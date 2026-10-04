import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  applyManifestToScheduler,
  compileManifestToScheduler,
  inspectSchedulerState,
  registerAuthorizationProvider,
  registerEvidenceProvider,
  registerIdentityProvider,
} from '@amittell/agentcli';
import { sshEvidenceProvider } from '@amittell/agentcli/evidence/ssh';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { enqueueDispatch, getDispatch } from '../dispatch-queue.js';
import { canonicalStringify, HANDOFF_V4_RUNTIME_CONTRACT } from '../handoff-artifact.js';
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
        schema_version: 30,
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

const PLUGIN_EVIDENCE_PROVIDER = 'v4-e2e-ed25519';
const TRUSTED_FINGERPRINTS_ENV = 'V4_E2E_TRUSTED_ED25519_FINGERPRINTS';

// A non-ssh evidence provider loaded from SCHEDULER_PROVIDER_PATH. agentcli
// persists only provider_config_hash on v4 jobs, so, like ssh with
// AGENTCLI_SIGNING_KEY, the signer reads its key path from the dispatcher
// environment. The envelope carries the public key; verify() trusts it only
// when its fingerprint is in an allowlist from the process environment, never
// because the envelope or the database row names it. The module-level timer
// breaks the documented rule that plugin modules have no side effects at
// import, on purpose: the CLI must still exit after it answers.
function writePluginEvidenceProvider(providerDir) {
  writeFileSync(join(providerDir, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  writeFileSync(join(providerDir, 'ed25519-evidence.js'), `
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const METHOD = '${PLUGIN_EVIDENCE_PROVIDER}';
export const keepAlive = setInterval(() => {}, 60_000);

const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
export const fingerprint = publicKey => 'SHA256:' + createHash('sha256')
  .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
  .digest('base64');
const signedBytes = envelope => Buffer.from(JSON.stringify([
  envelope.method,
  envelope.payload_digest,
  envelope.signed_payload,
  envelope.public_key,
]));

export default {
  name: '${PLUGIN_EVIDENCE_PROVIDER}',
  type: 'evidence',
  methods: [METHOD],
  resolve(config, ctx) {
    const keyPath = config.key_path || ctx.env.V4_E2E_ED25519_KEY;
    return keyPath ? { privateKey: createPrivateKey(readFileSync(keyPath)) } : null;
  },
  attest(payload, resolved) {
    const envelope = {
      schema: 'agentcli.evidence.envelope',
      version: 1,
      method: METHOD,
      payload_format: 'canonical-json',
      payload_digest: digest(payload),
      signed_payload: payload,
      public_key: createPublicKey(resolved.privateKey).export({ type: 'spki', format: 'pem' }),
    };
    envelope.key_fingerprint = fingerprint(envelope.public_key);
    envelope.signature = sign(null, signedBytes(envelope), resolved.privateKey).toString('base64');
    return { attested: true, envelope };
  },
  verify(envelope) {
    if (envelope.method !== METHOD || envelope.payload_digest !== digest(envelope.signed_payload)) {
      return { verified: false, reason: 'envelope was not produced by this provider' };
    }
    const keyFingerprint = fingerprint(envelope.public_key);
    const trusted = (process.env.${TRUSTED_FINGERPRINTS_ENV} || '').split(',').filter(Boolean);
    if (!trusted.includes(keyFingerprint)) {
      return { verified: false, reason: 'signer ' + keyFingerprint + ' is not a trusted key' };
    }
    const valid = verify(
      null,
      signedBytes(envelope),
      createPublicKey(envelope.public_key),
      Buffer.from(envelope.signature || '', 'base64'),
    );
    return valid
      ? { verified: true, payload: JSON.parse(envelope.signed_payload), key_fingerprint: keyFingerprint }
      : { verified: false, reason: 'ed25519 signature does not verify' };
  },
  describe(envelope) {
    return { provider: METHOD, method: envelope.method, key_fingerprint: envelope.key_fingerprint };
  },
};
`, { mode: 0o600 });
}

function pluginEvidenceManifest() {
  const task = (id, name, evidenceRef) => ({
    id,
    name,
    target: { session_target: 'shell' },
    shell: { program: 'printf', args: [id] },
    schedule: { cron: '0 0 * * *' },
    runtime: { timeout_ms: 10_000 },
    evidence: { ref: evidenceRef },
  });
  return {
    version: '0.2',
    evidence_profiles: [{
      id: 'v4-e2e-plugin-evidence',
      provider: PLUGIN_EVIDENCE_PROVIDER,
      methods: [PLUGIN_EVIDENCE_PROVIDER],
      payload: { format: 'canonical-json' },
      verify: { required: true },
    }, {
      id: 'v4-e2e-ssh-evidence',
      provider: 'ssh',
      methods: ['ssh-signature'],
      payload: { format: 'canonical-json' },
      verify: { required: true },
    }],
    workflows: [{
      id: 'handoff-v4-plugin-evidence',
      name: 'Handoff v4 plugin evidence',
      tasks: [
        task('signed', 'Handoff v4 plugin evidence', 'v4-e2e-plugin-evidence'),
        task('ssh-signed', 'Handoff v4 ssh evidence beside a plugin', 'v4-e2e-ssh-evidence'),
      ],
    }],
  };
}

function runCliResult(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, `CLI ${args.join(' ')} did not exit: ${result.error?.message}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`CLI stdout is not JSON: ${result.stdout}\nstderr: ${result.stderr}`, {
      cause: error,
    });
  }
  return { status: result.status, stderr: result.stderr, payload };
}

test('plugin evidence signs in the dispatcher and re-verifies from the CLI after its run and job are pruned', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-plugin-evidence-e2e-'));
  const dbPath = join(fixture, 'scheduler.db');
  const providerDir = join(fixture, 'providers');
  const keyPath = join(fixture, 'evidence-ed25519.pem');
  const sshKeyPath = join(fixture, 'evidence-ssh-key');
  const allowedSignersPath = join(fixture, 'allowed_signers');
  let dispatcher;
  t.after(async () => {
    await stopChild(dispatcher);
    closeDb();
    rmSync(fixture, { recursive: true, force: true });
  });

  mkdirSync(providerDir, { mode: 0o700 });
  writePluginEvidenceProvider(providerDir);
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  // The test signs the forgery below with the same plugin code; its timer
  // must not hold this process open.
  const plugin = await import(pathToFileURL(join(providerDir, 'ed25519-evidence.js')).href);
  clearInterval(plugin.keepAlive);
  const signerFingerprint = plugin.fingerprint(privateKey);
  const sshKey = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', sshKeyPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(sshKey.status, 0, sshKey.stderr);
  writeFileSync(
    allowedSignersPath,
    `${process.env.USER || 'agentcli'} ${readFileSync(`${sshKeyPath}.pub`, 'utf8').trim()}\n`,
    { mode: 0o600 },
  );

  // agentcli validates the profile's provider name at compile time; signing
  // and verification use the scheduler plugin above, never this stub.
  registerEvidenceProvider({
    name: PLUGIN_EVIDENCE_PROVIDER,
    methods: [PLUGIN_EVIDENCE_PROVIDER],
    resolve() { return null; },
    attest() { return { attested: false, reason: 'compile-time stub' }; },
    verify() { return { verified: false, reason: 'compile-time stub' }; },
    describe() { return { provider: PLUGIN_EVIDENCE_PROVIDER }; },
  });
  setDbPath(dbPath);
  await initDb();
  const applied = await applyFreshManifest(
    pluginEvidenceManifest(),
    { PATH: process.env.PATH || '/usr/bin' },
  );
  assert.equal(applied.job_count, 2);
  const jobNamed = name => getDb().prepare('SELECT * FROM jobs WHERE name = ?').get(name);
  const job = jobNamed('Handoff v4 plugin evidence');
  const sshJob = jobNamed('Handoff v4 ssh evidence beside a plugin');
  for (const applyJob of [job, sshJob]) {
    assert.equal(applyJob?.handoff_version, 4);
    assert(runJobNow(applyJob.id)?.dispatch_id, `${applyJob.name} dispatch was not queued`);
  }
  closeDb();

  const env = {
    ...process.env,
    SCHEDULER_DB: dbPath,
    OPENCLAW_SCHEDULER_HOME: fixture,
    OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
    SCHEDULER_PROVIDER_PATH: providerDir,
    [TRUSTED_FINGERPRINTS_ENV]: signerFingerprint,
    AGENTCLI_ALLOWED_SIGNERS: allowedSignersPath,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
  };
  // Only the dispatcher can read the signing keys.
  dispatcher = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env: {
      ...env,
      V4_E2E_ED25519_KEY: keyPath,
      AGENTCLI_SIGNING_KEY: sshKeyPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let dispatcherStderr = '';
  dispatcher.stderr.on('data', chunk => { dispatcherStderr += chunk; });

  const probe = new Database(dbPath, { readonly: true });
  const signed = jobId => () => {
    if (dispatcher.exitCode != null || dispatcher.signalCode != null) {
      throw new Error(`dispatcher exited: ${dispatcherStderr}`);
    }
    const latest = probe.prepare('SELECT * FROM runs WHERE job_id = ?').get(jobId);
    return {
      run: latest,
      evidence: latest
        ? probe.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(latest.id)
        : null,
      dispatcher_stderr: dispatcherStderr.slice(-2000),
    };
  };
  const settled = state => {
    if (state.run && !['pending', 'running', 'ok'].includes(state.run.status)) {
      throw new Error(`evidence run failed: ${JSON.stringify(state)}`);
    }
    return state.run?.status === 'ok' && state.evidence ? state : null;
  };
  let run;
  let evidence;
  let sshRun;
  try {
    ({ run, evidence } = await waitFor(signed(job.id), settled, 'plugin evidence signing'));
    ({ run: sshRun } = await waitFor(signed(sshJob.id), settled, 'ssh evidence signing'));
  } finally {
    probe.close();
  }
  await stopChild(dispatcher);

  assert.equal(evidence.evidence_provider, PLUGIN_EVIDENCE_PROVIDER);
  assert.equal(evidence.evidence_method, PLUGIN_EVIDENCE_PROVIDER);
  assert.equal(JSON.parse(evidence.evidence_envelope).key_fingerprint, signerFingerprint);
  assert.equal(JSON.stringify(evidence).includes(keyPath), false);

  assert.equal(runCliResult(['jobs', 'delete', job.id], env).payload.deleted, true);
  const pruned = new Database(dbPath, { readonly: true });
  try {
    assert.equal(pruned.prepare('SELECT COUNT(*) AS count FROM runs WHERE id = ?').get(run.id).count, 0);
    assert.equal(pruned.prepare('SELECT COUNT(*) AS count FROM jobs WHERE id = ?').get(job.id).count, 0);
  } finally {
    pruned.close();
  }

  const verified = runCliResult(['runs', 'evidence', run.id], env);
  assert.equal(verified.status, 0, JSON.stringify(verified.payload));
  assert.equal(verified.payload.ok, true);
  assert.equal(verified.payload.evidence.integrity.cryptographically_verified, true);
  assert.equal(verified.payload.evidence.integrity.provider, PLUGIN_EVIDENCE_PROVIDER);
  assert.equal(verified.payload.evidence.integrity.key_fingerprint, signerFingerprint);
  assert.equal(verified.payload.evidence.integrity.trust_source, 'provider');
  assert.equal(verified.payload.evidence.payload.execution_id, run.id);

  const doctor = runCliResult(['doctor', '--deep'], env);
  assert.equal(doctor.payload.diagnostics.evidence_records.checked, 2);
  assert.equal(doctor.payload.diagnostics.evidence_records.invalid, 0, doctor.stderr);

  const { SCHEDULER_PROVIDER_PATH: _providerPath, ...envWithoutPlugins } = env;
  const unloaded = runCliResult(['runs', 'evidence', run.id], envWithoutPlugins);
  assert.equal(unloaded.status, 1);
  assert.equal(unloaded.payload.ok, false);
  assert.equal(unloaded.payload.evidence.integrity.code, 'EVIDENCE_PROVIDER_NOT_LOADED');
  assert.match(unloaded.payload.evidence.integrity.error, /SCHEDULER_PROVIDER_PATH/);

  chmodSync(providerDir, 0o777);
  try {
    const refused = runCliResult(['runs', 'evidence', run.id], env);
    assert.equal(refused.status, 1);
    assert.equal(refused.payload.evidence.integrity.code, 'EVIDENCE_PROVIDER_NOT_LOADED');
    assert.match(refused.payload.evidence.integrity.error, /is world-writable/);
    assert.match(refused.stderr, /REFUSING to load providers/);
  } finally {
    chmodSync(providerDir, 0o700);
  }

  // A plugin path that cannot be read leaves built-in providers working; only
  // the plugin row fails closed, and doctor still reports diagnostics.
  const unreadableDir = join(fixture, 'unreadable-providers');
  mkdirSync(unreadableDir, { mode: 0o700 });
  chmodSync(unreadableDir, 0o300);
  try {
    const shapes = [['regular file', join(providerDir, 'ed25519-evidence.js'), /ENOTDIR/]];
    if (process.getuid?.() !== 0) shapes.push(['unreadable directory', unreadableDir, /EACCES/]);
    for (const [shape, providerPath, problem] of shapes) {
      const shapeEnv = { ...env, SCHEDULER_PROVIDER_PATH: providerPath };
      const sshVerified = runCliResult(['runs', 'evidence', sshRun.id], shapeEnv);
      assert.equal(sshVerified.status, 0, `${shape}: ${JSON.stringify(sshVerified.payload)}`);
      assert.equal(sshVerified.payload.evidence.integrity.cryptographically_verified, true);
      assert.equal(sshVerified.payload.evidence.integrity.trust_source, 'operator');
      const pluginRow = runCliResult(['runs', 'evidence', run.id], shapeEnv);
      assert.equal(pluginRow.status, 1, shape);
      assert.equal(pluginRow.payload.evidence.integrity.code, 'EVIDENCE_PROVIDER_NOT_LOADED');
      assert.match(pluginRow.payload.evidence.integrity.error, problem);
      const shapeDoctor = runCliResult(['doctor', '--deep'], shapeEnv);
      assert.equal(shapeDoctor.payload.diagnostics?.evidence_records.checked, 2, shape);
      assert.equal(shapeDoctor.payload.diagnostics.evidence_records.invalid, 1, shape);
    }
  } finally {
    chmodSync(unreadableDir, 0o700);
  }

  // Forgery by a party with database write access, triggers intact: copy the
  // row under a new run id, re-sign the rebound payload with the attacker's own
  // key, and carry that key in the envelope.
  const { privateKey: attackerKey } = generateKeyPairSync('ed25519');
  const forgedRunId = `${run.id}-forged`;
  const forgedPayload = canonicalStringify({ ...JSON.parse(evidence.payload), execution_id: forgedRunId });
  const forged = plugin.default.attest(forgedPayload, { privateKey: attackerKey }).envelope;
  const writer = new Database(dbPath);
  try {
    assert.equal(
      writer.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_v4_evidence_%'").get().count,
      2,
    );
    writer.prepare(`
      INSERT INTO evidence_records (
        id, run_id, job_id, evidence_ref, algorithm, hash, payload, retention_policy,
        retention_until, handoff_artifact_digest, source_run_id,
        source_run_handoff_artifact_digest, evidence_method, evidence_verified,
        evidence_envelope, evidence_provider, evidence_principal,
        evidence_allowed_signers_path, created_at
      ) VALUES (?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      `${evidence.id}-forged`,
      forgedRunId,
      evidence.job_id,
      evidence.evidence_ref,
      forged.payload_digest,
      forgedPayload,
      evidence.retention_policy,
      evidence.retention_until,
      evidence.handoff_artifact_digest,
      evidence.source_run_id,
      evidence.source_run_handoff_artifact_digest,
      evidence.evidence_method,
      canonicalStringify(forged),
      evidence.evidence_provider,
      evidence.evidence_principal,
      evidence.evidence_allowed_signers_path,
      evidence.created_at,
    );
  } finally {
    writer.close();
  }
  const forgery = runCliResult(['runs', 'evidence', forgedRunId], env);
  assert.equal(forgery.status, 1, JSON.stringify(forgery.payload));
  assert.equal(forgery.payload.ok, false);
  assert.equal(forgery.payload.evidence.integrity.code, 'EVIDENCE_VERIFICATION_FAILED');
  assert.match(forgery.payload.evidence.integrity.error, /is not a trusted key/);
  const doctorAfterForgery = runCliResult(['doctor', '--deep'], env);
  assert.equal(doctorAfterForgery.payload.diagnostics.evidence_records.invalid, 1);

  // Tampering with the signer's own envelope needs the immutability trigger
  // dropped; the next CLI open recreates it.
  const envelope = JSON.parse(evidence.evidence_envelope);
  const rewriteEnvelope = value => {
    const tamperer = new Database(dbPath);
    try {
      tamperer.exec('DROP TRIGGER IF EXISTS trg_v4_evidence_no_update');
      tamperer.prepare('UPDATE evidence_records SET evidence_envelope = ? WHERE id = ?')
        .run(canonicalStringify(value), evidence.id);
    } finally {
      tamperer.close();
    }
  };
  // Fields the signature does not cover must not be reported as the signer.
  rewriteEnvelope({ ...envelope, principal: 'mallory', key_fingerprint: 'SHA256:not-the-signer' });
  const relabeled = runCliResult(['runs', 'evidence', run.id], env);
  assert.equal(relabeled.status, 0, JSON.stringify(relabeled.payload));
  assert.equal(relabeled.payload.evidence.integrity.principal, null);
  assert.equal(relabeled.payload.evidence.integrity.key_fingerprint, signerFingerprint);

  const signature = Buffer.from(envelope.signature, 'base64');
  signature[0] ^= 0xff;
  rewriteEnvelope({ ...envelope, signature: signature.toString('base64') });
  const tampered = runCliResult(['runs', 'evidence', run.id], env);
  assert.equal(tampered.status, 1);
  assert.equal(tampered.payload.ok, false);
  assert.equal(tampered.payload.evidence.integrity.code, 'EVIDENCE_VERIFICATION_FAILED');
  assert.match(tampered.payload.evidence.integrity.error, /signature does not verify/);
});

test('ssh evidence re-verifies only against allowed-signers files the operator configures or lists', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-ssh-trust-e2e-'));
  const dbPath = join(fixture, 'scheduler.db');
  const keyPath = join(fixture, 'operator-key');
  const allowedSignersPath = join(fixture, 'allowed_signers');
  const principal = process.env.USER || 'agentcli';
  let dispatcher;
  t.after(async () => {
    await stopChild(dispatcher);
    closeDb();
    rmSync(fixture, { recursive: true, force: true });
  });
  const keygen = path => {
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(generated.status, 0, generated.stderr);
    return readFileSync(`${path}.pub`, 'utf8').trim();
  };
  writeFileSync(allowedSignersPath, `${principal} ${keygen(keyPath)}\n`, { mode: 0o600 });

  setDbPath(dbPath);
  await initDb();
  const applied = await applyFreshManifest({
    version: '0.2',
    evidence_profiles: [{
      id: 'v4-e2e-ssh-trust',
      provider: 'ssh',
      methods: ['ssh-signature'],
      payload: { format: 'canonical-json' },
      verify: { required: true },
    }],
    workflows: [{
      id: 'handoff-v4-ssh-trust',
      name: 'Handoff v4 ssh evidence trust',
      tasks: [{
        id: 'ssh-trust',
        name: 'Handoff v4 ssh evidence trust',
        target: { session_target: 'shell' },
        shell: { program: 'printf', args: ['ssh-trust'] },
        schedule: { cron: '0 0 * * *' },
        runtime: { timeout_ms: 10_000 },
        evidence: { ref: 'v4-e2e-ssh-trust' },
      }],
    }],
  }, { PATH: process.env.PATH || '/usr/bin' });
  assert.equal(applied.job_count, 1);
  const job = getDb().prepare('SELECT * FROM jobs WHERE name = ?').get('Handoff v4 ssh evidence trust');
  assert(runJobNow(job.id)?.dispatch_id, 'ssh evidence dispatch was not queued');
  closeDb();

  // Neither trust setting may leak in from the environment running the tests.
  const {
    AGENTCLI_ALLOWED_SIGNERS: _operatorPath,
    SCHEDULER_TRUSTED_ALLOWED_SIGNERS: _listedPaths,
    ...inherited
  } = process.env;
  const env = {
    ...inherited,
    SCHEDULER_DB: dbPath,
    OPENCLAW_SCHEDULER_HOME: fixture,
    OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
  };
  const operatorEnv = { ...env, AGENTCLI_ALLOWED_SIGNERS: allowedSignersPath };
  dispatcher = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env: { ...operatorEnv, AGENTCLI_SIGNING_KEY: keyPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let dispatcherStderr = '';
  dispatcher.stderr.on('data', chunk => { dispatcherStderr += chunk; });
  const probe = new Database(dbPath, { readonly: true });
  let run;
  let evidence;
  try {
    ({ run, evidence } = await waitFor(() => {
      if (dispatcher.exitCode != null || dispatcher.signalCode != null) {
        throw new Error(`dispatcher exited: ${dispatcherStderr}`);
      }
      const latest = probe.prepare('SELECT * FROM runs WHERE job_id = ?').get(job.id);
      return {
        run: latest,
        evidence: latest
          ? probe.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(latest.id)
          : null,
        dispatcher_stderr: dispatcherStderr.slice(-2000),
      };
    }, state => {
      if (state.run && !['pending', 'running', 'ok'].includes(state.run.status)) {
        throw new Error(`ssh evidence run failed: ${JSON.stringify(state)}`);
      }
      return state.run?.status === 'ok' && state.evidence ? state : null;
    }, 'ssh evidence signing'));
  } finally {
    probe.close();
  }
  await stopChild(dispatcher);
  assert.equal(evidence.evidence_allowed_signers_path, allowedSignersPath);

  // Forgery by a database writer, triggers intact: rebind the payload to a new
  // run id, sign it with an attacker key, and name an allowed-signers file the
  // attacker controls. One is a file beside the database; the other is the
  // database file itself, which ssh-keygen reads line by line, so a signer line
  // in the row's own text makes it a valid allowed-signers file.
  const attackerKeyPath = join(fixture, 'attacker-key');
  const attackerSigner = `mallory ${keygen(attackerKeyPath)}`;
  const attackerSignersPath = join(fixture, 'attacker_allowed_signers');
  writeFileSync(attackerSignersPath, `${attackerSigner}\n`, { mode: 0o600 });
  const forgedRunIds = [];
  const writer = new Database(dbPath);
  try {
    assert.equal(
      writer.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_v4_evidence_%'").get().count,
      2,
    );
    for (const [suffix, signersPath] of [['file', attackerSignersPath], ['db', dbPath]]) {
      const forgedRunId = `${run.id}-forged-${suffix}`;
      const forgedPayload = canonicalStringify({
        ...JSON.parse(evidence.payload),
        execution_id: forgedRunId,
      });
      const forged = sshEvidenceProvider.attest(forgedPayload, {
        keyPath: attackerKeyPath,
        principal: 'mallory',
      });
      assert.equal(forged.attested, true, forged.reason);
      writer.prepare(`
        INSERT INTO evidence_records (
          id, run_id, job_id, evidence_ref, algorithm, hash, payload, retention_policy,
          retention_until, handoff_artifact_digest, source_run_id,
          source_run_handoff_artifact_digest, evidence_method, evidence_verified,
          evidence_envelope, evidence_provider, evidence_principal,
          evidence_allowed_signers_path, created_at
        ) VALUES (?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'ssh', 'mallory', ?, ?)
      `).run(
        `${evidence.id}-forged-${suffix}`,
        forgedRunId,
        evidence.job_id,
        `\n${attackerSigner}\n`,
        forged.envelope.payload_digest,
        forgedPayload,
        evidence.retention_policy,
        evidence.retention_until,
        evidence.handoff_artifact_digest,
        evidence.source_run_id,
        evidence.source_run_handoff_artifact_digest,
        evidence.evidence_method,
        canonicalStringify(forged.envelope),
        signersPath,
        evidence.created_at,
      );
      forgedRunIds.push(forgedRunId);
    }
    writer.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    writer.close();
  }
  const outcome = result => ({
    status: result.status,
    valid: result.payload.evidence?.integrity?.valid,
    code: result.payload.evidence?.integrity?.code,
  });
  const forgedWithOperator = forgedRunIds.map(runId =>
    runCliResult(['runs', 'evidence', runId], operatorEnv));
  assert.deepEqual(
    forgedWithOperator.map(outcome),
    forgedRunIds.map(() => ({ status: 1, valid: false, code: 'EVIDENCE_VERIFICATION_FAILED' })),
    JSON.stringify(forgedWithOperator.map(result => result.payload.evidence?.integrity)),
  );
  for (const forged of forgedWithOperator) {
    assert.match(
      forged.payload.evidence.integrity.error,
      /SCHEDULER_TRUSTED_ALLOWED_SIGNERS does not list/,
    );
  }

  const verified = runCliResult(['runs', 'evidence', run.id], operatorEnv);
  assert.equal(verified.status, 0, JSON.stringify(verified.payload));
  assert.equal(verified.payload.evidence.integrity.cryptographically_verified, true);
  assert.equal(verified.payload.evidence.integrity.trust_source, 'operator');
  assert.equal(verified.payload.evidence.integrity.principal, principal);
  assert.match(verified.payload.evidence.integrity.key_fingerprint, /^SHA256:/);
  const operatorDoctor = runCliResult(['doctor', '--deep'], operatorEnv);
  assert.equal(operatorDoctor.payload.diagnostics.evidence_records.checked, 3);
  assert.equal(operatorDoctor.payload.diagnostics.evidence_records.invalid, 2);
  assert.equal(operatorDoctor.payload.diagnostics.evidence_records.trust_not_configured, 0);
  assert.deepEqual(
    operatorDoctor.payload.diagnostics.evidence_records.invalid_samples.map(sample => sample.code),
    ['EVIDENCE_VERIFICATION_FAILED', 'EVIDENCE_VERIFICATION_FAILED'],
  );

  // No trust configured: the legitimate row fails closed and says what to set.
  const unconfigured = runCliResult(['runs', 'evidence', run.id], env);
  assert.deepEqual(outcome(unconfigured), {
    status: 1,
    valid: false,
    code: 'EVIDENCE_TRUST_NOT_CONFIGURED',
  });
  const unconfiguredError = unconfigured.payload.evidence.integrity.error;
  assert.match(unconfiguredError, /set AGENTCLI_ALLOWED_SIGNERS/);
  // Listing is offered only for a file the operator recognizes, never as the fix.
  assert.equal(
    unconfiguredError.includes(`names ${allowedSignersPath}. List it in SCHEDULER_TRUSTED_ALLOWED_SIGNERS`),
    true,
    unconfiguredError,
  );
  assert.match(unconfiguredError, /only if it is an allowed-signers file you created/);
  assert.match(unconfiguredError, /sign of a forged row/);
  const unconfiguredDoctor = runCliResult(['doctor', '--deep'], env).payload;
  assert.equal(unconfiguredDoctor.ok, false);
  assert.equal(unconfiguredDoctor.diagnostics.evidence_records.invalid, 3);
  assert.equal(unconfiguredDoctor.diagnostics.evidence_records.trust_not_configured, 3);
  assert.deepEqual(
    [...new Set(unconfiguredDoctor.diagnostics.evidence_records.invalid_samples.map(sample => sample.code))],
    ['EVIDENCE_TRUST_NOT_CONFIGURED'],
  );
  assert.equal(
    unconfiguredDoctor.warnings.some(warning => /no allowed-signers file is configured/.test(warning)),
    true,
  );
  assert.equal(
    unconfiguredDoctor.warnings.some(warning => /checksum or execution-binding/.test(warning)),
    false,
  );

  // A listed recorded path verifies, alone or beside an operator file that does
  // not hold the signing key; unlisted recorded paths do not.
  const otherOperatorPath = join(fixture, 'other_allowed_signers');
  writeFileSync(otherOperatorPath, `${principal} ${keygen(join(fixture, 'other-key'))}\n`, { mode: 0o600 });
  const listedEnv = {
    ...env,
    SCHEDULER_TRUSTED_ALLOWED_SIGNERS: [join(fixture, 'unrelated'), allowedSignersPath].join(delimiter),
  };
  for (const trustEnv of [listedEnv, { ...listedEnv, AGENTCLI_ALLOWED_SIGNERS: otherOperatorPath }]) {
    const listed = runCliResult(['runs', 'evidence', run.id], trustEnv);
    assert.equal(listed.status, 0, JSON.stringify(listed.payload));
    assert.equal(listed.payload.evidence.integrity.trust_source, 'operator-listed-recorded-path');
  }
  const otherOperator = runCliResult(['runs', 'evidence', run.id], {
    ...env,
    AGENTCLI_ALLOWED_SIGNERS: otherOperatorPath,
  });
  assert.equal(outcome(otherOperator).code, 'EVIDENCE_VERIFICATION_FAILED');
  assert.equal(
    otherOperator.payload.evidence.integrity.error.includes(`not ${allowedSignersPath}`),
    true,
    otherOperator.payload.evidence.integrity.error,
  );
  for (const runId of forgedRunIds) {
    assert.equal(
      outcome(runCliResult(['runs', 'evidence', runId], listedEnv)).code,
      'EVIDENCE_TRUST_NOT_CONFIGURED',
    );
  }
  assert.equal(runCliResult(['doctor', '--deep'], listedEnv).payload.diagnostics.evidence_records.invalid, 2);
});
