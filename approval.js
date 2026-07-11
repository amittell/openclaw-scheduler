// Approval gate management for HITL workflows
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import {
  APPROVAL_STATUSES,
  beginApprovalDispatch,
  cancelApproval,
  cancelApprovalForDispatch,
  cancelApprovalsForJob,
  cancelUnavailableJobApprovals,
  deferApprovalDispatch,
  getApprovalForDispatch,
  markApprovalDispatched,
  recoverInterruptedApprovalDispatches,
  transitionPendingApproval,
} from './approval-state.js';

function sqliteTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid approval expiration timestamp');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Create a pending approval record for a job (optionally linked to a run).
 */
export function createApproval(jobId, runId, dispatchQueueId = null, opts = {}) {
  const db = opts.db || getDb();
  const id = randomUUID();
  const create = () => {
    const job = db.prepare(
      'SELECT id, enabled, approval_timeout_s FROM jobs WHERE id = ?'
    ).get(jobId);
    if (!job) throw new Error(`Cannot create approval for missing job '${jobId}'`);
    if (job.enabled !== 1) throw new Error(`Cannot create approval for disabled job '${jobId}'`);

    if (dispatchQueueId) {
      const existing = db.prepare(`
        SELECT * FROM approvals
        WHERE dispatch_queue_id = ?
        ORDER BY requested_at DESC, id DESC
        LIMIT 1
      `).get(dispatchQueueId);
      if (existing) return { ...existing, deduped: true };
    }

    const timeoutSeconds = opts.timeoutSeconds ?? job.approval_timeout_s;
    const expiresAt = opts.expiresAt
      ? sqliteTimestamp(opts.expiresAt)
      : Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
        ? sqliteTimestamp(Date.now() + Number(timeoutSeconds) * 1000)
        : null;
    db.prepare(`
      INSERT INTO approvals (
        id, job_id, run_id, dispatch_queue_id, status, requested_at, expires_at
      ) VALUES (?, ?, ?, ?, 'pending', datetime('now'), ?)
    `).run(id, jobId, runId || null, dispatchQueueId || null, expiresAt);

    if (runId) {
      db.prepare(`
        UPDATE runs
        SET status = 'awaiting_approval'
        WHERE id = ? AND status = 'pending'
      `).run(runId);
    }
    if (dispatchQueueId) {
      db.prepare(`
        UPDATE job_dispatch_queue
        SET status = 'awaiting_approval',
            claim_owner = NULL,
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE id = ? AND status IN ('pending', 'claimed')
      `).run(dispatchQueueId);
    }

    return { ...getApproval(id, { db }), deduped: false };
  };
  const transaction = db.transaction(create);
  return db.inTransaction ? transaction() : transaction.immediate();
}

/**
 * Get an approval by ID.
 */
export function getApproval(id, opts = {}) {
  return (opts.db || getDb()).prepare('SELECT * FROM approvals WHERE id = ?').get(id);
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
const VALID_APPROVAL_STATUSES = new Set(['approved', 'rejected', 'timed_out', 'cancelled']);

export function resolveApproval(id, status, resolvedBy, notes) {
  if (!VALID_APPROVAL_STATUSES.has(status)) {
    throw new Error(`Invalid approval status '${status}': must be one of ${[...VALID_APPROVAL_STATUSES].join(', ')}`);
  }
  const transition = status === APPROVAL_STATUSES.CANCELLED
    ? cancelApproval(id, notes || 'Approval cancelled', { resolvedBy: resolvedBy || null })
    : transitionPendingApproval(id, status, {
      resolvedBy: resolvedBy || null,
      notes: notes || null,
      reason: notes || null,
    });
  return transition.approval;
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
      AND (
        (a.expires_at IS NOT NULL AND a.expires_at <= datetime('now'))
        OR (
          j.approval_timeout_s IS NOT NULL
          AND (julianday('now') - julianday(a.requested_at)) * 86400 > j.approval_timeout_s
        )
      )
  `).all();
}

/**
 * Prune old resolved approvals past retention.
 */
export function pruneApprovals(retentionDays = 30) {
  return getDb().prepare(`
    DELETE FROM approvals
    WHERE status IN ('rejected', 'timed_out', 'cancelled', 'dispatched')
      AND resolved_at < datetime('now', '-' || ? || ' days')
  `).run(retentionDays);
}

export {
  APPROVAL_STATUSES,
  beginApprovalDispatch,
  cancelApproval,
  cancelApprovalForDispatch,
  cancelApprovalsForJob,
  cancelUnavailableJobApprovals,
  deferApprovalDispatch,
  getApprovalForDispatch,
  markApprovalDispatched,
  recoverInterruptedApprovalDispatches,
};
