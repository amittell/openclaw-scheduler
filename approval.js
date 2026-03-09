// Approval gate management for HITL workflows
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

/**
 * Create a pending approval record for a job (optionally linked to a run).
 */
export function createApproval(jobId, runId, dispatchQueueId = null) {
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO approvals (id, job_id, run_id, dispatch_queue_id, status, requested_at)
    VALUES (?, ?, ?, ?, 'pending', datetime('now'))
  `).run(id, jobId, runId || null, dispatchQueueId || null);

  return getApproval(id);
}

/**
 * Get an approval by ID.
 */
export function getApproval(id) {
  return getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id);
}

/**
 * Get the latest pending approval for a job (if any).
 */
export function getPendingApproval(jobId) {
  return getDb().prepare(`
    SELECT * FROM approvals
    WHERE job_id = ? AND status = 'pending'
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(jobId);
}

/**
 * List all pending approvals.
 */
export function listPendingApprovals() {
  return getDb().prepare(`
    SELECT a.*, j.name as job_name
    FROM approvals a
    LEFT JOIN jobs j ON a.job_id = j.id
    WHERE a.status = 'pending'
    ORDER BY a.requested_at ASC
  `).all();
}

export function countPendingApprovalsForJob(jobId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS cnt
    FROM approvals
    WHERE job_id = ? AND status = 'pending'
  `).get(jobId);
  return row?.cnt || 0;
}

/**
 * Resolve an approval (approve / reject / timed_out).
 */
export function resolveApproval(id, status, resolvedBy, notes) {
  const db = getDb();
  db.prepare(`
    UPDATE approvals SET
      status = ?,
      resolved_at = datetime('now'),
      resolved_by = ?,
      notes = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, resolvedBy || null, notes || null, id);

  return getApproval(id);
}

/**
 * Get pending approvals that have exceeded their job's approval_timeout_s.
 * Joins with jobs to read the timeout value.
 */
export function getTimedOutApprovals() {
  return getDb().prepare(`
    SELECT a.*, j.name as job_name, j.approval_timeout_s, j.approval_auto
    FROM approvals a
    JOIN jobs j ON a.job_id = j.id
    WHERE a.status = 'pending'
      AND (julianday('now') - julianday(a.requested_at)) * 86400 > j.approval_timeout_s
  `).all();
}

/**
 * Prune old resolved approvals past retention.
 */
export function pruneApprovals(retentionDays = 30) {
  return getDb().prepare(`
    DELETE FROM approvals
    WHERE status != 'pending'
      AND resolved_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
}
