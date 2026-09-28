import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob, getJob, pruneOrphanedDeliveryWatchers } from '../jobs.js';
import { enqueueDispatch } from '../dispatch-queue.js';
import { createRun, finishRun } from '../runs.js';

const stateDir = mkdtempSync(join(tmpdir(), 'scheduler-ttl-watcher-reaper-'));
const labelsPath = join(stateDir, 'labels.json');

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

function ageWatcherJob(jobId, hoursAgo = 49) {
  getDb().prepare(`
    UPDATE jobs
    SET last_run_at = datetime('now', '-' || ? || ' hours'), last_status = 'ok'
    WHERE id = ?
  `).run(hoursAgo, jobId);
}

before(async () => {
  process.env.DISPATCH_STATE_DIR = stateDir;
  process.env.DISPATCH_LABELS_PATH = labelsPath;
  setDbPath(':memory:');
  await initDb();
});

after(() => {
  closeDb();
  delete process.env.DISPATCH_STATE_DIR;
  delete process.env.DISPATCH_LABELS_PATH;
  rmSync(stateDir, { recursive: true, force: true });
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
  deleteJobCleanup(plain.id);
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

function deleteJobCleanup(jobId) {
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
}
