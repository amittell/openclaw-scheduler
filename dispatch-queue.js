import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { sqliteNow } from './dispatcher-utils.js';

const VALID_DISPATCH_KINDS = new Set(['manual', 'chain', 'retry', 'schedule', 'at']);
const VALID_DISPATCH_STATUSES = new Set([
  'pending',
  'claimed',
  'awaiting_approval',
  'done',
  'cancelled',
  'failed',
]);

function claimExpiryModifier(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new Error('leaseMs must be a positive integer');
  }
  return `+${leaseMs / 1000} seconds`;
}

function normalizeClaimIdentity(opts = {}, { generateToken = false } = {}) {
  const owner = opts.ownerId ?? opts.claimOwner ?? opts.claim_owner ?? null;
  let token = opts.claimToken ?? opts.claim_token ?? null;
  const hasOwner = typeof owner === 'string' && owner.trim().length > 0;
  const hasToken = typeof token === 'string' && token.trim().length > 0;
  if (hasOwner && !hasToken && generateToken) token = randomUUID();
  if (hasOwner !== (typeof token === 'string' && token.trim().length > 0)) {
    throw new Error('claim owner and token must be provided together');
  }
  return hasOwner ? { owner, token } : null;
}

function verifyIdempotentDispatch(existing, jobId, kind, binding = {}) {
  if (existing.job_id !== jobId || existing.dispatch_kind !== kind) {
    throw new Error(
      `Dispatch id "${existing.id}" already exists for job "${existing.job_id}" ` +
      `with kind "${existing.dispatch_kind}"`,
    );
  }
  for (const [column, expected] of [
    ['handoff_artifact_digest', binding.artifactDigest],
    ['source_run_id', binding.sourceRunId],
    ['source_run_handoff_artifact_digest', binding.sourceArtifactDigest],
  ]) {
    if (expected !== undefined && (existing[column] ?? null) !== (expected ?? null)) {
      throw new Error(`Dispatch id "${existing.id}" already exists with a different ${column}`);
    }
  }
  return existing;
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

  const jobBinding = db.prepare(`
    SELECT handoff_version, handoff_artifact_digest FROM jobs WHERE id = ?
  `).get(jobId);
  if (!jobBinding) throw new Error(`Job "${jobId}" not found`);
  const v4 = Number(jobBinding.handoff_version) === 4;
  const artifactDigest = v4 ? jobBinding.handoff_artifact_digest : null;
  if (v4 && !artifactDigest) {
    throw Object.assign(new Error('Handoff v4 dispatch requires a persisted artifact'), {
      code: 'HANDOFF_ARTIFACT_REQUIRED',
    });
  }
  const sourceRunId = opts.source_run_id || null;
  const sourceRun = sourceRunId
    ? db.prepare('SELECT id, handoff_artifact_digest FROM runs WHERE id = ?').get(sourceRunId)
    : null;
  if (v4 && sourceRunId && !sourceRun) {
    throw Object.assign(new Error(`Source run "${sourceRunId}" not found`), {
      code: 'DELEGATION_SOURCE_RUN_MISSING',
    });
  }
  const sourceArtifactDigest = v4 && sourceRun ? sourceRun.handoff_artifact_digest : null;
  if (v4 && sourceRun && !sourceArtifactDigest) {
    throw Object.assign(new Error(`Source run "${sourceRunId}" has no handoff artifact`), {
      code: 'DELEGATION_SOURCE_ARTIFACT_REQUIRED',
    });
  }
  if (v4 && opts.source_run_handoff_artifact_digest
    && opts.source_run_handoff_artifact_digest !== sourceArtifactDigest) {
    throw Object.assign(new Error('Requested source artifact does not match the exact source run'), {
      code: 'DELEGATION_SOURCE_ARTIFACT_MISMATCH',
    });
  }
  const binding = { artifactDigest, sourceRunId, sourceArtifactDigest };
  const existing = opts.id ? getDispatch(id) : null;
  if (existing) return verifyIdempotentDispatch(existing, jobId, kind, binding);
  const scheduledFor = opts.scheduled_for || sqliteNow(-1000);

  db.prepare(`
    INSERT INTO job_dispatch_queue (
      id, job_id, dispatch_kind, status, scheduled_for, binding_scheduled_for,
      source_run_id, retry_of_run_id, created_at, claimed_at, processed_at,
      claim_owner, claim_token, claim_expires_at, attempt_count, last_error,
      replay_of_run_id, handoff_artifact_digest,
      source_run_handoff_artifact_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    id,
    jobId,
    kind,
    status,
    scheduledFor,
    scheduledFor,
    opts.source_run_id || null,
    opts.retry_of_run_id || null,
    opts.claimed_at || null,
    opts.processed_at || null,
    opts.claim_owner || null,
    opts.claim_token || null,
    opts.claim_expires_at || null,
    opts.attempt_count ?? 0,
    opts.last_error || null,
    opts.replay_of_run_id || null,
    artifactDigest,
    sourceArtifactDigest,
  );

  const inserted = getDispatch(id);
  if (!inserted) throw new Error(`Failed to enqueue dispatch "${id}"`);
  return verifyIdempotentDispatch(inserted, jobId, kind, binding);
}

export function getDispatch(id) {
  return getDb().prepare('SELECT * FROM job_dispatch_queue WHERE id = ?').get(id) || null;
}

export function getDueDispatches(limit = 100) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  recoverStaleDispatchClaims();
  cancelDisabledDispatches();
  return getDb().prepare(`
    SELECT q.*, j.name as job_name
    FROM job_dispatch_queue q
    JOIN jobs j ON q.job_id = j.id
    WHERE q.status = 'pending'
      AND q.scheduled_for <= datetime('now')
      AND j.enabled = 1
    ORDER BY q.scheduled_for ASC, q.created_at ASC
    LIMIT ?
  `).all(limit);
}

export function claimDispatch(id, opts = {}) {
  const identity = normalizeClaimIdentity(opts, { generateToken: true });
  if (!identity) {
    const modifier = claimExpiryModifier(opts.leaseMs ?? 30_000);
    const result = getDb().prepare(`
      UPDATE job_dispatch_queue
      SET status = 'claimed',
          claimed_at = datetime('now'),
          claim_expires_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?),
          attempt_count = attempt_count + 1,
          last_error = NULL
      WHERE id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.enabled = 1)
    `).run(modifier, id);
    return result.changes > 0 ? getDispatch(id) : null;
  }

  const modifier = claimExpiryModifier(opts.leaseMs ?? 30_000);
  return getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = 'claimed',
        claimed_at = datetime('now'),
        claim_owner = ?,
        claim_token = ?,
        claim_expires_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?),
        attempt_count = attempt_count + 1,
        last_error = NULL
    WHERE id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND j.enabled = 1)
    RETURNING *
  `).get(identity.owner, identity.token, modifier, id) || null;
}

export function renewDispatchClaim(id, opts = {}) {
  const identity = normalizeClaimIdentity(opts);
  if (!identity) throw new Error('claim owner and token are required to renew a dispatch claim');
  const modifier = claimExpiryModifier(opts.leaseMs ?? 30_000);
  return getDb().prepare(`
    UPDATE job_dispatch_queue
    SET claim_expires_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?)
    WHERE id = ?
      AND status = 'claimed'
      AND claim_owner = ?
      AND claim_token = ?
      AND julianday(claim_expires_at) > julianday('now')
    RETURNING *
  `).get(modifier, id, identity.owner, identity.token) || null;
}

export function releaseDispatch(id, scheduledFor = null, opts = {}) {
  if (scheduledFor && typeof scheduledFor === 'object') {
    opts = scheduledFor;
    scheduledFor = opts.scheduledFor || null;
  }
  const identity = normalizeClaimIdentity(opts);
  const ownership = identity
    ? 'claim_owner = ? AND claim_token = ?'
    : 'claim_owner IS NULL AND claim_token IS NULL';
  const params = [scheduledFor, opts.lastError || null, id];
  if (identity) params.push(identity.owner, identity.token);

  const result = getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = 'pending',
        scheduled_for = COALESCE(?, scheduled_for),
        last_error = COALESCE(?, last_error),
        claimed_at = NULL,
        claim_owner = NULL,
        claim_token = NULL,
        claim_expires_at = NULL
    WHERE id = ?
      AND status IN ('claimed', 'awaiting_approval')
      AND ${ownership}
  `).run(...params);
  return result.changes > 0 ? getDispatch(id) : null;
}

export function setDispatchStatus(id, status, opts = {}) {
  assertStatus(status);
  const processedAt = ['done', 'cancelled', 'failed'].includes(status) ? sqliteNow() : null;
  const identity = normalizeClaimIdentity(opts);
  const ownership = identity
    ? 'claim_owner = ? AND claim_token = ?'
    : '(claim_owner IS NULL AND claim_token IS NULL)';
  const result = getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = ?,
        processed_at = COALESCE(?, processed_at),
        last_error = COALESCE(?, last_error),
        claimed_at = CASE WHEN ? IN ('pending', 'awaiting_approval') THEN NULL ELSE claimed_at END,
        claim_owner = CASE WHEN ? IN ('pending', 'awaiting_approval') THEN NULL ELSE claim_owner END,
        claim_token = CASE WHEN ? IN ('pending', 'awaiting_approval') THEN NULL ELSE claim_token END,
        claim_expires_at = CASE
          WHEN ? IN ('pending', 'awaiting_approval', 'done', 'cancelled', 'failed') THEN NULL
          ELSE claim_expires_at
        END
    WHERE id = ?
      AND status NOT IN ('done', 'cancelled', 'failed')
      AND ${ownership}
  `).run(status, processedAt, opts.lastError || null, status, status, status, status, id,
    ...(identity ? [identity.owner, identity.token] : []));
  return result.changes > 0 ? getDispatch(id) : null;
}

export function recoverStaleDispatchClaims(opts = {}) {
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim()
    : 'Recovered expired dispatch claim';
  const result = getDb().prepare(`
    UPDATE job_dispatch_queue AS q
    SET status = 'pending',
        claimed_at = NULL,
        claim_owner = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        last_error = COALESCE(last_error, ?)
    WHERE q.status = 'claimed'
      AND q.claim_expires_at IS NOT NULL
      AND julianday(q.claim_expires_at) <= julianday('now')
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.dispatch_queue_id = q.id
          AND r.status IN ('pending', 'running', 'awaiting_approval', 'approved')
      )
  `).run(reason);
  return result.changes;
}

export function cancelDisabledDispatches() {
  const result = getDb().prepare(`
    UPDATE job_dispatch_queue
    SET status = 'cancelled',
        processed_at = COALESCE(processed_at, datetime('now')),
        claim_expires_at = NULL,
        last_error = COALESCE(last_error, 'Job disabled before dispatch')
    WHERE status = 'pending'
      AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.id = job_dispatch_queue.job_id AND j.enabled = 0
      )
  `).run();
  return result.changes;
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
