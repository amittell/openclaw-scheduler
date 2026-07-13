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
// The inbox consumer prepends a bounded brand/subject/age header. Keeping the
// durable body below this limit ensures one outbox part maps to one Telegram
// send instead of being split again inside the Gateway client.
export const DEFAULT_TELEGRAM_DELIVERY_PART_BYTES = 3600;

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

function utf8Length(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function utf8PrefixIndex(value, maxBytes) {
  let bytes = 0;
  let index = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    index += character.length;
  }
  return index;
}

function resolvePartBytes(channel, requestedBytes) {
  if (requestedBytes != null) {
    return positiveInteger(requestedBytes, null, 'maxPartBytes');
  }
  return String(channel || '').toLowerCase() === 'telegram'
    ? DEFAULT_TELEGRAM_DELIVERY_PART_BYTES
    : null;
}

/**
 * Deterministically split a delivery body into independently retryable parts.
 * The prefix budget is reserved before splitting so every returned part stays
 * within maxPartBytes even for multi-byte text and large part counts.
 */
export function splitDeliveryBody(body, opts = {}) {
  const text = String(body ?? '');
  const maxPartBytes = resolvePartBytes(opts.channel, opts.maxPartBytes);
  if (!maxPartBytes || utf8Length(text) <= maxPartBytes) return [text];
  if (maxPartBytes < 256) throw new Error('maxPartBytes must be at least 256');

  const prefixReserve = 32;
  const contentLimit = maxPartBytes - prefixReserve;
  const rawParts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (utf8Length(remaining) <= contentLimit) {
      rawParts.push(remaining);
      break;
    }

    const hardIndex = utf8PrefixIndex(remaining, contentLimit);
    if (hardIndex <= 0) throw new Error('maxPartBytes cannot hold the next UTF-8 character');
    const minimumSoftBreak = Math.floor(hardIndex * 0.5);
    let splitAt = remaining.lastIndexOf('\n', hardIndex);
    if (splitAt < minimumSoftBreak) splitAt = remaining.lastIndexOf(' ', hardIndex);
    if (splitAt < minimumSoftBreak) splitAt = hardIndex;

    const part = remaining.slice(0, splitAt).trimEnd();
    if (!part) {
      rawParts.push(remaining.slice(0, hardIndex));
      remaining = remaining.slice(hardIndex);
    } else {
      rawParts.push(part);
      remaining = remaining.slice(splitAt).trimStart();
    }
  }

  return rawParts.map((part, index) => {
    const prefixed = `[${index + 1}/${rawParts.length}] ${part}`;
    if (utf8Length(prefixed) > maxPartBytes) {
      throw new Error(`delivery part ${index + 1} exceeds maxPartBytes after prefixing`);
    }
    return prefixed;
  });
}

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

function markCompletionDebt(db, delivery, status, reason) {
  if (!delivery?.completion_label || !delivery?.completion_scope) return;
  const terminal = status === 'closed';
  db.prepare(`
    UPDATE completion_debts
    SET status = ?,
        open_reason = CASE WHEN ? = 'open' THEN ? ELSE open_reason END,
        close_reason = CASE WHEN ? = 'closed' THEN ? ELSE NULL END,
        opened_at = CASE WHEN ? = 'open' THEN COALESCE(opened_at, datetime('now')) ELSE opened_at END,
        closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE NULL END,
        final_reported_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE final_reported_at END,
        last_visible_update_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE last_visible_update_at END,
        updated_at = datetime('now')
    WHERE task_label = ? AND delivery_scope = ?
  `).run(
    status,
    status, reason,
    status, reason,
    status,
    status,
    status,
    status,
    delivery.completion_label,
    delivery.completion_scope,
  );
  if (terminal) return;
}

function reconcileCompletionDebt(db, delivery) {
  if (!delivery?.completion_label || !delivery?.completion_scope) return;
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status IN ('failed', 'cancelled') THEN 1 ELSE 0 END) AS failed
    FROM delivery_outbox
    WHERE completion_label = ? AND completion_scope = ?
  `).get(delivery.completion_label, delivery.completion_scope);
  if (counts.total > 0 && counts.delivered === counts.total) {
    markCompletionDebt(db, delivery, 'closed', 'confirmed-completion-delivered');
  } else if (counts.failed > 0) {
    markCompletionDebt(db, delivery, 'open', 'completion-delivery-failed');
  } else {
    markCompletionDebt(db, delivery, 'delivering', 'completion-enqueued-durably');
  }
}

function cancelLaterGroupParts(db, delivery, reason) {
  if (!delivery?.delivery_group_id || !Number.isInteger(delivery.part_index)) return 0;
  return db.prepare(`
    UPDATE delivery_outbox
    SET status = 'cancelled', next_attempt_at = datetime('now'),
        ${clearClaimSql()}, last_error = ?
    WHERE delivery_group_id = ?
      AND part_index > ?
      AND status IN ('pending', 'failed')
  `).run(reason, delivery.delivery_group_id, delivery.part_index).changes;
}

function recoverExpiredClaimsInTransaction(db, now) {
  const expired = db.prepare(`
    SELECT *
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
      const changed = fail.run(now, row.id, now).changes;
      failed += changed;
      if (changed) {
        const updated = getDeliveryRow(db, row.id);
        cancelLaterGroupParts(db, updated, 'Multipart delivery stopped after an expired final claim');
        reconcileCompletionDebt(db, updated);
      }
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
  const legacySinglePartUpgrade = existing.delivery_group_id == null
    && existing.part_index == null
    && existing.part_count == null
    && requested.delivery_group_id === requested.idempotency_key
    && requested.part_index === 1
    && requested.part_count === 1;
  for (const field of [
    'channel', 'target', 'body', 'message_id', 'job_id', 'run_id',
    'delivery_group_id', 'part_index', 'part_count',
    'completion_label', 'completion_scope',
  ]) {
    if (legacySinglePartUpgrade && ['delivery_group_id', 'part_index', 'part_count'].includes(field)) {
      continue;
    }
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
  const deliveryGroupIdValue = opts.deliveryGroupId ?? opts.delivery_group_id ?? null;
  const deliveryGroupId = deliveryGroupIdValue == null
    ? null
    : requiredString(deliveryGroupIdValue, 'deliveryGroupId');
  const partIndexValue = opts.partIndex ?? opts.part_index ?? null;
  const partCountValue = opts.partCount ?? opts.part_count ?? null;
  if ((partIndexValue == null) !== (partCountValue == null)) {
    throw new Error('partIndex and partCount must be provided together');
  }
  const partIndex = partIndexValue == null ? null : positiveInteger(partIndexValue, null, 'partIndex');
  const partCount = partCountValue == null ? null : positiveInteger(partCountValue, null, 'partCount');
  if (partIndex != null && partIndex > partCount) throw new Error('partIndex cannot exceed partCount');
  if (deliveryGroupId == null && partIndex != null) {
    throw new Error('deliveryGroupId is required for multipart metadata');
  }
  const completionLabelValue = opts.completionLabel ?? opts.completion_label ?? null;
  const completionScopeValue = opts.completionScope ?? opts.completion_scope ?? null;
  if ((completionLabelValue == null) !== (completionScopeValue == null)) {
    throw new Error('completionLabel and completionScope must be provided together');
  }
  const completionLabel = completionLabelValue == null
    ? null
    : requiredString(completionLabelValue, 'completionLabel');
  const completionScope = completionScopeValue == null
    ? null
    : requiredString(completionScopeValue, 'completionScope');
  const requested = {
    channel,
    target,
    body,
    message_id: messageId,
    job_id: jobId,
    run_id: runId,
    idempotency_key: normalizedKey,
    delivery_group_id: deliveryGroupId,
    part_index: partIndex,
    part_count: partCount,
    completion_label: completionLabel,
    completion_scope: completionScope,
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
          status, idempotency_key, delivery_group_id, part_index, part_count,
          completion_label, completion_scope, max_attempts, next_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
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
        deliveryGroupId,
        partIndex,
        partCount,
        completionLabel,
        completionScope,
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

/**
 * Enqueue a logical delivery as one or more independently claimed outbox rows.
 * A deterministic per-part idempotency key is the durable checkpoint: retries
 * claim only parts that have not already reached a terminal delivered state.
 */
export function enqueueMultipartDelivery(opts = {}) {
  const db = opts.db || getDb();
  const channel = requiredString(opts.channel, 'channel');
  const body = requiredString(opts.body, 'body', { allowEmpty: true });
  const parts = splitDeliveryBody(body, {
    channel,
    maxPartBytes: opts.maxPartBytes ?? opts.max_part_bytes,
  });

  const suppliedKey = opts.idempotencyKey ?? opts.idempotency_key ?? null;
  if (suppliedKey != null && (typeof suppliedKey !== 'string' || !suppliedKey.trim())) {
    throw new Error('idempotencyKey must be a non-empty string when provided');
  }
  const baseKey = suppliedKey?.trim() || null;
  const groupId = opts.deliveryGroupId ?? opts.delivery_group_id ?? baseKey ?? randomUUID();

  if (parts.length === 1) {
    const delivery = enqueueDelivery({
      ...opts,
      db,
      channel,
      body: parts[0],
      deliveryGroupId: groupId,
      partIndex: 1,
      partCount: 1,
    });
    return {
      ...delivery,
      partCount: 1,
      deliveries: [delivery],
      checkpointKey: delivery.idempotency_key || null,
    };
  }

  const attachments = opts.attachments || [];
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  if (attachments.length > 0) {
    throw new Error('multipart delivery attachments must be enqueued as a separate logical delivery');
  }

  const deliveries = immediate(db, () => parts.map((part, index) => enqueueDelivery({
    ...opts,
    db,
    id: opts.id ? `${opts.id}:part:${index + 1}` : undefined,
    channel,
    body: part,
    attachments: [],
    deliveryGroupId: groupId,
    partIndex: index + 1,
    partCount: parts.length,
    idempotencyKey: baseKey ? `${baseKey}:part:${index + 1}/${parts.length}` : null,
  })));

  return {
    ...deliveries[0],
    deduped: deliveries.every(delivery => delivery.deduped === true),
    partCount: deliveries.length,
    deliveries,
    checkpointKey: baseKey,
  };
}

export function getDelivery(id, opts = {}) {
  const db = opts.db || getDb();
  return decorateDelivery(db, getDeliveryRow(db, id), opts);
}

/**
 * Return durable per-part progress for a logical idempotency key. This uses the
 * existing outbox schema, where each part is a normal independently leased row.
 */
export function getDeliveryCheckpoint(idempotencyKey, opts = {}) {
  const db = opts.db || getDb();
  const baseKey = requiredString(idempotencyKey, 'idempotencyKey');
  const partPrefix = `${baseKey}:part:`;
  const rows = db.prepare(`
    SELECT o.*, j.name AS job_name
    FROM delivery_outbox o
    LEFT JOIN jobs j ON j.id = o.job_id
    WHERE o.idempotency_key = ?
       OR instr(o.idempotency_key, ?) = 1
    ORDER BY o.created_at ASC, o.id ASC
  `).all(baseKey, partPrefix)
    .sort((left, right) => {
      const leftPart = Number.parseInt(left.idempotency_key?.slice(partPrefix.length).split('/')[0] || '0', 10);
      const rightPart = Number.parseInt(right.idempotency_key?.slice(partPrefix.length).split('/')[0] || '0', 10);
      return leftPart - rightPart;
    })
    .map(row => decorateDelivery(db, row, opts));
  const statusCounts = Object.fromEntries(
    Object.values(DELIVERY_STATUSES).map(status => [status, 0])
  );
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  return {
    idempotencyKey: baseKey,
    partCount: rows.length,
    complete: rows.length > 0 && rows.every(row => row.status === DELIVERY_STATUSES.DELIVERED),
    statusCounts,
    deliveries: rows,
  };
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
    const exhaustedPending = db.prepare(`
      SELECT * FROM delivery_outbox
      WHERE status = 'pending' AND attempt_count >= max_attempts
    `).all();
    db.prepare(`
      UPDATE delivery_outbox
      SET status = 'failed',
          next_attempt_at = ?,
          last_error = COALESCE(last_error, 'Delivery attempt limit exhausted')
      WHERE status = 'pending' AND attempt_count >= max_attempts
    `).run(now);
    for (const exhausted of exhaustedPending) {
      const updated = getDeliveryRow(db, exhausted.id);
      cancelLaterGroupParts(db, updated, 'Multipart delivery stopped after its attempt limit was exhausted');
      reconcileCompletionDebt(db, updated);
    }

    const where = [
      "o.status = 'pending'",
      'o.next_attempt_at <= ?',
      'o.attempt_count < o.max_attempts',
      `(o.delivery_group_id IS NULL OR o.part_index IS NULL OR o.part_index <= 1 OR NOT EXISTS (
        SELECT 1 FROM delivery_outbox predecessor
        WHERE predecessor.delivery_group_id = o.delivery_group_id
          AND predecessor.part_index < o.part_index
          AND predecessor.status != 'delivered'
      ))`,
    ];
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
      ORDER BY o.next_attempt_at ASC, o.created_at ASC,
               COALESCE(o.delivery_group_id, o.id) ASC,
               COALESCE(o.part_index, 1) ASC, o.id ASC
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
    const candidate = db.prepare(`
      SELECT o.id
      FROM delivery_outbox o
      WHERE o.id = ?
        AND (
          o.delivery_group_id IS NULL
          OR o.part_index IS NULL
          OR o.part_index <= 1
          OR NOT EXISTS (
            SELECT 1 FROM delivery_outbox predecessor
            WHERE predecessor.delivery_group_id = o.delivery_group_id
              AND predecessor.part_index < o.part_index
              AND predecessor.status != 'delivered'
          )
        )
    `).get(id);
    return candidate
      ? claimCandidates(db, [candidate.id], owner, now, leaseExpiresAt)[0] || null
      : null;
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
    const delivered = getDeliveryRow(db, id);
    if (info.changes === 1) reconcileCompletionDebt(db, delivered);
    return {
      ...decorateDelivery(db, delivered),
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
    const updated = getDeliveryRow(db, id);
    if (info.changes === 1) {
      if (exhausted) cancelLaterGroupParts(db, updated, `Multipart delivery stopped after part ${updated.part_index || '?'} failed: ${errorText}`);
      reconcileCompletionDebt(db, updated);
    }
    return {
      ...decorateDelivery(db, updated),
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
    const updated = getDeliveryRow(db, id);
    if (info.changes === 1) {
      cancelLaterGroupParts(db, updated, `Multipart delivery stopped after part ${updated.part_index || '?'} failed: ${errorText}`);
      reconcileCompletionDebt(db, updated);
    }
    return {
      ...decorateDelivery(db, updated),
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
    const updated = getDeliveryRow(db, id);
    if (info.changes === 1) {
      cancelLaterGroupParts(db, updated, `Multipart delivery stopped after cancellation: ${reasonText}`);
      reconcileCompletionDebt(db, updated);
    }
    return {
      ...decorateDelivery(db, updated),
      transitioned: info.changes === 1,
    };
  });
}

export function cancelDeliveriesForRun(runId, reason = 'Run cancelled', opts = {}) {
  const db = opts.db || getDb();
  const reasonText = String(reason || 'Run cancelled').slice(0, 4000);
  return immediate(db, () => {
    const linked = db.prepare(`
      SELECT DISTINCT completion_label, completion_scope
      FROM delivery_outbox
      WHERE run_id = ? AND completion_label IS NOT NULL
    `).all(runId);
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'cancelled',
          next_attempt_at = datetime('now'),
          ${clearClaimSql()},
          last_error = ?
      WHERE run_id = ? AND status IN ('pending', 'claimed', 'failed')
    `).run(reasonText, runId);
    for (const completion of linked) reconcileCompletionDebt(db, completion);
    return info.changes;
  });
}

export function cancelDeliveriesForJob(jobId, reason = 'Job cancelled', opts = {}) {
  const db = opts.db || getDb();
  const reasonText = String(reason || 'Job cancelled').slice(0, 4000);
  return immediate(db, () => {
    const linked = db.prepare(`
      SELECT DISTINCT completion_label, completion_scope
      FROM delivery_outbox
      WHERE job_id = ? AND completion_label IS NOT NULL
    `).all(jobId);
    const info = db.prepare(`
      UPDATE delivery_outbox
      SET status = 'cancelled',
          next_attempt_at = datetime('now'),
          ${clearClaimSql()},
          last_error = ?
      WHERE job_id = ? AND status IN ('pending', 'claimed', 'failed')
    `).run(reasonText, jobId);
    for (const completion of linked) reconcileCompletionDebt(db, completion);
    return info.changes;
  });
}

export function retryFailedDelivery(id, opts = {}) {
  const db = opts.db || getDb();
  const maxAttempts = positiveInteger(opts.maxAttempts, 5, 'maxAttempts');
  const resetAttempts = opts.resetAttempts !== false;
  const nextAttemptAt = sqliteTimestamp(opts.nextAttemptAt ?? Date.now());
  return immediate(db, () => {
    const before = getDeliveryRow(db, id);
    if (!before) return null;
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
    if (info.changes === 1 && before.delivery_group_id && Number.isInteger(before.part_index)) {
      db.prepare(`
        UPDATE delivery_outbox
        SET status = 'pending', attempt_count = 0, max_attempts = ?,
            next_attempt_at = ?, ${clearClaimSql()}, last_error = NULL
        WHERE delivery_group_id = ?
          AND part_index > ?
          AND status = 'cancelled'
      `).run(maxAttempts, nextAttemptAt, before.delivery_group_id, before.part_index);
    }
    const row = getDeliveryRow(db, id);
    if (info.changes === 1) reconcileCompletionDebt(db, row);
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
