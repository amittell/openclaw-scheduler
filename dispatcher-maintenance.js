import { createHash } from 'node:crypto';
import { transitionRunTerminal } from './run-state.js';
import { persistTerminalEvidence, quarantineRunRecovery } from './runs.js';
import { pruneTerminalDeliveries } from './delivery-outbox.js';

// Shared with lifecycle tests through static imports; importing this module does not start the service.
export function createScheduleBookkeeping({
  getDb, getJob, updateJob, deleteJob, sqliteNow, nextRunFromCron, getBackoffMs, log,
}) {
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

  return { updateJobAfterRun, scheduledDispatchId };
}

export function pruneDeliveryHistory({
  log,
  getDb,
  retentionDays,
  limit,
  artifactsDir,
  pruneDeliveries = pruneTerminalDeliveries,
}) {
  if (typeof getDb !== 'function') throw new Error('getDb is required');
  const result = pruneDeliveries({
    db: getDb(),
    retentionDays,
    limit,
    artifactsDir,
  });
  if (result.pruned > 0 && typeof log === 'function') {
    log('info', `Pruned ${result.pruned} terminal delivery outbox row(s)`, {
      attachmentRowsPruned: result.attachmentRowsPruned,
      attachmentBytesPruned: result.attachmentBytesPruned,
      filesRemoved: result.filesRemoved,
      directoriesRemoved: result.directoriesRemoved,
      cutoff: result.cutoff,
    });
  }
  if (result.skippedUnsafePaths > 0 && typeof log === 'function') {
    log('warn', `Skipped ${result.skippedUnsafePaths} unsafe delivery attachment path(s) during pruning`);
  }
  return result;
}

const RECONCILABLE_TERMINAL_STATUSES = [
  'ok',
  'error',
  'timeout',
  'skipped',
  'cancelled',
  'crashed',
];

export function reconcileCompletedDueSchedules({
  log,
  getDb,
  getDueJobs,
  getDueAtJobs,
  getDispatch,
  scheduledDispatchId,
  updateJobAfterRun,
}) {
  const db = getDb();
  const terminalRunForDispatch = db.prepare(`
    SELECT id, status
    FROM runs
    WHERE dispatch_queue_id = ?
      AND status IN (${RECONCILABLE_TERMINAL_STATUSES.map(() => '?').join(', ')})
    ORDER BY COALESCE(terminal_transition_at, finished_at, started_at) DESC, id DESC
    LIMIT 1
  `);
  const dueSchedules = [
    ...getDueJobs().map(job => ({ job, kind: 'schedule', scheduledFor: job.next_run_at })),
    ...getDueAtJobs().map(job => ({ job, kind: 'at', scheduledFor: job.schedule_at })),
  ];
  let repaired = 0;
  for (const { job, kind, scheduledFor } of dueSchedules) {
    if (!scheduledFor) continue;
    const dispatch = getDispatch(scheduledDispatchId(job.id, kind, scheduledFor));
    if (!dispatch || dispatch.status !== 'done') continue;
    const terminalRun = terminalRunForDispatch.get(
      dispatch.id,
      ...RECONCILABLE_TERMINAL_STATUSES,
    );
    if (!terminalRun) continue;
    updateJobAfterRun(job, terminalRun.status);
    repaired += 1;
    log('warn', `Reconciled terminal ${kind} dispatch bookkeeping: ${job.name}`, {
      jobId: job.id,
      runId: terminalRun.id,
      dispatchId: dispatch.id,
      status: terminalRun.status,
      scheduledFor,
    });
  }
  return repaired;
}

export async function checkRunHealth({
  log,
  getDb,
  getRunningRuns,
  getStaleRuns,
  getTimedOutRuns,
  getJob,
  updateJobAfterRun,
  handleDelivery,
  dequeueJob,
  shouldRetry,
  scheduleRetry,
  staleThresholdSeconds,
  dispatcherOwnerId = null,
  dispatcherFencingToken = null,
  transitionRunTerminalFn = transitionRunTerminal,
  activeRunIds = [],
}) {
  if (!(activeRunIds instanceof Set) && !Array.isArray(activeRunIds)) {
    throw new Error('activeRunIds must be a Set or array');
  }
  const activeRunIdSet = activeRunIds instanceof Set ? activeRunIds : new Set(activeRunIds);
  const fencing = dispatcherOwnerId && dispatcherFencingToken
    ? { ownerId: dispatcherOwnerId, fencingToken: dispatcherFencingToken }
    : {};
  const transitionWithEvidence = (run, status, fields, commitTerminalBookkeeping = null) => {
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
    const commit = () => {
      const transition = transitionRunTerminalFn(run.id, status, fields, fencing);
      let terminalBookkeeping = null;
      if (transition?.changed) {
        const job = getJob(run.job_id);
        persistRecoveryEvidence(job, run.id, transition.run.status, fields, {}, { db });
        if (typeof commitTerminalBookkeeping === 'function') {
          terminalBookkeeping = commitTerminalBookkeeping(job, transition);
        }
      }
      return terminalBookkeeping == null
        ? transition
        : { ...transition, terminalBookkeeping };
    };
    const transaction = db.transaction(commit);
    try {
      return db.inTransaction ? transaction() : transaction.immediate();
    } catch (error) {
      if (error?.code !== 'RECOVERY_EVIDENCE_PERSIST_FAILED') throw error;
      const reason = `Recovery could not persist required terminal evidence: ${error.message}`;
      const quarantine = quarantineRunRecovery(run.id, reason, {
        db,
        dispatcherFence: Object.keys(fencing).length > 0 ? {
          ownerId: dispatcherOwnerId,
          fencingToken: dispatcherFencingToken,
        } : null,
      });
      if (quarantine.changed) {
        log('error', `Recovery blocked and job disabled: ${run.job_name}`, {
          runId: run.id,
          jobId: run.job_id,
          evidenceError: error.message,
        });
      }
      return quarantine;
    }
  };
  const commitTimeout = (run, fields) => transitionWithEvidence(
    run,
    'timeout',
    fields,
    job => {
      if (!job) return { job: null, retry: null };
      let retry = null;
      if (shouldRetry(job, run.id)) {
        const candidate = scheduleRetry(job, run.id, { lastStatus: 'timeout' });
        if (candidate && !candidate.skipped) {
          getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?')
            .run(candidate.retryCount, run.id);
          retry = candidate;
        }
      }
      if (!retry) updateJobAfterRun(job, 'timeout');
      return { job, retry };
    },
  );
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  log('debug', `Checking ${runningRuns.length} running run(s)`);

  const staleRuns = getStaleRuns(staleThresholdSeconds);
  for (const run of staleRuns) {
    if (activeRunIdSet.has(run.id)) {
      log('debug', `Deferring stale-run finalization to active execution: ${run.job_name}`, {
        runId: run.id,
      });
      continue;
    }
    log('warn', `Stale run: ${run.job_name}`, { runId: run.id });
    const transition = commitTimeout(run, {
      error_message: `No activity for ${staleThresholdSeconds}s`,
    });
    if (!transition?.changed || transition.run?.status !== 'timeout') {
      log('debug', `Skipped stale timeout side effects after losing terminal transition: ${run.job_name}`, {
        runId: run.id,
        status: transition?.run?.status || null,
      });
      continue;
    }
    const { job, retry } = transition.terminalBookkeeping || {};
    if (!job) continue;
    if (retry) {
      if (['announce', 'announce-always'].includes(job.delivery_mode)) {
        await handleDelivery(
          job,
          `[timeout] Job timed out (stale, will retry): ${job.name}\n\nNo activity for ${staleThresholdSeconds}s\nRetry ${retry.retryCount}/${job.max_retries} in ${retry.delaySec}s`,
          { runId: run.id }
        );
      }
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after stale timeout retry scheduling)`);
      }
      log('info', `Scheduled retry ${retry.retryCount} for timed-out stale run: ${job.name}`, { runId: run.id, delaySec: retry.delaySec });
      continue;
    }
    if (['announce', 'announce-always'].includes(job.delivery_mode)) {
      await handleDelivery(
        job,
        `[timeout] Job timed out (stale): ${job.name}\n\nNo activity for ${staleThresholdSeconds}s`,
        { runId: run.id }
      );
    }
    if (dequeueJob(job.id)) {
      log('info', `Dequeued pending dispatch for ${job.name} (after stale timeout)`);
    }
  }

  const staleRunIds = new Set(staleRuns.map(r => r.id));
  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    if (staleRunIds.has(run.id)) continue; // already handled above
    if (activeRunIdSet.has(run.id)) {
      log('debug', `Deferring timeout finalization to active execution: ${run.job_name}`, {
        runId: run.id,
      });
      continue;
    }
    log('warn', `Timed out: ${run.job_name}`, { runId: run.id, timeoutMs: run.run_timeout_ms });
    const transition = commitTimeout(run, {
      error_message: `Exceeded ${run.run_timeout_ms}ms timeout`,
    });
    if (!transition?.changed || transition.run?.status !== 'timeout') {
      log('debug', `Skipped timeout side effects after losing terminal transition: ${run.job_name}`, {
        runId: run.id,
        status: transition?.run?.status || null,
      });
      continue;
    }
    const { job, retry } = transition.terminalBookkeeping || {};
    if (!job) continue;
    if (retry) {
      if (['announce', 'announce-always'].includes(job.delivery_mode)) {
        await handleDelivery(
          job,
          `[timeout] Job timed out (will retry): ${job.name}\n\nExceeded ${run.run_timeout_ms}ms timeout\nRetry ${retry.retryCount}/${job.max_retries} in ${retry.delaySec}s`,
          { runId: run.id }
        );
      }
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after timeout retry scheduling)`);
      }
      log('info', `Scheduled retry ${retry.retryCount} for timed-out run: ${job.name}`, { runId: run.id, delaySec: retry.delaySec });
      continue;
    }
    if (['announce', 'announce-always'].includes(job.delivery_mode)) {
      await handleDelivery(
        job,
        `[timeout] Job timed out: ${job.name}\n\nExceeded ${run.run_timeout_ms}ms timeout`,
        { runId: run.id }
      );
    }
    if (dequeueJob(job.id)) {
      log('info', `Dequeued pending dispatch for ${job.name} (after absolute timeout)`);
    }
  }
}

export async function checkTaskTrackers({
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
}) {
  try {
    try {
      const db = getDb();
      const activeSessions = await getAllSubAgentSessions(10);
      if (activeSessions.length > 0) {
        for (const session of activeSessions) {
          const sessionKey = session.key || session.sessionKey;
          if (!sessionKey) continue;

          const agent = db.prepare(`
            SELECT a.tracker_id, a.agent_label
            FROM task_tracker_agents a
            JOIN task_tracker t ON a.tracker_id = t.id
            WHERE a.session_key = ? AND a.status IN ('pending', 'running') AND t.status = 'active'
          `).get(sessionKey);

          if (agent) {
            touchAgentHeartbeat(agent.tracker_id, agent.agent_label);
            log('debug', `Auto-heartbeat: ${agent.agent_label} (session active)`);
          }
        }
      }
    } catch (corrErr) {
      log('debug', `Session auto-correlation skipped: ${corrErr.message}`);
    }

    const deadAgents = checkDeadAgents();
    if (deadAgents.length > 0) {
      log('warn', `Marked ${deadAgents.length} dead agent(s)`, {
        agents: deadAgents.map(d => `${d.tracker_id.slice(0, 8)}/${d.agent_label}`),
      });
    }

    const activeGroups = listActiveTaskGroups();
    for (const group of activeGroups) {
      const result = checkGroupCompletion(group.id);
      if (!result) continue;
      const status = getTaskGroupStatus(group.id);
      const statusTag = result.status === 'completed' ? '[ok]' : '[FAILED]';
      const msg = `${statusTag} Task group "${group.name}" ${result.status}\n\n${result.summary || ''}`;
      log('info', `Task group ${result.status}: ${group.name}`, {
        trackerId: group.id,
        status: status?.status || result.status,
      });

      if (group.delivery_channel && group.delivery_to) {
        try {
          let channel = group.delivery_channel;
          let target = group.delivery_to;
          const resolved = resolveDeliveryAlias(target);
          if (resolved) {
            channel = resolved.channel;
            target = resolved.target;
          }
          await deliverMessage(channel, target, msg);
          log('info', `Task tracker summary delivered`, { channel, target, trackerId: group.id });
        } catch (err) {
          log('error', `Task tracker delivery failed: ${err.message}`, { trackerId: group.id });
        }
      }
    }
  } catch (err) {
    log('error', `Task tracker check error: ${err.message}`);
  }
}

export function expireStaleMessages({ expireMessages }) {
  expireMessages();
}

/**
 * Validate that a value does not contain shell metacharacters that could
 * enable injection when interpolated into a shell command string.
 */
function assertSafeShellArg(val, name) {
  if (typeof val !== 'string') return;
  if (/[`$\\;|&<>(){}[\]!#~\n\r]/.test(val)) {
    throw new Error(`${name} contains unsafe shell characters: ${val}`);
  }
}

/**
 * Shell-safe single-quote escaping. Returns a fully-quoted token wrapped
 * in single quotes. Embedded single quotes use the standard bash idiom
 * 'foo'\''bar' which ends the current single-quoted string, inserts an
 * escaped single quote, and reopens single quoting.
 */
function sq(val) {
  return "'" + String(val).replace(/'/g, "'\\''") + "'";
}

export function ensureAgentInboxJobs({ log, getDb, createJob }) {
  try {
    const db = getDb();

    // Find agents with delivery config
    const agents = db.prepare(`
      SELECT id, delivery_channel, delivery_to, brand_name
      FROM agents
      WHERE delivery_channel IS NOT NULL AND delivery_to IS NOT NULL
    `).all();

    if (agents.length === 0) return;

    for (const agent of agents) {
      const jobName = `inbox-consumer:${agent.id}`;

      // Check if job already exists
      const existing = db.prepare('SELECT id FROM jobs WHERE name = ?').get(jobName);
      if (existing) continue;

      // Validate args are free of shell metacharacters before interpolation
      assertSafeShellArg(agent.id, 'agent.id');
      assertSafeShellArg(agent.delivery_to, 'delivery_to');
      assertSafeShellArg(agent.delivery_channel, 'delivery_channel');

      // Use the bin command registered in package.json so the job does not
      // embed an absolute filesystem path that would break after upgrades.
      const consumerCmd = `openclaw-inbox-consumer --agent ${sq(agent.id)} --to ${sq(agent.delivery_to)} --channel ${sq(agent.delivery_channel)}`;

      createJob({
        name:             jobName,
        schedule_cron:    '*/5 * * * *',
        session_target:   'shell',
        payload_kind:     'shellCommand',
        payload_message:  consumerCmd,
        delivery_mode:    'none',
        overlap_policy:   'skip',
        enabled:          1,
        run_timeout_ms:   120_000,  // 2 min: inbox consumer shell script should be fast
        origin:           'system',
      });

      log('info', `Created inbox consumer job: ${jobName} -> ${agent.delivery_channel}:${agent.delivery_to}`);
    }
  } catch (err) {
    log('error', `ensureAgentInboxJobs error: ${err.message}`);
  }
}
