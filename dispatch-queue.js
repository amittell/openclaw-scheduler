import { randomUUID } from 'crypto';
import { getDb } from './db.js';

const VALID_DISPATCH_KINDS = new Set(['manual', 'chain', 'retry']);
const VALID_DISPATCH_STATUSES = new Set([
  'pending',
  'claimed',
  'awaiting_approval',
  'done',
  'cancelled',
]);

// Private copy of sqliteNow to avoid circular dependency with dispatcher-utils.js.
// Must stay in sync with the sqliteNow exported from dispatcher-utils.js.
function sqliteNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function assertKind(kind) {
  if (!VALID_DISPATCH_KINDS.has(kind)) {
    throw new Error(`Invalid dispatch kind "${kind}". Valid: ${[...VALID_DISPATCH_KINDS].join(', ')}`);
  }
}

function assertStatus(status) {
  if (!VALID_DISPATCH_STATUSES.has(status)) {
    throw new Error(`Invalid dispatch status "${status}". Valid: ${[...VALID_DISPATCH_STATUSES].join(', ')}`);
  }
}

export function enqueueDispatch(jobId, opts = {}) {
  const db = getDb();
  const id = opts.id || randomUUID();
  const kind = opts.kind || 'manual';
  const status = opts.status || 'pending';
  assertKind(kind);
  assertStatus(status);

  db.prepare(`
    INSERT INTO job_dispatch_queue (
      id, job_id, dispatch_kind, status, scheduled_for,
      source_run_id, retry_of_run_id, created_at, claimed_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(
    id,
    jobId,
    kind,
    status,
    opts.scheduled_for || sqliteNow(-1000),
    opts.source_run_id || null,
    opts.retry_of_run_id || null,
    opts.claimed_at || null,
    opts.processed_at || null
  );

  return getDispatch(id);
}

export function getDispatch(id) {
  return getDb().prepare('SELECT * FROM job_dispatch_queue WHERE id = ?').get(id) || null;
}

export function getDueDispatches(limit = 100) {
  return getDb().prepare(`
    SELECT q.*, j.name as job_name
    FROM job_dispatch_queue q
    JOIN jobs j ON q.job_id = j.id
    WHERE q.status = 'pending'
      AND q.scheduled_for <= datetime('now')
    ORDER BY q.scheduled_for ASC, q.created_at ASC
    LIMIT ?
  `).all(limit);
}

export function claimDispatch(id) {
  const result = getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = 'claimed',
        claimed_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return result.changes > 0 ? getDispatch(id) : null;
}

export function releaseDispatch(id, scheduledFor = null) {
  const result = getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = 'pending',
        scheduled_for = COALESCE(?, scheduled_for),
        claimed_at = NULL
    WHERE id = ? AND status IN ('claimed', 'awaiting_approval')
  `).run(scheduledFor, id);
  return result.changes > 0 ? getDispatch(id) : null;
}

export function setDispatchStatus(id, status) {
  assertStatus(status);
  const processedAt = ['done', 'cancelled'].includes(status) ? sqliteNow() : null;
  getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = ?,
        processed_at = COALESCE(?, processed_at)
    WHERE id = ?
  `).run(status, processedAt, id);
  return getDispatch(id);
}

export function listDispatchesForJob(jobId, limit = 20) {
  return getDb().prepare(`
    SELECT *
    FROM job_dispatch_queue
    WHERE job_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(jobId, limit);
}
