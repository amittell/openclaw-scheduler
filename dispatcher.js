#!/usr/bin/env node
// OpenClaw Scheduler Dispatcher
//
// Manages job scheduling via SQLite, dispatches to OpenClaw's built-in cron API,
// and monitors runs with implicit session heartbeats.
//
// Tick loop:
//   1. Find due jobs → dispatch via OpenClaw cron.run
//   2. Check running runs for staleness (implicit heartbeat)
//   3. Handle timed-out runs (fallback)
//   4. Sync run results from OpenClaw cron history
//   5. Sleep until next tick

import { initDb, closeDb } from './db.js';
import { getDueJobs, hasRunningRun, updateJob, nextRunFromCron, deleteJob, getJob } from './jobs.js';
import {
  createRun, finishRun, getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateHeartbeat, updateRunSession, pruneRuns
} from './runs.js';
import { sendSystemEvent, runCronJob, getCronRuns, listSessions } from './gateway.js';

// ── Config ──────────────────────────────────────────────────
const TICK_INTERVAL_MS = parseInt(process.env.SCHEDULER_TICK_MS || '10000', 10);
const STALE_THRESHOLD_S = parseInt(process.env.SCHEDULER_STALE_THRESHOLD_S || '90', 10);
const HEARTBEAT_CHECK_INTERVAL_MS = parseInt(process.env.SCHEDULER_HEARTBEAT_CHECK_MS || '30000', 10);
const PRUNE_INTERVAL_MS = parseInt(process.env.SCHEDULER_PRUNE_MS || '3600000', 10);
const LOG_PREFIX = '[scheduler]';

// ── State ───────────────────────────────────────────────────
let running = true;
let lastHeartbeatCheck = 0;
let lastPrune = 0;

// ── Logging ─────────────────────────────────────────────────
function log(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[fn](`${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}`);
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

  // Create our run record
  const run = createRun(job.id, { run_timeout_ms: job.run_timeout_ms });

  try {
    if (job.session_target === 'main') {
      // Main session: send system event directly
      await sendSystemEvent(job.payload_message, 'now');
      finishRun(run.id, 'ok', { summary: 'System event dispatched' });
      updateJobAfterRun(job, 'ok');
    } else {
      // Isolated session: trigger via OpenClaw's cron.run API
      // This leverages OC's built-in session spawning + delivery
      const result = await runCronJob(job.id);

      // Extract session info from result if available
      const resultData = result?.result;
      if (resultData?.details?.sessionKey) {
        updateRunSession(run.id, resultData.details.sessionKey, resultData.details.sessionId);
      }

      // The run is now async — OC is handling the session.
      // We'll check completion in the heartbeat loop.
      log('info', `Triggered cron.run for ${job.name}`, { runId: run.id });

      // Don't advance next_run_at yet — wait for completion monitoring.
      // But DO advance the schedule so we don't re-dispatch next tick.
      advanceNextRun(job);
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

// ── Update job state after a run completes ──────────────────
function updateJobAfterRun(job, status) {
  const now = new Date().toISOString();
  const patch = {
    last_run_at: now,
    last_status: status,
  };

  if (status === 'error' || status === 'timeout') {
    patch.consecutive_errors = (job.consecutive_errors || 0) + 1;
  } else if (status === 'ok') {
    patch.consecutive_errors = 0;
  }

  // Apply backoff for consecutive errors
  if (patch.consecutive_errors > 0) {
    const backoffMs = getBackoffMs(patch.consecutive_errors);
    const backoffDate = new Date(Date.now() + backoffMs);
    const currentNext = job.next_run_at ? new Date(job.next_run_at) : null;
    if (!currentNext || backoffDate > currentNext) {
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

// ── Exponential backoff ─────────────────────────────────────
function getBackoffMs(consecutiveErrors) {
  const backoffs = [30_000, 60_000, 300_000, 900_000, 3_600_000];
  return backoffs[Math.min(consecutiveErrors - 1, backoffs.length - 1)];
}

// ── Sync run results from OpenClaw's cron history ───────────
async function syncRunResults() {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  for (const run of runningRuns) {
    try {
      const result = await getCronRuns(run.job_id);
      const history = result?.result?.details?.runs || [];

      // Find the most recent completed run in OC's history
      // that started after our run started
      const runStarted = new Date(run.started_at + 'Z').getTime();
      const matching = history.find(h =>
        h.action === 'finished' &&
        h.runAtMs >= runStarted - 5000 // 5s tolerance
      );

      if (matching) {
        const status = matching.status === 'ok' ? 'ok' : 'error';
        finishRun(run.id, status, {
          summary: matching.summary?.slice(0, 5000),
          error_message: matching.status !== 'ok' ? matching.error : null,
        });
        const job = getJob(run.job_id);
        if (job) updateJobAfterRun(job, status);
        log('info', `Run completed: ${run.job_name} → ${status}`, {
          runId: run.id,
          durationMs: matching.durationMs,
        });
      }
    } catch (err) {
      // Non-fatal — we'll check again next tick
      log('debug', `Error syncing run for ${run.job_name}: ${err.message}`);
    }
  }
}

// ── Check running runs for staleness (implicit heartbeat) ───
async function checkRunHealth() {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  // First, try to sync results from OC's cron history
  await syncRunResults();

  // Re-fetch — some may have been completed
  const stillRunning = getRunningRuns();
  if (stillRunning.length === 0) return;

  log('debug', `Checking ${stillRunning.length} running run(s) for activity`);

  // Check session activity for implicit heartbeat
  let activeSessions;
  try {
    const result = await listSessions({ activeMinutes: 5, limit: 200 });
    activeSessions = result?.result?.details?.sessions || result?.result || [];
    if (!Array.isArray(activeSessions)) activeSessions = [];
  } catch (err) {
    log('error', `Failed to list sessions: ${err.message}`);
    return;
  }

  const activeKeys = new Set();
  for (const s of activeSessions) {
    if (s.sessionKey) activeKeys.add(s.sessionKey);
    if (s.key) activeKeys.add(s.key);
  }

  for (const run of stillRunning) {
    if (run.session_key && activeKeys.has(run.session_key)) {
      updateHeartbeat(run.id);
      log('debug', `Heartbeat updated: ${run.job_name}`);
    }
  }

  // Stale detection
  const staleRuns = getStaleRuns(STALE_THRESHOLD_S);
  for (const run of staleRuns) {
    log('warn', `Stale run: ${run.job_name}`, {
      runId: run.id,
      lastHeartbeat: run.last_heartbeat,
    });
    finishRun(run.id, 'timeout', {
      error_message: `No session activity for ${STALE_THRESHOLD_S}s`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'timeout');
  }

  // Absolute timeout fallback
  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    log('warn', `Timed out: ${run.job_name}`, {
      runId: run.id,
      timeoutMs: run.run_timeout_ms,
    });
    finishRun(run.id, 'timeout', {
      error_message: `Exceeded absolute timeout of ${run.run_timeout_ms}ms`,
    });
    const job = getJob(run.job_id);
    if (job) updateJobAfterRun(job, 'timeout');
  }
}

// ── Main tick ───────────────────────────────────────────────
async function tick() {
  const now = Date.now();

  // 1. Dispatch due jobs
  try {
    const dueJobs = getDueJobs();
    for (const job of dueJobs) {
      await dispatchJob(job);
    }
  } catch (err) {
    log('error', `Dispatch error: ${err.message}`);
  }

  // 2. Health check (every HEARTBEAT_CHECK_INTERVAL_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_INTERVAL_MS) {
    lastHeartbeatCheck = now;
    try {
      await checkRunHealth();
    } catch (err) {
      log('error', `Health check error: ${err.message}`);
    }
  }

  // 3. Prune (hourly)
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    try {
      pruneRuns(100);
      log('info', 'Pruned old runs');
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
  log('info', 'Starting OpenClaw Scheduler Dispatcher', {
    tickMs: TICK_INTERVAL_MS,
    staleThresholdS: STALE_THRESHOLD_S,
    heartbeatCheckMs: HEARTBEAT_CHECK_INTERVAL_MS,
  });

  initDb();
  log('info', 'Database initialized');

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
