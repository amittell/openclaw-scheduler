import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  applyManifestToScheduler,
  compileManifestToScheduler,
  inspectSchedulerState,
  registerAuthorizationProvider,
  registerIdentityProvider,
} from '@amittell/agentcli';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { enqueueDispatch, getDispatch } from '../dispatch-queue.js';
import { HANDOFF_V4_RUNTIME_CONTRACT } from '../handoff-artifact.js';
import {
  fireTriggeredChildren,
  createJob,
  getJob,
  runJobNow,
  scheduleRetry,
  updateJob,
} from '../jobs.js';
import { createRun, finishRun, persistV02Outcomes } from '../runs.js';

const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'cli.js');
const dispatcherPath = join(root, 'dispatcher.js');
const TASK_KINDS = ['schedule', 'at', 'manual', 'chain', 'retry'];
const JSON_FIELDS = [
  'identity',
  'authorization_proof',
  'authorization',
  'evidence',
  'contract_allowed_paths',
];
const V4_FEATURES = {
  root_approval_gate: true,
  approval_scope_enforcement: true,
  structured_output_format: true,
  runtime_execution: true,
  identity_declaration: true,
  runtime_identity_resolution: true,
  evidence_generation: true,
  audit_export: true,
  trust_evaluation: true,
  delegation_validation: true,
  credential_handoff: true,
  authorization_proof_verification: true,
  authorization_hook: true,
  handoff_v4_artifact: true,
  artifact_bound_proofs: true,
  signed_or_provider_verified_evidence: true,
  provider_session_cache: true,
  credential_presentation: true,
  source_run_bound_delegation: true,
  immutable_runtime_events: true,
};

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function signJwt(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
    kid: 'v4-e2e-key',
  })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function waitFor(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    const accepted = accept(latest);
    if (accepted) return accepted;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not reach its expected state: ${JSON.stringify(latest)}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const waitForExit = timeoutMs => new Promise(resolveExit => {
    if (child.exitCode != null || child.signalCode != null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
  child.kill('SIGTERM');
  if (await waitForExit(5_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(5_000), true, 'dispatcher did not exit after SIGKILL');
}

function registerCompileProviders() {
  registerIdentityProvider({
    name: 'v4-e2e-identity',
    capabilities: {
      auth_modes: ['service'],
      credential_types: ['bearer'],
      presentation_kinds: ['env'],
      handoff_modes: ['none', 'transaction-token'],
      trust_levels: ['supervised'],
      approval_mechanisms: [],
      refreshable: false,
      delegation: false,
    },
    validateProfile() { return { valid: true }; },
    resolveSession() {
      return {
        ok: true,
        session: {
          subject: { kind: 'service', principal: 'agent://v4-e2e' },
          credentials: { token: { value: 'v4-e2e-credential' } },
        },
      };
    },
    describeSession() {
      return { subject: { kind: 'service', principal: 'agent://v4-e2e' } };
    },
    materialize() { return { materialized: true, env_vars: {} }; },
    cleanup() { return { cleaned: true }; },
    prepareHandoff(session) { return { prepared: true, session }; },
  });
  registerAuthorizationProvider({
    name: 'v4-e2e-authorization',
    capabilities: {
      decision_kinds: ['permit', 'deny'],
      escalation: false,
      batch: false,
      dry_run: true,
    },
    validateProfile() { return { valid: true }; },
    authorize() { return { decision: 'permit', reason: 'v4 E2E provider permit' }; },
    describeDecision(decision) { return { decision: decision.decision }; },
  });
}

function writeRuntimeProviders(providerDir) {
  writeFileSync(join(providerDir, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  writeFileSync(join(providerDir, 'identity.js'), `
export default {
  name: 'v4-e2e-identity',
  type: 'identity',
  async resolveSession(request) {
    return {
      session: {
        subject: {
          kind: 'service',
          principal: request.principal || 'agent://v4-e2e'
        },
        trust: { level: 'supervised' },
        credentials: { token: { value: 'v4-e2e-credential' } }
      },
      expires_at: new Date(Date.now() + 300000).toISOString()
    };
  },
  async resumeSession() {
    return {
      session: {
        subject: { kind: 'service', principal: 'agent://v4-e2e' },
        trust: { level: 'supervised' },
        credentials: { token: { value: 'v4-e2e-credential' } }
      }
    };
  },
  async checkRevocation() { return { revoked: false }; },
  describeSession(session) {
    return { subject: session.subject, trust: session.trust };
  },
  async materializeCredentials(session, presentation) {
    return {
      bindings: presentation.bindings
        .filter(binding => binding.medium !== 'none')
        .map(binding => ({
          name: binding.name,
          medium: binding.medium,
          key: binding.env_key,
          file_name: binding.file_name,
          value: session.credentials.token.value
        }))
    };
  }
};
`, { mode: 0o600 });
  writeFileSync(join(providerDir, 'authorization.js'), `
export default {
  name: 'v4-e2e-authorization',
  type: 'authorization',
  async authorize() {
    return {
      decision: 'permit',
      reason: 'v4 E2E provider permit',
      decision_context: { policy: 'v4-e2e' }
    };
  }
};
`, { mode: 0o600 });
}

function buildManifest(fixture, publicKey, keyPath, allowedSignersPath, evidencePrincipal) {
  const allTaskIds = ['parent', ...TASK_KINDS];
  const proofProfiles = allTaskIds.map(taskId => ({
    id: `proof-${taskId}`,
    method: 'jwt',
    issuer: 'https://v4-e2e.invalid',
    audience: 'openclaw-scheduler',
    public_key: publicKey,
    proof: { value_from: { env: `V4_E2E_PROOF_${taskId.toUpperCase()}` } },
    claims: {
      audience: 'openclaw-scheduler',
      subject: 'agent://v4-e2e',
    },
    verify: { required: true },
  }));
  const common = taskId => ({
    name: `Handoff v4 E2E ${taskId}`,
    target: { session_target: 'shell' },
    identity: { ref: 'v4-e2e-identity' },
    authorization_proof: { ref: `proof-${taskId}` },
    authorization: { ref: 'v4-e2e-authorization' },
    evidence: { ref: 'v4-e2e-evidence' },
    ...(['chain', 'retry'].includes(taskId)
      ? { child_credential_policy: 'independent' }
      : {}),
    contract: {
      required_trust_level: 'supervised',
      trust_enforcement: 'strict',
      audit: 'always',
    },
    approval: {
      required: true,
      policy: 'manual',
      risk_level: 'high',
      timeout_s: 300,
    },
    delivery: {
      mode: 'announce-always',
      channel: 'test',
      to: 'v4-e2e',
    },
    output: { format: 'json', preview_bytes: 1024 },
    verify: {
      shell: `test -f ${shellQuote(join(fixture, `${taskId}.marker`))}`,
      timeout_seconds: 5,
      on_failure: 'error',
    },
    runtime: { timeout_ms: 10_000 },
    reliability: {
      guarantee: 'at-least-once',
      max_retries: taskId === 'retry' ? 1 : 0,
      overlap_policy: 'skip',
    },
  });
  const task = taskId => ({
    id: taskId,
    ...common(taskId),
    shell: {
      program: '/bin/sh',
      args: [
        '-c',
        `test "$V4_RUNTIME_TOKEN" = "v4-e2e-credential" && printf 'complete\\n' >> ${shellQuote(join(fixture, `${taskId}.marker`))} && printf '%s\\n' '{"kind":"${taskId}"}'`,
      ],
    },
    ...(taskId === 'chain'
      ? { trigger: { parent: 'parent', on: 'success' } }
      : { schedule: { cron: '0 0 * * *' } }),
  });
  return {
    version: '0.2',
    identity_profiles: [{
      id: 'v4-e2e-identity',
      provider: 'v4-e2e-identity',
      subject: {
        kind: 'service',
        principal: 'agent://v4-e2e',
        delegation_mode: 'none',
      },
      auth: {
        mode: 'service',
        required: true,
        cache: 'none',
        refresh: 'never',
      },
      trust: { level: 'supervised' },
      presentation: {
        handoff: 'transaction-token',
        cleanup: 'always',
        default_redaction: true,
        bindings: [{
          source: 'credentials.token.value',
          target: { kind: 'env', name: 'V4_RUNTIME_TOKEN' },
          required: true,
          redact: true,
          format: 'raw',
        }],
      },
    }],
    authorization_proof_profiles: proofProfiles,
    authorization_profiles: [{
      id: 'v4-e2e-authorization',
      provider: 'v4-e2e-authorization',
      request: { include: ['identity', 'trust', 'command'] },
    }],
    evidence_profiles: [{
      id: 'v4-e2e-evidence',
      provider: 'ssh',
      methods: ['ssh-signature'],
      provider_config: {
        key_path: keyPath,
        principal: evidencePrincipal,
        allowed_signers_path: allowedSignersPath,
      },
      payload: {
        bind: [
          'execution_id',
          'identity',
          'authorization_proof',
          'authorization',
          'command',
          'result',
          'postcondition',
        ],
        format: 'canonical-json',
      },
      verify: { required: true },
    }],
    workflows: [{
      id: 'handoff-v4-e2e',
      name: 'Handoff v4 public E2E',
      tasks: allTaskIds.map(task),
    }],
  };
}

function schedulerRunner() {
  return {
    invocation: { label: 'in-process-v4-scheduler' },
    queryCapabilities() {
      return {
        scheduler_version: '0.5.0-e2e',
        schema_version: 29,
        handoff_version: '4',
        handoff_contract: HANDOFF_V4_RUNTIME_CONTRACT,
        features: V4_FEATURES,
      };
    },
    listJobs() {
      return getDb().prepare('SELECT * FROM jobs ORDER BY created_at, id').all();
    },
    addJob(spec) {
      const normalized = { ...spec };
      for (const field of JSON_FIELDS) {
        if (normalized[field] != null && typeof normalized[field] !== 'string') {
          normalized[field] = JSON.stringify(normalized[field]);
        }
      }
      const job = createJob(normalized);
      return { ok: true, job };
    },
    updateJob(id, spec) {
      return { ok: true, job: updateJob(id, spec) };
    },
    deleteJob(id) {
      getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
      return { ok: true };
    },
  };
}

async function applyFreshManifest(manifest, compileEnv) {
  return applyManifestToScheduler(manifest, {
    runner: schedulerRunner(),
    cwd: root,
    env: compileEnv,
  });
}

test('handoff v4 applies to a fresh DB, survives restart, and executes every durable kind exactly once', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-handoff-v4-e2e-'));
  const dbPath = join(fixture, 'scheduler.db');
  const providerDir = join(fixture, 'providers');
  const keyPath = join(fixture, 'evidence-key');
  const allowedSignersPath = join(fixture, 'allowed_signers');
  const evidencePrincipal = process.env.USER || 'agentcli';
  const deliveryCalls = [];
  let dispatcher;
  let probe;
  let gatewayServer;

  t.after(async () => {
    await stopChild(dispatcher);
    if (gatewayServer) {
      await new Promise(resolveClose => gatewayServer.close(resolveClose));
    }
    probe?.close();
    closeDb();
    rmSync(fixture, { recursive: true, force: true });
  });

  mkdirSync(providerDir, { mode: 0o700 });
  writeRuntimeProviders(providerDir);

  const generated = spawnSync('ssh-keygen', [
    '-q', '-t', 'ed25519', '-N', '', '-f', keyPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(generated.status, 0, generated.stderr);
  writeFileSync(
    allowedSignersPath,
    `${evidencePrincipal} ${readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`,
    { mode: 0o600 },
  );

  gatewayServer = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method !== 'POST' || body.length === 0) {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const invocation = JSON.parse(body);
      if (invocation.tool === 'message' && invocation.args?.action === 'send') {
        deliveryCalls.push(invocation);
      }
      response.end(JSON.stringify({
        ok: true,
        result: { isError: false, content: [{ type: 'text', text: 'sent' }] },
      }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    gatewayServer.once('error', rejectListen);
    gatewayServer.listen(0, '127.0.0.1', resolveListen);
  });
  const address = gatewayServer.address();
  assert(address && typeof address === 'object');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  registerCompileProviders();
  const manifest = buildManifest(
    fixture,
    publicKeyPem,
    keyPath,
    allowedSignersPath,
    evidencePrincipal,
  );
  const compileEnv = { PATH: process.env.PATH || '/usr/bin' };
  let compiled;
  try {
    compiled = compileManifestToScheduler(manifest, {
      schedulerHandoffVersion: '4',
      cwd: root,
      env: compileEnv,
    });
  } catch (error) {
    throw new Error(
      `Manifest validation failed: ${JSON.stringify(error.validation?.errors || error.message)}`,
      { cause: error },
    );
  }
  const compiledByTask = new Map(compiled.jobs.map(job => [job.source.task_id, job]));

  const proofEnv = {};
  const now = Math.floor(Date.now() / 1000);
  for (const [taskId, job] of compiledByTask) {
    proofEnv[`V4_E2E_PROOF_${taskId.toUpperCase()}`] = signJwt({
      iss: 'https://v4-e2e.invalid',
      sub: 'agent://v4-e2e',
      aud: 'openclaw-scheduler',
      iat: now - 5,
      exp: now + 600,
      jti: `v4-e2e-${taskId}-${job.handoff_artifact_digest}`,
      manifest_digest: job.handoff_artifact_payload.manifest.digest,
      handoff_artifact_digest: job.handoff_artifact_digest,
    }, privateKey);
  }

  setDbPath(dbPath);
  await initDb();
  const applied = await applyFreshManifest(manifest, compileEnv);
  assert.equal(applied.handoff.field_version, '4');
  assert.equal(applied.job_count, compiled.jobs.length);
  assert.equal(applied.actions.every(action => action.action === 'created'), true);

  const jobsByTask = new Map(
    [...compiledByTask].map(([taskId, compiledJob]) => [taskId, getJob(compiledJob.id)]),
  );
  for (const [taskId, job] of jobsByTask) {
    assert(job, `applied job missing for ${taskId}`);
    assert.equal(job.handoff_version, 4);
    assert.equal(job.handoff_artifact_digest, compiledByTask.get(taskId).handoff_artifact_digest);
  }

  const inspectedArtifacts = await inspectSchedulerState({
    dbPath,
    entity: 'artifacts',
    limit: compiled.jobs.length + 1,
  });
  assert.equal(inspectedArtifacts.count, compiled.jobs.length);
  const inspectedDigests = new Set(inspectedArtifacts.items.map(item => item.digest));
  for (const job of jobsByTask.values()) {
    assert.equal(inspectedDigests.has(job.handoff_artifact_digest), true);
  }

  const parent = jobsByTask.get('parent');
  const parentRun = createRun(parent.id);
  persistV02Outcomes(parentRun.id, {
    identity_resolved: {
      principal: 'agent://v4-e2e',
      trust_level: 'supervised',
    },
  });
  finishRun(parentRun.id, 'ok', { summary: 'v4 chain source completed' });

  const fixtures = [];
  for (const kind of TASK_KINDS) {
    const job = jobsByTask.get(kind);
    const state = {
      kind,
      job,
      marker: join(fixture, `${kind}.marker`),
      dispatch: null,
      approval: null,
      retryOfRunId: null,
    };
    if (kind === 'schedule') {
      getDb().prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?")
        .run(job.id);
    } else if (kind === 'at') {
      state.dispatch = enqueueDispatch(job.id, {
        kind: 'at',
        scheduled_for: '2000-01-01 00:00:00',
      });
    } else if (kind === 'manual') {
      const manual = runJobNow(job.id);
      state.dispatch = getDispatch(manual.dispatch_id);
    } else if (kind === 'chain') {
      const [triggered] = fireTriggeredChildren(
        parent.id,
        'ok',
        'v4 chain source completed',
        parentRun.id,
      );
      assert(triggered, 'v4 chain dispatch was not produced');
      state.dispatch = getDispatch(triggered.dispatch_id);
    } else if (kind === 'retry') {
      const predecessor = createRun(job.id);
      persistV02Outcomes(predecessor.id, {
        identity_resolved: {
          principal: 'agent://v4-e2e',
          trust_level: 'supervised',
        },
      });
      finishRun(predecessor.id, 'error', { summary: 'v4 retry predecessor' });
      const retry = scheduleRetry(job, predecessor.id);
      assert(retry.dispatch, 'v4 retry dispatch was not produced');
      getDb().prepare(
        "UPDATE job_dispatch_queue SET scheduled_for = datetime('now', '-1 second'), binding_scheduled_for = datetime('now', '-1 second') WHERE id = ?",
      ).run(retry.dispatch.id);
      state.dispatch = getDispatch(retry.dispatch.id);
      state.retryOfRunId = predecessor.id;
    }
    fixtures.push(state);
  }

  closeDb();
  const env = {
    ...process.env,
    ...proofEnv,
    SCHEDULER_DB: dbPath,
    OPENCLAW_SCHEDULER_HOME: fixture,
    OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
    SCHEDULER_PROVIDER_PATH: providerDir,
    AGENTCLI_SIGNING_KEY: keyPath,
    AGENTCLI_ALLOWED_SIGNERS: allowedSignersPath,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '5000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
  };
  dispatcher = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let dispatcherStderr = '';
  dispatcher.stderr.on('data', chunk => { dispatcherStderr += chunk; });
  const assertDispatcherHealthy = () => {
    if (dispatcher.exitCode != null || dispatcher.signalCode != null) {
      throw new Error(
        `dispatcher exited code=${dispatcher.exitCode} signal=${dispatcher.signalCode}: ${dispatcherStderr}`,
      );
    }
  };

  probe = new Database(dbPath);
  probe.pragma('journal_mode = WAL');
  const pending = await waitFor(
    () => {
      assertDispatcherHealthy();
      return probe.prepare("SELECT * FROM approvals WHERE status = 'pending'").all();
    },
    rows => rows.length === TASK_KINDS.length ? rows : null,
    'v4 approval gates',
  );
  for (const approval of pending) {
    const state = fixtures.find(candidate => candidate.job.id === approval.job_id);
    assert(state, `unexpected v4 approval for ${approval.job_id}`);
    state.approval = approval;
    state.dispatch = probe.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?')
      .get(approval.dispatch_queue_id);
    assert.equal(state.dispatch.dispatch_kind, state.kind);
    assert.equal(state.dispatch.handoff_artifact_digest, state.job.handoff_artifact_digest);
    assert.equal(approval.handoff_artifact_digest, state.job.handoff_artifact_digest);
    assert.equal(existsSync(state.marker), false);
  }

  for (const approval of pending) {
    const response = runCli([
      'approvals',
      'approve',
      approval.id,
      '--reason',
      `approved v4 ${approval.dispatch_queue_id}`,
    ], env);
    assert.equal((response.approval || response).status, 'approved');
  }

  await waitFor(
    () => {
      assertDispatcherHealthy();
      return fixtures.map(state => ({
        kind: state.kind,
        runs: probe.prepare(
          'SELECT id, status, summary, error_message, approval_used FROM runs WHERE job_id = ? AND approval_used IS NOT NULL ORDER BY started_at',
        ).all(state.job.id),
        events: probe.prepare(
          'SELECT event_type, payload FROM runtime_events WHERE job_id = ? ORDER BY id',
        ).all(state.job.id),
        dispatcher_stderr: dispatcherStderr.slice(-4000),
      }));
    },
    states => {
      const failed = states.find(state => state.runs.some(run =>
        !['awaiting_approval', 'running', 'ok'].includes(run.status)));
      if (failed) {
        throw new Error(`v4 ${failed.kind} execution failed: ${JSON.stringify(failed)}`);
      }
      return states.every(state => state.runs.length === 1 && state.runs[0].status === 'ok')
        ? states
        : null;
    },
    'v4 executions',
  );

  await waitFor(
    () => ({
      rows: probe.prepare("SELECT * FROM delivery_outbox WHERE status = 'delivered'").all(),
      calls: deliveryCalls.length,
    }),
    snapshot => snapshot.rows.length === TASK_KINDS.length * 2
      && snapshot.calls === TASK_KINDS.length * 2
      ? snapshot
      : null,
    'v4 approval and completion deliveries',
    40_000,
  );

  for (const state of fixtures) {
    const runs = probe.prepare(
      'SELECT * FROM runs WHERE job_id = ? AND approval_used IS NOT NULL',
    ).all(state.job.id);
    assert.equal(runs.length, 1, `${state.kind} executed more than once`);
    const [run] = runs;
    assert.equal(run.handoff_artifact_digest, state.job.handoff_artifact_digest);
    assert.match(run.runtime_instance_id, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(run.structured_output).kind, state.kind);
    assert.equal(JSON.parse(run.verification_result).status, 'passed');
    assert.equal(JSON.parse(run.authorization_decision).decision, 'permit');
    assert.equal(JSON.parse(run.authorization_proof_verification).verified, true);
    assert.equal(JSON.parse(run.identity_resolved).principal, 'agent://v4-e2e');
    assert.equal(
      JSON.stringify(JSON.parse(run.identity_resolved)).includes('v4-e2e-credential'),
      false,
    );
    assert.equal(readFileSync(state.marker, 'utf8'), 'complete\n');

    const cliJob = runCli(['jobs', 'get', state.job.id], env);
    const cliRun = runCli(['runs', 'get', run.id], env);
    assert.equal(cliJob.handoff_artifact_digest, state.job.handoff_artifact_digest);
    assert.equal(cliJob.effective_task_hash, state.job.effective_task_hash);
    assert.equal(cliRun.handoff_artifact_digest, state.job.handoff_artifact_digest);
    assert.equal(cliRun.source_run_handoff_artifact_digest, run.source_run_handoff_artifact_digest);

    const evidence = probe.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(run.id);
    assert(evidence, `missing evidence for ${state.kind}`);
    assert.equal(evidence.evidence_verified, 1);
    assert.equal(evidence.handoff_artifact_digest, state.job.handoff_artifact_digest);
    const verified = runCli(['runs', 'evidence', run.id], env).evidence;
    assert.equal(verified.integrity.valid, true, verified.integrity.error);
    assert.equal(verified.integrity.cryptographically_verified, true);

    const presentations = probe.prepare(
      'SELECT * FROM credential_presentations WHERE run_id = ?',
    ).all(run.id);
    assert.equal(presentations.length, 1);
    assert.equal(presentations[0].status, 'cleaned');
    assert.equal(presentations[0].medium, 'env');
    assert.equal(JSON.stringify(presentations).includes('v4-e2e-credential'), false);

    const eventTypes = new Set(
      probe.prepare('SELECT event_type FROM runtime_events WHERE run_id = ? ORDER BY id')
        .all(run.id)
        .map(event => event.event_type),
    );
    for (const expected of [
      'proof.verified',
      'identity.resolved',
      'capability.negotiated',
      'credential.materialized',
      'credential.cleaned',
      'evidence.verified',
    ]) {
      assert.equal(eventTypes.has(expected), true, `${state.kind} missing ${expected}`);
    }

    const outboxRows = probe.prepare('SELECT * FROM delivery_outbox WHERE job_id = ?')
      .all(state.job.id);
    assert.equal(outboxRows.length, 2, `${state.kind} delivery event was not exactly once`);
    assert.equal(outboxRows.every(row => row.status === 'delivered'), true);

    if (state.kind === 'chain') {
      assert.equal(run.source_run_id, parentRun.id);
      assert.equal(run.source_run_handoff_artifact_digest, parent.handoff_artifact_digest);
    }
    if (state.kind === 'retry') {
      assert.equal(run.source_run_id, state.retryOfRunId);
      assert.equal(run.retry_of, state.retryOfRunId);
      assert.equal(run.source_run_handoff_artifact_digest, state.job.handoff_artifact_digest);
    }
  }

  assert.equal(deliveryCalls.length, TASK_KINDS.length * 2);
  assert.equal(deliveryCalls.every(call => call.tool === 'message'), true);
  const persistedText = JSON.stringify({
    sessions: probe.prepare('SELECT * FROM provider_sessions').all(),
    credentials: probe.prepare('SELECT * FROM credential_presentations').all(),
    runs: probe.prepare('SELECT identity_resolved FROM runs').all(),
    events: probe.prepare('SELECT payload FROM runtime_events').all(),
  });
  assert.equal(persistedText.includes('v4-e2e-credential'), false);

  const manualState = fixtures.find(state => state.kind === 'manual');
  const replayDispatchId = runCli(['jobs', 'run', manualState.job.id], env).dispatch_id;
  const replayApproval = await waitFor(
    () => probe.prepare(
      "SELECT * FROM approvals WHERE dispatch_queue_id = ? AND status = 'pending'",
    ).get(replayDispatchId),
    row => row || null,
    'replay approval gate',
  );
  runCli([
    'approvals',
    'approve',
    replayApproval.id,
    '--reason',
    'approve replay rejection regression',
  ], env);
  const replayRun = await waitFor(
    () => probe.prepare(
      'SELECT * FROM runs WHERE dispatch_queue_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(replayDispatchId),
    run => run && run.status === 'error' ? run : null,
    'replayed proof terminal failure',
  );
  assert.match(replayRun.error_message, /replay|already used/i);
  assert.equal(
    probe.prepare('SELECT status FROM job_dispatch_queue WHERE id = ?').get(replayDispatchId).status,
    'done',
  );
  assert.equal(
    probe.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE run_id = ? AND event_type = 'proof.failed'")
      .get(replayRun.id).count,
    1,
  );
  const quarantineEvent = probe.prepare(
    "SELECT payload FROM runtime_events WHERE run_id = ? AND event_type = 'job.quarantine.required'",
  ).get(replayRun.id);
  assert.equal(JSON.parse(quarantineEvent.payload).job_disabled, true);
  assert.equal(probe.prepare('SELECT enabled FROM jobs WHERE id = ?').get(manualState.job.id).enabled, 0);
  assert.equal(readFileSync(manualState.marker, 'utf8'), 'complete\n');

  await waitFor(
    () => ({
      delivered: probe.prepare(
        "SELECT COUNT(*) AS count FROM delivery_outbox WHERE job_id = ? AND status = 'delivered'",
      ).get(manualState.job.id).count,
      calls: deliveryCalls.length,
    }),
    state => state.delivered === 3 && state.calls === TASK_KINDS.length * 2 + 1
      ? state
      : null,
    'replay failure approval delivery',
    40_000,
  );
});
