// Daily-job reliability: delivery route normalization (Bug A) and
// transient-LLM retry + failure alerting (Bug B) for isolated agent-turn jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setDbPath, initDb, closeDb, getDb } from '../db.js';
import { createJob, getJob, getDispatchBacklogCount, canEnqueueDispatch, scheduleRetry } from '../jobs.js';
import { createRun, getRun } from '../runs.js';
import { enqueueDispatch, setDispatchStatus } from '../dispatch-queue.js';
import { updateJob } from '../jobs.js';
import { commitCompletionBookkeeping } from '../run-completion.js';
import { createDeliveryHelpers } from '../dispatcher-delivery.js';
import { finalizeDispatch } from '../dispatcher-strategies.js';
import { applySessionOverridesToSessionStore, prepareAgentSelection } from '../gateway.js';

const tempDir = mkdtempSync(join(tmpdir(), 'sched-daily-reliability-'));

function teardown() {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
}
test.after(teardown);

// Hooks cannot be skipped by --test-name-pattern: every selected fixture test
// must initialize its own database before it can create an enabled job.
test.before(async () => {
  setDbPath(join(tempDir, 'scheduler.db'));
  await initDb();
});

// ---------------------------------------------------------------------------
// Bug A: delivery route normalization
// ---------------------------------------------------------------------------

function makeHandleDelivery(jobOverrides = {}, { alias, delivered, errors, infos } = {}) {
  delivered ||= [];
  errors ||= [];
  infos ||= [];
  const { handleDelivery } = createDeliveryHelpers({
    log: (level, msg, meta) => {
      if (level === 'error') errors.push({ msg, meta });
      if (level === 'info') infos.push({ msg, meta });
    },
    resolveDeliveryAlias: () => alias || null,
    enqueueDeliveryFn: (entry) => delivered.push(entry) && {
      id: `del-${delivered.length}`,
      deduped: false,
      attachments: [],
      partCount: 1,
    },
  });
  const job = {
    id: 'job-daily',
    name: 'Daily Job',
    delivery_mode: 'announce',
    delivery_channel: null,
    delivery_to: '12345',
    ...jobOverrides,
  };
  return { job, handleDelivery, delivered, errors, infos };
}

test('bare numeric delivery_to with null channel resolves to telegram', () => {
  const { job, handleDelivery, delivered, errors } = makeHandleDelivery({
    delivery_channel: null,
    delivery_to: '-5268075089',
  });
  const delivery = handleDelivery(job, 'status summary body', { runId: 'run-1' });
  assert.ok(delivery, 'delivery enqueued');
  assert.equal(errors.length, 0, 'no hard failure');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'telegram');
  assert.equal(delivered[0].target, '-5268075089');
  assert.equal(delivered[0].body, 'status summary body');
  assert.equal(delivered[0].jobId, 'job-daily');
  assert.equal(delivered[0].runId, 'run-1');
});

test('bare positive numeric delivery_to with null channel resolves to telegram', () => {
  const { job, handleDelivery, delivered, errors } = makeHandleDelivery({
    delivery_channel: '',
    delivery_to: '484946046',
  });
  handleDelivery(job, 'dm body', { runId: 'run-2' });
  assert.equal(errors.length, 0, 'no hard failure');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'telegram');
  assert.equal(delivered[0].target, '484946046');
});

test('bare numeric inference trims only surrounding whitespace', () => {
  const { job, handleDelivery, delivered } = makeHandleDelivery({ delivery_to: '  -5268075089  ' });
  handleDelivery(job, 'body');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'telegram');
  assert.equal(delivered[0].target, '-5268075089');
});

for (const target of ['123 456', '123\t456', '123\n456', '+12345']) {
  test(`bare numeric inference rejects malformed target ${JSON.stringify(target)}`, () => {
    const { job, handleDelivery, delivered, infos } = makeHandleDelivery({ delivery_to: target });
    assert.throws(() => handleDelivery(job, 'body'), /Delivery route for 'Daily Job' requires both channel and target/);
    assert.equal(delivered.length, 0, 'invalid inferred route never reaches the outbox');
    assert.equal(infos.some(entry => entry.msg.includes('auto-resolved')), false);
  });
}

test('explicit channel is preserved (no override)', () => {
  const { job, handleDelivery, delivered } = makeHandleDelivery({
    delivery_channel: 'telegram',
    delivery_to: '12345',
  });
  handleDelivery(job, 'body', { runId: 'run-3' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'telegram');
  assert.equal(delivered[0].target, '12345');
});

test('prefixed target without channel resolves its own channel', () => {
  const { job, handleDelivery, delivered } = makeHandleDelivery({
    delivery_channel: null,
    delivery_to: 'telegram:-1003892419349',
  });
  handleDelivery(job, 'body', { runId: 'run-4' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'telegram');
  assert.equal(delivered[0].target, '-1003892419349');
});

test('genuinely bad route still hard-fails with job name in log and error', () => {
  const bad = [
    { delivery_channel: null, delivery_to: 'not-a-number' },
    { delivery_channel: null, delivery_to: '@some_alias_but_resolver_off' },
    { delivery_channel: 'telegram', delivery_to: null },
  ];
  for (const overrides of bad) {
    const { job, handleDelivery, delivered, errors } = makeHandleDelivery(overrides);
    assert.throws(
      () => handleDelivery(job, 'body', { runId: 'run-bad' }),
      (err) => err.message.includes('Delivery route') && err.message.includes(job.name),
      `route ${JSON.stringify(overrides)} must throw with job name`,
    );
    assert.equal(delivered.length, 0, 'nothing enqueued for bad route');
    assert.ok(
      errors.some(e => e.msg.includes('Delivery route is incomplete') && e.msg.includes(job.name)),
      'error log carries the job name',
    );
  }
});

test('fully unrouted announce job (no channel, no target) is a no-op, not a hard failure', () => {
  const { job, handleDelivery, delivered, errors } = makeHandleDelivery({
    delivery_channel: null,
    delivery_to: null,
  });
  const result = handleDelivery(job, 'body', { runId: 'run-none' });
  assert.equal(result, null, 'returns null like the pre-existing no-route path');
  assert.equal(delivered.length, 0);
  assert.equal(errors.length, 0, 'no error logged');
});

test('alias resolution still wins over bare-numeric inference', () => {
  const { job, handleDelivery, delivered } = makeHandleDelivery({
    delivery_channel: null,
    delivery_to: 'ops_room',
  }, { alias: { channel: 'discord', target: 'guild-9' } });
  handleDelivery(job, 'body', { runId: 'run-alias' });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'discord');
  assert.equal(delivered[0].target, 'guild-9');
});

// ---------------------------------------------------------------------------
// Bug A: model-only preparation needs no retired session store
// ---------------------------------------------------------------------------

test('retired local override reports failure; model-only preparation needs no legacy store', async () => {
  const retired = applySessionOverridesToSessionStore('scheduler:daily-job-reliability-never-created', {
    authProfile: 'vendor:work', modelRef: 'vendor/model',
  }, 'main');
  assert.equal(retired.ok, false);
  assert.match(retired.error, /retired/);
  const prepared = await prepareAgentSelection('scheduler:daily-job-reliability-never-created', { modelRef: 'vendor/model' });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.applied, false);
});

// ---------------------------------------------------------------------------
// Bug B: transient-LLM retry + failure alert for isolated agent-turn jobs
// ---------------------------------------------------------------------------

function makeDeps({ alerts, deliveries, jobState, retryDisabled }) {
  return {
    finishRun: (runId, status, fields) => {
      getDb().prepare('UPDATE runs SET status = ?, summary = ?, error_message = ? WHERE id = ?')
        .run(status, fields?.summary ?? null, fields?.error_message ?? null, runId);
      const run = getRun(runId);
      return { changed: true, run, status, cancelled: false, fenced: false };
    },
    transitionRunTerminal: null,
    completeRunFenced: null,
    commitCompletionBookkeeping,
    shouldRunPostCompletionEffects: (completion) => completion.changed && !completion.cancelled,
    updateIdempotencyResultHash: () => {},
    releaseIdempotencyKey: () => {},
    setAgentStatus: () => {},
    handleDelivery: () => { deliveries.push('delivery'); return { id: 'del-x', deduped: false, partCount: 1 }; },
    shouldRetry: () => false,
    scheduleRetry,
    getDb,
    updateJobAfterRun: (jobArg, status) => {
      jobState.errors = (jobState.errors || 0) + (status === 'error' ? 1 : 0);
      updateJob(jobArg.id, {
        last_status: status,
        consecutive_errors: jobState.errors,
      });
    },
    updateJob,
    setDispatchStatus,
    handleTriggeredChildren: () => {},
    dequeueJob: () => false,
    sqliteNow: (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    log: () => {},
    getJob,
    enqueueDispatch,
    canEnqueueDispatch,
    getDispatchBacklogCount,
    alertTransitFailure: retryDisabled ? undefined : (payload) => { alerts.push(payload); },
    clearMaterializedEnvironment: () => {},
  };
}

function makeIsolatedJob(name, overrides = {}) {
  return createJob({
    name,
    schedule_cron: '0 7 * * *',
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'do the daily work',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    ...overrides,
  });
}

async function finishError(job, errorMessage, { alerts, deliveries, jobState } = {}) {
  alerts ||= [];
  deliveries ||= [];
  jobState ||= { errors: 1 };
  const run = createRun(job.id);
  const ctx = {
    run,
    idemKey: null,
    dispatchRecord: null,
    v02Outcomes: null,
    v4Artifact: null,
  };
  let transientRetry = null;
  const deps = makeDeps({ alerts, deliveries, jobState });
  const origUpdateJobAfterRun = deps.updateJobAfterRun;
  deps.updateJobAfterRun = (jobArg, status) => { origUpdateJobAfterRun(jobArg, status); };
  const origCommit = deps.commitCompletionBookkeeping;
  deps.commitCompletionBookkeeping = (db, callback) => {
    const outcome = origCommit(db, callback);
    if (outcome?.transientRetry) transientRetry = outcome.transientRetry;
    return outcome;
  };
  await finalizeDispatch(job, ctx, {
    status: 'error',
    summary: errorMessage,
    content: errorMessage,
    errorMessage,
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: false,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: false,
    skipAgentCleanup: false,
    idemAction: 'release',
    retryFiresChildren: false,
    earlyReturn: false,
  }, deps);
  await new Promise(r => setTimeout(r, 50)); // let fire-and-forget alert flush
  return { run, alerts, deliveries, jobState, transientRetry };
}

test('transient 5xx failure on isolated agent-turn job retries once after ~5min, no alert', async () => {
  const job = makeIsolatedJob('Daily: Transient 5xx', {
    delivery_channel: 'telegram',
    delivery_to: '484946046',
  });
  const { run, alerts, deliveries, transientRetry } = await finishError(
    job,
    'Chat completions failed (500): Internal Server Error',
    {},
  );
  assert.ok(transientRetry, 'transient retry was scheduled');
  assert.equal(transientRetry.delaySec, 300, '~5 minute delay');
  const dispatches = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE job_id = ? AND dispatch_kind = ?',
  ).all(job.id, 'retry');
  assert.equal(dispatches.length, 1, 'exactly one retry dispatch enqueued');
  const delaySec = (new Date(dispatches[0].scheduled_for.replace(' ', 'T') + 'Z').getTime()
    - Date.now()) / 1000;
  assert.ok(delaySec > 240 && delaySec <= 360, `retry delay ~5min, got ${Math.round(delaySec)}s`);
  assert.equal(getRun(run.id).retry_count, 1, 'run marked as having a retry pending');
  assert.equal(alerts.length, 0, 'no alert after first failure');
  // job has delivery_mode 'none' so no soft-failure announcement is expected
  assert.equal(deliveries.length, 0, 'no delivery for delivery_mode none job');
});

test('second consecutive transient failure records job error and fires alert', async () => {
  const job = makeIsolatedJob('Daily: Second Failure', {
    delivery_channel: 'telegram',
    delivery_to: '484946046',
  });
  // First failure: transient retry scheduled, consecutive_errors = 1
  const first = await finishError(job, 'Chat completions failed (500): Internal Server Error', {});
  assert.ok(first.transientRetry, 'first failure schedules the one-and-only retry');
  // Second failure (the retry run): consecutive_errors was 1 before this failure, so updateJobAfterRun sets it to 2
  const second = await finishError(
    job,
    'Session idle for 240s -- aborted (activity-based timeout)',
    { jobState: { errors: 1 } },
  );
  const { alerts, jobState } = second;
  assert.equal(jobState.errors, 2, 'second failure recorded on the job');
  const fresh = getJob(job.id);
  assert.equal(fresh.consecutive_errors, 2);
  assert.equal(alerts.length, 1, 'alert fired after 2 consecutive failures');
  assert.equal(alerts[0].jobName, 'Daily: Second Failure');
  assert.equal(alerts[0].consecutiveErrors, 2);
  assert.match(alerts[0].errorMessage, /Session idle for 240s/);
});

test('non-transient error does not schedule retry or alert', async () => {
  const job = makeIsolatedJob('Daily: Config Error', {
    delivery_channel: 'telegram',
    delivery_to: '484946046',
  });
  await finishError(job, "agent_id must match the pattern", {});
  const retryDispatches = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE job_id = ? AND dispatch_kind = ?',
  ).all(job.id, 'retry');
  assert.equal(retryDispatches.length, 0, 'no retry for config/validation errors');
});

test('shell jobs are exempt from transient retry', async () => {
  const job = createJob({
    name: 'Daily: Shell 5xx',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'curl localhost:0 && echo done',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  const run = createRun(job.id);
  const ctx = { run, idemKey: null, dispatchRecord: null, v02Outcomes: null, v4Artifact: null };
  const alerts = [];
  await finalizeDispatch(job, ctx, {
    status: 'error',
    summary: 'Shell failed with Internal Server Error from upstream',
    content: 'Shell failed with Internal Server Error from upstream',
    errorMessage: 'Internal Server Error',
    runFinishFields: { shell_exit_code: 1 },
    deliveryOverride: null,
    skipDelivery: true,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: false,
    skipAgentCleanup: true,
    idemAction: 'release',
    retryFiresChildren: false,
    earlyReturn: false,
  }, makeDeps({ alerts, jobState: { errors: 1 } }));
  const retryDispatches = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE job_id = ? AND dispatch_kind = ?',
  ).all(job.id, 'retry');
  assert.equal(retryDispatches.length, 0, 'shell jobs never get transient retry');
});

test('retry is not scheduled when the dispatch backlog limit is reached', async () => {
  const job = makeIsolatedJob('Daily: Backlog Full', {
    delivery_channel: 'telegram',
    delivery_to: '484946046',
    max_queued_dispatches: 1,
  });
  // Pre-fill the backlog so canEnqueueDispatch fails
  enqueueDispatch(job.id, { kind: 'retry', scheduled_for: '2027-01-01 00:00:00' });
  assert.ok(getDispatchBacklogCount(job.id) >= 1, 'backlog non-empty');
  const run = createRun(job.id);
  const ctx = { run, idemKey: null, dispatchRecord: null, v02Outcomes: null, v4Artifact: null };
  const alerts = [];
  let transientRetry = null;
  const deps = makeDeps({ alerts, jobState: { errors: 1 } });
  const origCommit = deps.commitCompletionBookkeeping;
  deps.commitCompletionBookkeeping = (db, callback) => {
    const outcome = origCommit(db, callback);
    if (outcome?.transientRetry) transientRetry = outcome.transientRetry;
    return outcome;
  };
  await finalizeDispatch(job, ctx, {
    status: 'error',
    summary: 'Chat completions failed (500): Internal Server Error',
    content: 'Chat completions failed (500): Internal Server Error',
    errorMessage: 'Chat completions failed (500): Internal Server Error',
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: true,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: false,
    skipAgentCleanup: false,
    idemAction: 'release',
    retryFiresChildren: false,
    earlyReturn: false,
  }, deps);
  assert.equal(transientRetry, null, 'backlog limit suppresses the transient retry');
  const retryDispatches = getDb().prepare(
    'SELECT * FROM job_dispatch_queue WHERE job_id = ? AND dispatch_kind = ?',
  ).all(job.id, 'retry');
  assert.equal(retryDispatches.length, 1, 'only the pre-existing backlog row; no new retry');
});
