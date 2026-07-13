import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import {
  acquireDispatcherLease,
  assertDispatcherLease,
  releaseDispatcherLease,
  renewDispatcherLease,
} from '../runtime-lease.js';
import {
  claimRunForDispatch,
  getRunCancellation,
  isRunCancellationRequested,
  recordRunCredentialCleanupState,
  recordRunProcess,
  recordRunProcessTerminated,
  requestRunCancellation,
  transitionRunTerminal,
} from '../run-state.js';
import {
  createRun,
  finishRun,
  getRun,
  persistV02Outcomes,
  pruneRuns,
  quarantineRunRecovery,
  updateContextSummary,
} from '../runs.js';
import {
  claimDispatch,
  enqueueDispatch,
  getDispatch,
  getDueDispatches,
  releaseDispatch,
  recoverStaleDispatchClaims,
  setDispatchStatus,
} from '../dispatch-queue.js';
import {
  cancelJob,
  createJob,
  deleteJob,
  getDispatchBacklogCount,
  getJob,
  pruneExpiredJobs,
  updateJob,
} from '../jobs.js';
import { createApproval, getApproval } from '../approval.js';
import { buildShellEnvironment, runShellCommand } from '../dispatcher-shell.js';
import { runAgentTurn } from '../gateway.js';
import { createDispatcherRuntime } from '../dispatcher-runtime.js';
import { prepareDispatch } from '../dispatcher-strategies.js';
import {
  completeRunFenced,
  classifyPreExecutionAbort,
  commitCompletionBookkeeping,
  isTerminalRunStatus,
  shouldRunPostCompletionEffects,
} from '../run-completion.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createShellJob(name, overrides = {}) {
  return createJob({
    name,
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 30_000,
    origin: 'system',
    ...overrides,
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function makeProcessTreeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scheduler-process-tree-'));
  const path = join(directory, 'tree.mjs');
  writeFileSync(path, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: 'ignore',
});
process.stdout.write(String(child.pid) + '\\n');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, 'utf8');
  return { directory, path };
}

before(async () => {
  setDbPath(':memory:');
  await initDb();
});

after(() => {
  closeDb();
});

test('dispatcher leases refuse a second owner and fence stale owners after takeover', async () => {
  const first = acquireDispatcherLease('runtime-test', 'owner-a', 60);
  assert.equal(first.owner_id, 'owner-a');
  assert.equal(first.fencing_token, 1);
  assert.equal(acquireDispatcherLease('runtime-test', 'owner-b', 1_000), null);

  await delay(90);
  const takeover = acquireDispatcherLease('runtime-test', 'owner-b', 1_000);
  assert.equal(takeover.owner_id, 'owner-b');
  assert.equal(takeover.fencing_token, 2);
  assert.equal(assertDispatcherLease('runtime-test', 'owner-a', 1), false);
  assert.equal(renewDispatcherLease('runtime-test', 'owner-a', 1, 1_000), null);
  assert.equal(renewDispatcherLease('runtime-test', 'owner-b', 2, 1_000)?.fencing_token, 2);
  assert.equal(releaseDispatcherLease('runtime-test', 'owner-a', 1), false);
  assert.equal(releaseDispatcherLease('runtime-test', 'owner-b', 2), true);
  const afterRelease = acquireDispatcherLease('runtime-test', 'owner-c', 1_000);
  assert.equal(afterRelease.fencing_token, 3, 'graceful release must not reuse an old fence token');
  assert.equal(releaseDispatcherLease('runtime-test', 'owner-c', 3), true);
});

test('dispatcher runtime renews leadership independently while the caller awaits', async () => {
  let expiresAt = 0;
  let renewals = 0;
  const runtime = createDispatcherRuntime({
    leaseName: 'independent-renewal-test',
    ownerId: 'independent-renewal-owner',
    leaseTtlMs: 60,
    acquireLease: (_name, ownerId, ttlMs) => {
      expiresAt = Date.now() + ttlMs;
      return { owner_id: ownerId, fencing_token: 1 };
    },
    renewLease: (_name, ownerId, fencingToken, ttlMs) => {
      if (ownerId !== 'independent-renewal-owner' || fencingToken !== 1 || Date.now() >= expiresAt) {
        return null;
      }
      renewals += 1;
      expiresAt = Date.now() + ttlMs;
      return { owner_id: ownerId, fencing_token: fencingToken };
    },
    releaseLease: () => true,
    assertLease: () => Date.now() < expiresAt,
  });

  assert.ok(runtime.start());
  await delay(180);
  assert.ok(renewals >= 3, `expected periodic renewals, observed ${renewals}`);
  assert.equal(runtime.assertLeadership(), true);
  await runtime.stop();
});

test('terminal transitions are fenced CAS operations and cannot be overwritten', () => {
  const leaseName = 'runtime-terminal-cas-lease';
  const lease = acquireDispatcherLease(leaseName, 'owner-b', 2_000);
  const job = createShellJob('runtime-terminal-cas');
  const run = createRun(job.id, {
    dispatcher_owner: 'owner-b',
    dispatcher_token: lease.fencing_token,
  });

  const stale = transitionRunTerminal(
    run.id,
    'ok',
    { summary: 'stale completion' },
    { ownerId: 'owner-a', fencingToken: lease.fencing_token, leaseName },
  );
  assert.equal(stale.changed, false);
  assert.equal(stale.fenced, true);
  assert.equal(stale.run.status, 'running');

  const winner = transitionRunTerminal(
    run.id,
    'ok',
    { summary: 'authoritative completion' },
    { ownerId: 'owner-b', fencingToken: lease.fencing_token, leaseName },
  );
  assert.equal(winner.changed, true);
  assert.equal(winner.fenced, false);
  assert.equal(winner.run.status, 'ok');

  const duplicate = transitionRunTerminal(
    run.id,
    'error',
    { summary: 'late overwrite' },
    { ownerId: 'owner-b', fencingToken: lease.fencing_token, leaseName },
  );
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.fenced, false);
  assert.equal(duplicate.run.status, 'ok');
  assert.equal(duplicate.run.summary, 'authoritative completion');
  assert.equal(releaseDispatcherLease(leaseName, 'owner-b', lease.fencing_token), true);
});

test('run ownership can only be claimed under a live dispatcher lease', () => {
  const leaseName = 'runtime-run-claim-lease';
  const lease = acquireDispatcherLease(leaseName, 'run-claim-owner', 2_000);
  const job = createShellJob('runtime-run-claim');
  const run = createRun(job.id);
  assert.equal(claimRunForDispatch(run.id, {
    ownerId: 'wrong-owner',
    fencingToken: lease.fencing_token,
    leaseName,
  }), null);
  const claimed = claimRunForDispatch(run.id, {
    ownerId: 'run-claim-owner',
    fencingToken: lease.fencing_token,
    leaseName,
  });
  assert.equal(claimed.dispatcher_owner, 'run-claim-owner');
  assert.equal(claimed.dispatcher_token, lease.fencing_token);
  transitionRunTerminal(
    run.id,
    'cancelled',
    { summary: 'test cleanup' },
    { ownerId: 'run-claim-owner', fencingToken: lease.fencing_token, leaseName },
  );
  assert.equal(releaseDispatcherLease(leaseName, 'run-claim-owner', lease.fencing_token), true);
});

test('a cancellation request forces the eventual terminal status to cancelled', () => {
  const leaseName = 'runtime-cancel-terminal-lease';
  const lease = acquireDispatcherLease(leaseName, 'cancel-owner', 2_000);
  const job = createShellJob('runtime-cancel-terminal');
  const run = createRun(job.id, {
    dispatcher_owner: 'cancel-owner',
    dispatcher_token: lease.fencing_token,
  });
  const requested = requestRunCancellation(run.id, {
    requestedBy: 'test-operator',
    reason: 'stop requested',
  });
  assert.equal(requested.changed, true);
  assert.equal(getRunCancellation(run.id).cancel_requested_by, 'test-operator');

  const completed = transitionRunTerminal(
    run.id,
    'ok',
    { summary: 'command returned after cancellation' },
    { ownerId: 'cancel-owner', fencingToken: lease.fencing_token, leaseName },
  );
  assert.equal(completed.changed, true);
  assert.equal(completed.run.status, 'cancelled');
  assert.equal(releaseDispatcherLease(leaseName, 'cancel-owner', lease.fencing_token), true);
});

test('an expired lease fences the old owner after a new dispatcher takes over', async () => {
  const leaseName = 'runtime-expired-owner-lease';
  const oldLease = acquireDispatcherLease(leaseName, 'expired-owner-a', 60);
  const job = createShellJob('runtime-expired-owner');
  const run = createRun(job.id, {
    dispatcher_owner: 'expired-owner-a',
    dispatcher_token: oldLease.fencing_token,
  });
  assert.ok(recordRunProcess(
    run.id,
    { pid: 123_456, pgid: 123_456 },
    { ownerId: 'expired-owner-a', fencingToken: oldLease.fencing_token, leaseName },
  ));

  await delay(90);
  const newLease = acquireDispatcherLease(leaseName, 'expired-owner-b', 2_000);
  assert.ok(newLease.fencing_token > oldLease.fencing_token);

  const staleCompletion = transitionRunTerminal(
    run.id,
    'ok',
    { summary: 'must be fenced' },
    { ownerId: 'expired-owner-a', fencingToken: oldLease.fencing_token, leaseName },
  );
  assert.equal(staleCompletion.changed, false);
  assert.equal(staleCompletion.fenced, true);
  assert.equal(staleCompletion.run.status, 'running');
  assert.ok(recordRunProcessTerminated(
    run.id,
    { ownerId: 'expired-owner-a', fencingToken: oldLease.fencing_token, leaseName },
  )?.process_terminated_at);
  requestRunCancellation(run.id, { requestedBy: 'test-cleanup', reason: 'expired lease test cleanup' });
  assert.equal(releaseDispatcherLease(leaseName, 'expired-owner-b', newLease.fencing_token), true);
});

test('cancelJob records live cancellation metadata and closes pending approval state', () => {
  const job = createShellJob('runtime-cancel-job');
  const liveRun = createRun(job.id, { dispatcher_owner: 'live-owner', dispatcher_token: 4 });
  const pendingDispatch = enqueueDispatch(job.id, { kind: 'manual' });
  const claimedDispatch = enqueueDispatch(job.id, { kind: 'manual' });
  assert.ok(claimDispatch(claimedDispatch.id, { ownerId: 'cancel-race-owner', leaseMs: 2_000 }));
  const approvalDispatch = enqueueDispatch(job.id, { kind: 'manual' });
  setDispatchStatus(approvalDispatch.id, 'awaiting_approval');
  const approvalRun = createRun(job.id, {
    status: 'awaiting_approval',
    dispatch_queue_id: approvalDispatch.id,
  });
  const approval = createApproval(job.id, approvalRun.id, approvalDispatch.id);

  assert.deepEqual(cancelJob(job.id, {
    requestedBy: 'test-operator',
    reason: 'operator cancelled the job',
  }), [job.id]);

  assert.equal(getJob(job.id).enabled, 0);
  assert.equal(getDispatch(pendingDispatch.id).status, 'cancelled');
  assert.equal(getDispatch(claimedDispatch.id).status, 'cancelled');
  assert.equal(getDispatch(approvalDispatch.id).status, 'cancelled');
  assert.equal(getApproval(approval.id).status, 'cancelled');
  assert.equal(getRun(approvalRun.id).status, 'cancelled');

  const stillLive = getRun(liveRun.id);
  assert.equal(stillLive.status, 'running');
  assert.ok(stillLive.cancel_requested_at);
  assert.equal(stillLive.cancel_requested_by, 'test-operator');
  assert.equal(stillLive.cancel_reason, 'operator cancelled the job');
});

test('deleteJob refuses active job trees until cancellation reaches a terminal run', () => {
  const parent = createShellJob('runtime-delete-active-parent');
  const child = createShellJob('runtime-delete-active-child', {
    parent_id: parent.id,
    trigger_on: 'complete',
  });
  const dispatch = enqueueDispatch(child.id, { kind: 'manual' });
  const run = createRun(child.id, { dispatch_queue_id: dispatch.id });

  assert.throws(
    () => deleteJob(parent.id),
    error => error.code === 'JOB_ACTIVE_RUNS' && error.activeRuns.some(active => active.id === run.id),
  );
  assert.equal(getJob(parent.id).id, parent.id);
  assert.equal(getRun(run.id).status, 'running');
  assert.equal(getDispatch(dispatch.id).job_id, child.id);

  cancelJob(parent.id, { requestedBy: 'delete-test', reason: 'prepare for deletion' });
  assert.equal(transitionRunTerminal(run.id, 'cancelled', { summary: 'cancelled before deletion' }).changed, true);
  assert.equal(deleteJob(parent.id), true);
});

test('run and expired-job pruning never delete active lifecycle state', () => {
  const historyJob = createShellJob('runtime-prune-active-history');
  const active = createRun(historyJob.id);
  getDb().prepare("UPDATE runs SET started_at = datetime('now', '-30 days') WHERE id = ?").run(active.id);
  for (let index = 0; index < 4; index += 1) {
    const terminal = createRun(historyJob.id);
    finishRun(terminal.id, 'ok', { summary: `terminal-${index}` });
  }
  pruneRuns(1);
  assert.equal(getRun(active.id).status, 'running');
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS count FROM runs WHERE job_id = ? AND status = 'ok'").get(historyJob.id).count,
    1,
  );

  const expiring = createShellJob('runtime-prune-active-job', {
    enabled: 0,
    delete_after_run: 1,
  });
  const expiringRun = createRun(expiring.id);
  getDb().prepare(`
    UPDATE jobs
    SET last_run_at = datetime('now', '-2 days'), last_status = 'ok'
    WHERE id = ?
  `).run(expiring.id);
  pruneExpiredJobs();
  assert.equal(getJob(expiring.id).id, expiring.id);
  finishRun(expiringRun.id, 'cancelled', { summary: 'prune test cleanup' });
  pruneExpiredJobs();
  assert.equal(getJob(expiring.id), undefined);

  finishRun(active.id, 'cancelled', { summary: 'history cleanup' });
  deleteJob(historyJob.id);
});

test('automatic pruning preserves recovery-blocked operator signals', () => {
  const scheduledAt = '2020-01-01 00:00:00';
  const job = createShellJob('runtime-prune-recovery-blocked', {
    schedule_kind: 'at',
    schedule_at: scheduledAt,
    schedule_cron: '0 0 31 2 *',
    next_run_at: scheduledAt,
    enabled: 0,
    delete_after_run: 1,
  });
  const run = createRun(job.id);
  getDb().prepare(`
    UPDATE runs
    SET status = 'recovery_blocked',
        finished_at = ?,
        terminal_transition_at = ?,
        error_message = 'operator review required'
    WHERE id = ?
  `).run(scheduledAt, scheduledAt, run.id);
  getDb().prepare(`
    UPDATE jobs
    SET enabled = 0,
        last_run_at = ?,
        last_status = 'recovery_blocked'
    WHERE id = ?
  `).run(scheduledAt, job.id);

  pruneRuns(0);
  pruneExpiredJobs();
  assert.equal(getRun(run.id).status, 'recovery_blocked');
  assert.equal(getJob(job.id).last_status, 'recovery_blocked');

  assert.equal(deleteJob(job.id), true, 'explicit operator deletion remains available');
});

test('prepared outcome checkpoints reject a stale dispatcher fence', async () => {
  const leaseName = 'runtime-outcome-checkpoint-fence';
  const first = acquireDispatcherLease(leaseName, 'checkpoint-owner-a', 60);
  const job = createShellJob('runtime-outcome-checkpoint');
  const run = createRun(job.id, {
    dispatcher_owner: 'checkpoint-owner-a',
    dispatcher_token: first.fencing_token,
  });
  persistV02Outcomes(run.id, {
    identity_resolved: { principal: 'before-takeover' },
  }, {
    requireRunningFence: true,
    dispatcherFence: {
      leaseName,
      ownerId: 'checkpoint-owner-a',
      fencingToken: first.fencing_token,
    },
  });

  await delay(90);
  const takeover = acquireDispatcherLease(leaseName, 'checkpoint-owner-b', 2_000);
  assert.throws(
    () => persistV02Outcomes(run.id, {
      identity_resolved: { principal: 'stale-write' },
    }, {
      requireRunningFence: true,
      dispatcherFence: {
        leaseName,
        ownerId: 'checkpoint-owner-a',
        fencingToken: first.fencing_token,
      },
    }),
    error => error.code === 'RUN_OUTCOME_CHECKPOINT_FENCED',
  );
  assert.equal(JSON.parse(getRun(run.id).identity_resolved).principal, 'before-takeover');
  requestRunCancellation(run.id, { requestedBy: 'test-cleanup', reason: 'checkpoint test cleanup' });
  getDb().prepare(`
    UPDATE runs
    SET status = 'cancelled', finished_at = datetime('now'), terminal_transition_at = datetime('now')
    WHERE id = ?
  `).run(run.id);
  assert.equal(releaseDispatcherLease(leaseName, 'checkpoint-owner-b', takeover.fencing_token), true);
  deleteJob(job.id);
});

test('recovery quarantine requires run ownership unless startup explicitly adopts an orphan', async () => {
  const leaseName = 'runtime-recovery-quarantine-fence';
  const staleLease = acquireDispatcherLease(leaseName, 'quarantine-owner-a', 60);
  const job = createShellJob('runtime-recovery-quarantine');
  const run = createRun(job.id, {
    dispatcher_owner: 'quarantine-owner-a',
    dispatcher_token: staleLease.fencing_token,
  });
  await delay(90);
  const takeover = acquireDispatcherLease(leaseName, 'quarantine-owner-b', 2_000);
  const fence = {
    leaseName,
    ownerId: 'quarantine-owner-b',
    fencingToken: takeover.fencing_token,
  };

  const ordinary = quarantineRunRecovery(run.id, 'must preserve foreign ownership', {
    dispatcherFence: fence,
  });
  assert.equal(ordinary.changed, false);
  assert.equal(getRun(run.id).status, 'running');

  const adopted = quarantineRunRecovery(run.id, 'startup adopted expired orphan', {
    dispatcherFence: fence,
    allowStaleRunOwner: true,
  });
  assert.equal(adopted.changed, true);
  assert.equal(getRun(run.id).status, 'recovery_blocked');
  assert.equal(getJob(job.id).enabled, 0);
  assert.equal(releaseDispatcherLease(leaseName, 'quarantine-owner-b', takeover.fencing_token), true);
  deleteJob(job.id);
});

test('cancellation after dispatch claim atomically prevents execution run creation', async () => {
  const job = createShellJob('runtime-cancel-after-claim');
  const dispatch = enqueueDispatch(job.id, { kind: 'manual' });
  const context = await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, {
    claimDispatch(id) {
      const claimed = claimDispatch(id, { ownerId: 'cancel-after-claim-owner', leaseMs: 2_000 });
      cancelJob(job.id, { requestedBy: 'race-test', reason: 'cancelled after claim' });
      return claimed;
    },
    releaseDispatch,
    setDispatchStatus,
    countPendingApprovalsForJob: () => 0,
    getPendingApproval: () => null,
    createApproval,
    getApprovalForDispatch: () => null,
    beginApprovalDispatch: () => ({ changed: false }),
    markApprovalDispatched: () => ({ changed: false }),
    cancelApprovalForDispatch: () => ({ changed: false }),
    createRun,
    getRun,
    hasRunningRunForPool: () => false,
    hasRunningRun: () => false,
    enqueueJob: () => ({ queued: false }),
    getDispatchBacklogCount,
    generateIdempotencyKey: () => null,
    generateChainIdempotencyKey: () => null,
    generateRunNowIdempotencyKey: () => null,
    claimIdempotencyKey: () => true,
    finishRun: () => null,
    getDb,
    sqliteNow: () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    adaptiveDeferralMs: () => 1_000,
    handleDelivery: () => null,
    advanceNextRun: () => {},
    updateJobAfterRun: () => {},
    TICK_INTERVAL_MS: 1_000,
    log: () => {},
    evaluateGovernance: () => ({ allowed: true, violations: [], warnings: [] }),
    buildShellEnvironment: () => ({}),
    summarizeGovernance: () => null,
  });

  assert.equal(context, null);
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM runs WHERE job_id = ?').get(job.id).count, 0);
});

test('disabling a job after claim atomically prevents execution run creation', async () => {
  const job = createShellJob('runtime-disable-after-claim');
  const dispatch = enqueueDispatch(job.id, { kind: 'manual' });
  const context = await prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, {
    claimDispatch(id) {
      const claimed = claimDispatch(id, { ownerId: 'disable-after-claim-owner', leaseMs: 2_000 });
      updateJob(job.id, { enabled: 0 });
      return claimed;
    },
    releaseDispatch,
    setDispatchStatus,
    countPendingApprovalsForJob: () => 0,
    getPendingApproval: () => null,
    createApproval,
    getApprovalForDispatch: () => null,
    beginApprovalDispatch: () => ({ changed: false }),
    markApprovalDispatched: () => ({ changed: false }),
    cancelApprovalForDispatch: () => ({ changed: false }),
    createRun,
    getRun,
    hasRunningRunForPool: () => false,
    hasRunningRun: () => false,
    enqueueJob: () => ({ queued: false }),
    getDispatchBacklogCount,
    generateIdempotencyKey: () => null,
    generateChainIdempotencyKey: () => null,
    generateRunNowIdempotencyKey: () => null,
    claimIdempotencyKey: () => true,
    finishRun: () => null,
    getDb,
    sqliteNow: () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    adaptiveDeferralMs: () => 1_000,
    handleDelivery: () => null,
    advanceNextRun: () => {},
    updateJobAfterRun: () => {},
    TICK_INTERVAL_MS: 1_000,
    log: () => {},
    evaluateGovernance: () => ({ allowed: true, violations: [], warnings: [] }),
    buildShellEnvironment: () => ({}),
    summarizeGovernance: () => null,
  });

  assert.equal(context, null);
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
  assert.match(getDispatch(dispatch.id).last_error, /disabled before execution/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM runs WHERE job_id = ?').get(job.id).count, 0);
});

test('cancellation during slow preparation terminalizes the run before execution', async () => {
  const job = createShellJob('runtime-cancel-slow-prepare', {
    identity: JSON.stringify({ provider: 'slow-test-provider' }),
  });
  const dispatch = enqueueDispatch(job.id, { kind: 'manual' });
  let releaseIdentityResolution;
  const identityResolution = new Promise(resolve => {
    releaseIdentityResolution = resolve;
  });
  let preparedRun;
  let signalPrepared;
  const runPrepared = new Promise(resolve => {
    signalPrepared = resolve;
  });

  const preparation = prepareDispatch(getJob(job.id), { dispatchRecord: dispatch }, {
    claimDispatch,
    releaseDispatch,
    setDispatchStatus,
    countPendingApprovalsForJob: () => 0,
    getPendingApproval: () => null,
    createApproval,
    getApprovalForDispatch: () => null,
    beginApprovalDispatch: () => ({ changed: false }),
    markApprovalDispatched: () => ({ changed: false }),
    cancelApprovalForDispatch: () => ({ changed: false }),
    createRun,
    getRun,
    hasRunningRunForPool: () => false,
    hasRunningRun: () => false,
    enqueueJob: () => ({ queued: false }),
    getDispatchBacklogCount,
    generateIdempotencyKey: () => null,
    generateChainIdempotencyKey: () => null,
    generateRunNowIdempotencyKey: () => null,
    claimIdempotencyKey: () => true,
    releaseIdempotencyKey: () => {},
    getDb,
    sqliteNow: () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    adaptiveDeferralMs: () => 1_000,
    handleDelivery: () => null,
    advanceNextRun: () => {},
    updateJobAfterRun: () => {},
    TICK_INTERVAL_MS: 1_000,
    log: () => {},
    evaluateGovernance: () => ({ allowed: true, violations: [], warnings: [] }),
    buildShellEnvironment: () => ({}),
    summarizeGovernance: () => null,
    summarizeCredentialHandoff: () => null,
    resolveIdentity: async () => {
      await identityResolution;
      return {
        provider: 'slow-test-provider',
        source: 'static',
        trust_level: 'untrusted',
      };
    },
    evaluateTrust: () => ({ decision: 'allow' }),
    verifyAuthorizationProof: async () => ({ verified: true }),
    evaluateAuthorization: async () => ({ decision: 'allow' }),
    getIdentityProvider: () => null,
    getAuthorizationProvider: () => null,
    getProofVerifier: () => null,
    persistV02Outcomes: () => {},
    handleTriggeredChildren: () => {},
    dequeueJob: () => false,
    transitionRunTerminal,
    completeRunFenced,
    commitCompletionBookkeeping,
    shouldRunPostCompletionEffects,
    isRunCancellationRequested,
    onRunPrepared: run => {
      preparedRun = run;
      signalPrepared();
    },
  });

  await runPrepared;
  assert.equal(getRun(preparedRun.id).status, 'running');
  cancelJob(job.id, {
    requestedBy: 'slow-prepare-test',
    reason: 'cancelled while identity provider was resolving',
  });
  releaseIdentityResolution();

  assert.equal(await preparation, null);
  const cancelled = getRun(preparedRun.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.summary, /cancelled while identity provider was resolving/);
  assert.equal(cancelled.process_started_at, null);
  assert.equal(getDispatch(dispatch.id).status, 'cancelled');
});

test('recovery_blocked is recognized as a terminal run status', () => {
  assert.equal(isTerminalRunStatus('recovery_blocked'), true);
});

test('pre-execution abort classification preserves lifecycle work for recovery', () => {
  const activeRun = { status: 'running', cancel_requested_at: null };
  assert.equal(classifyPreExecutionAbort(activeRun, 'shutdown'), 'recover');
  assert.equal(classifyPreExecutionAbort(activeRun, 'lease_lost'), 'recover');
  assert.equal(classifyPreExecutionAbort(activeRun, 'fatal'), 'recover');
  assert.equal(classifyPreExecutionAbort(activeRun, null), 'recover');
  assert.equal(classifyPreExecutionAbort(activeRun, 'health_timeout'), 'complete_error');
  assert.equal(classifyPreExecutionAbort({
    ...activeRun,
    cancel_requested_at: 'present',
  }, 'shutdown'), 'cancel');
});

test('credential cleanup safety state survives lease loss without stale terminal writes', () => {
  const leaseName = 'runtime-credential-cleanup-state-lease';
  const lease = acquireDispatcherLease(leaseName, 'cleanup-state-owner', 2_000);
  const job = createShellJob('runtime-credential-cleanup-state');
  const run = createRun(job.id);
  assert.ok(claimRunForDispatch(run.id, {
    ownerId: 'cleanup-state-owner',
    fencingToken: lease.fencing_token,
    leaseName,
  }));
  assert.ok(recordRunCredentialCleanupState(run.id, {
    status: 'pending',
    attempts: 0,
  }, {
    ownerId: 'cleanup-state-owner',
    fencingToken: lease.fencing_token,
    leaseName,
  }));
  updateContextSummary(run.id, { prompt_messages: 2 });
  const mergedContext = JSON.parse(getRun(run.id).context_summary);
  assert.equal(mergedContext.prompt_messages, 2);
  assert.equal(mergedContext.credential_cleanup.status, 'pending');
  assert.equal(releaseDispatcherLease(leaseName, 'cleanup-state-owner', lease.fencing_token), true);

  const failed = recordRunCredentialCleanupState(run.id, {
    status: 'failed',
    attempts: 3,
    error: 'provider cleanup remained unavailable',
  }, {
    ownerId: 'cleanup-state-owner',
    fencingToken: lease.fencing_token,
    leaseName,
    allowAfterLeaseLoss: true,
  });
  const cleanupState = JSON.parse(failed.context_summary).credential_cleanup;
  assert.equal(cleanupState.status, 'failed');
  assert.equal(cleanupState.operator_action_required, true);
  assert.equal(cleanupState.attempts, 3);

  getDb().prepare(`
    UPDATE runs
    SET status = 'recovery_blocked', finished_at = datetime('now')
    WHERE id = ?
  `).run(run.id);
  assert.equal(recordRunCredentialCleanupState(run.id, {
    status: 'cleaned',
    attempts: 3,
  }, {
    ownerId: 'cleanup-state-owner',
    fencingToken: lease.fencing_token,
    leaseName,
    allowAfterLeaseLoss: true,
  }), null);
});

test('dispatch claims expire, recover, and use idempotent deterministic IDs', async () => {
  const job = createShellJob('runtime-queue-recovery');
  const first = enqueueDispatch(job.id, { id: 'deterministic-schedule', kind: 'schedule' });
  const again = enqueueDispatch(job.id, { id: 'deterministic-schedule', kind: 'schedule' });
  assert.equal(again.id, first.id);
  assert.throws(
    () => enqueueDispatch(job.id, { id: 'deterministic-schedule', kind: 'at' }),
    /already exists/,
  );

  const claimed = claimDispatch(first.id, { ownerId: 'queue-owner', leaseMs: 50 });
  assert.equal(claimed.claim_owner, 'queue-owner');
  assert.ok(claimed.claim_token);
  assert.equal(claimed.attempt_count, 1);
  const legacy = enqueueDispatch(job.id, { id: 'legacy-expiring-claim', kind: 'manual' });
  const legacyClaim = claimDispatch(legacy.id, { leaseMs: 50 });
  assert.equal(legacyClaim.claim_owner, null);
  assert.ok(legacyClaim.claim_expires_at, 'compatibility claims still need a recovery deadline');
  assert.equal(recoverStaleDispatchClaims(), 0);

  await delay(80);
  assert.equal(recoverStaleDispatchClaims(), 2);
  const recovered = getDispatch(first.id);
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.claim_owner, null);
  assert.match(recovered.last_error, /expired dispatch claim/i);
  assert.ok(getDueDispatches().some(dispatch => dispatch.id === first.id));
  assert.equal(getDispatch(legacy.id).status, 'pending');
});

test('disabled jobs cancel every dispatch kind including manual dispatches', () => {
  const job = createShellJob('runtime-disabled-queue', { enabled: 0 });
  const scheduled = enqueueDispatch(job.id, { id: 'disabled-schedule', kind: 'schedule' });
  const manual = enqueueDispatch(job.id, { id: 'disabled-manual', kind: 'manual' });
  const due = getDueDispatches();

  assert.equal(getDispatch(scheduled.id).status, 'cancelled');
  assert.equal(getDispatch(manual.id).status, 'cancelled');
  assert.ok(!due.some(dispatch => dispatch.id === manual.id));
  assert.ok(!due.some(dispatch => dispatch.id === scheduled.id));
});

test('fire-and-forget, shell environment policy, and output defaults validate consistently', () => {
  const job = createJob({
    name: 'runtime-job-defaults',
    schedule_cron: '0 * * * *',
    session_target: 'main',
    payload_kind: 'systemEvent',
    payload_message: 'run in the background',
    execution_intent: 'fire-and-forget',
    delivery_mode: 'none',
    run_timeout_ms: 30_000,
    origin: 'system',
  });
  assert.equal(job.execution_intent, 'fire-and-forget');
  assert.equal(job.shell_env_policy, 'minimal');
  assert.equal(job.output_store_limit_bytes, 65_536);
  assert.equal(job.output_excerpt_limit_bytes, 65_536);
  assert.equal(job.output_summary_limit_bytes, 65_536);
  assert.equal(job.output_offload_threshold_bytes, 65_536);

  assert.equal(updateJob(job.id, { shell_env_policy: 'inherit' }).shell_env_policy, 'inherit');
  assert.throws(() => updateJob(job.id, { shell_env_policy: 'unsafe' }), /shell_env_policy/);
  assert.throws(() => updateJob(job.id, { execution_intent: 'background-ish' }), /execution_intent/);
  assert.throws(
    () => createShellJob('runtime-invalid-fire-and-forget', { execution_intent: 'fire-and-forget' }),
    /only supported.*main/,
  );

  const originalSecret = process.env.RUNTIME_HARDENING_SECRET;
  process.env.RUNTIME_HARDENING_SECRET = 'must-not-leak';
  try {
    assert.equal(buildShellEnvironment(null, 'minimal').RUNTIME_HARDENING_SECRET, undefined);
    assert.equal(buildShellEnvironment(null, 'inherit').RUNTIME_HARDENING_SECRET, 'must-not-leak');
    assert.equal(buildShellEnvironment({ RUNTIME_HARDENING_SECRET: 'explicit' }, 'minimal').RUNTIME_HARDENING_SECRET, 'explicit');
  } finally {
    if (originalSecret == null) delete process.env.RUNTIME_HARDENING_SECRET;
    else process.env.RUNTIME_HARDENING_SECRET = originalSecret;
  }
});

test('shell timeout kills the complete descendant process group', async () => {
  const fixture = makeProcessTreeFixture();
  let descendantPid = null;
  try {
    const result = await runShellCommand(
      `${shellQuote(process.execPath)} ${shellQuote(fixture.path)}`,
      150,
      null,
      { killGraceMs: 75, envPolicy: 'minimal' },
    );
    descendantPid = Number(result.stdout.trim().split(/\s+/)[0]);
    assert.equal(result.timedOut, true);
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 1);
    await delay(100);
    assert.equal(processExists(descendantPid), false, `descendant ${descendantPid} survived timeout`);
  } finally {
    if (processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('external abort kills descendants and reports process metadata', async () => {
  const fixture = makeProcessTreeFixture();
  const controller = new AbortController();
  let callbackProcess = null;
  let descendantPid = null;
  try {
    const promise = runShellCommand(
      `${shellQuote(process.execPath)} ${shellQuote(fixture.path)}`,
      5_000,
      null,
      {
        signal: controller.signal,
        killGraceMs: 75,
        onProcess: info => { callbackProcess = info; },
      },
    );
    setTimeout(() => controller.abort(new Error('test cancellation')), 150);
    const result = await promise;
    descendantPid = Number(result.stdout.trim().split(/\s+/)[0]);
    assert.equal(result.aborted, true);
    assert.equal(result.error?.code, 'ABORT_ERR');
    assert.equal(callbackProcess.pid, result.pid);
    assert.equal(callbackProcess.pgid, result.pgid);
    await delay(100);
    assert.equal(processExists(descendantPid), false, `descendant ${descendantPid} survived abort`);
  } finally {
    if (processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('maxBuffer is enforced without returning unbounded output', async () => {
  const result = await runShellCommand('printf 123456789', 2_000, null, {
    maxBuffer: 4,
    killGraceMs: 25,
  });
  assert.equal(result.maxBufferExceeded, true);
  assert.equal(result.stdout, '1234');
  assert.equal(result.stdoutBytes, 9);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.error?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('gateway agent turns honor an external AbortSignal', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => await new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(opts.signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    opts.signal.addEventListener('abort', () => {
      reject(opts.signal.reason || new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

  const controller = new AbortController();
  try {
    const turn = runAgentTurn({
      message: 'wait forever',
      sessionKey: 'runtime-hardening-test',
      timeoutMs: 5_000,
      signal: controller.signal,
      cancelOnAbort: false,
    });
    controller.abort(new Error('operator cancellation'));
    await assert.rejects(turn, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime hardening tests did not leave active owned runs', () => {
  const rows = getDb().prepare(`
    SELECT id FROM runs
    WHERE status = 'running' AND cancel_requested_at IS NULL
  `).all();
  assert.equal(rows.length, 0);
});
