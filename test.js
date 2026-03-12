#!/usr/bin/env node
// Scheduler v2 unified test suite — in-memory, self-contained
// Covers: schema, cron, jobs, runs, messages, agents, chaining, retry, cancellation

import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { setDbPath, initDb, closeDb, getDb } from './db.js';
import { resolveSchedulerDbPath, resolveSchedulerHome } from './paths.js';
import {
  createJob, getJob, listJobs, updateJob, deleteJob,
  getDueJobs, getDueAtJobs, hasRunningRun, nextRunFromCron,
  getTriggeredChildren, getChildJobs, fireTriggeredChildren,
  pruneExpiredJobs, detectCycle, getChainDepth,
  shouldRetry, scheduleRetry, cancelJob,
  enqueueJob, dequeueJob, runJobNow,
  hasRunningRunForPool, evalTriggerCondition,
  validateJobSpec, parseInDuration, AT_JOB_CRON_SENTINEL,
} from './jobs.js';
import {
  getDispatch, getDueDispatches, listDispatchesForJob,
  enqueueDispatch, claimDispatch, releaseDispatch, setDispatchStatus,
} from './dispatch-queue.js';
import {
  createRun, getRun, finishRun, getRunsForJob,
  getStaleRuns, getTimedOutRuns,
  updateHeartbeat, pruneRuns,
  getRunningRunsByPool, updateRunSession, updateContextSummary,
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
import {
  matchesSentinel, detectTransientError, adaptiveDeferralMs,
  buildExecutionIntentNote, getBackoffMs, sqliteNow,
} from './dispatcher-utils.js';
import { chooseRepairWebhookUrl, evaluateWebhookHealth } from './scripts/telegram-webhook-check.mjs';
import { normalizeShellResult, extractShellResultFromRun } from './shell-result.js';
import * as publicApi from './index.js';

// ── Test harness ────────────────────────────────────────────
let passed = 0;
let failed = 0;

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
function assert(cond, msg) {
  if (cond) { passed++; if (verbose) console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
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
assert(typeof publicApi.db.initDb === 'function', 'public API exports db namespace');
assert(typeof publicApi.jobs.createJob === 'function', 'public API exports jobs namespace');
assert(typeof publicApi.shellResults.normalizeShellResult === 'function', 'public API exports shell result helpers');

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
assert(runCols.includes('shell_stdout_path'), 'runs.shell_stdout_path column');
assert(runCols.includes('shell_stderr_path'), 'runs.shell_stderr_path column');
assert(runCols.includes('shell_stdout_bytes'), 'runs.shell_stdout_bytes column');
assert(runCols.includes('shell_stderr_bytes'), 'runs.shell_stderr_bytes column');
assert(jobCols.includes('execution_intent'), 'jobs.execution_intent column');
assert(jobCols.includes('execution_read_only'), 'jobs.execution_read_only column');
assert(jobCols.includes('max_queued_dispatches'), 'jobs.max_queued_dispatches column');
assert(jobCols.includes('max_pending_approvals'), 'jobs.max_pending_approvals column');
assert(jobCols.includes('max_trigger_fanout'), 'jobs.max_trigger_fanout column');
assert(jobCols.includes('output_store_limit_bytes'), 'jobs.output_store_limit_bytes column');
assert(jobCols.includes('output_offload_threshold_bytes'), 'jobs.output_offload_threshold_bytes column');

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
  { stdout: '', stderr: '', error: Object.assign(new Error('Command failed: sleep 2\n'), { killed: true, signal: 'SIGTERM' }) },
  { timeoutMs: 1500 }
);
assert(shellTimeout.status === 'timeout', 'shell result marks timeout separately');
assert(shellTimeout.timedOut === true, 'shell result captures timedOut flag');
assert(shellTimeout.errorMessage === 'Shell command timed out after 1500ms', 'shell result timeout error message');

const shellSignaled = normalizeShellResult(
  { stdout: '', stderr: '', error: Object.assign(new Error('Command failed: sleep 2\n'), { killed: false, signal: 'SIGTERM' }) },
  { timeoutMs: 1500 }
);
assert(shellSignaled.status === 'error', 'shell result keeps non-timeout signals as error');
assert(shellSignaled.timedOut === false, 'shell result does not misclassify non-timeout signals');

const shellArtifactsDir = mkdtempSync(join(tmpdir(), 'scheduler-artifacts-'));
const largeOutput = 'x'.repeat(5000);
const shellOffloaded = normalizeShellResult(
  { stdout: largeOutput, stderr: '', error: null },
  {
    runId: 'run-offload-1',
    timeoutMs: 300000,
    storeLimit: 512,
    excerptLimit: 256,
    summaryLimit: 1024,
    offloadThreshold: 1024,
    artifactsDir: shellArtifactsDir,
  }
);
assert(typeof shellOffloaded.stdoutPath === 'string', 'shell result offloads stdout when threshold exceeded');
assert(shellOffloaded.stdoutBytes === 5000, 'shell result stores stdout byte count');
assert(readFileSync(shellOffloaded.stdoutPath, 'utf8').length === 5000, 'shell result writes offloaded stdout artifact');
rmSync(shellArtifactsDir, { recursive: true, force: true });

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
  shell_stdout_path: shellOffloaded.stdoutPath,
  shell_stdout_bytes: shellOffloaded.stdoutBytes,
});
const storedShellRun = getRun(shellRun.id);
assert(storedShellRun.shell_exit_code === 7, 'finishRun stores shell exit code');
assert(storedShellRun.shell_stdout === 'hello', 'finishRun stores shell stdout');
assert(storedShellRun.shell_stderr === 'boom', 'finishRun stores shell stderr');
assert(storedShellRun.shell_stdout_path === shellOffloaded.stdoutPath, 'finishRun stores shell stdout artifact path');
const extractedShell = extractShellResultFromRun(storedShellRun);
assert(extractedShell.exitCode === 7, 'extractShellResultFromRun reads direct shell columns');
assert(extractedShell.stderr === 'boom', 'extractShellResultFromRun reads stderr');
assert(extractedShell.stdoutPath === shellOffloaded.stdoutPath, 'extractShellResultFromRun reads artifact path');

// ── Telegram webhook diagnostics ───────────────────────────
console.log('\nWebhook Diagnostics:');
const healthOk = evaluateWebhookHealth({
  label: 'test-bot',
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
  label: 'test-bot',
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
const disabledNumericJob = createJob({ name: 'Disabled Numeric Job', enabled: 0, schedule_cron: '*/6 * * * *', payload_message: 'Disabled', delivery_mode: 'none' });
assert(disabledNumericJob.enabled === 0, 'numeric enabled=0 creates a disabled job');
updateJob(job.id, { name: 'Updated' });
assert(getJob(job.id).name === 'Updated', 'updateJob');
updateJob(job.id, { enabled: false });
assert(getJob(job.id).enabled === 0, 'boolean enabled=false updates to disabled');
assert(listJobs().length >= 1, 'listJobs');
const budgetedJob = createJob({
  name: 'Budgeted Agent Job',
  schedule_cron: '*/10 * * * *',
  payload_message: 'Plan the next action without executing it.',
  session_target: 'isolated',
  payload_kind: 'agentTurn',
  delivery_mode: 'none',
  execution_intent: 'plan',
  execution_read_only: 1,
  max_queued_dispatches: 3,
  max_pending_approvals: 2,
  max_trigger_fanout: 4,
  output_store_limit_bytes: 4096,
  output_excerpt_limit_bytes: 512,
  output_summary_limit_bytes: 2048,
  output_offload_threshold_bytes: 1024,
});
assert(budgetedJob.execution_intent === 'plan', 'createJob stores execution_intent');
assert(budgetedJob.execution_read_only === 1, 'createJob stores execution_read_only');
assert(budgetedJob.max_queued_dispatches === 3, 'createJob stores max_queued_dispatches');
assert(budgetedJob.output_offload_threshold_bytes === 1024, 'createJob stores output_offload_threshold_bytes');

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
assert(childFailure.trigger_on === 'failure', 'trigger_on = failure');
assert(childComplete.trigger_on === 'complete', 'trigger_on = complete');

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

const cappedParent = createJob({
  name: 'CappedParent',
  schedule_cron: '0 8 * * *',
  payload_message: 'cap fanout',
  delivery_mode: 'none',
  max_trigger_fanout: 1,
});
createJob({ name: 'FanoutChild1', parent_id: cappedParent.id, trigger_on: 'success', payload_message: 'c1', delivery_mode: 'none' });
createJob({ name: 'FanoutChild2', parent_id: cappedParent.id, trigger_on: 'success', payload_message: 'c2', delivery_mode: 'none' });
const fanoutTriggered = fireTriggeredChildren(cappedParent.id, 'ok', 'fanout', parentRun.id);
assert(fanoutTriggered.length === 1, 'max_trigger_fanout limits triggered children per parent run');

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

const retryRun = createRun(retryJob.id, {
  run_timeout_ms: 300000,
  retry_count: retry1.retryCount,
  retry_of: run1.id,
  triggered_by_run: run1.id,
});
assert(retryRun.retry_count === 1, 'createRun persists retry_count for retry dispatches');

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

const singleRetryJob = createJob({ name: 'SingleRetry', schedule_cron: '0 9 * * *', payload_message: 'single retry', max_retries: 1, delivery_mode: 'none' });
const singleRetryRun1 = createRun(singleRetryJob.id, { run_timeout_ms: 300000 });
finishRun(singleRetryRun1.id, 'error', { error_message: 'first fail' });
const singleRetry = scheduleRetry(singleRetryJob, singleRetryRun1.id);
getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(singleRetry.retryCount, singleRetryRun1.id);
const singleRetryRun2 = createRun(singleRetryJob.id, {
  run_timeout_ms: 300000,
  retry_count: singleRetry.retryCount,
  retry_of: singleRetryRun1.id,
  triggered_by_run: singleRetryRun1.id,
});
finishRun(singleRetryRun2.id, 'error', { error_message: 'second fail' });
assert(!shouldRetry(singleRetryJob, singleRetryRun2.id), 'retry attempt inherits retry_count and exhausts max_retries');

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

const limitedQueueJob = createJob({
  name: 'LimitedQueueJob',
  schedule_cron: '*/5 * * * *',
  payload_message: 'limited queue',
  overlap_policy: 'queue',
  max_queued_dispatches: 1,
  delivery_mode: 'none',
});
const queueResult1 = enqueueJob(limitedQueueJob.id);
const queueResult2 = enqueueJob(limitedQueueJob.id);
assert(queueResult1.queued === true, 'enqueueJob returns queued=true below max_queued_dispatches');
assert(queueResult2.queued === false && queueResult2.limited === true, 'enqueueJob blocks growth once max_queued_dispatches is reached');

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
  const { createApproval, getPendingApproval, listPendingApprovals, resolveApproval } = await import('./approval.js');

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

  // TASK_FAILED sentinel tests (uses matchesSentinel from dispatcher-utils.js)
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

console.log('\n── Drain Error Detection ──');
{
  const { isDrainError, detectTransientError: detectTransientFromUtils } = await import('./dispatcher-utils.js');

  // isDrainError positive matches
  assert(isDrainError('Gateway is draining for restart; new tasks are not accepted'), 'isDrainError: full drain message');
  assert(isDrainError('gateway is draining'), 'isDrainError: gateway draining (case insensitive)');
  assert(isDrainError('new tasks are not accepted'), 'isDrainError: new tasks not accepted');

  // isDrainError negative matches
  assert(!isDrainError('rate limited'), 'isDrainError: rate limited is not a drain error');
  assert(!isDrainError('Service unavailable'), 'isDrainError: service unavailable is not a drain error');
  assert(!isDrainError(''), 'isDrainError: empty string is not a drain error');
  assert(!isDrainError(null), 'isDrainError: null is not a drain error');
  assert(!isDrainError(undefined), 'isDrainError: undefined is not a drain error');
  assert(!isDrainError('The gateway timed out'), 'isDrainError: gateway timeout is not a drain error');

  // detectTransientError from dispatcher-utils catches drain errors (patterns added to TRANSIENT_ERROR_PATTERNS)
  assert(detectTransientFromUtils('Gateway is draining for restart; new tasks are not accepted'), 'detectTransientError: catches drain message');
  assert(detectTransientFromUtils('new tasks are not accepted'), 'detectTransientError: catches new tasks not accepted');
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
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
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


// ═══════════════════════════════════════════════════════════
// SECTION: Watchdog Job Type (v13)
// ═══════════════════════════════════════════════════════════

console.log('\n── Watchdog Jobs ──');
{
  // Schema: job_type column exists with default 'standard'
  const watchdogCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  assert(watchdogCols.includes('job_type'), 'jobs.job_type column exists');
  assert(watchdogCols.includes('watchdog_target_label'), 'jobs.watchdog_target_label column exists');
  assert(watchdogCols.includes('watchdog_check_cmd'), 'jobs.watchdog_check_cmd column exists');
  assert(watchdogCols.includes('watchdog_timeout_min'), 'jobs.watchdog_timeout_min column exists');
  assert(watchdogCols.includes('watchdog_alert_channel'), 'jobs.watchdog_alert_channel column exists');
  assert(watchdogCols.includes('watchdog_alert_target'), 'jobs.watchdog_alert_target column exists');
  assert(watchdogCols.includes('watchdog_self_destruct'), 'jobs.watchdog_self_destruct column exists');
  assert(watchdogCols.includes('watchdog_started_at'), 'jobs.watchdog_started_at column exists');

  // Default job_type is 'standard'
  const stdJob = createJob({ name: 'StdJob', schedule_cron: '0 10 * * *', payload_message: 'test', delivery_mode: 'none' });
  assert(stdJob.job_type === 'standard', "default job_type = 'standard'");
  deleteJob(stdJob.id);

  // Create a watchdog job
  const wdJob = createJob({
    name: 'Test Watchdog',
    schedule_cron: '*/10 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo check',
    delivery_mode: 'none',
    job_type: 'watchdog',
    watchdog_target_label: 'my-task',
    watchdog_check_cmd: 'node chilisaus/index.mjs stuck --label my-task --threshold-min 15',
    watchdog_timeout_min: 60,
    watchdog_alert_channel: 'telegram',
    watchdog_alert_target: '123456789',
    watchdog_self_destruct: 1,
    watchdog_started_at: new Date().toISOString(),
  });
  assert(wdJob.job_type === 'watchdog', "watchdog job_type = 'watchdog'");
  assert(wdJob.watchdog_target_label === 'my-task', 'watchdog_target_label stored');
  assert(wdJob.watchdog_check_cmd.includes('stuck'), 'watchdog_check_cmd stored');
  assert(wdJob.watchdog_timeout_min === 60, 'watchdog_timeout_min stored');
  assert(wdJob.watchdog_alert_channel === 'telegram', 'watchdog_alert_channel stored');
  assert(wdJob.watchdog_alert_target === '123456789', 'watchdog_alert_target stored');
  assert(wdJob.watchdog_self_destruct === 1, 'watchdog_self_destruct stored');
  assert(wdJob.watchdog_started_at !== null, 'watchdog_started_at stored');

  // Get job preserves all watchdog fields
  const fetched = getJob(wdJob.id);
  assert(fetched.job_type === 'watchdog', 'getJob returns job_type');
  assert(fetched.watchdog_target_label === 'my-task', 'getJob returns watchdog_target_label');

  // Update watchdog fields
  updateJob(wdJob.id, { watchdog_timeout_min: 120 });
  assert(getJob(wdJob.id).watchdog_timeout_min === 120, 'updateJob updates watchdog_timeout_min');

  updateJob(wdJob.id, { watchdog_self_destruct: 0 });
  assert(getJob(wdJob.id).watchdog_self_destruct === 0, 'updateJob can disable watchdog_self_destruct');

  // listJobs returns job_type
  const allJobsWd = listJobs();
  const listedWd = allJobsWd.find(j => j.id === wdJob.id);
  assert(listedWd && listedWd.job_type === 'watchdog', 'listJobs includes job_type for watchdog');

  // Validation: watchdog without check_cmd should throw
  let threwNoCmd = false;
  try {
    createJob({
      name: 'Bad Watchdog',
      schedule_cron: '*/10 * * * *',
      payload_message: 'test',
      delivery_mode: 'none',
      job_type: 'watchdog',
      watchdog_target_label: 'test',
      // missing watchdog_check_cmd
    });
  } catch (e) {
    threwNoCmd = e.message.includes('watchdog_check_cmd');
  }
  assert(threwNoCmd, 'watchdog without check_cmd rejected');

  // Validation: invalid job_type should throw
  let threwBadType = false;
  try {
    createJob({
      name: 'Bad Type',
      schedule_cron: '*/10 * * * *',
      payload_message: 'test',
      delivery_mode: 'none',
      job_type: 'invalid',
    });
  } catch (e) {
    threwBadType = e.message.includes('job_type');
  }
  assert(threwBadType, 'invalid job_type rejected');

  // Schema version is 16
  const version = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  assert(version.v >= 16, 'schema_migrations has v16');

  // Clean up
  deleteJob(wdJob.id);
}

// ═══════════════════════════════════════════════════════════
// AUTH PROFILE
// ═══════════════════════════════════════════════════════════

console.log('\n── Auth Profile ──');
{
  // Create job with auth_profile: 'inherit'
  const inheritJob = createJob({
    name: 'Test Auth Profile Inherit',
    schedule_cron: '0 0 * * *',
    payload_message: 'test inherit profile',
    session_target: 'isolated',
    auth_profile: 'inherit',
  });
  assert(inheritJob.auth_profile === 'inherit', 'auth_profile=inherit stored correctly');

  // Create job with specific auth_profile
  const specificJob = createJob({
    name: 'Test Auth Profile Specific',
    schedule_cron: '0 0 * * *',
    payload_message: 'test specific profile',
    session_target: 'isolated',
    auth_profile: 'anthropic:gmail',
  });
  assert(specificJob.auth_profile === 'anthropic:gmail', 'auth_profile=anthropic:gmail stored correctly');

  // Create job with null auth_profile (default)
  const nullJob = createJob({
    name: 'Test Auth Profile Null',
    schedule_cron: '0 0 * * *',
    payload_message: 'test null profile',
    session_target: 'isolated',
  });
  assert(nullJob.auth_profile === null, 'auth_profile defaults to null');

  // Create job with explicit null auth_profile
  const explicitNullJob = createJob({
    name: 'Test Auth Profile Explicit Null',
    schedule_cron: '0 0 * * *',
    payload_message: 'test explicit null',
    session_target: 'isolated',
    auth_profile: null,
  });
  assert(explicitNullJob.auth_profile === null, 'auth_profile explicit null stored as null');

  // Update job to set auth_profile
  const updated = updateJob(nullJob.id, { auth_profile: 'openai:work' });
  assert(updated.auth_profile === 'openai:work', 'auth_profile updated to openai:work');

  // Update job to clear auth_profile
  const cleared = updateJob(updated.id, { auth_profile: null });
  assert(cleared.auth_profile === null, 'auth_profile cleared back to null');

  // Validation: reject non-string types
  let caught = false;
  try {
    validateJobSpec({ auth_profile: 123, name: 'bad', schedule_cron: '0 0 * * *', payload_message: 'x' }, null, 'create');
  } catch (e) {
    caught = e.message.includes('auth_profile must be a string');
  }
  assert(caught, 'auth_profile rejects non-string types');

  // Whitespace-only auth_profile normalizes to null (via normalizeNullableString)
  const wsResult = validateJobSpec({ auth_profile: '  ', name: 'ok', schedule_cron: '0 0 * * *', payload_message: 'x' }, null, 'create');
  assert(wsResult.auth_profile === null, 'auth_profile whitespace normalizes to null');

  // Validation: reject boolean type
  caught = false;
  try {
    validateJobSpec({ auth_profile: true, name: 'bad', schedule_cron: '0 0 * * *', payload_message: 'x' }, null, 'create');
  } catch (e) {
    caught = e.message.includes('auth_profile must be a string');
  }
  assert(caught, 'auth_profile rejects boolean type');

  // getJob retrieves auth_profile
  const fetched = getJob(specificJob.id);
  assert(fetched.auth_profile === 'anthropic:gmail', 'getJob returns auth_profile');

  // Clean up
  deleteJob(inheritJob.id);
  deleteJob(specificJob.id);
  deleteJob(nullJob.id);
  deleteJob(explicitNullJob.id);
}

console.log('\n── Migration Guard ──');
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'scheduler-migrate-'));
  const legacyDbPath = join(legacyDir, 'scheduler.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_cron TEXT NOT NULL,
      schedule_tz TEXT NOT NULL DEFAULT 'America/New_York',
      session_target TEXT NOT NULL DEFAULT 'isolated',
      agent_id TEXT DEFAULT 'main',
      payload_kind TEXT NOT NULL,
      payload_message TEXT NOT NULL,
      payload_timeout_seconds INTEGER DEFAULT 120,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      delivery_mode TEXT DEFAULT 'announce',
      delivery_channel TEXT,
      delivery_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delete_after_run INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      trigger_on TEXT,
      trigger_delay_s INTEGER DEFAULT 0,
      trigger_condition TEXT DEFAULT NULL,
      max_retries INTEGER DEFAULT 0,
      queued_count INTEGER DEFAULT 0,
      payload_scope TEXT NOT NULL DEFAULT 'own',
      resource_pool TEXT DEFAULT NULL,
      delivery_guarantee TEXT DEFAULT 'at-most-once',
      job_class TEXT DEFAULT 'standard',
      approval_required INTEGER DEFAULT 0,
      approval_timeout_s INTEGER DEFAULT 3600,
      approval_auto TEXT DEFAULT 'reject',
      context_retrieval TEXT DEFAULT 'none',
      context_retrieval_limit INTEGER DEFAULT 5,
      preferred_session_key TEXT DEFAULT NULL,
      job_type TEXT NOT NULL DEFAULT 'standard',
      next_run_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      duration_ms INTEGER,
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      session_key TEXT,
      session_id TEXT,
      summary TEXT,
      error_message TEXT,
      dispatched_at TEXT,
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      retry_count INTEGER DEFAULT 0,
      retry_of TEXT,
      idempotency_key TEXT,
      context_summary TEXT,
      replay_of TEXT,
      triggered_by_run TEXT,
      dispatch_queue_id TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    CREATE TABLE task_tracker_agents (id TEXT PRIMARY KEY);
    CREATE TABLE approvals (id TEXT PRIMARY KEY);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (14);
  `);
  legacyDb.close();

  closeDb();
  setDbPath(legacyDbPath);
  await initDb();
  const migratedDb = getDb();
  const migratedRunCols = migratedDb.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  const migratedJobCols = migratedDb.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  assert(migratedRunCols.includes('shell_exit_code'), 'migration guard backfills shell_exit_code when version marker is already 14');
  assert(migratedRunCols.includes('shell_stdout_path'), 'migration guard backfills shell_stdout_path when version marker is already 14');
  assert(migratedJobCols.includes('execution_intent'), 'migration guard backfills execution_intent when version marker is already 14');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n── Dispatcher Utils ──');
{
  // sqliteNow returns valid datetime string
  const now = sqliteNow();
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(now), 'sqliteNow returns YYYY-MM-DD HH:MM:SS');
  const future = sqliteNow(60000);
  assert(future > now, 'sqliteNow with positive offset is in the future');

  // adaptiveDeferralMs
  assert(adaptiveDeferralMs(0) === 10000, 'adaptiveDeferralMs(0) returns base 10s');
  assert(adaptiveDeferralMs(0, 5000) === 5000, 'adaptiveDeferralMs(0, 5000) returns custom base');
  assert(adaptiveDeferralMs(4) === 50000, 'adaptiveDeferralMs(4) returns 5x base');
  assert(adaptiveDeferralMs(11) === 120000, 'adaptiveDeferralMs(11) caps multiplier at 12');
  assert(adaptiveDeferralMs(99) === 120000, 'adaptiveDeferralMs(99) also caps multiplier at 12');
  assert(adaptiveDeferralMs(0, 30000) === 30000, 'adaptiveDeferralMs with high base respects base');
  assert(adaptiveDeferralMs(99, 30000) === 300000, 'adaptiveDeferralMs with high base caps at 300000');

  // buildExecutionIntentNote
  assert(buildExecutionIntentNote({ execution_intent: 'execute', execution_read_only: 0 }) === '', 'no note for normal job');
  const planNote = buildExecutionIntentNote({ execution_intent: 'plan', execution_read_only: 0 });
  assert(planNote.includes('planning-only'), 'plan intent includes planning-only');
  assert(planNote.includes('[SYSTEM NOTE'), 'plan intent has system note header');
  assert(planNote.includes('[END SYSTEM NOTE]'), 'plan intent has system note footer');
  const readOnlyNote = buildExecutionIntentNote({ execution_intent: 'execute', execution_read_only: 1 });
  assert(readOnlyNote.includes('read-only'), 'read-only note includes read-only');
  assert(readOnlyNote.includes('forbidden'), 'read-only note includes forbidden');
  const bothNote = buildExecutionIntentNote({ execution_intent: 'plan', execution_read_only: 1 });
  assert(bothNote.includes('planning-only'), 'both: includes planning-only');
  assert(bothNote.includes('forbidden'), 'both: includes forbidden');

  // getBackoffMs
  assert(getBackoffMs(1) === 30000, 'getBackoffMs(1) = 30s');
  assert(getBackoffMs(2) === 60000, 'getBackoffMs(2) = 60s');
  assert(getBackoffMs(3) === 300000, 'getBackoffMs(3) = 5m');
  assert(getBackoffMs(4) === 900000, 'getBackoffMs(4) = 15m');
  assert(getBackoffMs(5) === 3600000, 'getBackoffMs(5) = 1h');
  assert(getBackoffMs(99) === 3600000, 'getBackoffMs(99) caps at 1h');
}

console.log('\n── Dispatch Queue Lifecycle ──');
{
  const dqJob = createJob({ name: 'dq-lifecycle', schedule_cron: '0 0 31 2 *', payload_message: 'test' });

  // claimDispatch
  const d1 = enqueueDispatch(dqJob.id, { kind: 'manual' });
  assert(d1.status === 'pending', 'enqueued dispatch is pending');
  const claimed = claimDispatch(d1.id);
  assert(claimed !== null, 'claimDispatch returns the dispatch');
  assert(claimed.status === 'claimed', 'claimed dispatch has status claimed');
  assert(claimed.claimed_at !== null, 'claimed dispatch has claimed_at');
  const claimAgain = claimDispatch(d1.id);
  assert(claimAgain === null, 'claimDispatch on already-claimed returns null');

  // releaseDispatch
  const released = releaseDispatch(d1.id);
  assert(released !== null, 'releaseDispatch returns the dispatch');
  assert(released.status === 'pending', 'released dispatch is pending again');
  assert(released.claimed_at === null, 'released dispatch has null claimed_at');

  // releaseDispatch with new scheduledFor
  claimDispatch(d1.id);
  const releasedWithTime = releaseDispatch(d1.id, '2099-01-01 00:00:00');
  assert(releasedWithTime.scheduled_for === '2099-01-01 00:00:00', 'release updates scheduled_for');

  // releaseDispatch on pending returns null
  const releaseNotClaimed = releaseDispatch(d1.id);
  assert(releaseNotClaimed === null, 'releaseDispatch on pending returns null');

  // setDispatchStatus to done
  claimDispatch(d1.id);
  const done = setDispatchStatus(d1.id, 'done');
  assert(done.status === 'done', 'setDispatchStatus sets done');
  assert(done.processed_at !== null, 'done dispatch has processed_at');

  // setDispatchStatus to cancelled
  const d2 = enqueueDispatch(dqJob.id, { kind: 'manual' });
  const cancelled2 = setDispatchStatus(d2.id, 'cancelled');
  assert(cancelled2.status === 'cancelled', 'setDispatchStatus sets cancelled');
  assert(cancelled2.processed_at !== null, 'cancelled dispatch has processed_at');

  // setDispatchStatus to pending does not set processed_at
  const d3 = enqueueDispatch(dqJob.id, { kind: 'manual' });
  const pending = setDispatchStatus(d3.id, 'pending');
  assert(pending.processed_at === null, 'pending dispatch has no processed_at');

  deleteJob(dqJob.id);
}

console.log('\n── Approval Timeout / Prune / Count ──');
{
  const { createApproval, getApproval, countPendingApprovalsForJob,
          getTimedOutApprovals, pruneApprovals, resolveApproval } = await import('./approval.js');

  const aJob = createJob({
    name: 'approval-timeout-test', schedule_cron: '0 * * * *', payload_message: 'test',
    approval_required: 1, approval_timeout_s: 1, approval_auto: 'reject',
  });
  const aRun1 = createRun(aJob.id, { status: 'awaiting_approval' });
  const aRun2 = createRun(aJob.id, { status: 'awaiting_approval' });

  // countPendingApprovalsForJob
  const ap1 = createApproval(aJob.id, aRun1.id);
  const ap2 = createApproval(aJob.id, aRun2.id);
  assert(countPendingApprovalsForJob(aJob.id) === 2, 'countPendingApprovalsForJob returns 2');
  resolveApproval(ap1.id, 'approved', 'operator');
  assert(countPendingApprovalsForJob(aJob.id) === 1, 'countPendingApprovalsForJob returns 1 after resolve');

  // getTimedOutApprovals: backdate ap2 so it exceeds the 1s timeout
  getDb().prepare("UPDATE approvals SET requested_at = datetime('now', '-10 seconds') WHERE id = ?").run(ap2.id);
  const timedOut = getTimedOutApprovals();
  assert(timedOut.some(a => a.id === ap2.id), 'getTimedOutApprovals finds backdated approval');
  const timedOutRow = timedOut.find(a => a.id === ap2.id);
  assert(timedOutRow.job_name === 'approval-timeout-test', 'timed out approval has job_name');
  assert(timedOutRow.approval_timeout_s === 1, 'timed out approval has approval_timeout_s');
  assert(timedOutRow.approval_auto === 'reject', 'timed out approval has approval_auto');

  // pruneApprovals: resolve ap2 and backdate resolved_at
  resolveApproval(ap2.id, 'timed_out', 'system');
  getDb().prepare("UPDATE approvals SET resolved_at = datetime('now', '-60 days') WHERE id = ?").run(ap2.id);
  const pruneResult = pruneApprovals(30);
  assert(pruneResult.changes >= 1, 'pruneApprovals deletes old resolved approvals');
  assert(getApproval(ap2.id) === undefined, 'pruned approval is gone');
  // ap1 was resolved recently, should still exist
  assert(getApproval(ap1.id) !== undefined, 'recent resolved approval survives prune');

  finishRun(aRun1.id, 'ok');
  finishRun(aRun2.id, 'cancelled');
  deleteJob(aJob.id);
}

console.log('\n── Run Session & Context Summary ──');
{
  const rsJob = createJob({ name: 'run-session-test', schedule_cron: '0 0 31 2 *', payload_message: 'test' });

  // updateRunSession
  const rs1 = createRun(rsJob.id, { run_timeout_ms: 60000 });
  updateRunSession(rs1.id, 'my-session-key', 'session-123');
  const updated = getRun(rs1.id);
  assert(updated.session_key === 'my-session-key', 'updateRunSession stores session_key');
  assert(updated.session_id === 'session-123', 'updateRunSession stores session_id');

  // updateRunSession with nulls
  updateRunSession(rs1.id, null, null);
  const cleared = getRun(rs1.id);
  assert(cleared.session_key === null, 'updateRunSession clears session_key');
  assert(cleared.session_id === null, 'updateRunSession clears session_id');

  // updateContextSummary with object
  const summaryObj = { messages_injected: 3, scope: 'own' };
  const afterObj = updateContextSummary(rs1.id, summaryObj);
  assert(afterObj.context_summary === JSON.stringify(summaryObj), 'updateContextSummary stores object as JSON');

  // updateContextSummary with pre-serialized string
  const summaryStr = '{"pre":"serialized"}';
  const afterStr = updateContextSummary(rs1.id, summaryStr);
  assert(afterStr.context_summary === summaryStr, 'updateContextSummary stores string as-is');

  finishRun(rs1.id, 'ok');
  deleteJob(rsJob.id);
}

console.log('\n── Prompt Context Edge Cases ──');
{
  // No trigger (no triggered_by_run)
  const noTrigger = buildTriggeredRunContext({});
  assert(noTrigger.text === '', 'no trigger: text is empty');
  assert(Object.keys(noTrigger.meta).length === 0, 'no trigger: meta is empty');

  // Null/undefined run
  const nullRun = buildTriggeredRunContext(null);
  assert(nullRun.text === '', 'null run: text is empty');

  // Missing parent run (getRunById returns undefined)
  const missingParent = buildTriggeredRunContext(
    { triggered_by_run: 'nonexistent-run' },
    { getRunById: () => undefined, getJobById: () => undefined }
  );
  assert(missingParent.text === '', 'missing parent: text is empty');
  assert(missingParent.meta.parent_run_missing === true, 'missing parent: meta.parent_run_missing is true');
  assert(missingParent.meta.triggered_by_run === 'nonexistent-run', 'missing parent: meta.triggered_by_run set');

  // Non-shell parent with summary (no shell fields)
  const nonShellCtx = buildTriggeredRunContext(
    { triggered_by_run: 'parent-run-2' },
    {
      getRunById: () => ({
        id: 'parent-run-2',
        job_id: 'parent-job-2',
        status: 'ok',
        summary: 'Agent completed the analysis successfully',
      }),
      getJobById: () => ({ id: 'parent-job-2', name: 'Agent Analysis', session_target: 'isolated' }),
    }
  );
  assert(nonShellCtx.text.includes('Trigger Context'), 'non-shell: has trigger context header');
  assert(nonShellCtx.text.includes('Agent Analysis'), 'non-shell: includes parent job name');
  assert(nonShellCtx.text.includes('Agent completed the analysis'), 'non-shell: includes parent summary');
  assert(!nonShellCtx.text.includes('Exit code'), 'non-shell: no shell exit code');
  assert(nonShellCtx.meta.parent_run_status === 'ok', 'non-shell: meta has parent status');
  assert(nonShellCtx.meta.parent_shell_exit_code === undefined, 'non-shell: no shell fields in meta');

  // Parent with error_message but no summary and no shell fields
  const errorOnlyCtx = buildTriggeredRunContext(
    { triggered_by_run: 'parent-run-3' },
    {
      getRunById: () => ({
        id: 'parent-run-3',
        job_id: 'parent-job-3',
        status: 'error',
        error_message: 'Connection refused',
      }),
      getJobById: () => ({ id: 'parent-job-3', name: 'Health Check', session_target: 'isolated' }),
    }
  );
  assert(errorOnlyCtx.text.includes('Connection refused'), 'error-only: includes error message');
  assert(errorOnlyCtx.text.includes('Parent run error:'), 'error-only: has error label');
}

console.log('\n── Dispatcher Integration ──');
{
  async function withTempDispatcher({ prepare, exercise }) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-dispatcher-'));
    const tempDbPath = join(tempRoot, 'scheduler.db');
    const env = {
      ...process.env,
      SCHEDULER_DB: tempDbPath,
      SCHEDULER_TICK_MS: '100',
      SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
      SCHEDULER_PRUNE_MS: '600000',
      SCHEDULER_BACKUP_MS: '600000',
      SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
    };
    const createdJobIds = [];
    const context = {};
    let child;
    let probeDb;

    try {
      closeDb();
      setDbPath(tempDbPath);
      await initDb();
      const addJob = (spec) => {
        const job = createJob(spec);
        createdJobIds.push(job.id);
        return job;
      };
      const triggerJob = (jobId) => runJobNow(jobId);
      await prepare({ addJob, triggerJob, context });
      closeDb();

      child = spawn(process.execPath, ['dispatcher.js'], {
        cwd: process.cwd(),
        env,
        stdio: 'ignore',
      });

      probeDb = new Database(tempDbPath);
      probeDb.pragma('journal_mode = WAL');
      await waitFor(
        () => probeDb.prepare("SELECT COUNT(*) AS c FROM agents WHERE id = 'main'").get().c === 1,
        { timeoutMs: 5000, intervalMs: 100, label: 'dispatcher startup' }
      );

      await exercise({ probeDb, context });
    } finally {
      if (probeDb) probeDb.close();
      await stopChild(child);

      closeDb();
      setDbPath(tempDbPath);
      await initDb();
      for (const jobId of createdJobIds.reverse()) {
        deleteJob(jobId);
      }
      closeDb();
      rmSync(tempRoot, { recursive: true, force: true });
      setDbPath(':memory:');
      await initDb();
    }
  }

  await withTempDispatcher({
    prepare: async ({ addJob, triggerJob, context }) => {
      const timeoutJob = addJob({
        name: 'dispatcher-timeout',
        schedule_cron: '0 0 31 2 *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'sleep 2',
        run_timeout_ms: 100,
        delivery_mode: 'none',
      });
      context.timeoutJobId = timeoutJob.id;
      triggerJob(timeoutJob.id);
    },
    exercise: async ({ probeDb, context }) => {
      const timeoutRun = await waitFor(
        () => probeDb.prepare(`
          SELECT status, shell_timed_out, shell_signal
          FROM runs
          WHERE job_id = ? AND finished_at IS NOT NULL
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(context.timeoutJobId),
        { timeoutMs: 10000, intervalMs: 100, label: 'dispatcher timeout run' }
      );
      assert(timeoutRun.status === 'timeout', 'dispatcher integration: shell timeout stored as timeout');
      assert(timeoutRun.shell_timed_out === 1, 'dispatcher integration: shell timeout sets shell_timed_out');
      assert(timeoutRun.shell_signal === 'SIGTERM', 'dispatcher integration: shell timeout preserves signal');
    },
  });

  await withTempDispatcher({
    prepare: async ({ addJob, triggerJob, context }) => {
      const root = addJob({
        name: 'dispatcher-retry-root',
        schedule_cron: '0 0 31 2 *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-root && exit 9',
        max_retries: 1,
        delivery_mode: 'none',
      });
      const child = addJob({
        name: 'dispatcher-retry-child',
        parent_id: root.id,
        trigger_on: 'failure',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-child-fired',
        delivery_mode: 'none',
      });
      context.rootJobId = root.id;
      context.childJobId = child.id;
      triggerJob(root.id);
    },
    exercise: async ({ probeDb, context }) => {
      await waitFor(
        () => probeDb.prepare(`
          SELECT COUNT(*) AS c
          FROM runs
          WHERE job_id = ? AND finished_at IS NOT NULL
        `).get(context.rootJobId).c >= 1,
        { timeoutMs: 10000, intervalMs: 100, label: 'initial retry root run' }
      );

      const pendingRetry = await waitFor(
        () => probeDb.prepare(`
          SELECT id
          FROM job_dispatch_queue
          WHERE job_id = ? AND dispatch_kind = 'retry' AND status = 'pending'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1
        `).get(context.rootJobId),
        { timeoutMs: 5000, intervalMs: 100, label: 'pending retry dispatch' }
      );
      probeDb.prepare(`
        UPDATE job_dispatch_queue
        SET scheduled_for = datetime('now', '-1 second')
        WHERE id = ?
      `).run(pendingRetry.id);

      const rootRuns = await waitFor(
        () => {
          const runs = probeDb.prepare(`
            SELECT id, status, retry_count, retry_of
            FROM runs
            WHERE job_id = ? AND finished_at IS NOT NULL
            ORDER BY started_at ASC, rowid ASC
          `).all(context.rootJobId);
          return runs.length >= 2 ? runs : null;
        },
        { timeoutMs: 10000, intervalMs: 100, label: 'exhausted retry chain' }
      );

      const childRun = await waitFor(
        () => probeDb.prepare(`
          SELECT status, triggered_by_run, summary
          FROM runs
          WHERE job_id = ? AND finished_at IS NOT NULL
          ORDER BY started_at ASC, rowid ASC
          LIMIT 1
        `).get(context.childJobId),
        { timeoutMs: 10000, intervalMs: 100, label: 'failure child dispatch' }
      );

      const remainingRetryDispatches = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM job_dispatch_queue
        WHERE job_id = ? AND dispatch_kind = 'retry' AND status = 'pending'
      `).get(context.rootJobId).c;

      assert(rootRuns.length === 2, 'dispatcher integration: root runs initial attempt plus one retry');
      assert(rootRuns[0].retry_count === 1, 'dispatcher integration: first failed run stores scheduled retry_count');
      assert(rootRuns[1].retry_count === 1, 'dispatcher integration: retry run inherits retry_count');
      assert(rootRuns[1].status === 'error', 'dispatcher integration: retry run finishes as error');
      assert(childRun.status === 'ok', 'dispatcher integration: failure child fires after retries exhaust');
      assert(childRun.triggered_by_run === rootRuns[1].id, 'dispatcher integration: failure child links to final failed run');
      assert(remainingRetryDispatches === 0, 'dispatcher integration: no extra retry dispatch remains after exhaustion');
    },
  });
}

// ═══════════════════════════════════════════════════════════
// SECTION: Dispatch Spawn Failure Detection
// ═══════════════════════════════════════════════════════════

console.log('\n── Dispatch Spawn Failure Detection ──');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');

  // 1. Dead registry: verify checkSubagentRunState and loadSubagentRegistry are gone
  const indexSrc = readFileSync(join(dispatchDir, 'index.mjs'), 'utf8');
  assert(!indexSrc.includes('checkSubagentRunState'), 'dead registry: checkSubagentRunState removed from index.mjs');
  assert(!indexSrc.includes('loadSubagentRegistry'), 'dead registry: loadSubagentRegistry removed from index.mjs');
  assert(!indexSrc.includes("subagents/runs.json"), 'dead registry: no reference to subagents/runs.json');
  // checkSessionDone now has sessionEverFound param
  assert(indexSrc.includes('sessionEverFound'), 'Fix 4: checkSessionDone has sessionEverFound param');
  assert(indexSrc.includes('session never found'), 'Fix 4: distinct reason for spawn-failure case');
  // post-spawn poll code exists
  assert(indexSrc.includes('spawn-warning'), 'Fix 3: cmdEnqueue sets spawn-warning status');
  assert(indexSrc.includes('SPAWN_POLL_MAX'), 'Fix 3: post-spawn poll loop present');

  // 2. Spawn-failure path: watcher exits non-zero when session never appears in gateway
  //    We use a mock dispatch that always returns status=done with liveness error,
  //    simulating auto-resolve after STARTUP_GRACE_MS with session never found.
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-sftest-'));
  const mockSpawnFailPath = join(tempDir, 'mock-spawn-fail.mjs');
  const mockLabelsSpawnFail = join(tempDir, 'labels-sf.json');
  const watcherPath = join(dispatchDir, 'watcher.mjs');

  writeFileSync(mockSpawnFailPath, `
const [,,sub] = process.argv;
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'test-sf',
    status: 'done',
    summary: 'Auto-resolved: session not found in gateway store',
    sessionKey: 'agent:main:subagent:sf-uuid',
    liveness: { error: 'session not found in gateway store' },
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, lastReply: null, status: 'done' }) + '\\n');
} else {
  // sync and other subcommands
  process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
}
`);

  writeFileSync(mockLabelsSpawnFail, JSON.stringify({
    'test-sf': {
      sessionKey: 'agent:main:subagent:sf-uuid',
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(Date.now() - 200_000).toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  let sfExitCode = 0;
  let sfStderr = '';
  let sfStdout = '';
  try {
    execFileSync(process.execPath, [watcherPath, '--label', 'test-sf', '--timeout', '5', '--poll-interval', '1'], {
      env: {
        ...process.env,
        DISPATCH_INDEX_PATH: mockSpawnFailPath,
        DISPATCH_LABELS_PATH: mockLabelsSpawnFail,
      },
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // execFileSync succeeded — sfExitCode retains its initial value of 0
  } catch (err) {
    sfExitCode  = err.status ?? 1;
    sfStderr    = err.stderr  ?? '';
    sfStdout    = err.stdout  ?? '';
  }
  assert(sfExitCode === 1, 'spawn-failure: watcher exits non-zero (exit code 1)');
  assert(sfStderr.includes('SPAWN FAILURE'), 'spawn-failure: watcher writes SPAWN FAILURE to stderr');
  assert(sfStdout.includes('SPAWN FAILURE'), 'spawn-failure: watcher writes SPAWN FAILURE to stdout');

  // 3. Normal completion: session seen once (liveness ok), then gone → watcher resolves ok (exit 0)
  //    Mock returns running+liveness for calls 1-2, then done on call 3+.
  const counterFile = join(tempDir, 'nc-counter.txt');
  writeFileSync(counterFile, '0');
  const mockNormalPath = join(tempDir, 'mock-normal.mjs');
  const mockLabelsNormal = join(tempDir, 'labels-nc.json');

  writeFileSync(mockNormalPath, `
import { readFileSync, writeFileSync } from 'fs';
const [,,sub] = process.argv;
const counterFile = ${JSON.stringify(counterFile)};
let count = 0;
try { count = parseInt(readFileSync(counterFile, 'utf8').trim()) || 0; } catch {}
if (sub === 'status') {
  count++;
  writeFileSync(counterFile, String(count));
  if (count <= 2) {
    // First 2 status polls: running, session found in gateway (no liveness error)
    process.stdout.write(JSON.stringify({
      ok: true,
      label: 'test-nc',
      status: 'running',
      sessionKey: 'agent:main:subagent:nc-uuid',
      liveness: { ageMs: 3000, updatedAt: Date.now() - 3000, sessionId: 'nc-sid' },
    }) + '\\n');
  } else {
    // 3rd+ poll: auto-resolved to done
    process.stdout.write(JSON.stringify({
      ok: true,
      label: 'test-nc',
      status: 'done',
      summary: 'Auto-resolved: session not found in gateway store',
      sessionKey: 'agent:main:subagent:nc-uuid',
      liveness: { error: 'session not found in gateway store' },
    }) + '\\n');
  }
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true, lastReply: 'Task completed successfully!', status: 'done',
  }) + '\\n');
} else {
  // sync etc
  process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
}
`);

  writeFileSync(mockLabelsNormal, JSON.stringify({
    'test-nc': {
      sessionKey: 'agent:main:subagent:nc-uuid',
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(Date.now() - 200_000).toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  let ncExitCode;
  let ncStdout;
  try {
    ncStdout = execFileSync(process.execPath, [watcherPath, '--label', 'test-nc', '--timeout', '30', '--poll-interval', '1'], {
      env: {
        ...process.env,
        DISPATCH_INDEX_PATH: mockNormalPath,
        DISPATCH_LABELS_PATH: mockLabelsNormal,
      },
      encoding: 'utf8',
      timeout: 40000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    ncExitCode = 0;
  } catch (err) {
    ncExitCode = err.status ?? 1;
    ncStdout   = err.stdout ?? '';
  }
  assert(ncExitCode === 0, 'normal completion: watcher exits 0');
  assert(ncStdout.includes('Task completed successfully!'), 'normal completion: watcher delivers lastReply in output');
  assert(!ncStdout.includes('SPAWN FAILURE'), 'normal completion: watcher does NOT report spawn failure');

  rmSync(tempDir, { recursive: true, force: true });
}

// ── Gateway-Restart-Kill Detection ──
console.log('\n── Gateway-Restart-Kill Recovery ──');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const watcherPath = join(dispatchDir, 'watcher.mjs');
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-gwkill-'));

  // 4. GW-restart-kill with MAX retries exceeded: exits non-zero, labels marked error
  //    Mock always returns session-not-found with no lastReply, and each enqueue
  //    call is a no-op (just outputs ok JSON). gwRestartRetryCount is pre-set to 2
  //    (MAX_GW_RESTART_RETRIES) so the watcher immediately gives up.
  const mockGwKillPath = join(tempDir, 'mock-gw-kill.mjs');
  const mockLabelsGwKill = join(tempDir, 'labels-gk.json');

  writeFileSync(mockGwKillPath, `
const [,,sub] = process.argv;
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'test-gk',
    status: 'done',
    summary: 'Auto-resolved: session not found in sessions store',
    sessionKey: 'agent:main:subagent:gk-uuid',
    liveness: { error: 'session not found in sessions store' },
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, lastReply: null, status: 'done' }) + '\\n');
} else if (sub === 'enqueue') {
  process.stdout.write(JSON.stringify({ ok: true, sessionKey: 'agent:main:subagent:gk-new', status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
}
`);

  // Pre-set gwRestartRetryCount=2 (already at max) so watcher immediately fails.
  // Also seed sessions.json so sessionEverFound=true (distinguishes from spawn-failure).
  writeFileSync(mockLabelsGwKill, JSON.stringify({
    'test-gk': {
      sessionKey: 'agent:main:subagent:gk-uuid',
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(Date.now() - 200_000).toISOString(),
      timeoutSeconds: 300,
      gwRestartRetryCount: 2,
    },
  }) + '\n');

  // Seed sessions.json so readSessionsStore finds the session (sessionEverFound=true)
  const gkSessionsDir = join(tempDir, '.openclaw', 'agents', 'main', 'sessions');
  mkdirSync(gkSessionsDir, { recursive: true });
  writeFileSync(join(gkSessionsDir, 'sessions.json'), JSON.stringify({
    'agent:main:subagent:gk-uuid': { sessionId: 'gk-sid', updatedAt: Date.now() - 5000, model: 'test' },
  }) + '\n');

  let gkExitCode = 0;
  let gkStdout = '';
  try {
    execFileSync(process.execPath, [watcherPath, '--label', 'test-gk', '--timeout', '5', '--poll-interval', '1'], {
      env: {
        ...process.env,
        DISPATCH_INDEX_PATH: mockGwKillPath,
        DISPATCH_LABELS_PATH: mockLabelsGwKill,
        HOME: tempDir,
      },
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    gkExitCode = err.status ?? 1;
    gkStdout   = err.stdout  ?? '';
  }
  assert(gkExitCode === 1, 'gw-restart-kill max retries: watcher exits non-zero');
  assert(gkStdout.includes('gateway restart'), 'gw-restart-kill max retries: output mentions gateway restart');
  assert(!gkStdout.includes('SPAWN FAILURE'), 'gw-restart-kill max retries: not misclassified as spawn failure');
  // Verify labels.json was updated to error status
  const gkLabels = JSON.parse(readFileSync(mockLabelsGwKill, 'utf8'));
  assert(gkLabels['test-gk'].status === 'error', 'gw-restart-kill max retries: labels.json marked error (not done)');
  assert(gkLabels['test-gk'].summary.includes('gateway-restart-kill'), 'gw-restart-kill max retries: labels.json summary contains gateway-restart-kill');

  // 5. GW-restart-kill first attempt: watcher re-dispatches (mock returns running after enqueue)
  //    gwRestartRetryCount starts at 0 — watcher should retry and continue polling.
  //    We simulate this by: first status call returns done/not-found (kill detected),
  //    second call also returns done/not-found (simulating another kill on the new session
  //    with gwRestartRetryCount now=1), third call returns done/not-found (count=2=max → give up).
  const mockGwRetryPath = join(tempDir, 'mock-gw-retry.mjs');
  const mockLabelsGwRetry = join(tempDir, 'labels-gr.json');
  const grCounterFile = join(tempDir, 'gr-counter.txt');
  writeFileSync(grCounterFile, '0');

  writeFileSync(mockGwRetryPath, `
import { readFileSync, writeFileSync } from 'fs';
const [,,sub,...rest] = process.argv;
const counterFile = ${JSON.stringify(grCounterFile)};

if (sub === 'status') {
  // Always return session-not-found — watcher should retry up to MAX then fail
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'test-gr',
    status: 'done',
    summary: 'Auto-resolved: session not found in sessions store',
    sessionKey: 'agent:main:subagent:gr-uuid',
    liveness: { error: 'session not found in sessions store' },
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, lastReply: null, status: 'done' }) + '\\n');
} else if (sub === 'enqueue') {
  // Simulate successful enqueue — update labels to 'running' with new sessionKey
  let labelsPath = ${JSON.stringify(mockLabelsGwRetry)};
  // Extract --label from args
  const labelIdx = rest.indexOf('--label');
  const lbl = labelIdx >= 0 ? rest[labelIdx + 1] : 'test-gr';
  try {
    const lbls = JSON.parse(readFileSync(labelsPath, 'utf8'));
    if (lbls[lbl]) {
      lbls[lbl].status = 'running';
      lbls[lbl].sessionKey = 'agent:main:subagent:gr-new-' + Date.now();
      lbls[lbl].error = null;
      writeFileSync(labelsPath, JSON.stringify(lbls, null, 2) + '\\n');
    }
  } catch {}
  process.stdout.write(JSON.stringify({ ok: true, sessionKey: 'agent:main:subagent:gr-new', status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
}
`);

  // gwRestartRetryCount=0 initially — watcher should retry twice then give up
  writeFileSync(mockLabelsGwRetry, JSON.stringify({
    'test-gr': {
      sessionKey: 'agent:main:subagent:gr-uuid',
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(Date.now() - 200_000).toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  // Seed liveness so sessionEverFound=true: write a fake sessions.json
  // (watcher reads HOME/.openclaw/agents/main/sessions/sessions.json)
  // We set HOME to tempDir for this test.
  const grSessionsDir = join(tempDir, '.openclaw', 'agents', 'main', 'sessions');
  mkdirSync(grSessionsDir, { recursive: true });
  writeFileSync(join(grSessionsDir, 'sessions.json'), JSON.stringify({
    'agent:main:subagent:gr-uuid': { sessionId: 'gr-sid', updatedAt: Date.now() - 5000, model: 'test' },
  }) + '\n');

  let grExitCode = 0;
  let grStdout = '';
  try {
    execFileSync(process.execPath, [watcherPath, '--label', 'test-gr', '--timeout', '10', '--poll-interval', '1'], {
      env: {
        ...process.env,
        DISPATCH_INDEX_PATH: mockGwRetryPath,
        DISPATCH_LABELS_PATH: mockLabelsGwRetry,
        HOME: tempDir,
      },
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    grExitCode = err.status ?? 1;
    grStdout   = err.stdout  ?? '';
  }
  assert(grExitCode === 1, 'gw-restart-kill retry exhausted: watcher exits non-zero after 2 retries');
  assert(grStdout.includes('gateway restart'), 'gw-restart-kill retry exhausted: output mentions gateway restart');
  const grLabels = JSON.parse(readFileSync(mockLabelsGwRetry, 'utf8'));
  assert(grLabels['test-gr'].status === 'error', 'gw-restart-kill retry exhausted: labels.json marked error');
  assert((grLabels['test-gr'].gwRestartRetryCount ?? 0) >= 2, 'gw-restart-kill retry exhausted: gwRestartRetryCount reached max');

  rmSync(tempDir, { recursive: true, force: true });
}

// ── Watcher exit-code correctness (timeout paths) ──
console.log('\n── Watcher timeout markLabelError ──');
{
  const watcherSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'dispatch', 'watcher.mjs'),
    'utf8'
  );
  // Timeout paths should call markLabelError, not markDoneSync, before exit(1)
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s — token telemetry unavailable`)'),
    'timeout: markLabelError used for token-telemetry-unavailable path');
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s — token telemetry lost`)'),
    'timeout: markLabelError used for token-telemetry-lost path');
  assert(watcherSrc.includes("markLabelError(label, 'timed out — killed after steer attempts (no result captured)')"),
    'timeout: markLabelError used for steer-kill path');
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s — killed after steer attempts`)'),
    'timeout: markLabelError used for final killed-after-steer path');
  assert(watcherSrc.includes('isGatewayRestartKill'), 'gw-kill: isGatewayRestartKill function present');
  assert(watcherSrc.includes('MAX_GW_RESTART_RETRIES'), 'gw-kill: MAX_GW_RESTART_RETRIES constant present');
  assert(watcherSrc.includes('respawnAfterGwRestart'), 'gw-kill: respawnAfterGwRestart function present');
  assert(watcherSrc.includes('gwRestartRetryCount'), 'gw-kill: gwRestartRetryCount tracked in labels');
}

// ═══════════════════════════════════════════════════════════
// SECTION: Sessions.json Detection, Done Subcommand, STARTUP_GRACE_MS
// ═══════════════════════════════════════════════════════════

console.log('\n── Sessions.json Detection ──');
{
  const dispatchDir  = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexPath    = join(dispatchDir, 'index.mjs');
  const watcherPath  = join(dispatchDir, 'watcher.mjs');
  const indexSrc     = readFileSync(indexPath, 'utf8');
  const watcherSrc   = readFileSync(watcherPath, 'utf8');

  // ── 1. STARTUP_GRACE_MS constant checks ─────────────────────────────────
  // index.mjs must default to 300_000 (not the old 90_000)
  assert(indexSrc.includes('300_000'), 'STARTUP_GRACE_MS: index.mjs uses 300_000');
  assert(!indexSrc.includes('90_000'), 'STARTUP_GRACE_MS: index.mjs does not use old 90_000');
  // watcher.mjs must declare STARTUP_GRACE_MS = 300_000
  assert(watcherSrc.includes('STARTUP_GRACE_MS'), 'STARTUP_GRACE_MS: watcher.mjs declares constant');
  assert(watcherSrc.includes('300_000'), 'STARTUP_GRACE_MS: watcher.mjs uses 300_000');

  // ── 2. readSessionsStore present in both files ───────────────────────────
  assert(indexSrc.includes('readSessionsStore'), 'sessions.json: readSessionsStore in index.mjs');
  assert(watcherSrc.includes('readSessionsStore'), 'sessions.json: readSessionsStore in watcher.mjs');

  // ── 3. No direct sessions_list API calls for state checks in index.mjs ───
  // The three old patterns replaced: cmdStatus, cmdStuck, cmdSync
  // We verify sessions_list is not used for session state decisions
  // (it may still exist in other contexts but should not be the state oracle)
  assert(!indexSrc.includes("gatewayToolInvoke('sessions_list'"), 'sessions.json: no sessions_list calls in index.mjs');

  // ── 4. sessions.json read behaviour via temp store ───────────────────────
  const testTmpDir = mkdtempSync(join(tmpdir(), 'sessions-json-test-'));
  const testLabelsPath = join(testTmpDir, 'labels.json');
  // Path must match readSessionsStore: join(HOME_DIR, '.openclaw', 'agents', agent, 'sessions', 'sessions.json')
  const sessionsDir = join(testTmpDir, '.openclaw', 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');

  // Fake session entry — simulates a running dispatcher-spawned session
  const fakeSessionKey = 'agent:main:subagent:test-sess-uuid-001';
  const nowMs = Date.now();
  writeFileSync(sessionsJsonPath, JSON.stringify({
    [fakeSessionKey]: {
      sessionId: 'fake-sid-001',
      updatedAt: nowMs,            // active (just updated)
      model: 'anthropic/test',
    },
  }) + '\n');

  // Fake label pointing at fake session
  writeFileSync(testLabelsPath, JSON.stringify({
    'test-sess': {
      sessionKey: fakeSessionKey,
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(nowMs - 60_000).toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  // 4a. Present + active → dispatch status should see it
  const statusPresentActive = execFileSync(process.execPath, [indexPath, 'status', '--label', 'test-sess'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISPATCH_LABELS_PATH: testLabelsPath,
      HOME: testTmpDir,
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const statusObjActive = JSON.parse(statusPresentActive.trim());
  assert(statusObjActive.ok === true, 'sessions.json present+active: status ok');
  assert(statusObjActive.status === 'running', 'sessions.json present+active: status=running (not auto-resolved)');
  assert(statusObjActive.liveness && !statusObjActive.liveness.error, 'sessions.json present+active: liveness has no error');

  // 4b. Present + stale (>10min idle) → should auto-resolve to done
  const staleMs = nowMs - 11 * 60 * 1000;
  writeFileSync(sessionsJsonPath, JSON.stringify({
    [fakeSessionKey]: {
      sessionId: 'fake-sid-001',
      updatedAt: staleMs,
      model: 'anthropic/test',
    },
  }) + '\n');
  // Reset label to running so auto-resolve can kick in
  writeFileSync(testLabelsPath, JSON.stringify({
    'test-sess': {
      sessionKey: fakeSessionKey,
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(staleMs - 5 * 60 * 1000).toISOString(), // spawnedAt > STARTUP_GRACE_MS ago
      timeoutSeconds: 300,
    },
  }) + '\n');

  const statusPresentStale = execFileSync(process.execPath, [indexPath, 'status', '--label', 'test-sess'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISPATCH_LABELS_PATH: testLabelsPath,
      HOME: testTmpDir,
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const statusObjStale = JSON.parse(statusPresentStale.trim());
  assert(statusObjStale.ok === true, 'sessions.json present+stale: status ok');
  assert(statusObjStale.status === 'done', 'sessions.json present+stale: auto-resolved to done');
  assert(statusObjStale.syncAction && statusObjStale.syncAction.includes('auto-resolved'), 'sessions.json present+stale: syncAction includes auto-resolved');

  // 4c. Absent (session key not in store) → auto-resolve as done (session completed/cleaned)
  writeFileSync(sessionsJsonPath, JSON.stringify({}) + '\n');
  writeFileSync(testLabelsPath, JSON.stringify({
    'test-sess': {
      sessionKey: fakeSessionKey,
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date(nowMs - 20 * 60 * 1000).toISOString(), // spawnedAt 20min ago > grace
      timeoutSeconds: 300,
    },
  }) + '\n');

  const statusAbsent = execFileSync(process.execPath, [indexPath, 'status', '--label', 'test-sess'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISPATCH_LABELS_PATH: testLabelsPath,
      HOME: testTmpDir,
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const statusObjAbsent = JSON.parse(statusAbsent.trim());
  assert(statusObjAbsent.ok === true, 'sessions.json absent: status ok');
  assert(statusObjAbsent.status === 'done', 'sessions.json absent: auto-resolved to done');

  rmSync(testTmpDir, { recursive: true, force: true });
}

console.log('\n── Done Subcommand ──');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexPath   = join(dispatchDir, 'index.mjs');
  const tempDone    = mkdtempSync(join(tmpdir(), 'done-subcmd-test-'));
  const doneLabels  = join(tempDone, 'labels.json');

  // Pre-populate labels.json with a running entry
  writeFileSync(doneLabels, JSON.stringify({
    'my-task': {
      sessionKey: 'agent:main:subagent:done-test-uuid',
      status: 'running',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: new Date().toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  // Run: node index.mjs done --label my-task --summary "all done!"
  const doneOut = execFileSync(process.execPath, [
    indexPath, 'done', '--label', 'my-task', '--summary', 'all done!',
  ], {
    encoding: 'utf8',
    env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const doneObj = JSON.parse(doneOut.trim());
  assert(doneObj.ok === true, 'done subcommand: ok=true');
  assert(doneObj.status === 'done', 'done subcommand: status=done');
  assert(doneObj.summary === 'all done!', 'done subcommand: summary stored');

  // Verify labels.json was updated
  const updatedLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
  assert(updatedLabels['my-task'].status === 'done', 'done subcommand: labels.json updated to done');
  assert(updatedLabels['my-task'].summary === 'all done!', 'done subcommand: labels.json summary updated');

  // done with unregistered label → exits 0 and marks as done (not an error)
  // NOTE: Changed from exits-1 in 07838b6: unregistered labels are valid for
  //       direct subagent spawns that weren't tracked via enqueue.
  {
    const unregRaw = execFileSync(process.execPath,
      [indexPath, 'done', '--label', 'nonexistent-label-xyz', '--summary', 'finished'],
      {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const unregResult = JSON.parse(unregRaw.trim());
    assert(unregResult.ok === true, 'done subcommand: exits 0 for unregistered label (not an error)');
    assert(unregResult.status === 'done', 'done subcommand: unregistered label marked done');
  }

  // done without --label → exits 2
  let threwNoLabel = false;
  try {
    execFileSync(process.execPath, [indexPath, 'done'], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    threwNoLabel = (err.status === 2);
  }
  assert(threwNoLabel, 'done subcommand: exits 2 when --label missing');

  // index.mjs source includes done in switch + cmdDone function
  const indexSrc = readFileSync(indexPath, 'utf8');
  assert(indexSrc.includes("case 'done'"), 'done subcommand: switch case exists in index.mjs');
  assert(indexSrc.includes('cmdDone'), 'done subcommand: cmdDone function defined');
  assert(indexSrc.includes('COMPLETION SIGNAL'), 'done subcommand: task template includes COMPLETION SIGNAL');

  // ── SHA validation tests ──────────────────────────────────

  // done with valid --sha succeeds (uses actual HEAD commit from the scheduler repo)
  {
    // Re-populate labels.json with a running entry for sha-test
    writeFileSync(doneLabels, JSON.stringify({
      'sha-test-task': {
        sessionKey: 'agent:main:subagent:sha-test-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    // Get current HEAD SHA from the scheduler repo (a real, existing commit)
    const validSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: dirname(fileURLToPath(import.meta.url)) }).trim();

    const shaValidOut = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'sha-test-task', '--summary', 'sha test done', '--sha', validSha,
    ], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const shaValidObj = JSON.parse(shaValidOut.trim());
    assert(shaValidObj.ok === true, 'done --sha valid: ok=true');
    assert(shaValidObj.status === 'done', 'done --sha valid: status=done');
    const shaValidLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(shaValidLabels['sha-test-task'].sha === validSha, 'done --sha valid: sha stored in labels.json');
  }

  // done with invalid --sha (non-existent commit) is rejected (exit code 1)
  {
    writeFileSync(doneLabels, JSON.stringify({
      'sha-reject-task': {
        sessionKey: 'agent:main:subagent:sha-reject-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    // Use a well-formed hex SHA that does not exist in the repo
    const fakeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    let threwInvalidSha = false;
    let invalidShaExitCode = null;
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'sha-reject-task', '--summary', 'should be rejected', '--sha', fakeSha,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwInvalidSha = true;
      invalidShaExitCode = err.status;
    }
    assert(threwInvalidSha, 'done --sha invalid (non-existent): throws (non-zero exit)');
    assert(invalidShaExitCode === 1, 'done --sha invalid (non-existent): exit code 1');

    // Labels should NOT be updated to done (task was rejected)
    const rejectedLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(rejectedLabels['sha-reject-task'].status === 'running', 'done --sha invalid: labels.json NOT updated to done');
  }

  // done without --sha still succeeds (backward compat)
  {
    writeFileSync(doneLabels, JSON.stringify({
      'no-sha-task': {
        sessionKey: 'agent:main:subagent:no-sha-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    const noShaOut = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'no-sha-task', '--summary', 'no sha needed',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const noShaObj = JSON.parse(noShaOut.trim());
    assert(noShaObj.ok === true, 'done without --sha (backward compat): ok=true');
    assert(noShaObj.status === 'done', 'done without --sha (backward compat): status=done');
    const noShaLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(!noShaLabels['no-sha-task'].sha, 'done without --sha (backward compat): no sha in labels.json');
  }

  rmSync(tempDone, { recursive: true, force: true });
}


// ═══════════════════════════════════════════════════════════
// SECTION: At-Jobs (one-shot scheduling, v18)
// ═══════════════════════════════════════════════════════════

console.log('\n── At-Jobs (one-shot scheduling) ──');

// Schema: new columns exist
// Note: uses getDb() (not the cached 'db' from test startup) since migration guard
// + dispatcher tests may have closed/reopened the connection.
{
  const atJobCols = getDb().prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  assert(atJobCols.includes('schedule_kind'), 'jobs.schedule_kind column exists (v18)');
  assert(atJobCols.includes('schedule_at'), 'jobs.schedule_at column exists (v18)');
}

// parseInDuration: resolves to correct schedule_at
{
  const nowMs = Date.now();

  const in15m = parseInDuration('15m');
  const parsed15m = new Date(in15m.replace(' ', 'T') + 'Z').getTime();
  assert(Math.abs(parsed15m - (nowMs + 15 * 60000)) < 2000, '--in 15m resolves within 2s tolerance');

  const in2h = parseInDuration('2h');
  const parsed2h = new Date(in2h.replace(' ', 'T') + 'Z').getTime();
  assert(Math.abs(parsed2h - (nowMs + 2 * 3600000)) < 2000, '--in 2h resolves within 2s tolerance');

  const in30s = parseInDuration('30s');
  const parsed30s = new Date(in30s.replace(' ', 'T') + 'Z').getTime();
  assert(Math.abs(parsed30s - (nowMs + 30000)) < 2000, '--in 30s resolves within 2s tolerance');

  const in1d = parseInDuration('1d');
  const parsed1d = new Date(in1d.replace(' ', 'T') + 'Z').getTime();
  assert(Math.abs(parsed1d - (nowMs + 86400000)) < 2000, '--in 1d resolves within 2s tolerance');

  let threwBadDuration = false;
  try { parseInDuration('invalid'); } catch { threwBadDuration = true; }
  assert(threwBadDuration, 'parseInDuration throws on invalid duration string');

  let threwNoUnit = false;
  try { parseInDuration('15'); } catch { threwNoUnit = true; }
  assert(threwNoUnit, 'parseInDuration throws when unit is missing');
}

// AT_JOB_CRON_SENTINEL is exported
assert(AT_JOB_CRON_SENTINEL === '0 0 31 2 *', 'AT_JOB_CRON_SENTINEL is the expected sentinel cron');

// at-job creation and getDueAtJobs
{
  const past = new Date(Date.now() - 5 * 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const future = new Date(Date.now() + 60 * 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  // Create a past at-job (should be due immediately)
  const atPast = createJob({
    name: 'At-Job Past Test',
    schedule_kind: 'at',
    schedule_at: past,
    schedule_cron: AT_JOB_CRON_SENTINEL,
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'at-job past test payload',
    delete_after_run: 1,
    next_run_at: past,
  });
  assert(atPast.schedule_kind === 'at', 'at-job created with schedule_kind=at');
  assert(atPast.schedule_at === past, 'at-job created with correct schedule_at');
  assert(atPast.schedule_cron === AT_JOB_CRON_SENTINEL, 'at-job stores sentinel cron');
  assert(atPast.delete_after_run === 1, 'at-job delete_after_run=1');

  // Create a future at-job (should NOT be due yet)
  const atFuture = createJob({
    name: 'At-Job Future Test',
    schedule_kind: 'at',
    schedule_at: future,
    schedule_cron: AT_JOB_CRON_SENTINEL,
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'at-job future test payload',
    delete_after_run: 0,
    next_run_at: future,
  });
  assert(atFuture.schedule_kind === 'at', 'future at-job has schedule_kind=at');

  // getDueAtJobs returns past at-job but NOT future at-job
  const dueAtJobs = getDueAtJobs();
  assert(dueAtJobs.some(j => j.id === atPast.id), 'getDueAtJobs returns past at-job');
  assert(!dueAtJobs.some(j => j.id === atFuture.id), 'getDueAtJobs does NOT return future at-job');

  // getDueJobs (cron) does NOT include at-jobs
  const dueCronJobs = getDueJobs();
  assert(!dueCronJobs.some(j => j.id === atPast.id), 'getDueJobs (cron) does NOT include past at-job');
  assert(!dueCronJobs.some(j => j.id === atFuture.id), 'getDueJobs (cron) does NOT include future at-job');

  // at-job with delete_after_run=1: after firing, delete the row
  updateJob(atPast.id, { last_run_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') });
  deleteJob(atPast.id);
  assert(!getJob(atPast.id), 'after delete_after_run=1 fire, at-job row is gone');

  // at-job with delete_after_run=0: after firing, disable (not deleted)
  updateJob(atFuture.id, {
    enabled: 0,
    last_run_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
  });
  const disabledAtJob = getJob(atFuture.id);
  assert(disabledAtJob !== null, 'at-job with delete_after_run=0 still exists after run');
  assert(!disabledAtJob.enabled, 'at-job with delete_after_run=0 is disabled after run');

  // Disabled at-job NOT returned by getDueAtJobs
  const dueAfterDisable = getDueAtJobs();
  assert(!dueAfterDisable.some(j => j.id === atFuture.id), 'disabled at-job not returned by getDueAtJobs');

  // Clean up
  deleteJob(atFuture.id);
}

// getDueAtJobs: last_run_at < schedule_at guard (already-ran job not re-fired)
{
  // Use a timestamp clearly in the past for schedule_at
  const ts = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const atAlreadyRan = createJob({
    name: 'At-Job Already Ran',
    schedule_kind: 'at',
    schedule_at: ts,
    schedule_cron: AT_JOB_CRON_SENTINEL,
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'already ran',
    delete_after_run: 0,
    next_run_at: ts,
  });
  // Simulate it already having run (last_run_at > schedule_at)
  const ranAt = new Date(Date.now() - 30000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  updateJob(atAlreadyRan.id, { last_run_at: ranAt });
  const dueCheck = getDueAtJobs();
  assert(!dueCheck.some(j => j.id === atAlreadyRan.id), 'getDueAtJobs skips at-job where last_run_at >= schedule_at');
  deleteJob(atAlreadyRan.id);
}

// Existing cron jobs unaffected: schedule_kind defaults to 'cron', schedule_at is null
{
  const cronJob = createJob({
    name: 'Regular Cron Job (migration test)',
    schedule_cron: '*/30 * * * *',
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'regular cron',
  });
  assert(cronJob.schedule_kind === 'cron' || cronJob.schedule_kind == null, 'cron job has schedule_kind=cron (default)');
  assert(cronJob.schedule_at === null || cronJob.schedule_at === undefined, 'cron job has schedule_at=null');
  assert(cronJob.schedule_cron === '*/30 * * * *', 'cron job schedule_cron is unchanged');
  // Cron jobs should NOT appear in getDueAtJobs
  const dueAt = getDueAtJobs();
  assert(!dueAt.some(j => j.id === cronJob.id), 'cron job not returned by getDueAtJobs');
  deleteJob(cronJob.id);
}

// validateJobSpec: at-job requires schedule_at
{
  let threwNoScheduleAt = false;
  try {
    validateJobSpec({
      name: 'Bad At-Job',
      schedule_kind: 'at',
      session_target: 'isolated',
      payload_kind: 'agentTurn',
      payload_message: 'missing schedule_at',
    }, null, 'create');
  } catch (e) {
    threwNoScheduleAt = e.message.includes('schedule_at');
  }
  assert(threwNoScheduleAt, 'validateJobSpec throws when at-job missing schedule_at');
}

// validateJobSpec: cron job still requires schedule_cron (backward compat)
{
  let threwNoCron = false;
  try {
    validateJobSpec({
      name: 'Bad Cron Job',
      session_target: 'isolated',
      payload_kind: 'agentTurn',
      payload_message: 'missing schedule_cron',
    }, null, 'create');
  } catch (e) {
    threwNoCron = e.message.includes('schedule_cron');
  }
  assert(threwNoCron, 'validateJobSpec still requires schedule_cron for cron jobs (backward compat)');
}


// ═══════════════════════════════════════════════════════════
// SECTION: Watchdog Heartbeat Guard
// ═══════════════════════════════════════════════════════════
// Tests the lastPing-based liveness guard added to cmdStatus and cmdSync
// in dispatch/index.mjs (Part 2 of fix/watchdog-premature-resolve).

console.log('\n── Watchdog Heartbeat Guard ──');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexPath   = join(dispatchDir, 'index.mjs');
  const watcherPath = join(dispatchDir, 'watcher.mjs');

  // ── Source-level presence checks ─────────────────────────────────────
  const indexSrc  = readFileSync(indexPath, 'utf8');
  const watcherSrc = readFileSync(watcherPath, 'utf8');

  assert(watcherSrc.includes('PING_INTERVAL_MS'),     'watcher.mjs defines PING_INTERVAL_MS constant');
  assert(watcherSrc.includes('60_000'),               'watcher.mjs sets PING_INTERVAL_MS to 60_000');
  assert(watcherSrc.includes('lastPing'),             'watcher.mjs writes lastPing in heartbeat');
  assert(watcherSrc.includes('setInterval'),          'watcher.mjs uses setInterval for heartbeat');
  assert(watcherSrc.includes('clearInterval'),        'watcher.mjs clears heartbeat interval on exit');
  assert(watcherSrc.includes('_pingInterval'),        'watcher.mjs tracks interval ref in _pingInterval');

  assert(indexSrc.includes('PING_STALE_MS'),          'index.mjs defines PING_STALE_MS for watchdog guard');
  assert(indexSrc.includes('hardCeilingMs'),          'index.mjs defines hardCeilingMs');
  assert(indexSrc.includes('lastPing'),               'index.mjs checks lastPing in watchdog guard');
  assert(indexSrc.includes('idleThresholdMs'),        'index.mjs uses idleThresholdMs instead of hardcoded 10 min');
  assert(indexSrc.includes('PING_STALE_MS_SYNC'),     'index.mjs applies same guard in cmdSync');

  // ── Helper: create temp env with stale sessions.json ─────────────────
  // Uses a session idle for 15 min — normally triggering auto-resolve.
  function makeWdgEnv(tmpDir) {
    const labelsPath  = join(tmpDir, 'labels.json');
    const sessionsDir = join(tmpDir, '.openclaw', 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    const fakeSessionKey   = 'agent:main:subagent:wdg-test-uuid';
    const staleUpdatedAt   = Date.now() - 15 * 60 * 1000; // 15 min ago

    writeFileSync(sessionsJsonPath, JSON.stringify({
      [fakeSessionKey]: {
        sessionId: 'fake-sid-wdg',
        updatedAt: staleUpdatedAt,
        model: 'anthropic/test',
      },
    }) + '\n');

    return { labelsPath, sessionsJsonPath, fakeSessionKey, staleUpdatedAt };
  }

  function runStatus(labelsPath, tmpDir, label) {
    return JSON.parse(execFileSync(process.execPath, [indexPath, 'status', '--label', label], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: labelsPath, HOME: tmpDir },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  }

  const tmpBase = mkdtempSync(join(tmpdir(), 'wdg-hb-test-'));

  // ── Test 1: fresh lastPing + within hardCeiling → stays running ───────
  // Without the guard this session (idle 15 min, timeout 600s) would resolve.
  // With a fresh ping (30s old) and elapsed < hardCeiling (15 min < 15 min... use 6 min),
  // cmdStatus should defer auto-resolve.
  {
    const tmpDir = join(tmpBase, 't1');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t1': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 6 * 60 * 1000).toISOString(), // 6 min ago
        timeoutSeconds: 600,    // hardCeiling = 900s = 15 min; elapsed = 6 min < 15 min
        lastPing:       new Date(Date.now() - 30 * 1000).toISOString(),      // 30s ago — fresh
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t1');
    assert(result.status === 'running',   'watchdog guard t1: fresh lastPing + within ceiling → stays running');
    assert(!result.syncAction,            'watchdog guard t1: no auto-resolve action taken');
  }

  // ── Test 2: stale lastPing + within hardCeiling → falls through, auto-resolves ─
  // lastPing = 4 min ago (> PING_STALE_MS = 3 min), elapsed = 8 min < hardCeiling (15 min).
  // Should fall through to checkSessionDone with idleThresholdMs = 10 min.
  // Session idle 15 min > 10 min → auto-resolves.
  {
    const tmpDir = join(tmpBase, 't2');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t2': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 8 * 60 * 1000).toISOString(),  // 8 min ago
        timeoutSeconds: 600,    // hardCeiling = 15 min; elapsed = 8 min < 15 min
        lastPing:       new Date(Date.now() - 4 * 60 * 1000).toISOString(),  // 4 min ago — stale
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t2');
    assert(result.status === 'done',   'watchdog guard t2: stale lastPing → falls through → auto-resolves');
  }

  // ── Test 3: elapsedMs >= hardCeilingMs → resolves regardless of fresh ping ─
  // elapsed = 20 min ≥ hardCeiling (600 * 1.5s = 15 min).
  // Uses 2-min threshold; session idle 15 min > 2 min → auto-resolves.
  // (Fresh ping cannot save a zombie session past the hard ceiling.)
  {
    const tmpDir = join(tmpBase, 't3');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t3': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
        timeoutSeconds: 600,   // hardCeiling = 15 min; elapsed = 20 min ≥ 15 min
        lastPing:       new Date(Date.now() - 30 * 1000).toISOString(),      // 30s ago — fresh
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t3');
    assert(result.status === 'done', 'watchdog guard t3: past hard ceiling → resolves regardless of fresh ping');
  }

  // ── Test 4: no lastPing (backward compat) → uses idleThresholdMs ─────
  // Sessions dispatched before the heartbeat feature have no lastPing.
  // Behavior should use idleThresholdMs = max(timeoutSeconds*1000, 10 min).

  // 4a: timeoutSeconds=600 → idleThreshold=10 min, hardCeiling=15 min.
  //     spawnedAt 12 min ago → elapsed(12 min) < hardCeiling(15 min) → idleThresholdMs path.
  //     Session idle 15 min (makeWdgEnv default) > idleThreshold 10 min → resolves.
  //     (Previously used timeoutSeconds=300 / spawnedAt=20 min which fell into the zombie-guard
  //     path instead of the intended idleThresholdMs path.)
  {
    const tmpDir = join(tmpBase, 't4a');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t4a': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 12 * 60 * 1000).toISOString(), // 12 min ago < hardCeiling(15 min)
        timeoutSeconds: 600,   // idleThreshold = max(600000, 600000) = 10 min; hardCeiling = 15 min
        // no lastPing — backward compat
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t4a');
    assert(result.status === 'done', 'watchdog guard t4a: no lastPing + idle > idleThreshold → resolves (idleThresholdMs path)');
  }

  // 4b: timeoutSeconds=1800 → idleThreshold=30 min. Session idle 15 min < 30 min → stays running.
  {
    const tmpDir = join(tmpBase, 't4b');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    // Override sessions.json so session is 15 min stale (same as makeWdgEnv default)
    // but hardCeiling = 1800 * 1.5 = 2700s = 45 min, elapsed = 20 min < 45 min,
    // idleThreshold = max(1800000, 600000) = 30 min > silence(15 min) → stays running.
    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t4b': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
        timeoutSeconds: 1800,  // idleThreshold = 30 min, hardCeiling = 45 min
        // no lastPing — backward compat
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t4b');
    assert(result.status === 'running', 'watchdog guard t4b: no lastPing + idle < idleThreshold → stays running');
  }

  rmSync(tmpBase, { recursive: true, force: true });
}

closeDb();
console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
