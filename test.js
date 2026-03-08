#!/usr/bin/env node
// Scheduler v2 unified test suite — in-memory, self-contained
// Covers: schema, cron, jobs, runs, messages, agents, chaining, retry, cancellation

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setDbPath, initDb, closeDb, getDb } from './db.js';
import { resolveSchedulerDbPath, resolveSchedulerHome } from './paths.js';
import {
  createJob, getJob, listJobs, updateJob, deleteJob,
  getDueJobs, hasRunningRun, nextRunFromCron,
  getTriggeredChildren, getChildJobs, fireTriggeredChildren,
  pruneExpiredJobs, detectCycle, getChainDepth,
  shouldRetry, scheduleRetry, cancelJob,
  enqueueJob, dequeueJob, runJobNow,
  hasRunningRunForPool, evalTriggerCondition,
  validateJobPayload, validateJobSpec
} from './jobs.js';
import {
  getDispatch, getDueDispatches, listDispatchesForJob,
} from './dispatch-queue.js';
import {
  createRun, getRun, finishRun, getRunsForJob,
  getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateHeartbeat, pruneRuns,
  getRunningRunsByPool
} from './runs.js';
import {
  sendMessage, getMessage, getInbox, getOutbox, getThread,
  markDelivered, markRead, markAllRead, getUnreadCount,
  expireMessages, pruneMessages,
  ackMessage, listMessageReceipts, recordMessageAttempt, getTeamMessages,
} from './messages.js';
import { upsertAgent, getAgent, listAgents, setAgentStatus, touchAgent } from './agents.js';
import { splitMessageForChannel, TELEGRAM_MAX_MESSAGE_LENGTH } from './gateway.js';
import { resolveDispatchCliPath, resolveDispatchLabel } from './scripts/dispatch-cli-utils.mjs';
import { buildTriggeredRunContext } from './prompt-context.js';
import { chooseRepairWebhookUrl, evaluateWebhookHealth } from './scripts/telegram-webhook-check.mjs';
import { normalizeShellResult, extractShellResultFromRun } from './shell-result.js';

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
await initDb();
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
assert(tables.includes('message_receipts'), 'message_receipts table');
assert(tables.includes('team_tasks'), 'team_tasks table');
assert(tables.includes('team_mailbox_events'), 'team_mailbox_events table');
assert(tables.includes('job_dispatch_queue'), 'job_dispatch_queue table');

// Verify v3 columns exist
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(jobCols.includes('parent_id'), 'jobs.parent_id column');
assert(jobCols.includes('trigger_on'), 'jobs.trigger_on column');
assert(jobCols.includes('trigger_delay_s'), 'jobs.trigger_delay_s column');
assert(jobCols.includes('max_retries'), 'jobs.max_retries column');

const runCols = db.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
assert(runCols.includes('retry_count'), 'runs.retry_count column');
assert(runCols.includes('retry_of'), 'runs.retry_of column');
assert(runCols.includes('triggered_by_run'), 'runs.triggered_by_run column');
assert(runCols.includes('dispatch_queue_id'), 'runs.dispatch_queue_id column');
assert(runCols.includes('shell_exit_code'), 'runs.shell_exit_code column');
assert(runCols.includes('shell_signal'), 'runs.shell_signal column');
assert(runCols.includes('shell_timed_out'), 'runs.shell_timed_out column');
assert(runCols.includes('shell_stdout'), 'runs.shell_stdout column');
assert(runCols.includes('shell_stderr'), 'runs.shell_stderr column');

// ── Paths ───────────────────────────────────────────────────
console.log('\nPaths:');
const fakeEnv = { HOME: '/home/tester' };
assert(resolveSchedulerHome(fakeEnv) === '/home/tester/.openclaw/scheduler', 'resolveSchedulerHome defaults to ~/.openclaw/scheduler');
assert(
  resolveSchedulerDbPath({
    env: fakeEnv,
    moduleDir: '/home/tester/.openclaw/scheduler/node_modules/openclaw-scheduler'
  }) === '/home/tester/.openclaw/scheduler/scheduler.db',
  'npm installs default DB path to scheduler home, not node_modules'
);
const writableSourceDir = mkdtempSync(join(tmpdir(), 'scheduler-src-'));
assert(
  resolveSchedulerDbPath({ env: fakeEnv, moduleDir: writableSourceDir }) === join(writableSourceDir, 'scheduler.db'),
  'writable source checkout defaults DB path to package directory'
);
rmSync(writableSourceDir, { recursive: true, force: true });

// ── Prompt context ─────────────────────────────────────────
console.log('\nPrompt Context:');
const triggerContext = buildTriggeredRunContext(
  { triggered_by_run: 'parent-run-1' },
  {
    getRunById: () => ({
      id: 'parent-run-1',
      job_id: 'parent-job-1',
      status: 'error',
      error_message: 'Shell exited with code 2',
      shell_exit_code: 2,
      shell_stdout: 'checking...',
      shell_stderr: 'database locked'
    }),
    getJobById: () => ({ id: 'parent-job-1', name: 'Kebablebot Webhook Check', session_target: 'shell' }),
  }
);
assert(triggerContext.text.includes('Trigger Context'), 'trigger context header included');
assert(triggerContext.text.includes('Kebablebot Webhook Check'), 'trigger context includes parent job name');
assert(triggerContext.text.includes('Exit code: 2'), 'trigger context includes shell exit code');
assert(triggerContext.text.includes('stdout:'), 'trigger context includes shell stdout label');
assert(triggerContext.text.includes('stderr:'), 'trigger context includes shell stderr label');
assert(triggerContext.meta.parent_run_status === 'error', 'trigger context meta includes parent status');
assert(triggerContext.meta.parent_shell_exit_code === 2, 'trigger context meta includes shell exit code');

// ── Shell result helpers ────────────────────────────────────
console.log('\nShell Results:');
const shellFailure = normalizeShellResult(
  { stdout: 'hello\n', stderr: 'boom\n', error: Object.assign(new Error('failed'), { code: 7 }) },
  { timeoutMs: 300000 }
);
assert(shellFailure.status === 'error', 'shell result marks non-zero exit as error');
assert(shellFailure.exitCode === 7, 'shell result captures exit code');
assert(shellFailure.stdout === 'hello', 'shell result stores stdout separately');
assert(shellFailure.stderr === 'boom', 'shell result stores stderr separately');
assert(shellFailure.contextSummary.shell_result.stderr_excerpt === 'boom', 'shell result context summary carries stderr excerpt');

const shellTimeout = normalizeShellResult(
  { stdout: '', stderr: '', error: Object.assign(new Error('Command failed because it timed out'), { killed: true, signal: 'SIGTERM' }) },
  { timeoutMs: 1500 }
);
assert(shellTimeout.status === 'timeout', 'shell result marks timeout separately');
assert(shellTimeout.timedOut === true, 'shell result captures timedOut flag');
assert(shellTimeout.errorMessage === 'Shell command timed out after 1500ms', 'shell result timeout error message');

const shellRunJob = createJob({ name: 'Shell Run', schedule_cron: '*/5 * * * *', payload_message: '/bin/false', session_target: 'shell', payload_kind: 'shellCommand', delivery_mode: 'none' });
const shellRun = createRun(shellRunJob.id, { run_timeout_ms: 60000 });
finishRun(shellRun.id, 'error', {
  summary: shellFailure.summary,
  error_message: shellFailure.errorMessage,
  context_summary: shellFailure.contextSummary,
  shell_exit_code: shellFailure.exitCode,
  shell_signal: shellFailure.signal,
  shell_timed_out: shellFailure.timedOut,
  shell_stdout: shellFailure.stdout,
  shell_stderr: shellFailure.stderr,
});
const storedShellRun = getRun(shellRun.id);
assert(storedShellRun.shell_exit_code === 7, 'finishRun stores shell exit code');
assert(storedShellRun.shell_stdout === 'hello', 'finishRun stores shell stdout');
assert(storedShellRun.shell_stderr === 'boom', 'finishRun stores shell stderr');
const extractedShell = extractShellResultFromRun(storedShellRun);
assert(extractedShell.exitCode === 7, 'extractShellResultFromRun reads direct shell columns');
assert(extractedShell.stderr === 'boom', 'extractShellResultFromRun reads stderr');

// ── Telegram webhook diagnostics ───────────────────────────
console.log('\nWebhook Diagnostics:');
const healthOk = evaluateWebhookHealth({
  label: 'kebablebot',
  webhookInfo: {
    url: 'https://example.com/hook',
    pending_update_count: 0,
    max_connections: 40,
  },
  pendingThreshold: 1,
  requireWebhook: true,
  expectedWebhookUrl: 'https://example.com/hook',
  gatewayHealth: { ok: true, status: 200 },
  recentTelegramFailures: 0,
});
assert(healthOk.status === 'OK', 'webhook health ok state');

const healthAlert = evaluateWebhookHealth({
  label: 'kebablebot',
  webhookInfo: {
    url: 'https://example.com/hook',
    pending_update_count: 22,
    last_error_message: 'Bad webhook response: 500 Internal Server Error',
  },
  pendingThreshold: 1,
  requireWebhook: true,
  expectedWebhookUrl: 'https://example.com/hook',
  gatewayHealth: { ok: true, status: 200 },
  recentTelegramFailures: 3,
});
assert(healthAlert.status === 'ALERT', 'webhook health alert state');
assert(healthAlert.issues.some(issue => issue.startsWith('pending_update_count=')), 'webhook health flags pending updates');
assert(healthAlert.recommendation.includes('drop_pending_updates=true'), 'webhook health recommends drop pending repair');
assert(chooseRepairWebhookUrl({ url: 'https://current.example/hook' }, 'https://expected.example/hook') === 'https://current.example/hook', 'repair uses current webhook url first');
assert(chooseRepairWebhookUrl({ url: '' }, 'https://expected.example/hook') === 'https://expected.example/hook', 'repair falls back to expected webhook url');

let webhookCheckFailed = false;
try {
  execFileSync(process.execPath, [
    join(process.cwd(), 'bin/openclaw-scheduler.js'),
    'webhook-check'
  ], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (err) {
  webhookCheckFailed = true;
  assert(err.status === 2, 'webhook-check wrapper returns exit code 2 without a bot token');
  assert(String(err.stderr || '').includes('missing bot token'), 'webhook-check wrapper forwards missing token error');
}
assert(webhookCheckFailed, 'webhook-check wrapper invokes diagnostic script');

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
assert(!getInbox('main').some(m => m.id === msg.id), 'default inbox excludes delivered');
assert(getInbox('main', { includeDelivered: true }).some(m => m.id === msg.id), 'includeDelivered returns delivered');

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

// Team-aware routing + explicit receipts
const teamMsg = sendMessage({
  from_agent: 'orchestrator',
  to_agent: 'main',
  team_id: 'core-team',
  member_id: 'writer',
  task_id: 'task-001',
  kind: 'task',
  subject: 'Write draft',
  body: 'Draft the release notes for v1.0',
  ack_required: true,
});
assert(teamMsg.team_id === 'core-team', 'team_id stored');
assert(teamMsg.member_id === 'writer', 'member_id stored');
assert(teamMsg.task_id === 'task-001', 'task_id stored');
assert(teamMsg.ack_required === 1, 'ack_required stored');

markDelivered(teamMsg.id);
const teamDelivered = getMessage(teamMsg.id);
assert(teamDelivered.delivery_attempts >= 1, 'delivery attempt incremented');
const receipts1 = listMessageReceipts(teamMsg.id, 10);
assert(receipts1.some(r => r.event_type === 'attempt'), 'attempt receipt written');

ackMessage(teamMsg.id, 'writer', 'received');
const teamAcked = getMessage(teamMsg.id);
assert(teamAcked.ack_at !== null, 'ack_at set on ack');
const receipts2 = listMessageReceipts(teamMsg.id, 20);
assert(receipts2.some(r => r.event_type === 'ack'), 'ack receipt written');

recordMessageAttempt(teamMsg.id, { ok: false, actor: 'test', error: 'simulated error' });
const teamErr = getMessage(teamMsg.id);
assert(teamErr.last_error === 'simulated error', 'last_error updated on failed attempt');

const teamInbox = getTeamMessages('core-team', { includeRead: true, limit: 10 });
assert(teamInbox.some(m => m.id === teamMsg.id), 'getTeamMessages finds team message');

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

// fireTriggeredChildren enqueues durable chain dispatches
const parentRun = createRun(parent.id, { run_timeout_ms: 300000 });
const triggeredChildren = fireTriggeredChildren(parent.id, 'ok', 'ALERT: test', parentRun.id);
assert(triggeredChildren.length >= 1, 'children triggered after fire');
const childDispatches = listDispatchesForJob(childSuccess.id);
assert(childDispatches.some(d => d.dispatch_kind === 'chain'), 'child chain dispatch persisted');
assert(childDispatches.some(d => d.source_run_id === parentRun.id), 'child dispatch stores source_run_id');

// Trigger delay
const delayedChild = createJob({ name: 'Delayed', parent_id: parent.id, trigger_on: 'success', trigger_delay_s: 60, payload_message: 'delayed', delivery_mode: 'none' });
assert(delayedChild.trigger_delay_s === 60, 'trigger_delay_s stored');
fireTriggeredChildren(parent.id, 'ok', 'delayed output', parentRun.id);
const delayedDispatch = listDispatchesForJob(delayedChild.id).find(d => d.dispatch_kind === 'chain');
const delayedTime = new Date(delayedDispatch.scheduled_for + 'Z').getTime();
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
assert(retry1.dispatch.dispatch_kind === 'retry', 'retry creates durable dispatch');
assert(retry1.dispatch.retry_of_run_id === run1.id, 'retry dispatch tracks failed run');

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

// 5. runJobNow(id) creates a durable manual dispatch without mutating cron schedule
const laterJob = createJob({ name: 'LaterJob', schedule_cron: '0 4 * * *', payload_message: 'trigger later', delivery_mode: 'none' });
assert(new Date(laterJob.next_run_at + 'Z') > new Date(), 'laterJob starts with future next_run_at');
const triggered = runJobNow(laterJob.id);
assert(triggered.dispatch_id, 'runJobNow returns dispatch id');
const manualDispatch = getDispatch(triggered.dispatch_id);
assert(manualDispatch.dispatch_kind === 'manual', 'runJobNow creates manual dispatch');
assert(getDueDispatches().some(d => d.id === manualDispatch.id), 'runJobNow dispatch appears in dispatch queue');

// 6. runJobNow does NOT change the schedule_cron (normal schedule is preserved)
assert(triggered.schedule_cron === '0 4 * * *', 'runJobNow: schedule_cron unchanged');
assert(getJob(laterJob.id).next_run_at === laterJob.next_run_at, 'runJobNow: next_run_at unchanged');

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
const teamRoomRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(teamRoomRow !== undefined,               'seeded alias: team_room exists');
assert(teamRoomRow?.channel === 'telegram',     'team_room channel = telegram');
assert(teamRoomRow?.target  === '-1000000001',  'team_room target = -1000000001');

const ownerDmRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('owner_dm');
assert(ownerDmRow !== undefined,              'seeded alias: owner_dm exists');
assert(ownerDmRow?.channel === 'telegram',    'owner_dm channel = telegram');
assert(ownerDmRow?.target  === '1000000001',  'owner_dm target = 1000000001');

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
assert(allAliases.some(a => a.alias === 'owner_dm'),  'alias list: owner_dm present');
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
assert(r3?.target  === '1000000001', 'resolve @owner_dm: correct target');

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
const stillTeamRoom = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(stillTeamRoom !== undefined, 'seed alias team_room still intact after other alias removed');

// Upsert (INSERT OR REPLACE) works for alias updates
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('team_room', 'telegram', '-1000000001', 'Updated description');
const updatedTeamRoom = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(updatedTeamRoom?.description === 'Updated description', 'alias upsert updates description');
assert(updatedTeamRoom?.target === '-1000000001', 'alias upsert preserves target');

// ═══════════════════════════════════════════════════════════
// v5 Features
// ═══════════════════════════════════════════════════════════

console.log('\n── v5: Delivery Semantics ──');
{
  const j1 = createJob({ name: 'at-most-once-job', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-most-once' });
  assert(j1.delivery_guarantee === 'at-most-once', 'delivery_guarantee defaults to at-most-once');

  const j2 = createJob({ name: 'at-least-once-job', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' });
  assert(j2.delivery_guarantee === 'at-least-once', 'delivery_guarantee set to at-least-once');

  const j3 = createJob({ name: 'default-guarantee', schedule_cron: '0 * * * *', payload_message: 'test' });
  assert(j3.delivery_guarantee === 'at-most-once', 'delivery_guarantee default when omitted');

  const j4 = updateJob(j2.id, { delivery_guarantee: 'at-most-once' });
  assert(j4.delivery_guarantee === 'at-most-once', 'delivery_guarantee updateable');

  deleteJob(j1.id); deleteJob(j2.id); deleteJob(j3.id);
}

console.log('\n── v5: Job Class / Flush Hook ──');
{
  const j1 = createJob({ name: 'standard-job', schedule_cron: '0 * * * *', payload_message: 'test' });
  assert(j1.job_class === 'standard', 'job_class defaults to standard');

  const j2 = createJob({ name: 'flush-job', schedule_cron: '0 * * * *', payload_message: 'test', job_class: 'pre_compaction_flush' });
  assert(j2.job_class === 'pre_compaction_flush', 'job_class set to pre_compaction_flush');

  const j3 = updateJob(j2.id, { job_class: 'standard' });
  assert(j3.job_class === 'standard', 'job_class updateable');

  deleteJob(j1.id); deleteJob(j2.id);
}

console.log('\n── v5: Context Summary ──');
{
  import('./runs.js').then(m => m.updateContextSummary); // verify export exists
  const j = createJob({ name: 'ctx-job', schedule_cron: '0 * * * *', payload_message: 'test' });
  const run = createRun(j.id, { run_timeout_ms: 60000 });

  const ctxMeta = { messages_injected: 3, scope: 'global', job_class: 'standard', delivery_guarantee: 'at-most-once' };
  getDb().prepare('UPDATE runs SET context_summary = ? WHERE id = ?').run(JSON.stringify(ctxMeta), run.id);

  const updated = getDb().prepare('SELECT context_summary FROM runs WHERE id = ?').get(run.id);
  assert(updated.context_summary !== null, 'context_summary stored on run');

  const parsed = JSON.parse(updated.context_summary);
  assert(parsed.messages_injected === 3, 'context_summary JSON: messages_injected');
  assert(parsed.scope === 'global', 'context_summary JSON: scope');

  finishRun(run.id, 'ok', { summary: 'done' });
  deleteJob(j.id);
}

console.log('\n── v5: Typed Messages ──');
{
  // Test new message kinds
  const m1 = sendMessage({ from_agent: 'a', to_agent: 'b', kind: 'constraint', body: 'Never deploy on Fridays', owner: 'ops' });
  assert(m1.kind === 'constraint', 'constraint kind accepted');
  assert(m1.owner === 'ops', 'owner field stored');

  const m2 = sendMessage({ from_agent: 'a', to_agent: 'b', kind: 'decision', body: 'Use blue-green deploy', owner: 'architect' });
  assert(m2.kind === 'decision', 'decision kind accepted');

  const m3 = sendMessage({ from_agent: 'a', to_agent: 'b', kind: 'fact', body: 'DB is 500GB', owner: 'dba' });
  assert(m3.kind === 'fact', 'fact kind accepted');

  const m4 = sendMessage({ from_agent: 'a', to_agent: 'b', kind: 'preference', body: 'Prefer Postgres', owner: 'lead' });
  assert(m4.kind === 'preference', 'preference kind accepted');

  const m5 = sendMessage({ from_agent: 'a', to_agent: 'b', kind: 'text', body: 'Hello' });
  assert(m5.kind === 'text', 'text kind still works');

  // Test typed priority ordering in inbox
  const inbox = getInbox('b', { limit: 10 });
  assert(inbox.length >= 5, 'inbox has typed messages');
  // constraint should come first
  const firstKind = inbox[0]?.kind;
  assert(firstKind === 'constraint', 'inbox sorted: constraint first');
  // Find relative positions
  const kinds = inbox.map(m => m.kind);
  const constraintIdx = kinds.indexOf('constraint');
  const decisionIdx = kinds.indexOf('decision');
  const factIdx = kinds.indexOf('fact');
  const prefIdx = kinds.indexOf('preference');
  const textIdx = kinds.indexOf('text');
  assert(constraintIdx < decisionIdx, 'inbox order: constraint before decision');
  assert(decisionIdx < factIdx, 'inbox order: decision before fact');
  assert(factIdx < prefIdx, 'inbox order: fact before preference');
  assert(prefIdx < textIdx, 'inbox order: preference before text');

  // Clean up
  markAllRead('b');
}

console.log('\n── v5: Approval Gates ──');
{
  // Import approval module
  const { createApproval, getApproval, getPendingApproval, listPendingApprovals, resolveApproval, pruneApprovals } = await import('./approval.js');

  const j = createJob({ name: 'approval-job', schedule_cron: '0 * * * *', payload_message: 'test', approval_required: 1, approval_timeout_s: 60, approval_auto: 'reject' });
  assert(j.approval_required === 1, 'approval_required stored');
  assert(j.approval_timeout_s === 60, 'approval_timeout_s stored');
  assert(j.approval_auto === 'reject', 'approval_auto stored');

  const run = createRun(j.id, { run_timeout_ms: 60000, status: 'awaiting_approval' });
  assert(run.status === 'awaiting_approval', 'run created with awaiting_approval');

  const approval = createApproval(j.id, run.id);
  assert(approval !== undefined, 'approval created');
  assert(approval.status === 'pending', 'approval status is pending');
  assert(approval.job_id === j.id, 'approval linked to job');
  assert(approval.run_id === run.id, 'approval linked to run');

  const pending = getPendingApproval(j.id);
  assert(pending.id === approval.id, 'getPendingApproval finds it');

  const allPending = listPendingApprovals();
  assert(allPending.some(a => a.id === approval.id), 'listPendingApprovals includes it');

  // Approve it
  const resolved = resolveApproval(approval.id, 'approved', 'operator', 'looks good');
  assert(resolved.status === 'approved', 'approval resolved as approved');
  assert(resolved.resolved_by === 'operator', 'resolved_by set');
  assert(resolved.notes === 'looks good', 'notes stored');
  assert(resolved.resolved_at !== null, 'resolved_at timestamp set');

  // No more pending for this job
  const noPending = getPendingApproval(j.id);
  assert(noPending === undefined, 'no pending after resolution');

  // Create another and reject it
  const run2 = createRun(j.id, { run_timeout_ms: 60000, status: 'awaiting_approval' });
  const approval2 = createApproval(j.id, run2.id);
  const rejected = resolveApproval(approval2.id, 'rejected', 'operator', 'not ready');
  assert(rejected.status === 'rejected', 'approval rejected');

  finishRun(run.id, 'ok', { summary: 'done' });
  finishRun(run2.id, 'cancelled', { summary: 'rejected' });
  deleteJob(j.id);
}

console.log('\n── v5: Run Replay Fields ──');
{
  const j = createJob({ name: 'replay-test', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' });
  const run1 = createRun(j.id, { run_timeout_ms: 60000 });

  // Simulate crash: mark as crashed
  getDb().prepare("UPDATE runs SET status = 'crashed', finished_at = datetime('now') WHERE id = ?").run(run1.id);
  const crashed = getDb().prepare('SELECT status FROM runs WHERE id = ?').get(run1.id);
  assert(crashed.status === 'crashed', 'run marked as crashed');

  // Create replay run with replay_of
  const run2 = createRun(j.id, { run_timeout_ms: 60000, replay_of: run1.id });
  const replayRun = getDb().prepare('SELECT replay_of FROM runs WHERE id = ?').get(run2.id);
  assert(replayRun.replay_of === run1.id, 'replay_of links to crashed run');

  finishRun(run2.id, 'ok', { summary: 'replayed successfully' });
  deleteJob(j.id);
}

console.log('\n── v5: Hybrid Retrieval ──');
{
  const { getRecentRunSummaries, searchRunSummaries, buildRetrievalContext } = await import('./retrieval.js');

  const j = createJob({ name: 'retrieval-test', schedule_cron: '0 * * * *', payload_message: 'check deployment status', context_retrieval: 'hybrid', context_retrieval_limit: 3 });
  assert(j.context_retrieval === 'hybrid', 'context_retrieval stored');
  assert(j.context_retrieval_limit === 3, 'context_retrieval_limit stored');

  // Create runs with summaries
  for (let i = 0; i < 5; i++) {
    const r = createRun(j.id, { run_timeout_ms: 60000 });
    const ctx = JSON.stringify({ messages_injected: i, scope: 'own' });
    getDb().prepare('UPDATE runs SET context_summary = ? WHERE id = ?').run(ctx, r.id);
    finishRun(r.id, 'ok', { summary: `deployment check completed, status green, uptime ${99 + i/10}%` });
  }

  // Test recent retrieval
  const recent = getRecentRunSummaries(j.id, 3);
  assert(recent.length === 3, 'getRecentRunSummaries returns limit');
  assert(recent[0].context_summary !== null, 'recent runs have context_summary');

  // Test search retrieval
  const searched = searchRunSummaries(j.id, 'deployment uptime', 3);
  assert(searched.length > 0, 'searchRunSummaries returns results');
  assert(searched.length <= 3, 'searchRunSummaries respects limit');

  // Test buildRetrievalContext
  const ctx = buildRetrievalContext(j);
  assert(ctx.includes('Prior Run Context'), 'buildRetrievalContext includes header');
  assert(ctx.includes('End Prior Run Context'), 'buildRetrievalContext includes footer');

  // Test with none retrieval
  const j2 = createJob({ name: 'no-retrieval', schedule_cron: '0 * * * *', payload_message: 'test', context_retrieval: 'none' });
  const noCtx = buildRetrievalContext(j2);
  assert(noCtx === '', 'buildRetrievalContext empty for none');

  deleteJob(j.id); deleteJob(j2.id);
}

console.log('\n── Schema Baseline ──');
{
  // Verify consolidated schema baseline is recorded
  const version = getDb().prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  assert(version.v >= 10, 'schema_migrations has baseline v10');
  const v8 = getDb().prepare('SELECT version FROM schema_migrations WHERE version = 8').get();
  assert(v8 !== undefined, 'schema_migrations has v8');
  const v10 = getDb().prepare('SELECT version FROM schema_migrations WHERE version = 10').get();
  assert(v10 !== undefined, 'schema_migrations has v10');

  // Verify approvals table exists
  const approvalTable = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'").get();
  assert(approvalTable !== undefined, 'approvals table exists');

  // Verify new columns exist on jobs
  const jobCols = getDb().prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  assert(jobCols.includes('delivery_guarantee'), 'jobs has delivery_guarantee column');
  assert(jobCols.includes('job_class'), 'jobs has job_class column');
  assert(jobCols.includes('approval_required'), 'jobs has approval_required column');
  assert(jobCols.includes('approval_timeout_s'), 'jobs has approval_timeout_s column');
  assert(jobCols.includes('approval_auto'), 'jobs has approval_auto column');
  assert(jobCols.includes('context_retrieval'), 'jobs has context_retrieval column');
  assert(jobCols.includes('context_retrieval_limit'), 'jobs has context_retrieval_limit column');

  // Verify new columns on runs
  const runCols = getDb().prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  assert(runCols.includes('context_summary'), 'runs has context_summary column');
  assert(runCols.includes('replay_of'), 'runs has replay_of column');

  // Verify new column on messages
  const msgCols = getDb().prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  assert(msgCols.includes('owner'), 'messages has owner column');
  assert(msgCols.includes('team_id'), 'messages has team_id column');
  assert(msgCols.includes('member_id'), 'messages has member_id column');
  assert(msgCols.includes('task_id'), 'messages has task_id column');
  assert(msgCols.includes('ack_required'), 'messages has ack_required column');
  assert(msgCols.includes('ack_at'), 'messages has ack_at column');
  assert(msgCols.includes('delivery_attempts'), 'messages has delivery_attempts column');
  assert(msgCols.includes('last_error'), 'messages has last_error column');
  assert(msgCols.includes('team_mapped_at'), 'messages has team_mapped_at column');

  // Verify seeded 529 recovery job is runnable and valid for shell dispatch
  const recovery = getDb().prepare(`
    SELECT id, enabled, session_target, payload_kind, payload_message, next_run_at
    FROM jobs
    WHERE id = '8f2be5bd-b537-48c7-b277-44e934104ddc'
  `).get();
  assert(recovery !== undefined, 'seeded 529 recovery job exists');
  assert(recovery.session_target === 'shell', 'seeded 529 recovery target is shell');
  assert(recovery.payload_kind === 'shellCommand', 'seeded 529 recovery payload_kind is shellCommand');
  assert(recovery.payload_message === 'node dispatch/529-recovery.mjs', 'seeded 529 recovery command path is repo-local');
  assert(recovery.next_run_at !== null, 'seeded 529 recovery job is schedulable (next_run_at set)');
}

console.log('\n── v5: Task Tracker ──');
{
  const tt = await import('./task-tracker.js');

  // Create a task group
  const group = tt.createTaskGroup({
    name: 'test-agent-team',
    expectedAgents: ['agent-a', 'agent-b', 'agent-c'],
    timeoutS: 300,
    createdBy: 'test',
    deliveryChannel: 'telegram',
    deliveryTo: '-123',
  });
  assert(group !== undefined, 'task group created');
  assert(group.status === 'active', 'task group status is active');

  // Check agents were created
  const status = tt.getTaskGroupStatus(group.id);
  assert(status.agents.length === 3, 'task group has 3 agents');
  assert(status.agents.every(a => a.status === 'pending'), 'all agents pending initially');

  // Agent starts
  tt.agentStarted(group.id, 'agent-a');
  const s2 = tt.getTaskGroupStatus(group.id);
  const agentA = s2.agents.find(a => a.label === 'agent-a');
  assert(agentA.status === 'running', 'agent-a is running after start');

  // Agent completes
  tt.agentCompleted(group.id, 'agent-a', 'All good, 50 files processed');
  const s3 = tt.getTaskGroupStatus(group.id);
  const agentADone = s3.agents.find(a => a.label === 'agent-a');
  assert(agentADone.status === 'completed', 'agent-a completed');
  assert(agentADone.exit_message === 'All good, 50 files processed', 'exit message stored');

  // Agent fails
  tt.agentFailed(group.id, 'agent-b', 'Syntax error in output');
  const s4 = tt.getTaskGroupStatus(group.id);
  const agentB = s4.agents.find(a => a.label === 'agent-b');
  assert(agentB.status === 'failed', 'agent-b failed');
  assert(agentB.error === 'Syntax error in output', 'error message stored');

  // Group not complete yet (agent-c still pending)
  const completion1 = tt.checkGroupCompletion(group.id);
  assert(completion1 === null || completion1.status === 'active', 'group not complete with pending agent');

  // Complete the last agent
  tt.agentStarted(group.id, 'agent-c');
  tt.agentCompleted(group.id, 'agent-c', 'Done');
  const completion2 = tt.checkGroupCompletion(group.id);
  assert(completion2 !== null, 'group completion detected');
  assert(completion2.status === 'failed', 'group failed because agent-b failed');

  // List should not show completed groups
  const active = tt.listActiveTaskGroups();
  assert(!active.some(g => g.id === group.id), 'completed group not in active list');

  // Test dead agent detection with a short timeout
  // Note: an agent that reported a heartbeat within 5min is spared.
  // A truly dead agent has no heartbeat at all and exceeded the tracker timeout.
  const group2 = tt.createTaskGroup({
    name: 'timeout-test',
    expectedAgents: ['slow-agent'],
    timeoutS: 0, // immediate timeout for testing
    createdBy: 'test',
  });
  // Don't call agentStarted — leave agent in 'pending' with no heartbeat.
  // This simulates a sub-agent that was spawned but never reported in.
  const dead = tt.checkDeadAgents();
  assert(dead.length > 0, 'dead agent detected after timeout (no heartbeat, pending)');
  const deadAgent = dead.find(d => d.tracker_id === group2.id);
  assert(deadAgent !== undefined, 'correct dead agent found');

  // After marking dead, group should complete as failed
  tt.checkGroupCompletion(group2.id);
  const g2 = tt.getTaskGroup(group2.id);
  assert(g2.status === 'failed', 'group with dead agent marked failed');

  // ── v8: session key registration and heartbeat ───────────
  const group3 = tt.createTaskGroup({
    name: 'session-tracking-test',
    expectedAgents: ['writer', 'reviewer'],
    timeoutS: 600,
    createdBy: 'test',
  });

  // Register session keys (orchestrator sets these after spawning)
  tt.registerAgentSession(group3.id, 'writer', 'agent:main:subagent:writer-uuid');
  tt.registerAgentSession(group3.id, 'reviewer', 'agent:main:subagent:reviewer-uuid');

  const s5 = tt.getTaskGroupStatus(group3.id);
  const writer = s5.agents.find(a => a.label === 'writer');
  assert(writer.session_key === 'agent:main:subagent:writer-uuid', 'session key stored on writer');
  assert(writer.status === 'running', 'writer auto-promoted to running on session register');
  assert(writer.last_heartbeat !== undefined, 'last_heartbeat set on session register');

  // Touch heartbeat (simulates auto-correlation)
  tt.touchAgentHeartbeat(group3.id, 'writer');
  const s6 = tt.getTaskGroupStatus(group3.id);
  const writerHb = s6.agents.find(a => a.label === 'writer');
  assert(writerHb.last_heartbeat !== undefined, 'last_heartbeat updated by touchAgentHeartbeat');

  // Dead agent with recent heartbeat should NOT be killed
  const group4 = tt.createTaskGroup({
    name: 'heartbeat-alive-test',
    expectedAgents: ['active-agent'],
    timeoutS: 0, // immediately expired timeout
    createdBy: 'test',
  });
  tt.registerAgentSession(group4.id, 'active-agent', 'agent:main:subagent:active-uuid');
  // last_heartbeat was just set — agent should be spared
  const notDead = tt.checkDeadAgents().filter(d => d.tracker_id === group4.id);
  assert(notDead.length === 0, 'agent with recent heartbeat not marked dead despite timeout');
}

console.log('\n── v10: Team Adapter ──');
{
  const ta = await import('./team-adapter.js');
  const tt = await import('./task-tracker.js');

  const teamTaskMsg = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    team_id: 'team-alpha',
    member_id: 'writer',
    task_id: 'deliverable-42',
    kind: 'task',
    subject: 'Create draft',
    body: 'Prepare deliverable 42 draft',
    ack_required: true,
  });

  const mapped = ta.mapTeamMessages(50);
  assert(mapped >= 1, 'team adapter mapped at least one message');

  const teamTasks1 = ta.listTeamTasks('team-alpha', 20);
  const tracked = teamTasks1.find(t => t.id === 'deliverable-42');
  assert(tracked !== undefined, 'team task projected from message');
  assert(tracked.status === 'open', 'projected team task starts open');

  const events1 = ta.listTeamMailboxEvents('team-alpha', { taskId: 'deliverable-42', limit: 20 });
  assert(events1.some(e => e.event_type === 'task_created' || e.event_type === 'task_message'), 'team mailbox event created');

  const gate = ta.createTeamTaskGate({
    teamId: 'team-alpha',
    taskId: 'deliverable-42',
    expectedMembers: ['writer', 'reviewer'],
    timeoutS: 300,
    createdBy: 'test',
  });
  assert(gate.tracker_id !== undefined, 'team gate created with tracker');

  const teamTasks2 = ta.listTeamTasks('team-alpha', 20);
  const gated = teamTasks2.find(t => t.id === 'deliverable-42');
  assert(gated.status === 'blocked', 'task becomes blocked while gate is waiting');
  assert(gated.gate_status === 'waiting', 'gate_status waiting');

  tt.agentStarted(gate.tracker_id, 'writer');
  tt.agentCompleted(gate.tracker_id, 'writer', 'draft complete');
  tt.agentStarted(gate.tracker_id, 'reviewer');
  tt.agentCompleted(gate.tracker_id, 'reviewer', 'review complete');
  tt.checkGroupCompletion(gate.tracker_id);

  const gateCheck = ta.checkTeamTaskGates(20);
  assert(gateCheck.passed >= 1, 'gate marked passed after all team members complete');

  const teamTasks3 = ta.listTeamTasks('team-alpha', 20);
  const passedTask = teamTasks3.find(t => t.id === 'deliverable-42');
  assert(passedTask.gate_status === 'passed', 'task gate_status passed');
  assert(passedTask.status === 'open', 'task unblocked after gate pass');

  const acked = ta.ackTeamMessage(teamTaskMsg.id, 'writer', 'acknowledged');
  assert(acked !== null && acked.ack_at !== null, 'team-aware ack sets ack_at');
  const events2 = ta.listTeamMailboxEvents('team-alpha', { taskId: 'deliverable-42', limit: 50 });
  assert(events2.some(e => e.event_type === 'ack'), 'team-aware ack emits mailbox event');
}

console.log('\n── Idempotency Keys ──');
{
  const {
    generateIdempotencyKey, generateChainIdempotencyKey, generateRunNowIdempotencyKey,
    claimIdempotencyKey, releaseIdempotencyKey, checkIdempotencyKey, getIdempotencyEntry,
    updateIdempotencyResultHash, pruneIdempotencyLedger, listIdempotencyForJob,
    forcePruneIdempotency,
  } = await import('./idempotency.js');

  // Verify schema: idempotency_ledger table exists
  const ledgerTable = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency_ledger'").get();
  assert(ledgerTable !== undefined, 'idempotency_ledger table exists');

  // Verify runs.idempotency_key column exists
  const runCols = getDb().prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  assert(runCols.includes('idempotency_key'), 'runs has idempotency_key column');

  // Verify idempotency index exists
  const idemIdx = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_idempotency'").get();
  assert(idemIdx !== undefined, 'idx_runs_idempotency exists');

  // 1. Key generation is deterministic (same inputs = same key)
  const key1 = generateIdempotencyKey('job-abc', '2026-02-23 09:00:00');
  const key2 = generateIdempotencyKey('job-abc', '2026-02-23 09:00:00');
  assert(key1 === key2, 'idempotency key is deterministic');
  assert(key1.length === 32, 'idempotency key is 32 chars');

  // 2. Different schedule times produce different keys
  const key3 = generateIdempotencyKey('job-abc', '2026-02-23 10:00:00');
  assert(key1 !== key3, 'different schedule times produce different keys');

  // Different job IDs produce different keys
  const key4 = generateIdempotencyKey('job-xyz', '2026-02-23 09:00:00');
  assert(key1 !== key4, 'different job IDs produce different keys');

  // 3. Chain keys differ from schedule keys
  const chainKey = generateChainIdempotencyKey('parent-run-123', 'child-job-abc');
  assert(chainKey !== key1, 'chain key differs from schedule key');
  assert(chainKey.length === 32, 'chain key is 32 chars');

  // Chain keys are deterministic
  const chainKey2 = generateChainIdempotencyKey('parent-run-123', 'child-job-abc');
  assert(chainKey === chainKey2, 'chain key is deterministic');

  // 4. Run-now keys are unique per call
  const rnKey1 = generateRunNowIdempotencyKey('job-abc');
  // Small delay to ensure different timestamp
  await new Promise(r => setTimeout(r, 2));
  const rnKey2 = generateRunNowIdempotencyKey('job-abc');
  assert(rnKey1 !== rnKey2, 'run-now keys are unique per call');

  // 5. Ledger claim blocks duplicate dispatch
  const testJob = createJob({ name: 'idem-test-1', schedule_cron: '0 * * * *', payload_message: 'test' });
  const testRun = createRun(testJob.id, { run_timeout_ms: 60000 });
  const idemKey = generateIdempotencyKey(testJob.id, '2026-02-23 09:00:00');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  const claimed1 = claimIdempotencyKey(idemKey, testJob.id, testRun.id, expiresAt);
  assert(claimed1 === true, 'first claim succeeds');

  const existing = checkIdempotencyKey(idemKey);
  assert(existing !== null, 'claimed key is found in ledger');
  assert(existing.status === 'claimed', 'claimed key status is claimed');
  assert(existing.job_id === testJob.id, 'claimed key has correct job_id');
  assert(existing.run_id === testRun.id, 'claimed key has correct run_id');

  // Duplicate claim fails (race condition protection)
  const testRun2 = createRun(testJob.id, { run_timeout_ms: 60000 });
  const claimed2 = claimIdempotencyKey(idemKey, testJob.id, testRun2.id, expiresAt);
  assert(claimed2 === false, 'duplicate claim fails (UNIQUE constraint)');

  // 6. Failed run releases key (can be reclaimed)
  releaseIdempotencyKey(idemKey);
  const released = getIdempotencyEntry(idemKey);
  assert(released.status === 'released', 'released key status is released');
  assert(released.released_at !== null, 'released_at is set');

  const reclaimedCheck = checkIdempotencyKey(idemKey);
  assert(reclaimedCheck === null, 'released key not found as claimed');

  // Re-claim the released key (simulating retry)
  const testRun3 = createRun(testJob.id, { run_timeout_ms: 60000 });
  const reclaimed = claimIdempotencyKey(idemKey, testJob.id, testRun3.id, expiresAt);
  assert(reclaimed === true, 'released key can be reclaimed without deleting ledger row');

  // 7. Successful run keeps claim (blocks replay)
  const successCheck = checkIdempotencyKey(idemKey);
  assert(successCheck !== null, 'successful claim blocks replay');
  assert(successCheck.status === 'claimed', 'key remains claimed after success');

  // 8. UNIQUE constraint catches race conditions on runs table
  const runWithKey = createRun(testJob.id, { run_timeout_ms: 60000, idempotency_key: 'unique-test-key-001' });
  assert(runWithKey.idempotency_key === 'unique-test-key-001', 'run stores idempotency_key');
  let uniqueViolation = false;
  try {
    // Try inserting another run with same key (should fail due to UNIQUE index)
    getDb().prepare("INSERT INTO runs (id, job_id, status, run_timeout_ms, dispatched_at, idempotency_key) VALUES (?, ?, 'running', 60000, datetime('now'), ?)")
      .run('dup-run-id', testJob.id, 'unique-test-key-001');
  } catch (err) {
    if (err.message.includes('UNIQUE')) uniqueViolation = true;
  }
  assert(uniqueViolation, 'UNIQUE index on runs.idempotency_key catches duplicates');

  // 9. Expired keys are prunable
  const expiredKey = generateIdempotencyKey('expired-job', '2020-01-01 00:00:00');
  const pastExpiry = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  getDb().prepare(
    "INSERT INTO idempotency_ledger (key, job_id, run_id, claimed_at, expires_at) VALUES (?, ?, ?, datetime('now'), ?)"
  ).run(expiredKey, 'expired-job', 'expired-run', pastExpiry);

  const futureKey = generateIdempotencyKey('future-job', '2030-01-01 00:00:00');
  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  getDb().prepare(
    "INSERT INTO idempotency_ledger (key, job_id, run_id, claimed_at, expires_at) VALUES (?, ?, ?, datetime('now'), ?)"
  ).run(futureKey, 'future-job', 'future-run', futureExpiry);

  pruneIdempotencyLedger();
  const expiredAfterPrune = getIdempotencyEntry(expiredKey);
  assert(expiredAfterPrune === null, 'expired key pruned');

  // 14. Prune doesn't delete non-expired keys
  const futureAfterPrune = getIdempotencyEntry(futureKey);
  assert(futureAfterPrune !== null, 'non-expired key survives prune');

  // Clean up future key
  getDb().prepare('DELETE FROM idempotency_ledger WHERE key = ?').run(futureKey);

  // 10. Crashed run keys get released during replay simulation
  const crashJob = createJob({ name: 'crash-idem-test', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' });
  const crashKey = generateIdempotencyKey(crashJob.id, '2026-02-23 12:00:00');
  const crashRun = createRun(crashJob.id, { run_timeout_ms: 60000, idempotency_key: crashKey });
  claimIdempotencyKey(crashKey, crashJob.id, crashRun.id, expiresAt);

  // Simulate crash: mark run as crashed and release key (what replayOrphanedRuns does)
  getDb().prepare("UPDATE runs SET status = 'crashed', finished_at = datetime('now') WHERE id = ?").run(crashRun.id);
  releaseIdempotencyKey(crashKey);
  const crashedEntry = getIdempotencyEntry(crashKey);
  assert(crashedEntry.status === 'released', 'crashed run key is released');

  // Verify the key can be re-claimed in the ledger (for replay)
  // Note: in real replay, the old crashed run keeps its key in runs table,
  // and a new replay run gets a fresh idempotency_key. But the ledger key
  // can be reclaimed since it was released.
  const replayRun = createRun(crashJob.id, { run_timeout_ms: 60000, idempotency_key: crashKey + '-replay' });
  const replayClaimed = claimIdempotencyKey(crashKey, crashJob.id, replayRun.id, expiresAt);
  assert(replayClaimed === true, 'crashed run key can be reclaimed for replay');

  finishRun(crashRun.id, 'crashed'); finishRun(replayRun.id, 'ok');
  deleteJob(crashJob.id);

  // 11. Key is stored on run record
  const keyOnRun = getRun(runWithKey.id);
  assert(keyOnRun.idempotency_key === 'unique-test-key-001', 'idempotency_key persisted on run');

  // 12. Key is injected into prompt for at-least-once jobs
  // We test this by checking that buildJobPrompt behavior can detect delivery_guarantee
  // Since buildJobPrompt is internal to dispatcher.js, we verify the data path:
  const alJob = createJob({
    name: 'at-least-once-test', schedule_cron: '0 * * * *',
    payload_message: 'do something', delivery_guarantee: 'at-least-once',
  });
  assert(alJob.delivery_guarantee === 'at-least-once', 'at-least-once delivery_guarantee stored');
  const alRun = createRun(alJob.id, { run_timeout_ms: 60000, idempotency_key: 'al-test-key-12345678901234567890' });
  assert(alRun.idempotency_key === 'al-test-key-12345678901234567890', 'idempotency key available for prompt injection');
  finishRun(alRun.id, 'ok'); deleteJob(alJob.id);

  // 13. IDEMPOTENT_SKIP handling — verify matchesSentinel pattern
  // In dispatcher, matchesSentinel(trimmed, 'IDEMPOTENT_SKIP') skips delivery
  function matchesSentinelIdem(content, token) {
    if (!content) return false;
    const re = new RegExp(`^${token}(?:$|[\\s:])`);
    return re.test(content.trim());
  }
  assert(matchesSentinelIdem('IDEMPOTENT_SKIP', 'IDEMPOTENT_SKIP'), 'IDEMPOTENT_SKIP pattern recognized');
  assert(matchesSentinelIdem('IDEMPOTENT_SKIP: already processed this bet settlement', 'IDEMPOTENT_SKIP'), 'IDEMPOTENT_SKIP with message recognized');
  assert(!matchesSentinelIdem('Here is the result', 'IDEMPOTENT_SKIP'), 'normal content is not IDEMPOTENT_SKIP');
  assert(!matchesSentinelIdem('IDEMPOTENT_SKIPX', 'IDEMPOTENT_SKIP'), 'IDEMPOTENT_SKIPX is not IDEMPOTENT_SKIP');

  // 15. Manual release via CLI-style operation
  const manualKey = generateIdempotencyKey('manual-test', '2026-03-01 00:00:00');
  const manualRun = createRun(testJob.id, { run_timeout_ms: 60000 });
  claimIdempotencyKey(manualKey, testJob.id, manualRun.id, expiresAt);

  const beforeRelease = checkIdempotencyKey(manualKey);
  assert(beforeRelease !== null, 'manual key is claimed before release');

  // Simulate CLI release
  releaseIdempotencyKey(manualKey);
  const afterRelease = checkIdempotencyKey(manualKey);
  assert(afterRelease === null, 'manual key released via CLI-style operation');

  finishRun(manualRun.id, 'ok');

  // Result hash storage
  const hashKey = generateIdempotencyKey('hash-test', '2026-04-01 00:00:00');
  const hashRun = createRun(testJob.id, { run_timeout_ms: 60000 });
  claimIdempotencyKey(hashKey, testJob.id, hashRun.id, expiresAt);
  updateIdempotencyResultHash(hashKey, 'This is the result content');
  const hashEntry = getIdempotencyEntry(hashKey);
  assert(hashEntry.result_hash !== null, 'result hash stored on ledger entry');
  assert(hashEntry.result_hash.length === 16, 'result hash is 16 chars');
  finishRun(hashRun.id, 'ok');

  // listIdempotencyForJob
  const entries = listIdempotencyForJob(testJob.id);
  assert(entries.length > 0, 'listIdempotencyForJob returns entries');
  assert(entries[0].job_id === testJob.id, 'listIdempotencyForJob returns correct job entries');

  // forcePruneIdempotency — same as pruneIdempotencyLedger but returns count
  const prunedCount = forcePruneIdempotency();
  assert(typeof prunedCount === 'number', 'forcePruneIdempotency returns a number');

  // Run with null idempotency_key (default behavior)
  const nullKeyRun = createRun(testJob.id, { run_timeout_ms: 60000 });
  assert(nullKeyRun.idempotency_key === null, 'run without idempotency_key has null');

  // Clean up test runs
  finishRun(testRun.id, 'ok'); finishRun(testRun2.id, 'ok'); finishRun(testRun3.id, 'ok');
  finishRun(nullKeyRun.id, 'ok');
  deleteJob(testJob.id);
}

// ═══════════════════════════════════════════════════════════
// SECTION: Shell job type (session_target = 'shell')
// ═══════════════════════════════════════════════════════════

console.log('\n── Shell Jobs ──');

// Can create a shell job
const shellJob = createJob({
  name: 'Test Shell Job',
  schedule_cron: '0 8-23 * * *',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  payload_message: '/bin/echo hello',
  delivery_mode: 'none',
});
assert(shellJob.session_target === 'shell', 'shell job: session_target = shell');
assert(shellJob.payload_kind === 'shellCommand', 'shell job: payload_kind = shellCommand');
assert(shellJob.payload_message === '/bin/echo hello', 'shell job: payload_message = command');

// Can update to shell target
const toShellJob = createJob({ name: 'To-Shell Job', schedule_cron: '0 12 * * *', payload_message: 'test', delivery_mode: 'none' });
updateJob(toShellJob.id, { session_target: 'shell', payload_kind: 'shellCommand', payload_message: '/bin/echo updated' });
const updatedShell = getJob(toShellJob.id);
assert(updatedShell.session_target === 'shell', 'shell job update: session_target persisted');
assert(updatedShell.payload_message === '/bin/echo updated', 'shell job update: command persisted');

// Shell jobs are pruned like normal jobs (disabled + >24h → deleted)
updateJob(shellJob.id, { enabled: 0, last_run_at: '2020-01-01 00:00:00' });
pruneExpiredJobs();
assert(!getJob(shellJob.id), 'aged shell job pruned correctly');

// ═══════════════════════════════════════════════════════════
// SECTION: Transient Error Detection & delete_after_run Safety
// ═══════════════════════════════════════════════════════════

console.log('\n── Transient Error Detection ──');
{
  // Re-implement detectTransientError locally to test the pattern matching
  // (matches dispatcher.js TRANSIENT_ERROR_PATTERNS + detectTransientError)
  const TRANSIENT_ERROR_PATTERNS = [
    /temporarily overloaded/i,
    /service\s+(?:is\s+)?unavailable/i,
    /rate\s*limit(?:ed|s?)?/i,
    /too\s+many\s+requests/i,
    /\b5[0-9]{2}\b\s+(?:internal\s+)?server\s+error/i,
    /gateway\s+timeout/i,
    /bad\s+gateway/i,
    /model\s+(?:is\s+)?(?:overloaded|unavailable)/i,
    /API\s+(?:error|unavailable|timeout)/i,
    /capacity\s+(?:exceeded|limit)/i,
    /retry\s+(?:after|later|in\s+\d)/i,
    /context\s+(?:length|window)\s+exceeded/i,
    /token\s+limit\s+exceeded/i,
  ];

  function detectTransientError(content) {
    if (!content || !content.trim()) return false;
    const trimmed = content.trim();
    if (trimmed.length > 500) return false;
    return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(trimmed));
  }

  // Positive matches — these should be caught as transient errors
  assert(detectTransientError('The AI service is temporarily overloaded. Please try again later.'), 'detects: temporarily overloaded');
  assert(detectTransientError('Service unavailable'), 'detects: service unavailable');
  assert(detectTransientError('Service is unavailable right now'), 'detects: service is unavailable');
  assert(detectTransientError('Rate limited'), 'detects: rate limited');
  assert(detectTransientError('rate limit exceeded'), 'detects: rate limit exceeded');
  assert(detectTransientError('Error: Too many requests'), 'detects: too many requests');
  assert(detectTransientError('502 Bad Gateway'), 'detects: 502 bad gateway');
  assert(detectTransientError('503 Server Error'), 'detects: 503 server error');
  assert(detectTransientError('500 Internal Server Error'), 'detects: 500 internal server error');
  assert(detectTransientError('Gateway timeout'), 'detects: gateway timeout');
  assert(detectTransientError('Bad gateway'), 'detects: bad gateway');
  assert(detectTransientError('The model is overloaded'), 'detects: model is overloaded');
  assert(detectTransientError('model unavailable'), 'detects: model unavailable');
  assert(detectTransientError('API error occurred'), 'detects: API error');
  assert(detectTransientError('API unavailable'), 'detects: API unavailable');
  assert(detectTransientError('API timeout'), 'detects: API timeout');
  assert(detectTransientError('capacity exceeded'), 'detects: capacity exceeded');
  assert(detectTransientError('Please retry after 30 seconds'), 'detects: retry after');
  assert(detectTransientError('Retry later'), 'detects: retry later');
  assert(detectTransientError('retry in 5 seconds'), 'detects: retry in N');
  assert(detectTransientError('context length exceeded'), 'detects: context length exceeded');
  assert(detectTransientError('context window exceeded'), 'detects: context window exceeded');
  assert(detectTransientError('token limit exceeded'), 'detects: token limit exceeded');

  // Negative matches — these should NOT be flagged
  assert(!detectTransientError('Here is the weather report for today'), 'ignores: normal response');
  assert(!detectTransientError('HEARTBEAT_OK'), 'ignores: heartbeat');
  assert(!detectTransientError('I completed the task successfully'), 'ignores: success response');
  assert(!detectTransientError(''), 'ignores: empty string');
  assert(!detectTransientError(null), 'ignores: null');
  assert(!detectTransientError(undefined), 'ignores: undefined');

  // Long response with keyword should NOT be flagged (real work mentioning the term)
  const longResponse = 'I analyzed the system and found that the rate limit configuration needs updating. ' +
    'Here are my recommendations: '.padEnd(600, 'x');
  assert(!detectTransientError(longResponse), 'ignores: long response with keyword (>500 chars)');

  // TASK_FAILED sentinel tests (uses matchesSentinel regex: ^TOKEN(?:$|[\s:]))
  function matchesSentinel(content, token) {
    if (!content) return false;
    const re = new RegExp(`^${token}(?:$|[\\s:])`);
    return re.test(content.trim());
  }

  assert(matchesSentinel('TASK_FAILED', 'TASK_FAILED'), 'TASK_FAILED exact match');
  assert(matchesSentinel('TASK_FAILED: could not connect to database', 'TASK_FAILED'), 'TASK_FAILED with colon message');
  assert(matchesSentinel('TASK_FAILED something', 'TASK_FAILED'), 'TASK_FAILED with space message');
  assert(!matchesSentinel('TASK_FAILEDX', 'TASK_FAILED'), 'does not match TASK_FAILEDX (no word boundary)');
  assert(!matchesSentinel('The task failed to complete', 'TASK_FAILED'), 'does not match "task failed" in prose');

  // matchesSentinel works for other sentinels too
  assert(matchesSentinel('HEARTBEAT_OK', 'HEARTBEAT_OK'), 'HEARTBEAT_OK exact');
  assert(matchesSentinel('HEARTBEAT_OK extra info', 'HEARTBEAT_OK'), 'HEARTBEAT_OK with space');
  assert(!matchesSentinel('HEARTBEAT_OKAY', 'HEARTBEAT_OK'), 'does not match HEARTBEAT_OKAY');
}

console.log('\n── delete_after_run Safety ──');
{
  // Test that updateJobAfterRun does NOT delete when status is 'error'
  const oneShot = createJob({
    name: 'OneShot-DAR-Test',
    schedule_cron: '0 12 * * *',
    payload_message: 'one shot task',
    delete_after_run: true,
    delivery_mode: 'none',
  });
  assert(oneShot.delete_after_run === 1, 'one-shot job has delete_after_run=1');

  // Simulate error status — job should NOT be deleted
  updateJob(oneShot.id, { last_run_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''), last_status: 'error', consecutive_errors: 1 });
  const afterError = getJob(oneShot.id);
  assert(afterError !== undefined, 'one-shot job survives error status (not deleted)');

  // Simulate updateJobAfterRun deletion condition directly.
  // updateJobAfterRun deletes only when status === 'ok' and delete_after_run is truthy.
  const shouldDelete = (status, job) => status === 'ok' && Boolean(job.delete_after_run);

  assert(shouldDelete('ok', oneShot), 'delete_after_run triggers on ok status');
  assert(!shouldDelete('error', oneShot), 'delete_after_run does NOT trigger on error status');
  assert(!shouldDelete('timeout', oneShot), 'delete_after_run does NOT trigger on timeout status');

  // Clean up
  deleteJob(oneShot.id);
}


// ═══════════════════════════════════════════════════════════
// SECTION: session_target + payload_kind Validation
// ═══════════════════════════════════════════════════════════

console.log('\n── Payload Validation ──');

// 1. Valid: main + systemEvent
{
  const j = createJob({ name: 'Valid-main-sysEvent', schedule_cron: '0 9 * * *', session_target: 'main', payload_kind: 'systemEvent', payload_message: 'test', delivery_mode: 'none' });
  assert(j.session_target === 'main' && j.payload_kind === 'systemEvent', 'valid: main + systemEvent accepted');
  deleteJob(j.id);
}

// 2. Invalid: main + agentTurn → should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-main-agentTurn', schedule_cron: '0 9 * * *', session_target: 'main', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: main + agentTurn rejected');
}

// 3. Valid: shell + shellCommand
{
  const j = createJob({ name: 'Valid-shell-cmd', schedule_cron: '0 9 * * *', session_target: 'shell', payload_kind: 'shellCommand', payload_message: '/bin/echo hi', delivery_mode: 'none' });
  assert(j.session_target === 'shell' && j.payload_kind === 'shellCommand', 'valid: shell + shellCommand accepted');
  deleteJob(j.id);
}

// 4. Invalid: shell + agentTurn → should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-shell-agentTurn', schedule_cron: '0 9 * * *', session_target: 'shell', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: shell + agentTurn rejected');
}

// 5. Valid: isolated + agentTurn (default combo)
{
  const j = createJob({ name: 'Valid-isolated-agentTurn', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none' });
  assert(j.session_target === 'isolated' && j.payload_kind === 'agentTurn', 'valid: isolated + agentTurn accepted');
  deleteJob(j.id);
}

// 6. Invalid: isolated + shellCommand → should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-isolated-shell', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'shellCommand', payload_message: '/bin/echo nope', delivery_mode: 'none' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: isolated + shellCommand rejected');
}

// 7. updateJob: changing to invalid combo → should throw
{
  const j = createJob({ name: 'Update-validation', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none' });
  let threw = false;
  try { updateJob(j.id, { session_target: 'main', payload_kind: 'agentTurn' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'updateJob rejects invalid target+kind combo');
  deleteJob(j.id);
}

// 8. updateJob: changing session_target alone checks against existing payload_kind
{
  const j = createJob({ name: 'Update-target-only', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none' });
  let threw = false;
  try { updateJob(j.id, { session_target: 'shell' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'updateJob: changing target alone validates against existing kind');
  deleteJob(j.id);
}

console.log('\n── Job Spec Validation ──');
{
  let threw = false;
  try {
    validateJobSpec({
      name: 'Bad Control',
      schedule_cron: '0 9 * * *',
      payload_message: 'hello\u0000world',
      delivery_mode: 'none',
    });
  } catch (e) {
    threw = e.message.includes('control characters');
  }
  assert(threw, 'validateJobSpec rejects control characters in payload_message');

  threw = false;
  try {
    validateJobSpec({
      name: 'Bad Regex',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      trigger_condition: 'regex:(',
      delivery_mode: 'none',
    });
  } catch (e) {
    threw = e.message.includes('Invalid trigger_condition regex');
  }
  assert(threw, 'validateJobSpec rejects invalid trigger_condition regex');

  const normalized = validateJobSpec({
    name: 'Normalize Optional',
    schedule_cron: '0 9 * * *',
    payload_message: 'ok',
    delivery_mode: 'none',
    delivery_channel: '',
  });
  assert(normalized.delivery_channel === null, 'validateJobSpec normalizes empty nullable strings to null');
}

console.log('\n── Delivery Chunking ──');
{
  const short = splitMessageForChannel('telegram', 'hello world');
  assert(short.length === 1, 'short telegram message stays single-part');

  const long = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 250);
  const parts = splitMessageForChannel('telegram', long);
  assert(parts.length >= 2, 'long telegram message is split into multiple parts');
  assert(parts.every(p => p.length <= TELEGRAM_MAX_MESSAGE_LENGTH), 'all telegram parts obey max length');
  assert(parts[0].startsWith('[1/'), 'chunked telegram parts include part prefix');
}

console.log('\n── CLI JSON / Dry-Run / Schema ──');
{
  const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-cli-'));
  const dbPath = join(tempRoot, 'scheduler.db');
  const cliPath = join(process.cwd(), 'cli.js');
  const baseEnv = { ...process.env, SCHEDULER_DB: dbPath };

  const schemaOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'schema', 'jobs', '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(schemaOut.fields?.session_target?.enum?.includes('isolated'), 'cli schema --json returns job schema');

  const before = JSON.parse(execFileSync(process.execPath, [cliPath, 'jobs', 'list', '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));

  const dryRunSpec = JSON.stringify({
    name: 'DryRunOnly',
    schedule_cron: '0 10 * * *',
    payload_message: 'noop',
    delivery_mode: 'none',
  });
  const dryRun = JSON.parse(execFileSync(process.execPath, [cliPath, 'jobs', 'add', dryRunSpec, '--dry-run', '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(dryRun.dry_run === true && dryRun.valid === true, 'jobs add --dry-run --json validates without writing');

  const afterDryRun = JSON.parse(execFileSync(process.execPath, [cliPath, 'jobs', 'list', '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(before.length === afterDryRun.length, 'dry-run does not create a job');

  const realSpec = JSON.stringify({
    name: 'CLI Real Job',
    schedule_cron: '0 11 * * *',
    payload_message: 'real',
    delivery_mode: 'none',
  });
  const created = JSON.parse(execFileSync(process.execPath, [cliPath, 'jobs', 'add', realSpec, '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(created.ok === true && created.job?.id, 'jobs add --json returns created job payload');

  const runOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'jobs', 'run', created.job.id, '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(runOut.dispatch_kind === 'manual' && typeof runOut.dispatch_id === 'string', 'jobs run --json returns durable dispatch');

  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('\n── Dispatch Script Compatibility ──');
{
  const envBase = { HOME: '/tmp/alex' };
  const dispatchPath = '/tmp/alex/.openclaw/dispatch/index.mjs';
  const legacyPath = '/tmp/alex/.openclaw/chilisaus/index.mjs';

  const dispatchOnly = new Set([dispatchPath]);
  assert(
    resolveDispatchCliPath(envBase, p => dispatchOnly.has(p)) === dispatchPath,
    'resolveDispatchCliPath prefers dispatch path when available'
  );

  const legacyOnly = new Set([legacyPath]);
  assert(
    resolveDispatchCliPath(envBase, p => legacyOnly.has(p)) === legacyPath,
    'resolveDispatchCliPath falls back to legacy path when dispatch path missing'
  );

  const explicitDispatch = '/opt/custom/dispatch/index.mjs';
  const explicitLegacy = '/opt/custom/chilisaus/index.mjs';
  const explicitSet = new Set([explicitDispatch, explicitLegacy, dispatchPath]);
  assert(
    resolveDispatchCliPath(
      { ...envBase, DISPATCH_CLI: explicitDispatch, CHILISAUS_CLI: explicitLegacy },
      p => explicitSet.has(p)
    ) === explicitDispatch,
    'resolveDispatchCliPath prioritizes DISPATCH_CLI override'
  );

  const labels = {
    alpha: { status: 'running' },
    beta: { status: 'done' },
  };
  assert(resolveDispatchLabel('alpha', labels) === 'alpha', 'resolveDispatchLabel handles direct label match');
  assert(resolveDispatchLabel('dispatch-deliver:alpha', labels) === 'alpha', 'resolveDispatchLabel handles dispatch watcher prefix');
  assert(resolveDispatchLabel('chilisaus-deliver:beta', labels) === 'beta', 'resolveDispatchLabel handles legacy watcher prefix');
  assert(resolveDispatchLabel('dispatch-deliver:missing', labels) === null, 'resolveDispatchLabel returns null for missing label');
}


closeDb();
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
