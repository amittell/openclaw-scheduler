import './isolate-environment.mjs';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob } from '../jobs.js';
import {
  DEFAULT_DISPATCH_PRUNE_BATCH_SIZE,
  DEFAULT_DISPATCH_RETENTION_DAYS,
  TERMINAL_DISPATCH_STATUSES,
  pruneTerminalDispatches,
} from '../dispatch-queue.js';
import { DISPATCH_PRUNE_MAX_BATCHES, pruneDispatchQueueHistory } from '../dispatcher-maintenance.js';
import { DISPATCHER_INTEGER_SETTINGS, loadDispatcherRuntimeConfig } from '../runtime-config.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'scheduler-dispatch-retention-'));
let job;

before(async () => {
  setDbPath(join(tmpRoot, 'retention.db'));
  await initDb();
});

after(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM approvals; DELETE FROM runs; DELETE FROM job_dispatch_queue; DELETE FROM jobs;');
  job = createJob({
    name: 'retention probe',
    schedule_cron: '*/2 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    origin: 'system',
  });
});

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function insertDispatch(id, {
  status = 'done',
  kind = 'manual',
  createdDaysAgo = 30,
  processedDaysAgo = createdDaysAgo,
  scheduledFor = daysAgo(createdDaysAgo),
  digest = null,
} = {}) {
  getDb().prepare(`
    INSERT INTO job_dispatch_queue (
      id, job_id, dispatch_kind, status, scheduled_for, binding_scheduled_for,
      created_at, processed_at, handoff_artifact_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, job.id, kind, status, scheduledFor, scheduledFor,
    daysAgo(createdDaysAgo),
    processedDaysAgo == null ? null : daysAgo(processedDaysAgo),
    digest,
  );
}

function insertRun(id, dispatchId, status) {
  getDb().prepare(`
    INSERT INTO runs (id, job_id, status, started_at, dispatch_queue_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, job.id, status, daysAgo(30), dispatchId);
}

function insertApproval(id, dispatchId, status) {
  getDb().prepare(`
    INSERT INTO approvals (id, job_id, dispatch_queue_id, status, requested_at, binding_hash)
    VALUES (?, ?, ?, ?, ?, 'test-binding')
  `).run(id, job.id, dispatchId, status, daysAgo(30));
}

function remainingIds() {
  return getDb().prepare('SELECT id FROM job_dispatch_queue ORDER BY id').all().map(row => row.id);
}

test('terminal statuses and defaults are the documented ones', () => {
  assert.deepEqual([...TERMINAL_DISPATCH_STATUSES].sort(), ['cancelled', 'done', 'failed']);
  assert.equal(DEFAULT_DISPATCH_RETENTION_DAYS, 14);
  assert.equal(DISPATCHER_INTEGER_SETTINGS.dispatchRetentionDays.envName, 'SCHEDULER_DISPATCH_RETENTION_DAYS');
  assert.equal(loadDispatcherRuntimeConfig({}).dispatchRetentionDays, DEFAULT_DISPATCH_RETENTION_DAYS);
  assert.equal(
    loadDispatcherRuntimeConfig({ SCHEDULER_DISPATCH_RETENTION_DAYS: '30' }).dispatchRetentionDays,
    30,
  );
});

test('prune deletes old terminal rows and keeps every protected row', () => {
  // Deleted: old terminal rows, including one never processed (created_at
  // fallback), one whose only run finished, one whose approval was dispatched.
  insertDispatch('del-done', { status: 'done' });
  insertDispatch('del-failed', { status: 'failed' });
  insertDispatch('del-cancelled', { status: 'cancelled' });
  insertDispatch('del-never-processed', { status: 'cancelled', processedDaysAgo: null });
  insertDispatch('del-finished-run', { status: 'done' });
  insertRun('run-finished', 'del-finished-run', 'ok');
  insertDispatch('del-dispatched-approval', { status: 'done' });
  insertApproval('approval-dispatched', 'del-dispatched-approval', 'dispatched');

  // Kept: active rows, however old.
  insertDispatch('keep-pending', { status: 'pending', processedDaysAgo: null });
  insertDispatch('keep-claimed', { status: 'claimed', processedDaysAgo: null });
  insertDispatch('keep-awaiting', { status: 'awaiting_approval', processedDaysAgo: null });
  // Kept: terminal but inside the window (processed_at wins over created_at).
  insertDispatch('keep-recent', { status: 'done', createdDaysAgo: 30, processedDaysAgo: 2 });
  insertDispatch('keep-recent-created', { status: 'cancelled', createdDaysAgo: 2, processedDaysAgo: null });
  // Kept: handoff v4 bound (pruneRuns protects source runs through it).
  insertDispatch('keep-v4', { status: 'done', digest: `sha256:${'a'.repeat(64)}` });
  // Kept: referenced by an unfinished or recovery-blocked run.
  insertDispatch('keep-running-run', { status: 'done' });
  insertRun('run-running', 'keep-running-run', 'running');
  insertDispatch('keep-blocked-run', { status: 'failed' });
  insertRun('run-blocked', 'keep-blocked-run', 'recovery_blocked');
  // Kept: referenced by an active approval.
  insertDispatch('keep-pending-approval', { status: 'cancelled' });
  insertApproval('approval-pending', 'keep-pending-approval', 'pending');
  insertDispatch('keep-dispatching-approval', { status: 'done' });
  insertApproval('approval-dispatching', 'keep-dispatching-approval', 'dispatching');
  insertDispatch('keep-approved-approval', { status: 'cancelled' });
  insertApproval('approval-approved', 'keep-approved-approval', 'approved');
  // Kept: the scheduled occurrence the job is still due on.
  const dueSlot = daysAgo(20);
  insertDispatch('keep-due-slot', { status: 'done', kind: 'schedule', scheduledFor: dueSlot });
  getDb().prepare('UPDATE jobs SET next_run_at = ? WHERE id = ?').run(dueSlot, job.id);

  const result = pruneTerminalDispatches();
  assert.equal(result.pruned, 6);
  assert.deepEqual(remainingIds(), [
    'keep-approved-approval', 'keep-awaiting', 'keep-blocked-run', 'keep-claimed',
    'keep-dispatching-approval', 'keep-due-slot', 'keep-pending', 'keep-pending-approval',
    'keep-recent', 'keep-recent-created', 'keep-running-run', 'keep-v4',
  ]);
  const db = getDb();
  assert.equal(db.prepare("SELECT dispatch_queue_id FROM runs WHERE id = 'run-finished'").get().dispatch_queue_id, null);
  assert.equal(
    db.prepare("SELECT dispatch_queue_id FROM approvals WHERE id = 'approval-dispatched'").get().dispatch_queue_id,
    null,
  );
  assert.equal(db.prepare("SELECT dispatch_queue_id FROM runs WHERE id = 'run-running'").get().dispatch_queue_id, 'keep-running-run');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(pruneTerminalDispatches().pruned, 0, 'a second pass finds nothing more');
});

test('retentionDays and before move the cutoff', () => {
  insertDispatch('ten-days', { status: 'done', createdDaysAgo: 10 });
  insertDispatch('twenty-days', { status: 'done', createdDaysAgo: 20 });
  assert.equal(pruneTerminalDispatches({ retentionDays: 30 }).pruned, 0);
  assert.equal(pruneTerminalDispatches().pruned, 1);
  assert.deepEqual(remainingIds(), ['ten-days']);
  assert.equal(pruneTerminalDispatches({ before: Date.now() - 5 * 24 * 60 * 60 * 1000 }).pruned, 1);
  assert.throws(() => pruneTerminalDispatches({ retentionDays: 0 }), /retentionDays must be a positive integer/);
  assert.throws(() => pruneTerminalDispatches({ limit: 1.5 }), /limit must be a positive integer/);
});

test('one batch deletes at most limit rows and the search stays on an index', () => {
  for (let index = 0; index < 7; index++) insertDispatch(`old-${index}`, { status: 'done' });
  assert.equal(pruneTerminalDispatches({ limit: 3 }).pruned, 3);
  assert.equal(remainingIds().length, 4);

  const db = getDb();
  const seen = [];
  const original = db.prepare;
  db.prepare = function prepare(sql) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try {
    pruneTerminalDispatches({ limit: 1 });
  } finally {
    delete db.prepare;
  }
  const selectSql = seen.find(sql => /FROM job_dispatch_queue AS q/.test(sql));
  assert.ok(selectSql, 'the candidate select was prepared');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${selectSql}`)
    .all({ cutoff: daysAgo(14), limit: 1 })
    .map(row => row.detail);
  assert.ok(
    plan.some(detail => /SEARCH q USING INDEX idx_dispatch_queue_due \(status=\? AND scheduled_for<\?\)/.test(detail)),
    `candidate search must use idx_dispatch_queue_due: ${plan.join(' | ')}`,
  );
  assert.equal(plan.some(detail => /^SCAN /.test(detail)), false, `no full scan: ${plan.join(' | ')}`);
  for (const expected of [
    /UPDATE runs SET dispatch_queue_id = NULL WHERE dispatch_queue_id IN \(\?\)/,
    /UPDATE approvals SET dispatch_queue_id = NULL WHERE dispatch_queue_id IN \(\?\)/,
    /DELETE FROM job_dispatch_queue WHERE id IN \(\?\)/,
  ]) {
    assert.ok(seen.some(sql => expected.test(sql)), `expected statement ${expected} was prepared`);
  }
  const deleteSql = seen.find(sql => /DELETE FROM job_dispatch_queue/.test(sql));
  const deletePlan = db.prepare(`EXPLAIN QUERY PLAN ${deleteSql}`)
    .all('probe')
    .map(row => row.detail);
  assert.equal(deletePlan.some(detail => /^SCAN /.test(detail)), false, `no full scan: ${deletePlan.join(' | ')}`);
});

test('the cursor predicate keeps the candidate search on the due index', () => {
  for (let index = 0; index < 4; index++) insertDispatch(`plan-${index}`, { status: 'done' });
  const db = getDb();
  const seen = [];
  const original = db.prepare;
  db.prepare = function prepare(sql) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try {
    pruneTerminalDispatches({ limit: 2, afterScheduledFor: daysAgo(20), afterRowid: 1 });
  } finally {
    delete db.prepare;
  }
  const selectSql = seen.find(sql => /FROM job_dispatch_queue AS q/.test(sql));
  assert.ok(selectSql, 'the cursor candidate select was prepared');
  assert.ok(/q\.rowid > @afterRowid/.test(selectSql), 'the cursor predicate is present in the statement');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${selectSql}`)
    .all({ cutoff: daysAgo(14), limit: 2, afterScheduledFor: daysAgo(20), afterRowid: 1 })
    .map(row => row.detail);
  assert.ok(
    plan.some(detail => /SEARCH q USING INDEX idx_dispatch_queue_due/.test(detail)),
    `candidate search must use idx_dispatch_queue_due: ${plan.join(' | ')}`,
  );
  assert.equal(plan.some(detail => /^SCAN (q|job_dispatch_queue)\b/.test(detail)), false, `no full scan: ${plan.join(' | ')}`);
});

test('a pass advances its cursor past examined rows that share one scheduled_for', () => {
  for (let index = 0; index < 7; index++) insertDispatch(`cur-${String(index).padStart(2, '0')}`, { status: 'done' });
  const first = pruneTerminalDispatches({ limit: 3 });
  assert.equal(first.pruned, 3);
  assert.ok(typeof first.afterScheduledFor === 'string' && Number.isSafeInteger(first.afterRowid), 'a pass returns its cursor');
  const second = pruneTerminalDispatches({ limit: 3, afterScheduledFor: first.afterScheduledFor, afterRowid: first.afterRowid });
  assert.equal(second.pruned, 3);
  assert.deepEqual(remainingIds(), ['cur-06']);
  const third = pruneTerminalDispatches({ limit: 3, afterScheduledFor: second.afterScheduledFor, afterRowid: second.afterRowid });
  assert.equal(third.pruned, 1);
  assert.deepEqual(remainingIds(), []);
  assert.throws(
    () => pruneTerminalDispatches({ afterScheduledFor: daysAgo(20) }),
    /afterScheduledFor and afterRowid must be set together/,
  );
});

test('an at-occurrence is pruned only once it is no longer outstanding', () => {
  const makeAtJob = (name, slot) => createJob({
    name,
    schedule_kind: 'at',
    schedule_at: slot,
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    origin: 'system',
  });
  const completedSlot = daysAgo(20);
  const earlySlot = daysAgo(19);
  const outstandingSlot = daysAgo(18);
  const db = getDb();
  const completedJob = makeAtJob('at completed', completedSlot);
  const earlyJob = makeAtJob('at early', earlySlot);
  const outstandingJob = makeAtJob('at outstanding', outstandingSlot);
  // Ran after the slot: the occurrence is done and will never be due again
  // (getDueAtJobs keeps it out via last_run_at >= schedule_at).
  db.prepare(`UPDATE jobs SET last_run_at = datetime(?, '+3 hours') WHERE id = ?`).run(completedSlot, completedJob.id);
  // Ran before the slot: getDueAtJobs still considers the occurrence due, so
  // the dispatch row stays as the thing that stops re-enqueueing it.
  db.prepare(`UPDATE jobs SET last_run_at = datetime(?, '-3 hours') WHERE id = ?`).run(earlySlot, earlyJob.id);
  // OutstandingJob keeps last_run_at = NULL.
  insertDispatch('at-completed-row', { status: 'done', kind: 'at', scheduledFor: completedSlot });
  insertDispatch('at-early-row', { status: 'done', kind: 'at', scheduledFor: earlySlot });
  insertDispatch('at-outstanding-row', { status: 'done', kind: 'at', scheduledFor: outstandingSlot });
  db.prepare('UPDATE job_dispatch_queue SET job_id = ? WHERE id = ?').run(completedJob.id, 'at-completed-row');
  db.prepare('UPDATE job_dispatch_queue SET job_id = ? WHERE id = ?').run(earlyJob.id, 'at-early-row');
  db.prepare('UPDATE job_dispatch_queue SET job_id = ? WHERE id = ?').run(outstandingJob.id, 'at-outstanding-row');
  assert.equal(pruneTerminalDispatches().pruned, 1);
  assert.deepEqual(remainingIds(), ['at-early-row', 'at-outstanding-row']);
});

test('upgraded schema without ON DELETE SET NULL leaves no dangling references', () => {
  // Recreate the reference columns the way the consolidation migration adds
  // them to existing databases: plain TEXT, no REFERENCES, no ON DELETE
  // SET NULL (the partial indexes stay, as the migration creates them).
  const db = getDb();
  for (const [table, indexName] of [['runs', 'idx_runs_dispatch_queue'], ['approvals', 'idx_approvals_dispatch_queue']]) {
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN dispatch_queue_id`);
    db.exec(`ALTER TABLE ${table} ADD COLUMN dispatch_queue_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL`);
  }
  insertDispatch('upg-done', { status: 'done' });
  insertRun('upg-run', 'upg-done', 'ok');
  insertApproval('upg-approval', 'upg-done', 'dispatched');
  assert.equal(pruneTerminalDispatches().pruned, 1);
  assert.equal(remainingIds().length, 0);
  assert.equal(db.prepare("SELECT dispatch_queue_id FROM runs WHERE id = 'upg-run'").get().dispatch_queue_id, null);
  assert.equal(db.prepare("SELECT dispatch_queue_id FROM approvals WHERE id = 'upg-approval'").get().dispatch_queue_id, null);
  for (const table of ['runs', 'approvals']) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE dispatch_queue_id IS NOT NULL AND dispatch_queue_id NOT IN (SELECT id FROM job_dispatch_queue)`).get().n,
      0,
      `${table} has no dangling dispatch references`,
    );
  }
});

test('a prune pass is bounded by maxBatches, yields between batches, and logs', async () => {
  for (let index = 0; index < 25; index++) insertDispatch(`bulk-${String(index).padStart(2, '0')}`, { status: 'done' });
  insertDispatch('bulk-recent', { status: 'done', createdDaysAgo: 1 });
  const logs = [];
  let pauses = 0;
  const log = (level, message, meta) => logs.push({ level, message, meta });
  const pause = async () => { pauses += 1; };

  const first = await pruneDispatchQueueHistory({ log, batchSize: 10, maxBatches: 2, pause });
  assert.deepEqual(
    { pruned: first.pruned, batches: first.batches, more: first.more },
    { pruned: 20, batches: 2, more: true },
  );
  assert.equal(pauses, 1, 'the pass yields between batches, not before the first');
  assert.equal(remainingIds().length, 6);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'info');
  assert.equal(logs[0].message, 'Pruned 20 terminal dispatch queue row(s)');
  assert.equal(logs[0].meta.more, true);
  assert.equal(logs[0].meta.retentionDays, DEFAULT_DISPATCH_RETENTION_DAYS);

  const second = await pruneDispatchQueueHistory({ log, batchSize: 10, maxBatches: 2, pause });
  assert.deepEqual(
    { pruned: second.pruned, batches: second.batches, more: second.more },
    { pruned: 5, batches: 1, more: false },
  );
  assert.deepEqual(remainingIds(), ['bulk-recent']);

  const idle = await pruneDispatchQueueHistory({ log, batchSize: 10, maxBatches: 2, pause });
  assert.equal(idle.pruned, 0);
  assert.equal(logs.length, 2, 'a pass that prunes nothing does not log');
});

test('a prune pass stops between batches when the dispatcher stops running', async () => {
  for (let index = 0; index < 6; index++) insertDispatch(`stop-${index}`, { status: 'done' });
  let running = true;
  const result = await pruneDispatchQueueHistory({
    batchSize: 2,
    maxBatches: 10,
    pause: async () => { running = false; },
    shouldContinue: () => running,
  });
  assert.deepEqual({ pruned: result.pruned, batches: result.batches, more: result.more }, { pruned: 2, batches: 1, more: true });
  assert.equal(remainingIds().length, 4);
});

test('the default pass bound is 25 batches of 2000 rows', async () => {
  assert.equal(DEFAULT_DISPATCH_PRUNE_BATCH_SIZE, 2_000);
  assert.equal(DISPATCH_PRUNE_MAX_BATCHES, 25);
  const calls = [];
  const result = await pruneDispatchQueueHistory({
    pruneBatch: (opts) => {
      calls.push(opts);
      return { pruned: opts.limit, cutoff: 'fixed', limit: opts.limit };
    },
  });
  assert.equal(calls.length, 25);
  assert.equal(result.pruned, 50_000);
  assert.equal(result.more, true);
  assert.ok(calls.every(call => call.limit === 2_000 && call.before === calls[0].before), 'one cutoff per pass');
});
