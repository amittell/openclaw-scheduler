import { getDb } from './db.js';

export const APPROVAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  DISPATCHING: 'dispatching',
  DISPATCHED: 'dispatched',
});

const ACTIVE_STATUSES = new Set([
  APPROVAL_STATUSES.PENDING,
  APPROVAL_STATUSES.APPROVED,
  APPROVAL_STATUSES.DISPATCHING,
]);

const PENDING_DECISIONS = new Set([
  APPROVAL_STATUSES.APPROVED,
  APPROVAL_STATUSES.REJECTED,
  APPROVAL_STATUSES.TIMED_OUT,
  APPROVAL_STATUSES.CANCELLED,
]);

function immediate(db, fn) {
  const transaction = db.transaction(fn);
  return db.inTransaction ? transaction() : transaction.immediate();
}

function approvalRow(db, id) {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) || null;
}

function normalizeText(value, fallback = null, maxLength = 4000) {
  if (value == null) return fallback;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function finishApprovalRun(db, approval, status, message) {
  if (!approval.run_id) return 0;
  const summary = status === APPROVAL_STATUSES.APPROVED ? message : null;
  const error = status === APPROVAL_STATUSES.APPROVED ? null : message;
  const runStatus = status === APPROVAL_STATUSES.APPROVED ? 'approved' : 'cancelled';
  const eligibleStatuses = status === APPROVAL_STATUSES.APPROVED
    ? "'awaiting_approval', 'pending'"
    : "'awaiting_approval', 'pending', 'approved'";
  return db.prepare(`
    UPDATE runs
    SET status = ?,
        finished_at = datetime('now'),
        duration_ms = MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)),
        summary = COALESCE(?, summary),
        error_message = COALESCE(?, error_message),
        terminal_transition_at = COALESCE(terminal_transition_at, datetime('now'))
    WHERE id = ? AND status IN (${eligibleStatuses})
  `).run(runStatus, summary, error, approval.run_id).changes;
}

function releaseApprovalDispatch(db, approval) {
  if (!approval.dispatch_queue_id) return 0;
  return db.prepare(`
    UPDATE job_dispatch_queue
    SET status = 'pending',
        scheduled_for = datetime('now'),
        claimed_at = NULL,
        processed_at = NULL,
        claim_owner = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        last_error = NULL
    WHERE id = ? AND status = 'awaiting_approval'
  `).run(approval.dispatch_queue_id).changes;
}

function cancelApprovalDispatch(db, approval, reason) {
  if (!approval.dispatch_queue_id) return 0;
  return db.prepare(`
    UPDATE job_dispatch_queue
    SET status = 'cancelled',
        processed_at = datetime('now'),
        claim_owner = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        last_error = ?
    WHERE id = ? AND status IN ('pending', 'claimed', 'awaiting_approval')
  `).run(reason, approval.dispatch_queue_id).changes;
}

function pendingTransitionSql(status) {
  if (!PENDING_DECISIONS.has(status)) {
    throw new Error(`Invalid pending approval transition '${status}'`);
  }
  return `
    UPDATE approvals
    SET status = ?,
        resolved_at = datetime('now'),
        resolved_by = ?,
        notes = COALESCE(?, notes),
        decision_version = decision_version + 1,
        approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END,
        rejected_at = CASE WHEN ? = 'rejected' THEN datetime('now') ELSE rejected_at END,
        cancelled_reason = CASE WHEN ? IN ('cancelled', 'timed_out') THEN ? ELSE cancelled_reason END
    WHERE id = ? AND status = 'pending'
  `;
}

function transitionPendingInTransaction(db, id, status, opts = {}) {
  const before = approvalRow(db, id);
  if (!before) return { changed: false, approval: null, reason: 'not_found' };
  if (before.status !== APPROVAL_STATUSES.PENDING) {
    return { changed: false, approval: before, reason: 'already_resolved' };
  }
  let effectiveStatus = status;
  let forcedReason = null;
  if (status === APPROVAL_STATUSES.APPROVED) {
    const job = db.prepare('SELECT enabled FROM jobs WHERE id = ?').get(before.job_id);
    const run = before.run_id
      ? db.prepare('SELECT status FROM runs WHERE id = ?').get(before.run_id)
      : null;
    const dispatch = before.dispatch_queue_id
      ? db.prepare('SELECT status FROM job_dispatch_queue WHERE id = ?').get(before.dispatch_queue_id)
      : null;
    if (!job || job.enabled !== 1) {
      effectiveStatus = APPROVAL_STATUSES.CANCELLED;
      forcedReason = !job ? 'Job deleted before approval' : 'Job disabled before approval';
    } else if (run && !['awaiting_approval', 'pending'].includes(run.status)) {
      effectiveStatus = APPROVAL_STATUSES.CANCELLED;
      forcedReason = `Approval run is already ${run.status}`;
    } else if (dispatch && dispatch.status === 'cancelled') {
      effectiveStatus = APPROVAL_STATUSES.CANCELLED;
      forcedReason = 'Dispatch was cancelled before approval';
    }
  }
  const resolvedBy = normalizeText(opts.resolvedBy, null, 200);
  const notes = normalizeText(opts.notes);
  const defaultReason = effectiveStatus === APPROVAL_STATUSES.REJECTED
    ? 'Rejected by operator'
    : effectiveStatus === APPROVAL_STATUSES.TIMED_OUT
      ? 'Approval timed out'
      : effectiveStatus === APPROVAL_STATUSES.CANCELLED
        ? 'Approval cancelled'
        : 'Approval granted';
  const reason = normalizeText(forcedReason ?? opts.reason ?? notes, defaultReason);
  const info = db.prepare(pendingTransitionSql(effectiveStatus)).run(
    effectiveStatus,
    resolvedBy,
    notes,
    effectiveStatus,
    effectiveStatus,
    effectiveStatus,
    reason,
    id
  );
  if (info.changes !== 1) {
    return { changed: false, approval: approvalRow(db, id), reason: 'concurrent_transition' };
  }

  const transitioned = approvalRow(db, id);
  if (effectiveStatus === APPROVAL_STATUSES.APPROVED) {
    finishApprovalRun(db, transitioned, effectiveStatus, reason);
    const released = releaseApprovalDispatch(db, transitioned);
    if (transitioned.dispatch_queue_id && released !== 1) {
      const dispatch = db.prepare('SELECT status FROM job_dispatch_queue WHERE id = ?')
        .get(transitioned.dispatch_queue_id);
      if (dispatch && dispatch.status !== 'pending') {
        throw new Error(`Approved dispatch could not be released from status '${dispatch.status}'`);
      }
    }
  } else {
    finishApprovalRun(db, transitioned, effectiveStatus, reason);
    cancelApprovalDispatch(db, transitioned, reason);
  }
  return { changed: true, approval: approvalRow(db, id), reason: null };
}

export function transitionPendingApproval(id, status, opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => transitionPendingInTransaction(db, id, status, opts));
}

export function getApprovalForDispatch(dispatchQueueId, opts = {}) {
  const db = opts.db || getDb();
  const activeOnly = opts.activeOnly !== false;
  const where = activeOnly
    ? "AND status IN ('pending', 'approved', 'dispatching')"
    : '';
  return db.prepare(`
    SELECT *
    FROM approvals
    WHERE dispatch_queue_id = ? ${where}
    ORDER BY requested_at DESC, id DESC
    LIMIT 1
  `).get(dispatchQueueId) || null;
}

export function beginApprovalDispatch(dispatchQueueId, opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approval = getApprovalForDispatch(dispatchQueueId, { db, activeOnly: false });
    if (!approval) return { changed: false, approval: null, reason: 'not_found' };
    if (approval.status === APPROVAL_STATUSES.DISPATCHED) {
      return { changed: false, approval, reason: 'already_dispatched' };
    }
    if (approval.status === APPROVAL_STATUSES.DISPATCHING) {
      return { changed: false, approval, reason: 'already_dispatching' };
    }
    if (approval.status !== APPROVAL_STATUSES.APPROVED) {
      return { changed: false, approval, reason: 'not_approved' };
    }

    const job = db.prepare('SELECT id, enabled FROM jobs WHERE id = ?').get(approval.job_id);
    if (!job || job.enabled !== 1) {
      const cancelled = cancelApprovalInTransaction(
        db,
        approval,
        !job ? 'Job deleted before approved dispatch' : 'Job disabled before approved dispatch',
        'scheduler'
      );
      return { ...cancelled, reason: 'job_unavailable' };
    }
    const dispatch = db.prepare(
      'SELECT status FROM job_dispatch_queue WHERE id = ?'
    ).get(dispatchQueueId);
    if (!dispatch || dispatch.status !== 'claimed') {
      return { changed: false, approval, reason: 'dispatch_not_claimed' };
    }

    const info = db.prepare(`
      UPDATE approvals
      SET status = 'dispatching', decision_version = decision_version + 1
      WHERE id = ? AND status = 'approved'
    `).run(approval.id);
    return {
      changed: info.changes === 1,
      approval: approvalRow(db, approval.id),
      reason: info.changes === 1 ? null : 'concurrent_transition',
    };
  });
}

export function markApprovalDispatched(dispatchQueueId, opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approval = getApprovalForDispatch(dispatchQueueId, { db, activeOnly: false });
    if (!approval) return { changed: false, approval: null, reason: 'not_found' };
    if (approval.status === APPROVAL_STATUSES.DISPATCHED) {
      return { changed: false, approval, reason: 'already_dispatched' };
    }
    if (approval.status !== APPROVAL_STATUSES.DISPATCHING) {
      return { changed: false, approval, reason: 'not_dispatching' };
    }
    const notes = normalizeText(opts.notes);
    const info = db.prepare(`
      UPDATE approvals
      SET status = 'dispatched',
          dispatched_at = datetime('now'),
          notes = COALESCE(?, notes),
          decision_version = decision_version + 1
      WHERE id = ? AND status = 'dispatching'
    `).run(notes, approval.id);
    return {
      changed: info.changes === 1,
      approval: approvalRow(db, approval.id),
      reason: info.changes === 1 ? null : 'concurrent_transition',
    };
  });
}

export function deferApprovalDispatch(dispatchQueueId, reason = null, opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approval = getApprovalForDispatch(dispatchQueueId, { db, activeOnly: false });
    if (!approval) return { changed: false, approval: null, reason: 'not_found' };
    if (approval.status === APPROVAL_STATUSES.APPROVED) {
      return { changed: false, approval, reason: 'already_deferred' };
    }
    if (approval.status !== APPROVAL_STATUSES.DISPATCHING) {
      return { changed: false, approval, reason: 'not_dispatching' };
    }
    const scheduledFor = opts.scheduledFor || null;
    const info = db.prepare(`
      UPDATE approvals
      SET status = 'approved',
          notes = COALESCE(?, notes),
          decision_version = decision_version + 1
      WHERE id = ? AND status = 'dispatching'
    `).run(normalizeText(reason), approval.id);
    if (info.changes === 1 && approval.dispatch_queue_id) {
      db.prepare(`
        UPDATE job_dispatch_queue
        SET status = 'pending',
            scheduled_for = COALESCE(?, scheduled_for),
            claimed_at = NULL,
            claim_owner = NULL,
            claim_token = NULL,
            claim_expires_at = NULL
        WHERE id = ? AND status = 'claimed'
      `).run(scheduledFor, approval.dispatch_queue_id);
    }
    return {
      changed: info.changes === 1,
      approval: approvalRow(db, approval.id),
      reason: info.changes === 1 ? null : 'concurrent_transition',
    };
  });
}

function cancelApprovalInTransaction(db, approval, reason, resolvedBy) {
  if (!approval) return { changed: false, approval: null, reason: 'not_found' };
  if (approval.status === APPROVAL_STATUSES.CANCELLED) {
    return { changed: false, approval, reason: 'already_cancelled' };
  }
  if (!ACTIVE_STATUSES.has(approval.status)) {
    return { changed: false, approval, reason: 'terminal' };
  }
  const normalizedReason = normalizeText(reason, 'Approval cancelled');
  const info = db.prepare(`
    UPDATE approvals
    SET status = 'cancelled',
        resolved_at = COALESCE(resolved_at, datetime('now')),
        resolved_by = COALESCE(?, resolved_by),
        cancelled_reason = ?,
        notes = COALESCE(notes, ?),
        decision_version = decision_version + 1
    WHERE id = ? AND status IN ('pending', 'approved', 'dispatching')
  `).run(normalizeText(resolvedBy, 'scheduler', 200), normalizedReason, normalizedReason, approval.id);
  if (info.changes === 1) {
    const transitioned = approvalRow(db, approval.id);
    finishApprovalRun(db, transitioned, APPROVAL_STATUSES.CANCELLED, normalizedReason);
    cancelApprovalDispatch(db, transitioned, normalizedReason);
  }
  return {
    changed: info.changes === 1,
    approval: approvalRow(db, approval.id),
    reason: info.changes === 1 ? null : 'concurrent_transition',
  };
}

export function cancelApproval(id, reason = 'Approval cancelled', opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => cancelApprovalInTransaction(
    db,
    approvalRow(db, id),
    reason,
    opts.resolvedBy || 'scheduler'
  ));
}

export function cancelApprovalForDispatch(
  dispatchQueueId,
  reason = 'Approved dispatch cancelled before execution',
  opts = {}
) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approval = getApprovalForDispatch(dispatchQueueId, { db, activeOnly: true });
    return cancelApprovalInTransaction(
      db,
      approval,
      reason,
      opts.resolvedBy || 'scheduler'
    );
  });
}

export function cancelApprovalsForJob(jobId, reason = 'Job disabled or deleted', opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approvals = db.prepare(`
      SELECT * FROM approvals
      WHERE job_id = ? AND status IN ('pending', 'approved', 'dispatching')
      ORDER BY requested_at ASC
    `).all(jobId);
    let changed = 0;
    for (const approval of approvals) {
      if (cancelApprovalInTransaction(db, approval, reason, opts.resolvedBy || 'scheduler').changed) {
        changed += 1;
      }
    }
    return { changed, approvals: approvals.map(row => approvalRow(db, row.id)).filter(Boolean) };
  });
}

export function cancelUnavailableJobApprovals(opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approvals = db.prepare(`
      SELECT a.*, j.enabled AS job_enabled
      FROM approvals a
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.status IN ('pending', 'approved', 'dispatching')
        AND (j.id IS NULL OR j.enabled != 1)
      ORDER BY a.requested_at ASC
    `).all();
    let changed = 0;
    for (const approval of approvals) {
      const reason = approval.job_enabled == null
        ? 'Job deleted before approval completed'
        : 'Job disabled before approval completed';
      if (cancelApprovalInTransaction(db, approval, reason, 'scheduler').changed) changed += 1;
    }
    return { changed, approvals: approvals.map(row => approvalRow(db, row.id)).filter(Boolean) };
  });
}

export function recoverInterruptedApprovalDispatches(opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const approvals = db.prepare(`
      SELECT a.*, q.status AS queue_status, q.claim_expires_at,
             EXISTS (
               SELECT 1 FROM runs r
               WHERE r.dispatch_queue_id = a.dispatch_queue_id
                 AND r.id != COALESCE(a.run_id, '')
             ) AS has_execution_run
      FROM approvals a
      LEFT JOIN job_dispatch_queue q ON q.id = a.dispatch_queue_id
      WHERE a.status = 'dispatching'
    `).all();
    let recovered = 0;
    const now = db.prepare("SELECT datetime('now') AS value").get().value;
    for (const approval of approvals) {
      if (approval.has_execution_run || approval.queue_status === 'done') {
        const info = db.prepare(`
          UPDATE approvals
          SET status = 'dispatched',
              dispatched_at = COALESCE(dispatched_at, datetime('now')),
              decision_version = decision_version + 1
          WHERE id = ? AND status = 'dispatching'
        `).run(approval.id);
        recovered += info.changes;
        continue;
      }
      if (!approval.dispatch_queue_id || ['cancelled', 'failed'].includes(approval.queue_status)) {
        if (cancelApprovalInTransaction(db, approval, 'Approved dispatch was cancelled before execution', 'scheduler').changed) {
          recovered += 1;
        }
        continue;
      }
      const recoverableQueue = ['pending', 'awaiting_approval'].includes(approval.queue_status)
        || (
          approval.queue_status === 'claimed'
          && approval.claim_expires_at != null
          && approval.claim_expires_at <= now
        );
      if (!recoverableQueue) continue;
      const info = db.prepare(`
        UPDATE approvals
        SET status = 'approved', decision_version = decision_version + 1
        WHERE id = ? AND status = 'dispatching'
      `).run(approval.id);
      if (info.changes === 1) {
        db.prepare(`
          UPDATE job_dispatch_queue
          SET status = 'pending',
              claimed_at = NULL,
              claim_owner = NULL,
              claim_token = NULL,
              claim_expires_at = NULL
          WHERE id = ? AND status IN ('pending', 'claimed', 'awaiting_approval')
        `).run(approval.dispatch_queue_id);
        recovered += 1;
      }
    }
    return { recovered };
  });
}
