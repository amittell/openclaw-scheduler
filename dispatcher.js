#!/usr/bin/env node
// OpenClaw Scheduler Dispatcher v2
//
// Full standalone scheduler + message router.
// Dispatches independently via chat completions API.
//
// Tick loop:
//   1. Check gateway health
//   2. Find due jobs → dispatch via chat completions / system event
//   3. Check running runs for staleness (implicit heartbeat)
//   4. Deliver pending messages
//   5. Expire old messages
//   6. Prune old runs (hourly)

import { initDb, closeDb } from './db.js';
import { getDueJobs, hasRunningRun, updateJob, nextRunFromCron, deleteJob, getJob } from './jobs.js';
import {
  createRun, finishRun, getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateHeartbeat, updateRunSession, pruneRuns
} from './runs.js';
import {
  sendMessage as queueMessage, getInbox, markDelivered, markRead,
  expireMessages, pruneMessages, getUnreadCount
} from './messages.js';
import { upsertAgent, setAgentStatus, touchAgent, getAgent } from './agents.js';
import {
  runAgentTurn, sendSystemEvent, listSessions, deliverMessage, checkGatewayHealth
} from './gateway.js';

// ── Helpers ─────────────────────────────────────────────────
function sqliteNow() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// ── Config ──────────────────────────────────────────────────
const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULER_TICK_MS || '10000', 10);
const STALE_THRESHOLD_S = parseInt(process.env.SCHEDULER_STALE_THRESHOLD_S || '90', 10);
const HEARTBEAT_CHECK_MS = parseInt(process.env.SCHEDULER_HEARTBEAT_CHECK_MS || '30000', 10);
const MESSAGE_DELIVERY_MS = parseInt(process.env.SCHEDULER_MESSAGE_DELIVERY_MS || '15000', 10);
const PRUNE_INTERVAL_MS = parseInt(process.env.SCHEDULER_PRUNE_MS || '3600000', 10);
const LOG_PREFIX = '[scheduler]';

// ── State ───────────────────────────────────────────────────
let running = true;
let lastHeartbeatCheck = 0;
let lastMessageDelivery = 0;
let lastPrune = 0;
let gatewayHealthy = true;

// ── Logging ─────────────────────────────────────────────────
function log(level, msg, meta) {
  if (level === 'debug' && !process.env.SCHEDULER_DEBUG) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}\n`;
  process.stderr.write(line);
}

// ── Dispatch a single job ───────────────────────────────────
async function dispatchJob(job) {
  // Skip-overlap check
  if (job.overlap_policy === 'skip' && hasRunningRun(job.id)) {
    log('info', `Skipping ${job.name} — previous run still active`, { jobId: job.id });
    advanceNextRun(job);
    return;
  }

  log('info', `Dispatching: ${job.name}`, { jobId: job.id, target: job.session_target });

  const run = createRun(job.id, { run_timeout_ms: job.run_timeout_ms });

  try {
    if (job.session_target === 'main') {
      // Main session: send system event
      await sendSystemEvent(job.payload_message, 'now');
      finishRun(run.id, 'ok', { summary: 'System event dispatched' });
      updateJobAfterRun(job, 'ok');

    } else {
      // Isolated session: dispatch via chat completions API
      const sessionKey = `scheduler:${job.id}:${run.id}`;
      updateRunSession(run.id, sessionKey, null);

      // Mark agent as busy
      if (job.agent_id) setAgentStatus(job.agent_id, 'busy', sessionKey);

      const result = await runAgentTurn({
        message: buildJobPrompt(job, run),
        agentId: job.agent_id || 'main',
        sessionKey,
        model: job.payload_model || undefined,
        timeoutMs: (job.payload_timeout_seconds || 120) * 1000,
      });

      // Run completed synchronously via chat completions
      const content = result.content || '';
      const isHeartbeatOk = content.trim() === 'HEARTBEAT_OK' || content.trim().startsWith('HEARTBEAT_OK');

      finishRun(run.id, 'ok', { summary: content.slice(0, 5000) });

      // Mark agent as idle
      if (job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

      // Handle delivery
      if (job.delivery_mode === 'announce' && !isHeartbeatOk && content.trim()) {
        await handleDelivery(job, content);
      }

      // Queue result as message for traceability (before job deletion)
      queueMessage({
        from_agent: 'scheduler',
        to_agent: job.agent_id || 'main',
        kind: 'result',
        subject: `Job completed: ${job.name}`,
        body: content.slice(0, 5000),
        // Don't reference job_id/run_id for one-shot jobs (they get deleted)
        job_id: job.delete_after_run ? null : job.id,
        run_id: job.delete_after_run ? null : run.id,
      });

      // Update job state (may delete one-shot jobs)
      updateJobAfterRun(job, 'ok');

      log('info', `Completed: ${job.name} (${result.usage?.total_tokens || '?'} tokens)`, {
        runId: run.id,
        durationMs: run.duration_ms,
      });
    }
  } catch (err) {
    log('error', `Failed: ${job.name}: ${err.message}`, { jobId: job.id });
    finishRun(run.id, 'error', { error_message: err.message });
    if (job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

    // Queue error message (before potential job deletion)
    queueMessage({
      from_agent: 'scheduler',
      to_agent: job.agent_id || 'main',
      kind: 'system',
      subject: `Job failed: ${job.name}`,
      body: `Error: ${err.message}`,
      priority: 1,
      job_id: job.delete_after_run ? null : job.id,
      run_id: job.delete_after_run ? null : run.id,
    });

    updateJobAfterRun(job, 'error');
  }
}

// ── Build the prompt sent to the agent ──────────────────────
function buildJobPrompt(job, run) {
  const parts = [`[scheduler:${job.id} ${job.name}]`];
  
  // Include any pending messages for this agent
  const inbox = getInbox(job.agent_id || 'main', { limit: 5 });
  if (inbox.length > 0) {
    parts.push('\n--- Pending Messages ---');
    for (const msg of inbox) {
      parts.push(`From: ${msg.from_agent} | ${msg.kind} | ${msg.subject || '(no subject)'}`);
      parts.push(msg.body.slice(0, 500));
      parts.push('---');
      markDelivered(msg.id);
    }
  }

  parts.push('\n' + job.payload_message);
  return parts.join('\n');
}

// ── Deliver run output to channel ───────────────────────────
async function handleDelivery(job, content) {
  if (job.delivery_mode !== 'announce') return;
  if (!job.delivery_channel && !job.delivery_to) return;

  try {
    await deliverMessage(job.delivery_channel, job.delivery_to, content);
    log('info', `Delivered: ${job.name}`, { channel: job.delivery_channel, to: job.delivery_to });
  } catch (err) {
    log('error', `Delivery failed: ${job.name}: ${err.message}`);
  }
}

// ── Advance next_run_at ─────────────────────────────────────
function advanceNextRun(job) {
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  updateJob(job.id, { next_run_at: nextRun });
}

// ── Update job state after run ──────────────────────────────
function updateJobAfterRun(job, status) {
  const patch = { last_run_at: sqliteNow(), last_status: status };

  if (status === 'error' || status === 'timeout') {
    patch.consecutive_errors = (job.consecutive_errors || 0) + 1;
  } else if (status === 'ok') {
    patch.consecutive_errors = 0;
  }

  // Advance schedule
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  patch.next_run_at = nextRun;

  // Backoff for errors
  if (patch.consecutive_errors > 0 && nextRun) {
    const backoffMs = getBackoffMs(patch.consecutive_errors);
    const backoffDate = new Date(Date.now() + backoffMs);
    const nextDate = new Date(nextRun);
    if (backoffDate > nextDate) patch.next_run_at = backoffDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  updateJob(job.id, patch);

  if (status === 'ok' && job.delete_after_run) {
    log('info', `Deleting one-shot: ${job.name}`);
    deleteJob(job.id);
  }
}

function getBackoffMs(n) {
  const b = [30_000, 60_000, 300_000, 900_000, 3_600_000];
  return b[Math.min(n - 1, b.length - 1)];
}

// ── Health check for running runs ───────────────────────────
async function checkRunHealth() {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  log('debug', `Checking ${runningRuns.length} running run(s)`);

  // With chat completions dispatch, runs complete synchronously.
  // But if something hangs, the stale/timeout checks still apply.

  // Stale detection
  const staleRuns = getStaleRuns(STALE_THRESHOLD_S);
  for (const run of staleRuns) {
    log('warn', `Stale run: ${run.job_name}`, { runId: run.id });
    finishRun(run.id, 'timeout', {
      error_message: `No activity for ${STALE_THRESHOLD_S}s`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'timeout');
  }

  // Absolute timeout
  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    log('warn', `Timed out: ${run.job_name}`, { runId: run.id, timeoutMs: run.run_timeout_ms });
    finishRun(run.id, 'timeout', {
      error_message: `Exceeded ${run.run_timeout_ms}ms timeout`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'timeout');
  }
}

// ── Message delivery loop ───────────────────────────────────
async function deliverPendingMessages() {
  // Expire old messages
  expireMessages();

  // For now, messages are delivered inline with job prompts (buildJobPrompt).
  // Future: deliver high-priority messages immediately via system event or chat.
}

// ── Main tick ───────────────────────────────────────────────
async function tick() {
  const now = Date.now();

  // Gateway health check
  if (!gatewayHealthy || now % 60000 < TICK_INTERVAL_MS) {
    gatewayHealthy = await checkGatewayHealth();
    if (!gatewayHealthy) {
      log('warn', 'Gateway unreachable — skipping tick');
      return;
    }
  }

  // 1. Dispatch due jobs
  try {
    const dueJobs = getDueJobs();
    for (const job of dueJobs) {
      await dispatchJob(job);
    }
  } catch (err) {
    log('error', `Dispatch error: ${err.message}`);
  }

  // 2. Health check (every HEARTBEAT_CHECK_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_MS) {
    lastHeartbeatCheck = now;
    try { await checkRunHealth(); } catch (err) {
      log('error', `Health check error: ${err.message}`);
    }
  }

  // 3. Message delivery (every MESSAGE_DELIVERY_MS)
  if (now - lastMessageDelivery >= MESSAGE_DELIVERY_MS) {
    lastMessageDelivery = now;
    try { await deliverPendingMessages(); } catch (err) {
      log('error', `Message delivery error: ${err.message}`);
    }
  }

  // 4. Prune (hourly)
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    try {
      pruneRuns(100);
      pruneMessages(30);
      log('info', 'Pruned old runs + messages');
    } catch (err) {
      log('error', `Prune error: ${err.message}`);
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────
function shutdown(signal) {
  log('info', `Shutting down (${signal})`);
  running = false;
  closeDb();
  process.exit(0);
}

async function main() {
  log('info', 'Starting OpenClaw Scheduler v2 (standalone)', {
    tickMs: TICK_INTERVAL_MS,
    staleThresholdS: STALE_THRESHOLD_S,
    heartbeatCheckMs: HEARTBEAT_CHECK_MS,
  });

  initDb();

  // Register default agent
  upsertAgent('main', { name: 'Main Agent', status: 'idle', capabilities: ['*'] });

  log('info', 'Database initialized');

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (running) {
    await tick();
    await new Promise(r => setTimeout(r, TICK_INTERVAL_MS));
  }
}

main().catch(err => {
  log('error', `Fatal: ${err.message}`);
  closeDb();
  process.exit(1);
});
