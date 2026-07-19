// Run lifecycle management
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { TERMINAL_RUN_STATUSES, transitionRunTerminal } from './run-state.js';
import { assertArtifactMatchesJob } from './handoff-artifact.js';
import { appendRuntimeEvent } from './runtime-events.js';
import { validatePersistedArtifactBoundEvidenceRecord } from './evidence-runtime.js';
import {
  buildEvidenceExecutionSnapshot,
  generateEvidence,
  verifyEvidenceRecord,
} from './v02-runtime.js';

/**
 * Create a new run for a job.
 */
export function createRun(jobId, opts = {}) {
  const db = getDb();
  const id = randomUUID();
  const dispatcherOwner = opts.dispatcher_owner ?? opts.ownerId ?? null;
  const dispatcherToken = opts.dispatcher_token ?? opts.fencingToken ?? null;
  const hasDispatcherOwner = typeof dispatcherOwner === 'string' && dispatcherOwner.trim().length > 0;
  const hasDispatcherToken = Number.isInteger(dispatcherToken) && dispatcherToken > 0;
  if (hasDispatcherOwner !== hasDispatcherToken) {
    throw new Error('dispatcher owner and fencing token must be provided together');
  }
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const declaredEvidenceRequired = job && (job.evidence != null || job.evidence_ref != null) ? 1 : 0;
  const evidenceRequired = opts.evidence_required == null
    ? declaredEvidenceRequired
    : Number(Boolean(opts.evidence_required));
  const evidenceExecutionSnapshot = JSON.stringify(buildEvidenceExecutionSnapshot(job));
  const v4Artifact = Number(job?.handoff_version) === 4
    ? assertArtifactMatchesJob(job, { db })
    : null;
  const dispatch = opts.dispatch_queue_id
    ? db.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?').get(opts.dispatch_queue_id)
    : null;
  if (v4Artifact && opts.dispatch_queue_id
    && dispatch?.handoff_artifact_digest !== job.handoff_artifact_digest) {
    throw Object.assign(new Error('Dispatch artifact does not match the job artifact'), {
      code: 'HANDOFF_ARTIFACT_DIGEST_MISMATCH',
    });
  }
  const sourceRunId = v4Artifact
    ? (dispatch?.source_run_id ?? opts.triggered_by_run ?? opts.retry_of ?? opts.replay_of ?? null)
    : null;
  const sourceRun = sourceRunId
    ? db.prepare('SELECT id, handoff_artifact_digest FROM runs WHERE id = ?').get(sourceRunId)
    : null;
  const sourceArtifactDigest = v4Artifact
    ? (dispatch?.source_run_handoff_artifact_digest ?? sourceRun?.handoff_artifact_digest ?? null)
    : null;
  if (v4Artifact && sourceRunId && (
    !sourceRun
    || !sourceRun.handoff_artifact_digest
    || sourceArtifactDigest !== sourceRun.handoff_artifact_digest
  )) {
    throw Object.assign(new Error('Run source artifact does not match the exact source run'), {
      code: 'DELEGATION_SOURCE_ARTIFACT_MISMATCH',
    });
  }

  db.prepare(`
    INSERT INTO runs (
      id, job_id, status, run_timeout_ms, session_key, session_id,
      dispatched_at, context_summary, replay_of, idempotency_key, retry_count,
      retry_of, triggered_by_run, dispatch_queue_id,
      dispatcher_owner, dispatcher_token, dispatch_started_at,
      evidence_required, evidence_execution_snapshot,
      evidence_declaration_snapshot, evidence_ref_snapshot, approval_used,
      handoff_artifact_digest, runtime_instance_id, source_run_id,
      source_run_handoff_artifact_digest
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    jobId,
    opts.status || 'running',
    opts.run_timeout_ms || 300000,
    opts.session_key || null,
    opts.session_id || null,
    opts.context_summary ? JSON.stringify(opts.context_summary) : null,
    opts.replay_of || null,
    opts.idempotency_key || null,
    opts.retry_count ?? 0,
    opts.retry_of || null,
    opts.triggered_by_run || null,
    opts.dispatch_queue_id || null,
    hasDispatcherOwner ? dispatcherOwner : null,
    hasDispatcherToken ? dispatcherToken : null,
    opts.dispatch_started_at || (hasDispatcherOwner ? new Date().toISOString() : null),
    evidenceRequired,
    evidenceExecutionSnapshot,
    evidenceRequired === 1 ? job.evidence : null,
    evidenceRequired === 1 ? job.evidence_ref : null,
    opts.approval_used == null
      ? null
      : typeof opts.approval_used === 'string'
        ? opts.approval_used
        : JSON.stringify(opts.approval_used),
    v4Artifact ? job.handoff_artifact_digest : null,
    v4Artifact ? id : null,
    sourceRunId,
    sourceArtifactDigest,
  );

  const created = getRun(id);
  if (v4Artifact) {
    appendRuntimeEvent('run.created', {
      jobId,
      runId: id,
      dispatchQueueId: opts.dispatch_queue_id,
      handoffArtifactDigest: job.handoff_artifact_digest,
      sourceRunId,
      sourceRunHandoffArtifactDigest: sourceArtifactDigest,
      payload: {
        runtime_instance_id: id,
        dispatch_kind: dispatch?.dispatch_kind ?? null,
        status: created.status,
      },
    }, { db });
  }
  return created;
}

/**
 * Get a run by ID.
 */
export function getRun(id) {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

/**
 * Get runs for a job (most recent first).
 */
export function getRunsForJob(jobId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
  `).all(jobId, limit);
}

/**
 * Update run status to finished (ok/error/timeout).
 */
export function finishRun(id, status, opts = {}) {
  return finishRunCas(id, status, opts).run;
}

/**
 * Fenced terminal compare-and-swap. Unlike finishRun, this exposes whether the
 * transition won so dispatch finalization can suppress delivery, retries, and
 * child triggers after cancellation or lease takeover.
 */
export function finishRunCas(id, status, opts = {}, fencing = {}) {
  return transitionRunTerminal(id, status, opts, {
    ownerId: fencing.ownerId ?? fencing.dispatcher_owner ?? opts.dispatcher_owner ?? opts.ownerId,
    fencingToken: fencing.fencingToken ?? fencing.dispatcher_token ?? opts.dispatcher_token ?? opts.fencingToken,
    leaseName: fencing.leaseName ?? opts.leaseName,
  });
}

/**
 * Update last_heartbeat for a run (called by dispatcher when session activity detected).
 */
export function updateHeartbeat(id) {
  getDb().prepare(`
    UPDATE runs SET last_heartbeat = datetime('now') WHERE id = ?
  `).run(id);
}

/**
 * Update session info for a run.
 */
export function updateRunSession(id, sessionKey, sessionId) {
  getDb().prepare(`
    UPDATE runs SET session_key = ?, session_id = ? WHERE id = ?
  `).run(sessionKey, sessionId, id);
}

/**
 * Find stale runs: treats shell jobs and session-based jobs differently.
 *
 * - Session-based jobs (session_target != 'shell'): stale if last_heartbeat older than thresholdSeconds.
 *   These jobs emit heartbeats via gateway/session activity -- silence means stuck.
 * - Shell jobs (session_target = 'shell'): stale only if elapsed time > run_timeout_ms.
 *   Shell jobs have no heartbeat mechanism; they run until exit. Use timeout as the upper bound.
 *   Shell jobs with run_timeout_ms IS NULL are NOT flagged -- that's getTimedOutRuns' concern.
 *
 * Default threshold: 90 seconds (3 missed 30s heartbeats) for agent jobs.
 */
export function getStaleRuns(thresholdSeconds = 90) {
  if (!Number.isInteger(thresholdSeconds) || thresholdSeconds < 0) {
    throw new Error(`getStaleRuns: thresholdSeconds must be a non-negative integer, got ${thresholdSeconds}`);
  }
  return getDb().prepare(`
    SELECT r.*, j.name as job_name, j.run_timeout_ms as job_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
      AND (
        -- Shell jobs: stale only if they exceed their absolute run_timeout_ms
        (j.session_target = 'shell'
          AND r.run_timeout_ms IS NOT NULL
          AND (julianday('now') - julianday(COALESCE(r.dispatch_started_at, r.started_at))) * 86400000 > r.run_timeout_ms)
        OR
        -- Session-based jobs: stale if last_heartbeat not updated within threshold,
        -- or if they never heartbeated and started_at is past the threshold (startup grace)
        (j.session_target != 'shell'
          AND (r.last_heartbeat < datetime('now', '-' || ? || ' seconds')
               OR (r.last_heartbeat IS NULL
                   AND r.started_at < datetime('now', '-' || ? || ' seconds'))))
      )
  `).all(thresholdSeconds, thresholdSeconds);
}

/**
 * Find runs that have exceeded their absolute timeout (run_timeout_ms).
 *
 * Important overlap note: this function may return runs also returned by
 * `getStaleRuns`. Both queries match running runs that have exceeded their
 * run_timeout_ms. Callers must check the run's current status before acting
 * on results to avoid double-processing (e.g., finishing an already-finished run).
 *
 * This function serves as the fallback for when heartbeat-based stale detection
 * is not available -- for example, shell jobs that have no heartbeat mechanism,
 * or agent jobs whose first heartbeat has not yet arrived. Unlike `getStaleRuns`,
 * which requires a heartbeat timestamp to compare against, this function uses
 * only the run's started_at and run_timeout_ms columns.
 */
export function getTimedOutRuns() {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name, j.run_timeout_ms as job_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
      AND r.run_timeout_ms IS NOT NULL
      AND (julianday('now') - julianday(COALESCE(r.dispatch_started_at, r.started_at))) * 86400000 > r.run_timeout_ms
  `).all();
}

/**
 * Get active running runs (for heartbeat checking).
 */
export function getRunningRuns() {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name, j.run_timeout_ms as job_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
  `).all();
}

/**
 * Prune old runs (keep last N per job).
 */
export function pruneRuns(keepPerJob = 100) {
  const db = getDb();
  const jobs = db.prepare('SELECT id FROM jobs').all();

  for (const job of jobs) {
    db.prepare(`
      DELETE FROM runs
      WHERE job_id = ?
        AND status IN ('ok', 'error', 'timeout', 'skipped', 'cancelled', 'crashed')
        AND NOT EXISTS (
          SELECT 1 FROM job_dispatch_queue dispatch
          WHERE dispatch.source_run_id = runs.id
            AND dispatch.handoff_artifact_digest IS NOT NULL
        )
        AND id NOT IN (
        SELECT id FROM runs
        WHERE job_id = ?
          AND status IN ('ok', 'error', 'timeout', 'skipped', 'cancelled', 'crashed')
        ORDER BY started_at DESC LIMIT ?
      )
    `).run(job.id, job.id, keepPerJob);
  }
}

/**
 * Get all running runs for jobs in a given resource pool.
 */
export function getRunningRunsByPool(poolName) {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running' AND j.resource_pool = ?
  `).all(poolName);
}

/**
 * Store or update the context_summary JSON for a run.
 */
export function updateContextSummary(runId, summaryObj) {
  let nextSummary = summaryObj;
  const current = getRun(runId);
  if (current?.context_summary) {
    try {
      const existing = JSON.parse(current.context_summary);
      const incoming = typeof summaryObj === 'string' ? JSON.parse(summaryObj) : summaryObj;
      if (
        existing?.credential_cleanup
        && incoming
        && typeof incoming === 'object'
        && !Array.isArray(incoming)
        && incoming.credential_cleanup == null
      ) {
        nextSummary = {
          ...incoming,
          credential_cleanup: existing.credential_cleanup,
        };
      }
    } catch {
      // Preserve historical behavior for non-JSON summaries.
    }
  }
  const json = typeof nextSummary === 'string' ? nextSummary : JSON.stringify(nextSummary);
  getDb().prepare(`
    UPDATE runs SET context_summary = ? WHERE id = ?
  `).run(json, runId);
  return getRun(runId);
}

/**
 * Persist v0.2 runtime outcomes on a run record.
 *
 * Only updates columns present in the outcomes object. Values that are objects
 * are JSON-stringified before storage.
 *
 * Valid columns: identity_resolved, trust_evaluation, authorization_decision,
 * authorization_proof_verification, evidence_record, credential_handoff_summary.
 */
const V02_OUTCOME_COLUMNS = new Set([
  'identity_resolved',
  'trust_evaluation',
  'authorization_decision',
  'authorization_proof_verification',
  'evidence_record',
  'credential_handoff_summary',
  'delegation_validation',
]);

export function persistV02Outcomes(runId, outcomes, opts = {}) {
  if (!outcomes || typeof outcomes !== 'object') return;
  if (!runId) return;
  const db = opts.db || getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(outcomes)) {
    if (value === undefined) continue;
    if (!V02_OUTCOME_COLUMNS.has(key)) continue;
    if (!/^[a-z_]+$/.test(key)) throw new Error(`persistV02Outcomes: invalid column name "${key}"`);
    fields.push(`${key} = ?`);
    values.push(value != null && typeof value === 'object' ? JSON.stringify(value) : value);
  }
  const hasEvidenceRecord = Object.hasOwn(outcomes, 'evidence_record');
  const evidenceRecord = outcomes.evidence_record
    && typeof outcomes.evidence_record === 'object'
    && outcomes.evidence_record.algorithm === 'sha256'
    && outcomes.evidence_record.payload
    ? outcomes.evidence_record
    : null;
  if (hasEvidenceRecord && !evidenceRecord) {
    const error = new Error('Refusing to persist malformed evidence record');
    error.code = 'EVIDENCE_INTEGRITY_INVALID';
    throw error;
  }
  if (fields.length === 0 && !evidenceRecord) return;

  const requireRunningFence = opts.requireRunningFence === true;
  const dispatcherFence = opts.dispatcherFence || {};
  const ownerId = dispatcherFence.ownerId ?? dispatcherFence.dispatcher_owner ?? null;
  const fencingToken = dispatcherFence.fencingToken ?? dispatcherFence.dispatcher_token ?? null;
  const leaseName = dispatcherFence.leaseName || 'scheduler-dispatcher';
  if (requireRunningFence && (
    typeof ownerId !== 'string'
    || !ownerId
    || !Number.isInteger(fencingToken)
    || fencingToken <= 0
  )) {
    const error = new Error('A valid dispatcher fence is required for a running outcome checkpoint');
    error.code = 'RUN_OUTCOME_CHECKPOINT_FENCED';
    throw error;
  }

  const persist = () => {
    if (fields.length > 0) {
      const update = requireRunningFence
        ? db.prepare(`
            UPDATE runs
            SET ${fields.join(', ')}
            WHERE id = ?
              AND status = 'running'
              AND dispatcher_owner = ?
              AND dispatcher_token = ?
              AND EXISTS (
                SELECT 1
                FROM dispatcher_leases
                WHERE name = ?
                  AND owner_id = ?
                  AND fencing_token = ?
                  AND julianday(expires_at) > julianday('now')
              )
          `).run(...values, runId, ownerId, fencingToken, leaseName, ownerId, fencingToken)
        : db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values, runId);
      if (requireRunningFence && update.changes !== 1) {
        const error = new Error(`Run ${runId} is no longer owned by the live dispatcher fence`);
        error.code = 'RUN_OUTCOME_CHECKPOINT_FENCED';
        throw error;
      }
    }
    if (!evidenceRecord) return;

    const verification = verifyEvidenceRecord(evidenceRecord);
    if (!verification.valid) {
      const error = new Error(`Refusing to persist invalid evidence: ${verification.error || 'hash mismatch'}`);
      error.code = 'EVIDENCE_INTEGRITY_INVALID';
      throw error;
    }
    const run = db.prepare('SELECT job_id, status FROM runs WHERE id = ?').get(runId);
    if (!run) {
      const error = new Error(`Cannot persist evidence for missing run ${runId}`);
      error.code = 'RUN_NOT_FOUND';
      throw error;
    }
    if (evidenceRecord.payload.run?.id !== runId) {
      const error = new Error(`Evidence run binding ${JSON.stringify(evidenceRecord.payload.run?.id)} does not match target run ${runId}`);
      error.code = 'EVIDENCE_RUN_BINDING_MISMATCH';
      throw error;
    }
    if (evidenceRecord.payload.job_id !== run.job_id) {
      const error = new Error(`Evidence job binding ${JSON.stringify(evidenceRecord.payload.job_id)} does not match target job ${run.job_id}`);
      error.code = 'EVIDENCE_JOB_BINDING_MISMATCH';
      throw error;
    }
    if (evidenceRecord.payload.run?.status !== run.status
      || evidenceRecord.payload.result?.status !== run.status
      || evidenceRecord.payload.postcondition?.terminal_status !== run.status) {
      const error = new Error(`Evidence status does not match terminal run status ${JSON.stringify(run.status)}`);
      error.code = 'EVIDENCE_RUN_STATUS_MISMATCH';
      throw error;
    }
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
      const error = new Error(`Evidence cannot be persisted for non-terminal run status ${JSON.stringify(run.status)}`);
      error.code = 'EVIDENCE_RUN_STATUS_MISMATCH';
      throw error;
    }
    const existing = db.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(runId);
    if (existing && existing.hash !== evidenceRecord.hash) {
      const error = new Error(`Evidence for run ${runId} is immutable`);
      error.code = 'EVIDENCE_RECORD_IMMUTABLE';
      throw error;
    }
    if (!existing) {
      db.prepare(`
        INSERT INTO evidence_records (
          id, run_id, job_id, evidence_ref, algorithm, hash, payload,
          retention_policy, retention_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${runId}:${evidenceRecord.hash}`,
        runId,
        run.job_id,
        evidenceRecord.evidence_ref || null,
        evidenceRecord.algorithm,
        evidenceRecord.hash,
        JSON.stringify(evidenceRecord.payload),
        evidenceRecord.retention_policy || null,
        evidenceRecord.retention_until || null,
        evidenceRecord.created_at || new Date().toISOString(),
      );
    }
  };
  const transaction = db.transaction(persist);
  if (db.inTransaction) transaction();
  else transaction.immediate();
}

/** Persist scheduler-native checksum evidence after a terminal transition. */
export function persistTerminalEvidence(job, runId, status, fields = {}, outcomes = {}, opts = {}) {
  if (!job) return null;
  const db = opts.db || getDb();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) {
    const error = new Error(`Cannot generate evidence for missing run ${runId}`);
    error.code = 'RUN_NOT_FOUND';
    throw error;
  }
  if (run.status !== status) {
    const error = new Error(`Cannot generate ${status} evidence for run in status ${run.status}`);
    error.code = 'EVIDENCE_RUN_STATUS_MISMATCH';
    throw error;
  }
  const isApprovalGateRun = Boolean(
    db.prepare('SELECT 1 FROM approvals WHERE run_id = ? LIMIT 1').get(run.id),
  );
  if (isApprovalGateRun && run.evidence_required !== 1) return null;
  let executionSnapshot;
  try {
    executionSnapshot = run.evidence_execution_snapshot
      ? JSON.parse(run.evidence_execution_snapshot)
      : null;
  } catch (cause) {
    const error = new Error('Stored evidence execution snapshot is invalid JSON');
    error.code = 'EVIDENCE_EXECUTION_SNAPSHOT_INVALID';
    error.cause = cause;
    throw error;
  }
  let verificationResult = fields.verification_result ?? run.verification_result ?? null;
  const verificationSnapshot = executionSnapshot?.job_snapshot || {};
  if (
    verificationSnapshot.verification_declared === true
    && verificationResult == null
    && !isApprovalGateRun
  ) {
    verificationResult = {
      passed: false,
      status: 'interrupted',
      on_failure: verificationSnapshot.verify_on_failure || 'error',
      exit_code: null,
      signal: null,
      timed_out: status === 'timeout',
      duration_ms: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      stdout_sha256: null,
      stderr_sha256: null,
      error: `Verification did not complete before terminal status ${status}`,
    };
    db.prepare(`
      UPDATE runs
      SET verification_result = ?
      WHERE id = ? AND verification_result IS NULL
    `).run(JSON.stringify(verificationResult), run.id);
  }
  if (run.evidence_required !== 1) return null;
  const parseOutcome = field => {
    if (run[field] == null || Object.hasOwn(outcomes, field)) return undefined;
    try {
      return JSON.parse(run[field]);
    } catch (cause) {
      const error = new Error(`Stored ${field} outcome is invalid JSON`);
      error.code = 'EVIDENCE_OUTCOME_INVALID';
      error.cause = cause;
      throw error;
    }
  };
  const effectiveOutcomes = { ...outcomes };
  for (const field of [
    'identity_resolved', 'trust_evaluation', 'authorization_decision',
    'authorization_proof_verification', 'credential_handoff_summary',
    'delegation_validation',
  ]) {
    const parsed = parseOutcome(field);
    if (parsed !== undefined) effectiveOutcomes[field] = parsed;
  }
  if (status !== 'ok') {
    let declaration;
    try {
      declaration = run.evidence_declaration_snapshot
        ? JSON.parse(run.evidence_declaration_snapshot)
        : null;
    } catch (cause) {
      const error = new Error('Stored evidence declaration snapshot is invalid JSON');
      error.code = 'EVIDENCE_DECLARATION_SNAPSHOT_INVALID';
      error.cause = cause;
      throw error;
    }
    const requestedBindings = new Set(
      Array.isArray(declaration?.payload?.bind) ? declaration.payload.bind : [],
    );
    const reason = `Runtime evaluation did not complete before terminal status ${status}`;
    const interrupted = {
      identity: ['identity_resolved', { source: 'runtime-interrupted', error: reason }],
      trust: ['trust_evaluation', { decision: 'deny', enforcement: 'runtime-interrupted', reason }],
      authorization: ['authorization_decision', { decision: 'deny', source: 'runtime-interrupted', reason }],
      authorization_proof: ['authorization_proof_verification', { verified: false, source: 'runtime-interrupted', error: reason }],
      delegation: ['delegation_validation', {
        valid: false,
        acyclic: null,
        no_duplicate_hops: null,
        errors: [reason],
      }],
      credential_handoff: ['credential_handoff_summary', {
        mode: null,
        bindings_count: 0,
        cleanup_required: false,
        error: reason,
      }],
    };
    for (const binding of requestedBindings) {
      const fallback = interrupted[binding];
      if (fallback && effectiveOutcomes[fallback[0]] == null) {
        effectiveOutcomes[fallback[0]] = fallback[1];
      }
    }
  }
  const output = opts.output ?? fields.output ?? run.shell_stdout ?? null;
  const stderr = opts.stderr ?? fields.stderr ?? run.shell_stderr ?? null;
  const runMetadata = {
    id: run.id,
    status: run.status,
    summary: fields.summary ?? run.summary ?? null,
    output,
    stderr,
    stdout_sha256: opts.stdout_sha256 ?? fields.stdout_sha256 ?? null,
    stderr_sha256: opts.stderr_sha256 ?? fields.stderr_sha256 ?? (stderr == null ? null : undefined),
    stdout_bytes: opts.stdout_bytes ?? fields.stdout_bytes ?? run.shell_stdout_bytes
      ?? (output == null ? null : Buffer.byteLength(String(output), 'utf8')),
    stderr_bytes: opts.stderr_bytes ?? fields.stderr_bytes ?? run.shell_stderr_bytes
      ?? (stderr == null ? null : Buffer.byteLength(String(stderr), 'utf8')),
    exit_code: fields.shell_exit_code ?? run.shell_exit_code ?? null,
    signal: fields.shell_signal ?? run.shell_signal ?? null,
    timed_out: Boolean(fields.shell_timed_out ?? run.shell_timed_out ?? status === 'timeout'),
    structured_output: fields.structured_output ?? run.structured_output ?? null,
    structured_output_valid: fields.structured_output_valid ?? run.structured_output_valid ?? null,
    structured_output_warning: fields.structured_output_warning ?? run.structured_output_warning ?? null,
    structured_output_bytes: fields.structured_output_bytes ?? run.structured_output_bytes ?? null,
    structured_output_sha256: fields.structured_output_sha256 ?? run.structured_output_sha256 ?? null,
    structured_output_path: fields.structured_output_path ?? run.structured_output_path ?? null,
    verification_result: verificationResult,
  };
  runMetadata.execution_snapshot = executionSnapshot;
  const evidenceJob = {
    ...job,
    evidence: run.evidence_declaration_snapshot,
    evidence_ref: run.evidence_ref_snapshot,
  };
  const evidence = generateEvidence(evidenceJob, runMetadata, effectiveOutcomes);
  persistV02Outcomes(runId, { ...effectiveOutcomes, evidence_record: evidence }, { db });
  return evidence;
}

/**
 * Fail closed when recovery cannot safely construct the terminal evidence that
 * a run declared. This transition intentionally does not create evidence: the
 * recovery_blocked status and disabled job are the durable operator signal
 * that the evidence contract could not be satisfied.
 */
export function quarantineRunRecovery(runId, reason, opts = {}) {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('runId must be a non-empty string');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('reason must be a non-empty string');
  }
  const db = opts.db || getDb();
  const dispatcherFence = opts.dispatcherFence || null;
  const ownerId = dispatcherFence?.ownerId ?? dispatcherFence?.dispatcher_owner ?? null;
  const fencingToken = dispatcherFence?.fencingToken ?? dispatcherFence?.dispatcher_token ?? null;
  const leaseName = dispatcherFence?.leaseName || 'scheduler-dispatcher';
  const hasFence = dispatcherFence != null;
  const allowStaleRunOwner = opts.allowStaleRunOwner === true;
  if (allowStaleRunOwner && !hasFence) {
    throw new Error('allowStaleRunOwner requires a live dispatcher fence');
  }
  if (hasFence && (
    typeof ownerId !== 'string'
    || ownerId.trim().length === 0
    || !Number.isInteger(fencingToken)
    || fencingToken <= 0
  )) {
    throw new Error('A valid dispatcher fence is required for recovery quarantine');
  }

  const quarantine = () => {
    const updated = hasFence
      ? db.prepare(`
          UPDATE runs
          SET status = 'recovery_blocked',
              finished_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
              terminal_transition_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
              duration_ms = MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)),
              error_message = ?,
              summary = ?
          WHERE id = ?
            AND status = 'running'
            ${allowStaleRunOwner ? '' : 'AND dispatcher_owner = ? AND dispatcher_token = ?'}
            AND EXISTS (
              SELECT 1
              FROM dispatcher_leases
              WHERE name = ?
                AND owner_id = ?
                AND fencing_token = ?
                AND julianday(expires_at) > julianday('now')
            )
          RETURNING *
        `).get(
          reason,
          reason,
          runId,
          ...(allowStaleRunOwner ? [] : [ownerId, fencingToken]),
          leaseName,
          ownerId,
          fencingToken,
        )
      : db.prepare(`
          UPDATE runs
          SET status = 'recovery_blocked',
              finished_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
              terminal_transition_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
              duration_ms = MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)),
              error_message = ?,
              summary = ?
          WHERE id = ?
            AND status = 'running'
            AND dispatcher_owner IS NULL
            AND dispatcher_token IS NULL
          RETURNING *
        `).get(reason, reason, runId);
    if (!updated) {
      return { changed: false, run: db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) || null };
    }
    db.prepare(`
      UPDATE jobs
      SET enabled = 0,
          last_run_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
          last_status = 'recovery_blocked'
      WHERE id = ?
    `).run(updated.job_id);
    if (updated.dispatch_queue_id) {
      db.prepare(`
        UPDATE job_dispatch_queue
        SET status = 'failed',
            processed_at = COALESCE(processed_at, strftime('%Y-%m-%d %H:%M:%f', 'now')),
            claim_expires_at = NULL,
            last_error = ?
        WHERE id = ?
          AND status IN ('pending', 'claimed', 'awaiting_approval')
      `).run(reason, updated.dispatch_queue_id);
    }
    return { changed: true, run: updated };
  };
  const transaction = db.transaction(quarantine);
  return db.inTransaction ? transaction() : transaction.immediate();
}

/** Atomically transition a run and persist declared checksum evidence. */
export function transitionRunTerminalWithEvidence(
  job,
  runId,
  status,
  fields = {},
  outcomes = {},
  opts = {},
) {
  const db = opts.db || getDb();
  const commit = () => {
    const transition = transitionRunTerminal(runId, status, fields, {
      ownerId: opts.ownerId ?? opts.dispatcher_owner,
      fencingToken: opts.fencingToken ?? opts.dispatcher_token,
      leaseName: opts.leaseName,
    });
    if (transition.changed) {
      persistTerminalEvidence(
        job,
        runId,
        transition.run.status,
        fields,
        outcomes,
        { ...opts, db },
      );
    }
    return transition;
  };
  const transaction = db.transaction(commit);
  return db.inTransaction ? transaction() : transaction.immediate();
}

export function getEvidenceRecord(runId, opts = {}) {
  const row = (opts.db || getDb()).prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(runId);
  if (!row) return null;
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return { ...row, payload: null, integrity: { valid: false, error: 'stored payload is invalid JSON' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ...row,
      payload,
      integrity: { valid: false, error: 'stored payload is not an evidence object' },
    };
  }
  const record = {
    evidence_ref: row.evidence_ref,
    created_at: row.created_at,
    algorithm: row.algorithm,
    hash: row.hash,
    integrity: 'sha256',
    canonicalization: 'json-sort-v1',
    retention_policy: row.retention_policy || null,
    retention_until: row.retention_until || null,
    payload,
  };
  const integrity = verifyEvidenceRecord(record);
  const bindingErrors = [];
  if (payload.run?.id !== row.run_id) bindingErrors.push('stored run_id does not match payload.run.id');
  if (payload.job_id !== row.job_id) bindingErrors.push('stored job_id does not match payload.job_id');
  if (payload.evidence_ref !== row.evidence_ref) bindingErrors.push('stored evidence_ref does not match payload.evidence_ref');
  if (payload.created_at !== row.created_at) bindingErrors.push('stored created_at does not match payload.created_at');
  if ((payload.retention_policy ?? null) !== (row.retention_policy ?? null)) {
    bindingErrors.push('stored retention_policy does not match payload.retention_policy');
  }
  if ((payload.retention_until ?? null) !== (row.retention_until ?? null)) {
    bindingErrors.push('stored retention_until does not match payload.retention_until');
  }
  return {
    ...row,
    payload,
    integrity: bindingErrors.length === 0
      ? integrity
      : {
        ...integrity,
        valid: false,
        error: [...(integrity.errors || []), ...bindingErrors].join('; '),
        errors: [...(integrity.errors || []), ...bindingErrors],
      },
  };
}

/** Delete only evidence records whose explicit retention deadline has elapsed. */
export function pruneEvidenceRecords(opts = {}) {
  const db = opts.db || getDb();
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1000;
  const cutoff = opts.now == null ? new Date() : new Date(opts.now);
  if (Number.isNaN(cutoff.getTime())) throw new Error('invalid evidence retention cutoff');
  const candidates = db.prepare(`
    SELECT *
    FROM evidence_records
    WHERE retention_until IS NOT NULL
      AND julianday(retention_until) <= julianday(?)
    ORDER BY retention_until ASC
    LIMIT ?
  `).all(cutoff.toISOString(), limit);
  const remove = db.prepare('DELETE FROM evidence_records WHERE id = ?');
  const markPruned = db.prepare(`
    UPDATE runs
    SET evidence_record = ?
    WHERE id = ?
  `);
  const prune = () => {
    let changes = 0;
    for (const candidate of candidates) {
      let evidence;
      if (candidate.handoff_artifact_digest) {
        if (Date.parse(candidate.retention_until) > Date.now()) continue;
        try {
          validatePersistedArtifactBoundEvidenceRecord(candidate, { db });
          evidence = candidate;
        } catch {
          continue;
        }
      } else {
        evidence = getEvidenceRecord(candidate.run_id, { db });
        if (evidence?.integrity?.valid !== true) continue;
      }
      markPruned.run(JSON.stringify({
        pruned: true,
        reason: 'retention_expired',
        hash: evidence.hash,
        evidence_ref: evidence.evidence_ref,
        retention_until: evidence.retention_until,
        pruned_at: new Date().toISOString(),
      }), candidate.run_id);
      changes += remove.run(candidate.id).changes;
    }
    return { changes };
  };
  const transaction = db.transaction(prune);
  return db.inTransaction ? transaction() : transaction.immediate();
}
