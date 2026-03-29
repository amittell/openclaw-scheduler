// Run lifecycle management
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

/**
 * Create a new run for a job.
 */
export function createRun(jobId, opts = {}) {
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO runs (
      id, job_id, status, run_timeout_ms, session_key, session_id,
      dispatched_at, context_summary, replay_of, idempotency_key, retry_count,
      retry_of, triggered_by_run, dispatch_queue_id
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
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
    opts.dispatch_queue_id || null
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
  const db = getDb();
  const run = getRun(id);
  if (!run) return null;

  const iso = run.started_at
    ? (run.started_at.includes('T') ? run.started_at : run.started_at.replace(' ', 'T') + 'Z')
    : null;
  const startedAt = iso ? new Date(iso).getTime() : Date.now();
  const durationMs = Date.now() - startedAt;

  db.prepare(`
    UPDATE runs SET
      status = ?,
      finished_at = datetime('now'),
      duration_ms = ?,
      summary = COALESCE(?, summary),
      error_message = COALESCE(?, error_message),
      context_summary = COALESCE(?, context_summary),
      shell_exit_code = COALESCE(?, shell_exit_code),
      shell_signal = COALESCE(?, shell_signal),
      shell_timed_out = COALESCE(?, shell_timed_out),
      shell_stdout = COALESCE(?, shell_stdout),
      shell_stderr = COALESCE(?, shell_stderr),
      shell_stdout_path = COALESCE(?, shell_stdout_path),
      shell_stderr_path = COALESCE(?, shell_stderr_path),
      shell_stdout_bytes = COALESCE(?, shell_stdout_bytes),
      shell_stderr_bytes = COALESCE(?, shell_stderr_bytes)
    WHERE id = ? AND status IN ('pending', 'running', 'awaiting_approval', 'approved')
  `).run(
    status,
    durationMs,
    opts.summary || null,
    opts.error_message || null,
    opts.context_summary ? JSON.stringify(opts.context_summary) : null,
    opts.shell_exit_code ?? null,
    opts.shell_signal ?? null,
    opts.shell_timed_out != null ? Number(Boolean(opts.shell_timed_out)) : null,
    opts.shell_stdout ?? null,
    opts.shell_stderr ?? null,
    opts.shell_stdout_path ?? null,
    opts.shell_stderr_path ?? null,
    opts.shell_stdout_bytes ?? null,
    opts.shell_stderr_bytes ?? null,
    id
  );

  return getRun(id);
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
 *   These jobs emit heartbeats via gateway/session activity — silence means stuck.
 * - Shell jobs (session_target = 'shell'): stale only if elapsed time > run_timeout_ms.
 *   Shell jobs have no heartbeat mechanism; they run until exit. Use timeout as the upper bound.
 *   Shell jobs with run_timeout_ms IS NULL are NOT flagged — that's getTimedOutRuns' concern.
 *
 * Default threshold: 90 seconds (3 missed 30s heartbeats) for agent jobs.
 */
export function getStaleRuns(thresholdSeconds = 90) {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name, j.run_timeout_ms as job_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
      AND (
        -- Shell jobs: stale only if they exceed their absolute run_timeout_ms
        (j.session_target = 'shell'
          AND r.run_timeout_ms IS NOT NULL
          AND (julianday('now') - julianday(r.started_at)) * 86400000 > r.run_timeout_ms)
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
      AND (julianday('now') - julianday(r.started_at)) * 86400000 > r.run_timeout_ms
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
  const json = typeof summaryObj === 'string' ? summaryObj : JSON.stringify(summaryObj);
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
  const db = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(outcomes)) {
    if (value === undefined) continue;
    if (!V02_OUTCOME_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value != null && typeof value === 'object' ? JSON.stringify(value) : value);
  }
  if (fields.length === 0) return;
  values.push(runId);
  db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}
