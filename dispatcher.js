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

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb, getDb, checkpointWal } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { getDueJobs, hasRunningRun, hasRunningRunForPool, updateJob, nextRunFromCron, deleteJob, getJob, pruneExpiredJobs, fireTriggeredChildren, createJob, shouldRetry, scheduleRetry, enqueueJob, dequeueJob } from './jobs.js';
import {
  createRun, finishRun, getStaleRuns, getTimedOutRuns, getRunningRuns,
  updateHeartbeat, updateRunSession, pruneRuns, updateContextSummary
} from './runs.js';
import {
  sendMessage as queueMessage, getInbox, markDelivered, markRead,
  expireMessages, pruneMessages, getUnreadCount
} from './messages.js';
import {
  createApproval, getPendingApproval, listPendingApprovals,
  resolveApproval, getTimedOutApprovals, pruneApprovals
} from './approval.js';
import { buildRetrievalContext } from './retrieval.js';
import { upsertAgent, setAgentStatus, touchAgent, getAgent } from './agents.js';
import {
  runAgentTurn, sendSystemEvent, listSessions, deliverMessage, checkGatewayHealth,
  resolveDeliveryAlias
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
const BACKUP_INTERVAL_MS = parseInt(process.env.SCHEDULER_BACKUP_MS || '300000', 10); // 5 min
const LOG_PREFIX = '[scheduler]';

// ── State ───────────────────────────────────────────────────
let running = true;
let lastHeartbeatCheck = 0;
let lastMessageDelivery = 0;
let lastPrune = 0;
let lastBackup = 0;
let gatewayHealthy = true;

// ── Logging ─────────────────────────────────────────────────
function log(level, msg, meta) {
  if (level === 'debug' && !process.env.SCHEDULER_DEBUG) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} ${LOG_PREFIX} [${level}] ${msg}${metaStr}\n`;
  process.stderr.write(line);
}

// ── Replay orphaned runs on startup ─────────────────────────
async function replayOrphanedRuns() {
  const db = getDb();
  const orphaned = db.prepare(`
    SELECT r.id, r.job_id, j.delivery_guarantee, j.name as job_name, j.schedule_cron, j.schedule_tz, j.run_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
  `).all();

  if (orphaned.length === 0) return;
  log('info', `Found ${orphaned.length} orphaned run(s) to process`);

  for (const run of orphaned) {
    log('info', `Found orphaned run for ${run.job_name}`, { runId: run.id, jobId: run.job_id });

    // Mark old run as crashed
    db.prepare(`UPDATE runs SET status = 'crashed', finished_at = datetime('now') WHERE id = ?`).run(run.id);

    if (run.delivery_guarantee === 'at-least-once') {
      // Create a new run with replay_of pointing to the crashed run
      const newRun = createRun(run.job_id, { run_timeout_ms: run.run_timeout_ms });
      // Set replay_of on the new run (column may exist from migration)
      db.prepare(`UPDATE runs SET replay_of = ? WHERE id = ?`).run(run.id, newRun.id);
      log('info', `Replaying run for ${run.job_name} (at-least-once)`, { oldRunId: run.id, newRunId: newRun.id });
    } else {
      // at-most-once: just advance the schedule
      const nextRun = nextRunFromCron(run.schedule_cron, run.schedule_tz);
      if (nextRun) {
        updateJob(run.job_id, { next_run_at: nextRun });
      }
      log('info', `Marked crashed: ${run.job_name} (at-most-once)`, { runId: run.id });
    }
  }
}

// ── Check approval gates ────────────────────────────────────
async function checkApprovals() {
  // 1. Handle timed-out approvals
  try {
    const timedOut = getTimedOutApprovals();
    for (const approval of timedOut) {
      const job = getJob(approval.job_id);
      if (!job) continue;

      if (approval.approval_auto === 'approve' || job.approval_auto === 'approve') {
        resolveApproval(approval.id, 'approved', 'timeout');
        log('info', `Approval auto-approved (timeout): ${approval.job_name || job.name}`, { approvalId: approval.id });
        // Update run status and dispatch
        if (approval.run_id) {
          getDb().prepare("UPDATE runs SET status = 'pending' WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
        }
        await dispatchJob(job);
      } else {
        // Default: reject on timeout
        resolveApproval(approval.id, 'timed_out', 'timeout');
        if (approval.run_id) {
          getDb().prepare("UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
        }
        log('info', `Approval timed out (rejected): ${approval.job_name || job.name}`, { approvalId: approval.id });
      }
    }
  } catch (err) {
    log('error', `Approval timeout check error: ${err.message}`);
  }

  // 2. Check for newly approved approvals (operator approved via CLI)
  try {
    const db = getDb();
    const approved = db.prepare(`
      SELECT a.*, j.name as job_name
      FROM approvals a
      JOIN jobs j ON a.job_id = j.id
      JOIN runs r ON a.run_id = r.id
      WHERE a.status = 'approved'
        AND r.status IN ('awaiting_approval', 'pending')
    `).all();

    for (const approval of approved) {
      const job = getJob(approval.job_id);
      if (!job) continue;
      log('info', `Dispatching approved job: ${approval.job_name}`, { approvalId: approval.id });
      await dispatchJob(job);
    }
  } catch (err) {
    log('error', `Approval dispatch error: ${err.message}`);
  }
}

// ── Dispatch a single job ───────────────────────────────────
async function dispatchJob(job) {
  // HITL approval gate — if approval_required, block until approved
  if (job.approval_required) {
    const existing = getPendingApproval(job.id);
    if (existing) {
      // Already has a pending approval — skip dispatch, checkApprovals will handle it
      log('debug', `Skipping ${job.name} — awaiting approval`, { approvalId: existing.id });
      return;
    }
    // Check if this is a chain-triggered dispatch (parent_id means it was triggered)
    if (job.parent_id) {
      const run = createRun(job.id, { run_timeout_ms: job.run_timeout_ms });
      // Set run to awaiting_approval
      getDb().prepare("UPDATE runs SET status = 'awaiting_approval' WHERE id = ?").run(run.id);
      const approval = createApproval(job.id, run.id);
      log('info', `Approval required for ${job.name} — awaiting operator`, { approvalId: approval.id, runId: run.id });
      // Send notification via delivery channel
      const msg = `⚠️ Job '${job.name}' requires approval.\nApprove: node cli.js jobs approve ${job.id}\nReject: node cli.js jobs reject ${job.id}`;
      await handleDelivery(job, msg);
      return;
    }
  }

  // Resource pool concurrency check — prevents different jobs from competing for the same resource
  if (job.resource_pool && hasRunningRunForPool(job.resource_pool)) {
    log('info', `Skipping ${job.name} — resource pool '${job.resource_pool}' busy`, { jobId: job.id, pool: job.resource_pool });
    advanceNextRun(job);
    return;
  }

  // Overlap control
  if (hasRunningRun(job.id)) {
    if (job.overlap_policy === 'skip') {
      log('info', `Skipping ${job.name} — previous run still active`, { jobId: job.id });
      advanceNextRun(job);
      return;
    }
    if (job.overlap_policy === 'queue') {
      log('info', `Queueing ${job.name} — previous run still active`, { jobId: job.id });
      enqueueJob(job.id);
      advanceNextRun(job);
      return;
    }
    // 'allow' falls through — dispatch concurrently
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

      // Build prompt and collect context metadata
      const { prompt, contextMeta } = buildJobPrompt(job, run);

      // Store context summary on the run
      try { updateContextSummary(run.id, contextMeta); } catch (_e) { /* column may not exist yet */ }

      const result = await runAgentTurn({
        message: prompt,
        agentId: job.agent_id || 'main',
        sessionKey,
        model: job.payload_model || undefined,
        timeoutMs: (job.payload_timeout_seconds || 120) * 1000,
      });

      // Run completed synchronously via chat completions
      const content = result.content || '';
      const isHeartbeatOk = content.trim() === 'HEARTBEAT_OK' || content.trim().startsWith('HEARTBEAT_OK');

      // Handle NO_FLUSH response for pre_compaction_flush jobs
      const isNoFlush = content.trim() === 'NO_FLUSH';
      if (isNoFlush) {
        log('info', `Flush: nothing to flush for ${job.name}`);
      }

      finishRun(run.id, 'ok', { summary: content.slice(0, 5000) });

      // Mark agent as idle
      if (job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

      // Handle delivery (skip heartbeat-ok and no-flush responses)
      if (job.delivery_mode === 'announce' && !isHeartbeatOk && !isNoFlush && content.trim()) {
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

      // Fire triggered children on success (pass content for trigger_condition evaluation)
      const triggered = fireTriggeredChildren(job.id, 'ok', content);
      if (triggered.length > 0) {
        log('info', `Triggered ${triggered.length} child job(s)`, {
          parentId: job.id,
          children: triggered.map(c => c.name),
        });
      }

      // Drain queued dispatches (overlap_policy=queue)
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name}`);
      }

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

    // Retry logic: check if we should retry before declaring failure
    if (shouldRetry(job, run.id)) {
      const retry = scheduleRetry(job, run.id);
      log('info', `Scheduling retry ${retry.retryCount}/${job.max_retries} in ${retry.delaySec}s`, {
        jobId: job.id, runId: run.id,
      });
      // Store retry count on the run for tracking
      getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(retry.retryCount, run.id);
    } else {
      // Fire triggered children on failure (only after exhausting retries)
      // No content available on error path — condition checks will use empty string
      const triggered = fireTriggeredChildren(job.id, 'error', err.message);
      if (triggered.length > 0) {
        log('info', `Triggered ${triggered.length} child job(s) on failure`, {
          parentId: job.id,
          children: triggered.map(c => c.name),
        });
      }

      // Drain queued dispatches (overlap_policy=queue) even on failure
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after failure)`);
      }

      updateJobAfterRun(job, 'error');
    }
  }
}

// ── Build the prompt sent to the agent ──────────────────────
function buildJobPrompt(job, run) {
  const parts = [`[scheduler:${job.id} ${job.name}]`];

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
      if (kindLabel) {
        parts.push(`${kindLabel}${msg.body.slice(0, 500)}`);
      } else {
        parts.push(msg.body.slice(0, 500));
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
  };

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

  parts.push('\n' + job.payload_message);
  return { prompt: parts.join('\n'), contextMeta };
}

// ── Alias resolution ────────────────────────────────────────
/**
 * Resolve a delivery alias from the delivery_aliases table.
 * Accepts '@name' or bare 'name'. Returns { channel, target } or null.
 */
function resolveAlias(target) {
  if (!target) return null;
  return resolveDeliveryAlias(target);
}

// ── Deliver run output to channel ───────────────────────────
async function handleDelivery(job, content) {
  if (job.delivery_mode !== 'announce') return;
  if (!job.delivery_channel && !job.delivery_to) return;

  let channel = job.delivery_channel;
  let target = job.delivery_to;

  // Resolve alias before delivery (e.g. '@team_room' → telegram/-1000000001)
  if (target) {
    const resolved = resolveAlias(target);
    if (resolved) {
      channel = resolved.channel;
      target = resolved.target;
      log('info', `Resolved alias '${job.delivery_to}' → ${channel}/${target}`);
    }
  }

  try {
    await deliverMessage(channel, target, content);
    log('info', `Delivered: ${job.name}`, { channel, to: target });
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
  // Re-read from DB to get current state (avoids stale consecutive_errors during retries)
  const freshJob = getJob(job.id);
  const currentErrors = freshJob?.consecutive_errors || 0;
  const patch = { last_run_at: sqliteNow(), last_status: status };

  if (status === 'error' || status === 'timeout') {
    patch.consecutive_errors = currentErrors + 1;
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
    if (job) {
      updateJobAfterRun(job, 'timeout');
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after stale timeout)`);
      }
    }
  }

  // Absolute timeout
  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    log('warn', `Timed out: ${run.job_name}`, { runId: run.id, timeoutMs: run.run_timeout_ms });
    finishRun(run.id, 'timeout', {
      error_message: `Exceeded ${run.run_timeout_ms}ms timeout`,
    });
    const job = getJob(run.job_id);
    if (job) {
      updateJobAfterRun(job, 'timeout');
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after absolute timeout)`);
      }
    }
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

  // 2. Health check + approval gates (every HEARTBEAT_CHECK_MS)
  if (now - lastHeartbeatCheck >= HEARTBEAT_CHECK_MS) {
    lastHeartbeatCheck = now;
    try { await checkRunHealth(); } catch (err) {
      log('error', `Health check error: ${err.message}`);
    }
    try { await checkApprovals(); } catch (err) {
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
          const child = createJob({
            name: spec.name || `Spawned by ${msg.from_agent}`,
            parent_id: msg.job_id || null,
            schedule_cron: spec.schedule_cron,
            payload_message: spec.payload_message,
            session_target: spec.session_target || 'isolated',
            agent_id: spec.agent_id || msg.to_agent || 'main',
            delivery_mode: spec.delivery_mode || 'none',
            delivery_channel: spec.delivery_channel,
            delivery_to: spec.delivery_to,
            delete_after_run: spec.delete_after_run !== false ? 1 : 0,
            enabled: true,
          });
          // Fire immediately
          getDb().prepare(`UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?`).run(child.id);
          markDelivered(msg.id);
          log('info', `Spawned child job: ${child.name}`, { childId: child.id, parentJobId: msg.job_id });
        } catch (e) {
          log('error', `Spawn message parse error: ${e.message}`);
          markDelivered(msg.id); // Don't retry bad messages
        }
      }
    } catch (err) {
      log('error', `Spawn handler error: ${err.message}`);
    }
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
      pruneApprovals(30);
      const expiredCount = pruneExpiredJobs();
      if (expiredCount > 0) log('info', `Pruned ${expiredCount} expired disabled job(s)`);
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

  // 5. Backup to MinIO (every BACKUP_INTERVAL_MS, default 5 min)
  if (now - lastBackup >= BACKUP_INTERVAL_MS) {
    lastBackup = now;
    try {
      const isRollup = new Date().getMinutes() < (BACKUP_INTERVAL_MS / 60000);
      const mode = isRollup ? 'rollup' : 'snapshot';
      const { execSync } = await import('child_process');
      execSync(`node "${join(__dirname, 'backup.js')}" ${mode}`, {
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log('debug', `Backup ${mode} completed`);
    } catch (err) {
      log('error', `Backup failed: ${err.stderr?.toString()?.trim() || err.message}`);
    }
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

  // Replay orphaned runs from previous crash (delivery guarantee support)
  await replayOrphanedRuns();

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
