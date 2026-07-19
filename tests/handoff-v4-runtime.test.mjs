import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
import { executeShell } from '../dispatcher-strategies.js';
import { normalizeShellResult } from '../shell-result.js';
import { createApproval } from '../approval.js';
import { createJob, updateJob } from '../jobs.js';
import { claimProofReplay, verifyArtifactBoundProof } from '../proof-runtime.js';
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
} from '../runs.js';
import { getRuntimeEvent, listRuntimeEvents } from '../runtime-events.js';

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
  ]) {
    assert.throws(
      () => updateJob(job.id, patch),
      error => error.code === 'HANDOFF_ARTIFACT_REQUIRED',
    );
  }
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
      expires_at: new Date(Date.now() - 2_000).toISOString(),
      refresh_after: new Date(Date.now() - 3_000).toISOString(),
    },
  }, ctx, { db: getDb() });
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
    localCapabilityResolver: () => ['artifact-bound-runtime-v1'],
  });
  assert.equal(main.local.capabilities.includes('artifact-bound-runtime-v1'), true);
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
        allowed_signers_path: allowedSignersPath,
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
    assert.equal(stored.payload.includes('expected-output'), false);

    const verified = await verifyPersistedArtifactBoundEvidence(run.id, {
      allowedSignersPath,
      principal: 'scheduler-test',
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

    assert.throws(
      () => getDb().prepare(
        'UPDATE evidence_records SET handoff_artifact_digest = ? WHERE id = ?',
      ).run(`sha256:${'0'.repeat(64)}`, stored.id),
      /handoff v4 evidence is immutable/,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
