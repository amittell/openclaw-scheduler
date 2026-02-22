#!/usr/bin/env node
// Basic smoke tests for the scheduler
import { initDb, closeDb, getDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, getDueJobs, hasRunningRun, nextRunFromCron } from './jobs.js';
import { createRun, getRun, finishRun, getRunsForJob, getStaleRuns, getTimedOutRuns, getRunningRuns, updateHeartbeat, pruneRuns } from './runs.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// Use in-memory DB for tests
process.env.SCHEDULER_DB = ':memory:';

console.log('🧪 Running scheduler tests...\n');

// ── Schema ──────────────────────────────────────────────────
console.log('Schema:');
initDb();
const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
assert(tables.some(t => t.name === 'jobs'), 'jobs table exists');
assert(tables.some(t => t.name === 'runs'), 'runs table exists');
assert(tables.some(t => t.name === 'schema_migrations'), 'migrations table exists');

// ── Cron parsing ────────────────────────────────────────────
console.log('\nCron:');
const next = nextRunFromCron('0 9 * * *', 'America/New_York');
assert(next !== null, `nextRunFromCron returns a date: ${next}`);
assert(next.includes('T'), 'returns ISO format');

// ── Job CRUD ────────────────────────────────────────────────
console.log('\nJobs:');
const job = createJob({
  name: 'Test Job',
  schedule_cron: '*/5 * * * *',
  payload_message: 'Hello from test',
});
assert(job !== null, 'createJob returns a job');
assert(job.name === 'Test Job', 'name matches');
assert(job.enabled === 1, 'enabled by default');
assert(job.next_run_at !== null, 'next_run_at calculated');

const fetched = getJob(job.id);
assert(fetched.id === job.id, 'getJob returns same job');

updateJob(job.id, { name: 'Updated Job' });
const updated = getJob(job.id);
assert(updated.name === 'Updated Job', 'updateJob works');

const all = listJobs();
assert(all.length >= 1, `listJobs returns ${all.length} job(s)`);

// ── Due jobs ────────────────────────────────────────────────
console.log('\nDue jobs:');
// Make a job that's already due
const dueJob = createJob({
  name: 'Due Job',
  schedule_cron: '* * * * *',  // every minute
  payload_message: 'I am due',
});
// Force next_run_at to the past
getDb().prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").run(dueJob.id);
const dueJobs = getDueJobs();
assert(dueJobs.some(j => j.id === dueJob.id), 'getDueJobs finds past-due job');

// ── Runs ────────────────────────────────────────────────────
console.log('\nRuns:');
const run = createRun(job.id, { run_timeout_ms: 60000 });
assert(run !== null, 'createRun returns a run');
assert(run.status === 'running', 'initial status is running');
assert(run.run_timeout_ms === 60000, 'timeout copied from opts');

assert(hasRunningRun(job.id), 'hasRunningRun detects running run');

updateHeartbeat(run.id);
const hbRun = getRun(run.id);
assert(hbRun.last_heartbeat !== null, 'heartbeat updated');

finishRun(run.id, 'ok', { summary: 'Done!' });
const finished = getRun(run.id);
assert(finished.status === 'ok', 'run finished with ok');
assert(finished.summary === 'Done!', 'summary saved');
assert(finished.duration_ms >= 0, 'duration calculated');

assert(!hasRunningRun(job.id), 'no running runs after finish');

// ── Stale detection ─────────────────────────────────────────
console.log('\nStale detection:');
const staleRun = createRun(job.id, { run_timeout_ms: 1000 });
// Force heartbeat to 2 minutes ago
getDb().prepare("UPDATE runs SET last_heartbeat = datetime('now', '-120 seconds') WHERE id = ?").run(staleRun.id);
const stale = getStaleRuns(90);
assert(stale.some(r => r.id === staleRun.id), 'getStaleRuns finds stale run');

// ── Timeout detection ───────────────────────────────────────
console.log('\nTimeout detection:');
const timeoutRun = createRun(job.id, { run_timeout_ms: 1 }); // 1ms timeout
// Force started_at to 10 seconds ago (way past 1ms timeout)
getDb().prepare("UPDATE runs SET started_at = datetime('now', '-10 seconds') WHERE id = ?").run(timeoutRun.id);
const timedOut = getTimedOutRuns();
assert(timedOut.some(r => r.id === timeoutRun.id), 'getTimedOutRuns finds timed-out run');

// ── Delete job cascades ─────────────────────────────────────
console.log('\nCascade delete:');
const delJob = createJob({
  name: 'Deletable',
  schedule_cron: '0 * * * *',
  payload_message: 'bye',
});
createRun(delJob.id);
deleteJob(delJob.id);
assert(getJob(delJob.id) === undefined, 'job deleted');
assert(getRunsForJob(delJob.id).length === 0, 'runs cascade deleted');

// ── Prune ───────────────────────────────────────────────────
console.log('\nPrune:');
// Create many runs
for (let i = 0; i < 5; i++) {
  const r = createRun(job.id);
  finishRun(r.id, 'ok');
}
pruneRuns(3);
const remaining = getRunsForJob(job.id);
assert(remaining.length <= 3, `pruneRuns keeps at most 3 (got ${remaining.length})`);

// ── Cleanup ─────────────────────────────────────────────────
closeDb();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
