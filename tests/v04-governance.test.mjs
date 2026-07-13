import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApproval, getApproval, resolveApproval } from '../approval.js';
import { getAuthenticatedApprovalActor } from '../approval-binding.js';
import { initDb, closeDb, getDb, setDbPath } from '../db.js';
import { applyStructuredOutputContract } from '../dispatcher-strategies.js';
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

test('schema v28 persists handoff v3 fields', () => {
  assert.equal(SCHEDULER_SCHEMA_VERSION, 28);
  const job = createJob(jobSpec('v04-fields', {
    approval_required: true,
    approval_risk_level: 'high',
    approval_approver_scope: `user:${getAuthenticatedApprovalActor().username}`,
    output_format: 'json',
  }));
  assert.equal(job.approval_risk_level, 'high');
  assert.equal(job.approval_approver_scope, `user:${getAuthenticatedApprovalActor().username}`);
  assert.equal(job.output_format, 'json');
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

test('structured output validation persists normalized JSON and fails malformed output', () => {
  const valid = applyStructuredOutputContract(
    { output_format: 'json' },
    { status: 'ok', content: '{"b":2,"a":1}', runFinishFields: {} },
  );
  assert.equal(valid.status, 'ok');
  assert.equal(valid.runFinishFields.structured_output_valid, 1);
  assert.deepEqual(JSON.parse(valid.runFinishFields.structured_output), { b: 2, a: 1 });

  const invalid = applyStructuredOutputContract(
    { output_format: 'ndjson' },
    { status: 'ok', content: '{"ok":true}\nnot-json', runFinishFields: {} },
  );
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.runFinishFields.structured_output_valid, 0);
  assert.match(invalid.errorMessage, /line 2/);
});

test('capabilities advertise authoritative handoff v3 enforcement', () => {
  const output = execFileSync(process.execPath, ['cli.js', 'capabilities', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const capabilities = JSON.parse(output);
  assert.equal(capabilities.handoff_version, '3');
  assert.equal(capabilities.schema_version, 28);
  assert.equal(capabilities.features.root_approval_gate, true);
  assert.equal(capabilities.features.approval_scope_enforcement, true);
  assert.equal(capabilities.features.structured_output_format, true);
  assert.equal(capabilities.features.delegation_validation, true);
  assert.equal(capabilities.features.authorization_ref_resolution, true);
  assert.equal(capabilities.features.evidence_generation, false);
  assert.equal(capabilities.features.checksum_evidence_generation, true);
  assert.equal(capabilities.features.evidence_integrity, 'checksum-sha256-v2');
  assert.equal(capabilities.features.evidence_contract, 'openclaw-scheduler-checksum-v2');
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
