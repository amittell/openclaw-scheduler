#!/usr/bin/env node
// Scheduler v2 tests — jobs, runs, messages, agents
import { initDb, closeDb, getDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, getDueJobs, hasRunningRun, nextRunFromCron } from './jobs.js';
import { createRun, getRun, finishRun, getRunsForJob, getStaleRuns, getTimedOutRuns, getRunningRuns, updateHeartbeat, pruneRuns } from './runs.js';
import { sendMessage, getMessage, getInbox, getOutbox, getThread, markDelivered, markRead, markAllRead, getUnreadCount, expireMessages, pruneMessages } from './messages.js';
import { upsertAgent, getAgent, listAgents, setAgentStatus, touchAgent } from './agents.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

process.env.SCHEDULER_DB = ':memory:';

console.log('🧪 Running scheduler v2 tests...\n');

// ── Schema ──────────────────────────────────────────────────
console.log('Schema:');
initDb();
const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
assert(tables.includes('jobs'), 'jobs table');
assert(tables.includes('runs'), 'runs table');
assert(tables.includes('messages'), 'messages table');
assert(tables.includes('agents'), 'agents table');

// ── Cron parsing ────────────────────────────────────────────
console.log('\nCron:');
const next = nextRunFromCron('0 9 * * *', 'America/New_York');
assert(next !== null, `nextRunFromCron: ${next}`);

// ── Job CRUD ────────────────────────────────────────────────
console.log('\nJobs:');
const job = createJob({ name: 'Test Job', schedule_cron: '*/5 * * * *', payload_message: 'Hello' });
assert(job && job.name === 'Test Job', 'createJob');
assert(job.enabled === 1, 'enabled by default');
assert(job.next_run_at !== null, 'next_run_at calculated');
assert(getJob(job.id).id === job.id, 'getJob');
updateJob(job.id, { name: 'Updated' });
assert(getJob(job.id).name === 'Updated', 'updateJob');
assert(listJobs().length >= 1, 'listJobs');

// ── Due jobs ────────────────────────────────────────────────
console.log('\nDue jobs:');
const dueJob = createJob({ name: 'Due', schedule_cron: '* * * * *', payload_message: 'due' });
getDb().prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").run(dueJob.id);
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
console.log('\nStale detection:');
const staleRun = createRun(job.id, { run_timeout_ms: 1000 });
getDb().prepare("UPDATE runs SET last_heartbeat = datetime('now', '-120 seconds') WHERE id = ?").run(staleRun.id);
assert(getStaleRuns(90).some(r => r.id === staleRun.id), 'stale run detected');

// ── Timeout detection ───────────────────────────────────────
console.log('\nTimeout:');
const toRun = createRun(job.id, { run_timeout_ms: 1 });
getDb().prepare("UPDATE runs SET started_at = datetime('now', '-10 seconds') WHERE id = ?").run(toRun.id);
assert(getTimedOutRuns().some(r => r.id === toRun.id), 'timeout detected');

// ── Agents ──────────────────────────────────────────────────
console.log('\nAgents:');
const agent = upsertAgent('main', { name: 'Main Agent', capabilities: ['*'] });
assert(agent.id === 'main', 'upsertAgent creates');
assert(agent.name === 'Main Agent', 'agent name');
assert(Array.isArray(agent.capabilities), 'capabilities parsed');
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
assert(msg.from_agent === 'scheduler', 'from_agent');
assert(msg.to_agent === 'main', 'to_agent');

const msg2 = sendMessage({ from_agent: 'main', to_agent: 'scheduler', body: 'Got it', reply_to: msg.id });
assert(msg2.reply_to === msg.id, 'reply threading');

// Inbox
const inbox = getInbox('main');
assert(inbox.length >= 1, `inbox has messages (${inbox.length})`);
assert(inbox.some(m => m.id === msg.id), 'message in inbox');

// Outbox
const outbox = getOutbox('scheduler');
assert(outbox.some(m => m.id === msg.id), 'message in outbox');

// Thread
const thread = getThread(msg.id);
assert(thread.length === 2, `thread has 2 messages (got ${thread.length})`);

// Unread count
assert(getUnreadCount('main') >= 1, 'unread count > 0');

// Mark delivered
markDelivered(msg.id);
assert(getMessage(msg.id).status === 'delivered', 'markDelivered');

// Mark read
markRead(msg.id);
assert(getMessage(msg.id).status === 'read', 'markRead');
assert(getMessage(msg.id).read_at !== null, 'read_at set');

// Mark all read
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'msg A' });
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'msg B' });
const before = getUnreadCount('main');
markAllRead('main');
assert(getUnreadCount('main') === 0, `markAllRead (was ${before}, now 0)`);

// Priority ordering
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'normal', priority: 0 });
sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'urgent', priority: 2 });
const prioritized = getInbox('main');
assert(prioritized[0].priority >= prioritized[prioritized.length - 1].priority, 'priority ordering');

// Broadcast
sendMessage({ from_agent: 'scheduler', to_agent: 'broadcast', body: 'all agents' });
const bcast = getInbox('main');
assert(bcast.some(m => m.to_agent === 'broadcast'), 'broadcast received');

// Expiry
const expMsg = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'expires', expires_at: '2020-01-01T00:00:00Z' });
expireMessages();
assert(getMessage(expMsg.id).status === 'expired', 'expiry works');

// Metadata
const metaMsg = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'with meta', metadata: { key: 'value' } });
assert(getMessage(metaMsg.id).metadata?.key === 'value', 'metadata stored and parsed');

// ── Cascade delete ──────────────────────────────────────────
console.log('\nCascade delete:');
const delJob = createJob({ name: 'Deletable', schedule_cron: '0 * * * *', payload_message: 'bye' });
createRun(delJob.id);
deleteJob(delJob.id);
assert(!getJob(delJob.id), 'job deleted');
assert(getRunsForJob(delJob.id).length === 0, 'runs cascade deleted');

// ── Prune ───────────────────────────────────────────────────
console.log('\nPrune:');
for (let i = 0; i < 5; i++) { const r = createRun(job.id); finishRun(r.id, 'ok'); }
pruneRuns(3);
assert(getRunsForJob(job.id).length <= 3, 'pruneRuns');

pruneMessages(0); // prune everything older than 0 days
// (won't prune pending ones, only read/expired)

// ── Done ────────────────────────────────────────────────────
closeDb();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
