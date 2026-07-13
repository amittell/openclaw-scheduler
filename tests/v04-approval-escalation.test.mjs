import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  beginApprovalDispatch,
  countPendingApprovalsForJob,
  createApproval,
  getApprovalForDispatch,
  getPendingApproval,
  markApprovalDispatched,
  resolveApproval,
} from '../approval.js';
import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { getAuthenticatedApprovalActor } from '../approval-binding.js';
import {
  claimDispatch,
  enqueueDispatch,
  getDispatch,
  releaseDispatch,
  setDispatchStatus,
} from '../dispatch-queue.js';
import { prepareDispatch } from '../dispatcher-strategies.js';
import { adaptiveDeferralMs, sqliteNow } from '../dispatcher-utils.js';
import { buildShellEnvironment, evaluateGovernance, summarizeGovernance } from '../governance.js';
import {
  claimIdempotencyKey,
  generateChainIdempotencyKey,
  generateIdempotencyKey,
  releaseIdempotencyKey,
} from '../idempotency.js';
import {
  createJob,
  getDispatchBacklogCount,
  getJob,
  hasRunningRun,
  hasRunningRunForPool,
  updateJob,
} from '../jobs.js';
import { createRun, finishRun, getEvidenceRecord, getRun, persistV02Outcomes } from '../runs.js';
import {
  compareTrustLevels,
  evaluateAuthorization,
  evaluateTrust,
  generateEvidence,
  resolveIdentity,
  summarizeCredentialHandoff,
  validateDelegation,
  verifyAuthorizationProof,
} from '../v02-runtime.js';

before(async () => {
  setDbPath(':memory:');
  await initDb();
});

after(() => closeDb());

function jobSpec(name, authorization) {
  return {
    name,
    schedule_cron: '0 0 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf governed',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    origin: 'system',
    authorization: JSON.stringify(authorization),
  };
}

function dispatchDeps(provider, idempotencyKey) {
  return {
    claimDispatch,
    releaseDispatch,
    setDispatchStatus,
    countPendingApprovalsForJob,
    getPendingApproval,
    createApproval,
    getApprovalForDispatch,
    beginApprovalDispatch,
    markApprovalDispatched,
    cancelApprovalForDispatch: () => ({ changed: false, approval: null, reason: 'unused' }),
    createRun,
    getRun,
    hasRunningRunForPool,
    hasRunningRun,
    enqueueJob: () => ({ queued: false, queued_count: 0, limited: false }),
    getDispatchBacklogCount,
    generateIdempotencyKey,
    generateChainIdempotencyKey,
    generateRunNowIdempotencyKey: () => idempotencyKey,
    claimIdempotencyKey,
    finishRun,
    getDb,
    sqliteNow,
    adaptiveDeferralMs,
    handleDelivery: () => ({ ok: true }),
    advanceNextRun: () => {},
    updateJobAfterRun: () => {},
    updateJob: () => {},
    TICK_INTERVAL_MS: 100,
    log: () => {},
    resolveIdentity,
    evaluateTrust,
    verifyAuthorizationProof,
    evaluateAuthorization,
    summarizeCredentialHandoff,
    validateDelegation,
    persistV02Outcomes,
    releaseIdempotencyKey,
    handleTriggeredChildren: () => {},
    dequeueJob: () => false,
    compareTrustLevels,
    getIdentityProvider: () => null,
    getAuthorizationProvider: name => name === provider.name ? provider : null,
    getProofVerifier: () => null,
    resolveAuthorizationRef: null,
    evaluateGovernance,
    buildShellEnvironment,
    summarizeGovernance,
    generateEvidence,
  };
}

test('authorization escalation suspends and resumes the exact durable dispatch', async () => {
  const contextHash = `sha256:${'a'.repeat(64)}`;
  const provider = {
    name: 'approval-escalation-provider',
    authorize: async () => ({ decision: 'escalate', reason: 'operator review required', context_hash: contextHash }),
  };
  const job = createJob(jobSpec('authorization-escalation-resume', { provider: provider.name }));
  const dispatch = enqueueDispatch(job.id, { id: 'authorization-escalation-dispatch', kind: 'manual' });
  const deps = dispatchDeps(provider, 'authorization-escalation-idempotency');

  const suspended = await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, deps);
  assert.equal(suspended, null);
  const pending = getApprovalForDispatch(dispatch.id);
  assert.equal(pending.gate_kind, 'authorization');
  assert.equal(pending.status, 'pending');
  assert.equal(getRun(pending.run_id).status, 'awaiting_approval');
  assert.equal(getDispatch(dispatch.id).status, 'awaiting_approval');
  assert.equal(getDb().prepare('SELECT status FROM idempotency_ledger WHERE key = ?').get('authorization-escalation-idempotency'), undefined);

  assert.equal(resolveApproval(pending.id, 'approved', 'forged-value').status, 'approved');
  const resumed = await prepareDispatch(getJob(job.id), { dispatchRecord: getDispatch(dispatch.id) }, deps);
  assert.ok(resumed);
  assert.equal(resumed.v02Outcomes.authorization_decision.decision, 'permit');
  assert.equal(resumed.v02Outcomes.authorization_decision.human_override, true);
  assert.equal(resumed.v02Outcomes.authorization_decision.approval_id, pending.id);
  const approvalUsed = JSON.parse(resumed.run.approval_used);
  assert.equal(approvalUsed.approval_id, pending.id);
  assert.equal(approvalUsed.dispatch_queue_id, dispatch.id);
  assert.equal(approvalUsed.status, 'dispatching');
  assert.equal(approvalUsed.decision_status, 'approved');
  assert.equal(approvalUsed.approver, getApprovalForDispatch(dispatch.id, { activeOnly: false }).resolved_by);
  assert.equal(approvalUsed.resolved_by, getApprovalForDispatch(dispatch.id, { activeOnly: false }).resolved_by);
  assert.equal(approvalUsed.reason, 'Approval granted');
  assert.equal(approvalUsed.risk_level, 'high');
  assert.equal(approvalUsed.approver_scope, null);
  assert.match(approvalUsed.requested_at, /^\d{4}-\d{2}-\d{2}/);
  assert.match(approvalUsed.expires_at, /^\d{4}-\d{2}-\d{2}/);
  assert.match(approvalUsed.resolved_at, /^\d{4}-\d{2}-\d{2}/);
  assert.match(approvalUsed.approved_at, /^\d{4}-\d{2}-\d{2}/);
  assert.match(approvalUsed.binding_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(getApprovalForDispatch(dispatch.id, { activeOnly: false }).status, 'dispatched');
  finishRun(resumed.run.id, 'cancelled', { summary: 'test cleanup' });
  releaseIdempotencyKey(resumed.idemKey);
});

test('changed provider authorization context creates a fresh approval gate', async () => {
  let contextHash = `sha256:${'b'.repeat(64)}`;
  const provider = {
    name: 'approval-context-provider',
    authorize: async () => ({ decision: 'escalate', reason: 'same reason', context_hash: contextHash }),
  };
  const job = createJob(jobSpec('authorization-context-refresh', { provider: provider.name }));
  const dispatch = enqueueDispatch(job.id, { id: 'authorization-context-dispatch', kind: 'manual' });
  const deps = dispatchDeps(provider, 'authorization-context-idempotency');

  assert.equal(await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, deps), null);
  const first = getApprovalForDispatch(dispatch.id);
  resolveApproval(first.id, 'approved', null);
  contextHash = `sha256:${'c'.repeat(64)}`;

  const result = await prepareDispatch(getJob(job.id), { dispatchRecord: getDispatch(dispatch.id) }, deps);
  assert.equal(result, null);
  const replacement = getApprovalForDispatch(dispatch.id);
  assert.notEqual(replacement.id, first.id);
  assert.equal(replacement.gate_kind, 'authorization');
  assert.equal(replacement.status, 'pending');
  assert.equal(getDb().prepare('SELECT status FROM approvals WHERE id = ?').get(first.id).status, 'dispatched');
});

test('post-approval binding mutation cancels durably without deferral loop', async () => {
  const provider = { name: 'binding-mutation-provider', authorize: async () => ({ decision: 'permit' }) };
  const job = createJob({
    ...jobSpec('binding-mutation-cancellation', { provider: provider.name }),
    approval_required: true,
  });
  const dispatch = enqueueDispatch(job.id, { id: 'binding-mutation-dispatch', kind: 'manual' });
  const deps = dispatchDeps(provider, 'binding-mutation-idem');
  assert.equal(await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, deps), null);
  const approval = getApprovalForDispatch(dispatch.id);
  assert.equal(resolveApproval(approval.id, 'approved', null, 'approved before mutation').status, 'approved');
  updateJob(job.id, { payload_message: 'printf changed-after-approval' });

  assert.equal(
    await prepareDispatch(getJob(job.id), { dispatchRecord: getDispatch(dispatch.id) }, deps),
    null,
  );
  const cancelled = getApprovalForDispatch(dispatch.id, { activeOnly: false });
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.cancelled_reason, /execution contract changed/i);
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS count FROM runs WHERE job_id = ? AND approval_used IS NOT NULL").get(job.id).count,
    0,
  );
});

test('consume-time actor mismatch cancels durably without deferral loop', async () => {
  const provider = { name: 'scope-consume-provider', authorize: async () => ({ decision: 'permit' }) };
  const actor = getAuthenticatedApprovalActor();
  const job = createJob({
    ...jobSpec('scope-consume-cancellation', { provider: provider.name }),
    approval_required: true,
    approval_approver_scope: `user:${actor.username}`,
  });
  const dispatch = enqueueDispatch(job.id, { id: 'scope-consume-dispatch', kind: 'manual' });
  const deps = dispatchDeps(provider, 'scope-consume-idem');
  assert.equal(await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, deps), null);
  const approval = getApprovalForDispatch(dispatch.id);
  assert.equal(resolveApproval(approval.id, 'approved', null, 'scope approved').status, 'approved');
  getDb().prepare('UPDATE approvals SET resolved_by = ? WHERE id = ?')
    .run('local-user:999999', approval.id);

  assert.equal(
    await prepareDispatch(getJob(job.id), { dispatchRecord: getDispatch(dispatch.id) }, deps),
    null,
  );
  const cancelled = getApprovalForDispatch(dispatch.id, { activeOnly: false });
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.cancelled_reason, /no longer satisfies/i);
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS count FROM runs WHERE job_id = ? AND approval_used IS NOT NULL").get(job.id).count,
    0,
  );
});

test('latest inserted approval wins when timestamps and UUID ordering disagree', () => {
  const job = createJob(jobSpec('approval-rowid-ordering', { decision: 'permit' }));
  const dispatch = enqueueDispatch(job.id, { id: 'approval-rowid-dispatch', kind: 'manual' });
  const insert = getDb().prepare(`
    INSERT INTO approvals (
      id, job_id, dispatch_queue_id, status, requested_at, binding_hash, gate_kind
    ) VALUES (?, ?, ?, ?, '2026-07-12 00:00:00', ?, 'authorization')
  `);
  insert.run('z-older', job.id, dispatch.id, 'dispatched', 'sha256:older');
  insert.run('a-newer', job.id, dispatch.id, 'approved', 'sha256:newer');
  assert.equal(getApprovalForDispatch(dispatch.id, { activeOnly: false }).id, 'a-newer');
});

test('reject, timeout, and explicit cancellation consume scheduled approval occurrences', () => {
  for (const status of ['rejected', 'timed_out', 'cancelled']) {
    const job = createJob({
      ...jobSpec(`approval-occurrence-${status}`, { decision: 'permit' }),
      approval_required: true,
      next_run_at: '2020-01-01 00:00:00',
    });
    const dispatch = enqueueDispatch(job.id, {
      id: `approval-occurrence-dispatch-${status}`,
      kind: 'schedule',
      scheduled_for: '2020-01-01 00:00:00',
    });
    claimDispatch(dispatch.id);
    const run = createRun(job.id, { status: 'awaiting_approval', dispatch_queue_id: dispatch.id });
    const approval = createApproval(job.id, run.id, dispatch.id);
    const resolved = status === 'timed_out'
      ? resolveApproval(approval.id, status, 'scheduler', 'timeout', { automatic: true })
      : resolveApproval(approval.id, status, null, status);
    assert.equal(resolved.status, status);
    assert.ok(getJob(job.id).next_run_at > '2020-01-01 00:00:00');
    assert.equal(getDispatch(dispatch.id).status, 'cancelled');
  }
});

test('cancelling an already approved scheduled gate consumes the due occurrence', () => {
  const job = createJob({
    ...jobSpec('approved-cancellation-occurrence', { decision: 'permit' }),
    approval_required: true,
    next_run_at: '2020-01-01 00:00:00',
  });
  const dispatch = enqueueDispatch(job.id, {
    id: 'approved-cancellation-occurrence-dispatch',
    kind: 'schedule',
    scheduled_for: '2020-01-01 00:00:00',
  });
  claimDispatch(dispatch.id);
  const run = createRun(job.id, { status: 'awaiting_approval', dispatch_queue_id: dispatch.id });
  const approval = createApproval(job.id, run.id, dispatch.id);
  assert.equal(resolveApproval(approval.id, 'approved', null).status, 'approved');
  assert.equal(resolveApproval(approval.id, 'cancelled', null, 'operator cancelled').status, 'cancelled');
  assert.ok(getJob(job.id).next_run_at > '2020-01-01 00:00:00');
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
});

test('root approval gate runs are evidence-exempt before authorization is evaluated', async () => {
  const provider = { name: 'root-gate-provider', authorize: async () => ({ decision: 'permit' }) };
  const job = createJob({
    ...jobSpec('root-gate-evidence-exemption', { provider: provider.name }),
    approval_required: true,
    evidence_ref: 'audit:root-gate',
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      payload: { bind: ['authorization'] },
    }),
  });
  const dispatch = enqueueDispatch(job.id, { id: 'root-gate-evidence-dispatch', kind: 'manual' });
  assert.equal(
    await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, dispatchDeps(provider, 'root-gate-idem')),
    null,
  );
  const approval = getApprovalForDispatch(dispatch.id);
  const gateRun = getRun(approval.run_id);
  assert.equal(gateRun.evidence_required, 0);
  assert.equal(resolveApproval(approval.id, 'rejected', null, 'not approved').status, 'rejected');
  assert.equal(getRun(gateRun.id).status, 'cancelled');
  assert.equal(getEvidenceRecord(gateRun.id), null);
});

test('every dispatch kind stops at the approval boundary before live side effects', async () => {
  for (const kind of ['schedule', 'at', 'manual', 'chain', 'retry']) {
    const provider = { name: `gate-order-${kind}`, authorize: async () => ({ decision: 'permit' }) };
    const job = createJob({
      ...jobSpec(`gate-order-${kind}`, { provider: provider.name }),
      approval_required: true,
      identity: JSON.stringify({ subject: { kind: 'service', principal: `svc:${kind}` } }),
      authorization_proof: JSON.stringify({ method: 'none' }),
    });
    const dispatch = enqueueDispatch(job.id, { kind });
    const counters = {
      governance: 0,
      identity: 0,
      proof: 0,
      authorization: 0,
      provider: 0,
      credential_materialization: 0,
      gateway_submission: 0,
      user_code: 0,
    };
    const deps = {
      ...dispatchDeps(provider, `gate-order-idem-${kind}`),
      evaluateGovernance: () => { counters.governance++; return { allowed: true }; },
      resolveIdentity: () => { counters.identity++; return null; },
      verifyAuthorizationProof: async () => { counters.proof++; return { verified: true }; },
      evaluateAuthorization: async () => { counters.authorization++; return { decision: 'permit' }; },
      getIdentityProvider: () => {
        counters.provider++;
        return {
          materialize: async () => {
            counters.credential_materialization++;
            return { materialized: true, env_vars: {} };
          },
        };
      },
      runAgentTurn: async () => { counters.gateway_submission++; return { content: 'unexpected' }; },
      runShellCommand: async () => { counters.user_code++; return { exitCode: 0 }; },
    };
    assert.equal(await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, deps), null);
    assert.deepEqual(counters, {
      governance: 0,
      identity: 0,
      proof: 0,
      authorization: 0,
      provider: 0,
      credential_materialization: 0,
      gateway_submission: 0,
      user_code: 0,
    });
    assert.equal(getApprovalForDispatch(dispatch.id).status, 'pending');
    assert.equal(getDispatch(dispatch.id).status, 'awaiting_approval');
  }
});

test('authorization escalation rejection persists the requested authorization binding', async () => {
  const provider = {
    name: 'authorization-evidence-provider',
    authorize: async () => ({ decision: 'escalate', reason: 'review authorization evidence' }),
  };
  const job = createJob({
    ...jobSpec('authorization-rejection-evidence', { provider: provider.name }),
    evidence_ref: 'audit:authorization-rejection',
    evidence: JSON.stringify({
      provider: 'sha256',
      methods: ['sha256'],
      payload: { bind: ['authorization'] },
    }),
  });
  const dispatch = enqueueDispatch(job.id, { id: 'authorization-evidence-dispatch', kind: 'manual' });
  assert.equal(
    await prepareDispatch(
      getJob(job.id),
      { dispatchRecord: dispatch },
      dispatchDeps(provider, 'authorization-evidence-idem'),
    ),
    null,
  );
  const approval = getApprovalForDispatch(dispatch.id);
  assert.equal(resolveApproval(approval.id, 'rejected', null, 'authorization rejected').status, 'rejected');
  const evidence = getEvidenceRecord(approval.run_id);
  assert.equal(evidence.integrity.valid, true);
  assert.equal(evidence.payload.outcomes.authorization.decision, 'escalate');
  assert(evidence.payload.declaration.enforced_bindings.includes('authorization'));
});
