#!/usr/bin/env node
// OpenClaw Scheduler Dispatcher
//
// Full standalone scheduler + message router.
// Dispatches independently via chat completions API.
//
// Tick loop:
//   1. Check gateway health
//   2. Find due jobs -> dispatch via chat completions / system event
//   3. Check running runs for staleness (implicit heartbeat)
//   4. Deliver pending messages
//   5. Expire old messages
//   6. Prune old runs (hourly)

import { readFileSync } from 'fs';
import { createHash } from 'node:crypto';
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
  updateRunSession, pruneRuns, updateContextSummary, persistV02Outcomes,
  persistTerminalEvidence, pruneEvidenceRecords, quarantineRunRecovery,
} from './runs.js';
import {
  resolveIdentity, evaluateTrust, verifyAuthorizationProof,
  evaluateAuthorization, generateEvidence, summarizeCredentialHandoff,
  compareTrustLevels, validateDelegation,
} from './v02-runtime.js';
import {
  markDelivered, claimInboxForRun, ackClaimedInboxForRun,
  releaseClaimedInboxForRun, recoverStaleInboxClaims,
  expireMessages, pruneMessages
} from './messages.js';
import {
  createApproval, getPendingApproval,
  resolveApproval, getTimedOutApprovals, pruneApprovals, countPendingApprovalsForJob,
  getApprovalForDispatch, beginApprovalDispatch,
  markApprovalDispatched, cancelApprovalForDispatch, recoverInterruptedApprovalDispatches,
} from './approval.js';
import { buildRetrievalContext } from './retrieval.js';
import { upsertAgent, setAgentStatus } from './agents.js';
import {
  runAgentTurnWithActivityTimeout, runIsolatedAgentTurn,
  sendSystemEvent, getAllSubAgentSessions, listSessions,
  deliverMessage, checkGatewayHealth, waitForGateway, resolveDeliveryAlias,
  applySessionOverridesToSessionStore,
  cancelAgentSession,
  isAgentCancellationConfirmed,
} from './gateway.js';
import { normalizeShellResult, storeRunArtifact } from './shell-result.js';
import {
  getDispatch, getDueDispatches, claimDispatch, releaseDispatch, setDispatchStatus,
  enqueueDispatch,
} from './dispatch-queue.js';
import { recoverCredentialPresentations } from './credential-runtime.js';
import {
  listActiveTaskGroups, checkDeadAgents, checkGroupCompletion, getTaskGroupStatus,
  touchAgentHeartbeat,
} from './task-tracker.js';
import { mapTeamMessages, checkTeamTaskGates } from './team-adapter.js';
import { buildTriggeredRunContext } from './prompt-context.js';
import {
  runShellCommand,
  terminateProcessTree,
  inspectProcessIdentity,
} from './dispatcher-shell.js';
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
  pruneDeliveryHistory,
  reconcileCompletedDueSchedules,
} from './dispatcher-maintenance.js';
import {
  prepareDispatch,
  executeStrategy,
  finalizeDispatch,
  cleanupDispatchMaterialization,
} from './dispatcher-strategies.js';
import {
  loadProviders, getIdentityProvider, getAuthorizationProvider, getProofVerifier,
  resolveAuthorizationRef,
} from './provider-registry.js';
import {
  evaluateGovernance,
  buildShellEnvironment,
  clearMaterializedEnvironment,
  summarizeGovernance,
} from './governance.js';
import {
  acquireDispatcherLease,
  renewDispatcherLease,
  releaseDispatcherLease,
  assertDispatcherLease,
} from './runtime-lease.js';
import { createDispatcherRuntime, createDispatcherOwnerId } from './dispatcher-runtime.js';
import { loadDispatcherRuntimeConfig } from './runtime-config.js';
import {
  claimRunForDispatch,
  recordRunProcess,
  recordRunProcessTerminated,
  recordRunCredentialCleanupState,
  markAgentCancellationRequested,
  transitionRunTerminal,
  isRunCancellationRequested,
} from './run-state.js';
import {
  completeRunFenced,
  commitCompletionBookkeeping,
  shouldRunPostCompletionEffects,
  classifyPreExecutionAbort,
} from './run-completion.js';
import { drainDeliveryOutbox } from './scripts/inbox-consumer.mjs';

// -- Idempotency Key Wrappers --------------------------------
const generateIdempotencyKey = _genIdemKey;
const generateChainIdempotencyKey = _genChainKey;
const generateRunNowIdempotencyKey = _genRunNowKey;
const claimIdempotencyKey = _claimIdemKey;
const releaseIdempotencyKey = _releaseIdemKey;
const updateIdempotencyResultHash = _updateIdemHash;
const pruneIdempotencyLedger = _pruneIdemLedger;

// -- Config --------------------------------------------------
const dispatcherConfig = loadDispatcherRuntimeConfig(process.env);
const TICK_INTERVAL_MS = dispatcherConfig.tickIntervalMs;
const STALE_THRESHOLD_S = dispatcherConfig.staleThresholdSeconds;
const HEARTBEAT_CHECK_MS = dispatcherConfig.heartbeatCheckMs;
const MESSAGE_DELIVERY_MS = dispatcherConfig.messageDeliveryMs;
const DELIVERY_BATCH_SIZE = dispatcherConfig.deliveryBatchSize;
const PRUNE_INTERVAL_MS = dispatcherConfig.pruneIntervalMs;
const BACKUP_INTERVAL_MS = dispatcherConfig.backupIntervalMs;
const LEASE_TTL_MS = dispatcherConfig.leaseTtlMs;
const MAX_CONCURRENCY = dispatcherConfig.maxConcurrency;
const MAX_PENDING_WORK = dispatcherConfig.maxPending;
const DEBUG_ENABLED = dispatcherConfig.debugEnabled;
let backupEnabled = dispatcherConfig.backupEnabled;
const LOG_PREFIX = '[scheduler]';

// -- State ---------------------------------------------------
let running = true;
let lastHeartbeatCheck = 0;
let lastMessageDelivery = 0;
let lastPrune = 0;
let lastBackup = 0;
let lastGatewayCheck = 0;
let gatewayHealthy = true;
let lastRollupBackup = 0;
let dispatcherRuntime = null;
let shutdownPromise = null;
const activeRunControllers = new Map();

// -- Logging -------------------------------------------------
function log(level, msg, meta) {
  if (level === 'debug' && !DEBUG_ENABLED) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}\n`;
  process.stderr.write(line);
}

const { handleDelivery } = createDeliveryHelpers({
  log,
  resolveDeliveryAlias,
});

function requireDispatcherLeadership(context) {
  if (dispatcherRuntime?.assertLeadership()) return;
  running = false;
  throw new Error(`Dispatcher lease was lost during ${context}; refusing further state transitions`);
}

// -- Replay orphaned runs on startup -------------------------
async function replayOrphanedRuns() {
  const db = getDb();
  const persistRecoveryEvidence = (...args) => {
    try {
      return persistTerminalEvidence(...args);
    } catch (cause) {
      const error = new Error(`Recovery evidence persistence failed: ${cause.message}`, { cause });
      error.code = 'RECOVERY_EVIDENCE_PERSIST_FAILED';
      throw error;
    }
  };
  const orphaned = db.prepare(`
    SELECT r.id, r.job_id, r.dispatch_queue_id, r.idempotency_key,
           r.process_pid, r.process_pgid, r.process_identity,
           r.process_terminated_at, r.session_key, r.context_summary,
           j.delivery_guarantee, j.name as job_name, j.schedule_cron,
           j.schedule_tz, j.run_timeout_ms, j.schedule_kind,
           j.session_target, j.agent_id
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
  `).all();

  if (orphaned.length === 0) return;
  log('info', `Found ${orphaned.length} orphaned run(s) to process`);

  const recoveryFence = () => ({
    ownerId: dispatcherRuntime.ownerId,
    fencingToken: dispatcherRuntime.fencingToken,
  });
  const blockRecovery = (run, reason) => {
    try {
      return db.transaction(() => {
        const blockedAt = sqliteNow();
        const fence = recoveryFence();
        const blocked = db.prepare(`
          UPDATE runs
          SET status = 'recovery_blocked',
              finished_at = ?,
              terminal_transition_at = ?,
              duration_ms = MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)),
              error_message = ?,
              summary = ?
          WHERE id = ?
            AND status = 'running'
            AND EXISTS (
              SELECT 1
              FROM dispatcher_leases
              WHERE name = 'scheduler-dispatcher'
                AND owner_id = ?
                AND fencing_token = ?
                AND julianday(expires_at) > julianday('now')
            )
          RETURNING id
        `).get(blockedAt, blockedAt, reason, reason, run.id, fence.ownerId, fence.fencingToken);
        if (!blocked) return false;
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(run.job_id);
        persistRecoveryEvidence(
          job,
          run.id,
          'recovery_blocked',
          { summary: reason, error_message: reason },
          {},
          { db },
        );
        db.prepare(`
          UPDATE jobs
          SET enabled = 0,
              last_run_at = ?,
              last_status = 'recovery_blocked'
          WHERE id = ?
        `).run(blockedAt, run.job_id);
        if (run.dispatch_queue_id) {
          db.prepare(`
            UPDATE job_dispatch_queue
            SET status = 'failed',
                processed_at = COALESCE(processed_at, ?),
                claim_expires_at = NULL,
                last_error = ?
            WHERE id = ? AND status IN ('pending', 'claimed', 'awaiting_approval')
          `).run(blockedAt, reason, run.dispatch_queue_id);
        }
        return true;
      }).immediate();
    } catch (error) {
      if (error?.code !== 'RECOVERY_EVIDENCE_PERSIST_FAILED') throw error;
      const quarantineReason = `${reason}; required recovery evidence was unavailable: ${error.message}`;
      const quarantine = quarantineRunRecovery(run.id, quarantineReason, {
        db,
        dispatcherFence: recoveryFence(),
        allowStaleRunOwner: true,
      });
      if (quarantine.changed) {
        log('error', `Quarantined recovery without evidence and disabled job: ${run.job_name}`, {
          runId: run.id,
          jobId: run.job_id,
          evidenceError: error.message,
        });
      }
      return quarantine.changed;
    }
  };

  const confirmOriginalStopped = async (run) => {
    if (run.process_pid && !run.process_terminated_at) {
      const observed = inspectProcessIdentity(run.process_pid);
      if (observed.alive) {
        if (!run.process_identity || !observed.identity) {
          return { ok: false, reason: 'Orphan process identity could not be verified safely' };
        }
        if (observed.identity !== run.process_identity) {
          return { ok: false, reason: 'Stored orphan PID was reused by a different process; no signal was sent' };
        }
        const terminated = await terminateProcessTree(
          { pid: run.process_pid, kill: signal => process.kill(run.process_pid, signal) },
          { pgid: run.process_pgid || run.process_pid, graceMs: 2000 },
        );
        requireDispatcherLeadership('orphan process termination');
        if (!terminated) {
          return { ok: false, reason: 'Orphan process tree termination could not be confirmed' };
        }
      }
    }
    if (run.session_key && run.session_target !== 'shell') {
      const cancellation = await cancelAgentSession(run.session_key, {
        agentId: run.agent_id || 'main',
        runId: run.id,
      });
      requireDispatcherLeadership('orphan agent cancellation');
      if (!isAgentCancellationConfirmed(cancellation)) {
        return {
          ok: false,
          reason: `Orphan agent cancellation was not confirmed: ${cancellation.error || 'gateway did not confirm abort'}`,
        };
      }
    }
    return { ok: true };
  };

  for (const run of orphaned) {
    requireDispatcherLeadership('orphan recovery');
    log('info', `Found orphaned run for ${run.job_name}`, { runId: run.id, jobId: run.job_id });

    let termination;
    try {
      termination = await confirmOriginalStopped(run);
    } catch (error) {
      termination = { ok: false, reason: `Orphan termination check failed: ${error.message}` };
    }
    requireDispatcherLeadership('orphan termination confirmation');
    if (!termination.ok) {
      if (blockRecovery(run, termination.reason)) {
        log('error', `Blocked orphan replay and disabled job: ${run.job_name}`, {
          runId: run.id,
          jobId: run.job_id,
          reason: termination.reason,
        });
      }
      continue;
    }

    let credentialCleanup;
    try {
      credentialCleanup = run.context_summary
        ? JSON.parse(run.context_summary)?.credential_cleanup || null
        : null;
    } catch {
      credentialCleanup = String(run.context_summary || '').includes('credential_cleanup')
        ? { status: 'pending', error: 'invalid cleanup safety metadata' }
        : null;
    }
    const credentialPresentationRows = db.prepare(`
      SELECT status, last_error FROM credential_presentations WHERE run_id = ?
    `).all(run.id);
    const presentationFailure = credentialPresentationRows.find(row => row.status === 'failed');
    const presentationsRecovered = credentialPresentationRows.length > 0
      && credentialPresentationRows.every(row => ['cleaned', 'recovery_cleaned'].includes(row.status));
    if (presentationsRecovered && credentialCleanup?.status === 'pending') {
      credentialCleanup = { ...credentialCleanup, status: 'recovery_cleaned', error: null };
      let context;
      try { context = JSON.parse(run.context_summary || '{}'); } catch { context = {}; }
      context.credential_cleanup = credentialCleanup;
      db.prepare('UPDATE runs SET context_summary = ? WHERE id = ?').run(JSON.stringify(context), run.id);
    }
    if (presentationFailure || ['pending', 'failed'].includes(credentialCleanup?.status)) {
      const reason = presentationFailure
        ? `Credential recovery cleanup failed: ${presentationFailure.last_error || 'unknown failure'}`
        : credentialCleanup.status === 'failed'
        ? `Credential cleanup failed before recovery${credentialCleanup.error ? `: ${credentialCleanup.error}` : ''}`
        : 'Credential cleanup could not be confirmed before recovery';
      if (blockRecovery(run, reason)) {
        log('error', `Blocked orphan replay after unresolved credential cleanup: ${run.job_name}`, {
          runId: run.id,
          jobId: run.job_id,
          cleanupStatus: presentationFailure ? 'failed' : credentialCleanup?.status || null,
        });
      }
      continue;
    }

    // Wrap all per-run operations in a transaction so crash between steps
    // cannot leave the run marked crashed without the corresponding retry enqueued.
    const processOrphan = db.transaction(() => {
      const crashedAt = sqliteNow();
      const crashReason = 'Recovered after dispatcher lease expiry';

      // Mark old run as crashed
      const transitioned = db.prepare(`
        UPDATE runs
        SET status = 'crashed',
            finished_at = ?,
            terminal_transition_at = ?,
            summary = COALESCE(summary, ?),
            error_message = COALESCE(error_message, ?),
            process_terminated_at = CASE
              WHEN process_pid IS NOT NULL THEN COALESCE(process_terminated_at, ?)
              ELSE process_terminated_at
            END
        WHERE id = ? AND status = 'running'
        RETURNING id
      `).get(crashedAt, crashedAt, crashReason, crashReason, crashedAt, run.id);
      if (!transitioned) return { changed: false, replayDispatch: null };
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(run.job_id);
      persistRecoveryEvidence(
        job,
        run.id,
        'crashed',
        { summary: crashReason, error_message: crashReason },
        {},
        { db },
      );
      if (run.dispatch_queue_id) {
        db.prepare(`
          UPDATE job_dispatch_queue
          SET status = 'done',
              processed_at = COALESCE(processed_at, ?),
              claim_expires_at = NULL,
              last_error = COALESCE(last_error, 'Recovered after dispatcher lease expiry')
          WHERE id = ? AND status IN ('claimed', 'awaiting_approval')
        `).run(crashedAt, run.dispatch_queue_id);
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
          id: `replay-${run.id}`,
          kind: 'retry',
          scheduled_for: sqliteNow(-1000),
          source_run_id: run.id,
          retry_of_run_id: run.id,
          replay_of_run_id: run.id,
        });
        return { changed: true, replayDispatch };
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
        return { changed: true, replayDispatch: null };
      }
    });
    let recovery;
    try {
      recovery = processOrphan();
    } catch (error) {
      if (error?.code !== 'RECOVERY_EVIDENCE_PERSIST_FAILED') throw error;
      const reason = `Orphan recovery could not persist its terminal record: ${error.message}`;
      blockRecovery(run, reason);
      log('error', `Blocked orphan replay after terminal persistence failure: ${run.job_name}`, {
        runId: run.id,
        jobId: run.job_id,
        error: error.message,
      });
      continue;
    }
    if (!recovery.changed) continue;
    if (recovery.replayDispatch) {
      log('info', `Replaying run for ${run.job_name} (at-least-once)`, {
        oldRunId: run.id,
        dispatchId: recovery.replayDispatch.id,
      });
    } else {
      log('info', `Marked crashed: ${run.job_name} (at-most-once)`, { runId: run.id });
    }
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

// -- Triggered Children Helper -------------------------------
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


// -- Build dispatch dependencies bag -------------------------
function buildDispatchDeps(dispatcherFence = null) {
  const queueClaimOpts = (id) => {
    if (!dispatcherFence) return {};
    const record = getDispatch(id);
    if (!record?.claim_owner) return {};
    if (record.claim_owner === dispatcherFence.ownerId && record.claim_token) {
      return { ownerId: dispatcherFence.ownerId, claimToken: record.claim_token };
    }
    // Supply this dispatcher's identity so a claim held by another owner can
    // never fall through to the legacy unowned update path.
    return { ownerId: dispatcherFence.ownerId, claimToken: 'fenced-out' };
  };
  const claimDispatchForRuntime = (id) => claimDispatch(id, dispatcherFence
    ? { ownerId: dispatcherFence.ownerId, leaseMs: LEASE_TTL_MS }
    : {});
  const releaseDispatchForRuntime = (id, scheduledFor = null, opts = {}) => releaseDispatch(
    id,
    scheduledFor,
    { ...opts, ...queueClaimOpts(id) },
  );
  const setDispatchStatusForRuntime = (id, status, opts = {}) => setDispatchStatus(
    id,
    status,
    { ...opts, ...queueClaimOpts(id) },
  );
  const createRunForRuntime = (jobId, opts = {}) => {
    const ownsExecution = dispatcherFence && opts.status !== 'awaiting_approval';
    return createRun(jobId, ownsExecution ? {
      ...opts,
      ownerId: dispatcherFence.ownerId,
      fencingToken: dispatcherFence.fencingToken,
    } : opts);
  };
  const finishRunForRuntime = (runId, status, fields = {}) => {
    const current = getRun(runId);
    if (current?.dispatcher_owner) {
      return finishRun(runId, status, {
        ...fields,
        ownerId: dispatcherFence?.ownerId || 'fenced-out',
        fencingToken: dispatcherFence?.fencingToken || Number.MAX_SAFE_INTEGER,
      });
    }
    return finishRun(runId, status, fields);
  };

  return {
    // Guards + dispatch queue
    claimDispatch: claimDispatchForRuntime,
    releaseDispatch: releaseDispatchForRuntime,
    setDispatchStatus: setDispatchStatusForRuntime,
    countPendingApprovalsForJob, getPendingApproval,
    createApproval, getApprovalForDispatch, beginApprovalDispatch,
    markApprovalDispatched, cancelApprovalForDispatch,
    createRun: createRunForRuntime, getRun,
    hasRunningRunForPool, hasRunningRun,
    enqueueJob, getDispatchBacklogCount,
    generateIdempotencyKey, generateChainIdempotencyKey,
    generateRunNowIdempotencyKey, claimIdempotencyKey,
    finishRun: finishRunForRuntime, getDb,
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
    buildJobPrompt, markDelivered, claimInboxForRun, ackClaimedInboxForRun,
    releaseClaimedInboxForRun, runAgentTurnWithActivityTimeout,
    // Isolated cron-dispatch primitive: HTTP-only wrapper around the
    // chat-completions API; never forks a sibling openclaw process that
    // could SIGTERM the launchd-tracked gateway parent.
    runIsolatedAgentTurn,
    updateContextSummary, releaseIdempotencyKey,
    matchesSentinel, detectTransientError,
    listSessions,
    applySessionOverridesToSessionStore,
    // Finalize
    storeRunArtifact,
    updateIdempotencyResultHash,
    shouldRetry, scheduleRetry,
    updateJobAfterRun, handleTriggeredChildren,
    dequeueJob,
    // Drain-error retry
    isDrainError, enqueueDispatch, getJob,
    // v0.2 runtime
    resolveIdentity, evaluateTrust, verifyAuthorizationProof,
    evaluateAuthorization, generateEvidence, summarizeCredentialHandoff,
    compareTrustLevels, validateDelegation,
    persistV02Outcomes,
    // Provider registry
    getIdentityProvider,
    getAuthorizationProvider,
    getProofVerifier,
    resolveAuthorizationRef,
    // Enforceable governance
    evaluateGovernance,
    buildShellEnvironment,
    clearMaterializedEnvironment,
    summarizeGovernance,
    // Run ownership and atomic completion
    dispatcherFence,
    claimRunForDispatch,
    recordRunProcess,
    recordRunProcessTerminated,
    recordRunCredentialCleanupState,
    transitionRunTerminal,
    isRunCancellationRequested,
    cancelAgentSession,
    markAgentCancellationRequested,
    completeRunFenced,
    commitCompletionBookkeeping,
    shouldRunPostCompletionEffects,
  };
}

// -- Dispatch a single job -----------------------------------
function abortActiveRun(runId, reason = 'Run cancellation requested', abortKind = 'lifecycle') {
  const active = activeRunControllers.get(runId);
  if (!active) return false;
  if (!active.abortKind) active.abortKind = abortKind;
  if (active.ctx) active.ctx.abortKind = active.abortKind;
  if (!active.controller.signal.aborted) active.controller.abort(new Error(reason));
  const current = getRun(runId);
  if (!active.gatewayAbortSent && current?.session_key && active.job.session_target !== 'shell') {
    active.gatewayAbortSent = true;
    const dispatcherFence = active.ctx?.dispatcherFence || active.dispatcherFence || {};
    markAgentCancellationRequested(runId, dispatcherFence);
    void cancelAgentSession(current.session_key, {
      agentId: active.job.agent_id || 'main',
      runId,
    }).then(outcome => {
      if (!outcome.ok) {
        log('warn', `Gateway cancellation was not confirmed for ${active.job.name}`, {
          runId,
          error: outcome.error || null,
        });
      }
    });
  }
  return true;
}

async function dispatchJob(job, opts = {}) {
  const deps = buildDispatchDeps(opts.dispatcherFence || null);
  deps.onVerificationStart = (runId, timeoutMs) => {
    const active = activeRunControllers.get(runId);
    if (!active) return;
    active.phase = 'verification';
    active.verificationStartedAt = Date.now();
    active.verificationTimeoutMs = timeoutMs;
  };
  deps.onVerificationEnd = (runId) => {
    const active = activeRunControllers.get(runId);
    if (!active) return;
    active.phase = 'finalizing';
    active.verificationStartedAt = null;
    active.verificationTimeoutMs = null;
  };
  const controller = new AbortController();
  let preparedRunId = null;
  deps.onRunPrepared = (run) => {
    preparedRunId = run.id;
    activeRunControllers.set(run.id, {
      controller,
      job,
      ctx: null,
      dispatcherFence: opts.dispatcherFence || null,
      gatewayAbortSent: false,
      abortKind: null,
      phase: 'preparing',
    });
  };
  let ctx;
  try {
    ctx = await prepareDispatch(job, opts, deps);
  } catch (error) {
    if (preparedRunId) activeRunControllers.delete(preparedRunId);
    throw error;
  }
  if (!ctx) {
    if (preparedRunId) activeRunControllers.delete(preparedRunId);
    return;
  }
  ctx.abortSignal = controller.signal;
  activeRunControllers.set(ctx.run.id, {
    controller,
    job,
    ctx,
    dispatcherFence: opts.dispatcherFence || null,
    gatewayAbortSent: false,
    abortKind: activeRunControllers.get(ctx.run.id)?.abortKind || null,
    phase: 'execution',
  });
  const observeCancellation = () => {
    if (!isRunCancellationRequested(ctx.run.id)) return;
    const reason = getRun(ctx.run.id)?.cancel_reason || 'Run cancellation requested';
    abortActiveRun(ctx.run.id, reason, 'operator');
  };
  observeCancellation();
  const cancellationPoll = setInterval(observeCancellation, 200);
  cancellationPoll.unref?.();
  try {
    const currentRun = getRun(ctx.run.id);
    if (currentRun?.status !== 'running') {
      log('warn', `Skipping execution because prepared run is already terminal: ${job.name}`, {
        jobId: job.id,
        runId: ctx.run.id,
        status: currentRun?.status || 'missing',
      });
      return;
    }
    if (controller.signal.aborted) {
      const active = activeRunControllers.get(ctx.run.id);
      const disposition = classifyPreExecutionAbort(currentRun, active?.abortKind);
      if (disposition === 'recover') {
        log('info', `Preserving prepared run for startup recovery: ${job.name}`, {
          jobId: job.id,
          runId: ctx.run.id,
          abortKind: active?.abortKind || 'unknown',
        });
        return;
      }
      const reason = currentRun.cancel_reason
        || controller.signal.reason?.message
        || 'Run cancelled before execution';
      await finalizeDispatch(job, ctx, {
        status: disposition === 'cancel' ? 'cancelled' : 'error',
        summary: reason,
        content: reason,
        errorMessage: reason,
        runFinishFields: {},
        deliveryOverride: null,
        skipDelivery: disposition === 'cancel',
        skipJobUpdate: disposition === 'cancel',
        skipChildren: disposition === 'cancel',
        skipDequeue: disposition === 'cancel',
        skipAgentCleanup: true,
        idemAction: 'release',
        retryFiresChildren: false,
        earlyReturn: false,
      }, deps);
      return;
    }
    const result = await executeStrategy(job, ctx, deps);
    await finalizeDispatch(job, ctx, result, deps);
  } finally {
    clearInterval(cancellationPoll);
    activeRunControllers.delete(ctx.run.id);
    if (ctx.promptClaimedMessageIds?.length > 0) {
      const released = releaseClaimedInboxForRun(
        ctx.run.id,
        ctx.promptClaimedMessageIds,
        { reason: 'Agent turn did not acknowledge claimed prompt messages' },
      );
      if (released.released > 0) {
        log('info', `Released ${released.released} prompt message claim(s) after incomplete turn`, {
          runId: ctx.run.id,
          jobId: job.id,
        });
      }
    }
    // Cleanup is idempotent and also runs from finalizeDispatch for direct API
    // callers. This finally path covers strategy/finalization exceptions.
    const cleaned = await cleanupDispatchMaterialization(job, ctx, deps);
    if (!cleaned) {
      const currentRun = getRun(ctx.run.id);
      if (ctx.preserveForRecovery && currentRun?.status === 'running') {
        log('error', `Credential cleanup failed while preserving run for recovery: ${job.name}`, {
          jobId: job.id,
          runId: ctx.run.id,
          operatorActionRequired: true,
        });
      } else if (currentRun?.status === 'running' && dispatcherRuntime?.assertLeadership()) {
        await finalizeDispatch(job, ctx, {
          status: 'error',
          summary: 'Credential cleanup failed',
          content: 'Credential cleanup failed',
          errorMessage: 'Credential cleanup failed',
          runFinishFields: {},
          deliveryOverride: null,
          skipDelivery: true,
          skipJobUpdate: false,
          skipChildren: true,
          skipDequeue: true,
          skipAgentCleanup: true,
          idemAction: 'release',
          retryFiresChildren: false,
          earlyReturn: false,
        }, deps);
      } else if (currentRun?.status === 'running') {
        log('error', `Credential cleanup failed after dispatcher fence loss: ${job.name}`, {
          jobId: job.id,
          runId: ctx.run.id,
          operatorActionRequired: true,
        });
      }
    }
  }
}


// -- Build the prompt sent to the agent ----------------------
/**
 * Build the prompt sent to the agent for a given job and run.
 *
 * The caller acknowledges injected messages only after the agent turn is
 * accepted. Building a prompt is intentionally side-effect free so gateway
 * failures cannot lose inbox messages.
 */
function buildJobPrompt(job, run) {
  const parts = [`[scheduler:${job.id} ${job.name}]`];
  const executionNote = buildExecutionIntentNote(job);
  if (executionNote) parts.push(`\n${executionNote}`);
  if (job.payload_thinking) {
    parts.push(
      '\n[SYSTEM NOTE -- model policy]',
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
      '\n[SYSTEM NOTE -- scope=global]',
      'This job has cross-session sub-agent visibility enabled.',
      'When you need to list or inspect sub-agents, do NOT use `subagents list`',
      '(which only shows sub-agents spawned by the current session).',
      'Instead, call `sessions_list` with no session filter to enumerate ALL active',
      'sessions across every requester, then filter by session key prefix or agent id.',
      'This lets you observe sub-agents spawned from the main Telegram session or any',
      'other session -- not just this isolated scheduler session.',
      '[END SYSTEM NOTE]',
    );
  }

  // Include any pending messages for this agent.
  // Atomically reserve internal inbox rows for this run. External delivery
  // rows are excluded by claimInboxForRun and can never become prompt text.
  const inbox = claimInboxForRun(job.agent_id || 'main', run.id, { limit: 5 });
  const injectableMessages = inbox.filter(msg => {
    if (msg.status && msg.status !== 'prompt_claimed') {
      log('warn', `buildJobPrompt: skipping unclaimed message ${msg.id} (status=${msg.status}) for agent ${job.agent_id || 'main'}`);
      return false;
    }
    return true;
  });
  if (injectableMessages.length > 0) {
    parts.push('\n--- Pending Messages ---');
    for (const msg of injectableMessages) {
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
    }
  }

  // Collect context metadata
  const contextMeta = {
    messages_injected: injectableMessages.length,
    scope: job.payload_scope || 'own',
    job_class: job.job_class || 'standard',
    delivery_guarantee: job.delivery_guarantee || 'at-most-once',
    context_retrieval: job.context_retrieval || 'none',
    execution_intent: job.execution_intent || 'execute',
    execution_read_only: Boolean(job.execution_read_only),
    payload_model: job.payload_model || null,
    payload_model_fallback: job.payload_model_fallback || null,
    payload_thinking: job.payload_thinking || null,
    auth_profile: job.auth_profile || null,
    auth_profile_fallback: job.auth_profile_fallback || null,
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
  return {
    prompt: parts.join('\n'),
    contextMeta,
    injectedMessageIds: injectableMessages.map(message => message.id),
  };
}

// -- Advance next_run_at -------------------------------------
function advanceNextRun(job) {
  const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
  updateJob(job.id, { next_run_at: nextRun });
}

// -- Update job state after run ------------------------------
function updateJobAfterRun(job, status) {
  // Re-read from DB to get current state (avoids stale consecutive_errors during retries)
  const freshJob = getJob(job.id);
  if (!freshJob) return; // Job was already deleted (e.g. delete_after_run race)
  const currentErrors = freshJob?.consecutive_errors || 0;
  const patch = { last_run_at: sqliteNow(), last_status: status };
  const hasChildren = Boolean(getDb().prepare(
    'SELECT 1 FROM jobs WHERE parent_id = ? LIMIT 1',
  ).get(freshJob.id));

  if (status === 'error' || status === 'timeout') {
    patch.consecutive_errors = currentErrors + 1;
  } else if (status === 'ok') {
    patch.consecutive_errors = 0;
  }

  // At-jobs (one-shot): don't advance cron schedule -- delete or disable
  if (freshJob.schedule_kind === 'at') {
    if (freshJob.delete_after_run && !hasChildren) {
      getDb().transaction(() => {
        updateJob(job.id, patch);
        deleteJob(job.id);
      })();
      log('info', `Deleting one-shot at-job: ${job.name}`, { jobId: job.id });
    } else {
      patch.enabled = 0; // Disable so it won't fire again via getDueAtJobs
      updateJob(job.id, patch);
      log('info', hasChildren
        ? `Disabling completed at-job until its workflow children are retired: ${job.name}`
        : `Disabling completed at-job: ${job.name}`, { jobId: job.id });
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

  if (status === 'ok' && freshJob.delete_after_run && !hasChildren) {
    getDb().transaction(() => {
      updateJob(job.id, patch);
      deleteJob(freshJob.id);
    })();
    log('info', `Deleting one-shot: ${freshJob.name}`);
  } else {
    if (status === 'ok' && freshJob.delete_after_run && hasChildren) patch.enabled = 0;
    updateJob(job.id, patch);
  }
}

function scheduledDispatchId(jobId, kind, scheduledFor) {
  const digest = createHash('sha256')
    .update(`${jobId}\0${kind}\0${scheduledFor}`)
    .digest('hex');
  return `scheduled-${digest}`;
}

function materializeDueSchedules() {
  const materialize = (job, kind, scheduledFor) => {
    if (!scheduledFor) return null;
    const id = scheduledDispatchId(job.id, kind, scheduledFor);
    const existing = getDispatch(id);
    if (existing) return existing;
    const dispatch = enqueueDispatch(job.id, {
      id,
      kind,
      scheduled_for: scheduledFor,
    });
    log('debug', `Materialized due ${kind} dispatch: ${job.name}`, {
      jobId: job.id,
      dispatchId: dispatch.id,
      scheduledFor,
    });
    return dispatch;
  };

  const db = getDb();
  return db.transaction(() => {
    reconcileCompletedDueSchedules({
      log,
      getDb,
      getDueJobs,
      getDueAtJobs,
      getDispatch,
      scheduledDispatchId,
      updateJobAfterRun,
    });
    let created = 0;
    for (const job of getDueJobs()) {
      const before = getDispatch(scheduledDispatchId(job.id, 'schedule', job.next_run_at));
      materialize(job, 'schedule', job.next_run_at);
      if (!before) created += 1;
    }
    for (const job of getDueAtJobs()) {
      const before = getDispatch(scheduledDispatchId(job.id, 'at', job.schedule_at));
      materialize(job, 'at', job.schedule_at);
      if (!before) created += 1;
    }
    return created;
  })();
}

function submitDueDispatches() {
  const dueDispatches = getDueDispatches(Math.max(100, MAX_CONCURRENCY * 8));
  let submitted = 0;
  for (const dispatchRecord of dueDispatches) {
    const accepted = dispatcherRuntime.submit(`dispatch:${dispatchRecord.id}`, async dispatcherFence => {
      const currentDispatch = getDispatch(dispatchRecord.id);
      if (!currentDispatch || currentDispatch.status !== 'pending') return;
      const job = getJob(currentDispatch.job_id);
      if (!job) {
        setDispatchStatus(currentDispatch.id, 'cancelled', { lastError: 'Job no longer exists' });
        return;
      }
      if (!job.enabled) {
        setDispatchStatus(currentDispatch.id, 'cancelled', { lastError: 'Job disabled before dispatch' });
        return;
      }
      if (!gatewayHealthy && job.session_target === 'isolated') {
        getDb().prepare(`
          UPDATE job_dispatch_queue
          SET scheduled_for = ?, last_error = ?
          WHERE id = ? AND status = 'pending'
        `).run(sqliteNow(60000), 'Gateway unavailable; dispatch deferred', currentDispatch.id);
        return;
      }
      await dispatchJob(job, { dispatchRecord: currentDispatch, dispatcherFence });
    });
    if (accepted) submitted += 1;
  }
  return submitted;
}

// -- Main tick -----------------------------------------------
async function tick() {
  const now = Date.now();

  // Gateway health check
  if (!gatewayHealthy || now - lastGatewayCheck >= 60000) {
    lastGatewayCheck = now;
    gatewayHealthy = await checkGatewayHealth();
    if (!gatewayHealthy) {
      log('warn', 'Gateway unreachable -- isolated jobs will be deferred; shell/main jobs continue');
    }
  }

  if (!dispatcherRuntime?.renew()) {
    running = false;
    throw new Error('Dispatcher lease was lost; refusing further state transitions');
  }

  // 1. Materialize every due schedule, then submit durable queue entries to
  // the bounded worker pool. A crash cannot lose a selected due occurrence.
  try {
    const materialized = materializeDueSchedules();
    const submitted = submitDueDispatches();
    if (materialized > 0 || submitted > 0) {
      log('debug', 'Dispatch queue tick', {
        materialized,
        submitted,
        active: dispatcherRuntime.activeCount,
        pending: dispatcherRuntime.pendingCount,
      });
    }
  } catch (err) {
    log('error', `Dispatch error: ${err.message}`);
  }

  // 2. Health check + approval gates (every HEARTBEAT_CHECK_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_MS) {
    lastHeartbeatCheck = now;
    try {
      const healthCandidates = [
        ...getStaleRuns(STALE_THRESHOLD_S),
        ...getTimedOutRuns(),
      ];
      for (const run of healthCandidates) {
        if (activeRunControllers.get(run.id)?.phase === 'verification') continue;
        abortActiveRun(run.id, `Dispatcher health timeout for run ${run.id}`, 'health_timeout');
      }
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
        dispatcherOwnerId: dispatcherRuntime.ownerId,
        dispatcherFencingToken: dispatcherRuntime.fencingToken,
        activeRunIds: new Set(activeRunControllers.keys()),
      });
      requireDispatcherLeadership('run health maintenance');
    } catch (err) {
      log('error', `Health check error: ${err.message}`);
      if (!running) throw err;
    }
    try {
      await checkApprovals({
        log,
        getTimedOutApprovals,
        getJob,
        resolveApproval,
      });
      requireDispatcherLeadership('approval maintenance');
    } catch (err) {
      log('error', `Approval check error: ${err.message}`);
      if (!running) throw err;
    }
  }

  // 3. Message delivery + spawn handling (every MESSAGE_DELIVERY_MS)
  if (now - lastMessageDelivery >= MESSAGE_DELIVERY_MS) {
    lastMessageDelivery = now;
    try {
      const deliveryResult = await drainDeliveryOutbox(getDb(), {
        limit: DELIVERY_BATCH_SIZE,
        brand: 'OpenClaw Scheduler',
        owner: `dispatcher:${dispatcherRuntime.ownerId}`,
        leaseMs: Math.max(120000, MESSAGE_DELIVERY_MS * 4),
        interDeliveryDelayMs: 0,
      });
      if (deliveryResult.delivered > 0) {
        log('info', `Delivered ${deliveryResult.delivered} durable outbox item(s)`);
      }
      for (const error of deliveryResult.errors) {
        log('error', `Durable delivery failed: ${error.message}`);
      }
      requireDispatcherLeadership('durable outbox delivery');
    } catch (err) {
      log('error', `Durable outbox processing error: ${err.message}`);
      if (!running) throw err;
    }
    // Handle spawn messages -- running jobs can request child job creation
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
      requireDispatcherLeadership('task tracker maintenance');
    } catch (err) {
      log('error', `Task tracker error: ${err.message}`);
      if (!running) throw err;
    }
  }

  // 4. Prune (hourly)
  if (now - lastPrune >= PRUNE_INTERVAL_MS) {
    lastPrune = now;
    try {
      pruneRuns(100);
      const prunedEvidence = pruneEvidenceRecords();
      pruneMessages(30);
      pruneApprovals(30);
      pruneIdempotencyLedger();
      pruneDeliveryHistory({ log, getDb });
      const expiredCount = pruneExpiredJobs();
      if (expiredCount > 0) log('info', `Pruned ${expiredCount} expired disabled job(s)`);
      if (prunedEvidence.changes > 0) log('info', `Pruned ${prunedEvidence.changes} expired evidence record(s)`);
      // Ensure inbox consumer jobs exist for agents with delivery config
      ensureAgentInboxJobs({ log, getDb, createJob });
      // Checkpoint WAL to disk -- reduces data loss window on crash/SIGKILL
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
    requireDispatcherLeadership('backup setup');
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

// -- Lifecycle -----------------------------------------------
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    log('info', `Shutting down (${signal})`);
    running = false;
    for (const [runId] of activeRunControllers) {
      abortActiveRun(runId, `Dispatcher shutting down (${signal})`, 'shutdown');
    }
    if (dispatcherRuntime) {
      await dispatcherRuntime.stop({ drain: true });
    }
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
  })();
  return shutdownPromise;
}

// -- Startup repair -----------------------------------------
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
      log('warn', `Repaired null next_run_at for job "${job.name}" -> ${next}`);
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

  dispatcherRuntime = createDispatcherRuntime({
    ownerId: createDispatcherOwnerId(),
    leaseTtlMs: LEASE_TTL_MS,
    maxConcurrency: MAX_CONCURRENCY,
    maxPending: MAX_PENDING_WORK,
    acquireLease: acquireDispatcherLease,
    renewLease: renewDispatcherLease,
    releaseLease: releaseDispatcherLease,
    assertLease: assertDispatcherLease,
    onTaskError: (error, meta) => log('error', `Dispatch worker failed: ${error.message}`, meta),
    onLeaseLost: meta => {
      running = false;
      log('error', 'Dispatcher lease lost; stopping new work', meta);
      for (const [runId] of activeRunControllers) {
        abortActiveRun(runId, 'Dispatcher lease lost', 'lease_lost');
      }
    },
  });
  const acquiredLease = dispatcherRuntime.start();
  if (!acquiredLease) {
    throw new Error('Another live dispatcher owns the scheduler lease');
  }
  log('info', 'Dispatcher lease acquired', {
    ownerId: dispatcherRuntime.ownerId,
    fencingToken: dispatcherRuntime.fencingToken,
    leaseTtlMs: LEASE_TTL_MS,
    maxConcurrency: dispatcherRuntime.maxConcurrency,
  });

  // Load provider plugins if configured
  if (process.env.SCHEDULER_PROVIDER_PATH) {
    await loadProviders(process.env.SCHEDULER_PROVIDER_PATH);
    requireDispatcherLeadership('provider loading');
  }

  // Register default agent
  upsertAgent('main', { name: 'Main Agent', status: 'idle', capabilities: ['*'] });

  log('info', 'Database initialized');

  const recoveredApprovals = recoverInterruptedApprovalDispatches();
  if (recoveredApprovals.recovered > 0) {
    log('warn', `Recovered ${recoveredApprovals.recovered} approval dispatch state(s) before scheduling`);
  }
  requireDispatcherLeadership('startup approval recovery');

  // Remove durable credential presentations before any orphan can be replayed.
  const credentialRecovery = recoverCredentialPresentations({ db: getDb() });
  if (credentialRecovery.failed.length > 0) {
    log('error', `Credential recovery failed for ${credentialRecovery.failed.length} presentation(s)`);
  } else if (credentialRecovery.recovered.length > 0) {
    log('warn', `Recovered ${credentialRecovery.recovered.length} credential presentation(s) before orphan replay`);
  }
  requireDispatcherLeadership('startup credential recovery');

  // Replay orphaned runs from previous crash (delivery guarantee support)
  await replayOrphanedRuns();
  requireDispatcherLeadership('startup orphan recovery');
  const recoveredPromptClaims = recoverStaleInboxClaims({ olderThanSeconds: 0 });
  if (recoveredPromptClaims.recovered > 0) {
    log('info', `Recovered ${recoveredPromptClaims.recovered} abandoned prompt message claim(s)`);
  }
  reconcileQueuedRetrySchedules();

  // Repair any enabled cron jobs with NULL next_run_at (scheduling bug defence)
  repairNullNextRunAt();

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  while (running) {
    await tick();
    await new Promise(r => setTimeout(r, TICK_INTERVAL_MS));
  }
}

main().catch(async err => {
  log('error', `Fatal: ${err.message}`);
  if (dispatcherRuntime) {
    for (const [runId] of activeRunControllers) {
      abortActiveRun(runId, 'Dispatcher fatal shutdown', 'fatal');
    }
    await dispatcherRuntime.stop({ drain: true });
  }
  closeDb();
  process.exit(1);
});
