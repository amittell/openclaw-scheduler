import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { setDbPath, initDb, closeDb, getDb } from '../db.js';
import { createJob, getJob, updateJob, deleteJob, getDueJobs, getDueAtJobs, nextRunFromCron, shouldRetry, scheduleRetry, canEnqueueDispatch, getDispatchBacklogCount } from '../jobs.js';
import { createRun, getRun, finishRun } from '../runs.js';
import { enqueueDispatch, getDispatch, setDispatchStatus, claimDispatch } from '../dispatch-queue.js';
import { completeRunFenced, commitCompletionBookkeeping, shouldRunPostCompletionEffects } from '../run-completion.js';
import { transitionRunTerminal } from '../run-state.js';
import { createDeliveryHelpers, createTransientFailureAlertHandler } from '../dispatcher-delivery.js';
import { finalizeDispatch } from '../dispatcher-strategies.js';
import { reconcileCompletedDueSchedules } from '../dispatcher-maintenance.js';
import { sqliteNow, getBackoffMs } from '../dispatcher-utils.js';

const dispatcherSource = readFileSync(new URL('../dispatcher.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last).trim();
}
// The executable dispatcher starts its service when imported. Extract only its
// unchanged production updater and ID helper, binding them to the real test DB.
const context = vm.createContext({ getDb, getJob, updateJob, deleteJob, sqliteNow, nextRunFromCron, getBackoffMs, createHash, log: () => {} });
vm.runInContext(between(dispatcherSource, 'function updateJobAfterRun', 'function materializeDueSchedules'), context);
const { updateJobAfterRun, scheduledDispatchId } = context;

function createAlert(target, deliverMessageFn) {
  return createTransientFailureAlertHandler({ target, deliverMessageFn });
}
const alertPayload = { jobName: 'Synthetic job', jobId: 'fixture', runId: 'fixture-run', errorMessage: 'synthetic failure', consecutiveErrors: 2 };

test.beforeEach(async () => { setDbPath(':memory:'); await initDb(); });
test.afterEach(() => closeDb());

test('failure alerts never send without a valid explicit operator target', async () => {
  for (const target of [undefined, '', ' ', 'not-an-id', '0', '123 456', 'telegram:123', '9007199254740992']) {
    const calls = [];
    await createAlert(target, async (...args) => { calls.push(args); })(alertPayload);
    assert.equal(calls.length, 0, `invalid/unset operator target ${JSON.stringify(target)} must not send`);
  }
});

test('an explicit numeric operator target is normalized and used exactly once', async () => {
  for (const target of [' 123456 ', ' -100123456 ']) {
    const calls = [];
    await createAlert(target, async (...args) => { calls.push(args); })(alertPayload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'telegram');
    assert.equal(calls[0][1], target.trim());
  }
});

function fixture(overrides = {}) {
  return createJob({ name: 'Synthetic lifecycle job', schedule_cron: '0 7 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'synthetic fixture only', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system', ...overrides });
}
function setup(job, run, dispatchRecord = null, alert = async () => ({ sent: true })) {
  const { handleDelivery } = createDeliveryHelpers({ log: () => {}, resolveDeliveryAlias: () => null });
  const deps = { getDb, getJob, updateJob, deleteJob, finishRun, completeRunFenced, transitionRunTerminal, commitCompletionBookkeeping, shouldRunPostCompletionEffects, updateJobAfterRun, shouldRetry, scheduleRetry, canEnqueueDispatch, getDispatchBacklogCount, enqueueDispatch, setDispatchStatus, sqliteNow, handleDelivery, alertTransitFailure: alert, log: () => {}, updateIdempotencyResultHash: () => {}, releaseIdempotencyKey: () => {}, setAgentStatus: () => {}, handleTriggeredChildren: () => {}, dequeueJob: () => false };
  const ctx = { run, dispatchRecord, idemKey: null, v02Outcomes: null, v4Artifact: null };
  return { deps, ctx };
}
function result(status = 'error', content = 'non-transient synthetic configuration failure') {
  return { status, summary: content, content, errorMessage: status === 'error' ? content : null, runFinishFields: {}, skipAgentCleanup: true, skipChildren: true, skipDequeue: true, skipJobUpdate: false, skipDelivery: false };
}

test('completion rollback sends no alert and restores run/counter with real SQLite', async () => {
  let job = fixture();
  job = updateJob(job.id, { consecutive_errors: 1, delivery_mode: 'announce', delivery_to: 'not-an-id' });
  const run = createRun(job.id);
  const calls = [];
  const { deps, ctx } = setup(job, run, null, async payload => { calls.push(payload); });
  await assert.rejects(finalizeDispatch(job, ctx, result(), deps), /requires both channel and target/);
  await Promise.resolve();
  assert.equal(getRun(run.id).status, 'running');
  assert.equal(getJob(job.id).consecutive_errors, 1);
  assert.equal(calls.length, 0, 'no external alert from a rolled-back completion');
});

test('one alert observes a committed terminal run, and duplicate completion sends none', async () => {
  const job = updateJob(fixture().id, { consecutive_errors: 1 });
  const run = createRun(job.id);
  const observations = [];
  const { deps, ctx } = setup(job, run, null, async () => { observations.push({ inTransaction: getDb().inTransaction, status: getRun(run.id).status, errors: getJob(job.id).consecutive_errors }); return { sent: true }; });
  await finalizeDispatch(job, ctx, result(), deps);
  await finalizeDispatch(job, ctx, result(), deps);
  assert.deepEqual(observations, [{ inTransaction: false, status: 'error', errors: 2 }]);
});

test('an open outer transaction never emits an alert that could survive rollback', async () => {
  const job = updateJob(fixture().id, { consecutive_errors: 1 });
  const run = createRun(job.id);
  const calls = [];
  const { deps, ctx } = setup(job, run, null, async payload => { calls.push(payload); });
  getDb().exec('BEGIN');
  try {
    await finalizeDispatch(job, ctx, result(), deps);
    assert.equal(getDb().inTransaction, true);
    assert.equal(calls.length, 0);
  } finally {
    getDb().exec('ROLLBACK');
  }
  assert.equal(getRun(run.id).status, 'running');
  assert.equal(getJob(job.id).consecutive_errors, 1);
});

test('alert sink failure does not undo the committed completion or replay it', async () => {
  const job = updateJob(fixture().id, { consecutive_errors: 1 });
  const run = createRun(job.id);
  let calls = 0;
  const { deps, ctx } = setup(job, run, null, async () => { calls += 1; throw new Error('controlled sink failure'); });
  await finalizeDispatch(job, ctx, result(), deps);
  await finalizeDispatch(job, ctx, result(), deps);
  assert.equal(getRun(run.id).status, 'error');
  assert.equal(getJob(job.id).consecutive_errors, 2);
  assert.equal(calls, 1);
});

for (const terminalStatus of ['ok', 'error']) test(`one-shot transient retry survives reconciliation and completes ${terminalStatus}`, async () => {
  const job = fixture({ schedule_kind: 'at', schedule_at: sqliteNow(-60_000), max_retries: 0 });
  const dispatch = enqueueDispatch(job.id, { id: scheduledDispatchId(job.id, 'at', job.schedule_at), kind: 'at', scheduled_for: job.schedule_at });
  const claimed = claimDispatch(dispatch.id);
  const run = createRun(job.id, { dispatch_queue_id: dispatch.id });
  const alerts = [];
  const alert = async payload => { alerts.push(payload); return { sent: true }; };
  const { deps, ctx } = setup(job, run, claimed, alert);
  await finalizeDispatch(job, ctx, result('error', 'Chat completions failed (500): Internal Server Error'), deps);
  const retry = getDb().prepare("SELECT * FROM job_dispatch_queue WHERE job_id=? AND dispatch_kind='retry'").all(job.id);
  assert.equal(retry.length, 1);
  const reconciled = reconcileCompletedDueSchedules({ log: () => {}, getDb, getDueJobs, getDueAtJobs, getDispatch, scheduledDispatchId, updateJobAfterRun });
  assert.equal(reconciled, 0, 'retry scheduling records the original occurrence before reconciliation');
  assert.equal(getJob(job.id).enabled, 1);
  assert.ok(getJob(job.id).last_run_at);
  assert.equal(getJob(job.id).last_status, 'error');
  assert.equal(getJob(job.id).consecutive_errors, 1, 'first failure is counted exactly once');
  assert.equal(alerts.length, 0);
  const retryClaim = claimDispatch(retry[0].id);
  assert.ok(retryClaim, 'real enabled-job claim guard admits the pending retry');
  const retryRun = createRun(job.id, { dispatch_queue_id: retryClaim.id, retry_of: run.id, retry_count: getRun(run.id).retry_count });
  const second = setup(getJob(job.id), retryRun, retryClaim, alert);
  await finalizeDispatch(getJob(job.id), second.ctx, result(terminalStatus, 'Chat completions failed (500): Internal Server Error'), second.deps);
  assert.equal(getJob(job.id).enabled, 0, 'one-shot is disabled only after its retry completes');
  assert.equal(getRun(retryRun.id).status, terminalStatus);
  assert.equal(getDispatch(retryClaim.id).status, 'done');
  assert.equal(getDb().prepare('SELECT count(*) n FROM runs WHERE job_id=?').get(job.id).n, 2);
  assert.equal(getDispatchBacklogCount(job.id), 0, 'no second retry remains queued');
  assert.equal(getJob(job.id).consecutive_errors, terminalStatus === 'error' ? 2 : 0);
  assert.equal(alerts.length, terminalStatus === 'error' ? 1 : 0);
});

test('scheduleRetry retains its default delay and rejects invalid overrides before writing', () => {
  const job = fixture();
  const run = createRun(job.id);
  for (const delaySec of [0, -1, Infinity, NaN]) {
    assert.throws(() => scheduleRetry(job, run.id, { delaySec }), /positive finite/);
  }
  assert.equal(getDispatchBacklogCount(job.id), 0);
  assert.equal(getJob(job.id).last_run_at, null);
  const retry = scheduleRetry(job, run.id);
  assert.equal(retry.delaySec, 30);
  assert.equal(getDispatchBacklogCount(job.id), 1);
  assert.ok(getJob(job.id).last_run_at);
});

test('cron transient retry advances its occurrence and counts failures once across reconciliation', async () => {
  const job = updateJob(fixture().id, { next_run_at: sqliteNow(-60_000) });
  const dispatch = enqueueDispatch(job.id, { id: scheduledDispatchId(job.id, 'schedule', job.next_run_at), kind: 'schedule', scheduled_for: job.next_run_at });
  const run = createRun(job.id, { dispatch_queue_id: dispatch.id });
  const alerts = [];
  const alert = async payload => { alerts.push(payload); return { sent: true }; };
  const first = setup(job, run, claimDispatch(dispatch.id), alert);
  await finalizeDispatch(job, first.ctx, result('error', 'Chat completions failed (500): Internal Server Error'), first.deps);
  assert.notEqual(getJob(job.id).next_run_at, job.next_run_at);
  assert.equal(reconcileCompletedDueSchedules({ log: () => {}, getDb, getDueJobs, getDueAtJobs, getDispatch, scheduledDispatchId, updateJobAfterRun }), 0);
  assert.equal(getJob(job.id).consecutive_errors, 1);
  const retry = getDb().prepare("SELECT * FROM job_dispatch_queue WHERE job_id=? AND dispatch_kind='retry'").get(job.id);
  const retryRun = createRun(job.id, { dispatch_queue_id: retry.id, retry_of: run.id, retry_count: getRun(run.id).retry_count });
  const second = setup(getJob(job.id), retryRun, claimDispatch(retry.id), alert);
  await finalizeDispatch(getJob(job.id), second.ctx, result('error', 'Chat completions failed (500): Internal Server Error'), second.deps);
  assert.equal(getJob(job.id).enabled, 1);
  assert.equal(getJob(job.id).consecutive_errors, 2);
  assert.equal(alerts.length, 1);
  assert.equal(getDispatchBacklogCount(job.id), 0);
});

test('delivery validation rolls back transient retry, occurrence and counter together', async () => {
  const job = updateJob(fixture().id, { delivery_mode: 'announce', delivery_to: 'not-an-id' });
  const run = createRun(job.id);
  const { deps, ctx } = setup(job, run);
  await assert.rejects(finalizeDispatch(job, ctx, result('error', 'Chat completions failed (500): Internal Server Error'), deps), /requires both channel and target/);
  assert.equal(getRun(run.id).status, 'running');
  assert.equal(getRun(run.id).retry_count, 0);
  assert.equal(getJob(job.id).last_run_at, null);
  assert.equal(getJob(job.id).consecutive_errors, 0);
  assert.equal(getJob(job.id).enabled, 1);
  assert.equal(getDispatchBacklogCount(job.id), 0);
});
