import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { compileManifestToScheduler } from '@amittell/agentcli';

import {
  assertArtifactMatchesJob,
  canonicalStringify,
  getHandoffArtifact,
  sha256,
  validateHandoffArtifact,
} from '../handoff-artifact.js';
import {
  cleanupCredentialMaterialization,
  listCredentialPresentations,
  materializeCredentials,
  recoverCredentialPresentations,
} from '../credential-runtime.js';
import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { enqueueDispatch } from '../dispatch-queue.js';
import { validateArtifactBoundDelegation } from '../delegation-runtime.js';
import {
  persistArtifactBoundEvidence,
  verifyPersistedArtifactBoundEvidence,
} from '../evidence-runtime.js';
import { negotiateCredentialCapabilities } from '../capability-negotiation.js';
import { runShellCommand } from '../dispatcher-shell.js';
import { executeShell, executeWatchdog, finalizeDispatch } from '../dispatcher-strategies.js';
import { resolveArtifactBoundIdentity } from '../identity-runtime.js';
import { normalizeShellResult } from '../shell-result.js';
import { createApproval } from '../approval.js';
import { createJob, deleteJob, getJob, updateJob } from '../jobs.js';
import { claimProofReplay, revokeProof, verifyArtifactBoundProof } from '../proof-runtime.js';
import {
  _resetProviderSessionMemoryForTesting,
  adoptProviderSession,
  resolveProviderSession,
  resumeProviderSession,
} from '../provider-session-store.js';
import {
  createRun,
  finishRun,
  getRun,
  persistV02Outcomes,
  pruneEvidenceRecords,
  pruneRuns,
} from '../runs.js';
import { getRuntimeEvent, listRuntimeEvents } from '../runtime-events.js';
import { SCHEDULER_SCHEMAS } from '../scheduler-schema.js';

const JSON_FIELDS = [
  'identity',
  'authorization_proof',
  'authorization',
  'evidence',
  'contract_allowed_paths',
];

const sharedConformanceFixture = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'handoff-v4', 'conformance.json'),
  'utf8',
));

function applyFixtureChanges(payload, changes) {
  const changed = structuredClone(payload);
  for (const change of changes) {
    let target = changed;
    for (const key of change.path.slice(0, -1)) target = target[key];
    const key = change.path.at(-1);
    if (change.op === 'delete') delete target[key];
    else target[key] = structuredClone(change.value);
  }
  return changed;
}

function manifest(name = 'V4 runtime') {
  return {
    version: '0.2',
    workflows: [{
      id: `workflow-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      tasks: [{
        id: 'root',
        name,
        target: { session_target: 'shell' },
        shell: { program: 'printf', args: ['ok'] },
        schedule: { cron: '0 * * * *' },
        runtime: { timeout_ms: 30_000 },
        output: { format: 'text', preview_bytes: 512 },
      }],
    }],
  };
}

function schedulerSpec(name) {
  return schedulerSpecFromManifest(manifest(name));
}

function schedulerSpecFromManifest(input) {
  return schedulerSpecsFromManifest(input)[0];
}

function schedulerSpecsFromManifest(input) {
  let jobs;
  try {
    jobs = compileManifestToScheduler(input, {
      schedulerHandoffVersion: '4',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH || '/usr/bin' },
    }).jobs;
  } catch (error) {
    if (error.validation) {
      throw new Error(
        `Manifest validation failed: ${JSON.stringify(error.validation.errors)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return jobs.map(job => {
    const spec = { ...job };
    delete spec.source;
    for (const field of JSON_FIELDS) {
      if (spec[field] != null && typeof spec[field] !== 'string') {
        spec[field] = JSON.stringify(spec[field]);
      }
    }
    return spec;
  });
}

function delegationManifest(prefix, {
  childScope = 'read',
  maxDepth = 4,
  allowedDelegators = ['agent://source'],
} = {}) {
  return {
    version: '0.2',
    identity_profiles: [
      {
        id: `${prefix}-source-identity`,
        provider: 'none',
        subject: {
          kind: 'agent',
          principal: 'agent://source',
          delegation_mode: 'none',
        },
        auth: { mode: 'none', required: false },
        presentation: { handoff: 'none', cleanup: 'always' },
      },
      {
        id: `${prefix}-child-identity`,
        provider: 'aws-sts-assume-role',
        subject: {
          kind: 'agent',
          principal: 'agent://child',
          delegation_mode: 'on-behalf-of',
        },
        auth: {
          mode: 'exchange',
          required: false,
          provider_config: {
            role_arn: 'arn:aws:iam::123456789012:role/HandoffV4Test',
          },
          delegation_policy: {
            max_depth: maxDepth,
            allowed_delegators: allowedDelegators,
            require_grant_per_hop: true,
          },
        },
        presentation: { handoff: 'none', cleanup: 'always' },
      },
    ],
    workflows: [{
      id: `${prefix}-workflow`,
      name: `${prefix} workflow`,
      tasks: [
        {
          id: 'source',
          name: `${prefix} source`,
          target: { session_target: 'shell' },
          shell: { program: 'printf', args: ['source'] },
          schedule: { cron: '0 * * * *' },
          runtime: { timeout_ms: 30_000 },
          identity: { ref: `${prefix}-source-identity`, scope: 'read' },
        },
        {
          id: 'child',
          name: `${prefix} child`,
          target: { session_target: 'shell' },
          shell: { program: 'printf', args: ['child'] },
          trigger: { parent: 'source', on: 'success' },
          runtime: { timeout_ms: 30_000 },
          identity: { ref: `${prefix}-child-identity`, scope: childScope },
        },
      ],
    }],
  };
}

function identityHandoffManifest(prefix, childCredentialPolicy) {
  return {
    version: '0.2',
    identity_profiles: [{
      id: `${prefix}-identity`,
      provider: 'env-bearer',
      subject: { kind: 'service', principal: `service:${prefix}` },
      auth: {
        mode: 'service',
        required: true,
        provider_config: {
          token_env: `${prefix.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_TOKEN`,
        },
      },
      trust: { level: 'supervised' },
      presentation: { handoff: 'none', cleanup: 'always' },
    }],
    workflows: [{
      id: `${prefix}-workflow`,
      name: `${prefix} workflow`,
      tasks: [{
        id: 'source',
        name: `${prefix} source`,
        target: { session_target: 'shell' },
        shell: { program: 'printf', args: ['source'] },
        schedule: { cron: '0 * * * *' },
        runtime: { timeout_ms: 30_000 },
        identity: { ref: `${prefix}-identity`, scope: 'full' },
      }, {
        id: 'child',
        name: `${prefix} child`,
        target: { session_target: 'shell' },
        shell: { program: 'printf', args: ['child'] },
        trigger: { parent: 'source', on: 'success' },
        runtime: { timeout_ms: 30_000 },
        identity: { ref: `${prefix}-identity`, scope: 'read' },
        child_credential_policy: childCredentialPolicy,
      }],
    }],
  };
}

function recordDelegationIdentity(runId, principal = 'agent://source') {
  persistV02Outcomes(runId, {
    identity_resolved: {
      principal,
      delegation_chain: [{
        validated: true,
        grant: { id: `grant-${runId}` },
      }],
    },
  });
}

function createV4Job(name) {
  return createJob(schedulerSpec(name));
}

before(async () => {
  setDbPath(':memory:');
  await initDb();
});

after(() => {
  _resetProviderSessionMemoryForTesting();
  closeDb();
});

test('generated v4 artifacts bind the complete persisted scheduler execution projection', () => {
  const job = createV4Job('Artifact projection');
  const artifact = assertArtifactMatchesJob(job);
  assert.equal(artifact.payload.scheduler_job_binding.version, 1);
  assert.match(artifact.payload.scheduler_job_binding.digest, /^sha256:[0-9a-f]{64}$/);

  const future = structuredClone(artifact.payload);
  future.scheduler_schema_min = 30;
  const futureValidation = validateHandoffArtifact(future);
  assert.equal(futureValidation.ok, false);
  assert.match(futureValidation.errors.join('; '), /exactly 29/);

  assert.throws(
    () => updateJob(job.id, { payload_model: 'different-model' }),
    error => error.code === 'HANDOFF_ARTIFACT_REQUIRED',
  );
  for (const patch of [
    { payload_scope: 'global' },
    { resource_pool: 'different-pool' },
    { job_class: 'pre_compaction_flush' },
    { watchdog_target_label: 'different target' },
    { watchdog_check_cmd: 'printf changed' },
    { watchdog_timeout_min: 15 },
    { watchdog_alert_channel: 'signal' },
    { watchdog_alert_target: 'ops-room' },
    { watchdog_self_destruct: 0 },
    { watchdog_started_at: '2026-07-19 04:30:00' },
  ]) {
    assert.throws(
      () => updateJob(job.id, patch),
      error => error.code === 'HANDOFF_ARTIFACT_REQUIRED',
    );
  }
  const watchdogCompatibleManifest = manifest('Watchdog transition binding');
  delete watchdogCompatibleManifest.workflows[0].tasks[0].output;
  const watchdogCompatibleJob = createJob(schedulerSpecFromManifest(watchdogCompatibleManifest));
  assert.throws(
    () => updateJob(watchdogCompatibleJob.id, {
      job_type: 'watchdog',
      watchdog_check_cmd: 'exit 0',
    }),
    error => error.code === 'HANDOFF_ARTIFACT_REQUIRED',
  );
  const persistedArtifact = getHandoffArtifact(job.handoff_artifact_digest);
  const transplanted = {
    ...job,
    payload_model: 'different-model',
  };
  const mismatch = validateHandoffArtifact(persistedArtifact.payload, {
    expectedDigest: job.handoff_artifact_digest,
    job: transplanted,
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join('; '), /scheduler job execution binding/);
  assert.equal(
    SCHEDULER_SCHEMAS.proof_replay_ledger.key_fields.includes('claimed_at'),
    true,
  );
  assert.equal(
    SCHEDULER_SCHEMAS.proof_replay_ledger.key_fields.includes('created_at'),
    false,
  );

  const missingNoneContext = structuredClone(artifact.payload);
  delete missingNoneContext.authorization_proof.verification_context_hash;
  const missingNoneValidation = validateHandoffArtifact(missingNoneContext);
  assert.equal(missingNoneValidation.ok, false);
  assert.match(
    missingNoneValidation.errors.join('; '),
    /authorization_proof\.verification_context_hash.*required/,
  );

  for (const missingValue of ['delete', 'null']) {
    const missingContext = structuredClone(artifact.payload);
    missingContext.authorization_proof.method = 'jwt';
    missingContext.authorization_proof.artifact_binding_required = true;
    missingContext.authorization_proof.replay_protection_required = true;
    missingContext.authorization_proof.revocation_check_required = true;
    if (missingValue === 'delete') {
      delete missingContext.authorization_proof.verification_context_hash;
    } else {
      missingContext.authorization_proof.verification_context_hash = null;
    }
    const validation = validateHandoffArtifact(missingContext);
    assert.equal(validation.ok, false, missingValue);
    assert.match(
      validation.errors.join('; '),
      /authorization_proof\.verification_context_hash.*required/,
    );
  }
});

test('v4 main fire-and-forget fails closed while the legacy transport remains available', () => {
  const v4 = schedulerSpec('Main fire-and-forget refusal');
  assert.throws(
    () => createJob({
      ...v4,
      session_target: 'main',
      payload_kind: 'systemEvent',
      execution_intent: 'fire-and-forget',
    }),
    /cannot enforce artifact-bound Gateway requests/,
  );

  const legacy = createJob({
    name: 'Legacy main fire-and-forget compatibility',
    schedule_cron: '0 * * * *',
    session_target: 'main',
    payload_kind: 'systemEvent',
    payload_message: 'legacy event',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    origin: 'system',
    execution_intent: 'fire-and-forget',
  });
  assert.equal(legacy.execution_intent, 'fire-and-forget');
});

test('direct v4 job specs bind the same defaults that job creation persists', () => {
  const input = manifest('Direct v4 defaults');
  input.workflows[0].tasks[0].delivery = {
    mode: 'announce',
    channel: 'telegram',
    to: '@default_delivery',
  };
  input.workflows[0].tasks[0].output = { format: 'text', preview_bytes: 65_536 };
  const spec = schedulerSpecFromManifest(input);
  for (const field of [
    'max_trigger_fanout',
    'delivery_mode',
    'approval_required',
    'approval_timeout_s',
    'approval_auto',
    'output_store_limit_bytes',
    'output_excerpt_limit_bytes',
    'output_summary_limit_bytes',
  ]) {
    delete spec[field];
  }

  const job = createJob(spec);
  assert.equal(job.max_trigger_fanout, 25);
  assert.equal(job.delivery_mode, 'announce');
  assert.equal(job.approval_required, 0);
  assert.equal(job.approval_timeout_s, 3600);
  assert.equal(job.approval_auto, 'reject');
  assert.equal(job.output_store_limit_bytes, 65_536);
  assert.equal(job.output_excerpt_limit_bytes, 65_536);
  assert.equal(job.output_summary_limit_bytes, 65_536);
  assert.equal(job.output_offload_threshold_bytes, 524_288);
  assert.equal(assertArtifactMatchesJob(job).digest, job.handoff_artifact_digest);

  const offloadSpec = schedulerSpec('Direct v4 offload default');
  delete offloadSpec.output_offload_threshold_bytes;
  const offloadJob = createJob(offloadSpec);
  assert.equal(offloadJob.output_offload_threshold_bytes, 65_536);
  assert.equal(assertArtifactMatchesJob(offloadJob).digest, offloadJob.handoff_artifact_digest);
});

test('shared handoff v4 conformance fixtures have exact digest parity and fail closed', () => {
  const fixture = sharedConformanceFixture;
  const [job] = compileManifestToScheduler(fixture.manifest, {
    schedulerHandoffVersion: '4',
    cwd: fixture.compile.cwd,
    env: fixture.compile.env,
  }).jobs;
  assert.equal(job.handoff_artifact_digest, fixture.expected.artifact_digest);
  assert.equal(job.handoff_artifact_payload.manifest.digest, fixture.expected.manifest_digest);
  assert.equal(job.effective_task_hash, fixture.expected.effective_task_hash);
  assert.equal(
    job.handoff_artifact_payload.scheduler_job_binding.digest,
    fixture.expected.scheduler_job_binding_digest,
  );
  assert.equal(validateHandoffArtifact(job.handoff_artifact_payload, {
    expectedDigest: fixture.expected.artifact_digest,
  }).ok, true);

  for (const negative of fixture.negative_artifact_cases) {
    const validation = validateHandoffArtifact(
      applyFixtureChanges(job.handoff_artifact_payload, negative.changes),
      negative.use_expected_digest
        ? { expectedDigest: fixture.expected.artifact_digest }
        : {},
    );
    assert.equal(validation.ok, false, negative.name);
    assert.equal(
      validation.errors.some(message => message.includes(negative.expected_error)),
      true,
      negative.name,
    );
  }
});

test('handoff v4 artifacts reject normalized raw-secret field variants', () => {
  const payload = assertArtifactMatchesJob(createV4Job('Raw secret field variants')).payload;
  for (const key of [
    'privateKey', 'proofValue', 'rawValue', 'api_key', 'access_token',
    'refresh-token', 'clientSecret', 'authorization_header',
  ]) {
    const changed = structuredClone(payload);
    changed.extension = { [key]: 'must-not-persist' };
    const validation = validateHandoffArtifact(changed);
    assert.equal(validation.ok, false, key);
    assert.match(validation.errors.join('; '), /raw credential material/i, key);
  }
});

test('handoff v4 artifact collection validation never throws on malformed shapes', () => {
  const payload = assertArtifactMatchesJob(createV4Job('Malformed artifact collections')).payload;
  for (const [path, mutate, expected] of [
    [
      'command.args_sha256',
      value => { value.command.args_sha256 = { invalid: true }; },
      /command\.args_sha256 must be an array/,
    ],
    [
      'command.env.effective_env_value_sha256',
      value => { value.command.env.effective_env_value_sha256 = []; },
      /command\.env\.effective_env_value_sha256 must be an object/,
    ],
    [
      'identity.presentation.bindings',
      value => { value.identity.presentation.bindings = { invalid: true }; },
      /identity\.presentation\.bindings must be an array/,
    ],
  ]) {
    const malformed = structuredClone(payload);
    mutate(malformed);
    let validation;
    assert.doesNotThrow(() => { validation = validateHandoffArtifact(malformed); }, path);
    assert.equal(validation.ok, false, path);
    assert.match(validation.errors.join('; '), expected, path);
  }
});

test('handoff v4 evidence hashes match the persisted audit-safe job declaration', () => {
  const input = manifest('Evidence hash binding');
  input.evidence_profiles = [{
    id: 'evidence-hash-binding',
    provider: 'ssh',
    methods: ['ssh-signature'],
    provider_config: {
      key_path: '/secret/signing-key',
      principal: 'evidence-hash-principal',
      allowed_signers_path: '/trusted/allowed-signers',
    },
    payload: { format: 'canonical-json', bind: ['result'] },
    verify: { required: true },
  }];
  input.workflows[0].tasks[0].evidence = { ref: 'evidence-hash-binding' };
  const job = createJob(schedulerSpecFromManifest(input));
  const declaration = JSON.parse(job.evidence);
  const artifact = assertArtifactMatchesJob(job).payload;
  assert.equal(declaration.provider_config, null);
  assert.equal(JSON.stringify(declaration).includes('/secret/signing-key'), false);
  assert.equal(artifact.evidence.payload_hash, declaration.payload_hash);
  assert.equal(artifact.evidence.provider_config_hash, declaration.provider_config_hash);

  for (const [field, expectedError] of [
    ['payload_hash', /evidence payload hash.*job declaration/],
    ['provider_config_hash', /evidence provider configuration hash.*job declaration/],
  ]) {
    const tamperedArtifact = structuredClone(artifact);
    tamperedArtifact.evidence[field] = null;
    const validation = validateHandoffArtifact(tamperedArtifact, { job });
    assert.equal(validation.ok, false, field);
    assert.match(validation.errors.join('; '), expectedError);
  }
});

test('sha256 hashes Uint8Array inputs as bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(sha256(bytes), expected);
  assert.notEqual(sha256(bytes), sha256(String(bytes)));
});

test('v4 jobs cannot be downgraded through the API or direct database writes', () => {
  const job = createV4Job('No downgrade');
  assert.throws(
    () => updateJob(job.id, { handoff_version: null }),
    error => error.code === 'HANDOFF_ARTIFACT_DOWNGRADE_REFUSED',
  );
  assert.throws(
    () => getDb().prepare(
      'UPDATE jobs SET handoff_version = NULL, handoff_artifact_digest = NULL WHERE id = ?',
    ).run(job.id),
    /cannot be downgraded or cleared/,
  );

  const disabled = updateJob(job.id, { enabled: 0 });
  assert.equal(disabled.enabled, 0);
  assert.equal(disabled.handoff_version, 4);
  assert.equal(disabled.handoff_artifact_digest, job.handoff_artifact_digest);
  const reenabled = updateJob(job.id, { enabled: 1 });
  assert.equal(reenabled.enabled, 1);
  assert.equal(reenabled.handoff_artifact_digest, job.handoff_artifact_digest);
  assert.equal(assertArtifactMatchesJob(reenabled).digest, job.handoff_artifact_digest);
});

test('v4 child jobs reject legacy parents at create and update time', () => {
  const legacyParent = createJob({
    name: 'Legacy lineage parent',
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf legacy-parent',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    origin: 'system',
  });
  const childSpec = schedulerSpec('V4 lineage child');
  assert.throws(
    () => createJob({
      ...childSpec,
      parent_id: legacyParent.id,
      trigger_on: 'success',
    }),
    error => error.code === 'HANDOFF_V4_PARENT_REQUIRED',
  );

  const root = createV4Job('V4 lineage update');
  assert.throws(
    () => updateJob(root.id, {
      parent_id: legacyParent.id,
      trigger_on: 'success',
    }),
    error => error.code === 'HANDOFF_V4_PARENT_REQUIRED',
  );

  const corruptParent = createV4Job('Corrupt lineage parent');
  getDb().prepare('UPDATE jobs SET handoff_artifact_digest = ? WHERE id = ?').run(
    `sha256:${'e'.repeat(64)}`,
    corruptParent.id,
  );
  assert.throws(
    () => createJob({
      ...schedulerSpec('Corrupt lineage child'),
      parent_id: corruptParent.id,
      trigger_on: 'success',
    }),
    error => error.code === 'HANDOFF_V4_PARENT_REQUIRED',
  );
});

test('run pruning retains source runs bound to immutable v4 dispatches', () => {
  const job = createV4Job('Retained dispatch source run');
  const sourceRun = createRun(job.id);
  finishRun(sourceRun.id, 'ok');
  getDb().prepare('UPDATE runs SET started_at = ? WHERE id = ?')
    .run('2026-07-19 00:00:00', sourceRun.id);
  const dispatch = enqueueDispatch(job.id, {
    kind: 'chain',
    source_run_id: sourceRun.id,
  });
  for (let index = 0; index < 3; index++) {
    const newer = createRun(job.id);
    finishRun(newer.id, 'ok');
    getDb().prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(`2026-07-19 00:0${index + 1}:00`, newer.id);
  }

  assert.doesNotThrow(() => pruneRuns(1));
  assert.equal(getRun(sourceRun.id)?.id, sourceRun.id);
  const retainedDispatch = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE id = ?',
  ).get(dispatch.id);
  assert.equal(retainedDispatch.source_run_id, sourceRun.id);
  assert.equal(
    retainedDispatch.source_run_handoff_artifact_digest,
    job.handoff_artifact_digest,
  );
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM runs WHERE job_id = ?').get(job.id).count,
    2,
  );
});

test('source-run deletion preserves immutable v4 dispatch lineage', () => {
  const chain = manifest('Immutable lineage');
  chain.workflows[0].tasks.push({
    id: 'child',
    name: 'Immutable lineage child',
    target: { session_target: 'shell' },
    shell: { program: 'printf', args: ['child'] },
    trigger: { parent: 'root', on: 'success' },
    runtime: { timeout_ms: 30_000 },
  });
  const [parentSpec, childSpec] = schedulerSpecsFromManifest(chain);
  const parent = createJob(parentSpec);
  const child = createJob(childSpec);
  const sourceRun = createRun(parent.id);
  finishRun(sourceRun.id, 'ok');
  const dispatch = enqueueDispatch(child.id, {
    kind: 'chain',
    source_run_id: sourceRun.id,
  });

  assert.equal(deleteJob(parent.id), true);
  assert.equal(getRun(sourceRun.id), undefined);
  const retained = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE id = ?',
  ).get(dispatch.id);
  assert.equal(retained.source_run_id, sourceRun.id);
  assert.equal(
    retained.source_run_handoff_artifact_digest,
    parent.handoff_artifact_digest,
  );
  assert.throws(
    () => getDb().prepare(
      'UPDATE job_dispatch_queue SET source_run_id = NULL WHERE id = ?',
    ).run(dispatch.id),
    /handoff v4 dispatch bindings are immutable/,
  );
});

test('v4 replacement preserves both artifacts, clears nulls, and cancels stale work atomically', () => {
  const input = manifest('Artifact replacement');
  const originalSpec = schedulerSpecFromManifest(input);
  const job = createJob(originalSpec);
  const originalArtifact = getHandoffArtifact(job.handoff_artifact_digest);
  const staleDispatch = enqueueDispatch(job.id, { kind: 'manual' });
  const staleApproval = createApproval(job.id, null, staleDispatch.id);

  const replacementInput = structuredClone(input);
  delete replacementInput.workflows[0].tasks[0].output;
  const replacementSpec = schedulerSpecFromManifest(replacementInput);
  delete replacementSpec.id;
  const updated = updateJob(job.id, replacementSpec);

  assert.equal(updated.output_format, null);
  assert.notEqual(updated.handoff_artifact_digest, job.handoff_artifact_digest);
  assert.equal(updated.handoff_artifact_digest, replacementSpec.handoff_artifact_digest);
  assert.deepEqual(getHandoffArtifact(job.handoff_artifact_digest).payload, originalArtifact.payload);
  assert.equal(getHandoffArtifact(updated.handoff_artifact_digest).payload.output.format, null);
  assert.equal(assertArtifactMatchesJob(updated).digest, updated.handoff_artifact_digest);

  const cancelledDispatch = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE id = ?',
  ).get(staleDispatch.id);
  const cancelledApproval = getDb().prepare(
    'SELECT * FROM approvals WHERE id = ?',
  ).get(staleApproval.id);
  assert.equal(cancelledDispatch.status, 'cancelled');
  assert.match(cancelledDispatch.last_error, /artifact was replaced/);
  assert.equal(cancelledApproval.status, 'cancelled');
  assert.match(cancelledApproval.cancelled_reason, /artifact was replaced/);
});

test('artifact bindings remain immutable across dispatches, runs, approvals, evidence, and events', () => {
  const job = createV4Job('Immutable bindings');
  const dispatch = enqueueDispatch(job.id, { kind: 'manual' });
  const run = createRun(job.id, { dispatch_queue_id: dispatch.id });
  const approval = createApproval(job.id, run.id, dispatch.id);
  const db = getDb();

  assert.equal(dispatch.handoff_artifact_digest, job.handoff_artifact_digest);
  assert.equal(run.handoff_artifact_digest, job.handoff_artifact_digest);
  assert.equal(approval.handoff_artifact_digest, job.handoff_artifact_digest);

  assert.throws(
    () => db.prepare('UPDATE runs SET handoff_artifact_digest = NULL WHERE id = ?').run(run.id),
    /run bindings are immutable/,
  );
  assert.throws(
    () => db.prepare('UPDATE approvals SET handoff_artifact_digest = NULL WHERE id = ?').run(approval.id),
    /approval bindings are immutable/,
  );
  assert.throws(
    () => db.prepare(
      'UPDATE job_dispatch_queue SET handoff_artifact_digest = NULL WHERE id = ?',
    ).run(dispatch.id),
    /dispatch bindings are immutable/,
  );

  db.prepare(`
    INSERT INTO evidence_records (
      id, run_id, job_id, algorithm, hash, payload,
      handoff_artifact_digest, evidence_method, evidence_verified
    ) VALUES (?, ?, ?, 'sha256', ?, '{}', ?, 'test', 1)
  `).run(
    `evidence-${run.id}`,
    run.id,
    job.id,
    `sha256:${'1'.repeat(64)}`,
    job.handoff_artifact_digest,
  );
  assert.throws(
    () => db.prepare('DELETE FROM evidence_records WHERE run_id = ?').run(run.id),
    /handoff v4 evidence is immutable/,
  );

  const event = listRuntimeEvents({ runId: run.id })[0];
  assert.ok(event);
  assert.throws(
    () => db.prepare('UPDATE runtime_events SET payload = ? WHERE id = ?').run('{}', event.id),
    /runtime events are immutable/,
  );
});

test('expired v4 evidence is pruned only after its immutable retention deadline', () => {
  const job = createV4Job('Expired v4 evidence');
  const run = createRun(job.id);
  finishRun(run.id, 'ok', { summary: 'retention completed' });
  const payload = {
    execution_id: run.id,
    bindings: { handoff_artifact_digest: job.handoff_artifact_digest },
  };
  const payloadText = canonicalStringify(payload);
  const envelope = {
    method: 'test-signature',
    payload_digest: sha256(payloadText),
  };
  const retentionUntil = new Date(Date.now() - 1_000).toISOString();
  getDb().prepare(`
    INSERT INTO evidence_records (
      id, run_id, job_id, algorithm, hash, payload, retention_policy,
      retention_until, handoff_artifact_digest, evidence_method,
      evidence_verified, evidence_envelope
    ) VALUES (?, ?, ?, 'sha256', ?, ?, '1m', ?, ?, ?, 1, ?)
  `).run(
    `expired-evidence-${run.id}`,
    run.id,
    job.id,
    envelope.payload_digest,
    payloadText,
    retentionUntil,
    job.handoff_artifact_digest,
    envelope.method,
    canonicalStringify(envelope),
  );

  assert.equal(pruneEvidenceRecords().changes, 1);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE run_id = ?').get(run.id).count,
    0,
  );
  const tombstone = JSON.parse(getRun(run.id).evidence_record);
  assert.equal(tombstone.pruned, true);
  assert.equal(tombstone.reason, 'retention_expired');
});

test('v4 retention pruning cannot use a caller cutoff to bypass the persisted deadline', () => {
  const job = createV4Job('Future retained v4 evidence');
  const run = createRun(job.id);
  finishRun(run.id, 'ok', { summary: 'retention completed' });
  const payload = {
    execution_id: run.id,
    bindings: { handoff_artifact_digest: job.handoff_artifact_digest },
  };
  const payloadText = canonicalStringify(payload);
  const envelope = {
    method: 'test-signature',
    payload_digest: sha256(payloadText),
  };
  const retentionUntil = new Date(Date.now() + 86_400_000).toISOString();
  getDb().prepare(`
    INSERT INTO evidence_records (
      id, run_id, job_id, algorithm, hash, payload, retention_policy,
      retention_until, handoff_artifact_digest, evidence_method,
      evidence_verified, evidence_envelope
    ) VALUES (?, ?, ?, 'sha256', ?, ?, '1d', ?, ?, ?, 1, ?)
  `).run(
    `future-evidence-${run.id}`,
    run.id,
    job.id,
    envelope.payload_digest,
    payloadText,
    retentionUntil,
    job.handoff_artifact_digest,
    envelope.method,
    canonicalStringify(envelope),
  );

  assert.equal(pruneEvidenceRecords({ now: Date.now() + 2 * 86_400_000 }).changes, 0);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE run_id = ?').get(run.id).count,
    1,
  );
});

test('runtime event inspection reports malformed hash-matching JSON deterministically', () => {
  const payload = 'not-json';
  const result = getDb().prepare(`
    INSERT INTO runtime_events (event_type, payload, payload_sha256)
    VALUES ('fixture.invalid-json', ?, ?)
  `).run(payload, sha256(payload));
  const eventId = Number(result.lastInsertRowid);

  assert.throws(
    () => getRuntimeEvent(eventId),
    error => error.code === 'RUNTIME_EVENT_INVALID'
      && error.cause instanceof SyntaxError,
  );
  assert.throws(
    () => listRuntimeEvents({ eventType: 'fixture.invalid-json' }),
    error => error.code === 'RUNTIME_EVENT_INVALID'
      && error.cause instanceof SyntaxError,
  );
});

test('replay protection rejects nonce reuse and cross-artifact proof transplant', () => {
  const db = getDb();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const first = claimProofReplay(db, {
    method: 'jwt',
    issuer: 'issuer',
    subject: 'subject',
    proofId: 'shared-proof-id',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    runId: 'run-a',
    expiresAt,
  });
  assert.equal(first.claimed, true);

  const sameArtifact = claimProofReplay(db, {
    method: 'jwt',
    issuer: 'issuer',
    subject: 'subject',
    proofId: 'shared-proof-id',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    runId: 'run-b',
    expiresAt,
  });
  assert.equal(sameArtifact.claimed, false);
  assert.match(sameArtifact.reason, /already used/);

  const transplanted = claimProofReplay(db, {
    method: 'jwt',
    issuer: 'issuer',
    subject: 'subject',
    proofId: 'shared-proof-id',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    runId: 'run-c',
    expiresAt,
  });
  assert.equal(transplanted.claimed, false);
  assert.match(transplanted.reason, /different artifact/);
  assert.equal(transplanted.existingArtifactDigest, `sha256:${'a'.repeat(64)}`);
});

test('delegation uses the exact source run and rejects transplant, stale parent, and disallowed actors', () => {
  const input = delegationManifest('delegation-exact');
  const [sourceSpec, childSpec] = schedulerSpecsFromManifest(input);
  const sourceJob = createJob(sourceSpec);
  const childJob = createJob(childSpec);

  const exactSource = createRun(sourceJob.id);
  recordDelegationIdentity(exactSource.id);
  finishRun(exactSource.id, 'ok');
  const newerSource = createRun(sourceJob.id);
  recordDelegationIdentity(newerSource.id);
  finishRun(newerSource.id, 'ok');

  const dispatch = enqueueDispatch(childJob.id, {
    kind: 'chain',
    source_run_id: exactSource.id,
  });
  const validated = validateArtifactBoundDelegation(
    childJob,
    assertArtifactMatchesJob(childJob),
    dispatch,
    { runId: 'delegation-exact-run' },
  );
  assert.equal(validated.valid, true);
  assert.equal(validated.source_run_id, exactSource.id);
  assert.notEqual(validated.source_run_id, newerSource.id);
  assert.equal(validated.grants_verified, 1);

  assert.throws(
    () => validateArtifactBoundDelegation(
      childJob,
      assertArtifactMatchesJob(childJob),
      {
        ...dispatch,
        source_run_handoff_artifact_digest: childJob.handoff_artifact_digest,
      },
    ),
    error => error.code === 'DELEGATION_SOURCE_ARTIFACT_MISMATCH',
  );

  const disallowedSource = createRun(sourceJob.id);
  recordDelegationIdentity(disallowedSource.id, 'agent://attacker');
  finishRun(disallowedSource.id, 'ok');
  const disallowedDispatch = enqueueDispatch(childJob.id, {
    kind: 'chain',
    source_run_id: disallowedSource.id,
  });
  assert.throws(
    () => validateArtifactBoundDelegation(
      childJob,
      assertArtifactMatchesJob(childJob),
      disallowedDispatch,
    ),
    error => error.code === 'DELEGATION_DELEGATOR_NOT_ALLOWED',
  );

  const cycleIdentity = JSON.stringify({
    principal: 'agent://source',
    delegation_chain: [{ validated: true, grant: { id: 'cycle-grant' } }],
  });
  const insertCycleRun = getDb().prepare(`
    INSERT INTO runs (
      id, job_id, status, finished_at, handoff_artifact_digest,
      runtime_instance_id, source_run_id, source_run_handoff_artifact_digest,
      identity_resolved
    ) VALUES (?, ?, 'ok', datetime('now'), ?, ?, ?, ?, ?)
  `);
  insertCycleRun.run(
    'delegation-cycle-a',
    sourceJob.id,
    sourceJob.handoff_artifact_digest,
    'delegation-cycle-a',
    'delegation-cycle-b',
    sourceJob.handoff_artifact_digest,
    cycleIdentity,
  );
  insertCycleRun.run(
    'delegation-cycle-b',
    sourceJob.id,
    sourceJob.handoff_artifact_digest,
    'delegation-cycle-b',
    'delegation-cycle-a',
    sourceJob.handoff_artifact_digest,
    cycleIdentity,
  );
  const cycleDispatch = enqueueDispatch(childJob.id, {
    kind: 'chain',
    source_run_id: 'delegation-cycle-a',
  });
  assert.throws(
    () => validateArtifactBoundDelegation(
      childJob,
      assertArtifactMatchesJob(childJob),
      cycleDispatch,
    ),
    error => error.code === 'DELEGATION_CYCLE',
  );

  const changed = delegationManifest('delegation-exact');
  changed.workflows[0].tasks[0].shell.args = ['changed-source'];
  const [changedSourceSpec] = schedulerSpecsFromManifest(changed);
  updateJob(sourceJob.id, changedSourceSpec);
  assert.throws(
    () => validateArtifactBoundDelegation(
      childJob,
      assertArtifactMatchesJob(childJob),
      dispatch,
    ),
    error => error.code === 'DELEGATION_STALE_PARENT',
  );
});

test('inherited and downscoped provider sessions resume against the exact source artifact', async () => {
  for (const policy of ['inherit', 'downscope']) {
    const prefix = `identity-${policy}`;
    const [sourceSpec, childSpec] = schedulerSpecsFromManifest(
      identityHandoffManifest(prefix, policy),
    );
    const sourceJob = createJob(sourceSpec);
    const childJob = createJob(childSpec);
    let resumeContext = null;
    let handoffContext = null;
    const provider = {
      name: 'env-bearer',
      type: 'identity',
      async resolveSession(request) {
        return {
          session: {
            subject: { kind: 'service', principal: `service:${prefix}` },
            scope: request.scope,
            trust: { level: 'supervised' },
          },
        };
      },
      async resumeSession(row, ctx) {
        resumeContext = ctx;
        return {
          session: {
            subject: { kind: 'service', principal: row.subject_principal },
            scope: row.scope,
            trust: { level: 'supervised' },
          },
        };
      },
      async checkRevocation() { return { revoked: false }; },
      async prepareHandoff(session, request, ctx) {
        handoffContext = ctx;
        return {
          prepared: true,
          session: {
            ...session,
            scope: request.target_scope,
            trust: { level: 'restricted' },
          },
        };
      },
    };
    const providerLookup = () => provider;
    const sourceRun = createRun(sourceJob.id);
    const sourceIdentity = await resolveArtifactBoundIdentity(
      sourceJob,
      assertArtifactMatchesJob(sourceJob),
      sourceRun,
      { db: getDb(), getIdentityProvider: providerLookup },
    );
    persistV02Outcomes(sourceRun.id, { identity_resolved: sourceIdentity });
    finishRun(sourceRun.id, 'ok');
    _resetProviderSessionMemoryForTesting();

    const childRun = createRun(childJob.id, { triggered_by_run: sourceRun.id });
    const childIdentity = await resolveArtifactBoundIdentity(
      childJob,
      assertArtifactMatchesJob(childJob),
      childRun,
      { db: getDb(), getIdentityProvider: providerLookup },
    );
    assert.equal(resumeContext.artifactDigest, sourceJob.handoff_artifact_digest);
    assert.equal(resumeContext.childArtifactDigest, childJob.handoff_artifact_digest);
    assert.equal(childIdentity.source_run_id, sourceRun.id);
    assert.equal(
      childIdentity.source_run_handoff_artifact_digest,
      sourceJob.handoff_artifact_digest,
    );
    if (policy === 'inherit') {
      assert.equal(childIdentity.provider_session_id, sourceIdentity.provider_session_id);
      assert.equal(handoffContext, null);
    } else {
      assert.notEqual(childIdentity.provider_session_id, sourceIdentity.provider_session_id);
      assert.equal(childIdentity.trust_level, 'restricted');
      assert.equal(handoffContext.artifactDigest, childJob.handoff_artifact_digest);
      assert.equal(
        getDb().prepare('SELECT handoff_artifact_digest FROM provider_sessions WHERE id = ?')
          .get(childIdentity.provider_session_id).handoff_artifact_digest,
        childJob.handoff_artifact_digest,
      );
    }
  }
});

test('independent child identity fails closed when the source trust ceiling is unavailable', async () => {
  const [sourceSpec, childSpec] = schedulerSpecsFromManifest(
    identityHandoffManifest('identity-missing-source-trust', 'independent'),
  );
  const sourceJob = createJob(sourceSpec);
  const childJob = createJob(childSpec);
  const provider = {
    name: 'env-bearer',
    type: 'identity',
    async resolveSession(request) {
      return {
        session: {
          subject: { kind: 'service', principal: request.principal },
          scope: request.scope,
          trust: { level: 'supervised' },
        },
      };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const providerLookup = () => provider;
  const sourceRun = createRun(sourceJob.id);
  const sourceIdentity = await resolveArtifactBoundIdentity(
    sourceJob,
    assertArtifactMatchesJob(sourceJob),
    sourceRun,
    { db: getDb(), getIdentityProvider: providerLookup },
  );
  persistV02Outcomes(sourceRun.id, {
    identity_resolved: { ...sourceIdentity, trust_level: null },
  });
  finishRun(sourceRun.id, 'ok');

  const childRun = createRun(childJob.id, { triggered_by_run: sourceRun.id });
  await assert.rejects(
    () => resolveArtifactBoundIdentity(
      childJob,
      assertArtifactMatchesJob(childJob),
      childRun,
      { db: getDb(), getIdentityProvider: providerLookup },
    ),
    error => error.code === 'CHILD_CREDENTIAL_TRUST_UNAVAILABLE',
  );
});

test('delegation rejects scope escalation and excessive chain depth', () => {
  const escalatedSpecs = schedulerSpecsFromManifest(delegationManifest(
    'delegation-scope',
    { childScope: 'write' },
  ));
  const scopeSourceJob = createJob(escalatedSpecs[0]);
  const scopeChildJob = createJob(escalatedSpecs[1]);
  const scopeSource = createRun(scopeSourceJob.id);
  recordDelegationIdentity(scopeSource.id);
  finishRun(scopeSource.id, 'ok');
  const scopeDispatch = enqueueDispatch(scopeChildJob.id, {
    kind: 'chain',
    source_run_id: scopeSource.id,
  });
  assert.throws(
    () => validateArtifactBoundDelegation(
      scopeChildJob,
      assertArtifactMatchesJob(scopeChildJob),
      scopeDispatch,
    ),
    error => error.code === 'DELEGATION_SCOPE_ESCALATION',
  );

  const depthSpecs = schedulerSpecsFromManifest(delegationManifest(
    'delegation-depth',
    { maxDepth: 1 },
  ));
  const depthSourceJob = createJob(depthSpecs[0]);
  const depthChildJob = createJob(depthSpecs[1]);
  const firstHop = createRun(depthSourceJob.id);
  recordDelegationIdentity(firstHop.id);
  finishRun(firstHop.id, 'ok');
  const secondHop = createRun(depthSourceJob.id, { triggered_by_run: firstHop.id });
  recordDelegationIdentity(secondHop.id);
  finishRun(secondHop.id, 'ok');
  const depthDispatch = enqueueDispatch(depthChildJob.id, {
    kind: 'chain',
    source_run_id: secondHop.id,
  });
  assert.throws(
    () => validateArtifactBoundDelegation(
      depthChildJob,
      assertArtifactMatchesJob(depthChildJob),
      depthDispatch,
    ),
    error => error.code === 'DELEGATION_DEPTH_EXCEEDED',
  );
});

test('replay validation accepts the exact crashed terminal source before retry semantics', () => {
  const job = createV4Job('Crashed replay source');
  const source = createRun(job.id);
  finishRun(source.id, 'crashed', { summary: 'dispatcher recovery marked the run crashed' });
  const dispatch = {
    id: 'crashed-replay-dispatch',
    job_id: job.id,
    dispatch_kind: 'retry',
    source_run_id: source.id,
    replay_of_run_id: source.id,
    source_run_handoff_artifact_digest: job.handoff_artifact_digest,
  };
  const validated = validateArtifactBoundDelegation(
    job,
    assertArtifactMatchesJob(job),
    dispatch,
    { runId: 'crashed-replay-run' },
  );
  assert.equal(validated.valid, true);
  assert.equal(validated.source_run_id, source.id);
});

test('retry validation accepts an exact timed-out run of the same v4 job', () => {
  const job = createV4Job('Timed-out retry source');
  const source = createRun(job.id);
  finishRun(source.id, 'timeout', { summary: 'execution exceeded its timeout' });
  const dispatch = enqueueDispatch(job.id, {
    kind: 'retry',
    source_run_id: source.id,
    retry_of_run_id: source.id,
  });
  const validated = validateArtifactBoundDelegation(
    job,
    assertArtifactMatchesJob(job),
    dispatch,
    { runId: 'timed-out-retry-run' },
  );
  assert.equal(validated.valid, true);
  assert.equal(validated.source_run_id, source.id);
});

test('proof failure audit events are ordered and never claim verification success', async () => {
  const artifactDigest = `sha256:${'c'.repeat(64)}`;
  const job = {
    id: 'proof-failure-job',
    handoff_version: 4,
    handoff_artifact_digest: artifactDigest,
    authorization_proof: JSON.stringify({
      method: 'jwt',
      proof: { value_from: { env: 'HANDOFF_TEST_PROOF' } },
    }),
  };
  const artifact = {
    manifest: { digest: `sha256:${'d'.repeat(64)}` },
    authorization_proof: { method: 'jwt', artifact_binding_required: true },
  };
  const run = { id: 'proof-failure-run', source_run_id: null };

  await assert.rejects(
    () => verifyArtifactBoundProof(job, artifact, run, {
      db: getDb(),
      env: { HANDOFF_TEST_PROOF: 'opaque-proof-value' },
      agentcli: {
        async verifyAuthorizationProof() {
          return {
            verified: false,
            method: 'jwt',
            reason: 'signature refused',
            artifact_bound: false,
            replay_protected: false,
            revocation_checked: false,
            signature_verified: false,
          };
        },
      },
    }),
    error => error.code === 'AUTHORIZATION_PROOF_VERIFICATION_FAILED',
  );
  const events = listRuntimeEvents({ runId: run.id });
  assert.deepEqual(events.map(event => event.event_type), ['proof.verifying', 'proof.failed']);
  assert.equal(events.some(event => event.event_type === 'proof.verified'), false);
  assert.equal(JSON.stringify(events).includes('opaque-proof-value'), false);
});

test('approved v4 proof outcomes are reused without replay consumption and recheck revocation', async () => {
  const artifactDigest = `sha256:${'7'.repeat(64)}`;
  const job = {
    id: 'proof-approval-reuse-job',
    handoff_version: 4,
    handoff_artifact_digest: artifactDigest,
    authorization_proof: JSON.stringify({
      method: 'jwt',
      proof: { value_from: { env: 'PROOF_MUST_NOT_BE_READ_ON_RESUME' } },
    }),
  };
  const artifact = {
    manifest: { digest: `sha256:${'6'.repeat(64)}` },
    authorization_proof: { method: 'jwt', artifact_binding_required: true },
  };
  const priorRun = {
    id: 'proof-approval-prior-run',
    job_id: job.id,
    handoff_artifact_digest: artifactDigest,
  };
  const now = Date.now();
  const verified = {
    verified: true,
    method: 'jwt',
    signature_verified: true,
    artifact_bound: true,
    replay_protected: true,
    revocation_checked: true,
    issuer: 'https://issuer.example',
    subject: 'principal:alex',
    key_id: 'key-1',
    proof_id: 'proof-approval-id',
    verified_at: new Date(now).toISOString(),
    proof_valid_from: new Date(now - 60_000).toISOString(),
    proof_valid_until: new Date(now + 60_000).toISOString(),
    proof_clock_skew_seconds: 0,
  };
  let revocationChecks = 0;
  const currentRun = { id: 'proof-approval-resumed-run', source_run_id: null };
  const reused = await verifyArtifactBoundProof(job, artifact, currentRun, {
    db: getDb(),
    env: {},
    priorRun,
    reuseVerification: verified,
    approvalId: 'approval-1',
    checkProofRevocation(input) {
      revocationChecks += 1;
      assert.equal(input.priorRunId, priorRun.id);
      return { revoked: false };
    },
    agentcli: {
      async verifyAuthorizationProof() {
        throw new Error('proof must not be verified or replay-claimed twice');
      },
    },
  });
  assert.deepEqual(reused, verified);
  assert.equal(revocationChecks, 1);
  assert.deepEqual(
    listRuntimeEvents({ runId: currentRun.id }).map(event => event.event_type),
    ['proof.revalidating', 'proof.reused'],
  );

  await assert.rejects(
    () => verifyArtifactBoundProof(job, artifact, {
      id: 'proof-approval-expired-run',
      source_run_id: null,
    }, {
      db: getDb(),
      priorRun,
      reuseVerification: verified,
      approvalId: 'approval-1',
      now: now + 60_001,
    }),
    error => error.code === 'AUTHORIZATION_PROOF_EXPIRED',
  );

  revokeProof({
    method: 'jwt',
    proofId: verified.proof_id,
    reason: 'revoked while approval was pending',
  }, { db: getDb() });
  await assert.rejects(
    () => verifyArtifactBoundProof(job, artifact, {
      id: 'proof-approval-revoked-run',
      source_run_id: null,
    }, {
      db: getDb(),
      priorRun,
      reuseVerification: verified,
      approvalId: 'approval-1',
    }),
    error => error.code === 'AUTHORIZATION_PROOF_REVOKED',
  );
});

test('provider session cache and rotation state are scoped to the exact artifact', async () => {
  _resetProviderSessionMemoryForTesting();
  let resolves = 0;
  const provider = {
    name: 'artifact-session-provider',
    type: 'identity',
    async resolveSession(request) {
      resolves += 1;
      return {
        session: {
          principal: request.principal,
          scope: request.scope,
          rotation_id: `rotation-${resolves}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async checkRevocation() {
      return { revoked: false };
    },
  };
  const request = { principal: 'principal:alex', scope: ['read'] };
  const first = await resolveProviderSession(provider, request, {
    artifactDigest: `sha256:${'e'.repeat(64)}`,
    jobId: 'session-job-a',
    runId: 'session-run-a',
  }, { db: getDb() });
  const reused = await resolveProviderSession(provider, request, {
    artifactDigest: `sha256:${'e'.repeat(64)}`,
    jobId: 'session-job-a',
    runId: 'session-run-b',
  }, { db: getDb() });
  const secondArtifact = await resolveProviderSession(provider, request, {
    artifactDigest: `sha256:${'f'.repeat(64)}`,
    jobId: 'session-job-b',
    runId: 'session-run-c',
  }, { db: getDb() });

  assert.equal(first.row.id, reused.row.id);
  assert.notEqual(first.row.id, secondArtifact.row.id);
  assert.notEqual(first.cache_key_hash, secondArtifact.cache_key_hash);
  assert.equal(resolves, 2);
  assert.equal(first.row.handoff_artifact_digest, `sha256:${'e'.repeat(64)}`);
  assert.equal(secondArtifact.row.handoff_artifact_digest, `sha256:${'f'.repeat(64)}`);
});

test('concurrent provider resolution returns the winning persisted session identity', async () => {
  _resetProviderSessionMemoryForTesting();
  let releaseResolvers;
  const release = new Promise(resolve => { releaseResolvers = resolve; });
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let resolves = 0;
  const provider = {
    name: 'concurrent-session-provider',
    type: 'identity',
    async resolveSession() {
      const call = ++resolves;
      signalStarted();
      await release;
      return {
        session: {
          principal: `principal:concurrent-${call}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const request = { principal: 'principal:concurrent' };
  const context = {
    artifactDigest: `sha256:${'8'.repeat(64)}`,
    jobId: 'concurrent-session-job',
  };
  const firstPromise = resolveProviderSession(provider, request, {
    ...context,
    runId: 'concurrent-session-run-1',
  }, { db: getDb() });
  await started;
  const secondPromise = resolveProviderSession(provider, request, {
    ...context,
    runId: 'concurrent-session-run-2',
  }, { db: getDb() });
  releaseResolvers();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(resolves, 1);
  assert.equal(first.row.id, second.row.id);
  assert.ok(first.session);
  assert.ok(second.session);
  assert.equal(first.session.principal, second.session.principal);
  assert.equal(first.session.principal, first.row.subject_principal);
  assert.equal(
    JSON.parse(first.row.session_summary).subject_principal,
    first.session.principal,
  );
  assert.equal(
    getDb().prepare(
      'SELECT COUNT(*) AS count FROM provider_sessions WHERE provider_name = ?',
    ).get(provider.name).count,
    1,
  );
});

test('concurrent cold writers resume the persisted session winner', async () => {
  _resetProviderSessionMemoryForTesting();
  const db = getDb();
  const secondDbIdentity = { prepare: (...args) => db.prepare(...args) };
  const releases = [];
  const starts = [];
  let resolveCalls = 0;
  let resumeCalls = 0;
  const provider = {
    name: 'cross-process-session-provider',
    type: 'identity',
    async resolveSession() {
      const call = ++resolveCalls;
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      releases[call] = release;
      starts[call]?.();
      await wait;
      return {
        session: {
          principal: `principal:writer-${call}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async resumeSession(row) {
      resumeCalls += 1;
      const summary = JSON.parse(row.session_summary);
      return {
        session: {
          principal: summary.subject_principal,
          expires_at: summary.expires_at,
        },
      };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const startedOne = new Promise(resolve => { starts[1] = resolve; });
  const startedTwo = new Promise(resolve => { starts[2] = resolve; });
  const request = { principal: 'principal:writer-race' };
  const context = {
    artifactDigest: `sha256:${'5'.repeat(64)}`,
    jobId: 'cross-process-session-job',
  };
  const firstPromise = resolveProviderSession(provider, request, {
    ...context,
    runId: 'cross-process-session-run-1',
  }, { db });
  await startedOne;
  const secondPromise = resolveProviderSession(provider, request, {
    ...context,
    runId: 'cross-process-session-run-2',
  }, { db: secondDbIdentity });
  await startedTwo;
  releases[1]();
  const first = await firstPromise;
  _resetProviderSessionMemoryForTesting();
  releases[2]();
  const second = await secondPromise;

  assert.equal(resolveCalls, 2);
  assert.equal(resumeCalls, 1);
  assert.equal(first.row.id, second.row.id);
  assert.equal(first.session.principal, 'principal:writer-1');
  assert.equal(second.session.principal, first.session.principal);
  assert.equal(second.row.subject_principal, first.session.principal);
});

test('provider result expiry uses completion time unless a clock is explicit', async () => {
  _resetProviderSessionMemoryForTesting();
  const expiringProvider = {
    name: 'completion-expiry-provider',
    type: 'identity',
    async resolveSession() {
      const expiresAt = new Date(Date.now() + 10).toISOString();
      await new Promise(resolve => setTimeout(resolve, 25));
      return { session: { principal: 'principal:expired-at-completion', expires_at: expiresAt } };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  await assert.rejects(
    () => resolveProviderSession(
      expiringProvider,
      { principal: 'principal:expired-at-completion' },
      {
        artifactDigest: `sha256:${'6'.repeat(64)}`,
        jobId: 'completion-expiry-job',
        runId: 'completion-expiry-run',
      },
      { db: getDb() },
    ),
    error => error.code === 'PROVIDER_SESSION_EXPIRED',
  );

  const deterministicProvider = {
    name: 'explicit-clock-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: 'principal:explicit-clock',
          expires_at: new Date(1_000).toISOString(),
        },
      };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const deterministic = await resolveProviderSession(
    deterministicProvider,
    { principal: 'principal:explicit-clock' },
    {
      artifactDigest: `sha256:${'7'.repeat(64)}`,
      jobId: 'explicit-clock-job',
      runId: 'explicit-clock-run',
      now: new Date(0),
    },
    { db: getDb() },
  );
  assert.equal(deterministic.session.principal, 'principal:explicit-clock');

  const refreshProvider = {
    name: 'completion-expiry-refresh-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: 'principal:refresh-expiry',
          expires_at: new Date(1_000).toISOString(),
        },
      };
    },
    async refreshSession() {
      const expiresAt = new Date(Date.now() + 10).toISOString();
      await new Promise(resolve => setTimeout(resolve, 25));
      return { session: { principal: 'principal:refresh-expiry', expires_at: expiresAt } };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const refreshRequest = { principal: 'principal:refresh-expiry' };
  const refreshContext = {
    artifactDigest: `sha256:${'4'.repeat(64)}`,
    jobId: 'completion-expiry-refresh-job',
    runId: 'completion-expiry-refresh-run',
  };
  await resolveProviderSession(
    refreshProvider,
    refreshRequest,
    { ...refreshContext, now: new Date(0) },
    { db: getDb() },
  );
  await assert.rejects(
    () => resolveProviderSession(
      refreshProvider,
      refreshRequest,
      refreshContext,
      { db: getDb() },
    ),
    error => error.code === 'PROVIDER_SESSION_EXPIRED',
  );
});

test('expired provider sessions re-resolve when refreshSession is unavailable', async () => {
  _resetProviderSessionMemoryForTesting();
  let resolves = 0;
  const provider = {
    name: 'reresolve-only-provider',
    type: 'identity',
    async resolveSession(request) {
      resolves += 1;
      return {
        session: {
          principal: request.principal,
          rotation_id: `resolve-${resolves}`,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async checkRevocation() {
      return { revoked: false };
    },
    async resumeSession() {
      throw new Error('expired sessions must be re-resolved instead of resumed');
    },
  };
  const request = { principal: 'principal:reresolve' };
  const ctx = {
    artifactDigest: `sha256:${'3'.repeat(64)}`,
    jobId: 'reresolve-job',
    runId: 'reresolve-run-1',
  };
  const initial = await resolveProviderSession(provider, request, ctx, { db: getDb() });
  getDb().prepare('UPDATE provider_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), initial.row.id);
  const replaced = await resolveProviderSession(provider, request, {
    ...ctx,
    runId: 'reresolve-run-2',
  }, { db: getDb() });

  assert.equal(resolves, 2);
  assert.equal(replaced.row.id, initial.row.id);
  assert.equal(replaced.row.status, 'active');
  assert.equal(replaced.row.rotation_counter, 1);
  assert.equal(replaced.session.rotation_id, 'resolve-2');
  assert.deepEqual(
    listRuntimeEvents({ runId: 'reresolve-run-2' }).map(event => event.event_type),
    ['provider.session.reresolved'],
  );
});

test('provider sessions fail closed on expired output and indeterminate revocation', async () => {
  _resetProviderSessionMemoryForTesting();
  const artifactDigest = `sha256:${'d'.repeat(64)}`;
  const request = { principal: 'principal:provider-fail-closed' };
  const expiredProvider = {
    name: 'expired-output-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: request.principal,
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        },
      };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  await assert.rejects(
    () => resolveProviderSession(expiredProvider, request, {
      artifactDigest,
      jobId: 'expired-output-job',
      runId: 'expired-output-run',
    }, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_EXPIRED',
  );
  assert.equal(
    getDb().prepare(
      'SELECT COUNT(*) AS count FROM provider_sessions WHERE provider_name = ?',
    ).get(expiredProvider.name).count,
    0,
  );

  const indeterminateProvider = {
    name: 'indeterminate-revocation-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: request.principal,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async resumeSession(row) {
      return { session: { principal: row.subject_principal } };
    },
    async checkRevocation() { return {}; },
  };
  const indeterminateContext = {
    artifactDigest,
    jobId: 'indeterminate-revocation-job',
    runId: 'indeterminate-revocation-run',
  };
  await assert.rejects(
    () => resolveProviderSession(
      indeterminateProvider,
      request,
      indeterminateContext,
      { db: getDb() },
    ),
    error => error.code === 'PROVIDER_SESSION_REVOCATION_INDETERMINATE',
  );
  const persisted = getDb().prepare(
    'SELECT * FROM provider_sessions WHERE provider_name = ?',
  ).get(indeterminateProvider.name);
  assert.equal(persisted.revocation_checked_at, null);
  _resetProviderSessionMemoryForTesting();
  await assert.rejects(
    () => resumeProviderSession(
      indeterminateProvider,
      persisted.id,
      indeterminateContext,
      { db: getDb() },
    ),
    error => error.code === 'PROVIDER_SESSION_REVOCATION_INDETERMINATE',
  );
  assert.equal(
    getDb().prepare('SELECT revocation_checked_at FROM provider_sessions WHERE id = ?')
      .get(persisted.id).revocation_checked_at,
    null,
  );
});

test('provider session rotation fails closed on a corrupted persisted summary', () => {
  _resetProviderSessionMemoryForTesting();
  const provider = { name: 'corrupt-summary-provider', type: 'identity' };
  const request = { principal: 'principal:corrupt-summary' };
  const ctx = {
    artifactDigest: `sha256:${'4'.repeat(64)}`,
    jobId: 'corrupt-summary-job',
    runId: 'corrupt-summary-run',
  };
  const initial = adoptProviderSession(provider, request, {
    session: {
      principal: request.principal,
      rotation_id: 'rotation-1',
    },
  }, ctx, { db: getDb() });
  getDb().prepare('UPDATE provider_sessions SET session_summary = ? WHERE id = ?')
    .run('not-json', initial.row.id);

  assert.throws(
    () => adoptProviderSession(provider, request, {
      session: {
        principal: request.principal,
        rotation_id: 'rotation-2',
      },
    }, ctx, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_CORRUPT'
      && error.cause instanceof SyntaxError,
  );
  assert.equal(
    getDb().prepare('SELECT session_summary FROM provider_sessions WHERE id = ?')
      .get(initial.row.id).session_summary,
    'not-json',
  );
});

test('provider session refresh rotates safely, bounds transient retries, and terminates on revocation', async () => {
  _resetProviderSessionMemoryForTesting();
  const artifactDigest = `sha256:${'7'.repeat(64)}`;
  let refreshes = 0;
  let revoked = false;
  const provider = {
    name: 'lifecycle-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: 'principal:lifecycle',
          rotation_id: 'rotation-1',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          refresh_after: new Date(Date.now() - 1_000).toISOString(),
        },
      };
    },
    async refreshSession() {
      refreshes += 1;
      if (refreshes === 1) {
        return { ok: false, error: 'temporary provider outage', transient: true };
      }
      return {
        session: {
          principal: 'principal:lifecycle',
          rotation_id: 'rotation-2',
          expires_at: new Date(Date.now() + 120_000).toISOString(),
          refresh_after: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async checkRevocation() {
      return revoked ? { revoked: true, reason: 'provider revoked session' } : { revoked: false };
    },
  };
  const request = { principal: 'principal:lifecycle', scope: ['read'] };
  const ctx = {
    artifactDigest,
    jobId: 'lifecycle-job',
    runId: 'lifecycle-run',
  };
  const initial = await resolveProviderSession(provider, request, ctx, { db: getDb() });

  await assert.rejects(
    () => resolveProviderSession(provider, request, ctx, {
      db: getDb(),
      maxTransientErrors: 2,
    }),
    error => error.transient === true && /temporary provider outage/.test(error.message),
  );
  assert.equal(
    getDb().prepare('SELECT status FROM provider_sessions WHERE id = ?').get(initial.row.id).status,
    'expired',
  );

  const rotated = await resolveProviderSession(provider, request, ctx, {
    db: getDb(),
    maxTransientErrors: 2,
  });
  assert.equal(rotated.row.id, initial.row.id);
  assert.equal(rotated.row.status, 'active');
  assert.equal(rotated.row.rotation_counter, 1);
  assert.equal(rotated.row.transient_error_count, 0);
  assert.equal(JSON.stringify(rotated.row).includes('rotation-2'), false);

  revoked = true;
  await assert.rejects(
    () => resolveProviderSession(provider, request, ctx, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_REVOKED',
  );
  assert.equal(
    getDb().prepare('SELECT status FROM provider_sessions WHERE id = ?').get(initial.row.id).status,
    'revoked',
  );
  await assert.rejects(
    () => resolveProviderSession(provider, request, ctx, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_REVOKED',
  );
});

test('provider session transient retry exhaustion and terminal errors are deterministic', async () => {
  _resetProviderSessionMemoryForTesting();
  const artifactDigest = `sha256:${'6'.repeat(64)}`;
  let refreshes = 0;
  const provider = {
    name: 'terminal-provider',
    type: 'identity',
    async resolveSession() {
      return {
        session: {
          principal: 'principal:terminal',
          refresh_after: new Date(Date.now() - 1_000).toISOString(),
        },
      };
    },
    async refreshSession() {
      refreshes += 1;
      return { ok: false, error: 'still unavailable', transient: true };
    },
    async checkRevocation() { return { revoked: false }; },
  };
  const request = { principal: 'principal:terminal' };
  const ctx = { artifactDigest, jobId: 'terminal-job', runId: 'terminal-run' };
  const initial = await resolveProviderSession(provider, request, ctx, { db: getDb() });
  await assert.rejects(
    () => resolveProviderSession(provider, request, ctx, {
      db: getDb(),
      maxTransientErrors: 1,
    }),
    error => error.code === 'PROVIDER_SESSION_RETRY_EXHAUSTED',
  );
  assert.equal(refreshes, 1);
  assert.equal(
    getDb().prepare('SELECT status FROM provider_sessions WHERE id = ?').get(initial.row.id).status,
    'failed',
  );
  await assert.rejects(
    () => resolveProviderSession(provider, request, ctx, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_FAILED',
  );
  assert.equal(refreshes, 1);
});

test('resumed provider sessions refresh expired state before reuse and then recheck revocation', async () => {
  _resetProviderSessionMemoryForTesting();
  const artifactDigest = `sha256:${'3'.repeat(64)}`;
  const request = { principal: 'principal:resume-refresh' };
  const ctx = { artifactDigest, jobId: 'resume-refresh-job', runId: 'resume-refresh-run' };
  let refreshes = 0;
  let revocationChecks = 0;
  const provider = {
    name: 'resume-refresh-provider',
    type: 'identity',
    async resumeSession() {
      return { session: { principal: request.principal, rotation_id: 'resume-1' } };
    },
    async refreshSession() {
      refreshes += 1;
      return {
        session: {
          principal: request.principal,
          rotation_id: 'resume-2',
          expires_at: new Date(Date.now() + 120_000).toISOString(),
          refresh_after: new Date(Date.now() + 60_000).toISOString(),
        },
      };
    },
    async checkRevocation() {
      revocationChecks += 1;
      return { revoked: false };
    },
  };
  const adopted = adoptProviderSession(provider, request, {
    session: {
      principal: request.principal,
      rotation_id: 'resume-1',
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      refresh_after: new Date(Date.now() + 60_000).toISOString(),
    },
  }, ctx, { db: getDb() });
  getDb().prepare('UPDATE provider_sessions SET expires_at = ?, refresh_after = ? WHERE id = ?')
    .run(
      new Date(Date.now() - 2_000).toISOString(),
      new Date(Date.now() - 3_000).toISOString(),
      adopted.row.id,
    );
  _resetProviderSessionMemoryForTesting();

  const resumed = await resumeProviderSession(provider, adopted.row.id, ctx, { db: getDb() });
  assert.equal(refreshes, 1);
  assert.equal(revocationChecks, 1);
  assert.equal(resumed.row.status, 'active');
  assert.equal(resumed.row.rotation_counter, 1);
  assert.equal(resumed.session.rotation_id, 'resume-2');

  await assert.rejects(
    () => resumeProviderSession(provider, adopted.row.id, {
      ...ctx,
      artifactDigest: `sha256:${'4'.repeat(64)}`,
    }, { db: getDb() }),
    error => error.code === 'PROVIDER_SESSION_ARTIFACT_MISMATCH',
  );
});

test('temp-file credentials are tracked before write and recover without persisting secrets', async () => {
  const schedulerHome = mkdtempSync(join(tmpdir(), 'scheduler-v4-credentials-'));
  const previousSchedulerHome = process.env.SCHEDULER_HOME;
  process.env.SCHEDULER_HOME = schedulerHome;
  let observedPath = null;
  try {
    const provider = {
      name: 'credential-provider',
      async materializeCredentials() {
        return {
          bindings: [{
            name: 'api-key',
            medium: 'temp-file',
            key: 'API_KEY_FILE',
            file_name: 'api-key',
            value: 'credential-value-must-not-persist',
          }],
        };
      },
    };
    const materialization = await materializeCredentials(
      provider,
      { session: { id: 'opaque-session' } },
      {
        handoff: 'temp-file',
        bindings: [{
          name: 'api-key',
          medium: 'temp-file',
          env_key: 'API_KEY_FILE',
          file_name: 'api-key',
          required: true,
        }],
      },
      {
        jobId: 'credential-job',
        runId: 'credential-run',
        artifactDigest: `sha256:${'9'.repeat(64)}`,
        sessionTarget: 'shell',
      },
      {
        db: getDb(),
        onPresentationPersisted({ id, tempPath }) {
          observedPath = tempPath;
          const row = getDb().prepare(
            'SELECT status, temp_path FROM credential_presentations WHERE id = ?',
          ).get(id);
          assert.equal(row.status, 'materialized');
          assert.equal(row.temp_path, tempPath);
          assert.equal(existsSync(tempPath), false);
        },
      },
    );

    assert.equal(existsSync(observedPath), true);
    assert.equal(readFileSync(observedPath, 'utf8'), 'credential-value-must-not-persist');
    const rows = listCredentialPresentations({ runId: 'credential-run' });
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes('credential-value-must-not-persist'), false);
    assert.match(rows[0].value_sha256, /^[0-9a-f]{64}$/);

    const recovered = recoverCredentialPresentations({ db: getDb() });
    assert.deepEqual(recovered.failed, []);
    assert.deepEqual(recovered.recovered, [rows[0].id]);
    assert.equal(existsSync(observedPath), false);
    assert.equal(
      getDb().prepare('SELECT status FROM credential_presentations WHERE id = ?').get(rows[0].id).status,
      'recovery_cleaned',
    );

    await cleanupCredentialMaterialization(materialization, {
      jobId: 'credential-job',
      runId: 'credential-run',
      artifactDigest: `sha256:${'9'.repeat(64)}`,
    }, { db: getDb() });
  } finally {
    if (previousSchedulerHome === undefined) delete process.env.SCHEDULER_HOME;
    else process.env.SCHEDULER_HOME = previousSchedulerHome;
    rmSync(schedulerHome, { recursive: true, force: true });
  }
});

test('failed credential cleanup remains recoverable on the next cleanup pass', async () => {
  const schedulerHome = mkdtempSync(join(tmpdir(), 'scheduler-v4-cleanup-retry-'));
  const previousSchedulerHome = process.env.SCHEDULER_HOME;
  process.env.SCHEDULER_HOME = schedulerHome;
  try {
    const materialization = await materializeCredentials(
      {
        name: 'cleanup-retry-provider',
        async materializeCredentials() {
          return {
            bindings: [{
              name: 'retry-secret',
              medium: 'temp-file',
              key: 'RETRY_SECRET_FILE',
              file_name: 'retry-secret',
              value: 'cleanup-retry-secret',
            }],
          };
        },
      },
      { session: { id: 'cleanup-retry-session' } },
      {
        handoff: 'temp-file',
        bindings: [{
          name: 'retry-secret',
          medium: 'temp-file',
          env_key: 'RETRY_SECRET_FILE',
          file_name: 'retry-secret',
          required: true,
        }],
      },
      {
        jobId: 'cleanup-retry-job',
        runId: 'cleanup-retry-run',
        artifactDigest: `sha256:${'2'.repeat(64)}`,
        sessionTarget: 'shell',
      },
      { db: getDb() },
    );
    const [presentation] = listCredentialPresentations({ runId: 'cleanup-retry-run' });
    const tempPath = materialization.tempPaths[0];
    rmSync(tempPath);
    mkdirSync(tempPath);

    await assert.rejects(
      () => cleanupCredentialMaterialization(materialization, {
        jobId: 'cleanup-retry-job',
        runId: 'cleanup-retry-run',
        artifactDigest: `sha256:${'2'.repeat(64)}`,
      }, { db: getDb() }),
      error => error.code === 'CREDENTIAL_CLEANUP_FAILED',
    );
    assert.equal(
      getDb().prepare('SELECT status FROM credential_presentations WHERE id = ?')
        .get(presentation.id).status,
      'failed',
    );

    rmSync(tempPath, { recursive: true });
    writeFileSync(tempPath, 'cleanup-retry-secret');
    const recovered = recoverCredentialPresentations({ db: getDb() });
    assert.deepEqual(recovered.failed, []);
    assert.deepEqual(recovered.recovered, [presentation.id]);
    assert.equal(existsSync(tempPath), false);
    assert.equal(
      getDb().prepare('SELECT status FROM credential_presentations WHERE id = ?')
        .get(presentation.id).status,
      'recovery_cleaned',
    );
  } finally {
    if (previousSchedulerHome === undefined) delete process.env.SCHEDULER_HOME;
    else process.env.SCHEDULER_HOME = previousSchedulerHome;
    rmSync(schedulerHome, { recursive: true, force: true });
  }
});

test('credential presentation enforces target media and never persists env, stdin, or gateway secrets', async () => {
  const schedulerHome = mkdtempSync(join(tmpdir(), 'scheduler-v4-media-'));
  const previousSchedulerHome = process.env.SCHEDULER_HOME;
  process.env.SCHEDULER_HOME = schedulerHome;
  const cases = [
    { medium: 'env', target: 'shell', key: 'ENV_SECRET', field: 'env' },
    { medium: 'stdin', target: 'shell', key: null, field: 'stdin' },
    {
      medium: 'gateway-env-header',
      target: 'isolated',
      key: 'GATEWAY_SECRET',
      field: 'gatewayEnv',
    },
  ];
  try {
    for (const [index, item] of cases.entries()) {
      const secret = `credential-media-secret-${index}`;
      const provider = {
        name: `credential-media-provider-${index}`,
        async materializeCredentials() {
          return {
            bindings: [{
              name: `binding-${index}`,
              medium: item.medium,
              key: item.key,
              value: secret,
            }],
          };
        },
      };
      const runId = `credential-media-run-${index}`;
      const materialized = await materializeCredentials(
        provider,
        { session: { id: `session-${index}` } },
        {
          handoff: item.medium,
          bindings: [{
            name: `binding-${index}`,
            medium: item.medium,
            env_key: item.key,
            file_name: null,
            required: true,
          }],
        },
        {
          jobId: `credential-media-job-${index}`,
          runId,
          artifactDigest: `sha256:${String(index + 1).repeat(64)}`,
          sessionTarget: item.target,
        },
        { db: getDb() },
      );
      if (item.field === 'stdin') {
        const stdinBuffer = materialized.stdin;
        assert.equal(stdinBuffer.toString('utf8'), secret);
        await cleanupCredentialMaterialization(materialized, { runId }, {
          db: getDb(),
        });
        assert.equal(stdinBuffer.every(value => value === 0), true);
      } else {
        assert.equal(materialized[item.field][item.key], secret);
        await cleanupCredentialMaterialization(materialized, { runId }, {
          db: getDb(),
        });
      }
      const rows = listCredentialPresentations({ runId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'cleaned');
      assert.equal(JSON.stringify(rows).includes(secret), false);
      assert.equal(JSON.stringify(listRuntimeEvents({ runId })).includes(secret), false);
    }

    let providerCalls = 0;
    const refusingProvider = {
      name: 'refusing-provider',
      async materializeCredentials() { providerCalls += 1; return { bindings: [] }; },
    };
    for (const item of [
      { target: 'main', medium: 'env', code: 'CREDENTIAL_MAIN_SESSION_REFUSED' },
      { target: 'isolated', medium: 'env', code: 'CREDENTIAL_MEDIUM_UNSUPPORTED' },
      { target: 'shell', medium: 'gateway-env-header', code: 'CREDENTIAL_MEDIUM_UNSUPPORTED' },
    ]) {
      await assert.rejects(
        () => materializeCredentials(
          refusingProvider,
          { session: {} },
          { handoff: item.medium },
          {
            runId: `refused-${item.target}-${item.medium}`,
            artifactDigest: `sha256:${'5'.repeat(64)}`,
            sessionTarget: item.target,
          },
          { db: getDb() },
        ),
        error => error.code === item.code,
      );
    }
    assert.equal(providerCalls, 0);
  } finally {
    if (previousSchedulerHome === undefined) delete process.env.SCHEDULER_HOME;
    else process.env.SCHEDULER_HOME = previousSchedulerHome;
    rmSync(schedulerHome, { recursive: true, force: true });
  }
});

test('credential materialization rejects missing, extra, duplicate, and retargeted provider bindings', async () => {
  const presentation = {
    handoff: 'env',
    bindings: [{
      name: 'token',
      medium: 'env',
      env_key: 'EXACT_TOKEN',
      file_name: null,
      required: true,
    }],
  };
  const invalidBindings = [
    [],
    [{ name: 'extra', medium: 'env', key: 'EXACT_TOKEN', value: 'secret' }],
    [
      { name: 'token', medium: 'env', key: 'EXACT_TOKEN', value: 'secret' },
      { name: 'token', medium: 'env', key: 'EXACT_TOKEN', value: 'secret' },
    ],
    [{ name: 'token', medium: 'env', key: 'OTHER_TOKEN', value: 'secret' }],
    [{ name: 'token', medium: 'stdin', key: 'EXACT_TOKEN', value: 'secret' }],
  ];
  for (const [index, bindings] of invalidBindings.entries()) {
    await assert.rejects(
      () => materializeCredentials(
        {
          name: `invalid-binding-provider-${index}`,
          async materializeCredentials() { return { bindings }; },
        },
        { session: {} },
        presentation,
        {
          runId: `invalid-binding-run-${index}`,
          artifactDigest: `sha256:${String(index + 1).repeat(64)}`,
          sessionTarget: 'shell',
        },
        { db: getDb() },
      ),
      error => error.code === 'CREDENTIAL_BINDING_INVALID',
    );
  }
  await assert.rejects(
    () => materializeCredentials(
      {
        name: 'invalid-file-binding-provider',
        async materializeCredentials() {
          return { bindings: [{
            name: 'token-file',
            medium: 'temp-file',
            key: 'TOKEN_FILE',
            file_name: 'provider-selected-name',
            value: 'secret',
          }] };
        },
      },
      { session: {} },
      {
        handoff: 'temp-file',
        bindings: [{
          name: 'token-file',
          medium: 'temp-file',
          env_key: 'TOKEN_FILE',
          file_name: 'artifact-selected-name',
          required: true,
        }],
      },
      {
        runId: 'invalid-binding-run-file-name',
        artifactDigest: `sha256:${'6'.repeat(64)}`,
        sessionTarget: 'shell',
      },
      { db: getDb() },
    ),
    error => error.code === 'CREDENTIAL_BINDING_INVALID',
  );
  let collidingProviderCalls = 0;
  await assert.rejects(
    () => materializeCredentials(
      {
        name: 'colliding-environment-provider',
        async materializeCredentials() {
          collidingProviderCalls += 1;
          return { bindings: [] };
        },
      },
      { session: {} },
      {
        handoff: 'env',
        bindings: [
          {
            name: 'primary-token',
            medium: 'env',
            env_key: 'SHARED_TOKEN',
            file_name: null,
            required: true,
          },
          {
            name: 'secondary-token',
            medium: 'env',
            env_key: 'SHARED_TOKEN',
            file_name: null,
            required: true,
          },
        ],
      },
      {
        runId: 'invalid-binding-run-env-collision',
        artifactDigest: `sha256:${'8'.repeat(64)}`,
        sessionTarget: 'shell',
      },
      { db: getDb() },
    ),
    error => error.code === 'CREDENTIAL_BINDING_INVALID',
  );
  assert.equal(collidingProviderCalls, 0);
  const optional = await materializeCredentials(
    {
      name: 'optional-binding-provider',
      async materializeCredentials() { return { bindings: [] }; },
    },
    { session: {} },
    {
      handoff: 'env',
      bindings: [{
        name: 'optional-token',
        medium: 'env',
        env_key: 'OPTIONAL_TOKEN',
        file_name: null,
        required: false,
      }],
    },
    {
      runId: 'optional-binding-run',
      artifactDigest: `sha256:${'7'.repeat(64)}`,
      sessionTarget: 'shell',
    },
    { db: getDb() },
  );
  assert.deepEqual(optional.env, {});
  assert.equal(optional.presentationIds.length, 0);
  await cleanupCredentialMaterialization(optional, { runId: 'optional-binding-run' }, { db: getDb() });
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS count FROM credential_presentations WHERE run_id LIKE 'invalid-binding-run-%'").get().count,
    0,
  );
});

test('stdin credential materialization is piped into the shell command', async () => {
  const secret = Buffer.from('stdin-credential-value', 'utf8');
  const result = await executeShell({
    name: 'stdin credential shell',
    payload_message: 'IFS= read -r value; printf "%s" "$value"',
    run_timeout_ms: 5_000,
    shell_env_policy: 'minimal',
  }, {
    run: { id: 'stdin-credential-shell-run' },
    executionEnv: {},
    v4CredentialMaterialization: { stdin: secret },
  }, {
    runShellCommand,
    normalizeShellResult,
    log() {},
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.runFinishFields.shell_stdout, secret.toString('utf8'));
  assert.equal(result.runFinishFields.shell_stdout_sha256, sha256(secret.toString('utf8')));
});

test('stdin credential materialization is piped into watchdog checks', async () => {
  const secret = Buffer.from('watchdog-stdin-credential', 'utf8');
  let observedStdin = null;
  await executeWatchdog({
    name: 'stdin credential watchdog',
    watchdog_check_cmd: 'ignored by test double',
    watchdog_self_destruct: 0,
    run_timeout_ms: 5_000,
    shell_env_policy: 'minimal',
  }, {
    run: { id: 'stdin-credential-watchdog-run' },
    executionEnv: {},
    v4CredentialMaterialization: { stdin: secret },
  }, {
    async runShellCommand(_command, _timeout, _env, options) {
      observedStdin = options.stdin;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async handleDelivery() {},
    log() {},
  });
  assert.equal(observedStdin, secret);
});

test('shell evidence digests bind normalized stdout after image marker extraction', async () => {
  const result = await executeShell({
    name: 'image marker shell',
    payload_message: 'ignored by test double',
    run_timeout_ms: 5_000,
    shell_env_policy: 'minimal',
  }, {
    run: { id: 'image-marker-shell-run' },
    executionEnv: {},
  }, {
    async runShellCommand() {
      return {
        stdout: '[IMAGE:/tmp/chart.png]\nnormalized-output\n',
        stderr: '',
      };
    },
    normalizeShellResult,
    log() {},
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.runFinishFields.shell_stdout, 'normalized-output');
  assert.equal(result.runFinishFields.shell_stdout_sha256, sha256('normalized-output'));
  assert.equal(result.evidenceOutput.stdout_sha256, sha256('normalized-output'));
  assert.deepEqual(result.imageAttachments, ['/tmp/chart.png']);
});

test('required signed v4 evidence failures durably block recovery', async () => {
  const input = manifest('Required signed evidence failure');
  input.evidence_profiles = [{
    id: 'required-signed-evidence',
    provider: 'ssh',
    methods: ['ssh-signature'],
    provider_config: {
      key_path: '/tmp/unavailable-scheduler-evidence-key',
      principal: 'scheduler-test',
      allowed_signers_path: '/tmp/unavailable-scheduler-allowed-signers',
    },
    payload: { format: 'canonical-json' },
    verify: { required: true },
  }];
  input.workflows[0].tasks[0].evidence = { ref: 'required-signed-evidence' };
  input.workflows[0].tasks[0].contract = { audit: 'always' };
  const job = createJob(schedulerSpecFromManifest(input));
  const run = createRun(job.id);
  const ctx = {
    run,
    idemKey: null,
    dispatchRecord: null,
    v02Outcomes: null,
    v4Artifact: assertArtifactMatchesJob(job),
  };
  await finalizeDispatch(job, ctx, {
    status: 'ok',
    summary: 'primary execution completed',
    content: 'primary execution completed',
    errorMessage: null,
    runFinishFields: {},
    skipDelivery: true,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: true,
    skipAgentCleanup: true,
    idemAction: 'noop',
    retryFiresChildren: false,
    earlyReturn: false,
  }, {
    finishRun,
    updateIdempotencyResultHash: () => {},
    releaseIdempotencyKey: () => {},
    setAgentStatus: () => {},
    handleDelivery: () => null,
    shouldRetry: () => false,
    scheduleRetry: () => null,
    getDb,
    updateJobAfterRun: () => {},
    updateJob,
    setDispatchStatus: () => null,
    handleTriggeredChildren: () => {},
    dequeueJob: () => false,
    log: () => {},
    clearMaterializedEnvironment: () => {},
    async prepareArtifactBoundEvidence() {
      throw Object.assign(new Error('evidence signer unavailable'), {
        code: 'EVIDENCE_SIGNING_FAILED',
      });
    },
  });

  const blocked = getRun(run.id);
  assert.equal(blocked.status, 'recovery_blocked');
  assert.match(blocked.error_message, /Required handoff v4 evidence failed/);
  assert.equal(getJob(job.id).enabled, 0);
  assert.equal(await verifyPersistedArtifactBoundEvidence(run.id), null);
  const failedEvent = listRuntimeEvents({
    runId: run.id,
    eventType: 'evidence.failed',
  }).at(-1);
  assert.equal(failedEvent.payload.required, true);
});

test('verified evidence envelopes without payload digests use one consistent hash fallback', async () => {
  const job = createV4Job('Envelope digest fallback');
  const artifact = assertArtifactMatchesJob(job);
  const run = createRun(job.id);
  const profile = {
    ref: 'envelope-digest-fallback',
    provider: 'test-envelope-provider',
    provider_config: { principal: 'fallback-principal' },
    payload: { format: 'canonical-json' },
    verify: { required: true },
  };
  getDb().prepare('UPDATE runs SET evidence_ref_snapshot = ?, evidence_declaration_snapshot = ? WHERE id = ?').run(
    profile.ref,
    JSON.stringify(profile),
    run.id,
  );
  finishRun(run.id, 'ok', {
    summary: 'fallback evidence complete',
    shell_exit_code: 0,
    shell_stdout: 'fallback-output',
    shell_stderr: '',
    shell_stdout_sha256: sha256('fallback-output'),
    shell_stderr_sha256: sha256(''),
  });

  const [evidenceApi, payloadApi] = await Promise.all([
    import('@amittell/agentcli/evidence'),
    import('@amittell/agentcli/evidence/payload'),
  ]);
  const provider = {
    resolve() { return {}; },
    attest(serialized) {
      return {
        attested: true,
        envelope: {
          method: 'test-envelope',
          signed_payload: serialized,
        },
      };
    },
  };
  const agentcli = {
    ...evidenceApi,
    ...payloadApi,
    resolveEvidenceProvider() { return provider; },
    async verifyEvidenceEnvelope(envelope) {
      return { verified: true, payload: JSON.parse(envelope.signed_payload) };
    },
  };
  const stored = await persistArtifactBoundEvidence(
    { ...job, evidence_ref: profile.ref, evidence: JSON.stringify(profile) },
    artifact,
    run.id,
    { agentcli, principal: 'fallback-principal' },
  );
  const envelope = JSON.parse(stored.evidence_envelope);
  assert.equal(Object.hasOwn(envelope, 'payload_digest'), false);
  assert.equal(stored.hash, sha256(canonicalStringify(envelope)));

  const verified = await verifyPersistedArtifactBoundEvidence(run.id, { agentcli });
  assert.equal(verified.integrity.valid, true, verified.integrity.error);
  assert.equal(verified.integrity.cryptographically_verified, true);
});

test('credential capability negotiation fails before release and binds fresh runtime nonces', async () => {
  const context = {
    jobId: 'capability-job',
    runId: 'capability-run',
    artifactDigest: `sha256:${'8'.repeat(64)}`,
    runtimeInstanceId: 'runtime-instance',
    sessionTarget: 'shell',
    presentationRequired: true,
  };
  await assert.rejects(
    () => negotiateCredentialCapabilities(null, context, {
      db: getDb(),
      localCapabilityResolver: () => ['artifact-bound-runtime-v1'],
    }),
    error => error.code === 'CAPABILITY_NEGOTIATION_DOWNGRADE',
  );

  const first = await negotiateCredentialCapabilities(null, context, {
    db: getDb(),
    localCapabilityResolver: () => [
      'artifact-bound-runtime-v1',
      'shell-credential-presentation-v1',
    ],
  });
  const second = await negotiateCredentialCapabilities({ env: { TOKEN: 'redacted' } }, context, {
    db: getDb(),
    localCapabilityResolver: () => [
      'artifact-bound-runtime-v1',
      'shell-credential-presentation-v1',
    ],
  });
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(JSON.stringify(listRuntimeEvents({ runId: context.runId })).includes('redacted'), false);

  const main = await negotiateCredentialCapabilities(null, {
    ...context,
    runId: 'capability-main-run',
    sessionTarget: 'main',
    presentationRequired: false,
  }, {
    db: getDb(),
    gateway: {
      gatewayUrl: 'https://gateway-capability.test',
      fetchImpl: async () => new Response(JSON.stringify({
        version: '2026.7.19',
        protocol: 4,
        capabilities: ['capability-binding-v1'],
      }), { headers: { 'content-type': 'application/json' } }),
    },
  });
  assert.equal(main.gateway.capabilities.includes('capability-binding-v1'), true);
  assert.equal(main.headers['x-openclaw-handoff-artifact'], context.artifactDigest);
  assert.equal(main.headers['x-openclaw-runtime-instance'], context.runtimeInstanceId);
  assert.equal(main.headers['x-openclaw-capability-nonce'], main.nonce);
  await assert.rejects(
    () => negotiateCredentialCapabilities(null, {
      ...context,
      runId: 'capability-main-credential-run',
      sessionTarget: 'main',
      presentationRequired: true,
    }, { db: getDb() }),
    error => error.code === 'CREDENTIAL_MAIN_SESSION_REFUSED',
  );
});

test('persisted SSH evidence is cryptographically reverified against the exact execution', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'scheduler-v4-evidence-'));
  const unrelatedCwd = mkdtempSync(join(tmpdir(), 'scheduler-v4-evidence-cwd-'));
  const keyPath = join(workdir, 'evidence-key');
  const allowedSignersPath = join(workdir, 'allowed_signers');
  const untrustedKeyPath = join(workdir, 'untrusted-key');
  try {
    for (const path of [keyPath, untrustedKeyPath]) {
      const generated = spawnSync('ssh-keygen', [
        '-q', '-t', 'ed25519', '-N', '', '-f', path,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(generated.status, 0, generated.stderr);
    }
    writeFileSync(
      allowedSignersPath,
      `scheduler-test ${readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`,
      { mode: 0o600 },
    );

    const input = manifest('Signed evidence');
    input.evidence_profiles = [{
      id: 'signed-evidence',
      provider: 'ssh',
      methods: ['ssh-signature'],
      provider_config: {
        key_path: keyPath,
        principal: 'scheduler-test',
        allowed_signers_path: 'allowed_signers',
      },
      payload: { format: 'canonical-json' },
      verify: { required: true },
    }];
    input.workflows[0].tasks[0].evidence = { ref: 'signed-evidence' };
    input.workflows[0].tasks[0].contract = { audit: 'always' };
    const job = createJob(schedulerSpecFromManifest(input));
    const run = createRun(job.id);
    const fullStdout = 'expected-output-from-the-complete-offloaded-artifact';
    const stdoutPath = join(workdir, 'full-stdout.txt');
    writeFileSync(stdoutPath, fullStdout, { mode: 0o600 });
    finishRun(run.id, 'ok', {
      summary: 'signed evidence completed',
      shell_exit_code: 0,
      shell_stdout: 'expected-output\n...[truncated]',
      shell_stderr: '',
      shell_stdout_path: stdoutPath,
      shell_stdout_bytes: Buffer.byteLength(fullStdout, 'utf8'),
      shell_stderr_bytes: 0,
      shell_stdout_sha256: sha256(fullStdout),
      shell_stderr_sha256: sha256(''),
      verification_result: JSON.stringify({ passed: true }),
    });

    const stored = await persistArtifactBoundEvidence(
      job,
      assertArtifactMatchesJob(job),
      run.id,
      {
        cwd: workdir,
        allowedSignersPath,
        principal: 'scheduler-test',
        env: {
          ...process.env,
          AGENTCLI_SIGNING_KEY: keyPath,
          AGENTCLI_ALLOWED_SIGNERS: allowedSignersPath,
        },
      },
    );
    assert.equal(stored.evidence_verified, 1);
    assert.equal(stored.handoff_artifact_digest, job.handoff_artifact_digest);
    assert.equal(stored.evidence_allowed_signers_path, allowedSignersPath);
    assert.equal(stored.payload.includes('expected-output'), false);

    const verified = await verifyPersistedArtifactBoundEvidence(run.id, {
      allowedSignersPath: join(unrelatedCwd, 'wrong-allowed-signers'),
      principal: 'wrong-principal',
      env: { USER: 'wrong-principal' },
    });
    assert.equal(verified.integrity.valid, true, verified.integrity.error);
    assert.equal(verified.integrity.cryptographically_verified, true);
    assert.equal(verified.payload.execution_id, run.id);
    assert.equal(
      verified.payload.bindings.handoff_artifact_digest,
      job.handoff_artifact_digest,
    );
    assert.equal(getRun(run.id).evidence_record.includes(stored.id), true);

    const replacementInput = structuredClone(input);
    replacementInput.workflows[0].tasks[0].schedule.cron = '5 * * * *';
    const replacementSpec = schedulerSpecFromManifest(replacementInput);
    delete replacementSpec.id;
    const replacedJob = updateJob(job.id, replacementSpec);
    assert.notEqual(replacedJob.handoff_artifact_digest, job.handoff_artifact_digest);
    const verifiedAfterReplacement = await verifyPersistedArtifactBoundEvidence(run.id, {
      allowedSignersPath,
      principal: 'scheduler-test',
    });
    assert.equal(
      verifiedAfterReplacement.integrity.valid,
      true,
      verifiedAfterReplacement.integrity.error,
    );
    assert.equal(
      verifiedAfterReplacement.payload.bindings.handoff_artifact_digest,
      job.handoff_artifact_digest,
    );

    writeFileSync(stdoutPath, 'tampered-output-with-a-different-complete-value', { mode: 0o600 });
    const tamperedOutput = await verifyPersistedArtifactBoundEvidence(run.id, {
      allowedSignersPath,
      principal: 'scheduler-test',
    });
    assert.equal(tamperedOutput.integrity.valid, false);
    assert.equal(tamperedOutput.integrity.code, 'EVIDENCE_OUTPUT_DIGEST_MISMATCH');
    writeFileSync(stdoutPath, fullStdout, { mode: 0o600 });

    writeFileSync(
      allowedSignersPath,
      `scheduler-test ${readFileSync(`${untrustedKeyPath}.pub`, 'utf8').trim()}\n`,
      { mode: 0o600 },
    );
    const trustRevoked = await verifyPersistedArtifactBoundEvidence(run.id, {
      allowedSignersPath,
      principal: 'scheduler-test',
    });
    assert.equal(trustRevoked.integrity.valid, false);
    assert.equal(trustRevoked.integrity.cryptographically_verified, false);

    writeFileSync(
      allowedSignersPath,
      `scheduler-test ${readFileSync(`${keyPath}.pub`, 'utf8').trim()}\n`,
      { mode: 0o600 },
    );
    assert.equal(deleteJob(job.id), true);
    assert.equal(getRun(run.id), undefined);
    const originalCwd = process.cwd();
    let retainedVerification;
    try {
      process.chdir(unrelatedCwd);
      retainedVerification = await verifyPersistedArtifactBoundEvidence(run.id);
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(
      retainedVerification.integrity.valid,
      true,
      retainedVerification.integrity.error,
    );
    assert.equal(retainedVerification.payload.execution_id, run.id);
    assert.equal(retainedVerification.evidence_provider, 'ssh');
    assert.equal(retainedVerification.evidence_principal, 'scheduler-test');

    assert.throws(
      () => getDb().prepare(
        'UPDATE evidence_records SET handoff_artifact_digest = ? WHERE id = ?',
      ).run(`sha256:${'0'.repeat(64)}`, stored.id),
      /handoff v4 evidence is immutable/,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});
