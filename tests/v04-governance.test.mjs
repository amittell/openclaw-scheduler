import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApproval, getApproval, resolveApproval } from '../approval.js';
import { getAuthenticatedApprovalActor } from '../approval-binding.js';
import { initDb, closeDb, getDb, setDbPath } from '../db.js';
import {
  applyStructuredOutputContract,
  applyVerificationContract,
} from '../dispatcher-strategies.js';
import { runShellCommand } from '../dispatcher-shell.js';
import { storeRunArtifact } from '../shell-result.js';
import { createJob, deleteJob, updateJob, validateJobSpec } from '../jobs.js';
import { createRun, finishRun, getEvidenceRecord, persistV02Outcomes } from '../runs.js';
import { SCHEDULER_SCHEMA_VERSION } from '../scheduler-schema.js';
import {
  _resetForTesting as resetProviderRegistry,
  loadProviders,
  resolveAuthorizationRef,
} from '../provider-registry.js';
import {
  evaluateAuthorization,
  generateEvidence,
  validateDelegation,
  verifyEvidenceRecord,
} from '../v02-runtime.js';

function jobSpec(name, extra = {}) {
  return {
    name,
    schedule_cron: '0 0 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf ok',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    origin: 'system',
    ...extra,
  };
}

before(async () => {
  setDbPath(':memory:');
  await initDb();
});

after(() => closeDb());

test('schema v30 preserves handoff v3 fields', () => {
  assert.equal(SCHEDULER_SCHEMA_VERSION, 30);
  const job = createJob(jobSpec('v04-fields', {
    approval_required: true,
    approval_risk_level: 'high',
    approval_approver_scope: `user:${getAuthenticatedApprovalActor().username}`,
    output_format: 'json',
    verify_shell: 'test -n "$PATH"',
    verify_timeout_s: 7,
    verify_on_failure: 'warn',
  }));
  assert.equal(job.approval_risk_level, 'high');
  assert.equal(job.approval_approver_scope, `user:${getAuthenticatedApprovalActor().username}`);
  assert.equal(job.output_format, 'json');
  assert.equal(job.verify_shell, 'test -n "$PATH"');
  assert.equal(job.verify_timeout_s, 7);
  assert.equal(job.verify_on_failure, 'warn');
  const updated = updateJob(job.id, {
    verify_shell: null,
    verify_timeout_s: null,
    verify_on_failure: null,
  });
  assert.equal(updated.verify_shell, null);
  assert.equal(updated.verify_timeout_s, null);
  assert.equal(updated.verify_on_failure, null);
  assert.throws(
    () => validateJobSpec(jobSpec('bad-risk', { approval_risk_level: 'critical' })),
    /approval_risk_level/,
  );
  assert.throws(
    () => validateJobSpec(jobSpec('bad-output', { output_format: 'yaml' })),
    /output_format/,
  );
  assert.throws(
    () => validateJobSpec(jobSpec('unscoped-gate', { approval_approver_scope: 'user:alex' })),
    /requires approval_required/,
  );
  assert.throws(
    () => validateJobSpec(jobSpec('domain-scope', {
      approval_required: true,
      approval_approver_scope: 'domain:example.com',
    })),
    /authenticatable local OS account/,
  );
  assert.doesNotThrow(() => validateJobSpec(jobSpec('bare-local-principal', {
    approval_required: true,
    approval_approver_scope: `local-user:${getAuthenticatedApprovalActor().uid}`,
  })));
  assert.throws(
    () => validateJobSpec(jobSpec('watchdog-verify', {
      job_type: 'watchdog',
      watchdog_target_label: 'target',
      watchdog_check_cmd: 'true',
      verify_shell: 'true',
    })),
    /verify_shell is not supported for watchdog jobs/,
  );
});

test('approval scope and execution binding fail closed', () => {
  const deniedScope = createJob(jobSpec('v04-denied-scope-approval', {
    approval_required: true,
    approval_risk_level: 'high',
    approval_approver_scope: 'user:not-the-current-test-user',
  }));
  const deniedApproval = createApproval(deniedScope.id, null);
  assert.throws(
    () => resolveApproval(deniedApproval.id, 'approved', 'user:not-the-current-test-user'),
    error => error.code === 'APPROVER_SCOPE_MISMATCH',
  );
  assert.equal(getApproval(deniedApproval.id).status, 'pending');

  const actor = getAuthenticatedApprovalActor();
  const scoped = createJob(jobSpec('v04-scoped-approval', {
    approval_required: true,
    approval_risk_level: 'high',
    approval_approver_scope: actor.uid == null ? `user:${actor.username}` : `uid:${actor.uid}`,
  }));
  const approval = createApproval(scoped.id, null);
  assert.equal(approval.risk_level, 'high');
  assert.equal(approval.approver_scope, actor.uid == null ? `user:${actor.username}` : `uid:${actor.uid}`);
  assert.match(approval.binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(resolveApproval(approval.id, 'approved', 'forged-caller-value').status, 'approved');
  assert.equal(getApproval(approval.id).resolved_by, actor.canonical);

  const mutable = createJob(jobSpec('v04-binding-change', { approval_required: true }));
  const staleApproval = createApproval(mutable.id, null);
  updateJob(mutable.id, { payload_message: 'printf changed' });
  const cancelled = resolveApproval(staleApproval.id, 'approved', 'operator');
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.cancelled_reason, /execution contract changed/);
});

test('authorization references resolve through a configured resolver and otherwise deny', async () => {
  const job = { id: 'auth-ref-job', authorization_ref: 'opa:payments/write' };
  const denied = await evaluateAuthorization(job, null, null, {});
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.source, 'reference-error');

  const permitted = await evaluateAuthorization(job, null, null, {
    resolveAuthorizationRef: async ref => ({
      policy: { ref, decision: 'permit', reason: 'resolved policy permits' },
    }),
  });
  assert.equal(permitted.decision, 'permit');
  assert.equal(permitted.source, 'reference');
  assert.equal(permitted.ref, 'opa:payments/write');
});

test('resolver-only authorization providers return structural policies without an implicit authorize call', async () => {
  const providerDir = mkdtempSync(join(tmpdir(), 'scheduler-resolver-only-'));
  try {
    writeFileSync(join(providerDir, 'resolver-only.js'), `
export default {
  name: 'resolver-only',
  type: 'authorization',
  async resolvePolicy(ref) {
    return { decision: 'permit', reason: 'resolved structural policy', policy_ref: ref };
  }
};
`);
    resetProviderRegistry();
    await loadProviders(providerDir);
    const resolved = await resolveAuthorizationRef('resolver-only:payments/write');
    assert.equal(resolved.provider, 'resolver-only');
    assert.equal(Object.hasOwn(resolved.policy, 'provider'), false);
    const decision = await evaluateAuthorization(
      { id: 'resolver-only-job', authorization_ref: 'resolver-only:payments/write' },
      null,
      null,
      { resolveAuthorizationRef },
    );
    assert.equal(decision.decision, 'permit');
    assert.equal(decision.source, 'reference');
  } finally {
    resetProviderRegistry();
    rmSync(providerDir, { recursive: true, force: true });
  }
});

test('delegation validation enforces grants, cycles, and provider denial', () => {
  const job = {
    identity_delegation_mode: 'on-behalf-of',
    identity: JSON.stringify({
      subject: { delegation_mode: 'on-behalf-of' },
      auth: { delegation_policy: { max_depth: 3, require_grant_per_hop: true } },
    }),
  };
  const valid = validateDelegation(job, {
    delegation_mode: 'on-behalf-of',
    session: { delegation_chain: [{ principal: 'root', grant: 'grant-1', validated: true }] },
  });
  assert.equal(valid.valid, true);

  const invalid = validateDelegation(job, {
    delegation_mode: 'on-behalf-of',
    session: {
      delegation_chain: [
        { principal: 'root', grant: 'grant-1', validated: true },
        { principal: 'root', grant: 'grant-1', validated: true },
      ],
      delegation_validation: { valid: false, errors: ['issuer rejected chain'] },
    },
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.acyclic, null);
  assert(invalid.errors.some(error => error.includes('issuer rejected chain')));
});

test('evidence is content-addressed, persisted, and tamper-evident', () => {
  const job = createJob(jobSpec('v04-evidence', {
    evidence_ref: 'audit:daily',
    evidence: JSON.stringify({ collect: ['result'], retention: '30d', format: 'json' }),
  }));
  const run = createRun(job.id, { run_timeout_ms: job.run_timeout_ms });
  finishRun(run.id, 'ok', { summary: 'checksum evidence fixture' });
  const evidence = generateEvidence(
    job,
    { id: run.id, status: 'ok', output: '{"ok":true}' },
    { authorization_decision: { decision: 'permit', reason: 'test' } },
  );
  assert.equal(evidence.integrity, 'sha256');
  assert.equal(verifyEvidenceRecord(evidence).valid, true);
  persistV02Outcomes(run.id, { evidence_record: evidence });
  const stored = getEvidenceRecord(run.id);
  assert.equal(stored.integrity.valid, true);
  assert.equal(stored.hash, evidence.hash);
  assert.equal(stored.retention_policy, '30d');
  assert.match(stored.retention_until, /^\d{4}-\d{2}-\d{2}T/);

  const otherJob = createJob(jobSpec('v04-evidence-transplant-target'));
  const otherRun = createRun(otherJob.id, { run_timeout_ms: otherJob.run_timeout_ms });
  assert.throws(
    () => persistV02Outcomes(otherRun.id, { evidence_record: evidence }),
    error => error.code === 'EVIDENCE_RUN_BINDING_MISMATCH',
  );

  const tampered = structuredClone(evidence);
  tampered.payload.run.status = 'error';
  assert.equal(verifyEvidenceRecord(tampered).valid, false);

  const replacement = generateEvidence(
    job,
    { id: run.id, status: 'ok', output: '{"ok":false}' },
    { authorization_decision: { decision: 'permit', reason: 'test' } },
  );
  assert.throws(
    () => persistV02Outcomes(run.id, { evidence_record: replacement }),
    error => error.code === 'EVIDENCE_RECORD_IMMUTABLE',
  );

  deleteJob(job.id);
  const retained = getEvidenceRecord(run.id);
  assert.equal(retained.integrity.valid, true);
  assert.equal(retained.job_id, job.id);
});

test('structured output validation persists normalized JSON and warns on malformed output', () => {
  const valid = applyStructuredOutputContract(
    { output_format: 'json' },
    { status: 'ok', content: '{"b":2,"a":1}', runFinishFields: {} },
  );
  assert.equal(valid.status, 'ok');
  assert.equal(valid.runFinishFields.structured_output_valid, 1);
  assert.deepEqual(JSON.parse(valid.runFinishFields.structured_output), { b: 2, a: 1 });
  assert.equal(valid.runFinishFields.structured_output_bytes, 13);
  assert.match(valid.runFinishFields.structured_output_sha256, /^sha256:[a-f0-9]{64}$/);

  const invalid = applyStructuredOutputContract(
    { output_format: 'ndjson' },
    { status: 'ok', content: '{"ok":true}\nnot-json', runFinishFields: {} },
  );
  assert.equal(invalid.status, 'ok');
  assert.equal(invalid.runFinishFields.structured_output_valid, 0);
  assert.match(invalid.runFinishFields.structured_output_warning, /line 2/);

  const secret = 'SECRET_TOKEN_123';
  const secretInvalid = applyStructuredOutputContract(
    { output_format: 'json' },
    { status: 'ok', content: `${secret} not-json`, runFinishFields: {} },
  );
  assert.equal(secretInvalid.runFinishFields.structured_output_valid, 0);
  assert.doesNotMatch(secretInvalid.runFinishFields.structured_output_warning, new RegExp(secret));

  for (const format of ['json', 'ndjson']) {
    const empty = applyStructuredOutputContract(
      { output_format: format },
      { status: 'ok', content: '', runFinishFields: {} },
    );
    assert.equal(empty.status, 'ok');
    assert.equal(empty.runFinishFields.structured_output_valid, 1);
    assert.equal(empty.runFinishFields.structured_output, null);
    assert.equal(empty.runFinishFields.structured_output_warning, null);
  }
  const emptyText = applyStructuredOutputContract(
    { output_format: 'text' },
    { status: 'ok', content: '', runFinishFields: {} },
  );
  assert.equal(emptyText.runFinishFields.structured_output_valid, 1);
  assert.equal(emptyText.runFinishFields.structured_output, '');
});

test('post-success verification supports pass, warn, error, timeout, and cancellation outcomes', async () => {
  const ctx = {
    run: { id: 'verification-contract-run' },
    executionEnv: { PATH: process.env.PATH, VERIFY_MARKER: 'ready' },
    abortSignal: new AbortController().signal,
    dispatcherFence: null,
  };
  const baseResult = {
    status: 'ok',
    summary: 'execution succeeded',
    content: 'execution succeeded',
    errorMessage: null,
    runFinishFields: {},
    skipChildren: false,
    skipDelivery: false,
    idemAction: 'keep',
  };
  const deps = { runShellCommand, isRunCancellationRequested: () => false };

  const passed = await applyVerificationContract({
    verify_shell: 'test "$VERIFY_MARKER" = ready',
    verify_timeout_s: 2,
    verify_on_failure: 'error',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, deps);
  assert.equal(passed.status, 'ok');
  assert.equal(passed.runFinishFields.verification_result.status, 'passed');
  assert.equal(passed.runFinishFields.verification_result.passed, true);

  const warned = await applyVerificationContract({
    verify_shell: 'exit 7',
    verify_timeout_s: 2,
    verify_on_failure: 'warn',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, deps);
  assert.equal(warned.status, 'ok');
  assert.equal(warned.runFinishFields.verification_result.status, 'failed');
  assert.match(warned.runFinishFields.context_summary.verification_warning, /exit code 7/);

  const failed = await applyVerificationContract({
    verify_shell: 'exit 9',
    verify_timeout_s: 2,
    verify_on_failure: 'error',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, deps);
  assert.equal(failed.status, 'error');
  assert.equal(failed.skipChildren, true);
  assert.match(failed.errorMessage, /exit code 9/);

  const timedOut = await applyVerificationContract({
    verify_shell: 'slow-check',
    verify_timeout_s: 1,
    verify_on_failure: 'error',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, {
    runShellCommand: async () => ({
      stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', error: new Error('timeout'),
      timedOut: true, aborted: false,
    }),
  });
  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.runFinishFields.verification_result.status, 'timed_out');

  const cancelled = await applyVerificationContract({
    verify_shell: 'cancelled-check',
    verify_timeout_s: 1,
    verify_on_failure: 'warn',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, {
    isRunCancellationRequested: () => true,
    runShellCommand: async () => ({
      stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM', error: new Error('cancelled'),
      timedOut: false, aborted: true,
    }),
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.skipDelivery, true);
  assert.equal(cancelled.runFinishFields.verification_result.status, 'cancelled');

  const interrupted = await applyVerificationContract({
    verify_shell: 'interrupted-check',
    verify_timeout_s: 1,
    verify_on_failure: 'error',
    shell_env_policy: 'minimal',
  }, { ...ctx, abortKind: 'shutdown' }, baseResult, {
    isRunCancellationRequested: () => false,
    runShellCommand: async () => ({
      stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM', error: new Error('shutdown'),
      timedOut: false, aborted: true,
    }),
  });
  assert.equal(interrupted.preserveForRecovery, true);
  assert.equal(interrupted.runFinishFields.verification_result.status, 'interrupted');

  let observedMaxBuffer = null;
  const largeVerifier = await applyVerificationContract({
    verify_shell: 'large-output-check',
    verify_timeout_s: 1,
    verify_on_failure: 'error',
    shell_env_policy: 'minimal',
  }, ctx, baseResult, {
    isRunCancellationRequested: () => false,
    runShellCommand: async (_command, _timeout, _env, options) => {
      observedMaxBuffer = options.maxBuffer;
      return { stdout: 'x'.repeat(70_000), stderr: '', exitCode: 0, timedOut: false, aborted: false };
    },
  });
  assert.equal(largeVerifier.status, 'ok');
  assert.equal(observedMaxBuffer, 1024 * 1024);
});

test('large structured output stores a retrievable reference instead of a full DB value', () => {
  const artifacts = [];
  const raw = JSON.stringify({ payload: 'x'.repeat(1024) });
  const result = applyStructuredOutputContract(
    { output_format: 'json', output_store_limit_bytes: 128 },
    { status: 'ok', content: raw, runFinishFields: {} },
    {
      runId: 'large-structured-run',
      storeRunArtifact(kind, runId, value) {
        artifacts.push({ kind, runId, value });
        return '/safe/artifacts/structured-output.txt';
      },
    },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.runFinishFields.structured_output_valid, 1);
  assert.equal(result.runFinishFields.structured_output, null);
  assert.equal(result.runFinishFields.structured_output_path, '/safe/artifacts/structured-output.txt');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].value, raw);
});

test('structured output offload failures are fatal storage errors, not parse failures', () => {
  const raw = JSON.stringify({ payload: 'x'.repeat(1024) });
  const result = applyStructuredOutputContract(
    { output_format: 'json', output_store_limit_bytes: 128 },
    { status: 'ok', content: raw, runFinishFields: { shell_stdout_path: '/marker-stripped.txt' } },
    {
      runId: 'failed-structured-offload',
      storeRunArtifact() {
        throw new Error('disk contains sensitive path detail');
      },
    },
  );
  assert.equal(result.status, 'error');
  assert.equal(result.runFinishFields.structured_output_valid, 1);
  assert.equal(result.runFinishFields.structured_output, null);
  assert.equal(result.runFinishFields.structured_output_path, null);
  assert.equal(result.runFinishFields.structured_output_warning, 'Structured output artifact storage failed');
  assert.doesNotMatch(result.runFinishFields.structured_output_warning, /sensitive/);
});

test('large whitespace text output remains offloadable with digest parity', () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'scheduler-whitespace-artifact-'));
  try {
    const raw = ' '.repeat(512);
    const result = applyStructuredOutputContract(
      { output_format: 'text', output_store_limit_bytes: 128 },
      { status: 'ok', content: raw, runFinishFields: {} },
      {
        runId: 'whitespace-structured-output',
        storeRunArtifact: (kind, runId, value) => storeRunArtifact(
          kind,
          runId,
          value,
          artifactsDir,
        ),
      },
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.runFinishFields.structured_output, null);
    assert.equal(readFileSync(result.runFinishFields.structured_output_path, 'utf8'), raw);
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
    assert.equal(result.runFinishFields.structured_output_sha256, `sha256:${digest}`);
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('capabilities advertise authoritative handoff v4 enforcement', () => {
  const output = execFileSync(process.execPath, ['cli.js', 'capabilities', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const capabilities = JSON.parse(output);
  assert.equal(capabilities.handoff_version, '4');
  assert.equal(capabilities.schema_version, 30);
  assert.deepEqual(capabilities.handoff_contract, {
    artifact_schema: 'openclaw.scheduler.handoff-artifact',
    artifact_schema_version: 1,
    canonicalization: 'json-sort-v1',
    canonicalization_version: 1,
    digest: 'sha256',
    undefined: 'null',
    execution_binding_version: 2,
    scheduler_job_binding_version: 1,
  });
  assert.equal(capabilities.features.root_approval_gate, true);
  assert.equal(capabilities.features.approval_scope_enforcement, false);
  assert.equal(capabilities.features.structured_output_format, true);
  assert.equal(capabilities.features.delegation_validation, true);
  assert.equal(capabilities.features.authorization_ref_resolution, true);
  assert.equal(capabilities.features.evidence_generation, true);
  assert.equal(capabilities.features.checksum_evidence_generation, true);
  assert.equal(capabilities.features.evidence_integrity, 'artifact-bound-signed-or-provider-verified-v4');
  assert.equal(capabilities.features.evidence_contract, 'agentcli-handoff-v4');
  assert.equal(capabilities.features.handoff_v4_artifact, true);
  assert.equal(capabilities.features.artifact_bound_proofs, true);
  assert.equal(capabilities.features.signed_or_provider_verified_evidence, true);
  assert.equal(capabilities.features.provider_session_cache, true);
  assert.equal(capabilities.features.credential_presentation, true);
  assert.equal(capabilities.features.source_run_bound_delegation, true);
  assert.equal(capabilities.features.immutable_runtime_events, true);
  assert.equal(capabilities.features.gateway_capability_discovery, true);
  assert.equal(capabilities.features.gateway_env_injection_negotiation, true);
  assert.equal(capabilities.features.multipart_delivery_checkpoints, true);
  assert.equal(capabilities.features.completion_delivery_scope, 'run');
});

test('evidence table is included in database integrity surface', () => {
  const table = getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evidence_records'",
  ).get();
  assert.equal(table.name, 'evidence_records');
});
