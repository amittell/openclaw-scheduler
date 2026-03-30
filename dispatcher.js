#!/usr/bin/env node
// OpenClaw Scheduler Dispatcher
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

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb, getDb, checkpointWal } from './db.js';
import {
  generateIdempotencyKey as _genIdemKey,
  generateChainIdempotencyKey as _genChainKey,
  generateRunNowIdempotencyKey as _genRunNowKey,
  claimIdempotencyKey as _claimIdemKey,
  releaseIdempotencyKey as _releaseIdemKey,
  updateIdempotencyResultHash as _updateIdemHash,
  forcePruneIdempotency as _pruneIdemLedger,
} from './idempotency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: SCHEDULER_VERSION = '0.0.0' } = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf8')
);
import { getDueJobs, getDueAtJobs, hasRunningRun, hasRunningRunForPool, updateJob, nextRunFromCron, deleteJob, getJob, pruneExpiredJobs, fireTriggeredChildren, createJob, shouldRetry, scheduleRetry, enqueueJob, dequeueJob, getDispatchBacklogCount } from './jobs.js';
import {
  createRun, finishRun, getRun, getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateRunSession, pruneRuns, updateContextSummary, persistV02Outcomes
} from './runs.js';
import {
  resolveIdentity, evaluateTrust, verifyAuthorizationProof,
  evaluateAuthorization, generateEvidence, summarizeCredentialHandoff,
  compareTrustLevels,
} from './v02-runtime.js';
import {
  getInbox, markDelivered,
  expireMessages, pruneMessages
} from './messages.js';
import {
  createApproval, getPendingApproval,
  resolveApproval, getTimedOutApprovals, pruneApprovals, countPendingApprovalsForJob
} from './approval.js';
import { buildRetrievalContext } from './retrieval.js';
import { upsertAgent, setAgentStatus } from './agents.js';
import {
  runAgentTurnWithActivityTimeout, sendSystemEvent, getAllSubAgentSessions, listSessions,
  deliverMessage, checkGatewayHealth, waitForGateway, resolveDeliveryAlias,
} from './gateway.js';
import { normalizeShellResult } from './shell-result.js';
import {
  getDispatch, getDueDispatches, claimDispatch, releaseDispatch, setDispatchStatus,
  enqueueDispatch,
} from './dispatch-queue.js';
import {
  listActiveTaskGroups, checkDeadAgents, checkGroupCompletion, getTaskGroupStatus,
  touchAgentHeartbeat,
} from './task-tracker.js';
import { mapTeamMessages, checkTeamTaskGates } from './team-adapter.js';
import { buildTriggeredRunContext } from './prompt-context.js';
import { runShellCommand } from './dispatcher-shell.js';
import {
  sqliteNow,
  adaptiveDeferralMs,
  buildExecutionIntentNote,
  matchesSentinel,
  detectTransientError,
  getBackoffMs,
  isDrainError,
} from './dispatcher-utils.js';
import { createDeliveryHelpers } from './dispatcher-delivery.js';
import { checkApprovals } from './dispatcher-approvals.js';
import {
  checkRunHealth,
  checkTaskTrackers,
  expireStaleMessages,
  ensureAgentInboxJobs,
} from './dispatcher-maintenance.js';
import {
  prepareDispatch,
  executeStrategy,
  finalizeDispatch,
} from './dispatcher-strategies.js';
import {
  loadProviders, getIdentityProvider, getAuthorizationProvider, getProofVerifier,
} from './provider-registry.js';

// ── Idempotency Key Wrappers ────────────────────────────────
// The shared module (idempotency.js) uses jobId strings; dispatcher wraps with job objects.
function generateIdempotencyKey(job, scheduledTime) {
  if (job.parent_id && !scheduledTime) return null;
  return _genIdemKey(job.id, scheduledTime);
}
const generateChainIdempotencyKey = _genChainKey;
const generateRunNowIdempotencyKey = _genRunNowKey;
const claimIdempotencyKey = _claimIdemKey;
const releaseIdempotencyKey = _releaseIdemKey;
const updateIdempotencyResultHash = _updateIdemHash;
const pruneIdempotencyLedger = _pruneIdemLedger;

// ── Config ──────────────────────────────────────────────────
const TICK_INTERVAL_MS = Math.max(1000, parseInt(process.env.SCHEDULER_TICK_MS || '10000', 10));
const STALE_THRESHOLD_S = Math.max(10, parseInt(process.env.SCHEDULER_STALE_THRESHOLD_S || '90', 10));
const HEARTBEAT_CHECK_MS = Math.max(5000, parseInt(process.env.SCHEDULER_HEARTBEAT_CHECK_MS || '30000', 10));
const MESSAGE_DELIVERY_MS = Math.max(5000, parseInt(process.env.SCHEDULER_MESSAGE_DELIVERY_MS || '15000', 10));
const PRUNE_INTERVAL_MS = Math.max(60000, parseInt(process.env.SCHEDULER_PRUNE_MS || '3600000', 10));
const BACKUP_INTERVAL_MS = Math.max(60000, parseInt(process.env.SCHEDULER_BACKUP_MS || '300000', 10)); // 5 min
let backupEnabled = process.env.SCHEDULER_BACKUP === '1' || process.env.SCHEDULER_BACKUP === 'true';
const LOG_PREFIX = '[scheduler]';

// ── State ───────────────────────────────────────────────────
let running = true;
let lastHeartbeatCheck = 0;
let lastMessageDelivery = 0;
let lastPrune = 0;
let lastBackup = 0;
let lastGatewayCheck = 0;
let gatewayHealthy = true;
let lastRollupBackup = 0;

// ── Logging ─────────────────────────────────────────────────
function log(level, msg, meta) {
  if (level === 'debug' && !process.env.SCHEDULER_DEBUG) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}\n`;
  process.stderr.write(line);
}

const { handleDelivery } = createDeliveryHelpers({
  log,
  resolveDeliveryAlias,
});

// ── Replay orphaned runs on startup ─────────────────────────
async function replayOrphanedRuns() {
  const db = getDb();
  const orphaned = db.prepare(`
    SELECT r.id, r.job_id, r.dispatch_queue_id, r.idempotency_key, j.delivery_guarantee, j.name as job_name, j.schedule_cron, j.schedule_tz, j.run_timeout_ms, j.schedule_kind
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
  `).all();

  if (orphaned.length === 0) return;
  log('info', `Found ${orphaned.length} orphaned run(s) to process`);

  for (const run of orphaned) {
    log('info', `Found orphaned run for ${run.job_name}`, { runId: run.id, jobId: run.job_id });

    // Wrap all per-run operations in a transaction so crash between steps
    // cannot leave the run marked crashed without the corresponding retry enqueued.
    const processOrphan = db.transaction(() => {
      const crashedAt = sqliteNow();

      // Mark old run as crashed
      db.prepare(`UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ?`).run(crashedAt, run.id);
      if (run.dispatch_queue_id) {
        setDispatchStatus(run.dispatch_queue_id, 'done');
      }

      // Release any idempotency key held by the crashed run so replays can reclaim
      if (run.idempotency_key) {
        releaseIdempotencyKey(run.idempotency_key);
        log('info', `Released idempotency key for crashed run`, { runId: run.id, key: run.idempotency_key.slice(0, 8) });
      }

      if (run.delivery_guarantee === 'at-least-once') {
        const replayPatch = {
          last_run_at: crashedAt,
          last_status: 'crashed',
        };
        if (run.schedule_kind !== 'at') {
          replayPatch.next_run_at = nextRunFromCron(run.schedule_cron, run.schedule_tz);
        }
        updateJob(run.job_id, replayPatch);

        // Enqueue a dispatch so the normal dispatch flow creates and executes the replay run
        const replayDispatch = enqueueDispatch(run.job_id, {
          kind: 'retry',
          scheduled_for: sqliteNow(-1000),
          source_run_id: run.id,
          retry_of_run_id: run.id,
        });
        log('info', `Replaying run for ${run.job_name} (at-least-once)`, { oldRunId: run.id, dispatchId: replayDispatch.id });
      } else {
        if (run.schedule_kind === 'at') {
          updateJob(run.job_id, { enabled: false });
          log('info', `Disabled at-job after crash (at-most-once): ${run.job_name}`, { jobId: run.job_id });
        } else {
          const nextRun = nextRunFromCron(run.schedule_cron, run.schedule_tz);
          if (nextRun) {
            updateJob(run.job_id, { next_run_at: nextRun });
          }
        }
        log('info', `Marked crashed: ${run.job_name} (at-most-once)`, { runId: run.id });
      }
    });
    processOrphan();
  }
}

function reconcileQueuedRetrySchedules() {
  const db = getDb();
  const queuedRetries = db.prepare(`
    SELECT DISTINCT
      j.id,
      j.name,
      j.parent_id,
      j.schedule_kind,
      j.schedule_cron,
      j.schedule_tz,
      j.next_run_at,
      j.schedule_at,
      j.last_run_at
    FROM jobs j
    JOIN job_dispatch_queue q ON q.job_id = j.id
    WHERE q.dispatch_kind = 'retry'
      AND q.status IN ('pending', 'claimed', 'awaiting_approval')
      AND j.enabled = 1
      AND j.parent_id IS NULL
  `).all();

  if (queuedRetries.length === 0) return;

  const now = Date.now();
  const parseMaybeDate = (value) => {
    if (!value || typeof value !== 'string') return null;
    const parsed = value.includes('T')
      ? new Date(value)
      : new Date(value.replace(' ', 'T') + 'Z');
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  for (const job of queuedRetries) {
    const patch = {};
    if (job.schedule_kind === 'at') {
      const scheduledAt = parseMaybeDate(job.schedule_at);
      const lastRunAt = parseMaybeDate(job.last_run_at);
      if (scheduledAt && (!lastRunAt || lastRunAt < scheduledAt)) {
        patch.last_run_at = sqliteNow();
      }
    } else {
      const nextRunAt = parseMaybeDate(job.next_run_at);
      if (nextRunAt && nextRunAt.getTime() <= now) {
        patch.next_run_at = nextRunFromCron(job.schedule_cron, job.schedule_tz);
      }
    }
    if (Object.keys(patch).length === 0) continue;
    updateJob(job.id, patch);
    log('info', `Reconciled root schedule while retry is queued: ${job.name}`, {
      jobId: job.id,
      patch,
    });
  }
}

// ── Triggered Children Helper ───────────────────────────────
/**
 * Fire triggered children for a completed run and track chain idempotency keys.
 * Extracts the duplicated fireTriggeredChildren + pendingChainKeys pattern.
 */
function handleTriggeredChildren(jobId, status, content, runId, logSuffix = '') {
  const triggered = fireTriggeredChildren(jobId, status, content, runId);
  if (triggered.length > 0) {
    log('info', `Triggered ${triggered.length} child job(s)${logSuffix}`, {
      parentId: jobId,
      children: triggered.map(c => c.name),
    });
  }
  return triggered;
}


// ── Build dispatch dependencies bag ─────────────────────────
function buildDispatchDeps() {
  return {
    // Guards + dispatch queue
    claimDispatch, releaseDispatch, setDispatchStatus,
    countPendingApprovalsForJob, getPendingApproval,
    createApproval, createRun, getRun,
    hasRunningRunForPool, hasRunningRun,
    enqueueJob, getDispatchBacklogCount,
    generateIdempotencyKey, generateChainIdempotencyKey,
    generateRunNowIdempotencyKey, claimIdempotencyKey,
    finishRun, getDb,
    sqliteNow, adaptiveDeferralMs,
    handleDelivery, advanceNextRun,
    TICK_INTERVAL_MS,
    log,
    // Watchdog
    runShellCommand, updateJob, deleteJob,
    // Main session
    sendSystemEvent, buildExecutionIntentNote,
    // Shell
    normalizeShellResult,
    // Agent
    waitForGateway, updateRunSession, setAgentStatus,
    buildJobPrompt, runAgentTurnWithActivityTimeout,
    updateContextSummary, releaseIdempotencyKey,
    matchesSentinel, detectTransientError,
    listSessions,
    // Finalize
    updateIdempotencyResultHash,
    shouldRetry, scheduleRetry,
    updateJobAfterRun, handleTriggeredChildren,
    dequeueJob,
    // Drain-error retry
    isDrainError, enqueueDispatch, getJob,
    // v0.2 runtime
    resolveIdentity, evaluateTrust, verifyAuthorizationProof,
    evaluateAuthorization, generateEvidence, summarizeCredentialHandoff,
    compareTrustLevels,
    persistV02Outcomes,
    // Provider registry
    getIdentityProvider,
    getAuthorizationProvider,
    getProofVerifier,
  };
}

// ── Dispatch a single job ───────────────────────────────────
async function dispatchJob(job, opts = {}) {
  const deps = buildDispatchDeps();
  const ctx = await prepareDispatch(job, opts, deps);
  if (!ctx) return;
  const result = await executeStrategy(job, ctx, deps);
  await finalizeDispatch(job, ctx, result, deps);
}


// ── Build the prompt sent to the agent ──────────────────────
/**
 * Build the prompt sent to the agent for a given job and run.
 *
 * Side effect: calls markDelivered() on each pending inbox message injected
 * into the prompt, so those messages will not be delivered again.
 */
function buildJobPrompt(job, run) {
  const parts = [`[scheduler:${job.id} ${job.name}]`];
  const executionNote = buildExecutionIntentNote(job);
  if (executionNote) parts.push(`\n${executionNote}`);
  if (job.payload_thinking) {
    parts.push(
      '\n[SYSTEM NOTE — model policy]',
      `Prefer reasoning depth: ${job.payload_thinking}.`,
      '[END SYSTEM NOTE]',
    );
  }

  // Flush preamble for pre_compaction_flush jobs
  if (job.job_class === 'pre_compaction_flush') {
    parts.push('\n[SYSTEM: Pre-compaction flush required]');
    parts.push('Write a structured summary of: active decisions, constraints, task owners, open questions.');
    parts.push('Format as labeled sections. If nothing needs flushing, respond with exactly: NO_FLUSH');
    parts.push('[END SYSTEM]');
  }

  // Global sub-agent scope: instruct the agent to query across all sessions
  if (job.payload_scope === 'global') {
    parts.push(
      '\n[SYSTEM NOTE — scope=global]',
      'This job has cross-session sub-agent visibility enabled.',
      'When you need to list or inspect sub-agents, do NOT use `subagents list`',
      '(which only shows sub-agents spawned by the current session).',
      'Instead, call `sessions_list` with no session filter to enumerate ALL active',
      'sessions across every requester, then filter by session key prefix or agent id.',
      'This lets you observe sub-agents spawned from the main Telegram session or any',
      'other session — not just this isolated scheduler session.',
      '[END SYSTEM NOTE]',
    );
  }

  // Include any pending messages for this agent
  const inbox = getInbox(job.agent_id || 'main', { limit: 5 });
  if (inbox.length > 0) {
    parts.push('\n--- Pending Messages ---');
    for (const msg of inbox) {
      const kindLabel = msg.kind && !['text', 'result', 'status', 'system', 'spawn'].includes(msg.kind)
        ? `[${msg.kind}]${msg.owner ? ` (owner: ${msg.owner})` : ''} `
        : '';
      parts.push(`From: ${msg.from_agent} | ${msg.kind} | ${msg.subject || '(no subject)'}`);
      const bodyExcerpt = msg.body.length > 500
        ? msg.body.slice(0, 500) + '\n[... message truncated]'
        : msg.body;
      if (kindLabel) {
        parts.push(`${kindLabel}${bodyExcerpt}`);
      } else {
        parts.push(bodyExcerpt);
      }
      parts.push('---');
      markDelivered(msg.id);
    }
  }

  // Collect context metadata
  const contextMeta = {
    messages_injected: inbox.length,
    scope: job.payload_scope || 'own',
    job_class: job.job_class || 'standard',
    delivery_guarantee: job.delivery_guarantee || 'at-most-once',
    context_retrieval: job.context_retrieval || 'none',
    execution_intent: job.execution_intent || 'execute',
    execution_read_only: Boolean(job.execution_read_only),
    payload_model: job.payload_model || null,
    payload_thinking: job.payload_thinking || null,
    auth_profile: job.auth_profile || null,
  };

  const triggerContext = buildTriggeredRunContext(run);
  if (triggerContext.text) {
    parts.push(triggerContext.text);
    Object.assign(contextMeta, triggerContext.meta);
  }

  // Add retrieval context if configured
  if (job.context_retrieval && job.context_retrieval !== 'none') {
    try {
      const retrievalCtx = buildRetrievalContext(job);
      if (retrievalCtx) {
        parts.push(retrievalCtx);
        contextMeta.retrieval_results = (retrievalCtx.match(/\n\[/g) || []).length;
      }
    } catch (err) {
      log('warn', `Retrieval context error for ${job.name}: ${err.message}`);
    }
  }

  // Inject idempotency key for at-least-once jobs
  if (run.idempotency_key && job.delivery_guarantee === 'at-least-once') {
    parts.push(`\n[IDEMPOTENCY KEY: ${run.idempotency_key}]`);
    parts.push('This is an at-least-once job. Before performing side effects, verify this key');
    parts.push('has not already been processed. If you\'ve already handled this exact execution,');
    parts.push('respond with: IDEMPOTENT_SKIP');
  }

  parts.push('\n' + (job.payload_message ?? ''));
  return { prompt: parts.join('\n'), contextMeta };
}

// ── Advance next_run_at ─────────────────────────────────────
function advanceNextRun(job) {
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  updateJob(job.id, { next_run_at: nextRun });
}

// ── Update job state after run ──────────────────────────────
function updateJobAfterRun(job, status) {
  // Re-read from DB to get current state (avoids stale consecutive_errors during retries)
  const freshJob = getJob(job.id);
  if (!freshJob) return; // Job was already deleted (e.g. delete_after_run race)
  const currentErrors = freshJob?.consecutive_errors || 0;
  const patch = { last_run_at: sqliteNow(), last_status: status };

  if (status === 'error' || status === 'timeout') {
    patch.consecutive_errors = currentErrors + 1;
  } else if (status === 'ok') {
    patch.consecutive_errors = 0;
  }

  // At-jobs (one-shot): don't advance cron schedule — delete or disable
  if (freshJob.schedule_kind === 'at') {
    if (freshJob.delete_after_run) {
      updateJob(job.id, patch);
      log('info', `Deleting one-shot at-job: ${job.name}`, { jobId: job.id });
      deleteJob(job.id);
    } else {
      patch.enabled = 0; // Disable so it won't fire again via getDueAtJobs
      updateJob(job.id, patch);
      log('info', `Disabling completed at-job: ${job.name}`, { jobId: job.id });
    }
    return;
  }

  // Cron job: advance schedule
  const nextRun = nextRunFromCron(freshJob.schedule_cron, freshJob.schedule_tz);
  patch.next_run_at = nextRun;

  // Backoff for errors
  if (patch.consecutive_errors > 0 && nextRun) {
    const backoffMs = getBackoffMs(patch.consecutive_errors);
    const backoffDate = new Date(Date.now() + backoffMs);
    const nextDate = new Date(nextRun);
    if (backoffDate > nextDate) patch.next_run_at = backoffDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  updateJob(job.id, patch);

  if (status === 'ok' && freshJob.delete_after_run) {
    log('info', `Deleting one-shot: ${freshJob.name}`);
    deleteJob(freshJob.id);
  }
}

// ── Main tick ───────────────────────────────────────────────
async function tick() {
  const now = Date.now();

  // Gateway health check
  if (!gatewayHealthy || now - lastGatewayCheck >= 60000) {
    lastGatewayCheck = now;
    gatewayHealthy = await checkGatewayHealth();
    if (!gatewayHealthy) {
      log('warn', 'Gateway unreachable — isolated jobs will be deferred; shell/main jobs continue');
    }
  }

  // 1. Dispatch due jobs
  try {
    const dueJobs = getDueJobs();
    for (const job of dueJobs) {
      if (!gatewayHealthy && job.session_target === 'isolated') {
        const deferredAt = new Date(Date.now() + 60000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
        updateJob(job.id, { next_run_at: deferredAt });
        log('info', `Deferred isolated job while gateway is down: ${job.name}`, { jobId: job.id, nextRunAt: deferredAt });
        continue;
      }
      await dispatchJob(job);
    }

    // 1b. Dispatch due at-jobs (one-shot scheduling)
    const dueAtJobs = getDueAtJobs();
    for (const job of dueAtJobs) {
      if (!gatewayHealthy && job.session_target === 'isolated') {
        // Gateway down: skip this tick, at-job will be retried next tick
        // (schedule_at condition still holds, enabled=1 unchanged)
        log('info', `Deferred at-job while gateway is down: ${job.name}`, { jobId: job.id, scheduleAt: job.schedule_at });
        continue;
      }
      await dispatchJob(job);
    }

    const dueDispatches = getDueDispatches();
    for (const dispatchRecord of dueDispatches) {
      const job = getJob(dispatchRecord.job_id);
      if (!job) {
        setDispatchStatus(dispatchRecord.id, 'cancelled');
        continue;
      }
      if (!job.enabled && dispatchRecord.dispatch_kind !== 'manual') {
        setDispatchStatus(dispatchRecord.id, 'cancelled');
        continue;
      }
      if (!gatewayHealthy && job.session_target === 'isolated') {
        releaseDispatch(dispatchRecord.id, sqliteNow(60000));
        log('info', `Deferred queued dispatch while gateway is down: ${job.name}`, {
          jobId: job.id,
          dispatchId: dispatchRecord.id,
        });
        continue;
      }
      await dispatchJob(job, { dispatchRecord });
    }
  } catch (err) {
    log('error', `Dispatch error: ${err.message}`);
  }

  // 2. Health check + approval gates (every HEARTBEAT_CHECK_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_MS) {
    lastHeartbeatCheck = now;
    try {
      await checkRunHealth({
        log,
        getDb,
        getRunningRuns,
        getStaleRuns,
        getTimedOutRuns,
        finishRun,
        getJob,
        updateJobAfterRun,
        handleDelivery,
        dequeueJob,
        shouldRetry,
        scheduleRetry,
        staleThresholdSeconds: STALE_THRESHOLD_S,
      });
    } catch (err) {
      log('error', `Health check error: ${err.message}`);
    }
    try {
      await checkApprovals({
        log,
        getDb,
        getTimedOutApprovals,
        getJob,
        resolveApproval,
        dispatchJob,
        getDispatch,
        setDispatchStatus,
      });
    } catch (err) {
      log('error', `Approval check error: ${err.message}`);
    }
  }

  // 3. Message delivery + spawn handling (every MESSAGE_DELIVERY_MS)
  if (now - lastMessageDelivery >= MESSAGE_DELIVERY_MS) {
    lastMessageDelivery = now;
    // Handle spawn messages — running jobs can request child job creation
    try {
      const spawnMsgs = getDb().prepare(`
        SELECT * FROM messages WHERE kind = 'spawn' AND delivered_at IS NULL
      `).all();
      for (const msg of spawnMsgs) {
        try {
          const spec = JSON.parse(msg.body);
          if (!spec.payload_message || typeof spec.payload_message !== 'string' || !spec.payload_message.trim()) {
            log('error', `Spawn message missing payload_message`, { msgId: msg.id, fromAgent: msg.from_agent });
            markDelivered(msg.id);
            continue;
          }
          const VALID_SPAWN_SESSION_TARGETS = ['isolated', 'shell'];
          const VALID_SPAWN_DELIVERY_MODES = ['none', 'announce', 'announce-always'];

          let sessionTarget = spec.session_target || 'isolated';
          if (!VALID_SPAWN_SESSION_TARGETS.includes(sessionTarget)) {
            log('warn', `Spawn: invalid session_target "${sessionTarget}", defaulting to "isolated"`, {
              msgId: msg.id, fromAgent: msg.from_agent,
            });
            sessionTarget = 'isolated';
          }

          let deliveryMode = spec.delivery_mode || 'none';
          if (!VALID_SPAWN_DELIVERY_MODES.includes(deliveryMode)) {
            log('warn', `Spawn: invalid delivery_mode "${deliveryMode}", defaulting to "none"`, {
              msgId: msg.id, fromAgent: msg.from_agent,
            });
            deliveryMode = 'none';
          }

          // Wrap job creation + message ack in a transaction so a crash
          // between the two cannot leave an unacked spawn that replays.
          const child = getDb().transaction(() => {
            const c = createJob({
              name: spec.name || `Spawned by ${msg.from_agent}`,
              parent_id: msg.job_id || null,
              schedule_cron: spec.schedule_cron,
              payload_message: spec.payload_message,
              session_target: sessionTarget,
              agent_id: spec.agent_id || msg.to_agent || 'main',
              delivery_mode: deliveryMode,
              delivery_channel: spec.delivery_channel,
              delivery_to: spec.delivery_to,
              delivery_opt_out_reason: spec.delivery_opt_out_reason
                || (deliveryMode === 'none' ? 'spawned-child' : null),
              delete_after_run: spec.delete_after_run !== false ? 1 : 0,
              enabled: true,
              run_timeout_ms: spec.run_timeout_ms || 300_000,
              origin: spec.origin || 'system',
            });
            // Fire immediately
            getDb().prepare(`UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?`).run(c.id);
            markDelivered(msg.id);
            return c;
          })();
          log('info', `Spawned child job: ${child.name}`, { childId: child.id, parentJobId: msg.job_id });
        } catch (e) {
          log('error', `Spawn message parse error: ${e.message}`, { msgId: msg.id, fromAgent: msg.from_agent });
          markDelivered(msg.id); // Don't retry bad messages
        }
      }
    } catch (err) {
      log('error', `Spawn handler error: ${err.message}`);
    }
    try {
      const mapped = mapTeamMessages(200);
      if (mapped > 0) {
        log('debug', `Team adapter mapped ${mapped} message(s)`);
      }
    } catch (err) {
      log('error', `Team adapter map error: ${err.message}`);
    }
    try {
      const gates = checkTeamTaskGates(100);
      if (gates.passed > 0 || gates.failed > 0) {
        log('info', `Team task gates updated`, gates);
      } else if (gates.pending > 0) {
        log('debug', `Team task gates pending`, gates);
      }
    } catch (err) {
      log('error', `Team gate check error: ${err.message}`);
    }
    try {
      expireStaleMessages({ expireMessages });
    } catch (err) {
      log('error', `Message delivery error: ${err.message}`);
    }
    try {
      await checkTaskTrackers({
        log,
        getDb,
        getAllSubAgentSessions,
        touchAgentHeartbeat,
        checkDeadAgents,
        listActiveTaskGroups,
        checkGroupCompletion,
        getTaskGroupStatus,
        resolveDeliveryAlias,
        deliverMessage,
      });
    } catch (err) {
      log('error', `Task tracker error: ${err.message}`);
    }
  }

  // 4. Prune (hourly)
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    try {
      pruneRuns(100);
      pruneMessages(30);
      pruneApprovals(30);
      pruneIdempotencyLedger();
      const expiredCount = pruneExpiredJobs();
      if (expiredCount > 0) log('info', `Pruned ${expiredCount} expired disabled job(s)`);
      // Ensure inbox consumer jobs exist for agents with delivery config
      ensureAgentInboxJobs({ log, getDb, createJob });
      // Checkpoint WAL to disk — reduces data loss window on crash/SIGKILL
      const cpResult = checkpointWal();
      if (cpResult) {
        log('debug', `WAL checkpoint: log=${cpResult.log}, checkpointed=${cpResult.checkpointed}, busy=${cpResult.busy}`);
      }
      log('info', 'Pruned old runs + messages');
    } catch (err) {
      log('error', `Prune error: ${err.message}`);
    }
  }

  // 5. Backup to MinIO (every BACKUP_INTERVAL_MS, default 5 min; set SCHEDULER_BACKUP=1 to enable)
  if (backupEnabled && now - lastBackup >= BACKUP_INTERVAL_MS) {
    lastBackup = now;
    const isRollup = now - lastRollupBackup >= 3600000;
    if (isRollup) lastRollupBackup = now;
    const mode = isRollup ? 'rollup' : 'snapshot';
    // Run backup in a child process without blocking the event loop
    const { execFile } = await import('child_process');
    execFile(process.execPath, [join(__dirname, 'backup.js'), mode], {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (err, _stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        if (msg.includes('not found') || msg.includes('ENOENT')) {
          log('warn', `Backup disabled: mc binary not found. Install mc to use backups.`);
          backupEnabled = false;
        } else {
          log('error', `Backup failed: ${msg}`);
        }
      } else {
        log('debug', `Backup ${mode} completed`);
      }
    });
  }
}

// ── Lifecycle ───────────────────────────────────────────────
function shutdown(signal) {
  log('info', `Shutting down (${signal})`);
  running = false;
  try {
    // Force WAL checkpoint before close to ensure all data is in main DB
    const cpResult = checkpointWal();
    if (cpResult) {
      log('info', `Shutdown WAL checkpoint: log=${cpResult.log}, checkpointed=${cpResult.checkpointed}, busy=${cpResult.busy}`);
    }
  } catch (err) {
    log('error', `Shutdown checkpoint failed: ${err.message}`);
  }
  closeDb();
  log('info', 'Shutdown complete');
  process.exit(0);
}

// ── Startup repair ─────────────────────────────────────────
/**
 * Find enabled root cron jobs with NULL next_run_at and recompute their schedule.
 * Guards against insertion bugs (e.g. via direct DB write or a CLI code-path that
 * skips nextRunFromCron) that leave a job permanently dormant.
 */
function repairNullNextRunAt() {
  const db = getDb();
  const broken = db.prepare(`
    SELECT id, name, schedule_cron, schedule_tz
    FROM jobs
    WHERE enabled = 1
      AND next_run_at IS NULL
      AND parent_id IS NULL
      AND schedule_cron IS NOT NULL
      AND schedule_cron != '0 0 31 2 *'
  `).all();

  if (broken.length === 0) return;

  const fix = db.prepare(`UPDATE jobs SET next_run_at = ? WHERE id = ?`);
  for (const job of broken) {
    const next = nextRunFromCron(job.schedule_cron, job.schedule_tz || 'UTC');
    if (next) {
      fix.run(next, job.id);
      log('warn', `Repaired null next_run_at for job "${job.name}" → ${next}`);
    }
  }
}

async function main() {
  log('info', `Starting OpenClaw Scheduler v${SCHEDULER_VERSION}`, {
    tickMs: TICK_INTERVAL_MS,
    staleThresholdS: STALE_THRESHOLD_S,
    heartbeatCheckMs: HEARTBEAT_CHECK_MS,
  });

  await initDb();

  // Load provider plugins if configured
  if (process.env.SCHEDULER_PROVIDER_PATH) {
    await loadProviders(process.env.SCHEDULER_PROVIDER_PATH);
  }

  // Register default agent
  upsertAgent('main', { name: 'Main Agent', status: 'idle', capabilities: ['*'] });

  log('info', 'Database initialized');

  // Replay orphaned runs from previous crash (delivery guarantee support)
  await replayOrphanedRuns();
  reconcileQueuedRetrySchedules();

  // Repair any enabled cron jobs with NULL next_run_at (scheduling bug defence)
  repairNullNextRunAt();

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
