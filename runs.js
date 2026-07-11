// Run lifecycle management
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { transitionRunTerminal } from './run-state.js';

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

  db.prepare(`
    INSERT INTO runs (
      id, job_id, status, run_timeout_ms, session_key, session_id,
      dispatched_at, context_summary, replay_of, idempotency_key, retry_count,
      retry_of, triggered_by_run, dispatch_queue_id,
      dispatcher_owner, dispatcher_token, dispatch_started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    opts.dispatch_started_at || (hasDispatcherOwner ? new Date().toISOString() : null)
  );

  return getRun(id);
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
      DELETE FROM runs WHERE job_id = ? AND id NOT IN (
        SELECT id FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
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
]);

export function persistV02Outcomes(runId, outcomes) {
  if (!outcomes || typeof outcomes !== 'object') return;
  if (!runId) return;
  const db = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(outcomes)) {
    if (value === undefined) continue;
    if (!V02_OUTCOME_COLUMNS.has(key)) continue;
    if (!/^[a-z_]+$/.test(key)) throw new Error(`persistV02Outcomes: invalid column name "${key}"`);
    fields.push(`${key} = ?`);
    values.push(value != null && typeof value === 'object' ? JSON.stringify(value) : value);
  }
  if (fields.length === 0) return;
  values.push(runId);
  db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}
