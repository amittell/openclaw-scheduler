import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import {
  cleanupDeliveryAttachmentMaterial,
  cleanupStagedAttachments,
  insertStagedAttachments,
  listDeliveryAttachments,
  persistStagedAttachments,
  stageDeliveryAttachments,
} from './attachment-store.js';

export const DEFAULT_DELIVERY_RETENTION_DAYS = 30;
export const DEFAULT_DELIVERY_PRUNE_LIMIT = 500;

export const DELIVERY_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATUSES = new Set([
  DELIVERY_STATUSES.DELIVERED,
  DELIVERY_STATUSES.CANCELLED,
]);

function sqliteTimestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function requiredString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`${name} is required`);
  return allowEmpty ? value : normalized;
}

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, name) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function getDeliveryRow(db, id) {
  return db.prepare(`
    SELECT o.*, j.name AS job_name
    FROM delivery_outbox o
    LEFT JOIN jobs j ON j.id = o.job_id
    WHERE o.id = ?
  `).get(id) || null;
}

function decorateDelivery(db, row, opts = {}) {
  if (!row) return null;
  return {
    ...row,
    attachments: listDeliveryAttachments(row.id, {
      db,
      includeContent: opts.includeAttachmentContent === true,
    }),
  };
}

function immediate(db, fn) {
  const transaction = db.transaction(fn);
  return db.inTransaction ? transaction() : transaction.immediate();
}

function clearClaimSql() {
  return `claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL`;
}

function recoverExpiredClaimsInTransaction(db, now) {
  const expired = db.prepare(`
    SELECT id, attempt_count, max_attempts
    FROM delivery_outbox
    WHERE status = 'claimed'
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at <= ?
  `).all(now);
  const retry = db.prepare(`
    UPDATE delivery_outbox
    SET status = 'pending',
        next_attempt_at = ?,
        ${clearClaimSql()},
        last_error = COALESCE(last_error, 'Delivery claim lease expired')
    WHERE id = ? AND status = 'claimed' AND claim_expires_at <= ?
  `);
  const fail = db.prepare(`
    UPDATE delivery_outbox
    SET status = 'failed',
        next_attempt_at = ?,
        ${clearClaimSql()},
        last_error = COALESCE(last_error, 'Delivery claim lease expired after final attempt')
    WHERE id = ? AND status = 'claimed' AND claim_expires_at <= ?
  `);

  let pending = 0;
  let failed = 0;
  for (const row of expired) {
    if (row.attempt_count >= row.max_attempts) {
      failed += fail.run(now, row.id, now).changes;
    } else {
      pending += retry.run(now, row.id, now).changes;
    }
  }
  return { recovered: pending + failed, pending, failed };
}

function attachmentIdentity(attachment) {
  return {
    ordinal: Number(attachment.ordinal),
    name: attachment.name,
    mime_type: attachment.mime_type || null,
    size_bytes: Number(attachment.size_bytes),
    sha256: attachment.sha256,
  };
}

function assertEquivalentIdempotentDelivery(existing, requested, existingAttachments, requestedAttachments) {
  const differingFields = [];
  for (const field of ['channel', 'target', 'body', 'message_id', 'job_id', 'run_id']) {
    if ((existing[field] ?? null) !== (requested[field] ?? null)) differingFields.push(field);
  }
  const existingIdentity = existingAttachments.map(attachmentIdentity);
  const requestedIdentity = requestedAttachments.map(attachmentIdentity);
  if (JSON.stringify(existingIdentity) !== JSON.stringify(requestedIdentity)) {
    differingFields.push('attachments');
  }
  if (differingFields.length === 0) return;

  const err = new Error(
    `delivery idempotency collision for '${requested.idempotency_key}': `
    + `request differs in ${differingFields.join(', ')}`
  );
  err.code = 'DELIVERY_IDEMPOTENCY_COLLISION';
  err.idempotencyKey = requested.idempotency_key;
  err.existingDeliveryId = existing.id;
  err.differingFields = differingFields;
  throw err;
}

export function enqueueDelivery(opts = {}) {
  const db = opts.db || getDb();
  const id = opts.id || randomUUID();
  const channel = requiredString(opts.channel, 'channel');
  const target = requiredString(opts.target ?? opts.delivery_to, 'target');
  const body = requiredString(opts.body, 'body', { allowEmpty: true });
  const attachments = opts.attachments || [];
  if (!body.trim() && (!Array.isArray(attachments) || attachments.length === 0)) {
    throw new Error('body or at least one attachment is required');
  }
  const maxAttempts = positiveInteger(opts.maxAttempts ?? opts.max_attempts, 5, 'maxAttempts');
  const idempotencyKey = opts.idempotencyKey ?? opts.idempotency_key ?? null;
  if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim())) {
    throw new Error('idempotencyKey must be a non-empty string when provided');
  }
  const normalizedKey = idempotencyKey?.trim() || null;
  const nextAttemptAt = sqliteTimestamp(opts.nextAttemptAt ?? opts.next_attempt_at ?? Date.now());
  const messageId = opts.messageId ?? opts.message_id ?? null;
  const jobId = opts.jobId ?? opts.job_id ?? null;
  const runId = opts.runId ?? opts.run_id ?? null;
  const requested = {
    channel,
    target,
    body,
    message_id: messageId,
    job_id: jobId,
    run_id: runId,
    idempotency_key: normalizedKey,
  };
  const outerTransaction = db.inTransaction;
  const staged = stageDeliveryAttachments(id, attachments, {
    artifactsDir: opts.artifactsDir,
    dbPath: opts.dbPath || db.name,
    maxBytes: opts.maxAttachmentBytes,
    maxCount: opts.maxAttachmentCount,
    maxTotalBytes: opts.maxTotalAttachmentBytes,
    persistFiles: false,
  });
  let artifactsPersisted = false;

  try {
    const outcome = immediate(db, () => {
      const info = db.prepare(`
        INSERT INTO delivery_outbox (
          id, message_id, job_id, run_id, channel, target, body,
          status, idempotency_key, max_attempts, next_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      `).run(
        id,
        messageId,
        jobId,
        runId,
        channel,
        target,
        body,
        normalizedKey,
        maxAttempts,
        nextAttemptAt
      );

      if (info.changes === 0) {
        const existing = db.prepare(
          'SELECT * FROM delivery_outbox WHERE idempotency_key = ?'
        ).get(normalizedKey);
        if (!existing) {
          throw new Error(`delivery idempotency conflict for '${normalizedKey}' without an existing row`);
        }
        assertEquivalentIdempotentDelivery(
          existing,
          requested,
          listDeliveryAttachments(existing.id, { db }),
          staged
        );
        return { id: existing.id, deduped: true };
      }

      if (!outerTransaction && staged.length > 0) {
        persistStagedAttachments(staged, {
          artifactsDir: opts.artifactsDir,
          dbPath: opts.dbPath || db.name,
        });
        artifactsPersisted = true;
      }
      insertStagedAttachments(
        db,
        id,
        messageId,
        staged
      );
      return { id, deduped: false };
    });
    return {
      ...decorateDelivery(db, getDeliveryRow(db, outcome.id), { includeAttachmentContent: true }),
      deduped: outcome.deduped,
    };
  } catch (err) {
    if (artifactsPersisted) {
      cleanupStagedAttachments(staged, {
        artifactsDir: opts.artifactsDir,
        dbPath: opts.dbPath || db.name,
      });
    }
    throw err;
  }
}

export function getDelivery(id, opts = {}) {
  const db = opts.db || getDb();
  return decorateDelivery(db, getDeliveryRow(db, id), opts);
}

export function getDeliveryByIdempotencyKey(idempotencyKey, opts = {}) {
  const db = opts.db || getDb();
  const row = db.prepare(`
    SELECT o.*, j.name AS job_name
    FROM delivery_outbox o
    LEFT JOIN jobs j ON j.id = o.job_id
    WHERE o.idempotency_key = ?
  `).get(idempotencyKey);
  return decorateDelivery(db, row || null, opts);
}

export function listDeliveries(opts = {}) {
  const db = opts.db || getDb();
  const limit = positiveInteger(opts.limit, 100, 'limit');
  const statuses = opts.status == null
    ? null
    : Array.isArray(opts.status) ? opts.status : [opts.status];
  if (statuses?.some(status => !Object.values(DELIVERY_STATUSES).includes(status))) {
    throw new Error('invalid delivery status filter');
  }
  const where = [];
  const params = [];
  if (statuses?.length) {
    where.push(`o.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (opts.jobId) {
    where.push('o.job_id = ?');
    params.push(opts.jobId);
  }
  if (opts.runId) {
    where.push('o.run_id = ?');
    params.push(opts.runId);
  }
  const rows = db.prepare(`
    SELECT o.*, j.name AS job_name
    FROM delivery_outbox o
    LEFT JOIN jobs j ON j.id = o.job_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(row => decorateDelivery(db, row, opts));
}

function claimCandidates(db, ids, owner, now, leaseExpiresAt) {
  const claimed = [];
  const update = db.prepare(`
    UPDATE delivery_outbox
    SET status = 'claimed',
        attempt_count = attempt_count + 1,
        claim_owner = ?,
        claim_token = ?,
        claim_expires_at = ?
    WHERE id = ?
      AND status = 'pending'
      AND next_attempt_at <= ?
      AND attempt_count < max_attempts
  `);
  for (const id of ids) {
    const token = randomUUID();
    const info = update.run(owner, token, leaseExpiresAt, id, now);
    if (info.changes === 1) {
      claimed.push(decorateDelivery(db, getDeliveryRow(db, id)));
    }
  }
  return claimed;
}

export function claimDueDeliveries(opts = {}) {
  const db = opts.db || getDb();
  const owner = requiredString(opts.owner, 'owner');
  const limit = positiveInteger(opts.limit, 50, 'limit');
  const leaseMs = positiveInteger(opts.leaseMs, 120_000, 'leaseMs');
  const nowValue = opts.now ?? Date.now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
  if (Number.isNaN(nowMs)) throw new Error('invalid claim time');
  const now = sqliteTimestamp(nowMs);
  const leaseExpiresAt = sqliteTimestamp(nowMs + leaseMs);

  return immediate(db, () => {
    recoverExpiredClaimsInTransaction(db, now);
    db.prepare(`
      UPDATE delivery_outbox
      SET status = 'failed',
          next_attempt_at = ?,
          last_error = COALESCE(last_error, 'Delivery attempt limit exhausted')
      WHERE status = 'pending' AND attempt_count >= max_attempts
    `).run(now);

    const where = ["o.status = 'pending'", 'o.next_attempt_at <= ?', 'o.attempt_count < o.max_attempts'];
    const params = [now];
    if (opts.channel) {
      where.push('o.channel = ?');
      params.push(opts.channel);
    }
    if (opts.target) {
      where.push('o.target = ?');
      params.push(opts.target);
    }
    const candidates = db.prepare(`
      SELECT o.id
      FROM delivery_outbox o
      WHERE ${where.join(' AND ')}
      ORDER BY o.next_attempt_at ASC, o.created_at ASC, o.id ASC
      LIMIT ?
    `).all(...params, limit);
    return claimCandidates(db, candidates.map(row => row.id), owner, now, leaseExpiresAt);
  });
}

export function claimDelivery(id, opts = {}) {
  const db = opts.db || getDb();
  const owner = requiredString(opts.owner, 'owner');
  const leaseMs = positiveInteger(opts.leaseMs, 120_000, 'leaseMs');
  const nowValue = opts.now ?? Date.now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
  if (Number.isNaN(nowMs)) throw new Error('invalid claim time');
  const now = sqliteTimestamp(nowMs);
  const leaseExpiresAt = sqliteTimestamp(nowMs + leaseMs);
  return immediate(db, () => {
    recoverExpiredClaimsInTransaction(db, now);
    return claimCandidates(db, [id], owner, now, leaseExpiresAt)[0] || null;
  });
}

export function renewDeliveryClaim(id, claimToken, opts = {}) {
  const db = opts.db || getDb();
  const leaseMs = positiveInteger(opts.leaseMs, 120_000, 'leaseMs');
  const nowValue = opts.now ?? Date.now();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : new Date(nowValue).getTime();
  if (Number.isNaN(nowMs)) throw new Error('invalid renewal time');
  const now = sqliteTimestamp(nowMs);
  const claimExpiresAt = sqliteTimestamp(nowMs + leaseMs);
  const info = db.prepare(`
    UPDATE delivery_outbox
    SET claim_expires_at = ?
    WHERE id = ?
      AND status = 'claimed'
      AND claim_token = ?
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at > ?
  `).run(claimExpiresAt, id, claimToken, now);
  const row = getDeliveryRow(db, id);
  return row
    ? { ...decorateDelivery(db, row), renewed: info.changes === 1 }
    : null;
}

function claimMatches(row, claimToken) {
  return row?.status === DELIVERY_STATUSES.CLAIMED
    && typeof claimToken === 'string'
    && claimToken.length > 0
    && row.claim_token === claimToken;
}

export function markDeliveryDelivered(id, claimToken, opts = {}) {
  const db = opts.db || getDb();
  return immediate(db, () => {
    const before = getDeliveryRow(db, id);
    if (!before) return null;
    if (before.status === DELIVERY_STATUSES.DELIVERED) {
      return { ...decorateDelivery(db, before), transitioned: false };
    }
    if (!claimMatches(before, claimToken)) {
      return { ...decorateDelivery(db, before), transitioned: false, reason: 'claim_mismatch' };
    }
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'delivered',
          delivered_at = datetime('now'),
          ${clearClaimSql()},
          last_error = NULL
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(id, claimToken);
    return {
      ...decorateDelivery(db, getDeliveryRow(db, id)),
      transitioned: info.changes === 1,
    };
  });
}

export function retryDelivery(id, claimToken, error, opts = {}) {
  const db = opts.db || getDb();
  const errorText = String(error?.message || error || 'Delivery failed').slice(0, 4000);
  return immediate(db, () => {
    const before = getDeliveryRow(db, id);
    if (!before) return null;
    if (!claimMatches(before, claimToken)) {
      return { ...decorateDelivery(db, before), transitioned: false, reason: 'claim_mismatch' };
    }
    const exhausted = before.attempt_count >= before.max_attempts;
    const defaultDelayMs = Math.min(300_000, 1000 * (2 ** Math.max(0, before.attempt_count - 1)));
    const delayMs = nonNegativeInteger(opts.delayMs, defaultDelayMs, 'delayMs');
    const terminalAt = sqliteTimestamp(Date.now());
    const nextAttemptAt = sqliteTimestamp(Date.now() + delayMs);
    const nextStatus = exhausted ? DELIVERY_STATUSES.FAILED : DELIVERY_STATUSES.PENDING;
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = ?,
          next_attempt_at = CASE WHEN ? = 'pending' THEN ? ELSE ? END,
          ${clearClaimSql()},
          last_error = ?
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(nextStatus, nextStatus, nextAttemptAt, terminalAt, errorText, id, claimToken);
    return {
      ...decorateDelivery(db, getDeliveryRow(db, id)),
      transitioned: info.changes === 1,
      retryScheduled: info.changes === 1 && !exhausted,
    };
  });
}

export function markDeliveryFailed(id, claimToken, error, opts = {}) {
  const db = opts.db || getDb();
  const errorText = String(error?.message || error || 'Delivery failed').slice(0, 4000);
  return immediate(db, () => {
    const before = getDeliveryRow(db, id);
    if (!before) return null;
    if (before.status === DELIVERY_STATUSES.FAILED) {
      return { ...decorateDelivery(db, before), transitioned: false };
    }
    if (!claimMatches(before, claimToken)) {
      return { ...decorateDelivery(db, before), transitioned: false, reason: 'claim_mismatch' };
    }
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'failed',
          next_attempt_at = datetime('now'),
          ${clearClaimSql()},
          last_error = ?
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(errorText, id, claimToken);
    return {
      ...decorateDelivery(db, getDeliveryRow(db, id)),
      transitioned: info.changes === 1,
    };
  });
}

export function cancelDelivery(id, reason = 'Delivery cancelled', opts = {}) {
  const db = opts.db || getDb();
  const reasonText = String(reason || 'Delivery cancelled').slice(0, 4000);
  return immediate(db, () => {
    const before = getDeliveryRow(db, id);
    if (!before) return null;
    if (before.status === DELIVERY_STATUSES.CANCELLED) {
      return { ...decorateDelivery(db, before), transitioned: false };
    }
    if (TERMINAL_STATUSES.has(before.status)) {
      return { ...decorateDelivery(db, before), transitioned: false, reason: 'terminal' };
    }
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'cancelled',
          next_attempt_at = datetime('now'),
          ${clearClaimSql()},
          last_error = ?
      WHERE id = ? AND status IN ('pending', 'claimed', 'failed')
    `).run(reasonText, id);
    return {
      ...decorateDelivery(db, getDeliveryRow(db, id)),
      transitioned: info.changes === 1,
    };
  });
}

export function cancelDeliveriesForRun(runId, reason = 'Run cancelled', opts = {}) {
  const db = opts.db || getDb();
  const reasonText = String(reason || 'Run cancelled').slice(0, 4000);
  const info = db.prepare(`
    UPDATE delivery_outbox
    SET status = 'cancelled',
        next_attempt_at = datetime('now'),
        ${clearClaimSql()},
        last_error = ?
    WHERE run_id = ? AND status IN ('pending', 'claimed', 'failed')
  `).run(reasonText, runId);
  return info.changes;
}

export function cancelDeliveriesForJob(jobId, reason = 'Job cancelled', opts = {}) {
  const db = opts.db || getDb();
  const reasonText = String(reason || 'Job cancelled').slice(0, 4000);
  const info = db.prepare(`
    UPDATE delivery_outbox
    SET status = 'cancelled',
        next_attempt_at = datetime('now'),
        ${clearClaimSql()},
        last_error = ?
    WHERE job_id = ? AND status IN ('pending', 'claimed', 'failed')
  `).run(reasonText, jobId);
  return info.changes;
}

export function retryFailedDelivery(id, opts = {}) {
  const db = opts.db || getDb();
  const maxAttempts = positiveInteger(opts.maxAttempts, 5, 'maxAttempts');
  const resetAttempts = opts.resetAttempts !== false;
  const nextAttemptAt = sqliteTimestamp(opts.nextAttemptAt ?? Date.now());
  return immediate(db, () => {
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'pending',
          attempt_count = CASE WHEN ? THEN 0 ELSE attempt_count END,
          max_attempts = CASE WHEN ? THEN ? ELSE MAX(?, attempt_count + 1) END,
          next_attempt_at = ?,
          ${clearClaimSql()},
          last_error = NULL
      WHERE id = ? AND status = 'failed'
    `).run(
      resetAttempts ? 1 : 0,
      resetAttempts ? 1 : 0,
      maxAttempts,
      maxAttempts,
      nextAttemptAt,
      id
    );
    const row = getDeliveryRow(db, id);
    return row ? { ...decorateDelivery(db, row), transitioned: info.changes === 1 } : null;
  });
}

export function recoverExpiredDeliveryClaims(opts = {}) {
  const db = opts.db || getDb();
  const now = sqliteTimestamp(opts.now ?? Date.now());
  return immediate(db, () => recoverExpiredClaimsInTransaction(db, now));
}

export function pruneTerminalDeliveries(opts = {}) {
  const db = opts.db || getDb();
  const retentionDays = positiveInteger(
    opts.retentionDays ?? opts.retention_days ?? process.env.SCHEDULER_DELIVERY_RETENTION_DAYS,
    DEFAULT_DELIVERY_RETENTION_DAYS,
    'retentionDays'
  );
  const limit = positiveInteger(
    opts.limit ?? process.env.SCHEDULER_DELIVERY_PRUNE_LIMIT,
    DEFAULT_DELIVERY_PRUNE_LIMIT,
    'limit'
  );
  const cutoff = opts.before == null
    ? sqliteTimestamp(Date.now() - (retentionDays * 24 * 60 * 60 * 1000))
    : sqliteTimestamp(opts.before);

  return immediate(db, () => {
    const rows = db.prepare(`
      SELECT id, status
      FROM delivery_outbox
      WHERE status IN ('delivered', 'failed', 'cancelled')
        AND CASE
          WHEN status = 'delivered' THEN COALESCE(delivered_at, created_at)
          ELSE MAX(created_at, next_attempt_at)
        END <= ?
      ORDER BY
        CASE
          WHEN status = 'delivered' THEN COALESCE(delivered_at, created_at)
          ELSE MAX(created_at, next_attempt_at)
        END ASC,
        id ASC
      LIMIT ?
    `).all(cutoff, limit);
    if (rows.length === 0) {
      return {
        pruned: 0,
        attachmentRowsPruned: 0,
        attachmentBytesPruned: 0,
        filesRemoved: 0,
        directoriesRemoved: 0,
        skippedUnsafePaths: 0,
        cutoff,
        limit,
      };
    }

    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    const attachmentRows = db.prepare(`
      SELECT id, outbox_id, source_path, size_bytes
      FROM delivery_attachments
      WHERE outbox_id IN (${placeholders})
    `).all(...ids);
    const artifactCleanup = cleanupDeliveryAttachmentMaterial(ids, attachmentRows, {
      artifactsDir: opts.artifactsDir,
      dbPath: opts.dbPath || db.name,
    });
    const deleted = db.prepare(`
      DELETE FROM delivery_outbox
      WHERE id IN (${placeholders})
        AND status IN ('delivered', 'failed', 'cancelled')
    `).run(...ids);
    if (deleted.changes !== ids.length) {
      throw new Error(`delivery prune deleted ${deleted.changes} of ${ids.length} selected rows`);
    }
    const remainingAttachments = db.prepare(`
      SELECT COUNT(*) AS count
      FROM delivery_attachments
      WHERE outbox_id IN (${placeholders})
    `).get(...ids).count;
    if (remainingAttachments !== 0) {
      throw new Error(`delivery prune left ${remainingAttachments} attachment row(s)`);
    }
    return {
      pruned: deleted.changes,
      attachmentRowsPruned: attachmentRows.length,
      attachmentBytesPruned: attachmentRows.reduce(
        (total, attachment) => total + Number(attachment.size_bytes || 0),
        0
      ),
      ...artifactCleanup,
      cutoff,
      limit,
    };
  });
}
