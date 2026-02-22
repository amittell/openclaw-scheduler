#!/usr/bin/env node
// OpenClaw Scheduler Dispatcher
// Replaces jobs.json cron + heartbeat with SQLite-backed scheduling.
//
// Tick loop:
//   1. Find due jobs → dispatch
//   2. Check running runs for staleness (implicit heartbeat)
//   3. Handle timed-out runs (fallback)
//   4. Sleep until next tick

import { initDb, closeDb } from './db.js';
import { getDueJobs, hasRunningRun, updateJob, nextRunFromCron, deleteJob, getJob } from './jobs.js';
import { createRun, finishRun, getStaleRuns, getTimedOutRuns, getRunningRuns, updateHeartbeat, updateRunSession, pruneRuns } from './runs.js';
import { sendSystemEvent, spawnIsolatedRun, listSessions, sendMessage } from './gateway.js';

// ── Config ──────────────────────────────────────────────────
const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULER_TICK_MS || '10000', 10); // 10s default
const STALE_THRESHOLD_S = parseInt(process.env.SCHEDULER_STALE_THRESHOLD_S || '90', 10);
const HEARTBEAT_CHECK_INTERVAL_MS = parseInt(process.env.SCHEDULER_HEARTBEAT_CHECK_MS || '30000', 10);
const PRUNE_INTERVAL_MS = parseInt(process.env.SCHEDULER_PRUNE_MS || '3600000', 10); // 1 hour
const LOG_PREFIX = '[scheduler]';

// ── State ───────────────────────────────────────────────────
let running = true;
let lastHeartbeatCheck = 0;
let lastPrune = 0;

// ── Logging ─────────────────────────────────────────────────
function log(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  console[level === 'error' ? 'error' : 'log'](`${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}`);
}

// ── Dispatch a single job ───────────────────────────────────
async function dispatchJob(job) {
  // Skip-overlap check
  if (job.overlap_policy === 'skip' && hasRunningRun(job.id)) {
    log('info', `Skipping ${job.name} — previous run still active`, { jobId: job.id });
    // Still advance next_run_at so we don't re-check every tick
    advanceNextRun(job);
    return;
  }

  log('info', `Dispatching: ${job.name}`, { jobId: job.id, target: job.session_target });

  // Create run record
  const run = createRun(job.id, { run_timeout_ms: job.run_timeout_ms });

  try {
    if (job.session_target === 'main') {
      // Main session: send system event
      await sendSystemEvent(job.payload_message, 'now');
      // Main session events complete immediately from our perspective
      finishRun(run.id, 'ok', { summary: 'System event dispatched' });
      updateJobAfterRun(job, 'ok');
    } else {
      // Isolated session: spawn via gateway
      const result = await spawnIsolatedRun(job, run.id);

      // Update run with session info from spawn result
      if (result && result.sessionKey) {
        updateRunSession(run.id, result.sessionKey, result.sessionId || null);
      }

      // Don't finish the run yet — it's async. The heartbeat checker will monitor it.
      updateJobAfterRun(job, 'running');
      log('info', `Spawned isolated run for ${job.name}`, {
        runId: run.id,
        sessionKey: result?.sessionKey,
      });
    }
  } catch (err) {
    log('error', `Failed to dispatch ${job.name}: ${err.message}`, { jobId: job.id });
    finishRun(run.id, 'error', { error_message: err.message });
    updateJobAfterRun(job, 'error');
  }
}

// ── Advance next_run_at ─────────────────────────────────────
function advanceNextRun(job) {
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  updateJob(job.id, { next_run_at: nextRun });
}

// ── Update job state after a run ────────────────────────────
function updateJobAfterRun(job, status) {
  const now = new Date().toISOString();
  const patch = {
    last_run_at: now,
    last_status: status,
  };

  if (status === 'error') {
    patch.consecutive_errors = (job.consecutive_errors || 0) + 1;
  } else if (status === 'ok') {
    patch.consecutive_errors = 0;
  }

  // Advance to next run
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  patch.next_run_at = nextRun;

  // Apply backoff for consecutive errors
  if (patch.consecutive_errors > 0 && nextRun) {
    const backoffMs = getBackoffMs(patch.consecutive_errors);
    const nextRunDate = new Date(nextRun);
    const backoffDate = new Date(Date.now() + backoffMs);
    // Use whichever is later
    if (backoffDate > nextRunDate) {
      patch.next_run_at = backoffDate.toISOString();
    }
  }

  updateJob(job.id, patch);

  // Delete one-shot jobs after success
  if (status === 'ok' && job.delete_after_run) {
    log('info', `Deleting one-shot job: ${job.name}`, { jobId: job.id });
    deleteJob(job.id);
  }
}

// ── Exponential backoff for errors ──────────────────────────
function getBackoffMs(consecutiveErrors) {
  const backoffs = [30000, 60000, 300000, 900000, 3600000]; // 30s, 1m, 5m, 15m, 60m
  const idx = Math.min(consecutiveErrors - 1, backoffs.length - 1);
  return backoffs[idx];
}

// ── Check running runs for staleness ────────────────────────
async function checkRunningRuns() {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  log('debug', `Checking ${runningRuns.length} running run(s) for activity`);

  // Check session activity for each running run
  let activeSessions;
  try {
    activeSessions = await listSessions({ activeMinutes: 5, limit: 100 });
  } catch (err) {
    log('error', `Failed to list sessions for heartbeat check: ${err.message}`);
    return;
  }

  // Build a set of active session keys
  const activeKeys = new Set();
  if (activeSessions && Array.isArray(activeSessions)) {
    for (const s of activeSessions) {
      if (s.sessionKey) activeKeys.add(s.sessionKey);
      if (s.key) activeKeys.add(s.key);
    }
  }

  for (const run of runningRuns) {
    if (run.session_key && activeKeys.has(run.session_key)) {
      // Session is still active — update heartbeat
      updateHeartbeat(run.id);
      log('debug', `Heartbeat updated for run ${run.id} (${run.job_name})`);
    }
    // If session_key not in active set, heartbeat stays stale → will be caught by stale check
  }

  // Now check for stale runs (heartbeat too old)
  const staleRuns = getStaleRuns(STALE_THRESHOLD_S);
  for (const run of staleRuns) {
    log('warn', `Stale run detected: ${run.job_name}`, {
      runId: run.id,
      lastHeartbeat: run.last_heartbeat,
      sessionKey: run.session_key,
    });
    finishRun(run.id, 'timeout', {
      error_message: `Run stale — no session activity for ${STALE_THRESHOLD_S}s`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'error');
  }

  // Fallback: absolute timeout check
  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    log('warn', `Timed out run: ${run.job_name}`, {
      runId: run.id,
      timeoutMs: run.run_timeout_ms,
    });
    finishRun(run.id, 'timeout', {
      error_message: `Run exceeded absolute timeout of ${run.run_timeout_ms}ms`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'error');
  }
}

// ── Monitor spawned sessions for completion ─────────────────
async function checkCompletedRuns() {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  for (const run of runningRuns) {
    if (!run.session_key) continue;

    try {
      // Check if the session has completed by looking at sessions list
      // A completed sub-agent session won't appear in active sessions
      // and will have a final status
      const sessions = await listSessions({ limit: 200 });
      const session = Array.isArray(sessions)
        ? sessions.find(s => (s.sessionKey || s.key) === run.session_key)
        : null;

      if (session && session.status === 'completed') {
        log('info', `Run completed: ${run.job_name}`, { runId: run.id });
        finishRun(run.id, 'ok', { summary: session.summary || 'Completed' });
        const job = getJob(run.job_id);
        if (job) updateJobAfterRun(job, 'ok');

        // Handle delivery
        if (job && job.delivery_mode === 'announce' && session.summary) {
          await handleDelivery(job, session.summary);
        }
      }
    } catch (err) {
      log('error', `Error checking run completion for ${run.job_name}: ${err.message}`);
    }
  }
}

// ── Deliver run output to channel ───────────────────────────
async function handleDelivery(job, summary) {
  if (job.delivery_mode !== 'announce') return;
  if (!job.delivery_channel && !job.delivery_to) return;

  try {
    await sendMessage(job.delivery_channel, job.delivery_to, summary);
    log('info', `Delivered output for ${job.name}`, {
      channel: job.delivery_channel,
      to: job.delivery_to,
    });
  } catch (err) {
    log('error', `Delivery failed for ${job.name}: ${err.message}`);
  }
}

// ── Main tick ───────────────────────────────────────────────
async function tick() {
  const now = Date.now();

  // 1. Find and dispatch due jobs
  try {
    const dueJobs = getDueJobs();
    for (const job of dueJobs) {
      await dispatchJob(job);
    }
  } catch (err) {
    log('error', `Error in dispatch cycle: ${err.message}`);
  }

  // 2. Heartbeat check (every HEARTBEAT_CHECK_INTERVAL_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_INTERVAL_MS) {
    lastHeartbeatCheck = now;
    try {
      await checkRunningRuns();
      await checkCompletedRuns();
    } catch (err) {
      log('error', `Error in heartbeat check: ${err.message}`);
    }
  }

  // 3. Prune old runs periodically
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    try {
      pruneRuns(100);
      log('info', 'Pruned old runs');
    } catch (err) {
      log('error', `Error pruning runs: ${err.message}`);
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
  log('info', 'Starting OpenClaw Scheduler Dispatcher', {
    tickMs: TICK_INTERVAL_MS,
    staleThresholdS: STALE_THRESHOLD_S,
    heartbeatCheckMs: HEARTBEAT_CHECK_INTERVAL_MS,
  });

  // Initialize database
  initDb();
  log('info', 'Database initialized');

  // Signal handlers
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Main loop
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
