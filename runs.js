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
      dispatched_at, context_summary, replay_of, idempotency_key,
      retry_of, triggered_by_run, dispatch_queue_id
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
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

  const startedAt = new Date(run.started_at + 'Z').getTime();
  const durationMs = Date.now() - startedAt;

  db.prepare(`
    UPDATE runs SET
      status = ?,
      finished_at = datetime('now'),
      duration_ms = ?,
      summary = ?,
      error_message = ?,
      context_summary = COALESCE(?, context_summary)
    WHERE id = ?
  `).run(
    status,
    durationMs,
    opts.summary || null,
    opts.error_message || null,
    opts.context_summary ? JSON.stringify(opts.context_summary) : null,
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
 * Find stale runs: status='running' AND last_heartbeat older than threshold.
 * Default threshold: 90 seconds (3 missed 30s heartbeats).
 */
export function getStaleRuns(thresholdSeconds = 90) {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name, j.run_timeout_ms as job_timeout_ms
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
      AND r.last_heartbeat < datetime('now', '-' || ? || ' seconds')
  `).all(thresholdSeconds);
}

/**
 * Find runs that have exceeded their absolute timeout.
 * This is the fallback when heartbeat-based detection isn't available.
 */
export function getTimedOutRuns() {
  return getDb().prepare(`
    SELECT r.*, j.name as job_name
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
