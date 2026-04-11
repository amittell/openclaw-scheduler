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

/** Safely parse a JSON string. Returns parsed value or null on failure. */
function safeParse(str) {
  if (str == null || str === '') return null;
  try {
    return JSON.parse(str);
  } catch (_e) {
    return null;
  }
}

function getIdentityTrustLevel(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return identity.trust_level
    || identity.trust?.effective_level
    || identity.trust?.level
    || identity.session?.trust?.effective_level
    || identity.session?.trust?.level
    || identity.raw?.trust_level
    || identity.raw?.trust?.effective_level
    || identity.raw?.trust?.level
    || null;
}

function getJobTrustLevel(job, parsedIdentity = null) {
  const identityBlob = parsedIdentity || safeParse(job?.identity);
  return getIdentityTrustLevel(identityBlob) || job?.identity_trust_level || null;
}

function hasIdentityDeclaration(job) {
  if (!job) return false;
  return job.identity != null
    || job.identity_ref != null
    || job.identity_principal != null
    || job.identity_run_as != null
    || job.identity_attestation != null
    || job.identity_subject_kind != null
    || job.identity_subject_principal != null
    || job.identity_trust_level != null
    || job.identity_delegation_mode != null;
}

/**
 * Redact session credentials from v02Outcomes before DB persistence.
 * Uses the provider's describeSession() for redaction when available,
 * otherwise strips the credentials key directly.
 */
export function redactOutcomesForPersistence(outcomes, deps) {
  if (!outcomes?.identity_resolved?.session?.credentials) return outcomes;
  const redacted = { ...outcomes };
  const ir = { ...redacted.identity_resolved };
  const session = { ...ir.session };

  const providerName = ir.provider;
  const provider = providerName && deps?.getIdentityProvider?.(providerName);
  if (provider && typeof provider.describeSession === 'function') {
    try {
      ir.session = provider.describeSession(session);
    } catch (_err) {
      delete session.credentials;
      ir.session = session;
    }
  } else {
    delete session.credentials;
    ir.session = session;
  }

  redacted.identity_resolved = ir;
  return redacted;
}

function abortPreparedRun(job, run, summary, outcomes, state, deps, opts = {}) {
  const {
    finishRun, persistV02Outcomes, releaseIdempotencyKey, updateJobAfterRun,
    setDispatchStatus, handleTriggeredChildren, dequeueJob, log,
  } = deps;

  finishRun(run.id, 'error', {
    summary,
    error_message: summary,
  });
  persistV02Outcomes(run.id, redactOutcomesForPersistence(outcomes, deps));
  if (state.idemKey) releaseIdempotencyKey(state.idemKey);
  updateJobAfterRun(job, 'error');
  if (state.dispatchRecord) setDispatchStatus(state.dispatchRecord.id, 'done');
  // Security-related aborts (identity/trust/auth/proof/credential failures)
  // should not fire child jobs -- a parent that failed a security gate must
  // not trigger downstream work that may have weaker security requirements.
  if (!opts.skipChildren) {
    handleTriggeredChildren(job.id, 'error', summary, run.id);
  }
  if (dequeueJob(job.id)) {
    log('info', `Dequeued pending dispatch for ${job.name}`);
  }
  return null;
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

  // 1b. v0.2 evidence and outcome persistence
  if (ctx.v02Outcomes) {
    const { generateEvidence, persistV02Outcomes } = deps;
    if (job.evidence || job.evidence_ref) {
      const runMetadata = { id: ctx.run.id, status: result.status };
      const evidence = generateEvidence(job, runMetadata, ctx.v02Outcomes);
      if (evidence) ctx.v02Outcomes.evidence_record = evidence;
    }
    persistV02Outcomes(ctx.run.id, redactOutcomesForPersistence(ctx.v02Outcomes, deps));
  }

  // 1c. Provider cleanup
  if (ctx.materializationCleanup) {
    try {
      const { provider, cleanupState } = ctx.materializationCleanup;
      if (typeof provider.cleanup === 'function') {
        await provider.cleanup(cleanupState, { env: process.env, cwd: process.cwd() });
      }
    } catch (err) {
      log('warn', `Provider cleanup failed for ${job.name}: ${err.message}`, { jobId: job.id });
    }
  }

  // 2. Idempotency key management
  if (ctx.idemKey) {
    if (result.idemAction === 'keep') {
      updateIdempotencyResultHash(ctx.idemKey, result.content);
    } else if (result.idemAction === 'release') {
      releaseIdempotencyKey(ctx.idemKey);
    }
    // 'noop' -- leave key claimed without writing result hash
  }

  // 3. Agent status cleanup (only for strategies that set busy)
  if (!result.skipAgentCleanup && job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

  // 4. Delivery
  if (!result.skipDelivery) {
    const deliveryContent = result.deliveryOverride ?? result.content;
    const shouldAnnounce = ['announce', 'announce-always'].includes(job.delivery_mode)
      && deliveryContent?.trim();

    const deliveryOpts = result.imageAttachments?.length > 0
      ? { imageAttachments: result.imageAttachments }
      : {};

    if (shouldAnnounce) {
      if (result.deliveryOverride) {
        await handleDelivery(job, result.deliveryOverride, deliveryOpts);
      } else if (result.status === 'error') {
        const willRetry = (job.max_retries ?? 0) > 0 && (ctx.run.retry_count || 0) < job.max_retries;
        const retryLabel = willRetry ? 'will retry' : 'no retries configured';
        await handleDelivery(job, `\u26a0\ufe0f Job soft-failed (${retryLabel}): ${job.name}\n\n${deliveryContent}`, deliveryOpts);
      } else {
        await handleDelivery(job, deliveryContent, deliveryOpts);
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
      log('info', `Failed: ${job.name} (retry scheduled)`, { runId: ctx.run.id });
      return; // retry path handles everything
    }
    log('warn', `Retry skipped for ${job.name} -- dispatch backlog limit reached`, {
      jobId: job.id, runId: ctx.run.id,
      maxQueuedDispatches: job.max_queued_dispatches || 25,
    });
    // Fall through to steps 6-9: updateJobAfterRun, dispatch status, children, dequeue
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

// -- Phase 1: Guards + run creation --------------------------

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

  // v0.2 runtime evaluation
  const {
    resolveIdentity, evaluateTrust, verifyAuthorizationProof,
    evaluateAuthorization, summarizeCredentialHandoff,
  } = deps;

  // Build provider context for v0.2 runtime calls
  const providerCtx = {
    getIdentityProvider: deps.getIdentityProvider,
    getAuthorizationProvider: deps.getAuthorizationProvider,
    getProofVerifier: deps.getProofVerifier,
    env: process.env,
    cwd: process.cwd(),
  };

  const v02Outcomes = {};
  const hasV02Identity = hasIdentityDeclaration(job);
  const hasV02Contract = job.contract_required_trust_level;
  const needsAuthorization = job.authorization || job.authorization_ref;
  const shouldResolveIdentity = hasV02Identity || hasV02Contract || needsAuthorization;

  if (shouldResolveIdentity) {
    v02Outcomes.identity_resolved = await resolveIdentity(job, providerCtx);
  }

  if (hasV02Identity) {
    const handoff = summarizeCredentialHandoff(job);
    if (handoff) v02Outcomes.credential_handoff_summary = handoff;
  }

  const hasDeclaredCredentialHandoff = v02Outcomes.credential_handoff_summary
    && (v02Outcomes.credential_handoff_summary.mode != null
      || v02Outcomes.credential_handoff_summary.bindings_count > 0);
  if (hasDeclaredCredentialHandoff && job.session_target !== 'shell') {
    return abortPreparedRun(
      job,
      run,
      'Credential handoff presentation is only supported for shell jobs',
      v02Outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }

  // Child credential policy enforcement.
  // Apply this BEFORE trust/auth evaluation so later gates see the effective
  // identity that will actually be materialized for the run. The policy can
  // narrow (downscope) or remove (none) credentials, and it may also inherit
  // the parent's auth_profile for downstream gateway calls.
  if (job.parent_id) {
    const { getDb: getDatabase } = deps;
    const parentJob = getDatabase().prepare(
      'SELECT id, child_credential_policy, identity, identity_trust_level, auth_profile FROM jobs WHERE id = ?'
    ).get(job.parent_id);

    if (parentJob) {
      const effectivePolicy = job.child_credential_policy
        || parentJob.child_credential_policy
        || 'none';
      const parentIdentityBlob = safeParse(parentJob.identity);
      const lastSuccessfulParentRun = (effectivePolicy === 'downscope' || effectivePolicy === 'independent')
        ? getDatabase().prepare(
          'SELECT identity_resolved FROM runs WHERE job_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1'
        ).get(parentJob.id, 'ok')
        : null;
      const parentResolvedIdentity = lastSuccessfulParentRun?.identity_resolved
        ? safeParse(lastSuccessfulParentRun.identity_resolved)
        : null;

      if (effectivePolicy === 'none') {
        // No credentials from parent; suppress any identity the child resolved on its own
        v02Outcomes.identity_resolved = null;
      } else if (effectivePolicy === 'inherit' && parentJob.auth_profile) {
        // Inherit parent's auth profile. Store in v02Outcomes rather than
        // mutating the job DB record, which could leak to downstream writes.
        v02Outcomes.effective_auth_profile = parentJob.auth_profile;
      } else if (effectivePolicy === 'downscope') {
        // Downscope: resolve narrower credentials via provider.
        // Fail closed on every path -- if downscope is declared, we must
        // either produce a downscoped session or abort dispatch.
        const providerName = parentIdentityBlob?.provider || parentIdentityBlob?.auth?.provider;
        const provider = deps.getIdentityProvider?.(providerName);
        let downscopeApplied = false;

        if (provider && typeof provider.prepareHandoff === 'function') {
          // Get parent session from last run or re-resolve
          let parentSession = parentResolvedIdentity?.session || null;

          if (!parentSession && provider.resolveSession) {
            // Fallback: re-resolve parent identity
            try {
              const parentScope = parentIdentityBlob?.scope || parentIdentityBlob?.auth?.scopes?.[0] || null;
              const reResolved = await provider.resolveSession(
                { profile: parentIdentityBlob, instanceId: parentJob.id, scope: parentScope },
                { env: process.env, cwd: process.cwd() }
              );
              if (reResolved.ok) parentSession = reResolved.session;
            } catch (resolveErr) {
              log('warn', `Downscope parent re-resolve failed for ${job.name}: ${resolveErr.message}`, { jobId: job.id });
            }
          }

          if (parentSession) {
            const childIdentityBlob = safeParse(job.identity) || {};
            const childScope = childIdentityBlob?.scope || childIdentityBlob?.auth?.scopes?.[0] || null;

            try {
              const handoffResult = await provider.prepareHandoff(
                parentSession,
                { target_scope: childScope, parent_profile: parentIdentityBlob },
                { env: process.env, cwd: process.cwd() }
              );

              if (handoffResult.prepared) {
                // Verify handoff actually downscoped: child trust must not
                // exceed parent. A provider that returns an elevated session
                // violates the downscope contract.
                const parentTrustLevel = getIdentityTrustLevel(parentResolvedIdentity)
                  || getIdentityTrustLevel({ session: parentSession })
                  || getJobTrustLevel(parentJob, parentIdentityBlob);
                const childTrustLevel = getIdentityTrustLevel({ session: handoffResult.session });
                const { compareTrustLevels } = deps;
                if (parentTrustLevel && childTrustLevel && compareTrustLevels(childTrustLevel, parentTrustLevel) > 0) {
                  log('warn', `Downscope handoff elevated trust from "${parentTrustLevel}" to "${childTrustLevel}" for ${job.name}`, { jobId: job.id });
                  // Do not set downscopeApplied -- will abort below
                } else {
                  // Override the identity resolution with the handoff session
                  v02Outcomes.identity_resolved = {
                    provider: providerName,
                    session: handoffResult.session,
                    source: 'provider',
                    subject_kind: handoffResult.session?.subject?.kind || 'unknown',
                    principal: handoffResult.session?.subject?.principal || null,
                    trust_level: childTrustLevel,
                    delegation_mode: null,
                    raw: childIdentityBlob,
                  };
                  downscopeApplied = true;
                }
              }
            } catch (err) {
              log('warn', `Downscope handoff error for ${job.name}: ${err.message}`, { jobId: job.id });
            }
          }
        }

        if (!downscopeApplied) {
          const reason = !provider
            ? `identity provider ${providerName || '(none)'} not loaded`
            : typeof provider.prepareHandoff !== 'function'
              ? `provider ${providerName} does not support prepareHandoff`
              : 'parent session unavailable or handoff did not produce a downscoped session';
          return abortPreparedRun(
            job,
            run,
            `Downscope credential policy failed: ${reason}`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
      } else if (effectivePolicy === 'independent') {
        // Child uses its own resolved identity, but cannot exceed the parent's
        // trust level. Without this cap, a child could declare a higher trust
        // level than the parent and bypass the parent's authorization scope.
        const parentTrustLevel = getIdentityTrustLevel(parentResolvedIdentity)
          || getJobTrustLevel(parentJob, parentIdentityBlob);
        const childTrustLevel = v02Outcomes.identity_resolved?.trust_level || null;
        if (parentTrustLevel && childTrustLevel) {
          const { compareTrustLevels } = deps;
          if (compareTrustLevels(childTrustLevel, parentTrustLevel) > 0) {
            return abortPreparedRun(
              job,
              run,
              `Independent child trust level "${childTrustLevel}" exceeds parent trust level "${parentTrustLevel}"`,
              v02Outcomes,
              { dispatchRecord, idemKey },
              deps,
              { skipChildren: true },
            );
          }
        }
      }
    }
  }

  if (v02Outcomes.identity_resolved?.source === 'provider-error') {
    return abortPreparedRun(
      job,
      run,
      'Identity resolution failed: ' + (v02Outcomes.identity_resolved.error || 'provider error'),
      v02Outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }

  if (hasV02Identity || hasV02Contract || v02Outcomes.identity_resolved != null) {
    v02Outcomes.trust_evaluation = evaluateTrust(job, v02Outcomes.identity_resolved);
    if (v02Outcomes.trust_evaluation?.decision === 'warn') {
      log('warn', `Trust evaluation warning for ${job.name}: ${v02Outcomes.trust_evaluation.reason}`, {
        jobId: job.id,
        runId: run.id,
      });
    }
    if (v02Outcomes.trust_evaluation?.decision === 'deny') {
      return abortPreparedRun(
        job,
        run,
        'Trust enforcement blocked dispatch: ' + v02Outcomes.trust_evaluation.reason,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  if (job.authorization_proof || job.authorization_proof_ref) {
    v02Outcomes.authorization_proof_verification = await verifyAuthorizationProof(job, providerCtx);
    if (v02Outcomes.authorization_proof_verification?.verified === false) {
      const proofError = v02Outcomes.authorization_proof_verification.error || 'verification returned false';
      // Proof verification failure is blocking: the job declared a proof
      // requirement, so proceeding without a valid proof violates policy.
      return abortPreparedRun(
        job,
        run,
        'Authorization proof verification failed: ' + proofError,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  if (needsAuthorization) {
    v02Outcomes.authorization_decision = await evaluateAuthorization(
      job, v02Outcomes.identity_resolved, v02Outcomes.trust_evaluation, providerCtx
    );

    if (v02Outcomes.authorization_decision?.decision === 'deny') {
      return abortPreparedRun(
        job,
        run,
        'Authorization denied: ' + v02Outcomes.authorization_decision.reason,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
    if (v02Outcomes.authorization_decision?.decision === 'escalate') {
      // Escalation means the authorization provider wants a human decision.
      // Abort the dispatch so the approval system (or operator) can intervene.
      return abortPreparedRun(
        job,
        run,
        'Authorization requires escalation: ' + (v02Outcomes.authorization_decision.reason || 'provider requested escalation'),
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
    if (v02Outcomes.authorization_decision?.advisory) {
      log('warn', `Authorization advisory for ${job.name}: ${v02Outcomes.authorization_decision.reason}`, { jobId: job.id });
    }
  }

  // Materialization phase
  let materializedEnv = null;
  let materializationCleanup = null;

  if (v02Outcomes.identity_resolved?.source === 'provider' && v02Outcomes.identity_resolved.session) {
    const providerName = v02Outcomes.identity_resolved.provider;
    const provider = deps.getIdentityProvider?.(providerName);
    const identityBlob = safeParse(job.identity) || {};
    const presentation = identityBlob.presentation || {};
    const hasPresentation = presentation && Object.keys(presentation).length > 0;

    if (provider && typeof provider.materialize === 'function') {
      try {
        const matResult = await provider.materialize(
          v02Outcomes.identity_resolved.session,
          presentation,
          { env: process.env, cwd: process.cwd() }
        );
        if (matResult?.materialized) {
          materializedEnv = matResult.env_vars || null;
          if (matResult.cleanup_required) {
            materializationCleanup = {
              provider,
              cleanupState: {
                session: v02Outcomes.identity_resolved.session,
                ...matResult,
              },
            };
          }
        } else if (hasPresentation) {
          // Materialization returned false but credentials were declared required
          return abortPreparedRun(
            job,
            run,
            `Credential materialization failed for provider ${providerName}: provider returned materialized=false`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
      } catch (err) {
        if (hasPresentation) {
          return abortPreparedRun(
            job,
            run,
            `Credential materialization error for provider ${providerName}: ${err.message}`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
        // No presentation declared: provider materializes opportunistically.
        // Warn and continue -- the shell job can still run without injected
        // credentials when the identity blob has no presentation block.
        log('warn', `Materialization failed for ${job.name}: ${err.message}`, { jobId: job.id });
      }
    } else if (hasPresentation) {
      // Job declared credential presentation but provider has no materialize method
      return abortPreparedRun(
        job,
        run,
        `Job declares credential presentation but provider ${providerName || '(none)'} does not support materialization`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  return { dispatchRecord, idemKey, run, retryCount, dispatchKind, isChainDispatch, v02Outcomes, materializedEnv, materializationCleanup };
}

// -- Strategy: Watchdog --------------------------------------

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
      `- Check: ${checkCmd.split(/\s/)[0]}${checkCmd.length > 80 ? ' [...]' : ''}`,
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

  } else if (exitCode === 0) {
    result.summary = `Watchdog check: target still running (${elapsedMin}min elapsed)`;
    result.skipDelivery = true;
    log('debug', `Watchdog: target still running: ${job.watchdog_target_label}`, {
      jobId: job.id, elapsedMin,
    });
  } else {
    result.summary = `Watchdog check command returned unexpected exit code ${exitCode}`;
    result.status = 'error';
    log('warn', `Watchdog: unexpected exit code for ${job.watchdog_target_label}`, {
      jobId: job.id, exitCode, stderr: stderr.slice(0, 200),
    });
  }

  return result;
}

// -- Strategy: Main session ----------------------------------

export async function executeMain(job, ctx, deps) {
  // Main session dispatch mode:
  // - execution_intent 'background' or missing: use executeAgent (sync, waits
  //   for response, captures content for delivery). Best for quick tasks where
  //   a few seconds of session latency is acceptable.
  // - execution_intent 'fire-and-forget': inject a system event and return
  //   immediately. The agent processes asynchronously and the session stays
  //   unblocked for interactive DMs. No response capture -- if delivery is
  //   configured, the prompt includes a reply-to instruction so the agent
  //   can send results via the message tool when done.
  //
  // Choose based on expected duration:
  //   Quick tasks (< 10s): sync is simpler and captures output
  //   Long tasks (> 30s): fire-and-forget avoids blocking interactive chat

  const isFireAndForget = job.execution_intent === 'fire-and-forget';

  if (!isFireAndForget) {
    // Sync path: reuse executeAgent with the main session key.
    // The job's preferred_session_key defaults to 'main' for main-session jobs.
    const originalSessionKey = job.preferred_session_key;
    job.preferred_session_key = job.preferred_session_key || 'main';
    const agentResult = await executeAgent(job, ctx, deps);
    job.preferred_session_key = originalSessionKey;
    return agentResult;
  }

  // Fire-and-forget path: inject system event, return immediately.
  const { sendSystemEvent, buildExecutionIntentNote, log } = deps;
  const result = makeDefaultResult();

  const executionNote = buildExecutionIntentNote(job);
  const modelNote = job.payload_thinking
    ? `[SYSTEM NOTE -- model policy]\nPrefer reasoning depth: ${job.payload_thinking}.\n[END SYSTEM NOTE]\n\n`
    : '';

  // Build the delivery reply-to instruction so the agent can send results
  // back through the scheduler post office when it finishes processing.
  let deliveryInstruction = '';
  if (job.delivery_mode && job.delivery_mode !== 'none' && job.delivery_channel && job.delivery_to) {
    deliveryInstruction = [
      '\n[SYSTEM NOTE -- delivery]',
      `When you have completed this task, send your results using the message tool.`,
      `Channel: ${job.delivery_channel}`,
      `Target: ${job.delivery_to}`,
      `Keep the message concise and actionable.`,
      `If there is nothing noteworthy to report, do not send a message.`,
      '[END SYSTEM NOTE]\n',
    ].join('\n');
  }

  const prompt = `${executionNote ? `${executionNote}\n\n` : ''}${modelNote}${deliveryInstruction}${job.payload_message}`;
  await sendSystemEvent(prompt, 'now');

  result.summary = 'System event dispatched (fire-and-forget)';
  result.content = job.payload_message;
  result.skipDelivery = true; // Agent handles delivery via message tool
  result.skipChildren = true;
  result.skipDequeue = true;

  log('info', `Dispatched (main/fire-and-forget): ${job.name}`, { runId: ctx.run.id });

  return result;
}

// -- Strategy: Shell -----------------------------------------

export async function executeShell(job, ctx, deps) {
  const { runShellCommand, normalizeShellResult, log } = deps;
  const result = makeDefaultResult();

  const shellExec = await runShellCommand(job.payload_message, job.run_timeout_ms, ctx.materializedEnv || null);
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
  if (shellResult.imageAttachments?.length > 0) {
    result.imageAttachments = shellResult.imageAttachments;
  }
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

// -- Strategy: Agent (isolated session) ----------------------

function describeAgentSelection(selection) {
  return {
    model: selection?.model || null,
    auth_profile: selection?.authProfile || null,
  };
}

function sameAgentSelection(left, right) {
  return (left?.model || undefined) === (right?.model || undefined)
    && (left?.authProfile || undefined) === (right?.authProfile || undefined);
}

async function resolveConfiguredAuthProfile(authProfile, deps, jobId, fieldName = 'auth_profile') {
  const { listSessions, log } = deps;
  let resolvedAuthProfile = authProfile || undefined;
  if (resolvedAuthProfile !== 'inherit') return resolvedAuthProfile;

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
      log('debug', `Resolved ${fieldName} 'inherit' -> '${profileId}'`, { jobId });
    } else {
      log('debug', `${fieldName} 'inherit' -- no main session profile found, passing 'inherit' as-is`, { jobId });
    }
  } catch (err) {
    log('warn', `Failed to resolve ${fieldName} 'inherit': ${err.message}`, { jobId });
    // Fall through with 'inherit' -- gateway may handle it.
  }

  return resolvedAuthProfile;
}

async function runAgentTurnForSelection(job, deps, prompt, sessionKey, selection) {
  const { runAgentTurnWithActivityTimeout, log } = deps;
  const { syncAuthStoreToSession: syncAuth, applyAuthProfileToSessionStore: applyAuthProfile } = deps;

  // Always sync the live auth store before each attempt so refreshed credentials
  // are visible to any embedded/isolated runner startup.
  if (typeof syncAuth === 'function') {
    const syncResult = syncAuth(job.agent_id || 'main');
    if (syncResult.ok) {
      log('debug', `Synced live auth store to agent '${job.agent_id || 'main'}'`, { jobId: job.id });
    } else {
      log('warn', `Failed to sync auth store: ${syncResult.error}`, { jobId: job.id });
    }
  }

  if (selection.authProfile && selection.authProfile !== 'inherit' && typeof applyAuthProfile === 'function') {
    const applyResult = applyAuthProfile(sessionKey, selection.authProfile, job.agent_id || 'main');
    if (applyResult.ok) {
      log('debug', `Applied auth profile '${selection.authProfile}' to session store for ${sessionKey}`, { jobId: job.id });
    } else {
      log('warn', `Failed to apply auth profile to session store: ${applyResult.error}`, { jobId: job.id, sessionKey });
    }
  }

  return runAgentTurnWithActivityTimeout({
    message: prompt,
    agentId: job.agent_id || 'main',
    sessionKey,
    model: selection.model || undefined,
    authProfile: selection.authProfile,
    idleTimeoutMs: (job.payload_timeout_seconds || 120) * 1000,
    pollIntervalMs: 60000,
    absoluteTimeoutMs: job.run_timeout_ms || 300000,
  });
}

export async function executeAgent(job, ctx, deps) {
  const {
    waitForGateway, updateRunSession, setAgentStatus,
    buildJobPrompt,
    updateContextSummary, releaseDispatch, releaseIdempotencyKey,
    updateJob, matchesSentinel, detectTransientError,
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

  // Use a stable session key per job (not per run) so subsequent runs reuse
  // the warm session. This avoids full agent bootstrap on every dispatch --
  // memory search, plugin init, and context loading only happen on the first
  // run. Later runs get a pre-warmed session with context already loaded.
  const requestedSessionKey = job.preferred_session_key || `scheduler:${job.id}`;
  const sessionKey = requestedSessionKey.startsWith('agent:')
    ? requestedSessionKey
    : `agent:${job.agent_id || 'main'}:${requestedSessionKey}`;
  updateRunSession(ctx.run.id, sessionKey, null);

  // Mark agent as busy
  if (job.agent_id) setAgentStatus(job.agent_id, 'busy', sessionKey);

  // Build prompt and collect context metadata
  const { prompt, contextMeta } = buildJobPrompt(job, ctx.run);
  try { updateContextSummary(ctx.run.id, contextMeta); } catch (_e) { /* column may not exist yet */ }

  const primarySelection = {
    model: job.payload_model || undefined,
    authProfile: await resolveConfiguredAuthProfile(
      ctx.v02Outcomes?.effective_auth_profile || job.auth_profile || undefined,
      deps,
      job.id,
      ctx.v02Outcomes?.effective_auth_profile ? 'effective_auth_profile' : 'auth_profile'
    ),
  };
  const hasConfiguredFallback = job.payload_model_fallback != null || job.auth_profile_fallback != null;
  const fallbackSelection = hasConfiguredFallback ? {
    model: job.payload_model_fallback || primarySelection.model || undefined,
    authProfile: job.auth_profile_fallback != null
      ? await resolveConfiguredAuthProfile(job.auth_profile_fallback, deps, job.id, 'auth_profile_fallback')
      : primarySelection.authProfile,
  } : null;

  let turnResult;
  try {
    turnResult = await runAgentTurnForSelection(job, deps, prompt, sessionKey, primarySelection);
  } catch (primaryError) {
    const canTryConfiguredFallback = fallbackSelection && !sameAgentSelection(primarySelection, fallbackSelection);
    if (!canTryConfiguredFallback) throw primaryError;

    log('warn', 'Primary agent selection failed; retrying with configured fallback', {
      jobId: job.id,
      primary: describeAgentSelection(primarySelection),
      fallback: describeAgentSelection(fallbackSelection),
      error: primaryError.message,
    });

    try {
      turnResult = await runAgentTurnForSelection(job, deps, prompt, sessionKey, fallbackSelection);
      log('info', 'Configured agent fallback succeeded', { jobId: job.id, fallback: describeAgentSelection(fallbackSelection) });
    } catch (fallbackError) {
      throw new Error(`Primary agent selection failed: ${primaryError.message}; configured fallback also failed: ${fallbackError.message}`, { cause: fallbackError });
    }
  }

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

  // Announce mode: only deliver on error (consistent with shell job behavior)
  if (job.delivery_mode === 'announce' && effectiveStatus === 'ok') {
    result.skipDelivery = true;
  }

  log('info', `Completed: ${job.name} (${turnResult.usage?.total_tokens || '?'} tokens)`, {
    runId: ctx.run.id,
    durationMs: ctx.run.started_at
      ? Date.now() - new Date(ctx.run.started_at.replace(' ', 'T') + (ctx.run.started_at.endsWith('Z') ? '' : 'Z')).getTime()
      : null,
  });

  return result;
}

// -- Strategy dispatcher with error-catch wrapper ------------

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

    // -- Drain-error retry for isolated agentTurn jobs ----------
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
        if (job.delivery_mode === 'announce' || job.delivery_mode === 'announce-always') {
          const retryMsg = `Job "${job.name}" failed with exception, retry ${retry.retryCount}/${job.max_retries} scheduled`;
          await handleDelivery(job, retryMsg);
        }
        getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(retry.retryCount, ctx.run.id);
        if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
        if (dequeueJob(job.id)) {
          log('info', `Dequeued pending dispatch for ${job.name} (after exception-retry)`);
        }
      } else {
        log('warn', `Retry skipped for ${job.name} -- dispatch backlog limit reached`, {
          jobId: job.id, runId: ctx.run.id,
          maxQueuedDispatches: job.max_queued_dispatches || 25,
        });
        if (['announce', 'announce-always'].includes(job.delivery_mode)) {
          await handleDelivery(job, `\u26a0\ufe0f Job failed: ${job.name}\n\n${err.message}`);
        }
        handleTriggeredChildren(job.id, 'error', err.message, ctx.run.id, ' on exception-retry-skipped');
        if (dequeueJob(job.id)) {
          log('info', `Dequeued pending dispatch for ${job.name} (after exception-retry-skipped)`);
        }
        updateJobAfterRun(job, 'error');
        if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
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
      if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
    }

    return { ...makeDefaultResult(), status: 'error', earlyReturn: true };
  }
}
