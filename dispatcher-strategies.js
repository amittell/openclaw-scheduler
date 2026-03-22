// dispatcher-strategies.js
// Strategy pattern for dispatchJob: each execution target returns a DispatchResult,
// and finalizeDispatch processes it uniformly.

/**
 * DispatchResult shape (returned by every strategy):
 * {
 *   status: 'ok' | 'error' | 'skipped',
 *   summary: string,
 *   content: string,              // for delivery + trigger condition eval
 *   errorMessage: string | null,
 *   runFinishFields: object,      // extra fields for finishRun (shell_exit_code, etc.)
 *   deliveryOverride: string | null, // override delivery content (null = use content)
 *   skipDelivery: boolean,        // suppress delivery entirely
 *   skipJobUpdate: boolean,       // strategy handled job state itself
 *   skipChildren: boolean,        // don't fire triggered children
 *   skipDequeue: boolean,         // don't drain overlap queue
 *   idemAction: 'keep' | 'release' | 'noop', // what to do with idempotency key
 *   retryFiresChildren: boolean,  // whether retry path fires triggered children
 *   earlyReturn: boolean,         // finalize should skip everything (strategy fully handled it)
 * }
 */

export function makeDefaultResult() {
  return {
    status: 'ok',
    summary: '',
    content: '',
    errorMessage: null,
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: false,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: false,
    skipAgentCleanup: true,
    idemAction: 'noop',
    retryFiresChildren: false,
    earlyReturn: false,
  };
}

/**
 * Uniform post-execution ceremony. Processes the DispatchResult from any strategy.
 *
 * @param {object} job - The job record
 * @param {object} ctx - DispatchContext from prepareDispatch
 * @param {object} result - DispatchResult from the strategy
 * @param {object} deps - Injected dependencies
 */
export async function finalizeDispatch(job, ctx, result, deps) {
  const {
    finishRun, updateIdempotencyResultHash, releaseIdempotencyKey,
    setAgentStatus, handleDelivery, shouldRetry, scheduleRetry,
    getDb, updateJobAfterRun, setDispatchStatus, handleTriggeredChildren,
    dequeueJob, log,
  } = deps;

  if (result.earlyReturn) return;

  // 1. Finish the run
  finishRun(ctx.run.id, result.status, {
    summary: result.summary,
    error_message: result.errorMessage,
    ...result.runFinishFields,
  });

  // 2. Idempotency key management
  if (ctx.idemKey) {
    if (result.idemAction === 'keep') {
      updateIdempotencyResultHash(ctx.idemKey, result.content);
    } else if (result.idemAction === 'release') {
      releaseIdempotencyKey(ctx.idemKey);
    }
    // 'noop' — leave key claimed without writing result hash
  }

  // 3. Agent status cleanup (only for strategies that set busy)
  if (!result.skipAgentCleanup && job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

  // 4. Delivery
  if (!result.skipDelivery) {
    const deliveryContent = result.deliveryOverride ?? result.content;
    const shouldAnnounce = ['announce', 'announce-always'].includes(job.delivery_mode)
      && deliveryContent?.trim();

    if (shouldAnnounce) {
      if (result.deliveryOverride) {
        await handleDelivery(job, result.deliveryOverride);
      } else if (result.status === 'error') {
        const willRetry = (job.max_retries ?? 0) > 0 && (ctx.run.retry_count || 0) < job.max_retries;
        const retryLabel = willRetry ? 'will retry' : 'no retries configured';
        await handleDelivery(job, `\u26a0\ufe0f Job soft-failed (${retryLabel}): ${job.name}\n\n${deliveryContent}`);
      } else {
        await handleDelivery(job, deliveryContent);
      }
    }
  }

  // 5. Retry on error
  if (result.status === 'error' && shouldRetry(job, ctx.run.id)) {
    const retry = scheduleRetry(job, ctx.run.id);
    if (retry.dispatch) {
      log('info', `Scheduling retry ${retry.retryCount}/${job.max_retries} in ${retry.delaySec}s`, {
        jobId: job.id, runId: ctx.run.id,
      });
      getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(retry.retryCount, ctx.run.id);
      if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
      if (!result.skipDequeue && dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name}`);
      }
      if (result.retryFiresChildren && !result.skipChildren) {
        handleTriggeredChildren(job.id, 'error', result.content, ctx.run.id, ' on soft failure');
      }
      log('info', `${result.status === 'error' ? 'Failed' : 'Completed'}: ${job.name} (retry scheduled)`, { runId: ctx.run.id });
      return; // retry path handles everything
    }
    log('warn', `Retry skipped for ${job.name} -- dispatch backlog limit reached`, {
      jobId: job.id, runId: ctx.run.id,
      maxQueuedDispatches: job.max_queued_dispatches || 25,
    });
    return;
  }

  // 6. Update job state
  if (!result.skipJobUpdate) {
    updateJobAfterRun(job, result.status);
  }

  // 7. Complete dispatch
  if (ctx.dispatchRecord) {
    setDispatchStatus(ctx.dispatchRecord.id, 'done');
  }

  // 8. Triggered children
  if (!result.skipChildren) {
    handleTriggeredChildren(job.id, result.status, result.content, ctx.run.id);
  }

  // 9. Dequeue overlap
  if (!result.skipDequeue && dequeueJob(job.id)) {
    log('info', `Dequeued pending dispatch for ${job.name}`);
  }
}

// ── Phase 1: Guards + run creation ──────────────────────────

/**
 * DispatchContext shape (returned by prepareDispatch):
 * {
 *   dispatchRecord: object | null,
 *   idemKey: string | null,
 *   run: object,               // the created run record
 *   retryCount: number,
 *   dispatchKind: string | null,
 *   isChainDispatch: boolean,
 * }
 */

/**
 * Phase 1: Guards + run creation. Returns DispatchContext or null (guard rejected).
 *
 * @param {object} job
 * @param {object} opts - { approvalBypass, dispatchRecord }
 * @param {object} deps - Injected dependencies
 * @returns {object|null}
 */
export async function prepareDispatch(job, opts, deps) {
  const {
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
  } = deps;

  const approvalBypass = opts.approvalBypass === true;
  let dispatchRecord = opts.dispatchRecord || null;

  // Claim pending dispatch
  if (dispatchRecord && dispatchRecord.status === 'pending') {
    dispatchRecord = claimDispatch(dispatchRecord.id);
    if (!dispatchRecord) {
      log('debug', `Skipping claimed dispatch for ${job.name}`, { dispatchId: opts.dispatchRecord.id });
      return null;
    }
  }

  const completeCurrentDispatch = (status = 'done') => {
    if (!dispatchRecord) return null;
    return setDispatchStatus(dispatchRecord.id, status);
  };

  const dispatchKind = dispatchRecord?.dispatch_kind || null;
  const isChainDispatch = dispatchKind === 'chain';
  const dispatchBacklogDepth = getDispatchBacklogCount(job.id);

  // HITL approval gate
  if (job.approval_required && isChainDispatch && !approvalBypass) {
    const pendingApprovalCount = countPendingApprovalsForJob(job.id);
    if (pendingApprovalCount >= (job.max_pending_approvals || 10)) {
      completeCurrentDispatch('cancelled');
      log('warn', `Approval backlog limit reached for ${job.name}`, {
        jobId: job.id,
        pendingApprovals: pendingApprovalCount,
        maxPendingApprovals: job.max_pending_approvals || 10,
      });
      return null;
    }
    const existing = getPendingApproval(job.id);
    if (existing) {
      releaseDispatch(dispatchRecord.id, sqliteNow(adaptiveDeferralMs(dispatchBacklogDepth)));
      log('debug', `Skipping ${job.name} -- approval already pending`, {
        approvalId: existing.id,
        dispatchId: dispatchRecord?.id || null,
        deferredMs: adaptiveDeferralMs(dispatchBacklogDepth),
      });
      return null;
    }
    const run = createRun(job.id, {
      run_timeout_ms: job.run_timeout_ms,
      status: 'awaiting_approval',
      dispatch_queue_id: dispatchRecord?.id || null,
      triggered_by_run: dispatchRecord?.source_run_id || null,
      retry_of: dispatchRecord?.retry_of_run_id || null,
    });
    const approval = createApproval(job.id, run.id, dispatchRecord?.id || null);
    if (dispatchRecord) setDispatchStatus(dispatchRecord.id, 'awaiting_approval');
    log('info', `Approval required for ${job.name} -- awaiting operator`, { approvalId: approval.id, runId: run.id });
    const msg = `\u26a0\ufe0f Job '${job.name}' requires approval.\nApprove: openclaw-scheduler jobs approve ${job.id}\nReject: openclaw-scheduler jobs reject ${job.id}`;
    await handleDelivery({ ...job, delivery_mode: 'announce-always' }, msg);
    return null;
  }

  // Resource pool concurrency
  if (job.resource_pool && hasRunningRunForPool(job.resource_pool)) {
    log('info', `Skipping ${job.name} -- resource pool '${job.resource_pool}' busy`, { jobId: job.id, pool: job.resource_pool });
    if (dispatchRecord) {
      releaseDispatch(dispatchRecord.id, sqliteNow(TICK_INTERVAL_MS));
    } else {
      advanceNextRun(job);
    }
    return null;
  }

  // Overlap control
  if (hasRunningRun(job.id)) {
    if (job.overlap_policy === 'skip') {
      log('info', `Skipping ${job.name} -- previous run still active`, { jobId: job.id });
      if (dispatchRecord) {
        completeCurrentDispatch('cancelled');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
    if (job.overlap_policy === 'queue') {
      const queueResult = enqueueJob(job.id);
      if (!queueResult.queued) {
        log('warn', `Queue limit reached for ${job.name} -- dropping overlap dispatch`, {
          jobId: job.id,
          queuedCount: queueResult.queued_count,
          maxQueuedDispatches: job.max_queued_dispatches || 25,
        });
        if (dispatchRecord) {
          completeCurrentDispatch('cancelled');
        } else {
          advanceNextRun(job);
        }
        return null;
      }
      log('info', `Queueing ${job.name} -- previous run still active`, {
        jobId: job.id,
        queuedCount: queueResult.queued_count,
      });
      if (dispatchRecord) {
        completeCurrentDispatch('done');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
    // 'allow' falls through
  }

  // Idempotency key generation
  const scheduledTime = job.schedule_at || job.next_run_at;
  let idemKey;
  if (dispatchKind === 'chain') {
    idemKey = generateChainIdempotencyKey(dispatchRecord.source_run_id || dispatchRecord.id, job.id);
  } else if (dispatchKind === 'manual') {
    idemKey = generateRunNowIdempotencyKey(job.id);
  } else if (dispatchKind === 'retry') {
    idemKey = generateChainIdempotencyKey(dispatchRecord.retry_of_run_id || dispatchRecord.id, job.id);
  } else {
    idemKey = generateIdempotencyKey(job, scheduledTime);
  }

  // Idempotency dedup
  if (idemKey) {
    const existing = getDb().prepare("SELECT * FROM idempotency_ledger WHERE key = ? AND status = 'claimed'").get(idemKey);
    if (existing) {
      log('info', `Idempotency skip: ${job.name} (key ${idemKey.slice(0,8)}... already claimed by run ${existing.run_id.slice(0,8)}...)`);
      if (dispatchRecord) {
        completeCurrentDispatch('done');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
  }

  log('info', `Dispatching: ${job.name}`, { jobId: job.id, target: job.session_target });

  const retryCount = dispatchKind === 'retry' && dispatchRecord?.retry_of_run_id
    ? (getRun(dispatchRecord.retry_of_run_id)?.retry_count || 0)
    : 0;

  const run = createRun(job.id, {
    run_timeout_ms: job.run_timeout_ms,
    idempotency_key: idemKey,
    retry_count: retryCount,
    dispatch_queue_id: dispatchRecord?.id || null,
    triggered_by_run: dispatchRecord?.source_run_id || null,
    retry_of: dispatchRecord?.retry_of_run_id || null,
  });

  // Claim idempotency key
  if (idemKey) {
    const expiresAt = job.delete_after_run
      ? sqliteNow(24 * 60 * 60 * 1000)
      : sqliteNow(7 * 24 * 60 * 60 * 1000);
    const claimed = claimIdempotencyKey(idemKey, job.id, run.id, expiresAt);
    if (!claimed) {
      log('warn', `Idempotency race: ${job.name} key ${idemKey.slice(0,8)}... claimed by concurrent dispatch`);
      finishRun(run.id, 'skipped', { summary: 'Idempotency key already claimed (race)' });
      if (dispatchRecord) {
        completeCurrentDispatch('done');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
  }

  return { dispatchRecord, idemKey, run, retryCount, dispatchKind, isChainDispatch };
}

// ── Strategy: Watchdog ──────────────────────────────────────

export async function executeWatchdog(job, ctx, deps) {
  const { runShellCommand, handleDelivery, updateJob, deleteJob, log } = deps;
  const result = makeDefaultResult();
  result.skipChildren = true;
  result.skipDequeue = true;

  const checkCmd = job.watchdog_check_cmd;
  if (!checkCmd) {
    result.status = 'error';
    result.errorMessage = 'Watchdog job missing watchdog_check_cmd';
    result.skipJobUpdate = false;
    return result;
  }

  const shellExec = await runShellCommand(checkCmd, Math.min(job.run_timeout_ms || 300000, 60000));
  const exitCode = shellExec.exitCode;
  const stdout = (shellExec.stdout || '').trim();
  const stderr = (shellExec.stderr || '').trim();

  let timedOut = false;
  let elapsedMin = 0;
  if (job.watchdog_started_at && job.watchdog_timeout_min) {
    const startedAt = new Date(job.watchdog_started_at).getTime();
    elapsedMin = Math.round((Date.now() - startedAt) / 60000);
    if (elapsedMin >= job.watchdog_timeout_min) timedOut = true;
  }

  if (exitCode === 2) {
    result.summary = `Watchdog check failed (transient): ${stderr || stdout}`;
    result.skipDelivery = true;
    log('debug', `Watchdog check transient failure: ${job.name}`, { exitCode, stderr: stderr.slice(0, 200) });

  } else if (exitCode === 0 && stdout) {
    const completionMsg = `\u2705 [watchdog] Task "${job.watchdog_target_label}" completed -- watchdog disarmed`;
    result.summary = completionMsg;
    result.content = completionMsg;
    log('info', `Watchdog: target completed: ${job.watchdog_target_label}`, { jobId: job.id });

    if (job.watchdog_alert_channel && job.watchdog_alert_target) {
      await handleDelivery({
        ...job,
        delivery_mode: 'announce-always',
        delivery_channel: job.watchdog_alert_channel,
        delivery_to: job.watchdog_alert_target,
      }, completionMsg);
    }
    result.skipDelivery = true;

    if (job.watchdog_self_destruct) {
      result.skipJobUpdate = true;
      updateJob(job.id, { enabled: 0 });
      deleteJob(job.id);
      log('info', `Watchdog self-destructed: ${job.name}`, { jobId: job.id });
    }

  } else if (exitCode === 1 || timedOut) {
    const reason = timedOut
      ? `running for ${elapsedMin}min (threshold: ${job.watchdog_timeout_min}min)`
      : `check command reported stuck`;
    const alertMsg = [
      `\ud83d\udea8 [watchdog] Task "${job.watchdog_target_label}" appears stuck`,
      `- Dispatched: ${job.watchdog_started_at || 'unknown'}`,
      `- Running for: ${elapsedMin} minutes (threshold: ${job.watchdog_timeout_min || '?'} min)`,
      `- Reason: ${reason}`,
      `- Check: ${checkCmd}`,
      stderr ? `- Error: ${stderr.slice(0, 500)}` : null,
      stdout ? `- Output: ${stdout.slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');
    result.summary = `Watchdog alert fired: ${reason}`;
    result.content = alertMsg;

    log('warn', `Watchdog alert: ${job.watchdog_target_label} stuck`, {
      jobId: job.id, elapsedMin, timedOut, exitCode,
    });

    if (job.watchdog_alert_channel && job.watchdog_alert_target) {
      await handleDelivery({
        ...job,
        delivery_mode: 'announce-always',
        delivery_channel: job.watchdog_alert_channel,
        delivery_to: job.watchdog_alert_target,
      }, alertMsg);
    }
    result.skipDelivery = true;

  } else {
    result.summary = `Watchdog check: target still running (${elapsedMin}min elapsed)`;
    result.skipDelivery = true;
    log('debug', `Watchdog: target still running: ${job.watchdog_target_label}`, {
      jobId: job.id, elapsedMin,
    });
  }

  return result;
}

// ── Strategy: Main session ──────────────────────────────────

export async function executeMain(job, ctx, deps) {
  const { sendSystemEvent, buildExecutionIntentNote } = deps;
  const result = makeDefaultResult();
  result.skipChildren = true;
  result.skipDequeue = true;

  const executionNote = buildExecutionIntentNote(job);
  const modelNote = job.payload_thinking
    ? `[SYSTEM NOTE \u2014 model policy]\nPrefer reasoning depth: ${job.payload_thinking}.\n[END SYSTEM NOTE]\n\n`
    : '';
  await sendSystemEvent(`${executionNote ? `${executionNote}\n\n` : ''}${modelNote}${job.payload_message}`, 'now');
  result.summary = 'System event dispatched';
  result.content = job.payload_message;

  // Main session only delivers on announce-always (not on error)
  if (job.delivery_mode !== 'announce-always') {
    result.skipDelivery = true;
  }

  return result;
}

// ── Strategy: Shell ─────────────────────────────────────────

export async function executeShell(job, ctx, deps) {
  const { runShellCommand, normalizeShellResult, log } = deps;
  const result = makeDefaultResult();

  const shellExec = await runShellCommand(job.payload_message, job.run_timeout_ms);
  const shellResult = normalizeShellResult(shellExec, {
    runId: ctx.run.id,
    timeoutMs: job.run_timeout_ms,
    storeLimit: job.output_store_limit_bytes || undefined,
    excerptLimit: job.output_excerpt_limit_bytes || undefined,
    summaryLimit: job.output_summary_limit_bytes || undefined,
    offloadThreshold: job.output_offload_threshold_bytes || undefined,
  });

  result.status = shellResult.status;
  result.summary = shellResult.summary;
  result.errorMessage = shellResult.errorMessage;
  result.content = shellResult.deliveryText;
  result.runFinishFields = {
    context_summary: shellResult.contextSummary,
    shell_exit_code: shellResult.exitCode,
    shell_signal: shellResult.signal,
    shell_timed_out: shellResult.timedOut,
    shell_stdout: shellResult.stdout,
    shell_stderr: shellResult.stderr,
    shell_stdout_path: shellResult.stdoutPath,
    shell_stderr_path: shellResult.stderrPath,
    shell_stdout_bytes: shellResult.stdoutBytes,
    shell_stderr_bytes: shellResult.stderrBytes,
  };

  // Shell delivery logic: announce-always sends on all results, announce sends on error only
  const announcePayload = shellResult.deliveryText.trim() ? shellResult.deliveryText : shellResult.errorMessage;
  if (job.delivery_mode === 'announce-always' && announcePayload) {
    const prefix = shellResult.status === 'ok' ? '' : `\u26a0\ufe0f Shell job failed: ${job.name}\n\n`;
    result.deliveryOverride = `${prefix}${announcePayload}`;
  } else if (job.delivery_mode === 'announce' && shellResult.status !== 'ok' && announcePayload) {
    result.deliveryOverride = announcePayload;
  } else {
    result.skipDelivery = true;
  }

  log('info', `Shell ${shellResult.status}: ${job.name}`, {
    runId: ctx.run.id,
    exitCode: shellResult.exitCode,
    signal: shellResult.signal,
    timedOut: shellResult.timedOut,
  });

  return result;
}

// ── Strategy: Agent (isolated session) ──────────────────────

export async function executeAgent(job, ctx, deps) {
  const {
    waitForGateway, updateRunSession, setAgentStatus,
    buildJobPrompt, runAgentTurnWithActivityTimeout,
    updateContextSummary, releaseDispatch, releaseIdempotencyKey,
    updateJob, matchesSentinel, detectTransientError,
    listSessions,
    sqliteNow, log,
  } = deps;
  const result = makeDefaultResult();

  // Gateway health check
  const gatewayReady = await waitForGateway(30000, 2000);
  if (!gatewayReady) {
    log('warn', `Gateway unavailable after 30s -- deferring: ${job.name}`, { jobId: job.id });
    // Strategy handles everything for the gateway-down case
    deps.finishRun(ctx.run.id, 'error', { error_message: 'Gateway unavailable -- deferred' });
    if (ctx.idemKey) releaseIdempotencyKey(ctx.idemKey);
    const deferredAt = sqliteNow(60000);
    if (ctx.dispatchRecord) {
      releaseDispatch(ctx.dispatchRecord.id, deferredAt);
    } else {
      updateJob(job.id, { next_run_at: deferredAt });
    }
    result.earlyReturn = true;
    return result;
  }

  const sessionKey = job.preferred_session_key || `scheduler:${job.id}:${ctx.run.id}`;
  updateRunSession(ctx.run.id, sessionKey, null);

  // Mark agent as busy
  if (job.agent_id) setAgentStatus(job.agent_id, 'busy', sessionKey);

  // Build prompt and collect context metadata
  const { prompt, contextMeta } = buildJobPrompt(job, ctx.run);
  try { updateContextSummary(ctx.run.id, contextMeta); } catch (_e) { /* column may not exist yet */ }

  // Resolve auth_profile: 'inherit' -> main session's active profile, specific string -> pass directly
  let resolvedAuthProfile = job.auth_profile || undefined;
  if (resolvedAuthProfile === 'inherit') {
    try {
      const sessions = await listSessions({ kinds: ['main'], activeMinutes: 120, limit: 10 });
      const sessionList = sessions?.result?.details?.sessions || sessions?.result?.sessions || sessions?.sessions || sessions || [];
      const mainSession = Array.isArray(sessionList)
        ? sessionList.find(s => {
            const key = s.key || s.sessionKey || '';
            return key.includes(':main:') || key.endsWith(':main') || key === 'main';
          })
        : null;
      const profileId = mainSession?.authProfileOverride || mainSession?.authProfile || mainSession?.profile;
      if (profileId) {
        resolvedAuthProfile = profileId;
        log('debug', `Resolved auth_profile 'inherit' -> '${profileId}'`, { jobId: job.id });
      } else {
        log('debug', `auth_profile 'inherit' -- no main session profile found, passing 'inherit' as-is`, { jobId: job.id });
      }
    } catch (err) {
      log('warn', `Failed to resolve 'inherit' auth_profile: ${err.message}`, { jobId: job.id });
      // Fall through with 'inherit' -- gateway may handle it
    }
  }

  const turnResult = await runAgentTurnWithActivityTimeout({
    message: prompt,
    agentId: job.agent_id || 'main',
    sessionKey,
    model: job.payload_model || undefined,
    authProfile: resolvedAuthProfile,
    idleTimeoutMs: (job.payload_timeout_seconds || 120) * 1000,
    pollIntervalMs: 60000,
    absoluteTimeoutMs: job.run_timeout_ms || 300000,
  });

  const content = turnResult.content || '';
  const trimmed = content.trim();

  const isHeartbeatOk = matchesSentinel(trimmed, 'HEARTBEAT_OK');
  const isNoFlush = matchesSentinel(trimmed, 'NO_FLUSH');
  const isIdempotentSkip = matchesSentinel(trimmed, 'IDEMPOTENT_SKIP');
  const isTaskFailed = matchesSentinel(trimmed, 'TASK_FAILED');
  const isTransientError = detectTransientError(content);

  if (isNoFlush) log('info', `Flush: nothing to flush for ${job.name}`);
  if (isIdempotentSkip) log('info', `Idempotent skip (agent): ${job.name}`);
  if (isTaskFailed) log('warn', `Agent signalled TASK_FAILED: ${job.name}`, { runId: ctx.run.id });
  if (isTransientError) log('warn', `Transient error detected in agent reply: ${job.name}`, { runId: ctx.run.id, snippet: content.slice(0, 200) });

  const effectiveStatus = (isTaskFailed || isTransientError) ? 'error' : 'ok';

  result.status = effectiveStatus;
  result.summary = content.slice(0, 5000);
  result.content = content;
  result.errorMessage = effectiveStatus === 'error'
    ? (isTaskFailed ? 'Agent signalled TASK_FAILED' : 'Transient error in agent reply')
    : null;
  result.idemAction = effectiveStatus === 'ok' ? 'keep' : 'release';
  result.skipAgentCleanup = false;
  result.retryFiresChildren = true;

  // Suppress delivery for sentinel responses
  if (isHeartbeatOk || isNoFlush || isIdempotentSkip) {
    result.skipDelivery = true;
  }

  log('info', `Completed: ${job.name} (${turnResult.usage?.total_tokens || '?'} tokens)`, {
    runId: ctx.run.id,
    durationMs: Date.now() - new Date(ctx.run.started_at.replace(' ', 'T') + 'Z').getTime(),
  });

  return result;
}

// ── Strategy dispatcher with error-catch wrapper ────────────

export async function executeStrategy(job, ctx, deps) {
  const { handleDelivery, log } = deps;
  try {
    if (job.job_type === 'watchdog') return await executeWatchdog(job, ctx, deps);
    if (job.session_target === 'main')  return await executeMain(job, ctx, deps);
    if (job.session_target === 'shell') return await executeShell(job, ctx, deps);
    return await executeAgent(job, ctx, deps);
  } catch (err) {
    const {
      finishRun, releaseIdempotencyKey, setAgentStatus,
      isDrainError, enqueueDispatch, getJob, getDispatchBacklogCount,
      shouldRetry, scheduleRetry, getDb, updateJobAfterRun,
      setDispatchStatus, handleTriggeredChildren, dequeueJob,
      sqliteNow,
    } = deps;

    log('error', `Failed: ${job.name}: ${err.message}`, { jobId: job.id });

    // ── Drain-error retry for isolated agentTurn jobs ──────────
    // Gateway drain errors are transient infra noise -- the job never ran.
    // Don't increment consecutive_errors, and schedule a single retry after 90s.
    const isIsolatedAgent = job.session_target !== 'main' && job.session_target !== 'shell' && job.job_type !== 'watchdog';
    if (isIsolatedAgent && isDrainError(err.message)) {
      finishRun(ctx.run.id, 'error', { error_message: err.message });
      if (ctx.idemKey) releaseIdempotencyKey(ctx.idemKey);
      if (job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

      // Check: max 1 drain retry per run, job must still be enabled, and respect overlap_policy:skip
      const freshJob = getJob(job.id);
      const canDrainRetry = freshJob && freshJob.enabled
        && (ctx.run.retry_count || 0) < 1
        && !(freshJob.overlap_policy === 'skip' && getDispatchBacklogCount(job.id) > 0);

      if (canDrainRetry) {
        const drainDispatch = enqueueDispatch(job.id, {
          kind: 'retry',
          scheduled_for: sqliteNow(90000),
          source_run_id: ctx.run.id,
          retry_of_run_id: ctx.run.id,
        });
        getDb().prepare('UPDATE runs SET retry_count = 1 WHERE id = ?').run(ctx.run.id);
        log('info', `[drain-retry] scheduling retry for ${job.name} in 90s (run ${ctx.run.id})`, {
          jobId: job.id, dispatchId: drainDispatch.id,
        });
      } else {
        log('info', `[drain-retry] skipping retry for ${job.name} (enabled=${freshJob?.enabled}, retry_count=${ctx.run.retry_count || 0}, overlap_backlog=${getDispatchBacklogCount(job.id)})`, {
          jobId: job.id, runId: ctx.run.id,
        });
      }

      // Do NOT call updateJobAfterRun -- avoid incrementing consecutive_errors for drain noise
      if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
      return { ...makeDefaultResult(), status: 'error', earlyReturn: true };
    }

    finishRun(ctx.run.id, 'error', { error_message: err.message });
    if (ctx.idemKey) releaseIdempotencyKey(ctx.idemKey);
    if (job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

    if (shouldRetry(job, ctx.run.id)) {
      const retry = scheduleRetry(job, ctx.run.id);
      if (retry.dispatch) {
        log('info', `Scheduling retry ${retry.retryCount}/${job.max_retries} in ${retry.delaySec}s`, {
          jobId: job.id, runId: ctx.run.id,
        });
        getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(retry.retryCount, ctx.run.id);
        if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
        dequeueJob(job.id);
      } else {
        log('warn', `Retry skipped for ${job.name} -- dispatch backlog limit reached`, {
          jobId: job.id, runId: ctx.run.id,
          maxQueuedDispatches: job.max_queued_dispatches || 25,
        });
        if (['announce', 'announce-always'].includes(job.delivery_mode)) {
          await handleDelivery(job, `\u26a0\ufe0f Job failed: ${job.name}\n\n${err.message}`);
        }
        updateJobAfterRun(job, 'error');
        if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'cancelled');
      }
    } else {
      if (['announce', 'announce-always'].includes(job.delivery_mode)) {
        await handleDelivery(job, `\u26a0\ufe0f Job failed: ${job.name}\n\n${err.message}`);
      }
      handleTriggeredChildren(job.id, 'error', err.message, ctx.run.id, ' on failure');
      if (dequeueJob(job.id)) {
        log('info', `Dequeued pending dispatch for ${job.name} (after failure)`);
      }
      updateJobAfterRun(job, 'error');
      if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'cancelled');
    }

    return { ...makeDefaultResult(), status: 'error', earlyReturn: true };
  }
}
