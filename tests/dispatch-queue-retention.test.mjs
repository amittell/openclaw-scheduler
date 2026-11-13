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

test('one statement deletes at most limit rows and the search stays on an index', () => {
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
  const deleteSql = seen.find(sql => /DELETE FROM job_dispatch_queue/.test(sql));
  assert.ok(deleteSql, 'the prune statement was prepared');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${deleteSql}`)
    .all({ cutoff: daysAgo(14), limit: 1 })
    .map(row => row.detail);
  assert.ok(
    plan.some(detail => /SEARCH q USING INDEX idx_dispatch_queue_due \(status=\? AND scheduled_for<\?\)/.test(detail)),
    `candidate search must use idx_dispatch_queue_due: ${plan.join(' | ')}`,
  );
  assert.equal(plan.some(detail => /^SCAN /.test(detail)), false, `no full scan: ${plan.join(' | ')}`);
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
