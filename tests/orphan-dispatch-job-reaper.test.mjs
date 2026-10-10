import './isolate-environment.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob, getJob, pruneOrphanedDispatchJobs } from '../jobs.js';
import { createRun, finishRun } from '../runs.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'scheduler-orphan-dispatch-reaper-'));
const stateDir = join(tmpRoot, 'dispatch');
const labelsPath = join(stateDir, 'labels.json');
const dbPath = join(tmpRoot, 'test.db');

function setLabels(labels) {
  writeFileSync(labelsPath, JSON.stringify(labels) + '\n', 'utf8');
}

function labelEntry(status) {
  return { status, updatedAt: new Date().toISOString() };
}

// Check-in jobs are */5 (or */15) cron WITHOUT ttl_hours and delivery_mode
// 'none' -- the residue this reaper exists to clear is their DISABLED row
// after a self-delete falls back to disabling on JOB_ACTIVE_RUNS.
function makeCheckinJob(name, overrides = {}) {
  return createJob({
    name,
    schedule_kind: 'cron',
    schedule_cron: '*/5 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 120_000,
    origin: 'system',
    ...overrides,
  });
}

function makeWatchdogJob(name, label, overrides = {}) {
  return createJob({
    name,
    job_type: 'watchdog',
    watchdog_target_label: label,
    watchdog_check_cmd: 'true',
    schedule_kind: 'cron',
    schedule_cron: '*/5 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 120_000,
    origin: 'system',
    ...overrides,
  });
}

function makeDeliverJob(name, overrides = {}) {
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

// Age the job's immutable created_at past the family window. The reaper ages
// on created_at (not last_run_at), so this sets created_at directly.
function ageJob(jobId, sqlFragment) {
  getDb().prepare(`UPDATE jobs SET created_at = ${sqlFragment} WHERE id = ?`).run(jobId);
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

test('disabled dispatch-checkin job past the grace window with a terminal label is reaped', () => {
  setLabels({ 'checkin-done': labelEntry('done') });
  const job = makeCheckinJob('dispatch-checkin:checkin-done', { enabled: 0 });
  ageJob(job.id, "datetime('now', '-10 minutes')");

  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined, 'disabled residue job should be deleted');
});

test('disabled dispatch-checkin job whose label is absent from the ledger is reaped', () => {
  setLabels({});
  const job = makeCheckinJob('dispatch-checkin:checkin-gone', { enabled: 0 });
  ageJob(job.id, "datetime('now', '-10 minutes')");

  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined, 'absent label means the watched work is gone');
});

test('dispatch-checkin job whose label is still running is NOT reaped', () => {
  setLabels({ 'checkin-running': labelEntry('running') });
  const job = makeCheckinJob('dispatch-checkin:checkin-running');
  ageJob(job.id, "datetime('now', '-10 minutes')");

  assert.equal(pruneOrphanedDispatchJobs(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while the watched label is non-terminal');

  setLabels({ 'checkin-running': labelEntry('interrupted') });
  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('dispatch-checkin job created within the 5-minute grace window is NOT reaped', () => {
  setLabels({ 'checkin-fresh': labelEntry('done') });
  const job = makeCheckinJob('dispatch-checkin:checkin-fresh');
  // created_at is now (freshly created), so a brand-new job racing its own
  // self-delete must survive this pass.
  assert.equal(pruneOrphanedDispatchJobs(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job inside the grace window must survive');

  ageJob(job.id, "datetime('now', '-6 minutes')");
  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined, 'job past the grace window is reaped');
});

test('watchdog job with a terminal label is reaped', () => {
  setLabels({ 'wd-done': labelEntry('error') });
  const job = makeWatchdogJob('watchdog:wd-done', 'wd-done');
  ageJob(job.id, "datetime('now', '-10 minutes')");

  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('watchdog job whose label is absent from the ledger is reaped', () => {
  setLabels({});
  const job = makeWatchdogJob('watchdog:wd-gone', 'wd-gone');
  ageJob(job.id, "datetime('now', '-10 minutes')");

  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined);
});

test('dispatch-deliver job keeps ttl-based aging: past ttl reaped, within ttl not', () => {
  setLabels({
    'deliver-aged': labelEntry('done'),
    'deliver-fresh': labelEntry('done'),
  });
  const aged = makeDeliverJob('dispatch-deliver:deliver-aged');
  const fresh = makeDeliverJob('dispatch-deliver:deliver-fresh');
  ageJob(aged.id, "datetime('now', '-49 hours')");

  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(aged.id), undefined, 'past-ttl deliver job is reaped');
  assert.equal(getJob(fresh.id).id, fresh.id, 'within-ttl deliver job must survive');

  ageJob(fresh.id, "datetime('now', '-49 hours')");
  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(fresh.id), undefined, 'deliver job is reaped once past ttl');
});

test('the standing delivery-failure-alert job is never reaped', () => {
  setLabels({ 'unrelated-label': labelEntry('done') });
  const job = createJob({
    name: 'delivery-failure-alert',
    schedule_kind: 'cron',
    schedule_cron: '*/5 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 30_000,
    origin: 'system',
    ttl_hours: 48,
  });
  // Far past any ttl window: the only thing keeping it alive is that its name
  // is not a dispatch job family member (no colon-label).
  ageJob(job.id, "datetime('now', '-1000 hours')");

  assert.equal(pruneOrphanedDispatchJobs(), 0);
  assert.equal(getJob(job.id).id, job.id, 'standing job must never be touched');
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
});

test('dispatch-checkin job with a live child is NOT reaped', () => {
  setLabels({ 'checkin-child': labelEntry('done') });
  const job = makeCheckinJob('dispatch-checkin:checkin-child');
  ageJob(job.id, "datetime('now', '-10 minutes')");
  const child = createJob({
    name: 'checkin-child-trigger',
    parent_id: job.id,
    trigger_on: 'success',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 30_000,
    origin: 'system',
  });

  assert.equal(pruneOrphanedDispatchJobs(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while a child is live');

  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(child.id);
  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined, 'job is reaped once the child is gone');
});

test('dispatch-checkin job with an in-flight run is NOT reaped', () => {
  setLabels({ 'checkin-inflight': labelEntry('done') });
  const job = makeCheckinJob('dispatch-checkin:checkin-inflight');
  ageJob(job.id, "datetime('now', '-10 minutes')");
  const running = createRun(job.id);

  assert.equal(pruneOrphanedDispatchJobs(), 0);
  assert.equal(getJob(job.id).id, job.id, 'job must survive while a run is in flight');

  finishRun(running.id, 'cancelled', { summary: 'cleanup' });
  assert.equal(pruneOrphanedDispatchJobs(), 1);
  assert.equal(getJob(job.id), undefined);
});
