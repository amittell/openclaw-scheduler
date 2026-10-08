import './isolate-environment.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob, getJob, pruneOrphanedDeliveryWatchers } from '../jobs.js';
import { enqueueDispatch } from '../dispatch-queue.js';
import { createRun, finishRun } from '../runs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'scheduler-ttl-watcher-reaper-'));
const stateDir = join(tmpRoot, 'dispatch');
const labelsPath = join(stateDir, 'labels.json');
const dbPath = join(tmpRoot, 'test.db');

function setLabels(labels) {
  writeFileSync(labelsPath, JSON.stringify(labels) + '\n', 'utf8');
}

function makeWatcherJob(name, overrides = {}) {
  return createJob({
    name,
    schedule_kind: 'cron',
    schedule_cron: '* * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'announce-always',
    delivery_channel: 'telegram',
    delivery_to: '-12345',
    overlap_policy: 'skip',
    run_timeout_ms: 120_000,
    delete_after_run: 1,
    ttl_hours: 48,
    origin: 'system',
    ...overrides,
  });
}

// Age the job past its ttl_hours window. The reaper ages on the immutable
// created_at (not last_run_at), so this sets created_at.
function ageWatcherJob(jobId, hoursAgo = 49) {
  getDb().prepare(`
    UPDATE jobs
    SET created_at = datetime('now', '-' || ? || ' hours')
    WHERE id = ?
  `).run(hoursAgo, jobId);
}

before(async () => {
  mkdirSync(stateDir, { recursive: true });
  process.env.DISPATCH_STATE_DIR = stateDir;
  process.env.DISPATCH_LABELS_PATH = labelsPath;
  setDbPath(dbPath);
  await initDb();
});

after(() => {
  closeDb();
  delete process.env.DISPATCH_STATE_DIR;
  delete process.env.DISPATCH_LABELS_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('enabled dispatch-deliver watcher past TTL with terminal parent label is reaped', () => {
  setLabels({ '830-acceptance-run': { status: 'done', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:830-acceptance-run');
  ageWatcherJob(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined, 'watcher job should be deleted');
});

test('enabled dispatch-deliver watcher past TTL with in-flight run is NOT reaped', () => {
  setLabels({ 'inflight-label': { status: 'done', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:inflight-label');
  ageWatcherJob(job.id);
  const running = createRun(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while a run is in flight');

  finishRun(running.id, 'cancelled', { summary: 'cleanup' });
  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('enabled dispatch-deliver watcher past TTL whose label is still running is NOT reaped', () => {
  setLabels({ 'still-running': { status: 'running', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:still-running');
  ageWatcherJob(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while the watched label is non-terminal');

  setLabels({ 'still-running': { status: 'interrupted', updatedAt: new Date().toISOString() } });
  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('non-dispatch-deliver jobs are unaffected by the watcher reaper', () => {
  setLabels({});
  const plain = createJob({
    name: 'regular-ttl-job',
    schedule_kind: 'cron',
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 30_000,
    origin: 'system',
    ttl_hours: 48,
  });
  ageWatcherJob(plain.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 0);
  assert.equal(getJob(plain.id).id, plain.id, 'plain ttl job must not be touched');

  const otherWatcher = makeWatcherJob('dispatch-deliver:unknown-label');
  ageWatcherJob(otherWatcher.id);
  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(otherWatcher.id), undefined, 'watcher whose label is absent from the ledger is terminal');
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(plain.id);
});

test('watcher with a handoff suffix resolves to its base label', () => {
  setLabels({ 'handoff-label': { status: 'error', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob(`dispatch-deliver:handoff-label:handoff:${Date.now()}`);
  ageWatcherJob(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('watcher with a pending queue row is NOT reaped', () => {
  setLabels({ 'queued-label': { status: 'done', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:queued-label');
  ageWatcherJob(job.id);
  const dispatch = enqueueDispatch(job.id, { kind: 'manual' });

  assert.equal(pruneOrphanedDeliveryWatchers(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while a dispatch is queued');

  getDb().prepare("UPDATE job_dispatch_queue SET status = 'done' WHERE id = ?").run(dispatch.id);
  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('full :handoff:<digits> suffix is preferred when it exists as a ledger key', () => {
  // A user label that literally ends in ":handoff:123" produces the job name
  // dispatch-deliver:foo:handoff:123. The full key is still running, so the
  // watcher must survive even though the stripped base "foo" is absent from
  // the ledger (the old suffix-stripping bug would have watched "foo").
  setLabels({ 'foo:handoff:123': { status: 'running', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:foo:handoff:123');
  ageWatcherJob(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 0);
  assert.equal(getJob(job.id).id, job.id, 'watcher must survive while the full-suffix label is running');

  setLabels({ 'foo:handoff:123': { status: 'done', updatedAt: new Date().toISOString() } });
  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined, 'watcher is reaped once the full-suffix label is terminal');
});

test('aging is based on created_at, not last_run_at', () => {
  // A watcher that keeps ticking every minute has a fresh last_run_at. The
  // reaper must age on the immutable created_at so such a watcher is reaped
  // once created_at is past TTL, even though last_run_at is recent.
  setLabels({ 'tick-label': { status: 'done', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:tick-label');
  getDb().prepare(`
    UPDATE jobs
    SET created_at = datetime('now', '-49 hours'),
        last_run_at = datetime('now', '-1 minute'),
        last_status = 'ok'
    WHERE id = ?
  `).run(job.id);

  assert.equal(pruneOrphanedDeliveryWatchers(), 1);
  assert.equal(getJob(job.id), undefined, 'ticking watcher is reaped once created_at is past TTL');
});

test('enqueue race: a queue row committed by another dispatcher is re-checked inside the delete transaction', () => {
  setLabels({ 'race-label': { status: 'done', updatedAt: new Date().toISOString() } });
  const job = makeWatcherJob('dispatch-deliver:race-label');
  ageWatcherJob(job.id);

  // Simulate a concurrent dispatcher committing a durable pending queue row
  // on a separate connection (its own write transaction) before the reaper's
  // delete transaction. The guard re-check inside the reaper's immediate
  // transaction must see it, defer the delete, and leave the queue row intact.
  const racer = new Database(dbPath);
  const queueId = `race-dispatch-${job.id}`;
  try {
    racer.prepare(`
      INSERT INTO job_dispatch_queue
        (id, job_id, dispatch_kind, status, scheduled_for, binding_scheduled_for, created_at)
      VALUES (?, ?, 'manual', 'pending', datetime('now'), datetime('now'), datetime('now'))
    `).run(queueId, job.id);
    assert.equal(pruneOrphanedDeliveryWatchers(), 0);
    assert.equal(getJob(job.id).id, job.id, 'job must survive a racing enqueue');
    const row = racer.prepare('SELECT status FROM job_dispatch_queue WHERE id = ?').get(queueId);
    assert.equal(row.status, 'pending', 'racing queue row must not be cascade-deleted');
  } finally {
    racer.close();
  }
});

test('relative DISPATCH_LABELS_PATH is resolved beneath DISPATCH_STATE_DIR', () => {
  // A relative override must resolve under stateDir (via the dispatch path
  // resolver), not against the process cwd. The ledger at the resolved
  // location holds a terminal label, so correct resolution reaps the watcher;
  // a wrong cwd-relative resolution would miss the file and fail safe (no reap).
  const relDir = join(stateDir, 'rel');
  mkdirSync(relDir, { recursive: true });
  writeFileSync(
    join(relDir, 'labels.json'),
    JSON.stringify({ 'rel-label': { status: 'done', updatedAt: new Date().toISOString() } }) + '\n',
    'utf8',
  );

  const savedLabels = process.env.DISPATCH_LABELS_PATH;
  process.env.DISPATCH_LABELS_PATH = 'rel/labels.json';
  try {
    const job = makeWatcherJob('dispatch-deliver:rel-label');
    ageWatcherJob(job.id);
    assert.equal(pruneOrphanedDeliveryWatchers(), 1);
    assert.equal(getJob(job.id), undefined, 'relative override must resolve beneath stateDir');
  } finally {
    process.env.DISPATCH_LABELS_PATH = savedLabels;
  }
});

test('index.d.ts declares pruneOrphanedDeliveryWatchers on the jobs namespace', () => {
  const dts = readFileSync(join(__dirname, '..', 'index.d.ts'), 'utf8');
  assert.match(dts, /pruneOrphanedDeliveryWatchers\(\): number;/, 'jobs namespace must declare the new export');
});
