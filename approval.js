// Approval gate management for HITL workflows
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { appendRuntimeEvent } from './runtime-events.js';
import {
  approvalBindingHashForDb,
  approverMatchesScope,
  getAuthenticatedApprovalActor,
} from './approval-binding.js';
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

function approvalAssociationError(message) {
  const error = new Error(message);
  error.code = 'APPROVAL_ASSOCIATION_MISMATCH';
  return error;
}

/**
 * Create a pending approval record for a job (optionally linked to a run).
 */
export function createApproval(jobId, runId, dispatchQueueId = null, opts = {}) {
  const db = opts.db || getDb();
  const id = randomUUID();
  const gateKind = opts.gateKind || 'job';
  if (!['job', 'authorization'].includes(gateKind)) {
    throw new Error(`Invalid approval gate kind '${gateKind}'`);
  }
  const create = () => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error(`Cannot create approval for missing job '${jobId}'`);
    if (job.enabled !== 1) throw new Error(`Cannot create approval for disabled job '${jobId}'`);

    const dispatch = dispatchQueueId
      ? db.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?').get(dispatchQueueId)
      : null;
    if (dispatchQueueId && !dispatch) {
      throw approvalAssociationError('Cannot create approval for a missing dispatch');
    }
    if (dispatch && dispatch.job_id !== jobId) {
      throw approvalAssociationError('Approval dispatch belongs to a different job');
    }

    const run = runId
      ? db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
      : null;
    if (runId && !run) {
      throw approvalAssociationError('Cannot create approval for a missing run');
    }
    if (run && run.job_id !== jobId) {
      throw approvalAssociationError('Approval run belongs to a different job');
    }
    if (run && dispatch && run.dispatch_queue_id !== dispatchQueueId) {
      throw approvalAssociationError('Approval run belongs to a different dispatch');
    }

    if (dispatchQueueId) {
      const existing = db.prepare(`
        SELECT * FROM approvals
        WHERE dispatch_queue_id = ?
          AND gate_kind = ?
          AND status IN ('pending', 'approved', 'dispatching')
        ORDER BY requested_at DESC, rowid DESC
        LIMIT 1
      `).get(dispatchQueueId, gateKind);
      if (existing) {
        if (
          existing.job_id !== jobId
          || (existing.run_id || null) !== (runId || null)
          || existing.dispatch_queue_id !== dispatchQueueId
          || (Number(job.handoff_version) === 4 && (
            existing.handoff_artifact_digest !== job.handoff_artifact_digest
            || existing.source_run_id !== (dispatch?.source_run_id || null)
            || existing.source_run_handoff_artifact_digest
              !== (dispatch?.source_run_handoff_artifact_digest || null)
          ))
        ) {
          throw approvalAssociationError('Existing approval belongs to a different job, run, or dispatch');
        }
        const existingRun = existing.run_id
          ? db.prepare('SELECT job_id, dispatch_queue_id FROM runs WHERE id = ?').get(existing.run_id)
          : null;
        if (
          existing.run_id
          && (
            !existingRun
            || existingRun.job_id !== existing.job_id
            || existingRun.dispatch_queue_id !== existing.dispatch_queue_id
          )
        ) {
          throw approvalAssociationError('Existing approval has an invalid run association');
        }
        return { ...existing, deduped: true };
      }
    }

    const timeoutSeconds = opts.timeoutSeconds ?? job.approval_timeout_s;
    const expiresAt = opts.expiresAt
      ? sqliteTimestamp(opts.expiresAt)
      : Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
        ? sqliteTimestamp(Date.now() + Number(timeoutSeconds) * 1000)
        : null;
    db.prepare(`
      INSERT INTO approvals (
        id, job_id, run_id, dispatch_queue_id, status, requested_at, expires_at,
        risk_level, approver_scope, binding_hash, gate_kind, decision_context,
        handoff_artifact_digest, source_run_id,
        source_run_handoff_artifact_digest
      ) VALUES (?, ?, ?, ?, 'pending', datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      jobId,
      runId || null,
      dispatchQueueId || null,
      expiresAt,
      opts.riskLevel || job.approval_risk_level || null,
      opts.approverScope ?? job.approval_approver_scope ?? null,
      approvalBindingHashForDb(db, job, { dispatchQueueId }),
      gateKind,
      opts.decisionContext == null
        ? null
        : typeof opts.decisionContext === 'string'
          ? opts.decisionContext
          : JSON.stringify(opts.decisionContext),
      Number(job.handoff_version) === 4 ? job.handoff_artifact_digest : null,
      Number(job.handoff_version) === 4 ? (dispatch?.source_run_id || run?.source_run_id || null) : null,
      Number(job.handoff_version) === 4
        ? (dispatch?.source_run_handoff_artifact_digest
          || run?.source_run_handoff_artifact_digest
          || null)
        : null,
    );

    if (Number(job.handoff_version) === 4) {
      if (dispatch?.handoff_artifact_digest !== job.handoff_artifact_digest
        || (run && run.handoff_artifact_digest !== job.handoff_artifact_digest)) {
        throw approvalAssociationError('Approval artifact does not match its job, run, and dispatch');
      }
      if ((dispatch?.source_run_id || null) !== (run?.source_run_id || null)
        || (dispatch?.source_run_handoff_artifact_digest || null)
          !== (run?.source_run_handoff_artifact_digest || null)) {
        throw approvalAssociationError('Approval source-run binding does not match its run and dispatch');
      }
    }

    if (runId) {
      db.prepare(`
        UPDATE runs
        SET status = 'awaiting_approval',
            dispatcher_owner = NULL,
            dispatcher_token = NULL
        WHERE id = ? AND status IN ('pending', 'running')
      `).run(runId);
    }
    if (opts.releaseIdempotencyKey && runId) {
      db.prepare(`
        DELETE FROM idempotency_ledger
        WHERE key = ? AND run_id = ? AND status = 'claimed'
      `).run(opts.releaseIdempotencyKey, runId);
      db.prepare(`
        UPDATE runs
        SET idempotency_key = NULL
        WHERE id = ?
          AND status = 'awaiting_approval'
          AND idempotency_key = ?
      `).run(runId, opts.releaseIdempotencyKey);
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

    const created = { ...getApproval(id, { db }), deduped: false };
    if (Number(job.handoff_version) === 4) {
      appendRuntimeEvent('approval.requested', {
        jobId,
        runId,
        approvalId: id,
        dispatchQueueId,
        handoffArtifactDigest: job.handoff_artifact_digest,
        sourceRunId: created.source_run_id,
        sourceRunHandoffArtifactDigest: created.source_run_handoff_artifact_digest,
        payload: { gate_kind: gateKind, binding_hash: created.binding_hash },
      }, { db });
    }
    return created;
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
export function getPendingApproval(jobId, opts = {}) {
  return (opts.db || getDb()).prepare(`
    SELECT * FROM approvals
    WHERE job_id = ? AND status = 'pending'
    ORDER BY requested_at DESC, rowid DESC
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

export function resolveApproval(id, status, resolvedBy, notes, opts = {}) {
  if (!VALID_APPROVAL_STATUSES.has(status)) {
    throw new Error(`Invalid approval status '${status}': must be one of ${[...VALID_APPROVAL_STATUSES].join(', ')}`);
  }
  const automaticActor = opts.automatic === true
    ? (typeof resolvedBy === 'string' && resolvedBy.trim() ? resolvedBy.trim() : 'scheduler')
    : null;
  const authenticatedActor = automaticActor ? null : getAuthenticatedApprovalActor();
  const canonicalActor = automaticActor || authenticatedActor.canonical;
  if (status === APPROVAL_STATUSES.CANCELLED) {
    return cancelApproval(id, notes || 'Approval cancelled', {
      resolvedBy: canonicalActor,
      db: opts.db,
    }).approval;
  }
  const transition = transitionPendingApproval(id, status, {
    resolvedBy: canonicalActor,
    authenticatedActor,
    automatic: Boolean(automaticActor),
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
  approverMatchesScope,
};
