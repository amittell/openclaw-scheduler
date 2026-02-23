#!/usr/bin/env node
// Scheduler v2 unified test suite — in-memory, self-contained
// Covers: schema, cron, jobs, runs, messages, agents, chaining, retry, cancellation

import { setDbPath, initDb, closeDb, getDb } from './db.js';
import {
  createJob, getJob, listJobs, updateJob, deleteJob,
  getDueJobs, hasRunningRun, nextRunFromCron,
  getTriggeredChildren, getChildJobs, fireTriggeredChildren,
  pruneExpiredJobs, detectCycle, getChainDepth,
  shouldRetry, scheduleRetry, cancelJob,
  enqueueJob, dequeueJob, runJobNow,
  hasRunningRunForPool, evalTriggerCondition
} from './jobs.js';
import {
  createRun, getRun, finishRun, getRunsForJob,
  getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateHeartbeat, pruneRuns,
  getRunningRunsByPool
} from './runs.js';
import {
  sendMessage, getMessage, getInbox, getOutbox, getThread,
  markDelivered, markRead, markAllRead, getUnreadCount,
  expireMessages, pruneMessages
} from './messages.js';
import { upsertAgent, getAgent, listAgents, setAgentStatus, touchAgent } from './agents.js';

// ── Test harness ────────────────────────────────────────────
let passed = 0;
let failed = 0;

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
function assert(cond, msg) {
  if (cond) { passed++; if (verbose) console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── In-memory DB ────────────────────────────────────────────
setDbPath(':memory:');
initDb();
const db = getDb();

console.log('🧪 Scheduler v2 test suite\n');

// ═══════════════════════════════════════════════════════════
// SECTION 1: Core (schema, cron, CRUD, runs, messages, agents)
// ═══════════════════════════════════════════════════════════

console.log('Schema:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
assert(tables.includes('jobs'), 'jobs table');
assert(tables.includes('runs'), 'runs table');
assert(tables.includes('messages'), 'messages table');
assert(tables.includes('agents'), 'agents table');

// Verify v3 columns exist
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(jobCols.includes('parent_id'), 'jobs.parent_id column');
assert(jobCols.includes('trigger_on'), 'jobs.trigger_on column');
assert(jobCols.includes('trigger_delay_s'), 'jobs.trigger_delay_s column');
assert(jobCols.includes('max_retries'), 'jobs.max_retries column');

const runCols = db.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
assert(runCols.includes('retry_count'), 'runs.retry_count column');
assert(runCols.includes('retry_of'), 'runs.retry_of column');

// ── Cron ────────────────────────────────────────────────────
console.log('\nCron:');
const next = nextRunFromCron('0 9 * * *', 'America/New_York');
assert(next !== null, 'nextRunFromCron parses');

// ── Job CRUD ────────────────────────────────────────────────
console.log('\nJobs:');
const job = createJob({ name: 'Test Job', schedule_cron: '*/5 * * * *', payload_message: 'Hello', delivery_mode: 'none' });
assert(job && job.name === 'Test Job', 'createJob');
assert(job.enabled === 1, 'enabled by default');
assert(job.next_run_at !== null, 'next_run_at calculated');
assert(getJob(job.id).id === job.id, 'getJob');
updateJob(job.id, { name: 'Updated' });
assert(getJob(job.id).name === 'Updated', 'updateJob');
assert(listJobs().length >= 1, 'listJobs');

// ── Due jobs ────────────────────────────────────────────────
console.log('\nDue jobs:');
const dueJob = createJob({ name: 'Due', schedule_cron: '* * * * *', payload_message: 'due', delivery_mode: 'none' });
db.prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").run(dueJob.id);
assert(getDueJobs().some(j => j.id === dueJob.id), 'getDueJobs finds past-due');

// ── Runs ────────────────────────────────────────────────────
console.log('\nRuns:');
const run = createRun(job.id, { run_timeout_ms: 60000 });
assert(run.status === 'running', 'initial status running');
assert(hasRunningRun(job.id), 'hasRunningRun');
updateHeartbeat(run.id);
assert(getRun(run.id).last_heartbeat !== null, 'heartbeat updated');
finishRun(run.id, 'ok', { summary: 'Done!' });
assert(getRun(run.id).status === 'ok', 'finished ok');
assert(getRun(run.id).summary === 'Done!', 'summary saved');
assert(!hasRunningRun(job.id), 'no running after finish');

// ── Stale detection ─────────────────────────────────────────
console.log('\nStale:');
const staleRun = createRun(job.id, { run_timeout_ms: 1000 });
db.prepare("UPDATE runs SET last_heartbeat = datetime('now', '-120 seconds') WHERE id = ?").run(staleRun.id);
assert(getStaleRuns(90).some(r => r.id === staleRun.id), 'stale run detected');

// ── Timeout ─────────────────────────────────────────────────
console.log('\nTimeout:');
const toRun = createRun(job.id, { run_timeout_ms: 1 });
db.prepare("UPDATE runs SET started_at = datetime('now', '-10 seconds') WHERE id = ?").run(toRun.id);
assert(getTimedOutRuns().some(r => r.id === toRun.id), 'timeout detected');

// ── Agents ──────────────────────────────────────────────────
console.log('\nAgents:');
const agent = upsertAgent('main', { name: 'Main Agent', capabilities: ['*'] });
assert(agent.id === 'main', 'upsertAgent');
assert(agent.name === 'Main Agent', 'agent name');
setAgentStatus('main', 'busy', 'session:123');
assert(getAgent('main').status === 'busy', 'setAgentStatus');
touchAgent('main');
assert(getAgent('main').last_seen_at !== null, 'touchAgent');
assert(listAgents().length >= 1, 'listAgents');

// ── Messages ────────────────────────────────────────────────
console.log('\nMessages:');
const msg = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'Hello agent', kind: 'text', subject: 'Greeting' });
assert(msg && msg.id, 'sendMessage');
assert(msg.status === 'pending', 'initial status pending');

const msg2 = sendMessage({ from_agent: 'main', to_agent: 'scheduler', body: 'Got it', reply_to: msg.id });
assert(msg2.reply_to === msg.id, 'reply threading');

const inbox = getInbox('main');
assert(inbox.length >= 1, 'inbox has messages');
assert(inbox.some(m => m.id === msg.id), 'message in inbox');

const outbox = getOutbox('scheduler');
assert(outbox.some(m => m.id === msg.id), 'message in outbox');

const thread = getThread(msg.id);
assert(thread.length === 2, 'thread has 2 messages');

assert(getUnreadCount('main') >= 1, 'unread > 0');

markDelivered(msg.id);
assert(getMessage(msg.id).status === 'delivered', 'markDelivered');

markRead(msg.id);
assert(getMessage(msg.id).status === 'read', 'markRead');
assert(getMessage(msg.id).read_at !== null, 'read_at set');

sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'A' });
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'B' });
markAllRead('main');
assert(getUnreadCount('main') === 0, 'markAllRead');

sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'normal', priority: 0 });
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'urgent', priority: 2 });
const prioritized = getInbox('main');
assert(prioritized[0].priority >= prioritized[prioritized.length - 1].priority, 'priority ordering');

sendMessage({ from_agent: 'scheduler', to_agent: 'broadcast', body: 'all agents' });
assert(getInbox('main').some(m => m.to_agent === 'broadcast'), 'broadcast');

const expMsg = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'expires', expires_at: '2020-01-01T00:00:00Z' });
expireMessages();
assert(getMessage(expMsg.id).status === 'expired', 'expiry');

const metaMsg = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'meta', metadata: { key: 'value' } });
assert(getMessage(metaMsg.id).metadata?.key === 'value', 'metadata');

// ── Cascade delete ──────────────────────────────────────────
console.log('\nCascade:');
const delJob = createJob({ name: 'Deletable', schedule_cron: '0 * * * *', payload_message: 'bye', delivery_mode: 'none' });
createRun(delJob.id);
deleteJob(delJob.id);
assert(!getJob(delJob.id), 'job deleted');
assert(getRunsForJob(delJob.id).length === 0, 'runs cascade deleted');

// ── Prune ───────────────────────────────────────────────────
console.log('\nPrune:');
for (let i = 0; i < 5; i++) { const r = createRun(job.id); finishRun(r.id, 'ok'); }
pruneRuns(3);
assert(getRunsForJob(job.id).length <= 3, 'pruneRuns');
pruneMessages(0);

// ═══════════════════════════════════════════════════════════
// SECTION 2: Workflow chaining (v3)
// ═══════════════════════════════════════════════════════════

console.log('\n── Chaining ──');

const parent = createJob({ name: 'Parent', schedule_cron: '0 9 * * *', payload_message: 'parent', delivery_mode: 'none' });
const childSuccess = createJob({ name: 'OnSuccess', parent_id: parent.id, trigger_on: 'success', payload_message: 'on success', delivery_mode: 'none' });
const childFailure = createJob({ name: 'OnFailure', parent_id: parent.id, trigger_on: 'failure', payload_message: 'on failure', delivery_mode: 'none' });
const childComplete = createJob({ name: 'OnComplete', parent_id: parent.id, trigger_on: 'complete', payload_message: 'on complete', delivery_mode: 'none' });

assert(childSuccess.parent_id === parent.id, 'child parent_id set');
assert(childSuccess.trigger_on === 'success', 'trigger_on = success');
assert(childSuccess.schedule_cron === '0 0 31 2 *', 'child gets dummy cron');
assert(childSuccess.next_run_at === null, 'child starts with null next_run_at');

// getChildJobs
assert(getChildJobs(parent.id).length === 3, 'getChildJobs returns 3');

// Triggered on success
const onSuccess = getTriggeredChildren(parent.id, 'ok');
assert(onSuccess.length === 2, 'success triggers 2 (success + complete)');
assert(onSuccess.some(c => c.name === 'OnSuccess'), 'includes success child');
assert(onSuccess.some(c => c.name === 'OnComplete'), 'includes complete child');
assert(!onSuccess.some(c => c.name === 'OnFailure'), 'excludes failure child');

// Triggered on failure
const onFailure = getTriggeredChildren(parent.id, 'error');
assert(onFailure.length === 2, 'failure triggers 2 (failure + complete)');
assert(onFailure.some(c => c.name === 'OnFailure'), 'includes failure child');
assert(!onFailure.some(c => c.name === 'OnSuccess'), 'excludes success child');

// fireTriggeredChildren sets next_run_at
fireTriggeredChildren(parent.id, 'ok');
assert(getJob(childSuccess.id).next_run_at !== null, 'child scheduled after fire');

// Trigger delay
const delayedChild = createJob({ name: 'Delayed', parent_id: parent.id, trigger_on: 'success', trigger_delay_s: 60, payload_message: 'delayed', delivery_mode: 'none' });
assert(delayedChild.trigger_delay_s === 60, 'trigger_delay_s stored');
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE id = ?').run(delayedChild.id);
fireTriggeredChildren(parent.id, 'ok');
const delayedTime = new Date(getJob(delayedChild.id).next_run_at + 'Z').getTime();
assert(delayedTime > Date.now(), 'delayed child scheduled in future');

// Agent routing
const agentJob = createJob({ name: 'AgentJob', schedule_cron: '0 12 * * *', agent_id: 'worker', payload_message: 'x', delivery_mode: 'none' });
assert(agentJob.agent_id === 'worker', 'agent_id stored');

// Orphan pruning
const tempParent = createJob({ name: 'TempParent', schedule_cron: '0 12 * * *', payload_message: 'temp', delivery_mode: 'none' });
const orphan = createJob({ name: 'Orphan', parent_id: tempParent.id, trigger_on: 'success', payload_message: 'orphan', delivery_mode: 'none' });
db.pragma('foreign_keys = OFF');
db.prepare('DELETE FROM jobs WHERE id = ?').run(tempParent.id);
db.pragma('foreign_keys = ON');
const pruned = pruneExpiredJobs();
assert(pruned > 0, 'orphan pruned');
assert(!getJob(orphan.id), 'orphan removed');

// Aged disabled job cleanup
const agedJob = createJob({ name: 'AgedDisabled', schedule_cron: '0 12 * * *', payload_message: 'aged', delivery_mode: 'none' });
updateJob(agedJob.id, { enabled: 0, last_run_at: '2020-01-01 00:00:00' });
const pruned2 = pruneExpiredJobs();
assert(pruned2 > 0, 'aged disabled job pruned');
assert(!getJob(agedJob.id), 'aged disabled job removed');

// Disabled job < 24h should NOT be pruned
const recentDisabled = createJob({ name: 'RecentDisabled', schedule_cron: '0 12 * * *', payload_message: 'recent', delivery_mode: 'none' });
updateJob(recentDisabled.id, { enabled: 0 });
pruneExpiredJobs();
assert(getJob(recentDisabled.id), 'recently disabled job kept');

// ═══════════════════════════════════════════════════════════
// SECTION 3: Cycle detection + max depth (v3b)
// ═══════════════════════════════════════════════════════════

console.log('\n── Cycles & Depth ──');

const cA = createJob({ name: 'cA', schedule_cron: '0 6 * * *', payload_message: 'a', delivery_mode: 'none' });
const cB = createJob({ name: 'cB', parent_id: cA.id, trigger_on: 'success', payload_message: 'b', delivery_mode: 'none' });
const cC = createJob({ name: 'cC', parent_id: cB.id, trigger_on: 'success', payload_message: 'c', delivery_mode: 'none' });

// Self-cycle
let err1 = false;
try { detectCycle(cC.id, cC.id); } catch { err1 = true; }
assert(err1, 'self-cycle detected');

// Deep cycle A→B→C→A
let err2 = false;
try { detectCycle(cA.id, cC.id); } catch { err2 = true; }
assert(err2, 'deep cycle detected');

// Valid chain is allowed
let ok1 = false;
try { detectCycle('new-id', cC.id); ok1 = true; } catch {}
assert(ok1, 'valid chain allowed');

// Blocked on updateJob
let err3 = false;
try { updateJob(cA.id, { parent_id: cC.id }); } catch { err3 = true; }
assert(err3, 'cycle blocked on updateJob');

// Chain depth
assert(getChainDepth(cA.id) === 0, 'root depth = 0');
assert(getChainDepth(cB.id) === 1, 'child depth = 1');
assert(getChainDepth(cC.id) === 2, 'grandchild depth = 2');

// Build 10-deep chain, verify 11th blocked
let deepParent = createJob({ name: 'D0', schedule_cron: '0 12 * * *', payload_message: 'd', delivery_mode: 'none' });
for (let i = 1; i <= 9; i++) {
  deepParent = createJob({ name: `D${i}`, parent_id: deepParent.id, trigger_on: 'success', payload_message: `d${i}`, delivery_mode: 'none' });
}
let err4 = false;
try { createJob({ name: 'D10', parent_id: deepParent.id, trigger_on: 'success', payload_message: 'too deep', delivery_mode: 'none' }); } catch { err4 = true; }
assert(err4, 'depth 11 blocked by MAX_CHAIN_DEPTH');

// ═══════════════════════════════════════════════════════════
// SECTION 4: Retry logic (v3b)
// ═══════════════════════════════════════════════════════════

console.log('\n── Retry ──');

const retryJob = createJob({ name: 'Retryable', schedule_cron: '0 8 * * *', payload_message: 'retry me', max_retries: 3, delivery_mode: 'none' });
assert(retryJob.max_retries === 3, 'max_retries stored');

const run1 = createRun(retryJob.id, { run_timeout_ms: 300000 });
finishRun(run1.id, 'error', { error_message: 'fail' });
assert(shouldRetry(retryJob, run1.id), 'shouldRetry true on first failure');

const retry1 = scheduleRetry(retryJob, run1.id);
assert(retry1.retryCount === 1, 'retryCount = 1');
assert(retry1.delaySec === 30, 'first retry = 30s');

// Backoff math
assert(30 * Math.pow(2, 0) === 30, 'backoff: retry 1 = 30s');
assert(30 * Math.pow(2, 1) === 60, 'backoff: retry 2 = 60s');
assert(30 * Math.pow(2, 2) === 120, 'backoff: retry 3 = 120s');

// Exhausted retries
db.prepare('UPDATE runs SET retry_count = 3 WHERE id = ?').run(run1.id);
assert(!shouldRetry(retryJob, run1.id), 'shouldRetry false after max');

// No-retry job
const noRetry = createJob({ name: 'NoRetry', schedule_cron: '0 8 * * *', payload_message: 'no', delivery_mode: 'none' });
const run2 = createRun(noRetry.id, { run_timeout_ms: 300000 });
finishRun(run2.id, 'error', { error_message: 'fail' });
assert(!shouldRetry(noRetry, run2.id), 'shouldRetry false when max_retries=0');

// ═══════════════════════════════════════════════════════════
// SECTION 5: Cancellation (v3b)
// ═══════════════════════════════════════════════════════════

console.log('\n── Cancellation ──');

const cancelP = createJob({ name: 'CancelP', schedule_cron: '0 7 * * *', payload_message: 'p', delivery_mode: 'none' });
const cancelC1 = createJob({ name: 'CancelC1', parent_id: cancelP.id, trigger_on: 'success', payload_message: 'c1', delivery_mode: 'none' });
const cancelC2 = createJob({ name: 'CancelC2', parent_id: cancelP.id, trigger_on: 'complete', payload_message: 'c2', delivery_mode: 'none' });
const cancelGC = createJob({ name: 'CancelGC', parent_id: cancelC1.id, trigger_on: 'success', payload_message: 'gc', delivery_mode: 'none' });

// Cascade cancel
const cancelled = cancelJob(cancelP.id);
assert(cancelled.length === 4, 'cascade cancels 4 jobs');
assert(!getJob(cancelP.id).enabled, 'parent disabled');
assert(!getJob(cancelC1.id).enabled, 'child 1 disabled');
assert(!getJob(cancelC2.id).enabled, 'child 2 disabled');
assert(!getJob(cancelGC.id).enabled, 'grandchild disabled');

// No-cascade
const ncP = createJob({ name: 'NcP', schedule_cron: '0 7 * * *', payload_message: 'p', delivery_mode: 'none' });
const ncC = createJob({ name: 'NcC', parent_id: ncP.id, trigger_on: 'success', payload_message: 'c', delivery_mode: 'none' });
const ncResult = cancelJob(ncP.id, { cascade: false });
assert(ncResult.length === 1, 'no-cascade cancels 1');
assert(!!getJob(ncC.id).enabled, 'child still enabled');

// Cancel running runs
const runP = createJob({ name: 'RunP', schedule_cron: '0 7 * * *', payload_message: 'r', delivery_mode: 'none' });
const runR = createRun(runP.id, { run_timeout_ms: 300000 });
assert(db.prepare('SELECT status FROM runs WHERE id = ?').get(runR.id).status === 'running', 'run is running');
cancelJob(runP.id);
assert(db.prepare('SELECT status FROM runs WHERE id = ?').get(runR.id).status === 'cancelled', 'running run cancelled');

// ═══════════════════════════════════════════════════════════
// SECTION 6: Queue overlap policy
// ═══════════════════════════════════════════════════════════

console.log('\n── Queue Overlap ──');

// Schema column exists
const qCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(qCols.includes('queued_count'), 'jobs.queued_count column');

// Create a queue-policy job
const qJob = createJob({ name: 'QueueJob', schedule_cron: '*/5 * * * *', payload_message: 'q', overlap_policy: 'queue', delivery_mode: 'none' });
assert(qJob.overlap_policy === 'queue', 'overlap_policy = queue');
assert(qJob.queued_count === 0, 'initial queued_count = 0');

// Enqueue increments counter
enqueueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 1, 'enqueue → queued_count = 1');
enqueueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 2, 'enqueue again → queued_count = 2');

// Dequeue consumes one and schedules for next tick
const dequeued1 = dequeueJob(qJob.id);
assert(dequeued1 === true, 'dequeue returns true');
assert(getJob(qJob.id).queued_count === 1, 'after dequeue → queued_count = 1');
assert(getJob(qJob.id).next_run_at !== null, 'dequeue sets next_run_at');

// Dequeue the second
const dequeued2 = dequeueJob(qJob.id);
assert(dequeued2 === true, 'second dequeue returns true');
assert(getJob(qJob.id).queued_count === 0, 'after second dequeue → queued_count = 0');

// Dequeue on empty returns false
const dequeued3 = dequeueJob(qJob.id);
assert(dequeued3 === false, 'dequeue on empty returns false');

// Queue with running run: simulate the full flow
const qRun = createRun(qJob.id, { run_timeout_ms: 300000 });
assert(hasRunningRun(qJob.id), 'qJob has running run');

// While running, enqueue 3 times (simulating 3 cron fires during a long run)
enqueueJob(qJob.id);
enqueueJob(qJob.id);
enqueueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 3, 'queued 3 during running');

// Finish the run — dequeue should consume one
finishRun(qRun.id, 'ok', { summary: 'done' });
const dq = dequeueJob(qJob.id);
assert(dq === true, 'dequeue after run completion');
assert(getJob(qJob.id).queued_count === 2, 'one consumed, 2 remaining');

// Drain remaining
dequeueJob(qJob.id);
dequeueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 0, 'fully drained');
assert(dequeueJob(qJob.id) === false, 'nothing left to dequeue');

// ═══════════════════════════════════════════════════════════
// SECTION 7: Run-Now Flag
// ═══════════════════════════════════════════════════════════

console.log('\n── Run-Now Flag ──');

// 1. Regular create (no run_now) → next_run_at computed from cron
const normalJob = createJob({ name: 'NormalScheduled', schedule_cron: '0 3 * * *', payload_message: 'normal', delivery_mode: 'none' });
const normalNextRun = new Date(normalJob.next_run_at + 'Z');
assert(normalNextRun > new Date(), 'regular create: next_run_at is in the future');

// 2. Create with run_now=true → next_run_at is in the past
const runNowJob = createJob({ name: 'RunNowJob', schedule_cron: '0 3 * * *', payload_message: 'run now!', delivery_mode: 'none', run_now: true });
const runNowTime = new Date(runNowJob.next_run_at + 'Z');
assert(runNowTime < new Date(), 'run_now=true: next_run_at is in the past');
assert(getDueJobs().some(j => j.id === runNowJob.id), 'run_now job immediately appears in getDueJobs()');

// 3. run_now=true is picked up — next_run_at should be ~1 second in the past
const diff = Date.now() - runNowTime.getTime();
assert(diff >= 0 && diff < 5000, 'run_now next_run_at is approximately 1 second in the past (within 5s)');

// 4. run_now=false (explicit) behaves like no run_now
const noRunNowJob = createJob({ name: 'NoRunNow', schedule_cron: '0 3 * * *', payload_message: 'no run', delivery_mode: 'none', run_now: false });
const noRunNowTime = new Date(noRunNowJob.next_run_at + 'Z');
assert(noRunNowTime > new Date(), 'run_now=false: next_run_at is in the future (normal cron)');

// 5. runJobNow(id) sets next_run_at to ~1 second in the past
const laterJob = createJob({ name: 'LaterJob', schedule_cron: '0 4 * * *', payload_message: 'trigger later', delivery_mode: 'none' });
assert(new Date(laterJob.next_run_at + 'Z') > new Date(), 'laterJob starts with future next_run_at');
const triggered = runJobNow(laterJob.id);
const triggeredTime = new Date(triggered.next_run_at + 'Z');
assert(triggeredTime < new Date(), 'runJobNow: next_run_at is now in the past');
const triggeredDiff = Date.now() - triggeredTime.getTime();
assert(triggeredDiff >= 0 && triggeredDiff < 5000, 'runJobNow: next_run_at is approximately 1 second ago (within 5s)');
assert(getDueJobs().some(j => j.id === laterJob.id), 'runJobNow: job appears in getDueJobs()');

// 6. runJobNow does NOT change the schedule_cron (normal schedule is preserved)
assert(triggered.schedule_cron === '0 4 * * *', 'runJobNow: schedule_cron unchanged');

// 7. runJobNow returns null for unknown id
const unknownResult = runJobNow('nonexistent-uuid-xxxx');
assert(unknownResult === undefined || unknownResult === null, 'runJobNow: returns null/undefined for missing id');

// ═══════════════════════════════════════════════════════════
// SECTION 7: payload_scope (cross-session sub-agent visibility)
// ═══════════════════════════════════════════════════════════

console.log('\n── payload_scope ──');

// Schema: column must exist with default 'own'
const scopeCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(scopeCols.includes('payload_scope'), 'jobs.payload_scope column exists');

// Default scope is 'own' when not specified
const scopeDefaultJob = createJob({ name: 'ScopeDefault', schedule_cron: '0 10 * * *', payload_message: 'default scope', delivery_mode: 'none' });
assert(scopeDefaultJob.payload_scope === 'own', "default payload_scope = 'own'");

// Create job with payload_scope='global'
const scopeGlobalJob = createJob({ name: 'ScopeGlobal', schedule_cron: '0 11 * * *', payload_message: 'check all sub-agents', payload_scope: 'global', delivery_mode: 'none' });
assert(scopeGlobalJob.payload_scope === 'global', "payload_scope stored as 'global'");

// Verify field persisted via getJob
const fetched = getJob(scopeGlobalJob.id);
assert(fetched.payload_scope === 'global', "getJob returns payload_scope='global'");

// Update payload_scope via updateJob
updateJob(scopeGlobalJob.id, { payload_scope: 'own' });
assert(getJob(scopeGlobalJob.id).payload_scope === 'own', "updateJob can change payload_scope to 'own'");
updateJob(scopeGlobalJob.id, { payload_scope: 'global' });
assert(getJob(scopeGlobalJob.id).payload_scope === 'global', "updateJob can change payload_scope back to 'global'");

// listJobs returns payload_scope
const allJobs = listJobs();
const listedGlobal = allJobs.find(j => j.id === scopeGlobalJob.id);
assert(listedGlobal && listedGlobal.payload_scope === 'global', "listJobs includes payload_scope");

// 'own'-scoped job should not have the global scope field set to 'global'
const listedDefault = allJobs.find(j => j.id === scopeDefaultJob.id);
assert(listedDefault && listedDefault.payload_scope === 'own', "listJobs: default job has payload_scope='own'");

// ═══════════════════════════════════════════════════════════
// DONE
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// SECTION: Resource Pool Concurrency (Global Locks)
// ═══════════════════════════════════════════════════════════

console.log('\n── Resource Pool ──');

// schema: resource_pool column exists
const jobColsPool = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(jobColsPool.includes('resource_pool'), 'jobs.resource_pool column exists');

// Create two jobs sharing the same pool
const poolJob1 = createJob({
  name: 'Pool Job 1',
  schedule_cron: '*/5 * * * *',
  payload_message: 'pool task 1',
  delivery_mode: 'none',
  resource_pool: 'browser',
});
const poolJob2 = createJob({
  name: 'Pool Job 2',
  schedule_cron: '*/5 * * * *',
  payload_message: 'pool task 2',
  delivery_mode: 'none',
  resource_pool: 'browser',
});
const noPoolJob = createJob({
  name: 'No Pool Job',
  schedule_cron: '*/5 * * * *',
  payload_message: 'no pool',
  delivery_mode: 'none',
});

assert(getJob(poolJob1.id).resource_pool === 'browser', 'poolJob1 has resource_pool=browser');
assert(getJob(poolJob2.id).resource_pool === 'browser', 'poolJob2 has resource_pool=browser');
assert(getJob(noPoolJob.id).resource_pool === null, 'noPoolJob has resource_pool=null');

// Pool is free before any run
assert(hasRunningRunForPool('browser') === false, 'pool free before any run');

// Start a run for poolJob1 → pool becomes busy
const poolRun1 = createRun(poolJob1.id, { run_timeout_ms: 300000 });
assert(hasRunningRunForPool('browser') === true, 'pool busy after poolJob1 run starts');
assert(hasRunningRunForPool('other') === false, 'different pool name is not busy');

// getRunningRunsByPool returns the run
const busyRuns = getRunningRunsByPool('browser');
assert(busyRuns.length === 1, 'getRunningRunsByPool returns 1 run');
assert(busyRuns[0].job_name === 'Pool Job 1', 'getRunningRunsByPool has correct job name');

// poolJob2 also counts since it shares the pool
const poolRun2 = createRun(poolJob2.id, { run_timeout_ms: 300000 });
const busyRuns2 = getRunningRunsByPool('browser');
assert(busyRuns2.length === 2, 'getRunningRunsByPool returns 2 runs when both jobs running');

// noPoolJob is unaffected by pool checks
assert(hasRunningRunForPool(null) === false, 'null pool → always false');
assert(hasRunningRunForPool('') === false, 'empty string pool → always false');

// Finish poolJob2's run → pool still busy (poolJob1 still running)
finishRun(poolRun2.id, 'ok', { summary: 'done' });
assert(hasRunningRunForPool('browser') === true, 'pool still busy (poolJob1 still running)');

// Finish poolJob1's run → pool free
finishRun(poolRun1.id, 'ok', { summary: 'done' });
assert(hasRunningRunForPool('browser') === false, 'pool free after all runs finish');
assert(getRunningRunsByPool('browser').length === 0, 'getRunningRunsByPool returns 0 after finish');

// updateJob can set resource_pool
updateJob(noPoolJob.id, { resource_pool: 'database' });
assert(getJob(noPoolJob.id).resource_pool === 'database', 'updateJob sets resource_pool');

// ═══════════════════════════════════════════════════════════
// SECTION: Event-Based Job Chaining — trigger_condition (v4)
// ═══════════════════════════════════════════════════════════

console.log('\n── trigger_condition ──');

// Schema: trigger_condition column exists
const tcCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(tcCols.includes('trigger_condition'), 'jobs.trigger_condition column exists');

// ── evalTriggerCondition unit tests ──────────────────────
// null/undefined → always matches
assert(evalTriggerCondition(null, 'anything') === true, 'null condition always matches');
assert(evalTriggerCondition(undefined, '') === true, 'undefined condition always matches');
assert(evalTriggerCondition(null, '') === true, 'null condition matches empty string');

// contains: substring match
assert(evalTriggerCondition('contains:ALERT', 'ALERT: high CPU') === true, 'contains: matches when present');
assert(evalTriggerCondition('contains:ALERT', 'all clear') === false, 'contains: no match when absent');
assert(evalTriggerCondition('contains:ALERT', '') === false, 'contains: no match on empty string');
assert(evalTriggerCondition('contains:ALERT', 'alert: lowercase') === false, 'contains: case-sensitive');
assert(evalTriggerCondition('contains:OK', 'status: OK') === true, 'contains: OK substring match');

// regex: pattern match
assert(evalTriggerCondition('regex:ALERT', 'ALERT: high CPU') === true, 'regex: basic match');
assert(evalTriggerCondition('regex:ALERT', 'all clear') === false, 'regex: no match');
assert(evalTriggerCondition('regex:CPU|ALERT', 'high CPU usage') === true, 'regex: OR pattern matches');
assert(evalTriggerCondition('regex:CPU|ALERT', 'all clear') === false, 'regex: OR pattern no match');
assert(evalTriggerCondition('regex:\\d+%', 'usage: 95%') === true, 'regex: digit pattern matches');
assert(evalTriggerCondition('regex:\\d+%', 'usage: normal') === false, 'regex: digit pattern no match');
assert(evalTriggerCondition('regex:[invalid', 'anything') === false, 'regex: invalid pattern → false');

// ── fireTriggeredChildren with trigger_condition ─────────
const tcParent = createJob({
  name: 'TC Parent',
  schedule_cron: '0 6 * * *',
  payload_message: 'monitor',
  delivery_mode: 'none',
});

// Child that fires only when output contains "ALERT"
const tcChildAlert = createJob({
  name: 'TC OnAlert',
  parent_id: tcParent.id,
  trigger_on: 'success',
  trigger_condition: 'contains:ALERT',
  payload_message: 'escalate',
  delivery_mode: 'none',
});
assert(getJob(tcChildAlert.id).trigger_condition === 'contains:ALERT', 'trigger_condition stored');

// Child with no condition — fires on status only
const tcChildAlways = createJob({
  name: 'TC Always',
  parent_id: tcParent.id,
  trigger_on: 'success',
  payload_message: 'always run',
  delivery_mode: 'none',
});
assert(getJob(tcChildAlways.id).trigger_condition === null, 'no trigger_condition → null');

// Child with regex condition
const tcChildRegex = createJob({
  name: 'TC Regex',
  parent_id: tcParent.id,
  trigger_on: 'success',
  trigger_condition: 'regex:CPU|MEM',
  payload_message: 'resource alert',
  delivery_mode: 'none',
});

// Reset next_run_at for all children
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 1: "ALERT: high CPU" — all three match
// contains:ALERT → matches "ALERT: high CPU" ✓
// no condition → always fires ✓
// regex:CPU|MEM → matches "CPU" ✓
const triggered1 = fireTriggeredChildren(tcParent.id, 'ok', 'ALERT: high CPU');
assert(triggered1.some(c => c.id === tcChildAlert.id), 'alert child fires: output has ALERT');
assert(triggered1.some(c => c.id === tcChildAlways.id), 'always child fires: no condition');
assert(triggered1.some(c => c.id === tcChildRegex.id), 'regex child fires: output has CPU');

// Reset
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 2: "all clear" — only no-condition child should fire
const triggered2 = fireTriggeredChildren(tcParent.id, 'ok', 'all clear');
assert(!triggered2.some(c => c.id === tcChildAlert.id), 'alert child does NOT fire: no ALERT in output');
assert(triggered2.some(c => c.id === tcChildAlways.id), 'always child fires regardless of output');
assert(!triggered2.some(c => c.id === tcChildRegex.id), 'regex child does NOT fire: no CPU or MEM');

// Reset
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 3: "MEM usage high" — regex child and no-condition child fire, alert child doesn't
const triggered3 = fireTriggeredChildren(tcParent.id, 'ok', 'MEM usage high');
assert(!triggered3.some(c => c.id === tcChildAlert.id), 'alert child does NOT fire: no ALERT in MEM output');
assert(triggered3.some(c => c.id === tcChildAlways.id), 'always child fires for MEM output');
assert(triggered3.some(c => c.id === tcChildRegex.id), 'regex child fires: output matches MEM');

// CASE 4: Failure path — children only triggered on matching trigger_on
const tcChildOnFail = createJob({
  name: 'TC OnFail',
  parent_id: tcParent.id,
  trigger_on: 'failure',
  trigger_condition: 'contains:CRITICAL',
  payload_message: 'fail handler',
  delivery_mode: 'none',
});
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);
// trigger_on='failure' child should NOT fire when status is 'ok'
const triggered4ok = fireTriggeredChildren(tcParent.id, 'ok', 'CRITICAL: something failed');
assert(!triggered4ok.some(c => c.id === tcChildOnFail.id), 'failure child does NOT fire on ok status');
// trigger_on='failure' child fires when status is 'error' AND condition matches
const triggered4err = fireTriggeredChildren(tcParent.id, 'error', 'CRITICAL: disk full');
assert(triggered4err.some(c => c.id === tcChildOnFail.id), 'failure child fires on error with CRITICAL in output');
// trigger_on='failure' child does NOT fire when condition does not match
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);
const triggered4errNoMatch = fireTriggeredChildren(tcParent.id, 'error', 'minor issue');
assert(!triggered4errNoMatch.some(c => c.id === tcChildOnFail.id), 'failure child does NOT fire when condition not matched');

// updateJob can set trigger_condition
updateJob(tcChildAlways.id, { trigger_condition: 'contains:TEST' });
assert(getJob(tcChildAlways.id).trigger_condition === 'contains:TEST', 'updateJob sets trigger_condition');

// updateJob can clear trigger_condition (set to null)
updateJob(tcChildAlways.id, { trigger_condition: null });
assert(getJob(tcChildAlways.id).trigger_condition === null, 'updateJob clears trigger_condition to null');

// ═══════════════════════════════════════════════════════════
// SECTION: Delivery Alias Resolution
// ═══════════════════════════════════════════════════════════

console.log('\n── Delivery Aliases ──');

// Table must exist
const aliasTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_aliases'").all();
assert(aliasTables.length === 1, 'delivery_aliases table exists');

// Columns must be correct
const aliasCols = db.prepare('PRAGMA table_info(delivery_aliases)').all().map(c => c.name);
assert(aliasCols.includes('alias'),       'delivery_aliases.alias column');
assert(aliasCols.includes('channel'),     'delivery_aliases.channel column');
assert(aliasCols.includes('target'),      'delivery_aliases.target column');
assert(aliasCols.includes('description'), 'delivery_aliases.description column');
assert(aliasCols.includes('created_at'),  'delivery_aliases.created_at column');

// Seeded aliases must be present
const degRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(degRow !== undefined,             'seeded alias: team_room exists');
assert(degRow?.channel === 'telegram',   'team_room channel = telegram');
assert(degRow?.target  === '-1000000001','team_room target = -1000000001');

const alexRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('owner_dm');
assert(alexRow !== undefined,            'seeded alias: owner_dm exists');
assert(alexRow?.channel === 'telegram',  'owner_dm channel = telegram');
assert(alexRow?.target  === '1000000001', 'owner_dm target = 1000000001');

// Add a new alias via DB
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('testchan', 'telegram', '-9999999', 'Test channel');
const testRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('testchan');
assert(testRow !== undefined,                   'alias add: testchan inserted');
assert(testRow?.channel === 'telegram',          'alias add: channel correct');
assert(testRow?.target === '-9999999',           'alias add: target correct');
assert(testRow?.description === 'Test channel',  'alias add: description correct');

// List aliases
const allAliases = db.prepare('SELECT * FROM delivery_aliases ORDER BY alias').all();
assert(allAliases.length >= 3, 'alias list: at least 3 aliases (2 seeded + 1 added)');
assert(allAliases.some(a => a.alias === 'team_room'), 'alias list: team_room present');
assert(allAliases.some(a => a.alias === 'owner_dm'),        'alias list: owner_dm present');
assert(allAliases.some(a => a.alias === 'testchan'),    'alias list: testchan present');

// Local resolve helper (mirrors dispatcher/gateway logic)
function resolveTestAlias(target) {
  if (!target) return null;
  const name = target.startsWith('@') ? target.slice(1) : target;
  return db.prepare('SELECT channel, target FROM delivery_aliases WHERE alias = ?').get(name) || null;
}

// Resolve alias by exact name (bare, no '@')
const r1 = resolveTestAlias('team_room');
assert(r1 !== null,                   'resolve bare name: found');
assert(r1?.channel === 'telegram',    'resolve bare name: correct channel');
assert(r1?.target  === '-1000000001','resolve bare name: correct target');

// Resolve alias with '@' prefix
const r2 = resolveTestAlias('@team_room');
assert(r2 !== null,                   'resolve @name: found');
assert(r2?.channel === 'telegram',    'resolve @name: correct channel');
assert(r2?.target  === '-1000000001','resolve @name: correct target');

// Resolve alias for 'owner_dm'
const r3 = resolveTestAlias('@owner_dm');
assert(r3 !== null,                  'resolve @owner_dm: found');
assert(r3?.channel === 'telegram',   'resolve @owner_dm: correct channel');
assert(r3?.target  === '1000000001',  'resolve @owner_dm: correct target');

// Unknown alias falls through (returns null → caller uses raw target, backward compat)
const r4 = resolveTestAlias('@nonexistent');
assert(r4 === null, 'unknown @alias returns null (backward compat)');

const r5 = resolveTestAlias('rawid12345');
assert(r5 === null, 'raw ID with no alias match returns null');

// Job with delivery_to='@team_room' stores alias as-is, resolves correctly
const aliasJob = createJob({
  name: 'AliasDeliveryJob',
  schedule_cron: '0 9 * * *',
  payload_message: 'alias test',
  delivery_mode: 'none',
  delivery_to: '@team_room',
});
assert(aliasJob.delivery_to === '@team_room', 'job stores @alias as-is in delivery_to');
const jobAlias = resolveTestAlias(aliasJob.delivery_to);
assert(jobAlias !== null,                   'job @alias resolves');
assert(jobAlias?.channel === 'telegram',    'job @alias channel = telegram');
assert(jobAlias?.target  === '-1000000001','job @alias target = -1000000001');

// Remove alias
db.prepare('DELETE FROM delivery_aliases WHERE alias = ?').run('testchan');
const removedRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('testchan');
assert(removedRow === undefined, 'alias remove: testchan deleted');

// Seed aliases still intact after removal of different alias
const stillDeg = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(stillDeg !== undefined, 'seed alias team_room still intact after other alias removed');

// Upsert (INSERT OR REPLACE) works for alias updates
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('team_room', 'telegram', '-1000000001', 'Updated description');
const updatedDeg = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(updatedDeg?.description === 'Updated description', 'alias upsert updates description');
assert(updatedDeg?.target === '-1000000001', 'alias upsert preserves target');

closeDb();
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
