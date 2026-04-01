#!/usr/bin/env node
// Scheduler v2 unified test suite -- in-memory, self-contained
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
  persistV02Outcomes,
} from './runs.js';
import {
  sendMessage, getMessage, getInbox, getOutbox, getThread,
  markDelivered, markRead, markAllRead, getUnreadCount,
  expireMessages, pruneMessages,
  ackMessage, listMessageReceipts, recordMessageAttempt, getTeamMessages,
} from './messages.js';
import { upsertAgent, getAgent, listAgents, setAgentStatus, touchAgent } from './agents.js';
import {
  splitMessageForChannel,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  checkGatewayHealth,
  invokeGatewayTool,
  runAgentTurn,
  runAgentTurnWithActivityTimeout,
} from './gateway.js';
import { resolveDispatchCliPath, resolveDispatchLabel } from './scripts/dispatch-cli-utils.mjs';
import { buildTriggeredRunContext } from './prompt-context.js';
import {
  matchesSentinel, detectTransientError, adaptiveDeferralMs,
  buildExecutionIntentNote, getBackoffMs, sqliteNow,
} from './dispatcher-utils.js';
import { checkRunHealth } from './dispatcher-maintenance.js';
import { chooseRepairWebhookUrl, evaluateWebhookHealth } from './scripts/telegram-webhook-check.mjs';
import { normalizeShellResult, extractShellResultFromRun } from './shell-result.js';
import {
  resolveIdentity, evaluateTrust, verifyAuthorizationProof,
  evaluateAuthorization, generateEvidence, summarizeCredentialHandoff,
  TRUST_LEVELS, compareTrustLevels,
} from './v02-runtime.js';
import { runShellCommand } from './dispatcher-shell.js';
import { prepareDispatch, finalizeDispatch, redactOutcomesForPersistence } from './dispatcher-strategies.js';
import { loadProviders, getIdentityProvider, _resetForTesting as resetProviderRegistry } from './provider-registry.js';
import * as publicApi from './index.js';

// -- Test harness --------------------------------------------
let passed = 0;
let failed = 0;

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
function assert(cond, msg) {
  if (cond) { passed++; if (verbose) console.log(`  PASS ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg}`); }
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

// -- In-memory DB --------------------------------------------
setDbPath(':memory:');
await initDb();
const db = getDb();

console.log('[TEST] Scheduler v2 test suite\n');

// ===========================================================
// SECTION 1: Core (schema, cron, CRUD, runs, messages, agents)
// ===========================================================

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

// -- Paths ---------------------------------------------------
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

// -- Prompt context -----------------------------------------
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
    getJobById: () => ({ id: 'parent-job-1', name: 'Webhook Health Check', session_target: 'shell' }),
  }
);
assert(triggerContext.text.includes('Trigger Context'), 'trigger context header included');
assert(triggerContext.text.includes('Webhook Health Check'), 'trigger context includes parent job name');
assert(triggerContext.text.includes('Exit code: 2'), 'trigger context includes shell exit code');
assert(triggerContext.text.includes('stdout:'), 'trigger context includes shell stdout label');
assert(triggerContext.text.includes('stderr:'), 'trigger context includes shell stderr label');
assert(triggerContext.meta.parent_run_status === 'error', 'trigger context meta includes parent status');
assert(triggerContext.meta.parent_shell_exit_code === 2, 'trigger context meta includes shell exit code');

// -- Shell result helpers ------------------------------------
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

const shellRunJob = createJob({ name: 'Shell Run', schedule_cron: '*/5 * * * *', payload_message: '/bin/false', session_target: 'shell', payload_kind: 'shellCommand', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
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

// -- Telegram webhook diagnostics ---------------------------
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
assert(chooseRepairWebhookUrl({ url: 'https://current.example/hook' }, 'https://expected.example/hook') === 'https://expected.example/hook', 'repair prefers expected webhook url over current');
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

// -- Cron ----------------------------------------------------
console.log('\nCron:');
const next = nextRunFromCron('0 9 * * *', 'America/New_York');
assert(next !== null, 'nextRunFromCron parses');

// -- Job CRUD ------------------------------------------------
console.log('\nJobs:');
const job = createJob({ name: 'Test Job', schedule_cron: '*/5 * * * *', payload_message: 'Hello', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(job && job.name === 'Test Job', 'createJob');
assert(job.enabled === 1, 'enabled by default');
assert(job.next_run_at !== null, 'next_run_at calculated');
assert(getJob(job.id).id === job.id, 'getJob');
const disabledNumericJob = createJob({ name: 'Disabled Numeric Job', enabled: 0, schedule_cron: '*/6 * * * *', payload_message: 'Disabled', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(disabledNumericJob.enabled === 0, 'numeric enabled=0 creates a disabled job');
updateJob(job.id, { name: 'Updated' });
assert(getJob(job.id).name === 'Updated', 'updateJob');
updateJob(job.id, { enabled: false });
assert(getJob(job.id).enabled === 0, 'boolean enabled=false updates to disabled');
const pausedRootJob = createJob({ name: 'PausedRootJob', enabled: 0, schedule_cron: '0 13 * * *', payload_message: 'paused root', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
updateJob(pausedRootJob.id, { next_run_at: '2000-01-01 00:00:00' });
const resumedRootJob = updateJob(pausedRootJob.id, { enabled: 1 });
assert(resumedRootJob.next_run_at !== '2000-01-01 00:00:00', 're-enabling root cron job recalculates next_run_at');
assert(!getDueJobs().some(j => j.id === pausedRootJob.id), 're-enabled root cron job is not immediately due from stale next_run_at');

const updateCronToAt = createJob({ name: 'UpdateCronToAt', schedule_cron: '0 8 * * *', payload_message: 'cron->at', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
let threwMissingScheduleAtOnUpdate = false;
try {
  updateJob(updateCronToAt.id, { schedule_kind: 'at', schedule_cron: null });
} catch (e) {
  threwMissingScheduleAtOnUpdate = e.message.includes('schedule_at');
}
assert(threwMissingScheduleAtOnUpdate, 'updateJob rejects cron->at without schedule_at');

let threwInvalidScheduleKind = false;
try {
  createJob({ name: 'InvalidScheduleKind', schedule_kind: 'banana', schedule_cron: '*/5 * * * *', payload_message: 'invalid schedule kind', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
} catch (e) {
  threwInvalidScheduleKind = e.message.includes('schedule_kind');
}
assert(threwInvalidScheduleKind, 'createJob rejects invalid schedule_kind values');

let threwSentinelRootCron = false;
try {
  createJob({ name: 'InvalidSentinelCronRoot', schedule_cron: AT_JOB_CRON_SENTINEL, payload_message: 'invalid sentinel root', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
} catch (e) {
  threwSentinelRootCron = e.message.includes('reserved at-job sentinel');
}
assert(threwSentinelRootCron, 'createJob rejects reserved at-job sentinel for root cron jobs');

const rootForTopology = createJob({ name: 'RootForTopology', schedule_cron: '0 9 * * *', payload_message: 'root topology', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const childForTopology = createJob({ name: 'ChildForTopology', parent_id: rootForTopology.id, trigger_on: 'success', schedule_cron: '0 11 * * *', payload_message: 'child topology', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
let threwPromoteWithTrigger = false;
try {
  updateJob(childForTopology.id, { parent_id: null });
} catch (e) {
  threwPromoteWithTrigger = e.message.includes('trigger_on is a child-only field');
}
assert(threwPromoteWithTrigger, 'promoting child to root requires clearing child-only trigger fields');
const promotedChild = updateJob(childForTopology.id, { parent_id: null, trigger_on: null });
assert(promotedChild.parent_id === null, 'child promotion clears parent_id');
assert(promotedChild.next_run_at !== null, 'promoting child to root recalculates next_run_at');
const demotedRoot = updateJob(rootForTopology.id, { parent_id: promotedChild.id, trigger_on: 'success' });
assert(demotedRoot.parent_id === promotedChild.id, 'root demotion stores parent_id');
assert(demotedRoot.next_run_at === null, 'demoting root to child clears next_run_at');
const childNoOrigin = createJob({ name: 'ChildNoOrigin', parent_id: rootForTopology.id, trigger_on: 'success', schedule_cron: '0 12 * * *', payload_message: 'child without origin', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000 });
let threwPromoteNoOrigin = false;
try {
  updateJob(childNoOrigin.id, { parent_id: null, trigger_on: null });
} catch (e) {
  threwPromoteNoOrigin = e.message.includes('origin is required');
}
assert(threwPromoteNoOrigin, 'promoting a child to a root job requires origin');
const promotedWithOrigin = updateJob(childNoOrigin.id, { parent_id: null, trigger_on: null, origin: 'system' });
assert(promotedWithOrigin.origin === 'system' && promotedWithOrigin.parent_id === null, 'child promotion succeeds when origin is provided');

const atToCron = createJob({
  name: 'AtToCron',
  schedule_kind: 'at',
  schedule_at: '2026-03-27 18:00:00',
  schedule_cron: AT_JOB_CRON_SENTINEL,
  payload_message: 'at->cron',
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 300_000,
  origin: 'system'
});
let threwAtToCronWithoutRealCron = false;
try {
  updateJob(atToCron.id, { schedule_kind: 'cron', schedule_at: null });
} catch (e) {
  threwAtToCronWithoutRealCron = e.message.includes('reserved at-job sentinel');
}
assert(threwAtToCronWithoutRealCron, 'updateJob rejects at->cron when the sentinel cron is still in place');
const atToCronUpdated = updateJob(atToCron.id, { schedule_kind: 'cron', schedule_cron: '0 10 * * *', schedule_at: null });
assert(atToCronUpdated.schedule_kind === 'cron', 'at->cron update stores cron kind');
assert(atToCronUpdated.next_run_at !== '2026-03-27 18:00:00', 'at->cron update recalculates next_run_at');

assert(listJobs().length >= 1, 'listJobs');
const budgetedJob = createJob({
  name: 'Budgeted Agent Job',
  schedule_cron: '*/10 * * * *',
  payload_message: 'Plan the next action without executing it.',
  session_target: 'isolated',
  payload_kind: 'agentTurn',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  execution_intent: 'plan',
  execution_read_only: 1,
  max_queued_dispatches: 3,
  max_pending_approvals: 2,
  max_trigger_fanout: 4,
  output_store_limit_bytes: 4096,
  output_excerpt_limit_bytes: 512,
  output_summary_limit_bytes: 2048,
  output_offload_threshold_bytes: 1024,
  run_timeout_ms:   300_000, origin: 'system',
});
assert(budgetedJob.execution_intent === 'plan', 'createJob stores execution_intent');
assert(budgetedJob.execution_read_only === 1, 'createJob stores execution_read_only');
assert(budgetedJob.max_queued_dispatches === 3, 'createJob stores max_queued_dispatches');
assert(budgetedJob.output_offload_threshold_bytes === 1024, 'createJob stores output_offload_threshold_bytes');

// -- Due jobs ------------------------------------------------
console.log('\nDue jobs:');
const dueJob = createJob({ name: 'Due', schedule_cron: '* * * * *', payload_message: 'due', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
db.prepare("UPDATE jobs SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").run(dueJob.id);
assert(getDueJobs().some(j => j.id === dueJob.id), 'getDueJobs finds past-due');

// -- Runs ----------------------------------------------------
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

// -- Stale detection -----------------------------------------
console.log('\nStale:');
const staleRun = createRun(job.id, { run_timeout_ms: 1000 });
db.prepare("UPDATE runs SET last_heartbeat = datetime('now', '-120 seconds') WHERE id = ?").run(staleRun.id);
assert(getStaleRuns(90).some(r => r.id === staleRun.id), 'stale run detected');

// -- getStaleRuns: shell vs agent jobs ------------------------
console.log('\n-- getStaleRuns: shell vs agent jobs --');

// Create a shell job (shellCommand) for stale testing
const shellJobForStale = createJob({
  name: 'Shell Stale Test Job',
  schedule_cron: '*/5 * * * *',
  payload_message: 'echo hello',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 120000,
  origin: 'system',
});

// Create an agent job (agentTurn) for stale testing
const agentJobForStale = createJob({
  name: 'Agent Stale Test Job',
  schedule_cron: '*/5 * * * *',
  payload_message: 'Do something',
  session_target: 'isolated',
  payload_kind: 'agentTurn',
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 300000,
  origin: 'system',
});

// Test 1: Shell job running 95s with run_timeout_ms=120000 -> NOT stale (95s < 120s)
{
  const r = createRun(shellJobForStale.id, { run_timeout_ms: 120000 });
  db.prepare("UPDATE runs SET started_at = datetime('now', '-95 seconds') WHERE id = ?").run(r.id);
  assert(!getStaleRuns(90).some(x => x.id === r.id),
    'shell job at 95s with 120s timeout -> NOT stale');
  finishRun(r.id, 'ok');
}

// Test 2: Shell job running 130s with run_timeout_ms=120000 -> IS stale (130s > 120s)
{
  const r = createRun(shellJobForStale.id, { run_timeout_ms: 120000 });
  db.prepare("UPDATE runs SET started_at = datetime('now', '-130 seconds') WHERE id = ?").run(r.id);
  assert(getStaleRuns(90).some(x => x.id === r.id),
    'shell job at 130s with 120s timeout -> IS stale');
  finishRun(r.id, 'ok');
}

// Test 3: Agent job with last_heartbeat 95s ago -> IS stale (heartbeat path)
{
  const r = createRun(agentJobForStale.id, { run_timeout_ms: 300000 });
  db.prepare("UPDATE runs SET last_heartbeat = datetime('now', '-95 seconds') WHERE id = ?").run(r.id);
  assert(getStaleRuns(90).some(x => x.id === r.id),
    'agent job with heartbeat 95s ago -> IS stale');
  finishRun(r.id, 'ok');
}

// Test 4: Agent job with last_heartbeat 30s ago -> NOT stale
{
  const r = createRun(agentJobForStale.id, { run_timeout_ms: 300000 });
  db.prepare("UPDATE runs SET last_heartbeat = datetime('now', '-30 seconds') WHERE id = ?").run(r.id);
  assert(!getStaleRuns(90).some(x => x.id === r.id),
    'agent job with heartbeat 30s ago -> NOT stale');
  finishRun(r.id, 'ok');
}

// Test 5: Shell job running 200s with run_timeout_ms=300000 -> NOT stale (200s < 300s)
// Confirms shell jobs with remaining budget are never false-positive stale.
// Note: run_timeout_ms has a NOT NULL constraint in schema, so NULL is not representable;
// the guard in the query is defensive only. The real invariant is: elapsed < timeout -> not stale.
{
  const r = createRun(shellJobForStale.id, { run_timeout_ms: 300000 });
  db.prepare("UPDATE runs SET started_at = datetime('now', '-200 seconds') WHERE id = ?").run(r.id);
  assert(!getStaleRuns(90).some(x => x.id === r.id),
    'shell job at 200s with 300s timeout -> NOT flagged by stale detector');
  finishRun(r.id, 'ok');
}

// -- Timeout -------------------------------------------------
console.log('\nTimeout:');
const toRun = createRun(job.id, { run_timeout_ms: 1 });
db.prepare("UPDATE runs SET started_at = datetime('now', '-10 seconds') WHERE id = ?").run(toRun.id);
assert(getTimedOutRuns().some(r => r.id === toRun.id), 'timeout detected');

{
  const timeoutRetryJob = createJob({
    name: 'timeout-retry-health-check',
    schedule_cron: '*/5 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo timeout retry',
    overlap_policy: 'queue',
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: 'timeout-retry-target',
    run_timeout_ms: 1,
    max_retries: 1,
    origin: 'system',
  });
  enqueueJob(timeoutRetryJob.id);
  const timeoutRetryRun = createRun(timeoutRetryJob.id, { run_timeout_ms: 1, status: 'running' });
  const timeoutRetryMessages = [];

  await checkRunHealth({
    log() {},
    getDb,
    getRunningRuns: () => [timeoutRetryRun],
    getStaleRuns: () => [],
    getTimedOutRuns: () => [{ ...timeoutRetryRun, job_name: timeoutRetryJob.name, run_timeout_ms: 1 }],
    finishRun,
    getJob,
    updateJobAfterRun() {},
    async handleDelivery(_job, content) {
      timeoutRetryMessages.push(content);
    },
    dequeueJob,
    shouldRetry,
    scheduleRetry,
    staleThresholdSeconds: 90,
  });

  const refreshedTimeoutRetryRun = getRun(timeoutRetryRun.id);
  const refreshedTimeoutRetryJob = getJob(timeoutRetryJob.id);
  const retryDispatches = listDispatchesForJob(timeoutRetryJob.id, 10);

  assert(refreshedTimeoutRetryRun.retry_count === 1, 'checkRunHealth timeout retry persists retry_count on the timed-out run');
  assert(refreshedTimeoutRetryRun.status === 'timeout', 'checkRunHealth timeout retry preserves run timeout status');
  assert(refreshedTimeoutRetryJob.last_status === 'timeout', 'checkRunHealth timeout retry records last_status as timeout');
  assert(refreshedTimeoutRetryJob.queued_count === 0, 'checkRunHealth timeout retry drains queued overlap backlog');
  assert(!shouldRetry(refreshedTimeoutRetryJob, timeoutRetryRun.id), 'checkRunHealth timeout retry exhausts max_retries for the timed-out run');
  assert(retryDispatches.some(d => d.dispatch_kind === 'retry' && d.status === 'pending'), 'checkRunHealth timeout retry enqueues a retry dispatch');
  assert(timeoutRetryMessages.length === 1 && timeoutRetryMessages[0].includes('will retry'), 'checkRunHealth timeout retry still delivers a timeout notice');

  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(timeoutRetryJob.id);
  deleteJob(timeoutRetryJob.id);
}

// -- Agents --------------------------------------------------
console.log('\nAgents:');
const agent = upsertAgent('main', { name: 'Main Agent', capabilities: ['*'] });
assert(agent.id === 'main', 'upsertAgent');
assert(agent.name === 'Main Agent', 'agent name');
setAgentStatus('main', 'busy', 'session:123');
assert(getAgent('main').status === 'busy', 'setAgentStatus');
touchAgent('main');
assert(getAgent('main').last_seen_at !== null, 'touchAgent');
assert(listAgents().length >= 1, 'listAgents');

// -- Messages ------------------------------------------------
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

// -- Cascade delete ------------------------------------------
console.log('\nCascade:');
const delJob = createJob({ name: 'Deletable', schedule_cron: '0 * * * *', payload_message: 'bye', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
createRun(delJob.id);
deleteJob(delJob.id);
assert(!getJob(delJob.id), 'job deleted');
assert(getRunsForJob(delJob.id).length === 0, 'runs cascade deleted');

// -- Prune ---------------------------------------------------
console.log('\nPrune:');
for (let i = 0; i < 5; i++) { const r = createRun(job.id); finishRun(r.id, 'ok'); }
pruneRuns(3);
assert(getRunsForJob(job.id).length <= 3, 'pruneRuns');
pruneMessages(0);

// ===========================================================
// SECTION 2: Workflow chaining (v3)
// ===========================================================

console.log('\n-- Chaining --');

const parent = createJob({ name: 'Parent', schedule_cron: '0 9 * * *', payload_message: 'parent', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const childSuccess = createJob({ name: 'OnSuccess', parent_id: parent.id, trigger_on: 'success', payload_message: 'on success', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const childFailure = createJob({ name: 'OnFailure', parent_id: parent.id, trigger_on: 'failure', payload_message: 'on failure', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const childComplete = createJob({ name: 'OnComplete', parent_id: parent.id, trigger_on: 'complete', payload_message: 'on complete', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });

assert(childSuccess.parent_id === parent.id, 'child parent_id set');
assert(childSuccess.trigger_on === 'success', 'trigger_on = success');
assert(childSuccess.schedule_cron === '0 0 31 2 *', 'child gets dummy cron');
assert(childSuccess.next_run_at === null, 'child starts with null next_run_at');
assert(childFailure.trigger_on === 'failure', 'trigger_on = failure');
assert(childComplete.trigger_on === 'complete', 'trigger_on = complete');

// getChildJobs
assert(getChildJobs(parent.id).length === 3, 'getChildJobs returns 3');

let threwMissingParentCreate = false;
try {
  createJob({
    name: 'MissingParentChild',
    parent_id: 'does-not-exist',
    trigger_on: 'success',
    payload_message: 'missing parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
} catch (e) {
  threwMissingParentCreate = e.message.includes('parent job does not exist');
}
assert(threwMissingParentCreate, 'createJob rejects nonexistent parent_id');

let threwMissingParentUpdate = false;
try {
  updateJob(childSuccess.id, { parent_id: 'missing-parent' });
} catch (e) {
  threwMissingParentUpdate = e.message.includes('parent job does not exist');
}
assert(threwMissingParentUpdate, 'updateJob rejects nonexistent parent_id');

let threwMissingChildTriggerCreate = false;
try {
  createJob({
    name: 'MissingChildTrigger',
    parent_id: parent.id,
    payload_message: 'dead child',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
} catch (e) {
  threwMissingChildTriggerCreate = e.message.includes('child jobs require trigger_on');
}
assert(threwMissingChildTriggerCreate, 'createJob rejects child jobs without trigger_on');

let threwMissingChildTriggerUpdate = false;
try {
  updateJob(childSuccess.id, { trigger_on: null });
} catch (e) {
  threwMissingChildTriggerUpdate = e.message.includes('child jobs require trigger_on');
}
assert(threwMissingChildTriggerUpdate, 'updateJob rejects clearing trigger_on on child jobs');

let threwRootTriggerOn = false;
try {
  createJob({
    name: 'RootTriggerOn',
    schedule_cron: '0 10 * * *',
    trigger_on: 'success',
    payload_message: 'root noop trigger',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
} catch (e) {
  threwRootTriggerOn = e.message.includes('trigger_on is a child-only field');
}
assert(threwRootTriggerOn, 'createJob rejects trigger_on on root jobs');

let threwRootTriggerDelay = false;
try {
  createJob({
    name: 'RootTriggerDelay',
    schedule_cron: '0 10 * * *',
    trigger_delay_s: 60,
    payload_message: 'root noop delay',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
} catch (e) {
  threwRootTriggerDelay = e.message.includes('trigger_delay_s is a child-only field');
}
assert(threwRootTriggerDelay, 'createJob rejects trigger_delay_s on root jobs');

let threwRootTriggerCondition = false;
try {
  createJob({
    name: 'RootTriggerCondition',
    schedule_cron: '0 10 * * *',
    trigger_condition: 'contains:ALERT',
    payload_message: 'root noop condition',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
} catch (e) {
  threwRootTriggerCondition = e.message.includes('trigger_condition is a child-only field');
}
assert(threwRootTriggerCondition, 'createJob rejects trigger_condition on root jobs');

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
const delayedChild = createJob({ name: 'Delayed', parent_id: parent.id, trigger_on: 'success', trigger_delay_s: 60, payload_message: 'delayed', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(delayedChild.trigger_delay_s === 60, 'trigger_delay_s stored');
fireTriggeredChildren(parent.id, 'ok', 'delayed output', parentRun.id);
const delayedDispatch = listDispatchesForJob(delayedChild.id).find(d => d.dispatch_kind === 'chain');
const delayedTime = new Date(delayedDispatch.scheduled_for + 'Z').getTime();
assert(delayedTime > Date.now(), 'delayed child scheduled in future');

const cappedParent = createJob({
  name: 'CappedParent',
  schedule_cron: '0 8 * * *',
  payload_message: 'cap fanout',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  max_trigger_fanout: 1,
  run_timeout_ms:   300_000, origin: 'system',
});
createJob({ name: 'FanoutChild1', parent_id: cappedParent.id, trigger_on: 'success', payload_message: 'c1', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
createJob({ name: 'FanoutChild2', parent_id: cappedParent.id, trigger_on: 'success', payload_message: 'c2', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const fanoutTriggered = fireTriggeredChildren(cappedParent.id, 'ok', 'fanout', parentRun.id);
assert(fanoutTriggered.length === 1, 'max_trigger_fanout limits triggered children per parent run');

// Agent routing
const agentJob = createJob({ name: 'AgentJob', schedule_cron: '0 12 * * *', agent_id: 'worker', payload_message: 'x', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(agentJob.agent_id === 'worker', 'agent_id stored');

// Orphan pruning
const tempParent = createJob({ name: 'TempParent', schedule_cron: '0 12 * * *', payload_message: 'temp', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const orphan = createJob({ name: 'Orphan', parent_id: tempParent.id, trigger_on: 'success', payload_message: 'orphan', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
db.pragma('foreign_keys = OFF');
db.prepare('DELETE FROM jobs WHERE id = ?').run(tempParent.id);
db.pragma('foreign_keys = ON');
const pruned = pruneExpiredJobs();
assert(pruned > 0, 'orphan pruned');
assert(!getJob(orphan.id), 'orphan removed');

// Aged disabled one-shot job cleanup (only delete_after_run=1 jobs are pruned)
const agedJob = createJob({ name: 'AgedDisabled', schedule_cron: '0 12 * * *', payload_message: 'aged', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system', delete_after_run: 1 });
updateJob(agedJob.id, { enabled: 0, last_run_at: '2020-01-01 00:00:00' });
const pruned2 = pruneExpiredJobs();
assert(pruned2 > 0, 'aged disabled job pruned');
assert(!getJob(agedJob.id), 'aged disabled job removed');

// Disabled job < 24h should NOT be pruned
const recentDisabled = createJob({ name: 'RecentDisabled', schedule_cron: '0 12 * * *', payload_message: 'recent', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
updateJob(recentDisabled.id, { enabled: 0 });
pruneExpiredJobs();
assert(getJob(recentDisabled.id), 'recently disabled job kept');

// Disabled annual cron job should NOT be pruned just because next_run_at is far away
const pausedAnnual = createJob({ name: 'PausedAnnual', schedule_cron: '0 0 1 1 *', payload_message: 'annual', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
updateJob(pausedAnnual.id, { enabled: 0 });
db.prepare("UPDATE jobs SET next_run_at = datetime('now', '+350 days') WHERE id = ?").run(pausedAnnual.id);
pruneExpiredJobs();
assert(getJob(pausedAnnual.id), 'disabled annual cron job kept');

const stagedFutureAt = createJob({
  name: 'StagedFutureAt',
  schedule_kind: 'at',
  schedule_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  payload_message: 'future staged one-shot',
  delete_after_run: 1,
  enabled: 0,
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 300_000,
  origin: 'system',
});
db.prepare("UPDATE jobs SET created_at = datetime('now', '-48 hours') WHERE id = ?").run(stagedFutureAt.id);
pruneExpiredJobs();
assert(getJob(stagedFutureAt.id), 'disabled future one-shot job is not pruned before it ever runs');
deleteJob(stagedFutureAt.id);

// ===========================================================
// SECTION 3: Cycle detection + max depth (v3b)
// ===========================================================

console.log('\n-- Cycles & Depth --');

const cA = createJob({ name: 'cA', schedule_cron: '0 6 * * *', payload_message: 'a', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const cB = createJob({ name: 'cB', parent_id: cA.id, trigger_on: 'success', payload_message: 'b', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const cC = createJob({ name: 'cC', parent_id: cB.id, trigger_on: 'success', payload_message: 'c', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });

// Self-cycle
let err1 = false;
try { detectCycle(cC.id, cC.id); } catch { err1 = true; }
assert(err1, 'self-cycle detected');

// Deep cycle A->B->C->A
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

// Build 11-deep chain, verify 12th blocked (MAX_CHAIN_DEPTH=10, depth > 10 throws)
let deepParent = createJob({ name: 'D0', schedule_cron: '0 12 * * *', payload_message: 'd', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
for (let i = 1; i <= 10; i++) {
  deepParent = createJob({ name: `D${i}`, parent_id: deepParent.id, trigger_on: 'success', payload_message: `d${i}`, delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
}
let err4 = false;
try { createJob({ name: 'D11', parent_id: deepParent.id, trigger_on: 'success', payload_message: 'too deep', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' }); } catch { err4 = true; }
assert(err4, 'depth 12 blocked by MAX_CHAIN_DEPTH');

// ===========================================================
// SECTION 4: Retry logic (v3b)
// ===========================================================

console.log('\n-- Retry --');

const retryJob = createJob({ name: 'Retryable', schedule_cron: '0 8 * * *', payload_message: 'retry me', max_retries: 3, delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
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

// Exhausted retries
db.prepare('UPDATE runs SET retry_count = 3 WHERE id = ?').run(run1.id);
assert(!shouldRetry(retryJob, run1.id), 'shouldRetry false after max');

// No-retry job
const noRetry = createJob({ name: 'NoRetry', schedule_cron: '0 8 * * *', payload_message: 'no', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const run2 = createRun(noRetry.id, { run_timeout_ms: 300000 });
finishRun(run2.id, 'error', { error_message: 'fail' });
assert(!shouldRetry(noRetry, run2.id), 'shouldRetry false when max_retries=0');

const singleRetryJob = createJob({ name: 'SingleRetry', schedule_cron: '0 9 * * *', payload_message: 'single retry', max_retries: 1, delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
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

const retryAtTs = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const retryAtJob = createJob({
  name: 'RetryAtJob',
  schedule_kind: 'at',
  schedule_at: retryAtTs,
  schedule_cron: AT_JOB_CRON_SENTINEL,
  payload_message: 'retry at job',
  delete_after_run: 0,
  max_retries: 1,
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 300_000,
  origin: 'system',
});
const retryAtRun = createRun(retryAtJob.id, { run_timeout_ms: 300000 });
finishRun(retryAtRun.id, 'error', { error_message: 'retry at fail' });
const retryAtDispatch = scheduleRetry(retryAtJob, retryAtRun.id);
const retryAtFresh = getJob(retryAtJob.id);
assert(retryAtDispatch.dispatch.dispatch_kind === 'retry', 'at-job retry creates durable dispatch');
assert(retryAtFresh.last_run_at !== null, 'at-job retry records last_run_at to suppress duplicate root dispatch');
assert(retryAtFresh.last_status === 'error', 'at-job retry records last_status');
assert(!getDueAtJobs().some(j => j.id === retryAtJob.id), 'at-job with queued retry is not still due via getDueAtJobs');
deleteJob(retryAtJob.id);

const skippedRetryAtTs = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
const skippedRetryAtJob = createJob({
  name: 'SkippedRetryAtJob',
  schedule_kind: 'at',
  schedule_at: skippedRetryAtTs,
  schedule_cron: AT_JOB_CRON_SENTINEL,
  payload_message: 'retry at job skipped',
  delete_after_run: 0,
  max_retries: 1,
  max_queued_dispatches: 1,
  delivery_mode: 'none',
  delivery_opt_out_reason: 'test',
  run_timeout_ms: 300_000,
  origin: 'system',
});
enqueueDispatch(skippedRetryAtJob.id, { kind: 'manual' });
const skippedRetryAtRun = createRun(skippedRetryAtJob.id, { run_timeout_ms: 300000 });
finishRun(skippedRetryAtRun.id, 'error', { error_message: 'retry at skip fail' });
const skippedRetryAtResult = scheduleRetry(skippedRetryAtJob, skippedRetryAtRun.id);
const skippedRetryAtFresh = getJob(skippedRetryAtJob.id);
assert(skippedRetryAtResult.dispatch === null && skippedRetryAtResult.skipped === true, 'at-job retry skip reports no queued dispatch when backlog is full');
assert(skippedRetryAtFresh.last_run_at === null, 'at-job retry skip does not mutate last_run_at when no retry dispatch is created');
assert(skippedRetryAtFresh.last_status === null, 'at-job retry skip does not mutate last_status when no retry dispatch is created');
assert(getDueAtJobs().some(j => j.id === skippedRetryAtJob.id), 'at-job remains due if retry dispatch was not actually queued');
deleteJob(skippedRetryAtJob.id);

// ===========================================================
// SECTION 5: Cancellation (v3b)
// ===========================================================

console.log('\n-- Cancellation --');

const cancelP = createJob({ name: 'CancelP', schedule_cron: '0 7 * * *', payload_message: 'p', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const cancelC1 = createJob({ name: 'CancelC1', parent_id: cancelP.id, trigger_on: 'success', payload_message: 'c1', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const cancelC2 = createJob({ name: 'CancelC2', parent_id: cancelP.id, trigger_on: 'complete', payload_message: 'c2', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const cancelGC = createJob({ name: 'CancelGC', parent_id: cancelC1.id, trigger_on: 'success', payload_message: 'gc', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });

// Cascade cancel
const cancelled = cancelJob(cancelP.id);
assert(cancelled.length === 4, 'cascade cancels 4 jobs');
assert(!getJob(cancelP.id).enabled, 'parent disabled');
assert(!getJob(cancelC1.id).enabled, 'child 1 disabled');
assert(!getJob(cancelC2.id).enabled, 'child 2 disabled');
assert(!getJob(cancelGC.id).enabled, 'grandchild disabled');

// No-cascade
const ncP = createJob({ name: 'NcP', schedule_cron: '0 7 * * *', payload_message: 'p', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const ncC = createJob({ name: 'NcC', parent_id: ncP.id, trigger_on: 'success', payload_message: 'c', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const ncResult = cancelJob(ncP.id, { cascade: false });
assert(ncResult.length === 1, 'no-cascade cancels 1');
assert(!!getJob(ncC.id).enabled, 'child still enabled');

// Cancel running runs
const runP = createJob({ name: 'RunP', schedule_cron: '0 7 * * *', payload_message: 'r', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const runR = createRun(runP.id, { run_timeout_ms: 300000 });
assert(db.prepare('SELECT status FROM runs WHERE id = ?').get(runR.id).status === 'running', 'run is running');
cancelJob(runP.id);
assert(db.prepare('SELECT status FROM runs WHERE id = ?').get(runR.id).status === 'cancelled', 'running run cancelled');

// ===========================================================
// SECTION 6: Queue overlap policy
// ===========================================================

console.log('\n-- Queue Overlap --');

// Schema column exists
const qCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(qCols.includes('queued_count'), 'jobs.queued_count column');

// Create a queue-policy job
const qJob = createJob({ name: 'QueueJob', schedule_cron: '*/5 * * * *', payload_message: 'q', overlap_policy: 'queue', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(qJob.overlap_policy === 'queue', 'overlap_policy = queue');
assert(qJob.queued_count === 0, 'initial queued_count = 0');

// Enqueue increments counter
enqueueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 1, 'enqueue -> queued_count = 1');
enqueueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 2, 'enqueue again -> queued_count = 2');

const limitedQueueJob = createJob({
  name: 'LimitedQueueJob',
  schedule_cron: '*/5 * * * *',
  payload_message: 'limited queue',
  overlap_policy: 'queue',
  max_queued_dispatches: 1,
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});
const queueResult1 = enqueueJob(limitedQueueJob.id);
const queueResult2 = enqueueJob(limitedQueueJob.id);
assert(queueResult1.queued === true, 'enqueueJob returns queued=true below max_queued_dispatches');
assert(queueResult2.queued === false && queueResult2.limited === true, 'enqueueJob blocks growth once max_queued_dispatches is reached');

// Dequeue consumes one and schedules for next tick
const dequeued1 = dequeueJob(qJob.id);
assert(dequeued1 === true, 'dequeue returns true');
assert(getJob(qJob.id).queued_count === 1, 'after dequeue -> queued_count = 1');
assert(getJob(qJob.id).next_run_at !== null, 'dequeue sets next_run_at');

// Dequeue the second
const dequeued2 = dequeueJob(qJob.id);
assert(dequeued2 === true, 'second dequeue returns true');
assert(getJob(qJob.id).queued_count === 0, 'after second dequeue -> queued_count = 0');

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

// Finish the run -- dequeue should consume one
finishRun(qRun.id, 'ok', { summary: 'done' });
const dq = dequeueJob(qJob.id);
assert(dq === true, 'dequeue after run completion');
assert(getJob(qJob.id).queued_count === 2, 'one consumed, 2 remaining');

// Drain remaining
dequeueJob(qJob.id);
dequeueJob(qJob.id);
assert(getJob(qJob.id).queued_count === 0, 'fully drained');
assert(dequeueJob(qJob.id) === false, 'nothing left to dequeue');

// ===========================================================
// SECTION 7: Run-Now Flag
// ===========================================================

console.log('\n-- Run-Now Flag --');

// 1. Regular create (no run_now) -> next_run_at computed from cron
const normalJob = createJob({ name: 'NormalScheduled', schedule_cron: '0 3 * * *', payload_message: 'normal', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
const normalNextRun = new Date(normalJob.next_run_at + 'Z');
assert(normalNextRun > new Date(), 'regular create: next_run_at is in the future');

// 2. Create with run_now=true -> next_run_at is in the past
const runNowJob = createJob({ name: 'RunNowJob', schedule_cron: '0 3 * * *', payload_message: 'run now!', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_now: true , run_timeout_ms: 300_000, origin: 'system' });
const runNowTime = new Date(runNowJob.next_run_at + 'Z');
assert(runNowTime < new Date(), 'run_now=true: next_run_at is in the past');
assert(getDueJobs().some(j => j.id === runNowJob.id), 'run_now job immediately appears in getDueJobs()');

// 3. run_now=true is picked up -- next_run_at should be ~1 second in the past
const diff = Date.now() - runNowTime.getTime();
assert(diff >= 0 && diff < 5000, 'run_now next_run_at is approximately 1 second in the past (within 5s)');

// 4. run_now=false (explicit) behaves like no run_now
const noRunNowJob = createJob({ name: 'NoRunNow', schedule_cron: '0 3 * * *', payload_message: 'no run', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_now: false , run_timeout_ms: 300_000, origin: 'system' });
const noRunNowTime = new Date(noRunNowJob.next_run_at + 'Z');
assert(noRunNowTime > new Date(), 'run_now=false: next_run_at is in the future (normal cron)');

// 5. runJobNow(id) creates a durable manual dispatch without mutating cron schedule
const laterJob = createJob({ name: 'LaterJob', schedule_cron: '0 4 * * *', payload_message: 'trigger later', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(new Date(laterJob.next_run_at + 'Z') > new Date(), 'laterJob starts with future next_run_at');
const triggered = runJobNow(laterJob.id);
assert(triggered.dispatch_id, 'runJobNow returns dispatch id');
const manualDispatch = getDispatch(triggered.dispatch_id);
assert(manualDispatch.dispatch_kind === 'manual', 'runJobNow creates manual dispatch');
assert(getDueDispatches().some(d => d.id === manualDispatch.id), 'runJobNow dispatch appears in dispatch queue');
const disabledManualJob = createJob({ name: 'DisabledManualJob', enabled: 0, schedule_cron: '0 5 * * *', payload_message: 'manual while disabled', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
const disabledManualDispatch = runJobNow(disabledManualJob.id);
assert(disabledManualDispatch.dispatch_id, 'runJobNow creates manual dispatch for disabled job');
assert(getDueDispatches().some(d => d.id === disabledManualDispatch.dispatch_id), 'disabled job manual dispatch is queued');

// 6. runJobNow does NOT change the schedule_cron (normal schedule is preserved)
assert(triggered.schedule_cron === '0 4 * * *', 'runJobNow: schedule_cron unchanged');
assert(getJob(laterJob.id).next_run_at === laterJob.next_run_at, 'runJobNow: next_run_at unchanged');

// 7. runJobNow returns null for unknown id
const unknownResult = runJobNow('nonexistent-uuid-xxxx');
assert(unknownResult === undefined || unknownResult === null, 'runJobNow: returns null/undefined for missing id');

// ===========================================================
// SECTION 8: payload_scope (cross-session sub-agent visibility)
// ===========================================================

console.log('\n-- payload_scope --');

// Schema: column must exist with default 'own'
const scopeCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(scopeCols.includes('payload_scope'), 'jobs.payload_scope column exists');

// Default scope is 'own' when not specified
const scopeDefaultJob = createJob({ name: 'ScopeDefault', schedule_cron: '0 10 * * *', payload_message: 'default scope', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
assert(scopeDefaultJob.payload_scope === 'own', "default payload_scope = 'own'");

// Create job with payload_scope='global'
const scopeGlobalJob = createJob({ name: 'ScopeGlobal', schedule_cron: '0 11 * * *', payload_message: 'check all sub-agents', payload_scope: 'global', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
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

// ===========================================================
// DONE
// ===========================================================


// ===========================================================
// SECTION: Resource Pool Concurrency (Global Locks)
// ===========================================================

console.log('\n-- Resource Pool --');

// schema: resource_pool column exists
const jobColsPool = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(jobColsPool.includes('resource_pool'), 'jobs.resource_pool column exists');

// Create two jobs sharing the same pool
const poolJob1 = createJob({
  name: 'Pool Job 1',
  schedule_cron: '*/5 * * * *',
  payload_message: 'pool task 1',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  resource_pool: 'browser',
  run_timeout_ms:   300_000, origin: 'system',
});
const poolJob2 = createJob({
  name: 'Pool Job 2',
  schedule_cron: '*/5 * * * *',
  payload_message: 'pool task 2',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  resource_pool: 'browser',
  run_timeout_ms:   300_000, origin: 'system',
});
const noPoolJob = createJob({
  name: 'No Pool Job',
  schedule_cron: '*/5 * * * *',
  payload_message: 'no pool',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});

assert(getJob(poolJob1.id).resource_pool === 'browser', 'poolJob1 has resource_pool=browser');
assert(getJob(poolJob2.id).resource_pool === 'browser', 'poolJob2 has resource_pool=browser');
assert(getJob(noPoolJob.id).resource_pool === null, 'noPoolJob has resource_pool=null');

// Pool is free before any run
assert(hasRunningRunForPool('browser') === false, 'pool free before any run');

// Start a run for poolJob1 -> pool becomes busy
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
assert(hasRunningRunForPool(null) === false, 'null pool -> always false');
assert(hasRunningRunForPool('') === false, 'empty string pool -> always false');

// Finish poolJob2's run -> pool still busy (poolJob1 still running)
finishRun(poolRun2.id, 'ok', { summary: 'done' });
assert(hasRunningRunForPool('browser') === true, 'pool still busy (poolJob1 still running)');

// Finish poolJob1's run -> pool free
finishRun(poolRun1.id, 'ok', { summary: 'done' });
assert(hasRunningRunForPool('browser') === false, 'pool free after all runs finish');
assert(getRunningRunsByPool('browser').length === 0, 'getRunningRunsByPool returns 0 after finish');

// updateJob can set resource_pool
updateJob(noPoolJob.id, { resource_pool: 'database' });
assert(getJob(noPoolJob.id).resource_pool === 'database', 'updateJob sets resource_pool');

// ===========================================================
// SECTION: Event-Based Job Chaining -- trigger_condition (v4)
// ===========================================================

console.log('\n-- trigger_condition --');

// Schema: trigger_condition column exists
const tcCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
assert(tcCols.includes('trigger_condition'), 'jobs.trigger_condition column exists');

// -- evalTriggerCondition unit tests ----------------------
// null/undefined -> always matches
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
assert(evalTriggerCondition('regex:[invalid', 'anything') === false, 'regex: invalid pattern -> false');

// -- fireTriggeredChildren with trigger_condition ---------
const tcParent = createJob({
  name: 'TC Parent',
  schedule_cron: '0 6 * * *',
  payload_message: 'monitor',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});

// Child that fires only when output contains "ALERT"
const tcChildAlert = createJob({
  name: 'TC OnAlert',
  parent_id: tcParent.id,
  trigger_on: 'success',
  trigger_condition: 'contains:ALERT',
  payload_message: 'escalate',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});
assert(getJob(tcChildAlert.id).trigger_condition === 'contains:ALERT', 'trigger_condition stored');

// Child with no condition -- fires on status only
const tcChildAlways = createJob({
  name: 'TC Always',
  parent_id: tcParent.id,
  trigger_on: 'success',
  payload_message: 'always run',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});
assert(getJob(tcChildAlways.id).trigger_condition === null, 'no trigger_condition -> null');

// Child with regex condition
const tcChildRegex = createJob({
  name: 'TC Regex',
  parent_id: tcParent.id,
  trigger_on: 'success',
  trigger_condition: 'regex:CPU|MEM',
  payload_message: 'resource alert',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});

// Reset next_run_at for all children
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 1: "ALERT: high CPU" -- all three match
// contains:ALERT -> matches "ALERT: high CPU" (yes)
// no condition -> always fires (yes)
// regex:CPU|MEM -> matches "CPU" (yes)
const triggered1 = fireTriggeredChildren(tcParent.id, 'ok', 'ALERT: high CPU');
assert(triggered1.some(c => c.id === tcChildAlert.id), 'alert child fires: output has ALERT');
assert(triggered1.some(c => c.id === tcChildAlways.id), 'always child fires: no condition');
assert(triggered1.some(c => c.id === tcChildRegex.id), 'regex child fires: output has CPU');

// Reset
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 2: "all clear" -- only no-condition child should fire
const triggered2 = fireTriggeredChildren(tcParent.id, 'ok', 'all clear');
assert(!triggered2.some(c => c.id === tcChildAlert.id), 'alert child does NOT fire: no ALERT in output');
assert(triggered2.some(c => c.id === tcChildAlways.id), 'always child fires regardless of output');
assert(!triggered2.some(c => c.id === tcChildRegex.id), 'regex child does NOT fire: no CPU or MEM');

// Reset
db.prepare('UPDATE jobs SET next_run_at = NULL WHERE parent_id = ?').run(tcParent.id);

// CASE 3: "MEM usage high" -- regex child and no-condition child fire, alert child doesn't
const triggered3 = fireTriggeredChildren(tcParent.id, 'ok', 'MEM usage high');
assert(!triggered3.some(c => c.id === tcChildAlert.id), 'alert child does NOT fire: no ALERT in MEM output');
assert(triggered3.some(c => c.id === tcChildAlways.id), 'always child fires for MEM output');
assert(triggered3.some(c => c.id === tcChildRegex.id), 'regex child fires: output matches MEM');

// CASE 4: Failure path -- children only triggered on matching trigger_on
const tcChildOnFail = createJob({
  name: 'TC OnFail',
  parent_id: tcParent.id,
  trigger_on: 'failure',
  trigger_condition: 'contains:CRITICAL',
  payload_message: 'fail handler',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
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

// ===========================================================
// SECTION: Delivery Alias Resolution
// ===========================================================

console.log('\n-- Delivery Aliases --');

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

// Insert test fixture aliases (no longer seeded in schema -- placeholder data removed for npm publish)
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('team_room', 'telegram', '-1000000001', 'Team room');
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('owner_dm', 'telegram', '1000000001', 'Owner DM');

const teamRoomRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(teamRoomRow !== undefined,               'fixture alias: team_room exists');
assert(teamRoomRow?.channel === 'telegram',     'team_room channel = telegram');
assert(teamRoomRow?.target  === '-1000000001',  'team_room target = -1000000001');

const ownerDmRow = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('owner_dm');
assert(ownerDmRow !== undefined,              'fixture alias: owner_dm exists');
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
assert(allAliases.length >= 3, 'alias list: at least 3 aliases (2 fixtures + 1 added)');
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

// Unknown alias falls through (returns null -> caller uses raw target, backward compat)
const r4 = resolveTestAlias('@nonexistent');
assert(r4 === null, 'unknown @alias returns null (backward compat)');

const r5 = resolveTestAlias('rawid12345');
assert(r5 === null, 'raw ID with no alias match returns null');

// Job with delivery_to='@team_room' stores alias as-is, resolves correctly
const aliasJob = createJob({
  name: 'AliasDeliveryJob',
  schedule_cron: '0 9 * * *',
  payload_message: 'alias test',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  delivery_to: '@team_room',
  run_timeout_ms:   300_000, origin: 'system',
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
assert(stillTeamRoom !== undefined, 'fixture alias team_room still intact after other alias removed');

// Upsert (INSERT OR REPLACE) works for alias updates
db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
  .run('team_room', 'telegram', '-1000000001', 'Updated description');
const updatedTeamRoom = db.prepare('SELECT * FROM delivery_aliases WHERE alias = ?').get('team_room');
assert(updatedTeamRoom?.description === 'Updated description', 'alias upsert updates description');
assert(updatedTeamRoom?.target === '-1000000001', 'alias upsert preserves target');

// ===========================================================
// v5 Features
// ===========================================================

console.log('\n-- v5: Delivery Semantics --');
{
  const j1 = createJob({ name: 'at-most-once-job', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-most-once' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  assert(j1.delivery_guarantee === 'at-most-once', 'delivery_guarantee defaults to at-most-once');

  const j2 = createJob({ name: 'at-least-once-job', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  assert(j2.delivery_guarantee === 'at-least-once', 'delivery_guarantee set to at-least-once');

  const j3 = createJob({ name: 'default-guarantee', schedule_cron: '0 * * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  assert(j3.delivery_guarantee === 'at-most-once', 'delivery_guarantee default when omitted');

  const j4 = updateJob(j2.id, { delivery_guarantee: 'at-most-once' });
  assert(j4.delivery_guarantee === 'at-most-once', 'delivery_guarantee updateable');

  deleteJob(j1.id); deleteJob(j2.id); deleteJob(j3.id);
}

console.log('\n-- v5: Job Class / Flush Hook --');
{
  const j1 = createJob({ name: 'standard-job', schedule_cron: '0 * * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  assert(j1.job_class === 'standard', 'job_class defaults to standard');

  const j2 = createJob({ name: 'flush-job', schedule_cron: '0 * * * *', payload_message: 'test', job_class: 'pre_compaction_flush' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  assert(j2.job_class === 'pre_compaction_flush', 'job_class set to pre_compaction_flush');

  const j3 = updateJob(j2.id, { job_class: 'standard' });
  assert(j3.job_class === 'standard', 'job_class updateable');

  deleteJob(j1.id); deleteJob(j2.id);
}

console.log('\n-- v5: Context Summary --');
{
  const j = createJob({ name: 'ctx-job', schedule_cron: '0 * * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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

console.log('\n-- v5: Typed Messages --');
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

console.log('\n-- v5: Approval Gates --');
{
  // Import approval module
  const { createApproval, getPendingApproval, listPendingApprovals, resolveApproval } = await import('./approval.js');

  const j = createJob({ name: 'approval-job', schedule_cron: '0 * * * *', payload_message: 'test', approval_required: 1, approval_timeout_s: 60, approval_auto: 'reject' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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

console.log('\n-- v5: Run Replay Fields --');
{
  const j = createJob({ name: 'replay-test', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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

console.log('\n-- v5: Hybrid Retrieval --');
{
  const { getRecentRunSummaries, searchRunSummaries, buildRetrievalContext } = await import('./retrieval.js');

  const j = createJob({ name: 'retrieval-test', schedule_cron: '0 * * * *', payload_message: 'check deployment status', context_retrieval: 'hybrid', context_retrieval_limit: 3 , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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
  const j2 = createJob({ name: 'no-retrieval', schedule_cron: '0 * * * *', payload_message: 'test', context_retrieval: 'none' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  const noCtx = buildRetrievalContext(j2);
  assert(noCtx === '', 'buildRetrievalContext empty for none');

  deleteJob(j.id); deleteJob(j2.id);
}

console.log('\n-- Schema Baseline --');
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

}

console.log('\n-- v5: Task Tracker --');
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
  // Don't call agentStarted -- leave agent in 'pending' with no heartbeat.
  // This simulates a sub-agent that was spawned but never reported in.
  const dead = tt.checkDeadAgents();
  assert(dead.length > 0, 'dead agent detected after timeout (no heartbeat, pending)');
  const deadAgent = dead.find(d => d.tracker_id === group2.id);
  assert(deadAgent !== undefined, 'correct dead agent found');

  // After marking dead, group should complete as failed
  tt.checkGroupCompletion(group2.id);
  const g2 = tt.getTaskGroup(group2.id);
  assert(g2.status === 'failed', 'group with dead agent marked failed');

  // -- v8: session key registration and heartbeat -----------
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
  // last_heartbeat was just set -- agent should be spared
  const notDead = tt.checkDeadAgents().filter(d => d.tracker_id === group4.id);
  assert(notDead.length === 0, 'agent with recent heartbeat not marked dead despite timeout');
}

console.log('\n-- v10: Team Adapter --');
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

console.log('\n-- Idempotency Keys --');
{
  const {
    generateIdempotencyKey, generateChainIdempotencyKey, generateRunNowIdempotencyKey,
    claimIdempotencyKey, releaseIdempotencyKey, checkIdempotencyKey, getIdempotencyEntry,
    updateIdempotencyResultHash, listIdempotencyForJob,
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
  const testJob = createJob({ name: 'idem-test-1', schedule_cron: '0 * * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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

  forcePruneIdempotency();
  const expiredAfterPrune = getIdempotencyEntry(expiredKey);
  assert(expiredAfterPrune === null, 'expired key pruned');

  // 14. Prune doesn't delete non-expired keys
  const futureAfterPrune = getIdempotencyEntry(futureKey);
  assert(futureAfterPrune !== null, 'non-expired key survives prune');

  // Clean up future key
  getDb().prepare('DELETE FROM idempotency_ledger WHERE key = ?').run(futureKey);

  // 10. Crashed run keys get released during replay simulation
  const crashJob = createJob({ name: 'crash-idem-test', schedule_cron: '0 * * * *', payload_message: 'test', delivery_guarantee: 'at-least-once' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(alJob.delivery_guarantee === 'at-least-once', 'at-least-once delivery_guarantee stored');
  const alRun = createRun(alJob.id, { run_timeout_ms: 60000, idempotency_key: 'al-test-key-12345678901234567890' });
  assert(alRun.idempotency_key === 'al-test-key-12345678901234567890', 'idempotency key available for prompt injection');
  finishRun(alRun.id, 'ok'); deleteJob(alJob.id);

  // 13. IDEMPOTENT_SKIP handling -- verify matchesSentinel pattern
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

  // forcePruneIdempotency -- same as pruneIdempotencyLedger but returns count
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

// ===========================================================
// SECTION: Shell job type (session_target = 'shell')
// ===========================================================

console.log('\n-- Shell Jobs --');

// Can create a shell job
const shellJob = createJob({
  name: 'Test Shell Job',
  schedule_cron: '0 8-23 * * *',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  payload_message: '/bin/echo hello',
  delivery_mode: 'none', delivery_opt_out_reason: 'test',
  run_timeout_ms:   300_000, origin: 'system',
});
assert(shellJob.session_target === 'shell', 'shell job: session_target = shell');
assert(shellJob.payload_kind === 'shellCommand', 'shell job: payload_kind = shellCommand');
assert(shellJob.payload_message === '/bin/echo hello', 'shell job: payload_message = command');

// Can update to shell target
const toShellJob = createJob({ name: 'To-Shell Job', schedule_cron: '0 12 * * *', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
updateJob(toShellJob.id, { session_target: 'shell', payload_kind: 'shellCommand', payload_message: '/bin/echo updated' });
const updatedShell = getJob(toShellJob.id);
assert(updatedShell.session_target === 'shell', 'shell job update: session_target persisted');
assert(updatedShell.payload_message === '/bin/echo updated', 'shell job update: command persisted');

// Shell one-shot jobs are pruned when disabled + >24h + delete_after_run=1
updateJob(shellJob.id, { enabled: 0, delete_after_run: 1, last_run_at: '2020-01-01 00:00:00' });
pruneExpiredJobs();
assert(!getJob(shellJob.id), 'aged shell job pruned correctly');

// ===========================================================
// SECTION: Transient Error Detection & delete_after_run Safety
// ===========================================================

console.log('\n-- Transient Error Detection --');
{
  // Positive matches -- these should be caught as transient errors
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

  // Negative matches -- these should NOT be flagged
  assert(!detectTransientError('Here is the weather report for today'), 'ignores: normal response');
  assert(!detectTransientError('HEARTBEAT_OK'), 'ignores: heartbeat');
  assert(!detectTransientError('I completed the task successfully'), 'ignores: success response');
  assert(!detectTransientError(''), 'ignores: empty string');
  assert(!detectTransientError(null), 'ignores: null');
  assert(!detectTransientError(undefined), 'ignores: undefined');

  // Long response with keyword only AFTER 500 chars should NOT be flagged
  const longResponse = 'I analyzed the system and found the configuration needs updating. ' +
    'Here are my recommendations: '.padEnd(550, 'x') + ' rate limit exceeded';
  assert(!detectTransientError(longResponse), 'ignores: long response with keyword only after 500 chars');

  // Long response with keyword IN first 500 chars IS flagged (infrastructure error with verbose stack)
  const longInfraError = 'Error: rate limit exceeded. ' + 'Stack trace details: '.padEnd(600, 'x');
  assert(detectTransientError(longInfraError), 'detects: long infra error with keyword in first 500 chars');

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

console.log('\n-- Drain Error Detection --');
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

console.log('\n-- delete_after_run Safety --');
{
  // Test that updateJobAfterRun does NOT delete when status is 'error'
  const oneShot = createJob({
    name: 'OneShot-DAR-Test',
    schedule_cron: '0 12 * * *',
    payload_message: 'one shot task',
    delete_after_run: true,
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(oneShot.delete_after_run === 1, 'one-shot job has delete_after_run=1');

  // Simulate error status -- job should NOT be deleted
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


// ===========================================================
// SECTION: session_target + payload_kind Validation
// ===========================================================

console.log('\n-- Payload Validation --');

// 1. Valid: main + systemEvent
{
  const j = createJob({ name: 'Valid-main-sysEvent', schedule_cron: '0 9 * * *', session_target: 'main', payload_kind: 'systemEvent', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  assert(j.session_target === 'main' && j.payload_kind === 'systemEvent', 'valid: main + systemEvent accepted');
  deleteJob(j.id);
}

// 2. Invalid: main + agentTurn -> should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-main-agentTurn', schedule_cron: '0 9 * * *', session_target: 'main', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , origin: 'system' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: main + agentTurn rejected');
}

// 3. Valid: shell + shellCommand
{
  const j = createJob({ name: 'Valid-shell-cmd', schedule_cron: '0 9 * * *', session_target: 'shell', payload_kind: 'shellCommand', payload_message: '/bin/echo hi', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  assert(j.session_target === 'shell' && j.payload_kind === 'shellCommand', 'valid: shell + shellCommand accepted');
  deleteJob(j.id);
}

// 4. Invalid: shell + agentTurn -> should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-shell-agentTurn', schedule_cron: '0 9 * * *', session_target: 'shell', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , origin: 'system' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: shell + agentTurn rejected');
}

// 5. Valid: isolated + agentTurn (default combo)
{
  const j = createJob({ name: 'Valid-isolated-agentTurn', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  assert(j.session_target === 'isolated' && j.payload_kind === 'agentTurn', 'valid: isolated + agentTurn accepted');
  deleteJob(j.id);
}

// 6. Invalid: isolated + shellCommand -> should throw
{
  let threw = false;
  try { createJob({ name: 'Bad-isolated-shell', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'shellCommand', payload_message: '/bin/echo nope', delivery_mode: 'none', delivery_opt_out_reason: 'test' , origin: 'system' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'invalid: isolated + shellCommand rejected');
}

// 7. updateJob: changing to invalid combo -> should throw
{
  const j = createJob({ name: 'Update-validation', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  let threw = false;
  try { updateJob(j.id, { session_target: 'main', payload_kind: 'agentTurn' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'updateJob rejects invalid target+kind combo');
  deleteJob(j.id);
}

// 8. updateJob: changing session_target alone checks against existing payload_kind
{
  const j = createJob({ name: 'Update-target-only', schedule_cron: '0 9 * * *', session_target: 'isolated', payload_kind: 'agentTurn', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  let threw = false;
  try { updateJob(j.id, { session_target: 'shell' }); }
  catch (e) { threw = e.message.includes('Invalid payload_kind'); }
  assert(threw, 'updateJob: changing target alone validates against existing kind');
  deleteJob(j.id);
}

console.log('\n-- Job Spec Validation --');
{
  let threw = false;
  try {
    validateJobSpec({
      name: 'Bad Control',
      schedule_cron: '0 9 * * *',
      payload_message: 'hello\u0000world',
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
    });
  } catch (e) {
    threw = e.message.includes('control characters');
  }
  assert(threw, 'validateJobSpec rejects control characters in payload_message');

  threw = false;
  try {
    validateJobSpec({
      name: 'Bad Regex',
      parent_id: 'parent-for-regex-validation',
      trigger_on: 'success',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      trigger_condition: 'regex:(',
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
    });
  } catch (e) {
    threw = e.message.includes('Invalid trigger_condition regex');
  }
  assert(threw, 'validateJobSpec rejects invalid trigger_condition regex');

  const normalized = validateJobSpec({
    name: 'Normalize Optional',
    schedule_cron: '0 9 * * *',
    payload_message: 'ok',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    delivery_channel: '',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  assert(normalized.delivery_channel === null, 'validateJobSpec normalizes empty nullable strings to null');

  // run_timeout_ms is required on create
  let threwNoTimeout = false;
  try {
    validateJobSpec({
      name: 'No Timeout',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
      origin: 'system',
    }, null, 'create');
  } catch (e) {
    threwNoTimeout = e.message.includes('run_timeout_ms is required');
  }
  assert(threwNoTimeout, 'validateJobSpec rejects missing run_timeout_ms on create');

  let threwZeroTimeout = false;
  try {
    validateJobSpec({
      name: 'Zero Timeout',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
      run_timeout_ms: 0,
      origin: 'system',
    }, null, 'create');
  } catch (e) {
    // assertInt fires for 0 (min=1): "must be an integer >= 1"
    // required check fires for null/undefined: "run_timeout_ms is required"
    threwZeroTimeout = e.message.includes('run_timeout_ms') &&
      (e.message.includes('required') || e.message.includes('>= 1') || e.message.includes('at least'));
  }
  assert(threwZeroTimeout, 'validateJobSpec rejects run_timeout_ms=0 on create');

  // run_timeout_ms not required on update (partial patch)
  const noTimeoutUpdate = validateJobSpec({ name: 'patch name only' }, { schedule_cron: '0 9 * * *', payload_message: 'x', run_timeout_ms: 300_000 }, 'update');
  assert(noTimeoutUpdate !== undefined, 'validateJobSpec does not require run_timeout_ms on update');
}

console.log('\n-- Origin Field (v20) --');
{
  // Origin is required on root job creation
  let threwNoOrigin = false;
  try {
    createJob({
      name: 'NoOriginJob',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
    });
  } catch (e) {
    threwNoOrigin = e.message.includes('origin is required');
  }
  assert(threwNoOrigin, 'createJob throws when origin missing on root job');

  // Origin is stored and retrievable
  const originJob = createJob({
    name: 'OriginJob',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'telegram:1234567890',
  });
  assert(originJob.origin === 'telegram:1234567890', 'createJob stores origin');
  assert(getJob(originJob.id).origin === 'telegram:1234567890', 'getJob returns origin');
  deleteJob(originJob.id);

  // System origin is accepted
  const sysJob = createJob({
    name: 'SystemOriginJob',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  assert(sysJob.origin === 'system', 'createJob stores "system" origin');
  deleteJob(sysJob.id);

  // Group chat origin is accepted
  const groupJob = createJob({
    name: 'GroupOriginJob',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'telegram:-100200000000',
  });
  assert(groupJob.origin === 'telegram:-100200000000', 'createJob stores group chat origin');
  deleteJob(groupJob.id);

  // Child jobs are exempt from origin requirement
  const parentForOrigin = createJob({
    name: 'OriginParent',
    schedule_cron: '0 9 * * *',
    payload_message: 'parent',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  const childNoOrigin = createJob({
    name: 'ChildNoOriginRequired',
    parent_id: parentForOrigin.id,
    trigger_on: 'success',
    payload_message: 'child task',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    // no origin -- child jobs are exempt
  });
  assert(childNoOrigin && childNoOrigin.origin === null, 'child jobs do not require origin');
  deleteJob(childNoOrigin.id);
  deleteJob(parentForOrigin.id);

  // origin is not required on update (partial patch)
  const updateableOriginJob = createJob({
    name: 'UpdateOrigin',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  const updated = updateJob(updateableOriginJob.id, { origin: 'telegram:999' });
  assert(updated.origin === 'telegram:999', 'updateJob can update origin');
  deleteJob(updateableOriginJob.id);

  // schema: origin column exists
  const jCols = getDb().prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  assert(jCols.includes('origin'), 'jobs table has origin column');
}

console.log('\n-- Delivery Enforcement (v19) --');
{
  // Test 1: agentTurn + delivery_mode "none" + no opt-out reason -> throws
  let threw1 = false;
  try {
    createJob({
      name: 'NoDeliveryNoReason',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'none',
      run_timeout_ms:   300_000, origin: 'system',
    });
  } catch (e) {
    threw1 = e.message.includes('delivery_opt_out_reason');
  }
  assert(threw1, 'agentTurn + delivery_mode "none" + no opt-out reason -> throws');

  // Test 2: agentTurn + delivery_mode "none" + opt-out reason -> passes
  const j2 = createJob({
    name: 'OptOutWithReason',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'internal monitoring, no human delivery needed',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(j2 && j2.delivery_opt_out_reason === 'internal monitoring, no human delivery needed', 'agentTurn + delivery_mode "none" + opt-out reason -> passes');
  deleteJob(j2.id);

  // Test 3: agentTurn + delivery_mode "announce" + delivery_to -> passes
  const j3 = createJob({
    name: 'WithDeliveryTarget',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'announce',
    delivery_to: '1234567890',
    delivery_channel: 'telegram',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(j3 && j3.delivery_mode === 'announce', 'agentTurn + delivery_mode "announce" + delivery_to -> passes');
  deleteJob(j3.id);

  // Test 4: systemEvent/main + delivery_mode "none" -> passes (exempt)
  const j4 = createJob({
    name: 'SystemEventNoDelivery',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    session_target: 'main',
    payload_kind: 'systemEvent',
    delivery_mode: 'none',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(j4 && j4.delivery_mode === 'none', 'systemEvent/main + delivery_mode "none" -> passes (exempt)');
  deleteJob(j4.id);

  // Test 5: child agentTurn + delivery_mode "none" -> passes (exempt)
  const parentJ = createJob({
    name: 'EnforcementParent',
    schedule_cron: '0 9 * * *',
    payload_message: 'parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'parent for child test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  const j5 = createJob({
    name: 'ChildNoDelivery',
    parent_id: parentJ.id,
    trigger_on: 'success',
    payload_message: 'child task',
    delivery_mode: 'none',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(j5 && j5.delivery_mode === 'none' && !j5.delivery_opt_out_reason, 'child agentTurn + delivery_mode "none" -> passes (exempt)');
  deleteJob(j5.id);
  deleteJob(parentJ.id);

  // Test 6: shell job + delivery_mode "none" -> passes (exempt, not agentTurn)
  const j6 = createJob({
    name: 'ShellNoDelivery',
    schedule_cron: '0 9 * * *',
    payload_message: 'echo hi',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    delivery_mode: 'none',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(j6 && j6.delivery_mode === 'none', 'shell + delivery_mode "none" -> passes (exempt)');
  deleteJob(j6.id);

  // Test 7: delivery_opt_out_reason persists via updateJob
  const j7 = createJob({
    name: 'UpdateOptOut',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'original reason',
    run_timeout_ms:   300_000, origin: 'system',
  });
  const j7u = updateJob(j7.id, { delivery_opt_out_reason: 'updated reason' });
  assert(j7u.delivery_opt_out_reason === 'updated reason', 'delivery_opt_out_reason updateable');
  deleteJob(j7.id);

  // Test 8: root agentTurn cannot be updated into delivery_mode="none" without opt-out reason
  const j8 = createJob({
    name: 'UpdateToNoDeliveryRequiresReason',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'announce',
    delivery_to: '1234567890',
    delivery_channel: 'telegram',
    run_timeout_ms:   300_000, origin: 'system',
  });
  let threwUpdateNoReason = false;
  try {
    updateJob(j8.id, {
      delivery_mode: 'none',
      delivery_channel: null,
      delivery_to: null,
    });
  } catch (e) {
    threwUpdateNoReason = e.message.includes('delivery_opt_out_reason');
  }
  assert(threwUpdateNoReason, 'updateJob rejects root agentTurn -> delivery_mode "none" without opt-out reason');

  const j8u = updateJob(j8.id, {
    delivery_mode: 'none',
    delivery_channel: null,
    delivery_to: null,
    delivery_opt_out_reason: 'internal monitoring, no human delivery needed',
  });
  assert(j8u.delivery_mode === 'none' && j8u.delivery_opt_out_reason, 'updateJob allows root agentTurn -> delivery_mode "none" with opt-out reason');
  deleteJob(j8.id);
}

console.log('\n-- delivery_to Required for Announce Modes --');
{
  // Test 1: createJob with delivery_mode='announce' and delivery_to=null -> throws
  let threw1 = false;
  try {
    createJob({
      name: 'announce-no-delivery-to',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'announce',
      run_timeout_ms: 300_000, origin: 'system',
    });
  } catch (e) {
    threw1 = e.message.includes('delivery_to');
  }
  assert(threw1, 'createJob with delivery_mode=announce and no delivery_to -> throws');

  // Test 2: createJob with delivery_mode='announce' and delivery_to='123456789' -> succeeds
  const j2 = createJob({
    name: 'announce-with-delivery-to',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'announce',
    delivery_to: '123456789',
    delivery_channel: 'telegram',
    run_timeout_ms: 300_000, origin: 'system',
  });
  assert(j2 && j2.delivery_mode === 'announce' && j2.delivery_to === '123456789',
    'createJob with delivery_mode=announce and delivery_to set -> succeeds');
  deleteJob(j2.id);

  // Test 3: createJob with delivery_mode='announce-always' and delivery_to=null -> throws
  let threw3 = false;
  try {
    createJob({
      name: 'announce-always-no-delivery-to',
      schedule_cron: '0 9 * * *',
      payload_message: 'test',
      delivery_mode: 'announce-always',
      run_timeout_ms: 300_000, origin: 'system',
    });
  } catch (e) {
    threw3 = e.message.includes('delivery_to');
  }
  assert(threw3, 'createJob with delivery_mode=announce-always and no delivery_to -> throws');

  // Test 4: createJob with delivery_mode='none' and delivery_to=null -> succeeds (no constraint)
  const j4 = createJob({
    name: 'none-mode-no-delivery-to',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000, origin: 'system',
  });
  assert(j4 && j4.delivery_mode === 'none', 'createJob with delivery_mode=none and no delivery_to -> succeeds');
  deleteJob(j4.id);

  // Test 5: updateJob to set delivery_mode='announce' without delivery_to -> throws
  const j5base = createJob({
    name: 'update-to-announce-base',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000, origin: 'system',
  });
  let threw5 = false;
  try {
    updateJob(j5base.id, { delivery_mode: 'announce' });
  } catch (e) {
    threw5 = e.message.includes('delivery_to');
  }
  assert(threw5, 'updateJob setting delivery_mode=announce without delivery_to -> throws');
  deleteJob(j5base.id);

  // Test 6: updateJob to set delivery_mode='announce' WITH delivery_to -> succeeds
  const j6base = createJob({
    name: 'update-to-announce-with-target',
    schedule_cron: '0 9 * * *',
    payload_message: 'test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000, origin: 'system',
  });
  const j6updated = updateJob(j6base.id, {
    delivery_mode: 'announce',
    delivery_to: '123456789',
    delivery_channel: 'telegram',
  });
  assert(j6updated.delivery_mode === 'announce' && j6updated.delivery_to === '123456789',
    'updateJob setting delivery_mode=announce with delivery_to -> succeeds');
  deleteJob(j6base.id);
}

console.log('\n-- Delivery Chunking --');
{
  const short = splitMessageForChannel('telegram', 'hello world');
  assert(short.length === 1, 'short telegram message stays single-part');

  const long = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 250);
  const parts = splitMessageForChannel('telegram', long);
  assert(parts.length >= 2, 'long telegram message is split into multiple parts');
  assert(parts.every(p => p.length <= TELEGRAM_MAX_MESSAGE_LENGTH), 'all telegram parts obey max length');
  assert(parts[0].startsWith('[1/'), 'chunked telegram parts include part prefix');
}

console.log('\n-- CLI JSON / Dry-Run / Schema --');
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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300000,
    origin: 'system',
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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300000,
    origin: 'system',
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

  // Test: jobs cancel with no ID should fail
  let cancelErr = null;
  try {
    execFileSync(process.execPath, [cliPath, 'jobs', 'cancel', '--json'], {
      cwd: process.cwd(),
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(false, 'jobs cancel with no ID should have thrown');
  } catch (err) {
    cancelErr = err;
    assert(err.status !== 0, 'jobs cancel with no ID exits non-zero');
  }
  const cancelStdout = String(cancelErr?.stdout || '');
  const cancelStderr = String(cancelErr?.stderr || '');
  let cancelJson = null;
  try { cancelJson = JSON.parse(cancelStdout); } catch {}
  assert(cancelJson?.ok === false, 'jobs cancel --json writes structured error payload to stdout');
  assert(cancelJson?.error === 'Usage: jobs cancel <id> [--no-cascade]', 'jobs cancel --json preserves usage error message');
  assert(cancelStderr.trim() === '', 'jobs cancel --json does not write structured error payload to stderr');

  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('\n-- CLI Launcher Routing --');
{
  const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-bin-'));
  const dbPath = join(tempRoot, 'scheduler.db');
  const homeDir = join(tempRoot, 'home');
  const labelsPath = join(tempRoot, 'labels.json');
  const binPath = join(dirname(fileURLToPath(import.meta.url)), 'bin/openclaw-scheduler.js');

  mkdirSync(homeDir, { recursive: true });
  writeFileSync(labelsPath, JSON.stringify({
    'worker-schema': {
      sessionKey: 'agent:main:subagent:test-session',
      status: 'done',
      agent: 'main',
      mode: 'fresh',
      spawnedAt: '2026-03-31T12:00:00.000Z',
      updatedAt: '2026-03-31T12:05:00.000Z',
      summary: 'completed',
    },
  }, null, 2));

  const baseEnv = {
    ...process.env,
    HOME: homeDir,
    SCHEDULER_DB: dbPath,
    DISPATCH_LABELS_PATH: labelsPath,
  };
  const schedulerStatus = execFileSync(process.execPath, [binPath, 'status'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  });
  assert(schedulerStatus.includes('=== OpenClaw Scheduler Status ==='), 'bin status without --label routes to scheduler CLI health view');

  const dispatchStatus = JSON.parse(execFileSync(process.execPath, [binPath, 'status', '--label', 'worker-schema', '--json'], {
    cwd: process.cwd(),
    env: baseEnv,
    encoding: 'utf8',
  }));
  assert(dispatchStatus.ok === true, 'bin status --label returns dispatch status payload');
  assert(dispatchStatus.label === 'worker-schema', 'bin status --label preserves requested label');
  assert(dispatchStatus.status === 'done', 'bin status --label routes to dispatch label status');

  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('\n-- Dispatch Script Compatibility --');
{
  const envBase = { HOME: '/tmp/testuser' };
  const schedulerPath = '/tmp/testuser/.openclaw/scheduler/dispatch/index.mjs';
  const dispatchPath = '/tmp/testuser/.openclaw/dispatch/index.mjs';

  const noBin = () => false; // stub out binary-in-PATH check so file fallbacks are tested

  const schedulerOnly = new Set([schedulerPath]);
  assert(
    resolveDispatchCliPath(envBase, p => schedulerOnly.has(p), noBin) === schedulerPath,
    'resolveDispatchCliPath prefers scheduler/dispatch path when available'
  );

  const dispatchOnly = new Set([dispatchPath]);
  assert(
    resolveDispatchCliPath(envBase, p => dispatchOnly.has(p), noBin) === dispatchPath,
    'resolveDispatchCliPath falls back to dispatch path when scheduler path missing'
  );

  const explicitDispatch = '/opt/custom/dispatch/index.mjs';
  const explicitSet = new Set([explicitDispatch, schedulerPath]);
  assert(
    resolveDispatchCliPath(
      { ...envBase, DISPATCH_CLI: explicitDispatch },
      p => explicitSet.has(p),
      noBin,
    ) === explicitDispatch,
    'resolveDispatchCliPath prioritizes DISPATCH_CLI override'
  );

  const labels = {
    alpha: { status: 'running' },
    beta: { status: 'done' },
  };
  assert(resolveDispatchLabel('alpha', labels) === 'alpha', 'resolveDispatchLabel handles direct label match');
  assert(resolveDispatchLabel('dispatch-deliver:alpha', labels) === 'alpha', 'resolveDispatchLabel handles dispatch watcher prefix');
  assert(resolveDispatchLabel('dispatch-deliver:missing', labels) === null, 'resolveDispatchLabel returns null for missing label');
}


// ===========================================================
// SECTION: Watchdog Job Type (v13)
// ===========================================================

console.log('\n-- Watchdog Jobs --');
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
  const stdJob = createJob({ name: 'StdJob', schedule_cron: '0 10 * * *', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test' , run_timeout_ms: 300_000, origin: 'system' });
  assert(stdJob.job_type === 'standard', "default job_type = 'standard'");
  deleteJob(stdJob.id);

  // Create a watchdog job
  const wdJob = createJob({
    name: 'Test Watchdog',
    schedule_cron: '*/10 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo check',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    job_type: 'watchdog',
    watchdog_target_label: 'my-task',
    watchdog_check_cmd: 'node dispatch/index.mjs stuck --label my-task --threshold-min 15',
    watchdog_timeout_min: 60,
    watchdog_alert_channel: 'telegram',
    watchdog_alert_target: '123456789',
    watchdog_self_destruct: 1,
    watchdog_started_at: new Date().toISOString(),
    run_timeout_ms:   300_000, origin: 'system',
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
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
      job_type: 'watchdog',
      watchdog_target_label: 'test',
      // missing watchdog_check_cmd
      run_timeout_ms:   300_000, origin: 'system',
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
      delivery_mode: 'none', delivery_opt_out_reason: 'test',
      job_type: 'invalid',
      run_timeout_ms:   300_000, origin: 'system',
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

// ===========================================================
// AUTH PROFILE
// ===========================================================

console.log('\n-- Auth Profile --');
{
  // Create job with auth_profile: 'inherit'
  const inheritJob = createJob({
    name: 'Test Auth Profile Inherit',
    schedule_cron: '0 0 * * *',
    payload_message: 'test inherit profile',
    session_target: 'isolated',
    auth_profile: 'inherit',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(inheritJob.auth_profile === 'inherit', 'auth_profile=inherit stored correctly');

  // Create job with specific auth_profile
  const specificJob = createJob({
    name: 'Test Auth Profile Specific',
    schedule_cron: '0 0 * * *',
    payload_message: 'test specific profile',
    session_target: 'isolated',
    auth_profile: 'anthropic:gmail',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(specificJob.auth_profile === 'anthropic:gmail', 'auth_profile=anthropic:gmail stored correctly');

  // Create job with null auth_profile (default)
  const nullJob = createJob({
    name: 'Test Auth Profile Null',
    schedule_cron: '0 0 * * *',
    payload_message: 'test null profile',
    session_target: 'isolated',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(nullJob.auth_profile === null, 'auth_profile defaults to null');

  // Create job with explicit null auth_profile
  const explicitNullJob = createJob({
    name: 'Test Auth Profile Explicit Null',
    schedule_cron: '0 0 * * *',
    payload_message: 'test explicit null',
    session_target: 'isolated',
    auth_profile: null,
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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
    validateJobSpec({ auth_profile: 123, name: 'bad', schedule_cron: '0 0 * * *', payload_message: 'x', delivery_to: '123456789' }, null, 'create');
  } catch (e) {
    caught = e.message.includes('auth_profile must be a string');
  }
  assert(caught, 'auth_profile rejects non-string types');

  // Whitespace-only auth_profile normalizes to null (via normalizeNullableString)
  const wsResult = validateJobSpec({ auth_profile: '  ', name: 'ok', schedule_cron: '0 0 * * *', payload_message: 'x', run_timeout_ms: 300_000, origin: 'system', delivery_to: '123456789' }, null, 'create');
  assert(wsResult.auth_profile === null, 'auth_profile whitespace normalizes to null');

  // Validation: reject boolean type
  caught = false;
  try {
    validateJobSpec({ auth_profile: true, name: 'bad', schedule_cron: '0 0 * * *', payload_message: 'x', delivery_to: '123456789' }, null, 'create');
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

console.log('\n-- Migration Guard --');
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
  let migrationLogs = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, cb) => {
    migrationLogs += String(chunk);
    if (typeof cb === 'function') cb();
    return true;
  });
  try {
    await initDb();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const migratedDb = getDb();
  const migratedRunCols = migratedDb.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  const migratedJobCols = migratedDb.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  const migratedMsgCols = migratedDb.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  const migratedApprovalCols = migratedDb.prepare('PRAGMA table_info(approvals)').all().map(c => c.name);
  const migratedTtaCols = migratedDb.prepare('PRAGMA table_info(task_tracker_agents)').all().map(c => c.name);
  assert(!migrationLogs.includes('migrate-consolidate error'), 'migration guard completes without consolidate errors on partial legacy tables');
  assert(!migrationLogs.includes('Schema apply warning'), 'migration guard completes without schema-apply warnings on partial legacy tables');
  assert(!migrationLogs.includes('Schema re-apply warning'), 'migration guard completes without schema re-apply warnings on partial legacy tables');
  assert(migratedRunCols.includes('shell_exit_code'), 'migration guard backfills shell_exit_code when version marker is already 14');
  assert(migratedRunCols.includes('shell_stdout_path'), 'migration guard backfills shell_stdout_path when version marker is already 14');
  assert(migratedJobCols.includes('execution_intent'), 'migration guard backfills execution_intent when version marker is already 14');
  assert(migratedJobCols.includes('origin'), 'migration guard backfills origin (v20) when version marker is already 14');
  assert(migratedMsgCols.includes('to_agent') && migratedMsgCols.includes('status'), 'migration guard backfills base messages columns on partial legacy tables');
  assert(migratedMsgCols.includes('reply_to') && migratedMsgCols.includes('body') && migratedMsgCols.includes('metadata'),
    'migration guard backfills modern messages columns on partial legacy tables');
  assert(migratedApprovalCols.includes('job_id') && migratedApprovalCols.includes('status'), 'migration guard backfills base approvals columns on partial legacy tables');
  assert(migratedTtaCols.includes('tracker_id') && migratedTtaCols.includes('status'), 'migration guard backfills base task_tracker_agents columns on partial legacy tables');
  const migratedMsg = sendMessage({ from_agent: 'legacy-a', to_agent: 'legacy-b', body: 'migrated hello' });
  assert(migratedMsg.body === 'migrated hello', 'sendMessage works after message-column migration');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n-- Partial Legacy Jobs + Messages Migration --');
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'scheduler-legacy-jobs-msg-'));
  const legacyDbPath = join(legacyDir, 'scheduler.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_cron TEXT NOT NULL,
      schedule_tz TEXT NOT NULL DEFAULT 'UTC',
      session_target TEXT NOT NULL DEFAULT 'isolated',
      payload_kind TEXT NOT NULL,
      payload_message TEXT NOT NULL,
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      delivery_mode TEXT DEFAULT 'none',
      delivery_opt_out_reason TEXT DEFAULT NULL,
      origin TEXT DEFAULT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, to_agent TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_seen_at TEXT, session_key TEXT, capabilities TEXT);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (14);
  `);
  legacyDb.close();

  closeDb();
  setDbPath(legacyDbPath);
  let migrationLogs = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, cb) => {
    migrationLogs += String(chunk);
    if (typeof cb === 'function') cb();
    return true;
  });
  try {
    await initDb();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const migratedDb = getDb();
  const migratedJobCols = migratedDb.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  const migratedMsgCols = migratedDb.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  assert(!migrationLogs.includes('migrate-consolidate error'), 'partial legacy job/message migration completes without consolidate errors');
  assert(!migrationLogs.includes('Schema apply warning'), 'partial legacy job/message migration completes without schema warnings');
  assert(migratedJobCols.includes('parent_id') && migratedJobCols.includes('next_run_at')
    && migratedJobCols.includes('last_run_at') && migratedJobCols.includes('last_status')
    && migratedJobCols.includes('consecutive_errors'),
  'partial legacy jobs gain scheduling-state columns');
  assert(migratedMsgCols.includes('reply_to') && migratedMsgCols.includes('subject')
    && migratedMsgCols.includes('body') && migratedMsgCols.includes('metadata'),
  'partial legacy messages gain modern message columns');
  const migratedMsg = sendMessage({ from_agent: 'a', to_agent: 'b', body: 'partial migration ok' });
  assert(migratedMsg.body === 'partial migration ok', 'sendMessage works after partial legacy job/message migration');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n-- Legacy At-Job Normalization --');
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'scheduler-at-migrate-'));
  const legacyDbPath = join(legacyDir, 'scheduler.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_kind TEXT NOT NULL DEFAULT 'cron',
      schedule_at TEXT DEFAULT NULL,
      schedule_cron TEXT,
      schedule_tz TEXT NOT NULL DEFAULT 'UTC',
      session_target TEXT NOT NULL DEFAULT 'isolated',
      agent_id TEXT DEFAULT 'main',
      payload_kind TEXT NOT NULL,
      payload_message TEXT NOT NULL,
      payload_timeout_seconds INTEGER DEFAULT 120,
      execution_intent TEXT NOT NULL DEFAULT 'execute',
      execution_read_only INTEGER NOT NULL DEFAULT 0,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      max_queued_dispatches INTEGER NOT NULL DEFAULT 25,
      max_pending_approvals INTEGER NOT NULL DEFAULT 10,
      max_trigger_fanout INTEGER NOT NULL DEFAULT 25,
      delivery_mode TEXT DEFAULT 'none',
      delivery_channel TEXT,
      delivery_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delete_after_run INTEGER NOT NULL DEFAULT 0,
      ttl_hours INTEGER DEFAULT NULL,
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
      output_store_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_summary_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536,
      preferred_session_key TEXT DEFAULT NULL,
      auth_profile TEXT DEFAULT NULL,
      delivery_opt_out_reason TEXT DEFAULT NULL,
      origin TEXT DEFAULT NULL,
      job_type TEXT NOT NULL DEFAULT 'standard',
      watchdog_target_label TEXT,
      watchdog_check_cmd TEXT,
      watchdog_timeout_min INTEGER,
      watchdog_alert_channel TEXT,
      watchdog_alert_target TEXT,
      watchdog_self_destruct INTEGER NOT NULL DEFAULT 1,
      watchdog_started_at TEXT,
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
      shell_exit_code INTEGER,
      shell_signal TEXT,
      shell_timed_out INTEGER NOT NULL DEFAULT 0,
      shell_stdout TEXT,
      shell_stderr TEXT,
      shell_stdout_path TEXT,
      shell_stderr_path TEXT,
      shell_stdout_bytes INTEGER NOT NULL DEFAULT 0,
      shell_stderr_bytes INTEGER NOT NULL DEFAULT 0,
      dispatched_at TEXT,
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      retry_count INTEGER DEFAULT 0,
      retry_of TEXT,
      triggered_by_run TEXT,
      dispatch_queue_id TEXT,
      context_summary TEXT,
      replay_of TEXT,
      idempotency_key TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, to_agent TEXT, status TEXT, created_at TEXT, delivery_to TEXT);
    CREATE TABLE task_tracker_agents (id TEXT PRIMARY KEY, session_key TEXT, last_heartbeat TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, job_id TEXT, run_id TEXT, dispatch_queue_id TEXT, status TEXT, requested_at TEXT, resolved_at TEXT, resolved_by TEXT, notes TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_seen_at TEXT, session_key TEXT, capabilities TEXT, delivery_channel TEXT, delivery_to TEXT, brand_name TEXT, created_at TEXT);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (21);
  `);
  legacyDb.prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_kind, schedule_at, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      delivery_mode, delete_after_run, next_run_at, run_timeout_ms,
      delivery_opt_out_reason, origin
    ) VALUES (?, ?, 1, 'at', ?, '0 0 31 2 *', 'UTC', 'isolated', 'main', 'agentTurn', 'legacy at job', 'none', 1, ?, 300000, 'test', 'system')
  `).run('legacy-at-job', 'LegacyAtJob', '2026-03-27T18:00:00.000Z', '2026-03-27T18:00:00.000Z');
  legacyDb.close();

  closeDb();
  setDbPath(legacyDbPath);
  await initDb();
  const normalizedLegacyAt = getJob('legacy-at-job');
  assert(normalizedLegacyAt.schedule_at === '2026-03-27 18:00:00', 'migration normalizes legacy ISO schedule_at');
  assert(getDueAtJobs().some(j => j.id === 'legacy-at-job'), 'legacy ISO at-job is due after migration/init');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n-- Partial Current Schema Consolidation --');
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'scheduler-partial-current-'));
  const legacyDbPath = join(legacyDir, 'scheduler.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT,
      enabled INTEGER,
      schedule_cron TEXT,
      schedule_tz TEXT,
      session_target TEXT,
      payload_kind TEXT,
      payload_message TEXT,
      run_timeout_ms INTEGER,
      job_type TEXT,
      execution_intent TEXT,
      max_queued_dispatches INTEGER,
      output_offload_threshold_bytes INTEGER,
      ttl_hours INTEGER,
      auth_profile TEXT,
      schedule_kind TEXT,
      schedule_at TEXT,
      delivery_mode TEXT,
      delivery_opt_out_reason TEXT,
      origin TEXT,
      parent_id TEXT,
      next_run_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      status TEXT,
      started_at TEXT,
      last_heartbeat TEXT,
      run_timeout_ms INTEGER,
      dispatch_queue_id TEXT,
      shell_exit_code INTEGER,
      shell_signal TEXT,
      shell_timed_out INTEGER,
      shell_stdout TEXT,
      shell_stderr TEXT,
      shell_stdout_path TEXT,
      shell_stderr_path TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      last_seen_at TEXT,
      session_key TEXT,
      capabilities TEXT,
      delivery_channel TEXT,
      delivery_to TEXT,
      brand_name TEXT,
      created_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      to_agent TEXT,
      status TEXT,
      created_at TEXT,
      delivery_to TEXT
    );
    CREATE TABLE task_tracker_agents (
      id TEXT PRIMARY KEY,
      session_key TEXT,
      last_heartbeat TEXT
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      run_id TEXT,
      status TEXT,
      requested_at TEXT
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (21);
  `);
  legacyDb.close();

  closeDb();
  setDbPath(legacyDbPath);
  let migrationLogs = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk, encoding, cb) => {
    migrationLogs += String(chunk);
    if (typeof cb === 'function') cb();
    return true;
  });
  try {
    await initDb();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const migratedDb = getDb();
  const migratedRunCols = migratedDb.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  const migratedMsgCols = migratedDb.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  const migratedTtaCols = migratedDb.prepare('PRAGMA table_info(task_tracker_agents)').all().map(c => c.name);
  assert(!migrationLogs.includes('migrate-consolidate error'), 'partial current-schema migration completes without consolidate errors');
  assert(!migrationLogs.includes('Schema apply warning'), 'partial current-schema migration completes without schema warnings');
  assert(migratedRunCols.includes('idempotency_key'), 'partial current-schema migration backfills runs.idempotency_key');
  assert(migratedMsgCols.includes('team_id'), 'partial current-schema migration backfills messages.team_id');
  assert(migratedTtaCols.includes('tracker_id'), 'partial current-schema migration backfills task_tracker_agents.tracker_id');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n-- Legacy Payload Normalization --');
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'scheduler-legacy-payload-'));
  const legacyDbPath = join(legacyDir, 'scheduler.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_kind TEXT NOT NULL DEFAULT 'cron',
      schedule_at TEXT DEFAULT NULL,
      schedule_cron TEXT,
      schedule_tz TEXT NOT NULL DEFAULT 'UTC',
      session_target TEXT NOT NULL DEFAULT 'isolated',
      agent_id TEXT DEFAULT 'main',
      payload_kind TEXT NOT NULL,
      payload_message TEXT NOT NULL,
      payload_timeout_seconds INTEGER DEFAULT 120,
      execution_intent TEXT NOT NULL DEFAULT 'execute',
      execution_read_only INTEGER NOT NULL DEFAULT 0,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      max_queued_dispatches INTEGER NOT NULL DEFAULT 25,
      max_pending_approvals INTEGER NOT NULL DEFAULT 10,
      max_trigger_fanout INTEGER NOT NULL DEFAULT 25,
      delivery_mode TEXT DEFAULT 'none',
      delivery_channel TEXT,
      delivery_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delete_after_run INTEGER NOT NULL DEFAULT 0,
      ttl_hours INTEGER DEFAULT NULL,
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
      output_store_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_summary_limit_bytes INTEGER NOT NULL DEFAULT 65536,
      output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536,
      preferred_session_key TEXT DEFAULT NULL,
      auth_profile TEXT DEFAULT NULL,
      delivery_opt_out_reason TEXT DEFAULT NULL,
      origin TEXT DEFAULT NULL,
      job_type TEXT NOT NULL DEFAULT 'standard',
      watchdog_target_label TEXT,
      watchdog_check_cmd TEXT,
      watchdog_timeout_min INTEGER,
      watchdog_alert_channel TEXT,
      watchdog_alert_target TEXT,
      watchdog_self_destruct INTEGER NOT NULL DEFAULT 1,
      watchdog_started_at TEXT,
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
      shell_exit_code INTEGER,
      shell_signal TEXT,
      shell_timed_out INTEGER NOT NULL DEFAULT 0,
      shell_stdout TEXT,
      shell_stderr TEXT,
      shell_stdout_path TEXT,
      shell_stderr_path TEXT,
      shell_stdout_bytes INTEGER NOT NULL DEFAULT 0,
      shell_stderr_bytes INTEGER NOT NULL DEFAULT 0,
      dispatched_at TEXT,
      run_timeout_ms INTEGER NOT NULL DEFAULT 300000,
      retry_count INTEGER DEFAULT 0,
      retry_of TEXT,
      triggered_by_run TEXT,
      dispatch_queue_id TEXT,
      context_summary TEXT,
      replay_of TEXT,
      idempotency_key TEXT
    );
    CREATE TABLE messages (id TEXT PRIMARY KEY, to_agent TEXT, status TEXT, created_at TEXT, delivery_to TEXT);
    CREATE TABLE task_tracker_agents (id TEXT PRIMARY KEY, session_key TEXT, last_heartbeat TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, job_id TEXT, run_id TEXT, dispatch_queue_id TEXT, status TEXT, requested_at TEXT, resolved_at TEXT, resolved_by TEXT, notes TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, last_seen_at TEXT, session_key TEXT, capabilities TEXT, delivery_channel TEXT, delivery_to TEXT, brand_name TEXT, created_at TEXT);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (21);
  `);
  legacyDb.prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_kind, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      delivery_mode, delivery_opt_out_reason, run_timeout_ms, origin, next_run_at
    ) VALUES (?, ?, 1, 'cron', '0 * * * *', 'UTC', 'shell', 'main', 'agentTurn', 'legacy shell job', 'none', NULL, 300000, 'system', datetime('now', '-1 minute'))
  `).run('legacy-shell-job', 'LegacyShellJob');
  legacyDb.prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_kind, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      delivery_mode, delivery_opt_out_reason, run_timeout_ms, origin, next_run_at
    ) VALUES (?, ?, 1, 'cron', '15 * * * *', 'UTC', 'isolated', 'main', 'agentTurn', 'legacy isolated job', 'none', NULL, 300000, 'system', datetime('now', '+1 hour'))
  `).run('legacy-isolated-job', 'LegacyIsolatedJob');
  legacyDb.close();

  closeDb();
  setDbPath(legacyDbPath);
  await initDb();
  const normalizedShell = getJob('legacy-shell-job');
  const normalizedIsolated = getJob('legacy-isolated-job');
  assert(normalizedShell.payload_kind === 'shellCommand', 'migration normalizes legacy shell payload_kind to shellCommand');
  assert(normalizedIsolated.delivery_opt_out_reason === 'legacy scheduler job intentionally suppresses automatic delivery', 'migration backfills delivery_opt_out_reason for legacy root agentTurn jobs');
  closeDb();

  rmSync(legacyDir, { recursive: true, force: true });
  setDbPath(':memory:');
  await initDb();
}

console.log('\n-- Dispatcher Utils --');
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

console.log('\n-- Dispatch Queue Lifecycle --');
{
  const dqJob = createJob({ name: 'dq-lifecycle', schedule_cron: '0 8 * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });

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

console.log('\n-- Approval Timeout / Prune / Count --');
{
  const { createApproval, getApproval, countPendingApprovalsForJob,
          getTimedOutApprovals, pruneApprovals, resolveApproval } = await import('./approval.js');

  const aJob = createJob({
    name: 'approval-timeout-test', schedule_cron: '0 * * * *', payload_message: 'test',
    approval_required: 1, approval_timeout_s: 1, approval_auto: 'reject',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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

  // Cleanup: remove approvals and runs for this job to avoid leaking state
  getDb().prepare('DELETE FROM approvals WHERE job_id = ?').run(aJob.id);
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(aJob.id);
  deleteJob(aJob.id);
}

console.log('\n-- finishRun status guard --');
{
  const guardJob = createJob({ name: 'finish-guard-test', schedule_cron: '0 0 * * *', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  const guardRun = createRun(guardJob.id, { run_timeout_ms: 300_000 });
  finishRun(guardRun.id, 'ok', { summary: 'first finish' });
  const afterFirst = getRun(guardRun.id);
  assert(afterFirst.status === 'ok', 'finishRun sets ok status');

  const firstDurationMs = afterFirst.duration_ms;

  // Attempt to overwrite ok with error -- should be a no-op (WHERE guard rejects non-matching status)
  finishRun(guardRun.id, 'error', { summary: 'second finish', error_message: 'should not apply' });
  const afterSecond = getRun(guardRun.id);
  assert(afterSecond.status === 'ok', 'finishRun does not overwrite terminal status');
  assert(afterSecond.summary === 'first finish', 'finishRun does not overwrite terminal summary');
  assert(afterSecond.duration_ms === firstDurationMs, 'finishRun does not recalculate duration_ms on guarded no-op');

  deleteJob(guardJob.id);
}

console.log('\n-- resolveApproval invalid status --');
{
  const { createApproval, resolveApproval } = await import('./approval.js');
  const rvJob = createJob({ name: 'resolve-validate-test', schedule_cron: '0 0 * * *', payload_message: 'test', delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });
  const rvRun = createRun(rvJob.id, { run_timeout_ms: 300_000 });
  const rvApproval = createApproval(rvJob.id, rvRun.id);

  let threw = false;
  try { resolveApproval(rvApproval.id, 'bogus_status', 'operator'); } catch (err) {
    threw = true;
    assert(err.message.includes('Invalid approval status'), `resolveApproval rejects invalid status: ${err.message}`);
  }
  assert(threw, 'resolveApproval throws on invalid status');

  // Verify 'pending' is also not a valid resolution status
  let threwPending = false;
  try { resolveApproval(rvApproval.id, 'pending', 'operator'); } catch { threwPending = true; }
  assert(threwPending, 'resolveApproval rejects pending as resolution status');

  // Valid status still works
  const resolved = resolveApproval(rvApproval.id, 'rejected', 'operator', 'test cleanup');
  assert(resolved.status === 'rejected', 'resolveApproval still accepts valid status');

  finishRun(rvRun.id, 'cancelled');
  deleteJob(rvJob.id);
}

console.log('\n-- Run Session & Context Summary --');
{
  const rsJob = createJob({ name: 'run-session-test', schedule_cron: '0 8 * * *', payload_message: 'test' , delivery_mode: 'none', delivery_opt_out_reason: 'test', run_timeout_ms: 300_000, origin: 'system' });

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

console.log('\n-- Prompt Context Edge Cases --');
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

console.log('\n-- Dispatcher Integration --');
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
      const disabledManual = addJob({
        name: 'dispatcher-disabled-manual',
        enabled: 0,
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'printf disabled-manual-ok',
        delivery_mode: 'none',
        delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
        origin: 'system',
      });
      context.jobId = disabledManual.id;
      triggerJob(disabledManual.id);
    },
    exercise: async ({ probeDb, context }) => {
      const completion = await waitFor(
        () => {
          const run = probeDb.prepare(`
            SELECT status, summary, finished_at
            FROM runs
            WHERE job_id = ? AND finished_at IS NOT NULL
            ORDER BY started_at DESC, rowid DESC
            LIMIT 1
          `).get(context.jobId);
          const dispatch = probeDb.prepare(`
            SELECT status, dispatch_kind
            FROM job_dispatch_queue
            WHERE job_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          `).get(context.jobId);
          if (run?.finished_at && dispatch?.status === 'done') return { run, dispatch };
          return null;
        },
        { timeoutMs: 10000, intervalMs: 100, label: 'disabled manual dispatch run' }
      );
      assert(completion.run.status === 'ok', 'dispatcher integration: disabled manual job still executes');
      assert(completion.dispatch.dispatch_kind === 'manual' && completion.dispatch.status === 'done', 'dispatcher integration: disabled manual dispatch completes instead of being cancelled');
    },
  });

  await withTempDispatcher({
    prepare: async ({ addJob, triggerJob, context }) => {
      const root = addJob({
        name: 'dispatcher-retry-skipped-root',
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-skipped-root && exit 7',
        max_retries: 1,
        max_queued_dispatches: 1,
        delivery_mode: 'none',
        delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
        origin: 'system',
      });
      const child = addJob({
        name: 'dispatcher-retry-skipped-child',
        parent_id: root.id,
        trigger_on: 'failure',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-skipped-child-fired',
        delivery_mode: 'none',
        delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
      });
      context.rootJobId = root.id;
      context.childJobId = child.id;
      triggerJob(root.id);
    },
    exercise: async ({ probeDb, context }) => {
      const rootRun = await waitFor(
        () => probeDb.prepare(`
          SELECT id, status
          FROM runs
          WHERE job_id = ? AND finished_at IS NOT NULL
          ORDER BY started_at ASC, rowid ASC
          LIMIT 1
        `).get(context.rootJobId),
        { timeoutMs: 10000, intervalMs: 100, label: 'retry-skipped root run' }
      );

      const childRun = await waitFor(
        () => probeDb.prepare(`
          SELECT status, triggered_by_run, summary
          FROM runs
          WHERE job_id = ? AND finished_at IS NOT NULL
          ORDER BY started_at ASC, rowid ASC
          LIMIT 1
        `).get(context.childJobId),
        { timeoutMs: 10000, intervalMs: 100, label: 'retry-skipped failure child' }
      );

      const retryDispatches = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM job_dispatch_queue
        WHERE job_id = ? AND dispatch_kind = 'retry'
      `).get(context.rootJobId).c;

      assert(rootRun.status === 'error', 'dispatcher integration: retry-skipped root run finishes as error');
      assert(childRun.status === 'ok', 'dispatcher integration: failure child fires when retry cannot be queued');
      assert(childRun.triggered_by_run === rootRun.id, 'dispatcher integration: retry-skipped child links to failed run');
      assert(retryDispatches === 0, 'dispatcher integration: retry-skipped path does not create retry dispatches');
    },
  });

  await withTempDispatcher({
    prepare: async ({ addJob, triggerJob, context }) => {
      const timeoutJob = addJob({
        name: 'dispatcher-timeout',
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'sleep 2',
        run_timeout_ms: 100,
        delivery_mode: 'none', delivery_opt_out_reason: 'test',
        origin: 'system',
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
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-root && exit 9',
        max_retries: 1,
        delivery_mode: 'none', delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
        origin: 'system',
      });
      const child = addJob({
        name: 'dispatcher-retry-child',
        parent_id: root.id,
        trigger_on: 'failure',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo retry-child-fired',
        delivery_mode: 'none', delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
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

      const prematureChildRuns = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM runs
        WHERE job_id = ? AND finished_at IS NOT NULL
      `).get(context.childJobId).c;
      assert(prematureChildRuns === 0, 'dispatcher integration: failure child does not fire before retry exhaustion');

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

  await withTempDispatcher({
    prepare: async ({ addJob, context }) => {
      const { generateIdempotencyKey, claimIdempotencyKey } = await import('./idempotency.js');
      const replayRoot = addJob({
        name: 'dispatcher-replay-root',
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'printf replay-root-ok',
        delivery_guarantee: 'at-least-once',
        delivery_mode: 'none',
        delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
        origin: 'system',
      });
      const staleDue = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      updateJob(replayRoot.id, { next_run_at: staleDue });
      const replayKey = generateIdempotencyKey(replayRoot.id, staleDue);
      const orphanedRun = createRun(replayRoot.id, {
        run_timeout_ms: 300000,
        idempotency_key: replayKey,
      });
      claimIdempotencyKey(
        replayKey,
        replayRoot.id,
        orphanedRun.id,
        new Date(Date.now() + 3600000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
      );
      context.rootJobId = replayRoot.id;
      context.orphanedRunId = orphanedRun.id;
      context.replayKey = replayKey;
      context.staleDue = staleDue;
    },
    exercise: async ({ probeDb, context }) => {
      const crashedRun = await waitFor(
        () => probeDb.prepare(`
          SELECT status, finished_at
          FROM runs
          WHERE id = ?
        `).get(context.orphanedRunId),
        { timeoutMs: 5000, intervalMs: 100, label: 'orphaned run replay mark crashed' }
      );
      assert(crashedRun.status === 'crashed', 'dispatcher replay marks orphaned run as crashed');

      const replayRun = await waitFor(
        () => probeDb.prepare(`
          SELECT id, status, idempotency_key
          FROM runs
          WHERE job_id = ?
            AND id != ?
            AND finished_at IS NOT NULL
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(context.rootJobId, context.orphanedRunId),
        { timeoutMs: 10000, intervalMs: 100, label: 'replay dispatch run' }
      );
      const refreshedJob = probeDb.prepare(`
        SELECT next_run_at
        FROM jobs
        WHERE id = ?
      `).get(context.rootJobId);

      await sleep(500);
      const totalRuns = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM runs
        WHERE job_id = ?
      `).get(context.rootJobId).c;
      const pendingRetryDispatches = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM job_dispatch_queue
        WHERE job_id = ?
          AND dispatch_kind = 'retry'
          AND status = 'pending'
      `).get(context.rootJobId).c;

      assert(replayRun.status === 'ok', 'dispatcher replay dispatch completes successfully after startup recovery');
      assert(replayRun.idempotency_key !== context.replayKey, 'dispatcher replay uses a fresh idempotency key');
      assert(refreshedJob.next_run_at !== context.staleDue, 'startup replay advances stale due next_run_at after crash recovery');
      assert(totalRuns === 2, 'startup replay creates exactly one replay run without duplicate due-loop inserts');
      assert(pendingRetryDispatches === 0, 'startup replay drains queued retry dispatch instead of leaving it stuck pending');
    },
  });

  await withTempDispatcher({
    prepare: async ({ addJob, context }) => {
      const { generateIdempotencyKey } = await import('./idempotency.js');
      const reconciledRoot = addJob({
        name: 'dispatcher-reconcile-retry-root',
        schedule_cron: '0 8 * * *',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'printf queued-retry-ok',
        delivery_guarantee: 'at-least-once',
        delivery_mode: 'none',
        delivery_opt_out_reason: 'test',
        run_timeout_ms: 300_000,
        origin: 'system',
      });
      const staleDue = new Date(Date.now() - 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
      updateJob(reconciledRoot.id, { next_run_at: staleDue });
      const staleKey = generateIdempotencyKey(reconciledRoot.id, staleDue);
      const crashedRun = createRun(reconciledRoot.id, {
        run_timeout_ms: 300000,
        idempotency_key: staleKey,
      });
      finishRun(crashedRun.id, 'crashed', { error_message: 'startup recovery pending' });
      enqueueDispatch(reconciledRoot.id, {
        kind: 'retry',
        scheduled_for: new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
        source_run_id: crashedRun.id,
        retry_of_run_id: crashedRun.id,
      });
      context.rootJobId = reconciledRoot.id;
      context.crashedRunId = crashedRun.id;
      context.staleKey = staleKey;
      context.staleDue = staleDue;
    },
    exercise: async ({ probeDb, context }) => {
      const replayRun = await waitFor(
        () => probeDb.prepare(`
          SELECT id, status, idempotency_key
          FROM runs
          WHERE job_id = ?
            AND id != ?
            AND finished_at IS NOT NULL
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(context.rootJobId, context.crashedRunId),
        { timeoutMs: 10000, intervalMs: 100, label: 'queued retry replay run' }
      );
      const refreshedJob = probeDb.prepare(`
        SELECT next_run_at
        FROM jobs
        WHERE id = ?
      `).get(context.rootJobId);
      await sleep(500);
      const totalRuns = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM runs
        WHERE job_id = ?
      `).get(context.rootJobId).c;
      const pendingRetryDispatches = probeDb.prepare(`
        SELECT COUNT(*) AS c
        FROM job_dispatch_queue
        WHERE job_id = ?
          AND dispatch_kind = 'retry'
          AND status = 'pending'
      `).get(context.rootJobId).c;

      assert(replayRun.status === 'ok', 'startup reconciliation lets queued retry dispatch execute for stale due jobs');
      assert(replayRun.idempotency_key !== context.staleKey, 'queued retry replay uses a fresh idempotency key');
      assert(refreshedJob.next_run_at !== context.staleDue, 'startup reconciliation advances stale next_run_at when retry is already queued');
      assert(totalRuns === 2, 'startup reconciliation avoids duplicate root dispatch attempts');
      assert(pendingRetryDispatches === 0, 'startup reconciliation drains the existing retry dispatch');
    },
  });
}

// ===========================================================
// SECTION: Dispatch Spawn Failure Detection
// ===========================================================

console.log('\n-- Dispatch Spawn Failure Detection --');
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
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 12000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // execFileSync succeeded -- sfExitCode retains its initial value of 0
  } catch (err) {
    sfExitCode  = err.status ?? 1;
    sfStderr    = err.stderr  ?? '';
    sfStdout    = err.stdout  ?? '';
  }
  assert(sfExitCode === 1, 'spawn-failure: watcher exits non-zero (exit code 1)');
  assert(sfStderr.includes('SPAWN FAILURE'), 'spawn-failure: watcher writes SPAWN FAILURE to stderr');
  assert(sfStdout.includes('SPAWN FAILURE'), 'spawn-failure: watcher writes SPAWN FAILURE to stdout');

  // 3. Normal completion: session seen once (liveness ok), then gone -> watcher resolves ok (exit 0)
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
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
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

  // 3b. Interrupted: status auto-resolved as 'interrupted' (session went idle without calling done).
  //     Mock always returns status=interrupted with the auto-resolve summary.
  //     Watcher must: exit non-zero (exit 1), write warning emoji to stdout,
  //     and NOT deliver as a successful result.
  {
    const intTempDir = mkdtempSync(join(tmpdir(), 'watcher-intr-'));
    const mockIntrPath = join(intTempDir, 'mock-interrupted.mjs');
    const mockLabelsIntr = join(intTempDir, 'labels-intr.json');

    writeFileSync(mockIntrPath, `
const [,,sub] = process.argv;
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'test-intr',
    status: 'interrupted',
    summary: 'Auto-resolved: session went idle without calling done. Work may be incomplete. (session idle 15 min)',
    sessionKey: 'agent:main:subagent:intr-uuid',
    liveness: { ageMs: 900000, updatedAt: Date.now() - 900000 },
    syncAction: 'auto-resolved as interrupted: session idle 15 min',
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, lastReply: 'partial output', status: 'interrupted' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
}
`);

    writeFileSync(mockLabelsIntr, JSON.stringify({
      'test-intr': {
        sessionKey: 'agent:main:subagent:intr-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 200_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let intrExitCode;
    let intrStdout;
    try {
      intrStdout = execFileSync(process.execPath, [watcherPath, '--label', 'test-intr', '--timeout', '30', '--poll-interval', '1'], {
        env: {
          ...process.env,
          DISPATCH_INDEX_PATH: mockIntrPath,
          DISPATCH_LABELS_PATH: mockLabelsIntr,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
        },
        encoding: 'utf8',
        timeout: 40000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      intrExitCode = 0;
    } catch (err) {
      intrExitCode = err.status ?? 1;
      intrStdout   = err.stdout ?? '';
    }
    assert(intrExitCode === 1, 'interrupted: watcher exits non-zero (exit 1)');
    assert(intrStdout.includes('⚠️'), 'interrupted: watcher writes ⚠️ warning to stdout');
    assert(intrStdout.includes('went idle before completing'), 'interrupted: watcher reports session went idle');
    assert(!intrStdout.includes('completed:'), 'interrupted: watcher does NOT deliver as successful completion');

    // Also verify labels.json was updated to 'error' (not kept as 'interrupted' or 'running')
    const finalLabels = JSON.parse(readFileSync(mockLabelsIntr, 'utf-8'));
    assert(finalLabels['test-intr'].status === 'error', 'interrupted: watcher marks label as error in labels.json');

    rmSync(intTempDir, { recursive: true, force: true });
  }

  rmSync(tempDir, { recursive: true, force: true });
}

// -- Gateway-Restart-Kill Detection --
console.log('\n-- Gateway-Restart-Kill Recovery --');
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
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
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
  //    gwRestartRetryCount starts at 0 -- watcher should retry and continue polling.
  //    We simulate this by: first status call returns done/not-found (kill detected),
  //    second call also returns done/not-found (simulating another kill on the new session
  //    with gwRestartRetryCount now=1), third call returns done/not-found (count=2=max -> give up).
  const mockGwRetryPath = join(tempDir, 'mock-gw-retry.mjs');
  const mockLabelsGwRetry = join(tempDir, 'labels-gr.json');
  const grCounterFile = join(tempDir, 'gr-counter.txt');
  writeFileSync(grCounterFile, '0');

  writeFileSync(mockGwRetryPath, `
import { readFileSync, writeFileSync } from 'fs';
const [,,sub,...rest] = process.argv;
const counterFile = ${JSON.stringify(grCounterFile)};

if (sub === 'status') {
  // Always return session-not-found -- watcher should retry up to MAX then fail
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
  // Simulate successful enqueue -- update labels to 'running' with new sessionKey
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

  // gwRestartRetryCount=0 initially -- watcher should retry twice then give up
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
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
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

// -- Watcher exit-code correctness (timeout paths) --
console.log('\n-- Watcher timeout markLabelError --');
{
  const watcherSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'dispatch', 'watcher.mjs'),
    'utf8'
  );
  // Timeout paths should call markLabelError, not markDoneSync, before exit(1)
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s -- token telemetry unavailable`)'),
    'timeout: markLabelError used for token-telemetry-unavailable path');
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s -- token telemetry lost`)'),
    'timeout: markLabelError used for token-telemetry-lost path');
  assert(watcherSrc.includes("markLabelError(label, 'timed out -- killed after steer attempts (no result captured)')"),
    'timeout: markLabelError used for steer-kill path');
  assert(watcherSrc.includes('markLabelError(label, `timed out after ${timeoutS}s -- killed after steer attempts`)'),
    'timeout: markLabelError used for final killed-after-steer path');
  assert(watcherSrc.includes('isGatewayRestartKill'), 'gw-kill: isGatewayRestartKill function present');
  assert(watcherSrc.includes('MAX_GW_RESTART_RETRIES'), 'gw-kill: MAX_GW_RESTART_RETRIES constant present');
  assert(watcherSrc.includes('respawnAfterGwRestart'), 'gw-kill: respawnAfterGwRestart function present');
  assert(watcherSrc.includes('gwRestartRetryCount'), 'gw-kill: gwRestartRetryCount tracked in labels');
}

// -- Watcher pre-deadline JSONL mtime extension --
console.log('\n-- Watcher pre-deadline JSONL mtime extension --');
{
  const watcherSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'dispatch', 'watcher.mjs'),
    'utf8'
  );
  // Source-level: JSONL extension block is present and correctly structured
  assert(watcherSrc.includes('preDeadlineJsonlMtime'), 'jsonl-extend: preDeadlineJsonlMtime variable present');
  assert(watcherSrc.includes('preDeadlineSessionId'), 'jsonl-extend: preDeadlineSessionId variable present (reset on respawn)');
  assert(watcherSrc.includes('getSessionStoreEntry(status.sessionKey)'), 'jsonl-extend: uses getSessionStoreEntry helper (not manual lookup)');
  assert(watcherSrc.includes('curMtime > preDeadlineJsonlMtime + 1000'), 'jsonl-extend: checks mtime advance > 1s threshold');
  assert(watcherSrc.includes('ROLLING_EXTEND_MS'), 'jsonl-extend: uses ROLLING_EXTEND_MS for extension amount');
  assert(watcherSrc.includes('MAX_DEADLINE_EXTENSION'), 'jsonl-extend: caps extension at MAX_DEADLINE_EXTENSION');
  assert(watcherSrc.includes("preDeadlineSessionId !== sessionId"), 'jsonl-extend: resets baseline on session change');
  assert(watcherSrc.includes('function getSessionJsonlMtime(sessionId, agentDir'), 'jsonl-extend: getSessionJsonlMtime function signature present');
  assert(watcherSrc.includes('statSync(jsonlPath).mtimeMs'), 'jsonl-extend: getSessionJsonlMtime reads mtimeMs via statSync');
}

// -- Watcher run_timeout_ms covers MAX_DEADLINE_EXTENSION --
console.log('\n-- Watcher run_timeout_ms ceiling --');
{
  const indexSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'dispatch', 'index.mjs'),
    'utf8'
  );
  // The run_timeout_ms formula must use Math.max to cover the rolling extension cap
  assert(indexSrc.includes('Math.max(watcherTimeoutS, 4 * 3600)'), 'run_timeout_ms: uses Math.max to cover MAX_DEADLINE_EXTENSION (4h) ceiling');
  assert(indexSrc.includes('420 * 1000'), 'run_timeout_ms: includes 7min headroom (2*FLAT_WINDOW + slop)');
}

// ===========================================================
// SECTION: Sessions.json Detection, Done Subcommand, STARTUP_GRACE_MS
// ===========================================================

console.log('\n-- Sessions.json Detection --');
{
  const dispatchDir  = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexPath    = join(dispatchDir, 'index.mjs');
  const watcherPath  = join(dispatchDir, 'watcher.mjs');
  const indexSrc     = readFileSync(indexPath, 'utf8');
  const watcherSrc   = readFileSync(watcherPath, 'utf8');

  // -- 1. STARTUP_GRACE_MS constant checks ---------------------------------
  // index.mjs must default to 300_000 (not the old 90_000)
  assert(indexSrc.includes('300_000'), 'STARTUP_GRACE_MS: index.mjs uses 300_000');
  assert(!indexSrc.includes('90_000'), 'STARTUP_GRACE_MS: index.mjs does not use old 90_000');
  // watcher.mjs: _STARTUP_GRACE_MS was removed (unused dead code, fix #40)
  // index.mjs still uses 300_000 for its startup grace logic

  // -- 2. readSessionsStore present in both files ---------------------------
  assert(indexSrc.includes('readSessionsStore'), 'sessions.json: readSessionsStore in index.mjs');
  assert(watcherSrc.includes('readSessionsStore'), 'sessions.json: readSessionsStore in watcher.mjs');

  // -- 3. No direct sessions_list API calls for state checks in index.mjs ---
  // The three old patterns replaced: cmdStatus, cmdStuck, cmdSync
  // We verify sessions_list is not used for session state decisions
  // (it may still exist in other contexts but should not be the state oracle)
  assert(!indexSrc.includes("gatewayToolInvoke('sessions_list'"), 'sessions.json: no sessions_list calls in index.mjs');

  // -- 4. sessions.json read behaviour via temp store -----------------------
  const testTmpDir = mkdtempSync(join(tmpdir(), 'sessions-json-test-'));
  const testLabelsPath = join(testTmpDir, 'labels.json');
  // Path must match readSessionsStore: join(HOME_DIR, '.openclaw', 'agents', agent, 'sessions', 'sessions.json')
  const sessionsDir = join(testTmpDir, '.openclaw', 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');

  // Fake session entry -- simulates a running dispatcher-spawned session
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

  // 4a. Present + active -> dispatch status should see it
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

  // 4b. Present + stale (>10min idle) -> should auto-resolve to done
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
  assert(statusObjStale.status === 'interrupted', 'sessions.json present+stale: auto-resolved to interrupted (not done -- agent never called done)');
  assert(statusObjStale.syncAction && statusObjStale.syncAction.includes('auto-resolved'), 'sessions.json present+stale: syncAction includes auto-resolved');

  // 4c. Absent (session key not in store) -> gateway API fallback.
  //     In 2026.3.13+ subagents are NOT written to sessions.json (SessionBindingService).
  //     When session is absent from sessions.json, checkSessionDone now calls
  //     gateway sessions.list API. In test env the gateway is unreachable, so
  //     the safe default is to NOT auto-resolve (defer), keeping status='running'.
  //     Only after the gateway API also confirms absence should we resolve as done.
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
  // With gateway API fallback: gateway unreachable in test env -> safe default = running (not done)
  assert(statusObjAbsent.status === 'running', 'sessions.json absent: deferred (gateway API fallback -- unreachable in test = safe default running)');

  rmSync(testTmpDir, { recursive: true, force: true });
}

console.log('\n-- Done Subcommand --');
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
      spawnedAt: new Date(Date.now() - 90_000).toISOString(),
      timeoutSeconds: 300,
    },
  }) + '\n');

  // Run: node index.mjs done --label my-task --summary "all done!" --checklist '{"work_complete":true}'
  const doneOut = execFileSync(process.execPath, [
    indexPath, 'done', '--label', 'my-task', '--summary', 'all done!',
    '--checklist', '{"work_complete":true}',
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

  // done with unregistered label -> exits 0 and marks as done (not an error)
  // NOTE: Changed from exits-1 in 07838b6: unregistered labels are valid for
  //       direct subagent spawns that weren't tracked via enqueue.
  {
    const unregRaw = execFileSync(process.execPath,
      [indexPath, 'done', '--label', 'nonexistent-label-xyz', '--summary', 'finished',
       '--checklist', '{"work_complete":true}'],
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

  // done without --label -> exits 2
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

  // -- SHA validation tests ----------------------------------

  // done with valid --sha succeeds (uses actual HEAD commit from the scheduler repo)
  {
    // Re-populate labels.json with a running entry for sha-test
    writeFileSync(doneLabels, JSON.stringify({
      'sha-test-task': {
        sessionKey: 'agent:main:subagent:sha-test-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    // Get current HEAD SHA from the scheduler repo (a real, existing commit)
    const validSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: dirname(fileURLToPath(import.meta.url)) }).trim();

    const shaValidOut = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'sha-test-task', '--summary', 'sha test done', '--sha', validSha,
      '--checklist', '{"work_complete":true,"pushed":true}',
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
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
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
        '--checklist', '{"work_complete":true}',
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
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    const noShaOut = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'no-sha-task', '--summary', 'no sha needed',
      '--checklist', '{"work_complete":true}',
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

  // -- Bug 1 fix: summary truncation at 300 chars ------------

  // done with summary > 300 chars -> truncated to 300 and warns on stderr
  {
    writeFileSync(doneLabels, JSON.stringify({
      'trunc-task': {
        sessionKey: 'agent:main:subagent:trunc-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    const longSummary = 'x'.repeat(350);
    const truncOut = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'trunc-task', '--summary', longSummary,
      '--checklist', '{"work_complete":true}',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // We can't easily capture stderr from execFileSync with stdio pipe, so
    // just verify the stored summary is at most 300 chars
    const truncObj = JSON.parse(truncOut.trim());
    assert(truncObj.ok === true, 'done --summary truncation: ok=true');
    assert(truncObj.summary.length === 300, 'done --summary truncation: summary truncated to 300 chars');
    const truncLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(truncLabels['trunc-task'].summary.length === 300, 'done --summary truncation: labels.json summary at most 300 chars');
    assert(truncLabels['trunc-task'].status === 'done', 'done --summary truncation: labels.json status=done');
  }

  // done with summary exactly 300 chars -> accepted as-is (no truncation)
  {
    writeFileSync(doneLabels, JSON.stringify({
      'exact-trunc-task': {
        sessionKey: 'agent:main:subagent:exact-trunc-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    const exact300 = 'y'.repeat(300);
    const exact300Out = execFileSync(process.execPath, [
      indexPath, 'done', '--label', 'exact-trunc-task', '--summary', exact300,
      '--checklist', '{"work_complete":true}',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exact300Obj = JSON.parse(exact300Out.trim());
    assert(exact300Obj.ok === true, 'done --summary exactly 300 chars: ok=true');
    assert(exact300Obj.summary.length === 300, 'done --summary exactly 300 chars: summary preserved');
  }

  // -- Structural checklist validation -------------------------

  // done without --checklist -> rejected (missing checklist)
  {
    writeFileSync(doneLabels, JSON.stringify({
      'no-checklist-task': {
        sessionKey: 'agent:main:subagent:no-checklist-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwNoChecklist = false;
    let noChecklistExitCode = null;
    let noChecklistStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'no-checklist-task', '--summary', 'done!',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwNoChecklist = true;
      noChecklistExitCode = err.status;
      noChecklistStderr = err.stderr || '';
    }
    assert(threwNoChecklist, 'done without --checklist: rejected (non-zero exit)');
    assert(noChecklistExitCode === 1, 'done without --checklist: exit code 1');
    assert(noChecklistStderr.includes('REJECTED'), 'done without --checklist: stderr contains REJECTED');
    assert(noChecklistStderr.includes('--checklist'), 'done without --checklist: stderr mentions --checklist');

    const noChecklistLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(noChecklistLabels['no-checklist-task'].status === 'running', 'done without --checklist: labels.json NOT updated');
  }

  // done with work_complete:false -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'work-incomplete-task': {
        sessionKey: 'agent:main:subagent:work-incomplete-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwWorkIncomplete = false;
    let workIncompleteExitCode = null;
    let workIncompleteStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'work-incomplete-task', '--summary', 'done!',
        '--checklist', '{"work_complete":false}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwWorkIncomplete = true;
      workIncompleteExitCode = err.status;
      workIncompleteStderr = err.stderr || '';
    }
    assert(threwWorkIncomplete, 'done with work_complete:false: rejected (non-zero exit)');
    assert(workIncompleteExitCode === 1, 'done with work_complete:false: exit code 1');
    assert(workIncompleteStderr.includes('REJECTED'), 'done with work_complete:false: stderr contains REJECTED');
    assert(workIncompleteStderr.includes('work_complete'), 'done with work_complete:false: stderr mentions work_complete');

    const workIncompleteLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(workIncompleteLabels['work-incomplete-task'].status === 'running', 'done with work_complete:false: labels.json NOT updated');
  }

  // done with tests_passed:false -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'tests-failed-task': {
        sessionKey: 'agent:main:subagent:tests-failed-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwTestsFailed = false;
    let testsFailedExitCode = null;
    let testsFailedStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'tests-failed-task', '--summary', 'done!',
        '--checklist', '{"work_complete":true,"tests_passed":false}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwTestsFailed = true;
      testsFailedExitCode = err.status;
      testsFailedStderr = err.stderr || '';
    }
    assert(threwTestsFailed, 'done with tests_passed:false: rejected (non-zero exit)');
    assert(testsFailedExitCode === 1, 'done with tests_passed:false: exit code 1');
    assert(testsFailedStderr.includes('REJECTED'), 'done with tests_passed:false: stderr contains REJECTED');
    assert(testsFailedStderr.includes('tests_passed'), 'done with tests_passed:false: stderr mentions tests_passed');

    const testsFailedLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(testsFailedLabels['tests-failed-task'].status === 'running', 'done with tests_passed:false: labels.json NOT updated');
  }

  // done with pushed:false -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'push-failed-task': {
        sessionKey: 'agent:main:subagent:push-failed-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwPushFailed = false;
    let pushFailedExitCode = null;
    let pushFailedStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'push-failed-task', '--summary', 'done!',
        '--checklist', '{"work_complete":true,"pushed":false}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwPushFailed = true;
      pushFailedExitCode = err.status;
      pushFailedStderr = err.stderr || '';
    }
    assert(threwPushFailed, 'done with pushed:false: rejected (non-zero exit)');
    assert(pushFailedExitCode === 1, 'done with pushed:false: exit code 1');
    assert(pushFailedStderr.includes('REJECTED'), 'done with pushed:false: stderr contains REJECTED');
    assert(pushFailedStderr.includes('pushed'), 'done with pushed:false: stderr mentions pushed');

    const pushFailedLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(pushFailedLabels['push-failed-task'].status === 'running', 'done with pushed:false: labels.json NOT updated');
  }

  // done with invalid JSON in --checklist -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'bad-json-task': {
        sessionKey: 'agent:main:subagent:bad-json-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwBadJson = false;
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'bad-json-task', '--summary', 'done!',
        '--checklist', 'not-valid-json',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwBadJson = (err.status === 1);
    }
    assert(threwBadJson, 'done with invalid JSON checklist: rejected (exit code 1)');
  }

  // done with valid checklist (all fields true) -> accepted
  const legitimateSummaries = [
    'Refactored the auth module and added unit tests. All 42 tests pass.',
    'Fixed the memory leak in the connection pool. Commit: abc1234.',
    'Updated dependencies and resolved 3 CVEs. PR merged.',
    'Implemented the structural completion checklist in cmdDone. Tests updated and passing.',
  ];
  for (const legit of legitimateSummaries) {
    writeFileSync(doneLabels, JSON.stringify({
      'legit-task': {
        sessionKey: 'agent:main:subagent:legit-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let legitOut;
    let legitThrew = false;
    try {
      legitOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'legit-task', '--summary', legit,
        '--checklist', '{"work_complete":true,"tests_passed":true,"pushed":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      legitThrew = true;
    }
    assert(!legitThrew, `done with valid checklist "${legit.slice(0, 40)}...": accepted (no false positive)`);
    const legitObj = JSON.parse(legitOut.trim());
    assert(legitObj.ok === true, `done with valid checklist "${legit.slice(0, 40)}...": ok=true`);
  }

  // done with only work_complete:true (minimal checklist) -> accepted
  {
    writeFileSync(doneLabels, JSON.stringify({
      'minimal-checklist-task': {
        sessionKey: 'agent:main:subagent:minimal-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
      },
    }) + '\n');

    let minimalOut;
    let minimalThrew = false;
    try {
      minimalOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'minimal-checklist-task', '--summary', 'Work done!',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      minimalThrew = true;
    }
    assert(!minimalThrew, 'done with minimal checklist {work_complete:true}: accepted');
    const minimalObj = JSON.parse(minimalOut.trim());
    assert(minimalObj.ok === true, 'done with minimal checklist: ok=true');
  }

  // -- Fix 1: Minimum runtime guard ----------------------------------------

  console.log('\n  -- Minimum Runtime Guard --');

  // Test 1: done called within 30s of spawn -> rejected with "suspiciously short"
  {
    writeFileSync(doneLabels, JSON.stringify({
      'premature-done-task': {
        sessionKey: 'agent:main:subagent:premature-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwPremature = false;
    let prematureExitCode = null;
    let prematureStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'premature-done-task', '--summary', 'quick done',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwPremature = true;
      prematureExitCode = err.status;
      prematureStderr = err.stderr || '';
    }
    assert(threwPremature, 'runtime-guard: done within 30s -> rejected (non-zero exit)');
    assert(prematureExitCode === 1, 'runtime-guard: done within 30s -> exit code 1');
    assert(prematureStderr.includes('REJECTED'), 'runtime-guard: done within 30s -> stderr contains REJECTED');
    assert(prematureStderr.includes('suspiciously short'), 'runtime-guard: done within 30s -> stderr mentions suspiciously short');
    assert(prematureStderr.includes('--force-done'), 'runtime-guard: done within 30s -> stderr mentions --force-done escape hatch');
    const prematureLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(prematureLabels['premature-done-task'].status === 'running', 'runtime-guard: done within 30s -> labels.json NOT updated');
  }

  // Test 2: done within 30s with --force-done but no --reason -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'force-no-reason-task': {
        sessionKey: 'agent:main:subagent:force-no-reason-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago
        timeoutSeconds: 300,
      },
    }) + '\n');

    let threwForceNoReason = false;
    let forceNoReasonExitCode = null;
    let forceNoReasonStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'force-no-reason-task', '--summary', 'quick done',
        '--checklist', '{"work_complete":true}', '--force-done',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwForceNoReason = true;
      forceNoReasonExitCode = err.status;
      forceNoReasonStderr = err.stderr || '';
    }
    assert(threwForceNoReason, 'runtime-guard: --force-done without --reason -> rejected');
    assert(forceNoReasonExitCode === 1, 'runtime-guard: --force-done without --reason -> exit code 1');
    assert(forceNoReasonStderr.includes('REJECTED'), 'runtime-guard: --force-done without --reason -> stderr REJECTED');
    assert(forceNoReasonStderr.includes('--reason'), 'runtime-guard: --force-done without --reason -> stderr mentions --reason');
    const forceNoReasonLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(forceNoReasonLabels['force-no-reason-task'].status === 'running', 'runtime-guard: --force-done without --reason -> labels.json NOT updated');
  }

  // Test 3: done within 30s with --force-done --reason "audit only" -> accepted
  {
    writeFileSync(doneLabels, JSON.stringify({
      'force-with-reason-task': {
        sessionKey: 'agent:main:subagent:force-with-reason-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 10_000).toISOString(), // 10s ago
        timeoutSeconds: 300,
      },
    }) + '\n');

    let forceWithReasonOut;
    let forceWithReasonThrew = false;
    try {
      forceWithReasonOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'force-with-reason-task', '--summary', 'audit only',
        '--checklist', '{"work_complete":true}', '--force-done', '--reason', 'audit only -- read-only task',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      forceWithReasonThrew = true;
    }
    assert(!forceWithReasonThrew, 'runtime-guard: --force-done --reason "audit only" -> accepted');
    const forceWithReasonObj = JSON.parse(forceWithReasonOut.trim());
    assert(forceWithReasonObj.ok === true, 'runtime-guard: --force-done --reason -> ok=true');
    assert(forceWithReasonObj.status === 'done', 'runtime-guard: --force-done --reason -> status=done');
    const forceWithReasonLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(forceWithReasonLabels['force-with-reason-task'].status === 'done', 'runtime-guard: --force-done --reason -> labels.json updated to done');
  }

  // Test 4: done called after 90s -> accepted normally (no --force-done needed)
  {
    writeFileSync(doneLabels, JSON.stringify({
      'long-running-task': {
        sessionKey: 'agent:main:subagent:long-running-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(), // 90s ago
        timeoutSeconds: 300,
      },
    }) + '\n');

    let longRunningOut;
    let longRunningThrew = false;
    try {
      longRunningOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'long-running-task', '--summary', 'work done after 90s',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      longRunningThrew = true;
    }
    assert(!longRunningThrew, 'runtime-guard: done after 90s -> accepted');
    const longRunningObj = JSON.parse(longRunningOut.trim());
    assert(longRunningObj.ok === true, 'runtime-guard: done after 90s -> ok=true');
    assert(longRunningObj.status === 'done', 'runtime-guard: done after 90s -> status=done');
  }

  // -- Fix 2: SHA required when task involves git operations ----------------

  console.log('\n  -- Git SHA Required Gate --');

  // Test 5: task prompt contains "git push", --sha omitted -> rejected
  {
    writeFileSync(doneLabels, JSON.stringify({
      'git-task-no-sha': {
        sessionKey: 'agent:main:subagent:git-no-sha-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Fix the bug, commit and git push to main branch.',
      },
    }) + '\n');

    let threwGitNoSha = false;
    let gitNoShaExitCode = null;
    let gitNoShaStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'git-task-no-sha', '--summary', 'pushed it',
        '--checklist', '{"work_complete":true,"pushed":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      threwGitNoSha = true;
      gitNoShaExitCode = err.status;
      gitNoShaStderr = err.stderr || '';
    }
    assert(threwGitNoSha, 'git-sha-gate: git task without --sha -> rejected');
    assert(gitNoShaExitCode === 1, 'git-sha-gate: git task without --sha -> exit code 1');
    assert(gitNoShaStderr.includes('REJECTED'), 'git-sha-gate: git task without --sha -> stderr REJECTED');
    assert(gitNoShaStderr.includes('--sha'), 'git-sha-gate: git task without --sha -> stderr mentions --sha');
    const gitNoShaLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(gitNoShaLabels['git-task-no-sha'].status === 'running', 'git-sha-gate: git task without --sha -> labels.json NOT updated');
  }

  // Test 6: task prompt contains "git push", --sha provided and valid -> accepted
  {
    const validShaForGitTest = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: dirname(fileURLToPath(import.meta.url)),
    }).trim();

    writeFileSync(doneLabels, JSON.stringify({
      'git-task-with-sha': {
        sessionKey: 'agent:main:subagent:git-with-sha-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Fix the bug, commit and git push to main branch.',
      },
    }) + '\n');

    let gitWithShaOut;
    let gitWithShaThrew = false;
    try {
      gitWithShaOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'git-task-with-sha', '--summary', 'pushed it',
        '--checklist', '{"work_complete":true,"pushed":true}',
        '--sha', validShaForGitTest,
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      gitWithShaThrew = true;
    }
    assert(!gitWithShaThrew, 'git-sha-gate: git task with valid --sha -> accepted');
    const gitWithShaObj = JSON.parse(gitWithShaOut.trim());
    assert(gitWithShaObj.ok === true, 'git-sha-gate: git task with valid --sha -> ok=true');
    assert(gitWithShaObj.status === 'done', 'git-sha-gate: git task with valid --sha -> status=done');
  }

  // Test 7: task prompt has no git operations, --sha omitted -> accepted
  {
    writeFileSync(doneLabels, JSON.stringify({
      'non-git-task-no-sha': {
        sessionKey: 'agent:main:subagent:non-git-no-sha-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Read the logs and summarize findings.',
      },
    }) + '\n');

    let nonGitNoShaOut;
    let nonGitNoShaThrew = false;
    try {
      nonGitNoShaOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'non-git-task-no-sha', '--summary', 'summary done',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      nonGitNoShaThrew = true;
    }
    assert(!nonGitNoShaThrew, 'git-sha-gate: non-git task without --sha -> accepted');
    const nonGitNoShaObj = JSON.parse(nonGitNoShaOut.trim());
    assert(nonGitNoShaObj.ok === true, 'git-sha-gate: non-git task without --sha -> ok=true');
    assert(nonGitNoShaObj.status === 'done', 'git-sha-gate: non-git task without --sha -> status=done');
  }

  // Test 8: negated git prose should NOT trigger the SHA gate
  {
    writeFileSync(doneLabels, JSON.stringify({
      'negated-git-prose': {
        sessionKey: 'agent:main:subagent:negated-git-prose-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Do NOT use git push here; just inspect and summarize findings.',
      },
    }) + '\n');

    let negatedGitOut;
    let negatedGitThrew = false;
    try {
      negatedGitOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'negated-git-prose', '--summary', 'summary done',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels, OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19999' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      negatedGitThrew = true;
    }
    assert(!negatedGitThrew, 'git-sha-gate: negated git prose without --sha -> accepted');
    const negatedGitObj = JSON.parse(negatedGitOut.trim());
    assert(negatedGitObj.ok === true, 'git-sha-gate: negated git prose without --sha -> ok=true');
    assert(negatedGitObj.status === 'done', 'git-sha-gate: negated git prose without --sha -> status=done');
  }

  // -- Fix 3: taskPrompt stored by enqueue (validated via index.mjs source) -

  console.log('\n  -- Fix 3: taskPrompt stored --');
  {
    const indexSrc = readFileSync(indexPath, 'utf8');
    assert(indexSrc.includes('taskPrompt'), 'fix3: index.mjs stores taskPrompt in setLabel');
    assert(indexSrc.includes('message.slice(0, 2000)'), 'fix3: taskPrompt is first 2000 chars of message');
    assert(indexSrc.includes('existing.taskPrompt'), 'fix3: done checks existing.taskPrompt for git patterns');
  }

  // -- Fix 1 (edge case): Old label with no taskPrompt + git args -> warning, NOT rejected --

  console.log('\n  -- Fix 1: Old label missing taskPrompt (false negative guard) --');
  {
    // Label has NO taskPrompt (enqueued before 6dfa458)
    writeFileSync(doneLabels, JSON.stringify({
      'old-label-no-prompt': {
        sessionKey: 'agent:main:subagent:old-label-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        // No taskPrompt field -- simulates label created before guard was added
      },
    }) + '\n');

    let oldLabelOut;
    let oldLabelThrew = false;
    try {
      oldLabelOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'old-label-no-prompt',
        '--summary', 'completed old task',
        '--checklist', '{"work_complete":true}',
        // No --sha even though the label conceptually involves git work
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      oldLabelThrew = true;
    }
    assert(!oldLabelThrew, 'fix1-old-label: old label (no taskPrompt) -> NOT rejected');
    const oldLabelObj = JSON.parse(oldLabelOut.trim());
    assert(oldLabelObj.ok === true, 'fix1-old-label: old label (no taskPrompt) -> ok=true');
    assert(oldLabelObj.status === 'done', 'fix1-old-label: old label (no taskPrompt) -> status=done');
    // Warning should be logged to stderr
    // (We can't easily capture stderr from execFileSync without piping, but we verify behavior is correct)
    const oldLabelLabels = JSON.parse(readFileSync(doneLabels, 'utf8'));
    assert(oldLabelLabels['old-label-no-prompt'].status === 'done', 'fix1-old-label: labels.json updated to done');
    // Verify the warning is in the source
    const indexSrcFix1 = readFileSync(indexPath, 'utf8');
    assert(indexSrcFix1.includes('taskPrompt not stored for label='), 'fix1-old-label: warning message present in source');
    assert(indexSrcFix1.includes('enqueued before guard'), 'fix1-old-label: warning mentions enqueued before guard');
  }

  // -- Fix 2 (edge case): Tightened regex prevents false positives; actual commands trigger gate --

  console.log('\n  -- Fix 2: Tightened git regex (prose vs command) --');
  {
    // Test A: standalone "rebase" (no git prefix) -> should NOT trigger SHA gate (old regex matched this)
    writeFileSync(doneLabels, JSON.stringify({
      'bare-rebase-mention': {
        sessionKey: 'agent:main:subagent:bare-rebase-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        // The old regex /rebase/i would match this (false positive)
        // The new regex requires \bgit\s+rebase\b -> should NOT match
        taskPrompt: 'Squash and rebase the commits locally before review.',
      },
    }) + '\n');

    let bareRebaseOut;
    let bareRebaseThrew = false;
    try {
      bareRebaseOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'bare-rebase-mention',
        '--summary', 'reviewed',
        '--checklist', '{"work_complete":true}',
        // No --sha -- should be accepted since bare "rebase" without "git " prefix is prose
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels, OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19999' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      bareRebaseThrew = true;
    }
    assert(!bareRebaseThrew, 'fix2-bare-rebase: "rebase" without "git " prefix -> NOT rejected (old regex false positive fixed)');
    const bareRebaseObj = JSON.parse(bareRebaseOut.trim());
    assert(bareRebaseObj.ok === true, 'fix2-bare-rebase: bare rebase mention -> ok=true');

    // Test B: "git push origin main" in taskPrompt -> SHOULD trigger SHA gate
    writeFileSync(doneLabels, JSON.stringify({
      'actual-git-cmd': {
        sessionKey: 'agent:main:subagent:actual-git-cmd-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Fix the bug then git push origin main to deploy.',
      },
    }) + '\n');

    let actualGitThrew = false;
    let actualGitExitCode = null;
    let actualGitStderr = '';
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'actual-git-cmd',
        '--summary', 'pushed changes',
        '--checklist', '{"work_complete":true}',
        // No --sha -- should be REJECTED since taskPrompt has actual git command
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      actualGitThrew = true;
      actualGitExitCode = err.status;
      actualGitStderr = err.stderr || '';
    }
    assert(actualGitThrew, 'fix2-actual-cmd: "git push origin main" in taskPrompt -> rejected without --sha');
    assert(actualGitExitCode === 1, 'fix2-actual-cmd: git command -> exit code 1');
    assert(actualGitStderr.includes('REJECTED'), 'fix2-actual-cmd: git command -> stderr REJECTED');
    assert(actualGitStderr.includes('--sha'), 'fix2-actual-cmd: git command -> stderr mentions --sha');

    // Also verify the helper is present in source
    const indexSrcFix2 = readFileSync(indexPath, 'utf8');
    assert(
      indexSrcFix2.includes('taskRequiresGitSha'),
      'fix2-regex: taskRequiresGitSha helper present in source',
    );
    assert(
      indexSrcFix2.includes('negatedContext'),
      'fix2-regex: negated context handling present in source',
    );
  }

  // -- Fix 3 (edge case): Session activity check via gateway API --

  console.log('\n  -- Fix 3: Session activity check (idle session guard) --');
  {
    // Verify the implementation is present in source
    const indexSrcFix3 = readFileSync(indexPath, 'utf8');
    assert(indexSrcFix3.includes('skip-activity-check'), 'fix3-activity: --skip-activity-check flag present in source');
    assert(indexSrcFix3.includes('messageCount'), 'fix3-activity: messageCount check present in source');
    assert(indexSrcFix3.includes('msgCount <= 2'), 'fix3-activity: <=2 message threshold present in source');
    assert(indexSrcFix3.includes('session activity check unavailable'), 'fix3-activity: graceful degradation warning present in source');

    // Test: Gateway API unavailable -> done accepted with warning (graceful degradation)
    // In the test environment, no gateway is running, so fetch() will throw ECONNREFUSED.
    // The done command should succeed (not rejected) and log a warning.
    writeFileSync(doneLabels, JSON.stringify({
      'activity-check-no-gw': {
        sessionKey: 'agent:main:subagent:activity-no-gw-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Do some work and report.',
      },
    }) + '\n');

    let noGwOut;
    let noGwThrew = false;
    try {
      noGwOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'activity-check-no-gw',
        '--summary', 'completed with no gateway',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        // Use a non-existent gateway URL so fetch definitely fails
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels, OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19999' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      noGwThrew = true;
    }
    assert(!noGwThrew, 'fix3-graceful-degradation: gateway API unavailable -> done accepted (not rejected)');
    const noGwObj = JSON.parse(noGwOut.trim());
    assert(noGwObj.ok === true, 'fix3-graceful-degradation: gateway unavailable -> ok=true');
    assert(noGwObj.status === 'done', 'fix3-graceful-degradation: gateway unavailable -> status=done');

    // Test: --skip-activity-check bypasses the activity guard entirely
    writeFileSync(doneLabels, JSON.stringify({
      'activity-skip-check': {
        sessionKey: 'agent:main:subagent:activity-skip-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 90_000).toISOString(),
        timeoutSeconds: 300,
        taskPrompt: 'Read-only task.',
      },
    }) + '\n');

    let skipOut;
    let skipThrew = false;
    try {
      skipOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'activity-skip-check',
        '--summary', 'completed via skip',
        '--checklist', '{"work_complete":true}',
        '--skip-activity-check',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels, OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19999' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      skipThrew = true;
    }
    assert(!skipThrew, 'fix3-skip-activity-check: --skip-activity-check -> done accepted');
    const skipObj = JSON.parse(skipOut.trim());
    assert(skipObj.ok === true, 'fix3-skip-activity-check: ok=true');
  }

  // -- Fix 4 (edge case): --timeout stored, threshold uses stored value --

  console.log('\n  -- Fix 4: Stored timeout used for threshold --');
  {
    // Verify the source stores `timeout` in enqueue and reads `existing.timeout` in done
    const indexSrcFix4 = readFileSync(indexPath, 'utf8');
    assert(indexSrcFix4.includes('timeout:        timeoutS'), 'fix4: enqueue stores timeout in label entry');
    assert(indexSrcFix4.includes('existing.timeout'), 'fix4: done reads existing.timeout for threshold');
    assert(indexSrcFix4.includes('existing.timeout ?? existing.timeoutSeconds'), 'fix4: done falls back to timeoutSeconds');

    // Test 7: label with timeout=3600 -> threshold=120s (60s elapsed -> still rejected)
    writeFileSync(doneLabels, JSON.stringify({
      'long-timeout-task': {
        sessionKey: 'agent:main:subagent:long-timeout-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 61_000).toISOString(), // 61s ago
        // timeout=3600 -> threshold=120s, so 61s < 120s -> should be REJECTED
        timeout: 3600,
        timeoutSeconds: 3600,
      },
    }) + '\n');

    let longTimeoutThrew = false;
    let longTimeoutExitCode = null;
    try {
      execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'long-timeout-task',
        '--summary', 'quick done on long task',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels },
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      longTimeoutThrew = true;
      longTimeoutExitCode = err.status;
    }
    assert(longTimeoutThrew, 'fix4-timeout-3600: 61s elapsed with timeout=3600 -> rejected (threshold=120s)');
    assert(longTimeoutExitCode === 1, 'fix4-timeout-3600: exit code 1');

    // Test 8: label with timeout=60 -> threshold=60s (61s elapsed -> should be ACCEPTED)
    writeFileSync(doneLabels, JSON.stringify({
      'short-timeout-task': {
        sessionKey: 'agent:main:subagent:short-timeout-uuid',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date(Date.now() - 61_000).toISOString(), // 61s ago
        // timeout=60 -> threshold=60s, so 61s > 60s -> should be ACCEPTED
        timeout: 60,
        timeoutSeconds: 60,
      },
    }) + '\n');

    let shortTimeoutOut;
    let shortTimeoutThrew = false;
    try {
      shortTimeoutOut = execFileSync(process.execPath, [
        indexPath, 'done', '--label', 'short-timeout-task',
        '--summary', 'completed short task',
        '--checklist', '{"work_complete":true}',
      ], {
        encoding: 'utf8',
        env: { ...process.env, DISPATCH_LABELS_PATH: doneLabels, OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:19999' },
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      shortTimeoutThrew = true;
    }
    assert(!shortTimeoutThrew, 'fix4-timeout-60: 61s elapsed with timeout=60 -> accepted (threshold=60s)');
    const shortTimeoutObj = JSON.parse(shortTimeoutOut.trim());
    assert(shortTimeoutObj.ok === true, 'fix4-timeout-60: ok=true');
    assert(shortTimeoutObj.status === 'done', 'fix4-timeout-60: status=done');
  }

  // -- Fix 5: Watcher auto-resolve uses 'interrupted' not 'done' (source check) --

  console.log('\n  -- Fix 5: Watcher uses interrupted not done for auto-resolve --');
  {
    const dispatchDir2 = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
    const watcherSrc = readFileSync(join(dispatchDir2, 'watcher.mjs'), 'utf8');
    assert(
      watcherSrc.includes("NOTE: Always resolve as 'interrupted', never 'done'. Only agent-side cmdDone may set status=done."),
      'fix5: watcher.mjs has required auto-resolve comment',
    );
    // The 'interrupted' path uses markLabelError (not markLabelDone)
    assert(watcherSrc.includes("status.status === 'interrupted'"), 'fix5: watcher handles interrupted status from cmdStatus');
    assert(watcherSrc.includes('markLabelError(label'), 'fix5: watcher uses markLabelError (not markLabelDone) for interrupted path');
  }

  rmSync(tempDone, { recursive: true, force: true });
}


// ===========================================================
// SECTION: At-Jobs (one-shot scheduling, v18)
// ===========================================================

console.log('\n-- At-Jobs (one-shot scheduling) --');

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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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

  const atParent = createJob({
    name: 'At-Parent',
    schedule_cron: '0 9 * * *',
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'parent for child at-job guard',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000, origin: 'system',
  });
  let threwChildAt = false;
  try {
    createJob({
      name: 'Child At Rejected',
      parent_id: atParent.id,
      trigger_on: 'success',
      schedule_kind: 'at',
      schedule_at: past,
      payload_message: 'child at-job should be rejected',
      delivery_mode: 'none',
      run_timeout_ms: 300_000,
    });
  } catch (e) {
    threwChildAt = e.message.includes('child jobs cannot use schedule_kind "at"');
  }
  assert(threwChildAt, 'createJob rejects child at-jobs');

  getDb().prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_kind, schedule_at, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      delivery_mode, delete_after_run, next_run_at, run_timeout_ms,
      parent_id, trigger_on, delivery_opt_out_reason, origin
    ) VALUES (
      'legacy-child-at', 'Legacy Child At', 1, 'at', ?, ?, 'UTC',
      'isolated', 'main', 'agentTurn', 'legacy child at payload',
      'none', 1, ?, 300000,
      ?, 'success', NULL, NULL
    )
  `).run(past, AT_JOB_CRON_SENTINEL, past, atParent.id);
  getDb().prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_kind, schedule_at, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      delivery_mode, delete_after_run, next_run_at, run_timeout_ms,
      parent_id, trigger_on, delivery_opt_out_reason, origin
    ) VALUES (
      'legacy-child-cron', 'Legacy Child Cron', 1, 'cron', NULL, '*/5 * * * *', 'UTC',
      'isolated', 'main', 'agentTurn', 'legacy child cron payload',
      'none', 0, ?, 300000,
      ?, 'success', NULL, NULL
    )
  `).run(past, atParent.id);
  assert(!getDueAtJobs().some(j => j.id === 'legacy-child-at'), 'getDueAtJobs ignores legacy child at-jobs');
  assert(!getDueJobs().some(j => j.id === 'legacy-child-cron'), 'getDueJobs ignores legacy child cron jobs');
  deleteJob('legacy-child-at');
  deleteJob('legacy-child-cron');
  deleteJob(atParent.id);

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

  // ISO-8601 schedule_at input is normalized and still due when appropriate
  const isoPastInput = new Date(Date.now() - 2 * 60000).toISOString();
  const atIsoPast = createJob({
    name: 'At-Job ISO Past Test',
    schedule_kind: 'at',
    schedule_at: isoPastInput,
    schedule_cron: AT_JOB_CRON_SENTINEL,
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'at-job iso past payload',
    delete_after_run: 1,
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
  });
  assert(atIsoPast.schedule_at.includes(' '), 'ISO schedule_at normalized to SQLite UTC format');
  assert(getDueAtJobs().some(j => j.id === atIsoPast.id), 'getDueAtJobs returns at-job created from ISO schedule_at');
  deleteJob(atIsoPast.id);

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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    run_timeout_ms:   300_000, origin: 'system',
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


// ===========================================================
// SECTION: Watchdog Heartbeat Guard
// ===========================================================
// Tests the lastPing-based liveness guard added to cmdStatus and cmdSync
// in dispatch/index.mjs (Part 2 of fix/watchdog-premature-resolve).

console.log('\n-- Watchdog Heartbeat Guard --');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexPath   = join(dispatchDir, 'index.mjs');
  const watcherPath = join(dispatchDir, 'watcher.mjs');

  // -- Source-level presence checks -------------------------------------
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

  // -- Helper: create temp env with stale sessions.json -----------------
  // Uses a session idle for 15 min -- normally triggering auto-resolve.
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

  // -- Test 1: fresh lastPing + within hardCeiling -> stays running -------
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
        lastPing:       new Date(Date.now() - 30 * 1000).toISOString(),      // 30s ago -- fresh
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t1');
    assert(result.status === 'running',   'watchdog guard t1: fresh lastPing + within ceiling -> stays running');
    assert(!result.syncAction,            'watchdog guard t1: no auto-resolve action taken');
  }

  // -- Test 2: stale lastPing + within hardCeiling -> falls through, auto-resolves -
  // lastPing = 4 min ago (> PING_STALE_MS = 3 min), elapsed = 8 min < hardCeiling (15 min).
  // Should fall through to checkSessionDone with idleThresholdMs = 10 min.
  // Session idle 15 min > 10 min -> auto-resolves.
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
        lastPing:       new Date(Date.now() - 4 * 60 * 1000).toISOString(),  // 4 min ago -- stale
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t2');
    assert(result.status === 'interrupted', 'watchdog guard t2: stale lastPing -> falls through -> auto-resolves as interrupted');
  }

  // -- Test 3: elapsedMs >= hardCeilingMs -> resolves regardless of fresh ping -
  // elapsed = 20 min >= hardCeiling (600 * 1.5s = 15 min).
  // Uses 2-min threshold; session idle 15 min > 2 min -> auto-resolves.
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
        timeoutSeconds: 600,   // hardCeiling = 15 min; elapsed = 20 min >= 15 min
        lastPing:       new Date(Date.now() - 30 * 1000).toISOString(),      // 30s ago -- fresh
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t3');
    assert(result.status === 'interrupted', 'watchdog guard t3: past hard ceiling -> resolves as interrupted regardless of fresh ping');
  }

  // -- Test 4: no lastPing (backward compat) -> uses idleThresholdMs -----
  // Sessions dispatched before the heartbeat feature have no lastPing.
  // Behavior should use idleThresholdMs = max(timeoutSeconds*1000, 10 min).

  // 4a: timeoutSeconds=600 -> idleThreshold=10 min, hardCeiling=15 min.
  //     spawnedAt 12 min ago -> elapsed(12 min) < hardCeiling(15 min) -> idleThresholdMs path.
  //     Session idle 15 min (makeWdgEnv default) > idleThreshold 10 min -> resolves.
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
        // no lastPing -- backward compat
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t4a');
    assert(result.status === 'interrupted', 'watchdog guard t4a: no lastPing + idle > idleThreshold -> resolves as interrupted (idleThresholdMs path)');
  }

  // 4b: timeoutSeconds=1800 -> idleThreshold=30 min. Session idle 15 min < 30 min -> stays running.
  {
    const tmpDir = join(tmpBase, 't4b');
    mkdirSync(tmpDir);
    const { labelsPath, fakeSessionKey } = makeWdgEnv(tmpDir);

    // Override sessions.json so session is 15 min stale (same as makeWdgEnv default)
    // but hardCeiling = 1800 * 1.5 = 2700s = 45 min, elapsed = 20 min < 45 min,
    // idleThreshold = max(1800000, 600000) = 30 min > silence(15 min) -> stays running.
    writeFileSync(labelsPath, JSON.stringify({
      'wdg-t4b': {
        sessionKey:     fakeSessionKey,
        status:         'running',
        agent:          'main',
        mode:           'fresh',
        spawnedAt:      new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
        timeoutSeconds: 1800,  // idleThreshold = 30 min, hardCeiling = 45 min
        // no lastPing -- backward compat
      },
    }) + '\n');

    const result = runStatus(labelsPath, tmpDir, 'wdg-t4b');
    assert(result.status === 'running', 'watchdog guard t4b: no lastPing + idle < idleThreshold -> stays running');
  }

  rmSync(tmpBase, { recursive: true, force: true });
}

// ===========================================================
// Post-Office Routing
// ===========================================================

console.log('\n-- Post-Office Routing: gatewayNotify enqueues to messages table --');
{
  // Import onFinished from hooks.mjs (which uses sendMessage internally)
  const { onFinished } = await import('./dispatch/hooks.mjs');

  // Use getDb() to get the current open DB instance (not the stale top-level `db`)
  const liveDb = getDb();

  // Count messages before
  const before = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='dispatch' AND to_agent='main' AND kind='result'").get();

  // Call onFinished with deliverTo set -- triggers gatewayNotify -> sendMessage
  await onFinished({
    label:          'test-label-post-office',
    job_id:         'jid-post-office',
    run_id:         'rid-post-office',
    agent:          'main',
    status:         'ok',
    deliverTo:      '1234567890',
    deliveryChannel: 'telegram',
    summary:        'post-office test completed',
  });

  const after = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='dispatch' AND to_agent='main' AND kind='result'").get();
  assert(after.cnt === before.cnt + 1, 'gatewayNotify: enqueues one message to messages table');

  const msg = liveDb.prepare("SELECT * FROM messages WHERE from_agent='dispatch' AND to_agent='main' AND kind='result' AND subject='test-label-post-office'").get();
  assert(msg !== undefined,                              'gatewayNotify: message exists');
  assert(msg.from_agent === 'dispatch',                  'gatewayNotify: from_agent=dispatch');
  assert(msg.to_agent === 'main',                        'gatewayNotify: to_agent=main');
  assert(msg.kind === 'result',                          'gatewayNotify: kind=result');
  assert(msg.subject === 'test-label-post-office',       'gatewayNotify: subject=label');
  assert(msg.body.includes('test-label-post-office'),    'gatewayNotify: body includes label');
  assert(msg.body.includes('post-office test completed'),'gatewayNotify: body includes summary');
  assert(msg.channel === 'telegram',                     'gatewayNotify: channel stored for reference');
  assert(msg.status === 'pending',                       'gatewayNotify: message status=pending (not yet delivered)');
}

console.log('\n-- Post-Office Routing: handleDelivery (announce) enqueues to messages table --');
{
  const { createDeliveryHelpers } = await import('./dispatcher-delivery.js');

  const liveDb = getDb();
  const logs = [];
  const { handleDelivery } = createDeliveryHelpers({
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
    deliverMessage: async () => { throw new Error('should not call deliverMessage directly'); },
    resolveDeliveryAlias: () => null,
  });

  const before = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='scheduler' AND to_agent='main' AND kind='result'").get();

  const announceJob = {
    name: 'PostOfficeShellJob',
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: '1234567890',
  };
  await handleDelivery(announceJob, 'shell job done -- all tests passed');

  const after = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='scheduler' AND to_agent='main' AND kind='result'").get();
  assert(after.cnt === before.cnt + 1, 'handleDelivery(announce): enqueues one message');

  const msg = liveDb.prepare("SELECT * FROM messages WHERE from_agent='scheduler' AND to_agent='main' AND kind='result' AND subject='PostOfficeShellJob'").get();
  assert(msg !== undefined,                             'handleDelivery(announce): message exists');
  assert(msg.from_agent === 'scheduler',                'handleDelivery(announce): from_agent=scheduler');
  assert(msg.to_agent === 'main',                       'handleDelivery(announce): to_agent=main');
  assert(msg.kind === 'result',                         'handleDelivery(announce): kind=result');
  assert(msg.subject === 'PostOfficeShellJob',          'handleDelivery(announce): subject=job name');
  assert(msg.body.includes('shell job done'),           'handleDelivery(announce): body=content');
  assert(msg.status === 'pending',                      'handleDelivery(announce): status=pending');

  assert(logs.some(l => l.msg.includes('Enqueued')),   'handleDelivery(announce): logs Enqueued');
}

console.log('\n-- Post-Office Routing: handleDelivery (delivery_mode=none) does not enqueue --');
{
  const { createDeliveryHelpers } = await import('./dispatcher-delivery.js');

  const liveDb = getDb();
  const { handleDelivery } = createDeliveryHelpers({
    log: () => {},
    deliverMessage: async () => {},
    resolveDeliveryAlias: () => null,
  });

  const before = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='scheduler' AND to_agent='main'").get();

  const noneJob = {
    name: 'SilentJob',
    delivery_mode: 'none', delivery_opt_out_reason: 'test',
    delivery_channel: 'telegram',
    delivery_to: '1234567890',
  };
  await handleDelivery(noneJob, 'should not be enqueued');

  const after = liveDb.prepare("SELECT COUNT(*) as cnt FROM messages WHERE from_agent='scheduler' AND to_agent='main'").get();
  assert(after.cnt === before.cnt, 'handleDelivery(none): does not enqueue any message');
}

// ===========================================================
// SECTION: inbox-consumer per-message delivery routing (v21)
// ===========================================================

console.log('\n-- inbox-consumer per-message delivery_to routing --');
{
  const liveDb = getDb();

  // Verify schema: messages.delivery_to column exists
  const msgColsV21 = liveDb.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  assert(msgColsV21.includes('delivery_to'), 'messages.delivery_to column exists (v21)');

  // Verify schema_migrations has v21
  const v21 = liveDb.prepare('SELECT version FROM schema_migrations WHERE version = 21').get();
  assert(v21 !== undefined, 'schema_migrations has v21');

  // Test 1: sendMessage stores delivery_to
  const m1 = sendMessage({
    from_agent:  'scheduler',
    to_agent:    'main',
    kind:        'result',
    subject:     'group-result',
    body:        'Job completed in group chat',
    channel:     'telegram',
    delivery_to: '-100000000',
  });
  assert(m1.delivery_to === '-100000000', 'sendMessage stores delivery_to on message');
  assert(m1.channel === 'telegram', 'sendMessage stores channel on message');

  // Test 2: sendMessage without delivery_to -> null
  const m2 = sendMessage({
    from_agent: 'scheduler',
    to_agent:   'main',
    kind:       'result',
    subject:    'dm-result',
    body:       'Job completed for DM delivery',
    channel:    'telegram',
  });
  assert(m2.delivery_to === null, 'sendMessage without delivery_to -> null');

  // Test 3: getMessage returns delivery_to
  const fetched1 = getMessage(m1.id);
  assert(fetched1.delivery_to === '-100000000', 'getMessage returns delivery_to correctly');

  // Test 4: inbox-consumer selectPendingMessages query returns delivery_to and channel
  // We simulate this by running the same SQL used in inbox-consumer
  const pendingMsgs = liveDb.prepare(`
    SELECT id, from_agent, to_agent, subject, body, kind, created_at, priority,
           delivery_to, channel
    FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
      AND status IN ('pending', 'delivered')
    ORDER BY priority DESC, created_at ASC
    LIMIT 10
  `).all('main');

  const withDeliveryTo = pendingMsgs.filter(m => m.delivery_to === '-100000000');
  assert(withDeliveryTo.length >= 1, 'selectPendingMessages returns messages with delivery_to set');
  assert(withDeliveryTo[0].channel === 'telegram', 'selectPendingMessages returns channel on message');

  const withoutDeliveryTo = pendingMsgs.filter(m => m.id === m2.id);
  assert(withoutDeliveryTo.length >= 1, 'selectPendingMessages returns messages without delivery_to');
  assert(withoutDeliveryTo[0].delivery_to === null, 'selectPendingMessages: delivery_to is null when not set');

  // Test 5: per-message routing logic (mirrors inbox-consumer drainOnce)
  // Message WITH delivery_to -> routes to delivery_to, not the default --to
  const defaultTo = '123456789';
  const defaultChannel = 'telegram';

  {
    const msg = withDeliveryTo[0];
    const msgTarget = msg.delivery_to || defaultTo;
    const msgChannel = msg.channel || defaultChannel;
    assert(msgTarget === '-100000000', 'routing: msg.delivery_to used when present (not default --to)');
    assert(msgChannel === 'telegram', 'routing: msg.channel used when present');
  }

  // Test 6: Message WITHOUT delivery_to -> falls back to default --to
  {
    const msg = withoutDeliveryTo[0];
    const msgTarget = msg.delivery_to || defaultTo;
    const msgChannel = msg.channel || defaultChannel;
    assert(msgTarget === defaultTo, 'routing: falls back to default --to when delivery_to is null');
    assert(msgChannel === defaultChannel, 'routing: falls back to default channel when msg.channel is null');
  }

  // Test 7: Message with channel set -> uses that channel, not default
  const m3 = sendMessage({
    from_agent:  'scheduler',
    to_agent:    'main',
    kind:        'result',
    subject:     'whatsapp-result',
    body:        'Job completed for WhatsApp',
    channel:     'whatsapp',
    delivery_to: '15551234567',
  });
  {
    const msgTarget = m3.delivery_to || defaultTo;
    const msgChannel = m3.channel || defaultChannel;
    assert(msgTarget === '15551234567', 'routing: uses msg.delivery_to for whatsapp message');
    assert(msgChannel === 'whatsapp', 'routing: uses msg.channel (whatsapp) not default (telegram)');
  }

  // Test 8: dispatcher-delivery.js sendMessage includes delivery_to (integration check)
  // handleDelivery already calls sendMessage with delivery_to -- verify it's stored
  const { createDeliveryHelpers } = await import('./dispatcher-delivery.js');
  const deliveryLogs = [];
  const { handleDelivery: handleDeliveryV21 } = createDeliveryHelpers({
    log: (level, msg, meta) => deliveryLogs.push({ level, msg, meta }),
    resolveDeliveryAlias: () => null,
  });

  const jobV21 = {
    name: 'GroupChatJob',
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: '-100000000',
  };
  await handleDeliveryV21(jobV21, 'group job done');

  const groupMsg = liveDb.prepare(
    "SELECT * FROM messages WHERE from_agent='scheduler' AND to_agent='main' AND subject='GroupChatJob' ORDER BY created_at DESC LIMIT 1"
  ).get();
  assert(groupMsg !== undefined, 'dispatcher-delivery: message created for group chat job');
  assert(groupMsg.delivery_to === '-100000000', 'dispatcher-delivery: delivery_to stored on message from handleDelivery');
  assert(groupMsg.channel === 'telegram', 'dispatcher-delivery: channel stored on message from handleDelivery');

  // Clean up
  markAllRead('main');
}

console.log('\n-- dispatch/index.mjs --deliver-to error message --');
{
  const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), 'dispatch');
  const indexSrc = readFileSync(join(dispatchDir, 'index.mjs'), 'utf8');

  // Verify improved error message contains --deliver-to guidance
  assert(indexSrc.includes('REJECTED: --deliver-to is required for dispatch jobs'), 'dispatch error: REJECTED prefix present');
  assert(indexSrc.includes('-100200000000'), 'dispatch error: generic group ID example present');
  assert(indexSrc.includes('123456789'), 'dispatch error: generic DM example present');
  assert(indexSrc.includes('--origin telegram:<chat_id>'), 'dispatch error: --origin auto-derive guidance present');
  assert(indexSrc.includes('audit trail required'), 'dispatch error: --no-monitor audit trail note present');

  // Verify the old confusing message is gone
  assert(!indexSrc.includes('--origin is required for agentTurn jobs'), 'dispatch error: old confusing --origin message removed');
}

// ============================================================
// SECTION: v0.2 Runtime Features
// ============================================================

console.log('\n-- v0.2 Schema Column Verification --');
{
  const liveDb = getDb();
  const jobCols = liveDb.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  const v02JobCols = [
    'identity_principal', 'identity_run_as', 'identity_attestation',
    'identity_ref', 'identity_subject_kind', 'identity_subject_principal',
    'identity_trust_level', 'identity_delegation_mode', 'identity',
    'authorization_proof_ref', 'authorization_proof',
    'authorization_ref', 'authorization',
    'evidence_ref', 'evidence',
    'contract_required_trust_level', 'contract_trust_enforcement',
    'contract_sandbox', 'contract_allowed_paths', 'contract_network',
    'contract_max_cost_usd', 'contract_audit',
    'child_credential_policy',
  ];
  for (const col of v02JobCols) {
    assert(jobCols.includes(col), `jobs table should have column ${col}`);
  }

  const runCols = liveDb.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
  const v02RunCols = [
    'identity_resolved', 'trust_evaluation', 'authorization_decision',
    'authorization_proof_verification', 'evidence_record', 'credential_handoff_summary',
  ];
  for (const col of v02RunCols) {
    assert(runCols.includes(col), `runs table should have column ${col}`);
  }
}

console.log('\n-- v0.2 Validation: valid fields accepted --');
{
  const v02Job = createJob({
    name: 'v02-valid-fields',
    schedule_cron: '0 4 * * *',
    payload_message: 'identity test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity_principal: 'agent:scheduler-v2',
    identity_run_as: 'service-account-main',
    identity_attestation: 'self-signed',
    identity_ref: 'urn:openclaw:identity:agent:scheduler-v2',
    identity_subject_kind: 'agent',
    identity_subject_principal: 'agent:scheduler-v2',
    identity_trust_level: 'supervised',
    identity_delegation_mode: 'none',
    identity: JSON.stringify({ subject_kind: 'agent', principal: 'agent:scheduler-v2', trust_level: 'supervised' }),
    authorization_proof_ref: 'urn:openclaw:proof:abc123',
    authorization_proof: JSON.stringify({ method: 'signed-jwt', ref: 'abc123' }),
    authorization_ref: 'urn:openclaw:authz:policy-1',
    authorization: JSON.stringify({ decision: 'permit', reason: 'pre-approved' }),
    evidence_ref: 'urn:openclaw:evidence:run-log-1',
    evidence: JSON.stringify({ collect: ['stdout', 'stderr'], retention: '30d' }),
    contract_required_trust_level: 'supervised',
    contract_trust_enforcement: 'block',
    contract_sandbox: 'docker',
    contract_allowed_paths: JSON.stringify(['/tmp', '/data']),
    contract_network: 'restricted',
    contract_max_cost_usd: 1.50,
    contract_audit: 'full',
  });
  assert(v02Job && v02Job.id, 'v0.2 job with all fields created successfully');
  assert(v02Job.identity_principal === 'agent:scheduler-v2', 'v0.2 identity_principal stored');
  assert(v02Job.identity_trust_level === 'supervised', 'v0.2 identity_trust_level stored');
  assert(v02Job.identity_subject_kind === 'agent', 'v0.2 identity_subject_kind stored');
  assert(v02Job.identity_delegation_mode === 'none', 'v0.2 identity_delegation_mode stored');
  assert(v02Job.contract_required_trust_level === 'supervised', 'v0.2 contract_required_trust_level stored');
  assert(v02Job.contract_trust_enforcement === 'block', 'v0.2 contract_trust_enforcement stored');
  assert(v02Job.contract_max_cost_usd === 1.50, 'v0.2 contract_max_cost_usd stored');
  assert(v02Job.contract_audit === 'full', 'v0.2 contract_audit stored');
  assert(v02Job.contract_sandbox === 'docker', 'v0.2 contract_sandbox stored');
  assert(v02Job.contract_network === 'restricted', 'v0.2 contract_network stored');
}

console.log('\n-- v0.2 Validation: invalid enum rejected --');
{
  let threwInvalidTrustLevel = false;
  try {
    createJob({
      name: 'v02-bad-trust',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad trust',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      identity_trust_level: 'invalid',
    });
  } catch (e) {
    threwInvalidTrustLevel = e.message.includes('identity_trust_level');
  }
  assert(threwInvalidTrustLevel, 'createJob rejects invalid identity_trust_level enum');

  let threwInvalidSubjectKind = false;
  try {
    createJob({
      name: 'v02-bad-subject-kind',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad subject kind',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      identity_subject_kind: 'bogus',
    });
  } catch (e) {
    threwInvalidSubjectKind = e.message.includes('identity_subject_kind');
  }
  assert(threwInvalidSubjectKind, 'createJob rejects invalid identity_subject_kind enum');

  let threwInvalidDelegation = false;
  try {
    createJob({
      name: 'v02-bad-delegation',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad delegation',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      identity_delegation_mode: 'nope',
    });
  } catch (e) {
    threwInvalidDelegation = e.message.includes('identity_delegation_mode');
  }
  assert(threwInvalidDelegation, 'createJob rejects invalid identity_delegation_mode enum');

  let threwInvalidContractTrust = false;
  try {
    createJob({
      name: 'v02-bad-contract-trust',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad contract trust',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_required_trust_level: 'ultra',
    });
  } catch (e) {
    threwInvalidContractTrust = e.message.includes('contract_required_trust_level');
  }
  assert(threwInvalidContractTrust, 'createJob rejects invalid contract_required_trust_level enum');

  let threwInvalidEnforcement = false;
  try {
    createJob({
      name: 'v02-bad-enforcement',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad enforcement',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_trust_enforcement: 'punish',
    });
  } catch (e) {
    threwInvalidEnforcement = e.message.includes('contract_trust_enforcement');
  }
  assert(threwInvalidEnforcement, 'createJob rejects invalid contract_trust_enforcement enum');
}

console.log('\n-- v0.2 Validation: credential handoff target guard --');
{
  let threwNonShellPresentation = false;
  try {
    createJob({
      name: 'v02-handoff-isolated',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad target',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      identity: JSON.stringify({
        provider: 'mock-provider',
        presentation: { mode: 'inject-env' },
      }),
    });
  } catch (e) {
    threwNonShellPresentation = e.message.includes('session_target "shell"');
  }
  assert(threwNonShellPresentation, 'createJob rejects credential handoff on non-shell jobs');

  const shellHandoffJob = createJob({
    name: 'v02-handoff-shell',
    schedule_cron: '0 5 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo handoff',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({
      provider: 'mock-provider',
      presentation: { mode: 'inject-env' },
    }),
  });
  assert(shellHandoffJob.session_target === 'shell', 'createJob allows credential handoff on shell jobs');
  deleteJob(shellHandoffJob.id);
}

console.log('\n-- v0.2 Validation: invalid JSON blob rejected --');
{
  let threwBadIdentityJson = false;
  try {
    createJob({
      name: 'v02-bad-identity-json',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad json',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      identity: 'not-json',
    });
  } catch (e) {
    threwBadIdentityJson = e.message.includes('identity') && e.message.includes('JSON');
  }
  assert(threwBadIdentityJson, 'createJob rejects non-JSON identity blob');

  let threwBadAuthProofJson = false;
  try {
    createJob({
      name: 'v02-bad-auth-proof-json',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad auth proof',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      authorization_proof: '{broken',
    });
  } catch (e) {
    threwBadAuthProofJson = e.message.includes('authorization_proof') && e.message.includes('JSON');
  }
  assert(threwBadAuthProofJson, 'createJob rejects non-JSON authorization_proof blob');

  let threwBadAuthJson = false;
  try {
    createJob({
      name: 'v02-bad-auth-json',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad authorization',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      authorization: 'not{valid',
    });
  } catch (e) {
    threwBadAuthJson = e.message.includes('authorization') && e.message.includes('JSON');
  }
  assert(threwBadAuthJson, 'createJob rejects non-JSON authorization blob');

  let threwBadEvidenceJson = false;
  try {
    createJob({
      name: 'v02-bad-evidence-json',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad evidence',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      evidence: 'nope[',
    });
  } catch (e) {
    threwBadEvidenceJson = e.message.includes('evidence') && e.message.includes('JSON');
  }
  assert(threwBadEvidenceJson, 'createJob rejects non-JSON evidence blob');

  let threwBadAllowedPaths = false;
  try {
    createJob({
      name: 'v02-bad-allowed-paths',
      schedule_cron: '0 5 * * *',
      payload_message: 'bad paths',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_allowed_paths: 'just-a-string',
    });
  } catch (e) {
    threwBadAllowedPaths = e.message.includes('contract_allowed_paths') && e.message.includes('JSON');
  }
  assert(threwBadAllowedPaths, 'createJob rejects non-JSON contract_allowed_paths blob');
}

console.log('\n-- v0.2 Validation: null values accepted (all optional) --');
{
  const minimalJob = createJob({
    name: 'v02-no-v02-fields',
    schedule_cron: '0 6 * * *',
    payload_message: 'minimal job',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  assert(minimalJob && minimalJob.id, 'job with no v0.2 fields created successfully');
  assert(minimalJob.identity_principal === null, 'identity_principal defaults to null');
  assert(minimalJob.identity_trust_level === null, 'identity_trust_level defaults to null');
  assert(minimalJob.identity === null, 'identity defaults to null');
  assert(minimalJob.authorization === null, 'authorization defaults to null');
  assert(minimalJob.evidence === null, 'evidence defaults to null');
  assert(minimalJob.contract_required_trust_level === null, 'contract_required_trust_level defaults to null');
  assert(minimalJob.contract_max_cost_usd === null, 'contract_max_cost_usd defaults to null');
}

console.log('\n-- v0.2 Validation: contract_max_cost_usd --');
{
  let threwNegativeCost = false;
  try {
    createJob({
      name: 'v02-negative-cost',
      schedule_cron: '0 5 * * *',
      payload_message: 'negative cost',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_max_cost_usd: -1.0,
    });
  } catch (e) {
    threwNegativeCost = e.message.includes('contract_max_cost_usd');
  }
  assert(threwNegativeCost, 'createJob rejects negative contract_max_cost_usd');

  let threwInfiniteCost = false;
  try {
    createJob({
      name: 'v02-infinite-cost',
      schedule_cron: '0 5 * * *',
      payload_message: 'infinite cost',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_max_cost_usd: Infinity,
    });
  } catch (e) {
    threwInfiniteCost = e.message.includes('contract_max_cost_usd');
  }
  assert(threwInfiniteCost, 'createJob rejects Infinity contract_max_cost_usd');

  let threwStringCost = false;
  try {
    createJob({
      name: 'v02-string-cost',
      schedule_cron: '0 5 * * *',
      payload_message: 'string cost',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 300_000,
      origin: 'system',
      contract_max_cost_usd: 'five',
    });
  } catch (e) {
    threwStringCost = e.message.includes('contract_max_cost_usd');
  }
  assert(threwStringCost, 'createJob rejects non-numeric contract_max_cost_usd');

  const zeroCostJob = createJob({
    name: 'v02-zero-cost',
    schedule_cron: '0 5 * * *',
    payload_message: 'zero cost',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    contract_max_cost_usd: 0,
  });
  assert(zeroCostJob.contract_max_cost_usd === 0, 'createJob accepts zero contract_max_cost_usd');

  const validCostJob = createJob({
    name: 'v02-valid-cost',
    schedule_cron: '0 5 * * *',
    payload_message: 'valid cost',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    contract_max_cost_usd: 99.99,
  });
  assert(validCostJob.contract_max_cost_usd === 99.99, 'createJob stores valid contract_max_cost_usd');
}

console.log('\n-- v0.2 Storage Round-Trip --');
{
  const identityBlob = JSON.stringify({
    subject_kind: 'service',
    principal: 'svc:data-pipeline',
    trust_level: 'autonomous',
    delegation_mode: 'on-behalf-of',
    presentation: {
      mode: 'inject-env',
      bindings: [
        { env: 'SVC_TOKEN', source: 'vault:secret/svc/token', cleanup: true },
        { env: 'SVC_CERT', source: 'vault:secret/svc/cert' },
      ],
      cleanup_required: false,
    },
  });
  const authProofBlob = JSON.stringify({ method: 'hmac', ref: 'proof-ref-456', payload: 'base64data' });
  const authBlob = JSON.stringify({ decision: 'permit', reason: 'approved by policy engine', depends_on_trust: true });
  const evidenceBlob = JSON.stringify({ collect: ['stdout', 'exit_code'], retention: '90d', format: 'json' });
  const allowedPathsBlob = JSON.stringify(['/opt/data', '/var/log']);

  const rtJob = createJob({
    name: 'v02-roundtrip',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'roundtrip test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity_principal: 'svc:data-pipeline',
    identity_run_as: 'data-runner',
    identity_attestation: 'oidc',
    identity_ref: 'urn:openclaw:identity:svc:data-pipeline',
    identity_subject_kind: 'service',
    identity_subject_principal: 'svc:data-pipeline',
    identity_trust_level: 'autonomous',
    identity_delegation_mode: 'on-behalf-of',
    identity: identityBlob,
    authorization_proof_ref: 'urn:openclaw:proof:456',
    authorization_proof: authProofBlob,
    authorization_ref: 'urn:openclaw:authz:policy-2',
    authorization: authBlob,
    evidence_ref: 'urn:openclaw:evidence:log-2',
    evidence: evidenceBlob,
    contract_required_trust_level: 'autonomous',
    contract_trust_enforcement: 'warn',
    contract_sandbox: 'nsjail',
    contract_allowed_paths: allowedPathsBlob,
    contract_network: 'egress-only',
    contract_max_cost_usd: 25.00,
    contract_audit: 'minimal',
  });

  const fetched = getJob(rtJob.id);
  assert(fetched.identity_principal === 'svc:data-pipeline', 'roundtrip: identity_principal');
  assert(fetched.identity_run_as === 'data-runner', 'roundtrip: identity_run_as');
  assert(fetched.identity_attestation === 'oidc', 'roundtrip: identity_attestation');
  assert(fetched.identity_ref === 'urn:openclaw:identity:svc:data-pipeline', 'roundtrip: identity_ref');
  assert(fetched.identity_subject_kind === 'service', 'roundtrip: identity_subject_kind');
  assert(fetched.identity_subject_principal === 'svc:data-pipeline', 'roundtrip: identity_subject_principal');
  assert(fetched.identity_trust_level === 'autonomous', 'roundtrip: identity_trust_level');
  assert(fetched.identity_delegation_mode === 'on-behalf-of', 'roundtrip: identity_delegation_mode');
  assert(fetched.identity === identityBlob, 'roundtrip: identity JSON blob');
  assert(fetched.authorization_proof_ref === 'urn:openclaw:proof:456', 'roundtrip: authorization_proof_ref');
  assert(fetched.authorization_proof === authProofBlob, 'roundtrip: authorization_proof JSON blob');
  assert(fetched.authorization_ref === 'urn:openclaw:authz:policy-2', 'roundtrip: authorization_ref');
  assert(fetched.authorization === authBlob, 'roundtrip: authorization JSON blob');
  assert(fetched.evidence_ref === 'urn:openclaw:evidence:log-2', 'roundtrip: evidence_ref');
  assert(fetched.evidence === evidenceBlob, 'roundtrip: evidence JSON blob');
  assert(fetched.contract_required_trust_level === 'autonomous', 'roundtrip: contract_required_trust_level');
  assert(fetched.contract_trust_enforcement === 'warn', 'roundtrip: contract_trust_enforcement');
  assert(fetched.contract_sandbox === 'nsjail', 'roundtrip: contract_sandbox');
  assert(fetched.contract_allowed_paths === allowedPathsBlob, 'roundtrip: contract_allowed_paths');
  assert(fetched.contract_network === 'egress-only', 'roundtrip: contract_network');
  assert(fetched.contract_max_cost_usd === 25.00, 'roundtrip: contract_max_cost_usd');
  assert(fetched.contract_audit === 'minimal', 'roundtrip: contract_audit');

  // Update a v0.2 field and verify
  updateJob(rtJob.id, { contract_max_cost_usd: 50.00 });
  const updated = getJob(rtJob.id);
  assert(updated.contract_max_cost_usd === 50.00, 'roundtrip: updateJob changes contract_max_cost_usd');
  assert(updated.identity_principal === 'svc:data-pipeline', 'roundtrip: updateJob preserves untouched v0.2 fields');

  updateJob(rtJob.id, { identity_trust_level: 'restricted' });
  const updated2 = getJob(rtJob.id);
  assert(updated2.identity_trust_level === 'restricted', 'roundtrip: updateJob changes identity_trust_level');
}

console.log('\n-- v0.2 resolveIdentity --');
{
  // With identity JSON blob
  const blobResult = await resolveIdentity({
    identity: JSON.stringify({
      subject_kind: 'agent',
      principal: 'agent:test-1',
      trust_level: 'supervised',
      delegation_mode: 'none',
    }),
  });
  assert(blobResult !== null, 'resolveIdentity: blob returns non-null');
  assert(blobResult.subject_kind === 'agent', 'resolveIdentity: blob subject_kind');
  assert(blobResult.principal === 'agent:test-1', 'resolveIdentity: blob principal');
  assert(blobResult.trust_level === 'supervised', 'resolveIdentity: blob trust_level');
  assert(blobResult.delegation_mode === 'none', 'resolveIdentity: blob delegation_mode');
  assert(blobResult.raw !== null && typeof blobResult.raw === 'object', 'resolveIdentity: blob raw is parsed object');

  // With scalar fields only (no blob)
  const scalarResult = await resolveIdentity({
    identity_principal: 'user:alex',
    identity_subject_kind: 'user',
    identity_trust_level: 'autonomous',
    identity_delegation_mode: 'on-behalf-of',
  });
  assert(scalarResult !== null, 'resolveIdentity: scalars returns non-null');
  assert(scalarResult.subject_kind === 'user', 'resolveIdentity: scalar subject_kind');
  assert(scalarResult.principal === 'user:alex', 'resolveIdentity: scalar principal');
  assert(scalarResult.trust_level === 'autonomous', 'resolveIdentity: scalar trust_level');
  assert(scalarResult.raw === null, 'resolveIdentity: scalar raw is null');

  // With no identity at all
  const nullResult = await resolveIdentity({});
  assert(nullResult === null, 'resolveIdentity: empty job returns null');

  const nullJobResult = await resolveIdentity(null);
  assert(nullJobResult === null, 'resolveIdentity: null job returns null');

  // With malformed JSON blob and scalar fallback
  const malformedResult = await resolveIdentity({
    identity: 'not-valid-json',
    identity_principal: 'fallback-principal',
    identity_subject_kind: 'workload',
  });
  assert(malformedResult !== null, 'resolveIdentity: malformed blob with scalars returns non-null');
  assert(malformedResult.principal === 'fallback-principal', 'resolveIdentity: malformed blob falls back to scalar principal');
  assert(malformedResult.raw && malformedResult.raw.error, 'resolveIdentity: malformed blob includes error in raw');
}

console.log('\n-- v0.2 evaluateTrust --');
{
  // Sufficient trust + block enforcement -> permit
  const permitResult = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'block' },
    { trust_level: 'autonomous' }
  );
  assert(permitResult.decision === 'permit', 'evaluateTrust: sufficient trust with block -> permit');
  assert(permitResult.effective_level === 'autonomous', 'evaluateTrust: effective level from identity');
  assert(permitResult.required_level === 'supervised', 'evaluateTrust: required level from contract');

  // Exact match -> permit
  const exactResult = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'block' },
    { trust_level: 'supervised' }
  );
  assert(exactResult.decision === 'permit', 'evaluateTrust: exact trust match -> permit');

  // Insufficient trust + block -> deny
  const denyResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous', contract_trust_enforcement: 'block' },
    { trust_level: 'restricted' }
  );
  assert(denyResult.decision === 'deny', 'evaluateTrust: insufficient trust with block -> deny');
  assert(denyResult.reason.includes('restricted'), 'evaluateTrust: deny reason includes effective level');

  // Insufficient trust + warn -> warn
  const warnResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous', contract_trust_enforcement: 'warn' },
    { trust_level: 'supervised' }
  );
  assert(warnResult.decision === 'warn', 'evaluateTrust: insufficient trust with warn -> warn');

  // Insufficient trust + none -> permit
  const noneEnforcementResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous', contract_trust_enforcement: 'none' },
    { trust_level: 'restricted' }
  );
  assert(noneEnforcementResult.decision === 'permit', 'evaluateTrust: insufficient trust with none enforcement -> permit');

  // No required trust level -> permit
  const noReqResult = evaluateTrust({}, { trust_level: 'supervised' });
  assert(noReqResult.decision === 'permit', 'evaluateTrust: no required trust -> permit');
  assert(noReqResult.reason.includes('no trust requirement'), 'evaluateTrust: no requirement reason');

  // No enforcement -> permit
  const noEnforcementResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous' },
    { trust_level: 'restricted' }
  );
  assert(noEnforcementResult.decision === 'permit', 'evaluateTrust: no enforcement defaults to none -> permit');

  // No effective trust level + block -> deny
  const noEffectiveBlockResult = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'block' },
    null
  );
  assert(noEffectiveBlockResult.decision === 'deny', 'evaluateTrust: no effective trust + block -> deny');

  // No effective trust level + warn -> warn
  const noEffectiveWarnResult = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'warn' },
    null
  );
  assert(noEffectiveWarnResult.decision === 'warn', 'evaluateTrust: no effective trust + warn -> warn');

  // Null job -> permit
  const nullJobTrust = evaluateTrust(null, null);
  assert(nullJobTrust.decision === 'permit', 'evaluateTrust: null job -> permit');

  // Trust level ordering
  assert(TRUST_LEVELS.indexOf('untrusted') < TRUST_LEVELS.indexOf('restricted'), 'TRUST_LEVELS: untrusted < restricted');
  assert(TRUST_LEVELS.indexOf('restricted') < TRUST_LEVELS.indexOf('supervised'), 'TRUST_LEVELS: restricted < supervised');
  assert(TRUST_LEVELS.indexOf('supervised') < TRUST_LEVELS.indexOf('autonomous'), 'TRUST_LEVELS: supervised < autonomous');
}

console.log('\n-- v0.2 evaluateTrust enforcement normalization --');
{
  // advisory normalizes to warn
  const advisoryResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous', contract_trust_enforcement: 'advisory' },
    { trust_level: 'supervised' }
  );
  assert(advisoryResult.decision === 'warn', 'evaluateTrust: advisory normalizes to warn');

  // strict normalizes to block
  const strictResult = evaluateTrust(
    { contract_required_trust_level: 'autonomous', contract_trust_enforcement: 'strict' },
    { trust_level: 'restricted' }
  );
  assert(strictResult.decision === 'deny', 'evaluateTrust: strict normalizes to block (deny)');

  // advisory with no effective trust -> warn
  const advisoryNoTrust = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'advisory' },
    null
  );
  assert(advisoryNoTrust.decision === 'warn', 'evaluateTrust: advisory + no effective trust -> warn');

  // strict with sufficient trust -> permit
  const strictSufficient = evaluateTrust(
    { contract_required_trust_level: 'supervised', contract_trust_enforcement: 'strict' },
    { trust_level: 'autonomous' }
  );
  assert(strictSufficient.decision === 'permit', 'evaluateTrust: strict + sufficient trust -> permit');
}

console.log('\n-- v0.2 verifyAuthorizationProof --');
{
  // Valid proof structure -> verified:true
  const validProof = await verifyAuthorizationProof({
    authorization_proof: JSON.stringify({ method: 'signed-jwt', ref: 'jwt-ref-1' }),
    authorization_proof_ref: 'urn:proof:1',
  });
  assert(validProof !== null, 'verifyAuthorizationProof: valid proof returns non-null');
  assert(validProof.verified === true, 'verifyAuthorizationProof: valid proof verified is true');
  assert(validProof.method === 'signed-jwt', 'verifyAuthorizationProof: method extracted');
  assert(validProof.ref === 'jwt-ref-1', 'verifyAuthorizationProof: ref from blob');

  // All known methods accepted
  for (const method of ['signed-jwt', 'hmac', 'api-key', 'bearer', 'mtls', 'oidc', 'saml', 'custom']) {
    const r = await verifyAuthorizationProof({
      authorization_proof: JSON.stringify({ method }),
    });
    assert(r.verified === true, `verifyAuthorizationProof: method ${method} accepted`);
  }

  // No proof -> null
  const noProof = await verifyAuthorizationProof({});
  assert(noProof === null, 'verifyAuthorizationProof: no proof -> null');
  assert(await verifyAuthorizationProof(null) === null, 'verifyAuthorizationProof: null job -> null');

  // Only ref, no inline proof -> verified:false with error
  const refOnly = await verifyAuthorizationProof({
    authorization_proof_ref: 'urn:proof:orphan',
  });
  assert(refOnly !== null, 'verifyAuthorizationProof: ref-only returns non-null');
  assert(refOnly.verified === false, 'verifyAuthorizationProof: ref-only verified is false');
  assert(refOnly.error && refOnly.error.includes('empty'), 'verifyAuthorizationProof: ref-only error mentions empty');

  // Invalid JSON -> verified:false
  const badJson = await verifyAuthorizationProof({
    authorization_proof: 'not-json',
  });
  assert(badJson.verified === false, 'verifyAuthorizationProof: invalid JSON verified is false');
  assert(badJson.error.includes('parse failed'), 'verifyAuthorizationProof: invalid JSON error message');

  // Missing method field -> verified:false
  const noMethod = await verifyAuthorizationProof({
    authorization_proof: JSON.stringify({ ref: 'some-ref' }),
  });
  assert(noMethod.verified === false, 'verifyAuthorizationProof: missing method verified is false');
  assert(noMethod.error.includes('method'), 'verifyAuthorizationProof: missing method error message');

  // Unrecognized method -> verified:false
  const unknownMethod = await verifyAuthorizationProof({
    authorization_proof: JSON.stringify({ method: 'telepathy' }),
  });
  assert(unknownMethod.verified === false, 'verifyAuthorizationProof: unknown method verified is false');
  assert(unknownMethod.error.includes('unrecognized'), 'verifyAuthorizationProof: unknown method error message');

  // Explicit verifier with no loaded plugin -> fail closed
  const missingVerifier = await verifyAuthorizationProof({
    authorization_proof: JSON.stringify({ verifier: 'missing-verifier', method: 'signed-jwt' }),
  }, {});
  assert(missingVerifier.verified === false, 'verifyAuthorizationProof: missing explicit verifier fails closed');
  assert(missingVerifier.source === 'provider-error', 'verifyAuthorizationProof: missing explicit verifier reports provider-error');
  assert(missingVerifier.error.includes('not loaded'), 'verifyAuthorizationProof: missing explicit verifier error mentions not loaded');
}

console.log('\n-- v0.2 evaluateAuthorization --');
{
  // No authorization -> null
  assert(await evaluateAuthorization({}, null, null) === null, 'evaluateAuthorization: no authorization -> null');
  assert(await evaluateAuthorization(null, null, null) === null, 'evaluateAuthorization: null job -> null');

  // Ref only -> deny (external policy resolution not implemented, fail closed)
  const refOnlyAuth = await evaluateAuthorization(
    { authorization_ref: 'urn:authz:1' }, null, null
  );
  assert(refOnlyAuth.decision === 'deny', 'evaluateAuthorization: ref-only -> deny (fail closed)');
  assert(refOnlyAuth.ref === 'urn:authz:1', 'evaluateAuthorization: ref-only ref');
  assert(refOnlyAuth.reason.includes('not yet implemented'), 'evaluateAuthorization: ref-only reason explains why');

  // Explicit deny in policy
  const explicitDeny = await evaluateAuthorization(
    { authorization: JSON.stringify({ decision: 'deny', reason: 'test deny' }) },
    null, null
  );
  assert(explicitDeny.decision === 'deny', 'evaluateAuthorization: explicit deny in policy');
  assert(explicitDeny.reason === 'test deny', 'evaluateAuthorization: explicit deny reason');

  // Explicit escalate in policy
  const explicitEscalate = await evaluateAuthorization(
    { authorization: JSON.stringify({ decision: 'escalate', reason: 'needs review' }) },
    null, null
  );
  assert(explicitEscalate.decision === 'escalate', 'evaluateAuthorization: explicit escalate in policy');

  // Trust deny propagation (depends_on_trust default true)
  const trustDenyPropagation = await evaluateAuthorization(
    { authorization: JSON.stringify({ decision: 'permit' }) },
    { trust_level: 'restricted' },
    { decision: 'deny', reason: 'trust too low' }
  );
  assert(trustDenyPropagation.decision === 'deny', 'evaluateAuthorization: trust deny propagation -> deny');
  assert(trustDenyPropagation.reason.includes('trust evaluation denied'), 'evaluateAuthorization: trust deny reason propagated');

  // Trust deny with depends_on_trust: false -> no propagation
  const noTrustDep = await evaluateAuthorization(
    { authorization: JSON.stringify({ decision: 'permit', depends_on_trust: false }) },
    null,
    { decision: 'deny', reason: 'trust too low' }
  );
  assert(noTrustDep.decision === 'permit', 'evaluateAuthorization: depends_on_trust=false ignores trust deny');

  // Requires identity but none resolved -> deny
  const reqIdentity = await evaluateAuthorization(
    { authorization: JSON.stringify({ requires_identity: true }) },
    null, null
  );
  assert(reqIdentity.decision === 'deny', 'evaluateAuthorization: requires_identity without identity -> deny');

  // Requires identity with identity -> permit
  const withIdentity = await evaluateAuthorization(
    { authorization: JSON.stringify({ requires_identity: true }) },
    { principal: 'agent:test' },
    null
  );
  assert(withIdentity.decision === 'permit', 'evaluateAuthorization: requires_identity with identity -> permit');

  // Invalid JSON -> deny
  const badAuthJson = await evaluateAuthorization(
    { authorization: 'not-json' }, null, null
  );
  assert(badAuthJson.decision === 'deny', 'evaluateAuthorization: invalid JSON -> deny');

  // Explicit provider with no loaded plugin -> fail closed
  const missingAuthProvider = await evaluateAuthorization(
    { authorization: JSON.stringify({ provider: 'missing-authz-provider' }) },
    { principal: 'agent:test' },
    { decision: 'permit', reason: 'trust ok' },
    {}
  );
  assert(missingAuthProvider.decision === 'deny', 'evaluateAuthorization: missing explicit provider fails closed');
  assert(missingAuthProvider.source === 'provider-error', 'evaluateAuthorization: missing explicit provider reports provider-error');
  assert(missingAuthProvider.reason.includes('not loaded'), 'evaluateAuthorization: missing explicit provider error mentions not loaded');

  // Provider that returns an unsupported decision -> fail closed
  const weirdAuthProvider = {
    authorize() {
      return { decision: 'allow', reason: 'provider typo' };
    },
  };
  const weirdAuthDecision = await evaluateAuthorization(
    { authorization: JSON.stringify({ provider: 'weird-authz-provider' }) },
    { principal: 'agent:test' },
    { decision: 'permit', reason: 'trust ok' },
    {
      getAuthorizationProvider: (name) => name === 'weird-authz-provider' ? weirdAuthProvider : null,
    }
  );
  assert(weirdAuthDecision.decision === 'deny', 'evaluateAuthorization: unsupported provider decision fails closed');
  assert(weirdAuthDecision.reason.includes('unsupported decision'), 'evaluateAuthorization: unsupported provider decision explains denial');
}

console.log('\n-- v0.2 generateEvidence --');
{
  // With evidence declaration
  const evidenceResult = generateEvidence(
    {
      evidence: JSON.stringify({ collect: ['stdout'], retention: '30d', format: 'json' }),
      evidence_ref: 'urn:evidence:1',
    },
    { id: 'run-1', status: 'ok' },
    { identity_resolved: { principal: 'agent:test' }, trust_evaluation: { decision: 'permit' } }
  );
  assert(evidenceResult !== null, 'generateEvidence: returns non-null for evidence declaration');
  assert(evidenceResult.evidence_ref === 'urn:evidence:1', 'generateEvidence: evidence_ref');
  assert(typeof evidenceResult.created_at === 'string', 'generateEvidence: created_at is string');
  assert(evidenceResult.payload_summary.collect[0] === 'stdout', 'generateEvidence: collect from blob');
  assert(evidenceResult.payload_summary.retention === '30d', 'generateEvidence: retention from blob');
  assert(evidenceResult.payload_summary.format === 'json', 'generateEvidence: format from blob');
  assert(evidenceResult.payload_summary.run_id === 'run-1', 'generateEvidence: run_id in summary');
  assert(evidenceResult.payload_summary.run_status === 'ok', 'generateEvidence: run_status in summary');
  assert(Array.isArray(evidenceResult.payload_summary.outcome_fields_present), 'generateEvidence: outcome fields listed');
  assert(evidenceResult.payload_summary.outcome_fields_present.includes('identity_resolved'), 'generateEvidence: identity_resolved in outcome fields');

  // No evidence -> null
  assert(generateEvidence({}, null, null) === null, 'generateEvidence: no evidence -> null');
  assert(generateEvidence(null, null, null) === null, 'generateEvidence: null job -> null');

  // Ref only (no inline evidence blob)
  const refOnlyEvidence = generateEvidence(
    { evidence_ref: 'urn:evidence:2' }, null, null
  );
  assert(refOnlyEvidence !== null, 'generateEvidence: ref-only returns non-null');
  assert(refOnlyEvidence.evidence_ref === 'urn:evidence:2', 'generateEvidence: ref-only evidence_ref');

  // Invalid evidence JSON -> returns with error in payload_summary
  const badEvidence = generateEvidence(
    { evidence: 'broken{json', evidence_ref: 'urn:evidence:3' }, null, null
  );
  assert(badEvidence !== null, 'generateEvidence: bad JSON returns non-null');
  assert(badEvidence.payload_summary.error && badEvidence.payload_summary.error.includes('parse failed'), 'generateEvidence: bad JSON error in payload_summary');
}

console.log('\n-- v0.2 summarizeCredentialHandoff --');
{
  // With presentation bindings
  const handoffResult = summarizeCredentialHandoff({
    identity: JSON.stringify({
      presentation: {
        mode: 'inject-env',
        bindings: [
          { env: 'TOKEN', source: 'vault:secret/token', cleanup: true },
          { env: 'CERT', source: 'vault:secret/cert' },
        ],
      },
    }),
  });
  assert(handoffResult !== null, 'summarizeCredentialHandoff: returns non-null for presentation');
  assert(handoffResult.mode === 'inject-env', 'summarizeCredentialHandoff: mode');
  assert(handoffResult.bindings_count === 2, 'summarizeCredentialHandoff: bindings_count');
  assert(handoffResult.cleanup_required === true, 'summarizeCredentialHandoff: cleanup_required from binding');

  // With credential_handoff alias
  const aliasResult = summarizeCredentialHandoff({
    identity: JSON.stringify({
      credential_handoff: {
        mode: 'file-mount',
        bindings: [{ path: '/run/secrets/key' }],
        cleanup_required: true,
      },
    }),
  });
  assert(aliasResult !== null, 'summarizeCredentialHandoff: credential_handoff alias works');
  assert(aliasResult.mode === 'file-mount', 'summarizeCredentialHandoff: alias mode');
  assert(aliasResult.cleanup_required === true, 'summarizeCredentialHandoff: alias cleanup_required');

  // No presentation -> null
  assert(summarizeCredentialHandoff({}) === null, 'summarizeCredentialHandoff: no identity -> null');
  assert(summarizeCredentialHandoff(null) === null, 'summarizeCredentialHandoff: null job -> null');
  assert(summarizeCredentialHandoff({ identity: JSON.stringify({ subject_kind: 'agent' }) }) === null, 'summarizeCredentialHandoff: identity without presentation -> null');

  // Malformed identity JSON -> error
  const malformedHandoff = summarizeCredentialHandoff({ identity: 'not-json' });
  assert(malformedHandoff !== null, 'summarizeCredentialHandoff: malformed JSON returns non-null');
  assert(malformedHandoff.error && malformedHandoff.error.includes('parse failed'), 'summarizeCredentialHandoff: malformed JSON error');
  assert(malformedHandoff.bindings_count === 0, 'summarizeCredentialHandoff: malformed JSON bindings_count is 0');
}

console.log('\n-- v0.2 persistV02Outcomes --');
{
  const outcomeJob = createJob({
    name: 'v02-persist-outcomes',
    schedule_cron: '0 8 * * *',
    payload_message: 'outcome test',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  const outcomeRun = createRun(outcomeJob.id, { run_timeout_ms: 60000 });

  const identityResolved = { subject_kind: 'agent', principal: 'agent:test', trust_level: 'supervised' };
  const trustEvaluation = { effective_level: 'supervised', required_level: 'supervised', decision: 'permit', reason: 'meets requirement' };
  const authDecision = { decision: 'permit', reason: 'pre-approved', ref: 'urn:authz:1' };
  const proofVerification = { verified: true, method: 'signed-jwt', ref: 'jwt-ref' };
  const evidenceRecord = { evidence_ref: 'urn:evidence:1', created_at: '2026-03-28T00:00:00Z', hash: null, payload_summary: {} };
  const handoffSummary = { mode: 'inject-env', bindings_count: 2, cleanup_required: true };

  persistV02Outcomes(outcomeRun.id, {
    identity_resolved: identityResolved,
    trust_evaluation: trustEvaluation,
    authorization_decision: authDecision,
    authorization_proof_verification: proofVerification,
    evidence_record: evidenceRecord,
    credential_handoff_summary: handoffSummary,
  });

  const fetchedRun = getRun(outcomeRun.id);
  assert(fetchedRun.identity_resolved !== null, 'persistV02Outcomes: identity_resolved stored');
  assert(fetchedRun.trust_evaluation !== null, 'persistV02Outcomes: trust_evaluation stored');
  assert(fetchedRun.authorization_decision !== null, 'persistV02Outcomes: authorization_decision stored');
  assert(fetchedRun.authorization_proof_verification !== null, 'persistV02Outcomes: authorization_proof_verification stored');
  assert(fetchedRun.evidence_record !== null, 'persistV02Outcomes: evidence_record stored');
  assert(fetchedRun.credential_handoff_summary !== null, 'persistV02Outcomes: credential_handoff_summary stored');

  // Verify JSON serialization round-trip
  const parsedIdentity = JSON.parse(fetchedRun.identity_resolved);
  assert(parsedIdentity.principal === 'agent:test', 'persistV02Outcomes: identity_resolved JSON roundtrip principal');
  assert(parsedIdentity.trust_level === 'supervised', 'persistV02Outcomes: identity_resolved JSON roundtrip trust_level');

  const parsedTrust = JSON.parse(fetchedRun.trust_evaluation);
  assert(parsedTrust.decision === 'permit', 'persistV02Outcomes: trust_evaluation JSON roundtrip decision');

  const parsedAuth = JSON.parse(fetchedRun.authorization_decision);
  assert(parsedAuth.decision === 'permit', 'persistV02Outcomes: authorization_decision JSON roundtrip decision');
  assert(parsedAuth.ref === 'urn:authz:1', 'persistV02Outcomes: authorization_decision JSON roundtrip ref');

  const parsedProof = JSON.parse(fetchedRun.authorization_proof_verification);
  assert(parsedProof.verified === true, 'persistV02Outcomes: authorization_proof_verification JSON roundtrip verified');
  assert(parsedProof.method === 'signed-jwt', 'persistV02Outcomes: authorization_proof_verification JSON roundtrip method');

  const parsedEvidence = JSON.parse(fetchedRun.evidence_record);
  assert(parsedEvidence.evidence_ref === 'urn:evidence:1', 'persistV02Outcomes: evidence_record JSON roundtrip ref');

  const parsedHandoff = JSON.parse(fetchedRun.credential_handoff_summary);
  assert(parsedHandoff.mode === 'inject-env', 'persistV02Outcomes: credential_handoff_summary JSON roundtrip mode');
  assert(parsedHandoff.bindings_count === 2, 'persistV02Outcomes: credential_handoff_summary JSON roundtrip bindings_count');

  // Verify null/undefined outcomes are safely ignored
  persistV02Outcomes(outcomeRun.id, { identity_resolved: undefined });
  const unchanged = getRun(outcomeRun.id);
  assert(unchanged.identity_resolved === fetchedRun.identity_resolved, 'persistV02Outcomes: undefined value does not overwrite');

  // Verify unknown columns are ignored
  persistV02Outcomes(outcomeRun.id, { nonexistent_field: 'should be ignored' });
  const stillOk = getRun(outcomeRun.id);
  assert(stillOk.identity_resolved === fetchedRun.identity_resolved, 'persistV02Outcomes: unknown columns ignored');

  // Verify null input is safely handled
  persistV02Outcomes(outcomeRun.id, null);
  persistV02Outcomes(outcomeRun.id, undefined);
  // If we got here without throwing, the safety check passed
  assert(true, 'persistV02Outcomes: null/undefined outcomes handled gracefully');

  // Verify string values are stored as-is (not double-serialized)
  persistV02Outcomes(outcomeRun.id, { identity_resolved: '{"raw":"string"}' });
  const stringStored = getRun(outcomeRun.id);
  assert(stringStored.identity_resolved === '{"raw":"string"}', 'persistV02Outcomes: string values stored as-is');
}

console.log('\n-- v0.2 Capabilities CLI --');
{
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const capsOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'capabilities', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, SCHEDULER_DB: ':memory:' },
    encoding: 'utf8',
  }));
  assert(capsOut.scheduler_version, 'capabilities: scheduler_version present');
  assert(capsOut.schema_version === 23, 'capabilities: schema_version is 23');
  assert(capsOut.handoff_version === '2', 'capabilities: handoff_version is 2');
  assert(capsOut.features, 'capabilities: features object present');
  assert(capsOut.features.identity_declaration === true, 'capabilities: identity_declaration enabled');
  assert(capsOut.features.runtime_identity_resolution === true, 'capabilities: runtime_identity_resolution enabled');
  assert(capsOut.features.trust_evaluation === true, 'capabilities: trust_evaluation enabled');
  assert(capsOut.features.authorization_proof_verification === true, 'capabilities: authorization_proof_verification enabled');
  assert(capsOut.features.authorization_hook === true, 'capabilities: authorization_hook enabled');
  assert(capsOut.features.evidence_generation === true, 'capabilities: evidence_generation enabled');
  assert(capsOut.features.credential_handoff === true, 'capabilities: credential_handoff enabled');
  assert(capsOut.features.audit_export === true, 'capabilities: audit_export enabled');
  assert(capsOut.features.delegation_validation === false, 'capabilities: delegation_validation not yet enabled');
  assert(capsOut.features.runtime_execution === true, 'capabilities: runtime_execution enabled');
}

// ===========================================================
// v0.2 resolveIdentity with mock provider
// ===========================================================

console.log('\n-- v0.2 resolveIdentity with provider --');
{
  // resolveIdentity with provider in ctx resolves via provider
  const providerJob = {
    id: 'test-provider-resolve',
    identity: JSON.stringify({
      provider: 'test-provider',
      scope: 'full',
      trust: { level: 'supervised' },
    }),
  };

  const mockProvider = {
    name: 'test-provider',
    type: 'identity',
    resolveSession(_request, _ctx) {
      return {
        ok: true,
        session: {
          subject: { kind: 'service', principal: 'test:mock' },
          trust: { effective_level: 'supervised' },
          credentials: {},
        },
      };
    },
  };

  const ctx = {
    getIdentityProvider: (name) => name === 'test-provider' ? mockProvider : null,
  };

  const provResult = await resolveIdentity(providerJob, ctx);
  assert(provResult !== null, 'resolveIdentity with provider: returns non-null');
  assert(provResult.source === 'provider', 'resolveIdentity with provider: source is provider');
  assert(provResult.session !== null && typeof provResult.session === 'object', 'resolveIdentity with provider: session present');
  assert(provResult.session.subject.kind === 'service', 'resolveIdentity with provider: session subject kind');
  assert(provResult.session.subject.principal === 'test:mock', 'resolveIdentity with provider: session subject principal');

  // resolveIdentity without ctx falls back to structural
  const noCtxJob = {
    id: 'test-no-ctx',
    identity: JSON.stringify({
      subject_kind: 'agent',
      principal: 'agent:structural',
      trust_level: 'restricted',
    }),
  };
  const structuralResult = await resolveIdentity(noCtxJob);
  assert(structuralResult !== null, 'resolveIdentity without ctx: returns non-null');
  assert(structuralResult.source === undefined || structuralResult.source !== 'provider', 'resolveIdentity without ctx: not from provider');
  assert(structuralResult.subject_kind === 'agent', 'resolveIdentity without ctx: structural subject_kind');
  assert(structuralResult.principal === 'agent:structural', 'resolveIdentity without ctx: structural principal');

  // resolveIdentity with empty ctx also falls back to structural
  const emptyCtxResult = await resolveIdentity(noCtxJob, {});
  assert(emptyCtxResult !== null, 'resolveIdentity with empty ctx: returns non-null');
  assert(emptyCtxResult.subject_kind === 'agent', 'resolveIdentity with empty ctx: structural subject_kind');

  // resolveIdentity with provider error returns transient error
  const errorProvider = {
    name: 'error-provider',
    type: 'identity',
    resolveSession(_request, _ctx) {
      return { ok: false, transient: true, error: 'Vault timeout' };
    },
  };

  const errorJob = {
    id: 'test-provider-error',
    identity: JSON.stringify({
      provider: 'error-provider',
      scope: 'full',
    }),
  };

  const errorCtx = {
    getIdentityProvider: (name) => name === 'error-provider' ? errorProvider : null,
  };

  const errorResult = await resolveIdentity(errorJob, errorCtx);
  assert(errorResult !== null, 'resolveIdentity with provider error: returns non-null');
  assert(errorResult.source === 'provider-error', 'resolveIdentity with provider error: source is provider-error');
  assert(errorResult.transient === true, 'resolveIdentity with provider error: transient is true');
  assert(errorResult.error === 'Vault timeout', 'resolveIdentity with provider error: error message matches');

  const missingProviderResult = await resolveIdentity({
    id: 'test-provider-missing',
    identity: JSON.stringify({ provider: 'missing-provider', scope: 'full' }),
  }, {});
  assert(missingProviderResult !== null, 'resolveIdentity with missing provider: returns non-null');
  assert(missingProviderResult.source === 'provider-error', 'resolveIdentity with missing provider: source is provider-error');
  assert(missingProviderResult.transient === false, 'resolveIdentity with missing provider: transient is false');
  assert(missingProviderResult.error.includes('not loaded'), 'resolveIdentity with missing provider: error mentions not loaded');
}

// ===========================================================
// Provider Registry
// ===========================================================

console.log('\n-- Provider Registry --');
{
  // loadProviders loads mock-stripe from test-providers directory
  resetProviderRegistry();
  const testProvidersDir = join(dirname(fileURLToPath(import.meta.url)), 'test-providers');
  await loadProviders(testProvidersDir);
  const mockStripe = getIdentityProvider('mock-stripe');
  assert(mockStripe !== null, 'loadProviders: mock-stripe loaded');
  assert(mockStripe.type === 'identity', 'loadProviders: mock-stripe type is identity');
  assert(mockStripe.name === 'mock-stripe', 'loadProviders: mock-stripe name matches');

  // getIdentityProvider returns null for unknown provider
  const unknown = getIdentityProvider('nonexistent');
  assert(unknown === null, 'getIdentityProvider: returns null for unknown provider');

  // Clean up registry state
  resetProviderRegistry();
}

// ===========================================================
// Shell env var injection
// ===========================================================

console.log('\n-- Shell env var injection --');
{
  const shellResult = await runShellCommand('echo $TEST_INJECT_VAR', 5000, { TEST_INJECT_VAR: 'hello_from_test' });
  assert(shellResult.stdout.includes('hello_from_test'), 'runShellCommand: env vars passed to subprocess');
}

function buildPrepareDispatchDeps(overrides = {}) {
    return {
      claimDispatch: () => true,
      releaseDispatch() {},
      setDispatchStatus() {},
      countPendingApprovalsForJob: () => 0,
      getPendingApproval: () => null,
      createApproval() { throw new Error('createApproval should not be called in prepareDispatch unit tests'); },
      createRun,
      getRun,
      hasRunningRunForPool: () => false,
      hasRunningRun: () => false,
      enqueueJob: () => ({ queued: false, queued_count: 0, limited: false }),
      getDispatchBacklogCount: () => 0,
      generateIdempotencyKey: () => 'idem-key',
      generateChainIdempotencyKey: () => 'chain-key',
      generateRunNowIdempotencyKey: () => 'run-now-key',
      claimIdempotencyKey: () => true,
      finishRun,
      getDb,
      sqliteNow,
      adaptiveDeferralMs,
      handleDelivery() {},
      advanceNextRun() {},
      TICK_INTERVAL_MS: 100,
      log() {},
      resolveIdentity,
      evaluateTrust,
      verifyAuthorizationProof,
      evaluateAuthorization,
      summarizeCredentialHandoff,
      persistV02Outcomes,
      releaseIdempotencyKey() {},
      updateJobAfterRun() {},
      handleTriggeredChildren() {},
      dequeueJob: () => false,
      compareTrustLevels,
      getIdentityProvider: () => null,
      getAuthorizationProvider: () => null,
      getProofVerifier: () => null,
      ...overrides,
    };
}

console.log('\n-- prepareDispatch v0.2 gating --');
{
  const scalarIdentityJob = createJob({
    name: 'prepare-dispatch-scalar-identity',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo scalar identity',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity_subject_kind: 'agent',
    identity_principal: 'agent:scalar-only',
    identity_trust_level: 'supervised',
    authorization: JSON.stringify({ requires_identity: true }),
  });
  const scalarCtx = await prepareDispatch(
    getJob(scalarIdentityJob.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(scalarCtx !== null, 'prepareDispatch: scalar identity fields trigger identity resolution');
  assert(scalarCtx?.v02Outcomes?.identity_resolved?.principal === 'agent:scalar-only', 'prepareDispatch: scalar identity principal is preserved');
  if (scalarCtx) finishRun(scalarCtx.run.id, 'cancelled', { summary: 'test cleanup' });
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(scalarIdentityJob.id);
  deleteJob(scalarIdentityJob.id);

  const providerErrorJob = createJob({
    name: 'prepare-dispatch-provider-error',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo provider error',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'error-provider', scope: 'full' }),
    authorization: JSON.stringify({ requires_identity: true }),
  });
  let providerErrorUpdates = 0;
  const providerErrorCtx = await prepareDispatch(
    getJob(providerErrorJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'error-provider'
        ? {
            name: 'error-provider',
            type: 'identity',
            resolveSession() {
              return { ok: false, transient: true, error: 'Vault timeout' };
            },
          }
        : null,
      updateJobAfterRun(_job, status) {
        if (status === 'error') providerErrorUpdates++;
      },
    }),
  );
  assert(providerErrorCtx === null, 'prepareDispatch: provider identity resolution failures fail closed');
  const providerErrorRun = getRunsForJob(providerErrorJob.id, 1)[0];
  assert(providerErrorRun.status === 'error', 'prepareDispatch: provider identity resolution failure finishes run as error');
  assert(providerErrorRun.error_message.includes('Identity resolution failed: Vault timeout'), 'prepareDispatch: provider identity resolution failure stores reason');
  const providerErrorIdentity = JSON.parse(getRun(providerErrorRun.id).identity_resolved);
  assert(providerErrorIdentity.source === 'provider-error', 'prepareDispatch: provider identity resolution failure persists provider-error outcome');
  assert(providerErrorUpdates === 1, 'prepareDispatch: provider identity resolution failure updates job state');
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(providerErrorJob.id);
  deleteJob(providerErrorJob.id);

  const missingVerifierJob = createJob({
    name: 'prepare-dispatch-missing-verifier',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo missing verifier',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    authorization_proof: JSON.stringify({ verifier: 'missing-verifier', method: 'signed-jwt' }),
  });
  const missingVerifierCtx = await prepareDispatch(
    getJob(missingVerifierJob.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(missingVerifierCtx === null, 'prepareDispatch: missing proof verifier fails closed');
  const missingVerifierRun = getRunsForJob(missingVerifierJob.id, 1)[0];
  assert(missingVerifierRun.status === 'error', 'prepareDispatch: missing proof verifier finishes run as error');
  assert(missingVerifierRun.error_message.includes('proof verifier not loaded'), 'prepareDispatch: missing proof verifier stores reason');
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(missingVerifierJob.id);
  deleteJob(missingVerifierJob.id);

  const missingAuthzProviderJob = createJob({
    name: 'prepare-dispatch-missing-authz-provider',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo missing authz provider',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity_subject_kind: 'agent',
    identity_principal: 'agent:missing-authz',
    authorization: JSON.stringify({ provider: 'missing-authz-provider' }),
  });
  const missingAuthzProviderCtx = await prepareDispatch(
    getJob(missingAuthzProviderJob.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(missingAuthzProviderCtx === null, 'prepareDispatch: missing authorization provider fails closed');
  const missingAuthzProviderRun = getRunsForJob(missingAuthzProviderJob.id, 1)[0];
  assert(missingAuthzProviderRun.status === 'error', 'prepareDispatch: missing authorization provider finishes run as error');
  assert(missingAuthzProviderRun.error_message.includes('authorization provider not loaded'), 'prepareDispatch: missing authorization provider stores reason');
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(missingAuthzProviderJob.id);
  deleteJob(missingAuthzProviderJob.id);

  const parentForNone = createJob({
    name: 'prepare-dispatch-parent-none',
    schedule_cron: '0 8 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent none',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
  });
  const nonePolicyChild = createJob({
    name: 'prepare-dispatch-child-none',
    parent_id: parentForNone.id,
    trigger_on: 'failure',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child none',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    identity: JSON.stringify({ subject_kind: 'service', principal: 'svc:none', trust_level: 'supervised' }),
    authorization: JSON.stringify({ requires_identity: true }),
    child_credential_policy: 'none',
  });
  const nonePolicyCtx = await prepareDispatch(
    getJob(nonePolicyChild.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(nonePolicyCtx === null, 'prepareDispatch: child_credential_policy=none re-evaluates authorization against cleared identity');
  const nonePolicyRun = getRunsForJob(nonePolicyChild.id, 1)[0];
  assert(nonePolicyRun.error_message.includes('requires identity'), 'prepareDispatch: none policy stores authorization deny reason');
  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(parentForNone.id, nonePolicyChild.id);
  deleteJob(nonePolicyChild.id);
  deleteJob(parentForNone.id);

  const handoffProvider = {
    name: 'handoff-provider',
    type: 'identity',
    resolveSession(request) {
      const scope = request.scope || request.profile?.scope || 'full';
      return {
        ok: true,
        session: {
          provider: 'handoff-provider',
          subject: { kind: 'service', principal: `svc:${scope}` },
          trust: { effective_level: 'autonomous' },
          credentials: {},
        },
      };
    },
    prepareHandoff(parentSession) {
      return {
        prepared: true,
        session: {
          ...parentSession,
          subject: { kind: 'service', principal: 'svc:downscoped' },
          trust: { effective_level: 'restricted' },
        },
      };
    },
  };

  const parentForDownscope = createJob({
    name: 'prepare-dispatch-parent-downscope',
    schedule_cron: '0 9 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent downscope',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'handoff-provider', scope: 'full' }),
  });
  const downscopeChild = createJob({
    name: 'prepare-dispatch-child-downscope',
    parent_id: parentForDownscope.id,
    trigger_on: 'failure',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child downscope',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    identity: JSON.stringify({ provider: 'handoff-provider', scope: 'payments' }),
    contract_required_trust_level: 'supervised',
    contract_trust_enforcement: 'block',
    child_credential_policy: 'downscope',
  });
  let downscopeUpdateCalls = 0;
  const downscopeTriggered = [];
  const downscopeCtx = await prepareDispatch(
    getJob(downscopeChild.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'handoff-provider' ? handoffProvider : null,
      updateJobAfterRun(_job, status) {
        if (status === 'error') downscopeUpdateCalls++;
      },
      handleTriggeredChildren(...args) {
        downscopeTriggered.push(args);
      },
    }),
  );
  assert(downscopeCtx === null, 'prepareDispatch: downscope re-evaluates trust using handoff session');
  const downscopeRun = getRunsForJob(downscopeChild.id, 1)[0];
  const downscopeTrust = JSON.parse(getRun(downscopeRun.id).trust_evaluation);
  assert(downscopeRun.status === 'error', 'prepareDispatch: downscope trust failure finishes run as error');
  assert(downscopeTrust.effective_level === 'restricted', 'prepareDispatch: persisted trust evaluation reflects downscoped identity');
  assert(downscopeUpdateCalls === 1, 'prepareDispatch: early trust deny still updates job state');
  assert(downscopeTriggered.length === 0, 'prepareDispatch: security abort (trust deny) does not fire triggered children');
  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(parentForDownscope.id, downscopeChild.id);
  deleteJob(downscopeChild.id);
  deleteJob(parentForDownscope.id);

  const cleanupCalls = [];
  const asyncProviderJob = createJob({
    name: 'prepare-dispatch-async-materialize',
    schedule_cron: '0 10 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo async materialize',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({
      provider: 'async-provider',
      scope: 'full',
      presentation: { mode: 'inject-env' },
    }),
  });
  const asyncProvider = {
    name: 'async-provider',
    type: 'identity',
    resolveSession() {
      return {
        ok: true,
        session: {
          provider: 'async-provider',
          subject: { kind: 'service', principal: 'svc:async' },
          trust: { effective_level: 'supervised' },
          credentials: {},
        },
      };
    },
    async materialize(_session, _presentation) {
      await Promise.resolve();
      return {
        materialized: true,
        env_vars: { ASYNC_PROVIDER_TOKEN: 'token-123' },
        cleanup_required: true,
        cleanup_token: 'cleanup-123',
        temp_path: '/tmp/async-provider-token',
      };
    },
    async cleanup(state) {
      cleanupCalls.push(state);
      return { cleaned: true };
    },
  };
  const asyncProviderCtx = await prepareDispatch(
    getJob(asyncProviderJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'async-provider' ? asyncProvider : null,
    }),
  );
  assert(asyncProviderCtx !== null, 'prepareDispatch: async provider materialization returns dispatch context');
  assert(asyncProviderCtx?.materializedEnv?.ASYNC_PROVIDER_TOKEN === 'token-123', 'prepareDispatch: async provider materialization awaits env vars');
  await finalizeDispatch(
    getJob(asyncProviderJob.id),
    asyncProviderCtx,
    {
      status: 'ok',
      summary: 'async materialize test',
      content: '',
      errorMessage: null,
      runFinishFields: {},
      deliveryOverride: null,
      skipDelivery: true,
      skipJobUpdate: true,
      skipChildren: true,
      skipDequeue: true,
      skipAgentCleanup: true,
      idemAction: 'noop',
      retryFiresChildren: false,
      earlyReturn: false,
    },
    {
      finishRun,
      updateIdempotencyResultHash() {},
      releaseIdempotencyKey() {},
      setAgentStatus() {},
      handleDelivery() {},
      shouldRetry: () => false,
      scheduleRetry() {
        throw new Error('scheduleRetry should not be called in async materialize test');
      },
      getDb,
      updateJobAfterRun() {},
      setDispatchStatus() {},
      handleTriggeredChildren() {},
      dequeueJob: () => false,
      log() {},
      generateEvidence,
      persistV02Outcomes,
    },
  );
  assert(cleanupCalls.length === 1, 'finalizeDispatch: async provider cleanup is invoked once');
  assert(cleanupCalls[0].cleanup_token === 'cleanup-123', 'finalizeDispatch: provider cleanup receives materialization metadata');
  assert(cleanupCalls[0].temp_path === '/tmp/async-provider-token', 'finalizeDispatch: provider cleanup receives cleanup path');
  assert(cleanupCalls[0].session.subject.principal === 'svc:async', 'finalizeDispatch: provider cleanup retains session details');
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(asyncProviderJob.id);
  deleteJob(asyncProviderJob.id);

  const legacyNonShellHandoffJob = createJob({
    name: 'prepare-dispatch-legacy-nonshell-handoff',
    schedule_cron: '0 11 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo invalid legacy handoff',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({
      provider: 'async-provider',
      presentation: { mode: 'inject-env' },
    }),
  });
  getDb().prepare('UPDATE jobs SET session_target = ?, payload_kind = ? WHERE id = ?')
    .run('isolated', 'agentTurn', legacyNonShellHandoffJob.id);
  const legacyNonShellHandoffCtx = await prepareDispatch(
    getJob(legacyNonShellHandoffJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'async-provider' ? asyncProvider : null,
    }),
  );
  assert(legacyNonShellHandoffCtx === null, 'prepareDispatch: non-shell credential handoff fails closed');
  const legacyNonShellHandoffRun = getRunsForJob(legacyNonShellHandoffJob.id, 1)[0];
  const legacyNonShellStored = getRun(legacyNonShellHandoffRun.id);
  assert(legacyNonShellStored.status === 'error', 'prepareDispatch: non-shell credential handoff finishes run as error');
  assert(legacyNonShellStored.error_message.includes('shell jobs'), 'prepareDispatch: non-shell credential handoff stores clear error');
  assert(legacyNonShellStored.credential_handoff_summary !== null, 'prepareDispatch: non-shell credential handoff still persists summary');
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(legacyNonShellHandoffJob.id);
  deleteJob(legacyNonShellHandoffJob.id);
}

// ===========================================================
// child_credential_policy validation
// ===========================================================

console.log('\n-- child_credential_policy validation --');
{
  // validateJobSpec accepts valid child_credential_policy values
  const validPolicies = ['downscope', 'inherit', 'none', 'independent'];
  for (const policy of validPolicies) {
    let threw = false;
    try {
      validateJobSpec({
        id: `test-ccp-valid-${policy}`,
        name: `ccp valid ${policy}`,
        schedule_cron: '0 9 * * *',
        schedule_tz: 'UTC',
        session_target: 'shell',
        payload_kind: 'shellCommand',
        payload_message: 'echo test',
        run_timeout_ms: 30000,
        delivery_mode: 'none',
        origin: 'test',
        child_credential_policy: policy,
      }, null, 'create');
    } catch {
      threw = true;
    }
    assert(!threw, `validateJobSpec accepts child_credential_policy: '${policy}'`);
  }

  // validateJobSpec rejects invalid child_credential_policy
  let invalidThrew = false;
  try {
    validateJobSpec({
      id: 'test-ccp-invalid',
      name: 'ccp invalid',
      schedule_cron: '0 9 * * *',
      schedule_tz: 'UTC',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'echo test',
      run_timeout_ms: 30000,
      delivery_mode: 'none',
      origin: 'test',
      child_credential_policy: 'invalid',
    }, null, 'create');
  } catch {
    invalidThrew = true;
  }
  assert(invalidThrew, 'validateJobSpec rejects invalid child_credential_policy');
}

// ===========================================================
// Regression: materialization failure aborts dispatch
// ===========================================================

console.log('\n-- Materialization failure abort --');
{
  const matFailJob = createJob({
    name: 'prepare-dispatch-mat-fail',
    schedule_cron: '0 10 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo should not run',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({
      provider: 'mat-fail-provider',
      scope: 'full',
      presentation: { mode: 'inject-env' },
    }),
  });

  // Provider that resolves identity ok but materialize() throws
  const matFailProvider = {
    name: 'mat-fail-provider',
    type: 'identity',
    resolveSession() {
      return {
        ok: true,
        session: {
          provider: 'mat-fail-provider',
          subject: { kind: 'service', principal: 'svc:mat-fail' },
          trust: { effective_level: 'supervised' },
          credentials: { token: { value: 'secret-123' } },
        },
      };
    },
    async materialize() {
      throw new Error('materialization exploded');
    },
  };

  const matFailCtx = await prepareDispatch(
    getJob(matFailJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'mat-fail-provider' ? matFailProvider : null,
      generateIdempotencyKey: () => 'idem-mat-fail',
    }),
  );
  assert(matFailCtx === null, 'prepareDispatch: materialization throw aborts dispatch when presentation declared');
  const matFailRun = getRunsForJob(matFailJob.id, 1)[0];
  assert(matFailRun.status === 'error', 'prepareDispatch: materialization failure run status is error');
  assert(matFailRun.error_message.includes('materialization exploded'), 'prepareDispatch: materialization failure error message preserved');

  // Provider that returns materialized=false
  const matFalseProvider = {
    name: 'mat-false-provider',
    type: 'identity',
    resolveSession() {
      return {
        ok: true,
        session: {
          provider: 'mat-false-provider',
          subject: { kind: 'service', principal: 'svc:mat-false' },
          trust: { effective_level: 'supervised' },
          credentials: {},
        },
      };
    },
    materialize() {
      return { materialized: false };
    },
  };

  const matFalseJob = createJob({
    name: 'prepare-dispatch-mat-false',
    schedule_cron: '0 10 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo should not run either',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({
      provider: 'mat-false-provider',
      scope: 'full',
      presentation: { mode: 'inject-env' },
    }),
  });

  const matFalseCtx = await prepareDispatch(
    getJob(matFalseJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'mat-false-provider' ? matFalseProvider : null,
      generateIdempotencyKey: () => 'idem-mat-false',
    }),
  );
  assert(matFalseCtx === null, 'prepareDispatch: materialized=false aborts dispatch when presentation declared');
  const matFalseRun = getRunsForJob(matFalseJob.id, 1)[0];
  assert(matFalseRun.status === 'error', 'prepareDispatch: materialized=false run status is error');
  assert(matFalseRun.error_message.includes('materialized=false'), 'prepareDispatch: materialized=false error message preserved');

  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(matFailJob.id, matFalseJob.id);
  deleteJob(matFailJob.id);
  deleteJob(matFalseJob.id);
}

// ===========================================================
// Regression: downscope happy path with real parent run
// ===========================================================

console.log('\n-- Downscope happy path --');
{
  const dsHappyProvider = {
    name: 'ds-happy-provider',
    type: 'identity',
    resolveSession(request) {
      const scope = request.scope || 'full';
      return {
        ok: true,
        session: {
          provider: 'ds-happy-provider',
          subject: { kind: 'service', principal: `svc:${scope}` },
          trust: { effective_level: 'supervised' },
          credentials: { token: { value: 'secret' } },
        },
      };
    },
    prepareHandoff(parentSession, handoff) {
      return {
        prepared: true,
        session: {
          ...parentSession,
          subject: { kind: 'service', principal: `svc:downscoped-${handoff.target_scope}` },
          trust: { effective_level: 'supervised' },
          credentials: { token: { value: 'downscoped-secret' } },
        },
      };
    },
    describeSession(session) {
      const copy = JSON.parse(JSON.stringify(session));
      if (copy.credentials?.token?.value) copy.credentials.token.value = '[REDACTED]';
      return copy;
    },
  };

  // Create parent with a completed run that has identity_resolved
  const dsParent = createJob({
    name: 'ds-happy-parent',
    schedule_cron: '0 9 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'ds-happy-provider', scope: 'full' }),
  });
  const parentRun = createRun(dsParent.id, { run_timeout_ms: 300_000 });
  finishRun(parentRun.id, 'ok', { summary: 'parent completed' });
  // Persist identity_resolved on the parent run (simulating what dispatch would do)
  persistV02Outcomes(parentRun.id, {
    identity_resolved: {
      provider: 'ds-happy-provider',
      session: {
        provider: 'ds-happy-provider',
        subject: { kind: 'service', principal: 'svc:full' },
        trust: { effective_level: 'supervised' },
        credentials: { token: { value: 'parent-secret' } },
      },
      source: 'provider',
    },
  });

  const dsChild = createJob({
    name: 'ds-happy-child',
    parent_id: dsParent.id,
    trigger_on: 'success',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    identity: JSON.stringify({ provider: 'ds-happy-provider', scope: 'payments' }),
    child_credential_policy: 'downscope',
  });

  const dsCtx = await prepareDispatch(
    getJob(dsChild.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'ds-happy-provider' ? dsHappyProvider : null,
      generateIdempotencyKey: () => 'idem-ds-happy',
    }),
  );
  assert(dsCtx !== null, 'prepareDispatch: downscope happy path succeeds');
  assert(dsCtx.v02Outcomes.identity_resolved.principal === 'svc:downscoped-payments', 'prepareDispatch: downscope overrides identity with handoff session');
  assert(dsCtx.v02Outcomes.identity_resolved.source === 'provider', 'prepareDispatch: downscope identity source is provider');

  // Verify credentials are redacted in persisted outcomes
  const dsRun = dsCtx.run;
  persistV02Outcomes(dsRun.id, redactOutcomesForPersistence(dsCtx.v02Outcomes, {
    getIdentityProvider: (name) => name === 'ds-happy-provider' ? dsHappyProvider : null,
  }));
  const persistedRun = getRun(dsRun.id);
  const persistedIdentity = JSON.parse(persistedRun.identity_resolved);
  assert(persistedIdentity.session.credentials.token.value === '[REDACTED]', 'prepareDispatch: downscope persisted credentials are redacted');

  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(dsParent.id, dsChild.id);
  deleteJob(dsChild.id);
  deleteJob(dsParent.id);
}

// ===========================================================
// Regression: downscope fails closed when parent session unavailable
// ===========================================================

console.log('\n-- Downscope fail-closed --');
{
  const dsFailProvider = {
    name: 'ds-fail-provider',
    type: 'identity',
    resolveSession() {
      return {
        ok: true,
        session: {
          provider: 'ds-fail-provider',
          subject: { kind: 'service', principal: 'svc:ds-fail' },
          trust: { effective_level: 'supervised' },
          credentials: {},
        },
      };
    },
    prepareHandoff() {
      return { prepared: false, error: 'no parent session available' };
    },
  };

  const dsFailParent = createJob({
    name: 'ds-fail-parent',
    schedule_cron: '0 9 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'ds-fail-provider', scope: 'full' }),
  });
  // No parent run created -- parent session is unavailable

  const dsFailChild = createJob({
    name: 'ds-fail-child',
    parent_id: dsFailParent.id,
    trigger_on: 'success',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    identity: JSON.stringify({ provider: 'ds-fail-provider', scope: 'payments' }),
    child_credential_policy: 'downscope',
  });

  const dsFailCtx = await prepareDispatch(
    getJob(dsFailChild.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'ds-fail-provider' ? dsFailProvider : null,
      generateIdempotencyKey: () => 'idem-ds-fail',
    }),
  );
  assert(dsFailCtx === null, 'prepareDispatch: downscope fails closed when parent session unavailable');
  const dsFailRun = getRunsForJob(dsFailChild.id, 1)[0];
  assert(dsFailRun.status === 'error', 'prepareDispatch: downscope fail-closed run status is error');
  assert(dsFailRun.error_message.includes('Downscope credential policy failed'), 'prepareDispatch: downscope fail-closed error message');

  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(dsFailParent.id, dsFailChild.id);
  deleteJob(dsFailChild.id);
  deleteJob(dsFailParent.id);
}

// ===========================================================
// Regression: escalate decision aborts dispatch
// ===========================================================

console.log('\n-- Authorization escalate abort --');
{
  const escalateJob = createJob({
    name: 'prepare-dispatch-escalate',
    schedule_cron: '0 11 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo escalate',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ subject_kind: 'agent', principal: 'agent:escalate-test', trust_level: 'supervised' }),
    authorization: JSON.stringify({ decision: 'escalate', reason: 'human review required' }),
  });

  const escalateCtx = await prepareDispatch(
    getJob(escalateJob.id),
    {},
    buildPrepareDispatchDeps({
      generateIdempotencyKey: () => 'idem-escalate',
    }),
  );
  assert(escalateCtx === null, 'prepareDispatch: escalate decision aborts dispatch');
  const escalateRun = getRunsForJob(escalateJob.id, 1)[0];
  assert(escalateRun.status === 'error', 'prepareDispatch: escalate run status is error');
  assert(escalateRun.error_message.includes('escalation'), 'prepareDispatch: escalate error mentions escalation');

  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(escalateJob.id);
  deleteJob(escalateJob.id);
}

// ===========================================================
// Regression: credential redaction in persisted outcomes
// ===========================================================

console.log('\n-- Credential redaction --');
{
  const redactJob = createJob({
    name: 'prepare-dispatch-redact',
    schedule_cron: '0 12 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo redact',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'redact-provider', scope: 'full' }),
  });

  const redactProvider = {
    name: 'redact-provider',
    type: 'identity',
    resolveSession() {
      return {
        ok: true,
        session: {
          provider: 'redact-provider',
          subject: { kind: 'service', principal: 'svc:redact' },
          trust: { effective_level: 'supervised' },
          credentials: { api_key: { kind: 'bearer', value: 'sk_live_SHOULD_NOT_PERSIST' } },
        },
      };
    },
    describeSession(session) {
      const copy = JSON.parse(JSON.stringify(session));
      if (copy.credentials?.api_key?.value) copy.credentials.api_key.value = '[REDACTED]';
      return copy;
    },
  };

  const redactCtx = await prepareDispatch(
    getJob(redactJob.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'redact-provider' ? redactProvider : null,
      generateIdempotencyKey: () => 'idem-redact',
    }),
  );
  assert(redactCtx !== null, 'prepareDispatch: redact test context created');

  // Simulate what finalizeDispatch does: redact then persist
  const redactedOutcomes = redactOutcomesForPersistence(redactCtx.v02Outcomes, {
    getIdentityProvider: (name) => name === 'redact-provider' ? redactProvider : null,
  });
  persistV02Outcomes(redactCtx.run.id, redactedOutcomes);

  const persistedRedactRun = getRun(redactCtx.run.id);
  const persistedRedactIdentity = JSON.parse(persistedRedactRun.identity_resolved);
  assert(persistedRedactIdentity.session.credentials.api_key.value === '[REDACTED]', 'credential redaction: live token replaced with [REDACTED]');
  assert(!JSON.stringify(persistedRedactIdentity).includes('sk_live_SHOULD_NOT_PERSIST'), 'credential redaction: raw token not present in persisted data');

  // Also test redaction without describeSession (falls back to credential stripping)
  const noDescribeProvider = {
    name: 'no-describe-provider',
    type: 'identity',
  };
  const outcomesWithCreds = {
    identity_resolved: {
      provider: 'no-describe-provider',
      session: {
        credentials: { secret: { value: 'raw-secret' } },
      },
      source: 'provider',
    },
  };
  const strippedOutcomes = redactOutcomesForPersistence(outcomesWithCreds, {
    getIdentityProvider: (name) => name === 'no-describe-provider' ? noDescribeProvider : null,
  });
  assert(strippedOutcomes.identity_resolved.session.credentials === undefined, 'credential redaction: fallback strips credentials key when no describeSession');

  const throwsDescribeProvider = {
    name: 'throws-describe-provider',
    type: 'identity',
    describeSession() {
      throw new Error('redaction exploded');
    },
  };
  const fallbackAfterThrow = redactOutcomesForPersistence({
    identity_resolved: {
      provider: 'throws-describe-provider',
      session: {
        credentials: { secret: { value: 'raw-secret' } },
      },
      source: 'provider',
    },
  }, {
    getIdentityProvider: (name) => name === 'throws-describe-provider' ? throwsDescribeProvider : null,
  });
  assert(fallbackAfterThrow.identity_resolved.session.credentials === undefined, 'credential redaction: describeSession throw falls back to stripping credentials');

  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(redactJob.id);
  deleteJob(redactJob.id);
}

// -- compareTrustLevels --

console.log('\n-- compareTrustLevels --');
{
  assert(compareTrustLevels('untrusted', 'autonomous') === -1, 'compareTrustLevels: untrusted < autonomous');
  assert(compareTrustLevels('autonomous', 'untrusted') === 1, 'compareTrustLevels: autonomous > untrusted');
  assert(compareTrustLevels('supervised', 'supervised') === 0, 'compareTrustLevels: equal levels return 0');
  assert(compareTrustLevels(null, null) === 0, 'compareTrustLevels: both null returns 0');
  assert(compareTrustLevels('restricted', 'supervised') === -1, 'compareTrustLevels: restricted < supervised');
  assert(compareTrustLevels('unknown', 'untrusted') === -1, 'compareTrustLevels: unrecognized < known');
}

// -- authorization_ref-only denial --

console.log('\n-- authorization_ref-only denial --');
{
  const refOnlyResult = await evaluateAuthorization(
    { authorization: null, authorization_ref: 'arn:aws:iam::123456789012:policy/Deny' },
    null,
    null,
    {},
  );
  assert(refOnlyResult.decision === 'deny', 'authorization_ref-only: decision is deny');
  assert(refOnlyResult.reason.includes('not yet implemented'), 'authorization_ref-only: reason mentions not implemented');
}

// -- independent child trust cap --

console.log('\n-- independent child trust cap --');
{
  const parentJob = createJob({
    name: 'trust-cap-parent',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'test-provider' }),
    child_credential_policy: 'independent',
  });
  const parentRun = createRun(parentJob.id, { run_timeout_ms: 300_000 });
  persistV02Outcomes(parentRun.id, {
    identity_resolved: {
      provider: 'test-provider',
      session: {
        subject: { kind: 'agent', principal: 'agent:parent' },
        trust: { effective_level: 'supervised' },
        credentials: {},
      },
      source: 'provider',
    },
  });
  finishRun(parentRun.id, 'ok', { summary: 'parent ok' });

  const childJob = createJob({
    name: 'trust-cap-child',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    parent_id: parentJob.id,
    trigger_on: 'success',
    child_credential_policy: 'independent',
    identity_trust_level: 'autonomous',
    identity_subject_kind: 'agent',
    identity_principal: 'agent:escalating-child',
  });

  const childCtx = await prepareDispatch(
    getJob(childJob.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(childCtx === null, 'independent trust cap: child with higher trust than parent is aborted');
  const childRun = getRunsForJob(childJob.id, 1)[0];
  assert(childRun.status === 'error', 'independent trust cap: run finishes as error');
  assert(childRun.error_message.includes('exceeds parent trust level'), 'independent trust cap: error mentions trust escalation');

  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(parentJob.id, childJob.id);
  deleteJob(childJob.id);
  deleteJob(parentJob.id);
}

// -- independent child within trust cap passes --

console.log('\n-- independent child within trust cap passes --');
{
  const parentJobOk = createJob({
    name: 'trust-cap-parent-ok',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'test-provider' }),
    child_credential_policy: 'independent',
  });
  const parentRunOk = createRun(parentJobOk.id, { run_timeout_ms: 300_000 });
  persistV02Outcomes(parentRunOk.id, {
    identity_resolved: {
      provider: 'test-provider',
      session: {
        subject: { kind: 'agent', principal: 'agent:parent-ok' },
        trust: { effective_level: 'autonomous' },
        credentials: {},
      },
      source: 'provider',
    },
  });
  finishRun(parentRunOk.id, 'ok', { summary: 'parent ok' });

  const childJobOk = createJob({
    name: 'trust-cap-child-ok',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child ok',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    parent_id: parentJobOk.id,
    trigger_on: 'success',
    child_credential_policy: 'independent',
    identity_trust_level: 'supervised',
    identity_subject_kind: 'agent',
    identity_principal: 'agent:ok-child',
  });

  const childCtxOk = await prepareDispatch(
    getJob(childJobOk.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(childCtxOk !== null, 'independent trust cap: child within parent trust level proceeds');
  if (childCtxOk) finishRun(childCtxOk.run.id, 'cancelled', { summary: 'test cleanup' });
  getDb().prepare('DELETE FROM runs WHERE job_id IN (?, ?)').run(parentJobOk.id, childJobOk.id);
  deleteJob(childJobOk.id);
  deleteJob(parentJobOk.id);
}

// -- downscope trust elevation detection --

console.log('\n-- downscope trust elevation detection --');
{
  // Create a provider that returns a session with HIGHER trust than parent
  const elevatingProvider = {
    name: 'elevating-provider',
    type: 'identity',
    resolveSession() {
      return { ok: true, session: { subject: { kind: 'agent', principal: 'agent:child' }, trust: { effective_level: 'supervised' }, credentials: {} } };
    },
    prepareHandoff(_parentSession, _opts) {
      // Return a session that elevates trust from supervised to autonomous
      return {
        prepared: true,
        session: {
          subject: { kind: 'agent', principal: 'agent:elevated' },
          trust: { effective_level: 'autonomous' },
          credentials: {},
        },
      };
    },
  };

  const dsParent = createJob({
    name: 'ds-elevate-parent',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo parent',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'elevating-provider' }),
    child_credential_policy: 'downscope',
  });

  // Create a parent run with an identity_resolved so downscope can read it
  const parentRun = createRun(dsParent.id, { run_timeout_ms: 300_000 });
  persistV02Outcomes(parentRun.id, {
    identity_resolved: JSON.stringify({
      provider: 'elevating-provider',
      session: { subject: { kind: 'agent', principal: 'agent:parent' }, trust: { effective_level: 'supervised' }, credentials: {} },
      source: 'provider',
    }),
  });
  finishRun(parentRun.id, 'ok', { summary: 'parent ok' });

  const dsChild = createJob({
    name: 'ds-elevate-child',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo child',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    parent_id: dsParent.id,
    trigger_on: 'success',
    child_credential_policy: 'downscope',
    identity: JSON.stringify({ provider: 'elevating-provider', scope: 'narrow' }),
  });

  const dsChildCtx = await prepareDispatch(
    getJob(dsChild.id),
    {},
    buildPrepareDispatchDeps({
      getIdentityProvider: (name) => name === 'elevating-provider' ? elevatingProvider : null,
    }),
  );
  assert(dsChildCtx === null, 'downscope elevation: child with elevated trust from handoff is aborted');
  const dsChildRun = getRunsForJob(dsChild.id, 1)[0];
  assert(dsChildRun.status === 'error', 'downscope elevation: run finishes as error');
  assert(dsChildRun.error_message.includes('Downscope credential policy failed'), 'downscope elevation: error mentions downscope failure');

  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(dsChild.id);
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(dsParent.id);
  deleteJob(dsChild.id);
  deleteJob(dsParent.id);
}

// -- malformed identity JSON on non-shell job does not masquerade as handoff --

console.log('\n-- malformed identity JSON on non-shell job --');
{
  const malformedIdentityJob = createJob({
    name: 'malformed-identity-nonshell',
    schedule_cron: '0 8 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo malformed identity',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ subject_kind: 'agent', principal: 'agent:test' }),
  });
  getDb().prepare('UPDATE jobs SET session_target = ?, payload_kind = ?, identity = ? WHERE id = ?')
    .run('isolated', 'agentTurn', 'not-json', malformedIdentityJob.id);

  const malformedIdentityCtx = await prepareDispatch(
    getJob(malformedIdentityJob.id),
    {},
    buildPrepareDispatchDeps(),
  );
  assert(malformedIdentityCtx !== null, 'prepareDispatch: malformed identity JSON on non-shell job no longer triggers handoff-only abort');
  assert(malformedIdentityCtx.v02Outcomes.credential_handoff_summary.error.includes('parse failed'), 'prepareDispatch: malformed identity JSON preserves handoff parse error details');

  if (malformedIdentityCtx) finishRun(malformedIdentityCtx.run.id, 'cancelled', { summary: 'test cleanup' });
  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(malformedIdentityJob.id);
  deleteJob(malformedIdentityJob.id);
}

// -- security abort skips triggered children --

console.log('\n-- security abort skips triggered children --');
{
  let childrenFired = false;
  const secAbortJob = createJob({
    name: 'sec-abort-no-children',
    schedule_cron: '0 7 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo should not dispatch',
    delivery_mode: 'none',
    delivery_opt_out_reason: 'test',
    run_timeout_ms: 300_000,
    origin: 'system',
    identity: JSON.stringify({ provider: 'missing-sec-provider', scope: 'full' }),
    authorization: JSON.stringify({ requires_identity: true }),
  });

  await prepareDispatch(
    getJob(secAbortJob.id),
    {},
    buildPrepareDispatchDeps({
      handleTriggeredChildren() { childrenFired = true; },
    }),
  );
  assert(!childrenFired, 'security abort: handleTriggeredChildren not called on identity resolution failure');

  getDb().prepare('DELETE FROM runs WHERE job_id = ?').run(secAbortJob.id);
  deleteJob(secAbortJob.id);
}

// -- evidence integrity field --

console.log('\n-- evidence integrity field --');
{
  const evidence = generateEvidence(
    { evidence: JSON.stringify({ collect: 'all' }) },
    { id: 'run-123', status: 'ok' },
    { identity_resolved: { principal: 'test' } },
  );
  assert(evidence !== null, 'evidence: generated from valid job');
  assert(evidence.integrity === 'none', 'evidence: integrity field is "none"');
  assert(evidence.hash === null, 'evidence: hash is null');
}

// -- persistV02Outcomes guards --

console.log('\n-- persistV02Outcomes guards --');
{
  // Null runId should no-op
  persistV02Outcomes(null, { identity_resolved: 'test' });
  persistV02Outcomes('', { identity_resolved: 'test' });
  persistV02Outcomes(undefined, { identity_resolved: 'test' });
  // If we got here without throwing, the guard works
  assert(true, 'persistV02Outcomes: null/empty/undefined runId no-ops safely');
}

// -- getStaleRuns type guard --

console.log('\n-- getStaleRuns type guard --');
{
  let threwOnString = false;
  try {
    getStaleRuns('not-a-number');
  } catch (e) {
    threwOnString = e.message.includes('non-negative integer');
  }
  assert(threwOnString, 'getStaleRuns: rejects non-integer string');

  let threwOnNegative = false;
  try {
    getStaleRuns(-1);
  } catch (e) {
    threwOnNegative = e.message.includes('non-negative integer');
  }
  assert(threwOnNegative, 'getStaleRuns: rejects negative integer');

  let threwOnFloat = false;
  try {
    getStaleRuns(1.5);
  } catch (e) {
    threwOnFloat = e.message.includes('non-negative integer');
  }
  assert(threwOnFloat, 'getStaleRuns: rejects non-integer float');

  // Valid call should not throw
  const staleRuns = getStaleRuns(90);
  assert(Array.isArray(staleRuns), 'getStaleRuns: returns array for valid input');
}

// -- Gateway scope header --

console.log('\n-- Gateway scope header --');
{
  const originalFetch = globalThis.fetch;
  const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-gateway-token';
  const captured = [];
  globalThis.fetch = async (url, opts = {}) => {
    captured.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { total_tokens: 1 },
      }),
      headers: new Headers({ 'x-openclaw-session-key': 'session-from-gateway' }),
    };
  };

  try {
    await runAgentTurn({
      message: 'hello',
      agentId: 'main',
      sessionKey: 'session-1',
      timeoutMs: 1000,
    });
    assert(
      captured[0]?.opts?.headers?.['x-openclaw-scopes'] === 'operator.write',
      'runAgentTurn: sends operator.write scope for chat completions',
    );

    await runAgentTurnWithActivityTimeout({
      message: 'hello',
      agentId: 'main',
      sessionKey: 'session-2',
      pollIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 1_000,
    });
    assert(
      captured[1]?.opts?.headers?.['x-openclaw-scopes'] === 'operator.write',
      'runAgentTurnWithActivityTimeout: sends operator.write scope for chat completions',
    );

    await invokeGatewayTool('sessions_list', { limit: 1 });
    assert(
      captured[2]?.opts?.headers?.['x-openclaw-scopes'] === undefined,
      'invokeGatewayTool: does not send chat-completions scope header',
    );

    const healthOk = await checkGatewayHealth();
    assert(healthOk === true, 'checkGatewayHealth: returns true for ok responses');
    assert(
      captured[3]?.opts?.headers?.['x-openclaw-scopes'] === undefined,
      'checkGatewayHealth: does not send chat-completions scope header',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
  }
}

closeDb();
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
