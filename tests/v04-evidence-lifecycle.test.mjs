import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { enqueueDispatch, getDispatch } from '../dispatch-queue.js';
import { checkRunHealth } from '../dispatcher-maintenance.js';
import { executeShell, finalizeDispatch } from '../dispatcher-strategies.js';
import { clearMaterializedEnvironment } from '../governance.js';
import { createJob, deleteJob, getJob, updateJob, validateJobSpec } from '../jobs.js';
import {
  createRun,
  finishRun,
  getEvidenceRecord,
  getRun,
  persistTerminalEvidence,
  persistV02Outcomes,
  pruneEvidenceRecords,
  transitionRunTerminalWithEvidence,
} from '../runs.js';
import { requestRunCancellation, transitionRunTerminal } from '../run-state.js';
import { normalizeShellResult } from '../shell-result.js';
import {
  commitCompletionBookkeeping,
  completeRunFenced,
  shouldRunPostCompletionEffects,
} from '../run-completion.js';
import { generateEvidence, verifyEvidenceRecord } from '../v02-runtime.js';

const fixtureDir = mkdtempSync(join(tmpdir(), 'scheduler-v04-evidence-'));
const dbPath = join(fixtureDir, 'scheduler.db');

function jobSpec(name, extra = {}) {
  return {
    name,
    schedule_cron: '0 0 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf original-payload',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    origin: 'system',
    evidence_ref: `audit:${name}`,
    evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
    ...extra,
  };
}

function doctor() {
  try {
    return JSON.parse(execFileSync(process.execPath, ['cli.js', 'doctor', '--json'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, SCHEDULER_DB: dbPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    return JSON.parse(String(error.stdout || '{}'));
  }
}

before(async () => {
  setDbPath(dbPath);
  await initDb();
});

after(() => {
  closeDb();
  rmSync(fixtureDir, { recursive: true, force: true });
});

test('job validation rejects every checksum declaration that generation cannot honor', () => {
  const invalidDeclarations = [
    { methods: [] },
    { methods: ['sha256', 'sha256'] },
    { payload: { bind: ['result', 'result'] } },
    { payload: { bind: ['context'], context: {} } },
    { payload: { bind: ['identity'] } },
    { payload: { bind: ['trust'] } },
    { payload: { bind: ['authorization'] } },
    { payload: { bind: ['authorization_proof'] } },
    { payload: { bind: ['delegation'] } },
    { payload: { bind: ['credential_handoff'] } },
    { collect: ['stdout', 'stdout'] },
    { retention: '101y' },
    { payload: { context: [] } },
    { ref: 'audit:different' },
    { provider_config: { signer: 'unavailable' } },
  ];
  for (const [index, evidence] of invalidDeclarations.entries()) {
    assert.throws(
      () => validateJobSpec(jobSpec(`invalid-evidence-${index}`, {
        evidence_ref: `audit:invalid-evidence-${index}`,
        evidence: JSON.stringify(evidence),
      }), null, 'create'),
      /evidence/i,
    );
  }

  const emptyProviderConfig = createJob(jobSpec('empty-provider-config', {
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      provider_config: {},
    }),
  }));
  const run = createRun(emptyProviderConfig.id);
  const transition = transitionRunTerminalWithEvidence(
    emptyProviderConfig,
    run.id,
    'ok',
    { summary: 'valid empty provider configuration' },
  );
  assert.equal(transition.changed, true);
  assert.equal(getEvidenceRecord(run.id).integrity.valid, true);

  assert.throws(
    () => validateJobSpec(jobSpec('identity-binding-excluded-from-collect', {
      identity_subject_kind: 'service',
      identity_principal: 'service:evidence-test',
      evidence: JSON.stringify({
        provider: 'sha256',
        methods: ['sha256'],
        collect: ['result'],
        payload: { bind: ['identity'] },
      }),
    }), null, 'create'),
    /evidence/i,
  );
});

test('evidence verification requires data for every requested binding', () => {
  const evidence = generateEvidence({
    id: 'binding-verifier-job',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    contract_required_trust_level: 'supervised',
    contract_trust_enforcement: 'block',
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      collect: ['identity', 'result'],
      payload: { bind: ['identity', 'trust'] },
    }),
  }, {
    id: 'binding-verifier-run',
    status: 'ok',
    summary: 'bound result',
  }, {
    identity_resolved: {
      source: 'structural',
      subject_kind: 'service',
      principal: 'service:binding-verifier',
      trust_level: 'supervised',
    },
    trust_evaluation: {
      effective_level: 'supervised',
      required_level: 'supervised',
      decision: 'permit',
      reason: 'meets declared level',
    },
  });
  assert.equal(evidence.payload.outcomes.trust.required, 'supervised');
  assert.equal(evidence.payload.outcomes.trust.actual, 'supervised');
  assert.equal(evidence.payload.outcomes.trust.enforcement, 'block');
  assert.equal(verifyEvidenceRecord(evidence).valid, true);

  const tampered = structuredClone(evidence);
  tampered.payload.outcomes.identity = null;
  delete tampered.payload_summary;
  tampered.hash = `sha256:${createHash('sha256').update(JSON.stringify(tampered.payload)).digest('hex')}`;
  const verification = verifyEvidenceRecord(tampered);
  assert.equal(verification.valid, false);
  assert.match(verification.error, /missing requested identity binding data/);
});

test('run snapshots bind the original execution and evidence declaration across job edits', () => {
  const job = createJob(jobSpec('snapshot-binding', {
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      collect: ['stdout'],
      retention: '30d',
    }),
  }));
  const run = createRun(job.id);
  updateJob(job.id, {
    payload_message: 'printf changed-after-run-start',
    evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'], collect: ['stderr'] }),
  });
  transitionRunTerminalWithEvidence(
    getJob(job.id),
    run.id,
    'ok',
    { shell_stdout: 'original output', shell_stdout_bytes: 15, summary: 'completed' },
  );
  const evidence = getEvidenceRecord(run.id);
  const originalPayloadHash = `sha256:${createHash('sha256').update('printf original-payload').digest('hex')}`;
  assert.equal(evidence.payload.execution_contract.command.payload_sha256, originalPayloadHash);
  assert.deepEqual(evidence.payload.declaration.collect, ['stdout']);
  assert.equal(evidence.payload.result.stdout_sha256.startsWith('sha256:'), true);
  assert.equal(evidence.payload.result.stderr_sha256, null);

  const mutableSummary = generateEvidence(
    { ...job, id: 'summary-integrity-job' },
    { id: 'summary-integrity-run', status: 'ok', output: 'output' },
    {},
  );
  mutableSummary.payload_summary.run_status = 'error';
  assert.equal(verifyEvidenceRecord(mutableSummary).valid, false);
});

test('retention pruning writes an auditable tombstone and does not make doctor unhealthy', () => {
  const job = createJob(jobSpec('retention-prune', {
    evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'], retention: '1m' }),
  }));
  const run = createRun(job.id);
  transitionRunTerminalWithEvidence(job, run.id, 'ok', { summary: 'retained briefly' });
  const result = pruneEvidenceRecords({ now: Date.now() + 61_000 });
  assert.equal(result.changes, 1);
  assert.equal(getEvidenceRecord(run.id), null);
  const tombstone = JSON.parse(getRun(run.id).evidence_record);
  assert.equal(tombstone.pruned, true);
  assert.equal(tombstone.reason, 'retention_expired');
  const diagnostics = doctor();
  assert.equal(diagnostics.diagnostics.evidence_records.missing, 0);
  assert.equal(diagnostics.diagnostics.evidence_records.invalid, 0);
});

test('corrupt evidence is retained, reported without crashing, and makes doctor unhealthy', () => {
  const job = createJob(jobSpec('corrupt-evidence', {
    evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'], retention: '1m' }),
  }));
  const run = createRun(job.id);
  transitionRunTerminalWithEvidence(job, run.id, 'ok', { summary: 'corruption fixture' });
  const secretMalformedPayload = 'TOP-SECRET-EVIDENCE-123';
  getDb().prepare('UPDATE evidence_records SET payload = ? WHERE run_id = ?')
    .run(secretMalformedPayload, run.id);
  assert.equal(pruneEvidenceRecords({ now: Date.now() + 61_000 }).changes, 0);
  const corruptRecord = getEvidenceRecord(run.id);
  assert.equal(corruptRecord.integrity.valid, false);
  assert.equal(corruptRecord.integrity.error, 'stored payload is invalid JSON');
  const diagnostics = doctor();
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.diagnostics.evidence_records.invalid > 0, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secretMalformedPayload));
  getDb().prepare('DELETE FROM evidence_records WHERE run_id = ?').run(run.id);
  getDb().prepare("UPDATE runs SET evidence_record = '{\"pruned\":true,\"reason\":\"retention_expired\"}' WHERE id = ?").run(run.id);
});

test('retained evidence remains accessible after the run and job are deleted', () => {
  const job = createJob(jobSpec('deleted-run-evidence'));
  const run = createRun(job.id);
  transitionRunTerminalWithEvidence(job, run.id, 'ok', { summary: 'delete after evidence' });
  deleteJob(job.id);
  assert.equal(getRun(run.id), undefined);
  const output = execFileSync(process.execPath, ['cli.js', 'runs', 'evidence', run.id, '--json'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SCHEDULER_DB: dbPath },
    encoding: 'utf8',
  });
  const response = JSON.parse(output);
  assert.equal(response.ok, true);
  assert.equal(response.evidence.run_id, run.id);
});

test('recovery records interrupted verification in the run and evidence postcondition', () => {
  const job = createJob(jobSpec('verification-recovery', {
    verify_shell: 'test -f /tmp/verification-result',
    verify_timeout_s: 5,
    verify_on_failure: 'error',
  }));
  const run = createRun(job.id);
  const editedJob = updateJob(job.id, {
    verify_shell: null,
    verify_timeout_s: null,
    verify_on_failure: null,
  });
  finishRun(run.id, 'crashed', { summary: 'dispatcher restarted during verification' });
  const evidence = persistTerminalEvidence(
    editedJob,
    run.id,
    'crashed',
    { summary: 'dispatcher restarted during verification' },
  );
  const recoveredRun = getRun(run.id);
  const verification = JSON.parse(recoveredRun.verification_result);
  assert.equal(verification.status, 'interrupted');
  assert.equal(verification.passed, false);
  assert.equal(evidence.payload.version, 3);
  assert.equal(evidence.payload.postcondition.verification_status, 'interrupted');
  assert.equal(evidence.payload.postcondition.verification_passed, false);
  assert.equal(verifyEvidenceRecord(evidence).valid, true);

  const originallyUnverified = createJob(jobSpec('verification-recovery-no-fabrication', {
    verify_shell: null,
  }));
  const unverifiedRun = createRun(originallyUnverified.id);
  const laterVerified = updateJob(originallyUnverified.id, {
    verify_shell: 'test -f /tmp/later-verification',
    verify_timeout_s: 5,
    verify_on_failure: 'error',
  });
  finishRun(unverifiedRun.id, 'crashed', { summary: 'crashed before any verification contract existed' });
  const unverifiedEvidence = persistTerminalEvidence(
    laterVerified,
    unverifiedRun.id,
    'crashed',
    { summary: 'crashed before any verification contract existed' },
  );
  assert.equal(getRun(unverifiedRun.id).verification_result, null);
  assert.equal(unverifiedEvidence.payload.postcondition.verification_status, null);

  const noEvidenceJob = createJob(jobSpec('verification-recovery-without-evidence', {
    evidence: null,
    evidence_ref: null,
    verify_shell: 'test -f /tmp/no-evidence-verification',
    verify_timeout_s: 9,
    verify_on_failure: 'warn',
  }));
  const noEvidenceRun = createRun(noEvidenceJob.id);
  finishRun(noEvidenceRun.id, 'crashed', { summary: 'verification interrupted without evidence' });
  assert.equal(
    persistTerminalEvidence(
      noEvidenceJob,
      noEvidenceRun.id,
      'crashed',
      { summary: 'verification interrupted without evidence' },
    ),
    null,
  );
  const noEvidenceVerification = JSON.parse(getRun(noEvidenceRun.id).verification_result);
  assert.equal(noEvidenceVerification.status, 'interrupted');
  assert.equal(noEvidenceVerification.on_failure, 'warn');
});

test('cancellation-winning finalization persists evidence before suppressing side effects', async () => {
  const job = createJob(jobSpec('cancelled-finalization', {
    evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'], collect: ['result'] }),
  }));
  const run = createRun(job.id);
  requestRunCancellation(run.id, { requestedBy: 'test', reason: 'operator cancelled' });
  let deliveries = 0;
  let children = 0;
  await finalizeDispatch(job, {
    run,
    idemKey: null,
    dispatchRecord: null,
    v02Outcomes: {},
  }, {
    status: 'ok',
    summary: 'late success',
    content: 'late success',
    errorMessage: null,
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: false,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: true,
    skipAgentCleanup: true,
    idemAction: 'noop',
    retryFiresChildren: false,
    earlyReturn: false,
  }, {
    finishRun,
    transitionRunTerminal,
    completeRunFenced,
    commitCompletionBookkeeping,
    shouldRunPostCompletionEffects,
    generateEvidence,
    persistV02Outcomes,
    updateIdempotencyResultHash: () => {},
    releaseIdempotencyKey: () => {},
    setAgentStatus: () => {},
    handleDelivery: () => { deliveries += 1; },
    shouldRetry: () => false,
    scheduleRetry: () => null,
    getDb,
    updateJobAfterRun: () => {},
    updateJob,
    setDispatchStatus: () => null,
    handleTriggeredChildren: () => { children += 1; },
    dequeueJob: () => false,
    log: () => {},
    clearMaterializedEnvironment,
  });
  assert.equal(getRun(run.id).status, 'cancelled');
  assert.equal(getEvidenceRecord(run.id).payload.run.status, 'cancelled');
  assert.equal(deliveries, 0);
  assert.equal(children, 0);
});

test('lifecycle-aborted verification preserves recovery ownership through cleanup failure', async () => {
  const job = createJob(jobSpec('verification-lifecycle-preserve', {
    verify_shell: 'test -f /tmp/verification-never-runs',
    verify_timeout_s: 30,
    verify_on_failure: 'error',
  }));
  const run = createRun(job.id);
  const ctx = {
    run,
    idemKey: null,
    dispatchRecord: null,
    v02Outcomes: {},
    abortKind: 'lease_lost',
    abortSignal: new AbortController().signal,
    dispatcherFence: { ownerId: 'lost-owner', fencingToken: 1 },
    credentialCleanupTracked: true,
    materializationCleanup: {
      provider: {
        cleanup: async () => { throw new Error('cleanup unavailable after ownership loss'); },
      },
      cleanupState: {},
    },
  };
  const effects = { delivery: 0, children: 0, job: 0, dispatch: 0, cleanupState: 0 };
  await finalizeDispatch(job, ctx, {
    status: 'ok',
    summary: 'primary succeeded',
    content: 'primary succeeded',
    errorMessage: null,
    runFinishFields: {},
    skipChildren: false,
    skipDelivery: false,
    idemAction: 'keep',
    earlyReturn: false,
  }, {
    runShellCommand: async () => ({
      stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM',
      error: new Error('lease lost'), timedOut: false, aborted: true,
    }),
    isRunCancellationRequested: () => false,
    materializationCleanupRetryDelaysMs: [0],
    clearMaterializedEnvironment,
    recordRunCredentialCleanupState: () => { effects.cleanupState += 1; return false; },
    handleDelivery: () => { effects.delivery += 1; },
    handleTriggeredChildren: () => { effects.children += 1; },
    updateJobAfterRun: () => { effects.job += 1; },
    setDispatchStatus: () => { effects.dispatch += 1; },
    log: () => {},
  });
  assert.equal(ctx.preserveForRecovery, true);
  assert.equal(ctx.materializationCleanupResult.cleaned, false);
  assert.equal(getRun(run.id).status, 'running');
  assert.deepEqual(effects, { delivery: 0, children: 0, job: 0, dispatch: 0, cleanupState: 1 });
});

test('successful verification terminalization preserves credential cleanup audit state', async () => {
  const job = createJob(jobSpec('verification-cleanup-merge', {
    evidence: null,
    evidence_ref: null,
    verify_shell: 'true',
    verify_timeout_s: 5,
    verify_on_failure: 'error',
  }));
  const run = createRun(job.id);
  getDb().prepare('UPDATE runs SET context_summary = ? WHERE id = ?').run(
    JSON.stringify({ credential_cleanup: { status: 'cleaned', attempts: 1 } }),
    run.id,
  );
  await finalizeDispatch(job, {
    run,
    idemKey: null,
    dispatchRecord: null,
    v02Outcomes: null,
  }, {
    status: 'ok',
    summary: 'primary succeeded',
    content: 'primary succeeded',
    errorMessage: null,
    runFinishFields: { context_summary: { shell_result: { status: 'ok' } } },
    skipChildren: false,
    skipDelivery: true,
    skipDequeue: true,
    skipAgentCleanup: true,
    idemAction: 'noop',
    earlyReturn: false,
  }, {
    runShellCommand: async () => ({
      stdout: '', stderr: '', exitCode: 0, signal: null,
      error: null, timedOut: false, aborted: false,
    }),
    isRunCancellationRequested: () => false,
    finishRun,
    updateIdempotencyResultHash: () => {},
    releaseIdempotencyKey: () => {},
    setAgentStatus: () => {},
    handleDelivery: () => {},
    shouldRetry: () => false,
    scheduleRetry: () => null,
    getDb,
    updateJobAfterRun: () => {},
    setDispatchStatus: () => {},
    handleTriggeredChildren: () => {},
    dequeueJob: () => false,
    log: () => {},
    clearMaterializedEnvironment,
  });
  const completed = getRun(run.id);
  assert.equal(completed.status, 'ok');
  const context = JSON.parse(completed.context_summary);
  assert.equal(context.credential_cleanup.status, 'cleaned');
  assert.equal(context.credential_cleanup.attempts, 1);
  assert.equal(context.shell_result.status, 'ok');
  assert.equal(JSON.parse(completed.verification_result).status, 'passed');
});

test('maintenance timeout persists evidence atomically with the terminal transition', async () => {
  const job = createJob(jobSpec('maintenance-timeout-evidence'));
  const run = createRun(job.id, { run_timeout_ms: 1 });
  await checkRunHealth({
    log: () => {},
    getDb,
    getRunningRuns: () => [run],
    getStaleRuns: () => [],
    getTimedOutRuns: () => [{ ...run, job_name: job.name, run_timeout_ms: 1 }],
    getJob,
    updateJobAfterRun: () => {},
    handleDelivery: () => null,
    dequeueJob: () => false,
    shouldRetry: () => false,
    scheduleRetry: () => null,
    staleThresholdSeconds: 90,
  });
  assert.equal(getRun(run.id).status, 'timeout');
  assert.equal(getEvidenceRecord(run.id).payload.run.status, 'timeout');
});

test('maintenance quarantines corrupt evidence state without timeout side effects', async () => {
  const job = createJob(jobSpec('maintenance-corrupt-evidence'));
  const dispatch = enqueueDispatch(job.id, {
    kind: 'manual',
    scheduled_for: '2000-01-01 00:00:00',
  });
  const run = createRun(job.id, {
    run_timeout_ms: 1,
    dispatch_queue_id: dispatch.id,
  });
  getDb().prepare(`
    UPDATE runs
    SET evidence_execution_snapshot = '{invalid-json',
        started_at = datetime('now', '-10 seconds')
    WHERE id = ?
  `).run(run.id);
  let deliveries = 0;
  let retries = 0;
  let updates = 0;
  let dequeues = 0;
  await checkRunHealth({
    log: () => {},
    getDb,
    getRunningRuns: () => [getRun(run.id)],
    getStaleRuns: () => [],
    getTimedOutRuns: () => [{ ...getRun(run.id), job_name: job.name, run_timeout_ms: 1 }],
    getJob,
    updateJobAfterRun: () => { updates += 1; },
    handleDelivery: () => { deliveries += 1; },
    dequeueJob: () => { dequeues += 1; return true; },
    shouldRetry: () => { retries += 1; return true; },
    scheduleRetry: () => { throw new Error('must not schedule'); },
    staleThresholdSeconds: 90,
  });

  const quarantined = getRun(run.id);
  assert.equal(quarantined.status, 'recovery_blocked');
  assert.match(quarantined.error_message, /evidence execution snapshot is invalid json/i);
  assert.equal(getJob(job.id).enabled, 0);
  assert.equal(getJob(job.id).last_status, 'recovery_blocked');
  assert.equal(getDispatch(dispatch.id).status, 'failed');
  assert.equal(getEvidenceRecord(run.id), null);
  assert.equal(deliveries, 0);
  assert.equal(retries, 0);
  assert.equal(updates, 0);
  assert.equal(dequeues, 0);
  const diagnostics = doctor();
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.diagnostics.recovery_blocked_runs > 0, true);
  assert.equal(diagnostics.diagnostics.evidence_records.missing > 0, true);
});

test('legacy invalid evidence retention quarantines maintenance recovery', async () => {
  const job = createJob(jobSpec('maintenance-legacy-invalid-retention'));
  const run = createRun(job.id, { run_timeout_ms: 1 });
  getDb().prepare(`
    UPDATE runs
    SET evidence_declaration_snapshot = ?,
        started_at = datetime('now', '-10 seconds')
    WHERE id = ?
  `).run(JSON.stringify({ provider: 'sha256', methods: ['sha256'], retention: '101y' }), run.id);
  await checkRunHealth({
    log: () => {},
    getDb,
    getRunningRuns: () => [getRun(run.id)],
    getStaleRuns: () => [],
    getTimedOutRuns: () => [{ ...getRun(run.id), job_name: job.name, run_timeout_ms: 1 }],
    getJob,
    updateJobAfterRun: () => { throw new Error('must not update'); },
    handleDelivery: () => { throw new Error('must not deliver'); },
    dequeueJob: () => { throw new Error('must not dequeue'); },
    shouldRetry: () => { throw new Error('must not retry'); },
    scheduleRetry: () => { throw new Error('must not schedule'); },
    staleThresholdSeconds: 90,
  });
  assert.equal(getRun(run.id).status, 'recovery_blocked');
  assert.match(getRun(run.id).error_message, /retention must not exceed 100 years/i);
  assert.equal(getJob(job.id).enabled, 0);
  assert.equal(getEvidenceRecord(run.id), null);
});

test('shell evidence hashes complete raw output before marker removal and storage truncation', async () => {
  const rawStdout = `${'raw-output-'.repeat(200)}\n[IMAGE:/tmp/evidence-image.png]\n`;
  const rawStderr = 'complete diagnostic stream';
  const job = createJob(jobSpec('raw-shell-output', {
    output_store_limit_bytes: 128,
    output_excerpt_limit_bytes: 128,
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      collect: ['stdout', 'stderr', 'exit_code'],
    }),
  }));
  const run = createRun(job.id);
  const ctx = { run, executionEnv: null, v02Outcomes: {}, idemKey: null, dispatchRecord: null };
  const result = await executeShell(job, ctx, {
    runShellCommand: async () => ({
      stdout: rawStdout,
      stderr: rawStderr,
      exitCode: 0,
      signal: null,
      timedOut: false,
    }),
    normalizeShellResult,
    log: () => {},
  });
  await finalizeDispatch(job, ctx, result, {
    finishRun,
    transitionRunTerminal,
    completeRunFenced,
    commitCompletionBookkeeping,
    shouldRunPostCompletionEffects,
    generateEvidence,
    persistV02Outcomes,
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
    clearMaterializedEnvironment,
  });
  const evidence = getEvidenceRecord(run.id);
  assert.equal(
    evidence.payload.result.stdout_sha256,
    `sha256:${createHash('sha256').update(rawStdout).digest('hex')}`,
  );
  assert.equal(
    evidence.payload.result.stderr_sha256,
    `sha256:${createHash('sha256').update(rawStderr).digest('hex')}`,
  );
  assert.equal(evidence.payload.result.stdout_bytes, Buffer.byteLength(rawStdout));
  assert.equal(evidence.payload.result.stderr_bytes, Buffer.byteLength(rawStderr));
  assert.equal(getRun(run.id).shell_stdout.includes('[IMAGE:'), false);
  assert(Buffer.byteLength(getRun(run.id).shell_stdout) < Buffer.byteLength(rawStdout));
});
