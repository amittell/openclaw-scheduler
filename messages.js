// Message queue -- inter-agent communication
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

// Valid message kinds (extended with typed contract kinds)
const VALID_KINDS = new Set([
  'text', 'task', 'result', 'status', 'system', 'spawn',
  'decision', 'constraint', 'fact', 'preference',
]);

// Rows with either external route field belong to the legacy delivery queue.
// They remain readable by the compatibility consumer, but must never enter an
// agent prompt or any agent-facing unread count.
const INTERNAL_ROUTE_SQL = 'channel IS NULL AND delivery_to IS NULL';
const PROMPT_CLAIM_PATH = '$._scheduler_prompt_claim';
const PROMPT_WRAPPER_PATH = '$._scheduler_prompt_claim.metadata_wrapped';
const PROMPT_ORIGINAL_JSON_PATH = '$._scheduler_prompt_original_metadata';
const PROMPT_ORIGINAL_RAW_PATH = '$._scheduler_prompt_original_metadata_raw';

function immediate(db, fn) {
  const transaction = db.transaction(fn);
  return db.inTransaction ? transaction() : transaction.immediate();
}

function requiredId(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function normalizeMessageIds(messageIds) {
  if (!Array.isArray(messageIds)) throw new Error('messageIds must be an array');
  const ids = [...new Set(messageIds.map(id => requiredId(id, 'messageId')))];
  if (ids.length > 1000) throw new Error('messageIds may contain at most 1000 unique IDs');
  return ids;
}

function claimableMetadataSql() {
  return `CASE
    WHEN metadata IS NULL OR trim(metadata) = '' THEN '{}'
    WHEN json_valid(metadata) AND json_type(metadata) = 'object' THEN metadata
    WHEN json_valid(metadata) THEN json_object(
      '_scheduler_prompt_original_metadata', json(metadata)
    )
    ELSE json_object(
      '_scheduler_prompt_original_metadata_raw', metadata
    )
  END`;
}

function removePromptClaimSql() {
  return `CASE
    WHEN json_valid(metadata)
      AND json_extract(metadata, '${PROMPT_WRAPPER_PATH}') = 1
    THEN CASE
      WHEN json_type(metadata, '${PROMPT_ORIGINAL_JSON_PATH}') IS NOT NULL
      THEN metadata -> '${PROMPT_ORIGINAL_JSON_PATH}'
      ELSE json_extract(metadata, '${PROMPT_ORIGINAL_RAW_PATH}')
    END
    ELSE NULLIF(json_remove(
      CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
      '${PROMPT_CLAIM_PATH}'
    ), '{}')
  END`;
}

/**
 * Send a message from one agent to another.
 */
export function sendMessage(opts) {
  if (!opts.from_agent) throw new Error('from_agent is required');
  if (!opts.to_agent) throw new Error('to_agent is required');
  if (opts.body == null) throw new Error('body is required');
  if (opts.attachments != null) {
    if (!Array.isArray(opts.attachments)) throw new Error('attachments must be an array');
    if (opts.attachments.length > 0) {
      throw new Error('sendMessage does not accept external attachments; use enqueueDelivery so files are persisted');
    }
  }
  const db = getDb();
  const id = randomUUID();
  const kind = opts.kind || 'text';

  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid message kind '${kind}'. Valid: ${[...VALID_KINDS].join(', ')}`);
  }

  const idempotencyKey = opts.idempotency_key || null;

  // With an idempotency key, a re-enqueue of the same logical message (e.g. a
  // crash-retry, or two delivery paths for one completion) collapses to the
  // original row instead of creating a duplicate. Without one, behavior is
  // unchanged (every call inserts a fresh row).
  const info = db.prepare(`
    INSERT INTO messages (
      id, from_agent, to_agent, team_id, member_id, task_id, reply_to,
      kind, subject, body, metadata, priority, channel, delivery_to, status,
      expires_at, job_id, run_id, owner, ack_required, idempotency_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  `).run(
    id,
    opts.from_agent,
    opts.to_agent,
    opts.team_id || null,
    opts.member_id || null,
    opts.task_id || null,
    opts.reply_to || null,
    kind,
    opts.subject || null,
    opts.body,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    opts.priority || 0,
    opts.channel || null,
    opts.delivery_to || null,
    opts.expires_at || null,
    opts.job_id || null,
    opts.run_id || null,
    opts.owner || null,
    opts.ack_required ? 1 : 0,
    idempotencyKey
  );

  if (idempotencyKey && info.changes === 0) {
    // Duplicate: an equivalent message already exists -- return it unchanged.
    const existing = db.prepare('SELECT id FROM messages WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return { ...getMessage(existing.id), deduped: true };
    // Conflict reported but the row is gone (deleted/compacted between the
    // insert and this read). Surface a clear consistency error instead of
    // falling through to return a phantom row for the never-inserted id.
    throw new Error(`sendMessage: idempotency conflict for '${idempotencyKey}' but no existing row found`);
  }

  return getMessage(id);
}

/**
 * Get a message by ID.
 */
export function getMessage(id) {
  const msg = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (msg && msg.metadata) {
    try { msg.metadata = JSON.parse(msg.metadata); } catch (err) {
      process.stderr.write(`[messages] JSON parse error for metadata: ${err.message}\n`);
    }
  }
  return msg;
}

/**
 * Get pending messages for an agent (inbox), ordered by typed priority then
 * numeric priority then time.
 */
export function getInbox(agentId, opts = {}) {
  const limit = opts.limit || 50;
  const includeRead = opts.includeRead || false;
  const includeDelivered = opts.includeDelivered || false;
  const teamId = opts.teamId || null;
  const memberId = opts.memberId || null;
  const taskId = opts.taskId || null;

  // SQLite CASE expression mirrors KIND_PRIORITY map
  const kindOrder = `
    CASE kind
      WHEN 'constraint' THEN 0
      WHEN 'decision'   THEN 1
      WHEN 'fact'       THEN 2
      WHEN 'task'       THEN 3
      WHEN 'preference' THEN 4
      ELSE 5
    END`;

  const whereParts = ['(to_agent = ? OR to_agent = \'broadcast\')'];
  const whereParams = [agentId];
  if (teamId) {
    whereParts.push('team_id = ?');
    whereParams.push(teamId);
  }
  if (memberId) {
    whereParts.push('(member_id IS NULL OR member_id = ?)');
    whereParams.push(memberId);
  }
  if (taskId) {
    whereParts.push('task_id = ?');
    whereParams.push(taskId);
  }
  const whereSql = whereParts.join(' AND ');

  if (includeRead) {
    return getDb().prepare(`
      SELECT * FROM messages
      WHERE ${whereSql}
        AND ${INTERNAL_ROUTE_SQL}
        AND status IN ('pending', 'delivered', 'read')
      ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
      LIMIT ?
    `).all(...whereParams, limit).map(parseMetadata);
  }

  if (includeDelivered) {
    return getDb().prepare(`
      SELECT * FROM messages
      WHERE ${whereSql}
        AND ${INTERNAL_ROUTE_SQL}
        AND status IN ('pending', 'delivered')
      ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
      LIMIT ?
    `).all(...whereParams, limit).map(parseMetadata);
  }

  return getDb().prepare(`
    SELECT * FROM messages
    WHERE ${whereSql}
      AND ${INTERNAL_ROUTE_SQL}
      AND status = 'pending'
    ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
    LIMIT ?
  `).all(...whereParams, limit).map(parseMetadata);
}

/**
 * Atomically reserve pending internal messages for one scheduler run. Repeated
 * calls by the same run return its existing reservations, while competing runs
 * cannot observe or claim them.
 */
export function claimInboxForRun(agentId, runId, opts = {}) {
  const db = opts.db || getDb();
  const normalizedAgentId = requiredId(agentId, 'agentId');
  const normalizedRunId = requiredId(runId, 'runId');
  const limit = opts.limit == null ? 5 : Number(opts.limit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error('limit must be an integer between 1 and 1000');
  }

  return immediate(db, () => {
    const alreadyClaimed = db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE (to_agent = ? OR to_agent = 'broadcast')
        AND ${INTERNAL_ROUTE_SQL}
        AND status = 'prompt_claimed'
        AND json_valid(metadata)
        AND json_extract(metadata, '${PROMPT_CLAIM_PATH}.run_id') = ?
    `).get(normalizedAgentId, normalizedRunId).count;
    const remaining = Math.max(0, limit - alreadyClaimed);

    if (remaining > 0) {
      const candidates = db.prepare(`
        SELECT id
        FROM messages
        WHERE (to_agent = ? OR to_agent = 'broadcast')
          AND ${INTERNAL_ROUTE_SQL}
          AND status = 'pending'
        ORDER BY
          CASE kind
            WHEN 'constraint' THEN 0
            WHEN 'decision'   THEN 1
            WHEN 'fact'       THEN 2
            WHEN 'task'       THEN 3
            WHEN 'preference' THEN 4
            ELSE 5
          END ASC,
          priority DESC,
          created_at ASC,
          id ASC
        LIMIT ?
      `).all(normalizedAgentId, remaining);
      const claim = db.prepare(`
        UPDATE messages
        SET status = 'prompt_claimed',
            metadata = json_set(
              ${claimableMetadataSql()},
              '${PROMPT_CLAIM_PATH}',
              json_object(
                'run_id', ?,
                'claimed_at', datetime('now'),
                'metadata_wrapped', CASE
                  WHEN metadata IS NULL OR trim(metadata) = '' THEN 0
                  WHEN json_valid(metadata) AND json_type(metadata) = 'object' THEN 0
                  ELSE 1
                END
              )
            ),
            last_error = NULL
        WHERE id = ?
          AND status = 'pending'
          AND ${INTERNAL_ROUTE_SQL}
          AND (to_agent = ? OR to_agent = 'broadcast')
      `);
      for (const candidate of candidates) {
        claim.run(normalizedRunId, candidate.id, normalizedAgentId);
      }
    }

    return db.prepare(`
      SELECT *
      FROM messages
      WHERE (to_agent = ? OR to_agent = 'broadcast')
        AND ${INTERNAL_ROUTE_SQL}
        AND status = 'prompt_claimed'
        AND json_valid(metadata)
        AND json_extract(metadata, '${PROMPT_CLAIM_PATH}.run_id') = ?
      ORDER BY
        CASE kind
          WHEN 'constraint' THEN 0
          WHEN 'decision'   THEN 1
          WHEN 'fact'       THEN 2
          WHEN 'task'       THEN 3
          WHEN 'preference' THEN 4
          ELSE 5
        END ASC,
        priority DESC,
        created_at ASC,
        id ASC
      LIMIT ?
    `).all(normalizedAgentId, normalizedRunId, limit).map(parseMetadata);
  });
}

/** Mark prompt reservations as consumed only after their owning turn completes. */
export function ackClaimedInboxForRun(runId, messageIds, opts = {}) {
  const db = opts.db || getDb();
  const normalizedRunId = requiredId(runId, 'runId');
  const ids = normalizeMessageIds(messageIds);
  if (ids.length === 0) return { acked: 0, messages: [] };

  return immediate(db, () => {
    const update = db.prepare(`
      UPDATE messages
      SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, datetime('now')),
          delivery_attempts = COALESCE(delivery_attempts, 0) + 1,
          metadata = ${removePromptClaimSql()},
          last_error = NULL
      WHERE id = ?
        AND status = 'prompt_claimed'
        AND ${INTERNAL_ROUTE_SQL}
        AND json_valid(metadata)
        AND json_extract(metadata, '${PROMPT_CLAIM_PATH}.run_id') = ?
      RETURNING *
    `);
    const messages = [];
    for (const id of ids) {
      const row = update.get(id, normalizedRunId);
      if (!row) continue;
      messages.push(parseMetadata(row));
      addReceipt(
        row.id,
        'attempt',
        row.delivery_attempts,
        'dispatcher',
        `Injected into completed run ${normalizedRunId}`,
        db
      );
    }
    return { acked: messages.length, messages };
  });
}

/** Release prompt reservations after a failed/deferred turn so another run can retry. */
export function releaseClaimedInboxForRun(runId, messageIds, opts = {}) {
  const db = opts.db || getDb();
  const normalizedRunId = requiredId(runId, 'runId');
  const ids = normalizeMessageIds(messageIds);
  if (ids.length === 0) return { released: 0, messages: [] };
  const reason = opts.reason ? String(opts.reason).slice(0, 4000) : null;

  return immediate(db, () => {
    const update = db.prepare(`
      UPDATE messages
      SET status = 'pending',
          metadata = ${removePromptClaimSql()},
          last_error = ?
      WHERE id = ?
        AND status = 'prompt_claimed'
        AND ${INTERNAL_ROUTE_SQL}
        AND json_valid(metadata)
        AND json_extract(metadata, '${PROMPT_CLAIM_PATH}.run_id') = ?
      RETURNING *
    `);
    const messages = [];
    for (const id of ids) {
      const row = update.get(reason, id, normalizedRunId);
      if (row) messages.push(parseMetadata(row));
    }
    return { released: messages.length, messages };
  });
}

/** Recover abandoned prompt reservations whose owning run is no longer active. */
export function recoverStaleInboxClaims(opts = {}) {
  const db = opts.db || getDb();
  const olderThanSeconds = opts.olderThanSeconds == null ? 300 : Number(opts.olderThanSeconds);
  if (!Number.isSafeInteger(olderThanSeconds) || olderThanSeconds < 0) {
    throw new Error('olderThanSeconds must be a non-negative integer');
  }

  return immediate(db, () => {
    const candidates = db.prepare(`
      SELECT id,
             CASE WHEN json_valid(metadata)
               THEN json_extract(metadata, '${PROMPT_CLAIM_PATH}.run_id')
               ELSE NULL
             END AS prompt_run_id
      FROM messages
      WHERE status = 'prompt_claimed'
        AND ${INTERNAL_ROUTE_SQL}
        AND (
          NOT json_valid(metadata)
          OR json_extract(metadata, '${PROMPT_CLAIM_PATH}.claimed_at') IS NULL
          OR json_extract(metadata, '${PROMPT_CLAIM_PATH}.claimed_at')
             <= datetime('now', '-' || ? || ' seconds')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM runs r
          WHERE r.id = CASE WHEN json_valid(messages.metadata)
            THEN json_extract(messages.metadata, '${PROMPT_CLAIM_PATH}.run_id')
            ELSE NULL
          END
            AND r.status IN ('pending', 'running', 'awaiting_approval', 'approved')
        )
      ORDER BY created_at ASC, id ASC
    `).all(olderThanSeconds);
    const update = db.prepare(`
      UPDATE messages
      SET status = 'pending',
          metadata = ${removePromptClaimSql()},
          last_error = ?
      WHERE id = ? AND status = 'prompt_claimed'
      RETURNING *
    `);
    const messages = [];
    for (const candidate of candidates) {
      const detail = candidate.prompt_run_id
        ? `Recovered stale prompt claim from run ${candidate.prompt_run_id}`
        : 'Recovered malformed stale prompt claim';
      const row = update.get(detail, candidate.id);
      if (row) messages.push(parseMetadata(row));
    }
    return { recovered: messages.length, messages };
  });
}

/**
 * Team mailbox query (independent of to_agent).
 */
export function getTeamMessages(teamId, opts = {}) {
  const limit = opts.limit || 50;
  const includeRead = opts.includeRead || false;
  const memberId = opts.memberId || null;
  const taskId = opts.taskId || null;

  const where = ['team_id = ?'];
  const params = [teamId];
  if (memberId) {
    where.push('(member_id IS NULL OR member_id = ?)');
    params.push(memberId);
  }
  if (taskId) {
    where.push('task_id = ?');
    params.push(taskId);
  }
  where.push(INTERNAL_ROUTE_SQL);

  if (!includeRead) {
    where.push("status IN ('pending', 'delivered')");
  }

  return getDb().prepare(`
    SELECT * FROM messages
    WHERE ${where.join(' AND ')}
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...params, limit).map(parseMetadata);
}

/**
 * Get messages sent by an agent (outbox).
 */
export function getOutbox(agentId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE from_agent = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agentId, limit).map(parseMetadata);
}

/**
 * Get thread (message + all replies).
 */
export function getThread(messageId) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE id = ? OR reply_to = ?
    ORDER BY created_at ASC
  `).all(messageId, messageId).map(parseMetadata);
}

/**
 * Mark a message as delivered.
 */
export function markDelivered(id) {
  const result = getDb().prepare(`
    UPDATE messages SET status = 'delivered', delivered_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);
  if (result.changes > 0) {
    recordMessageAttempt(id, { ok: true, actor: 'dispatcher' });
  }
}

/**
 * Mark a message as read.
 */
export function markRead(id) {
  const result = getDb().prepare(`
    UPDATE messages
    SET status = 'read',
        read_at = datetime('now'),
        ack_at = COALESCE(ack_at, datetime('now'))
    WHERE id = ? AND status IN ('pending', 'delivered')
  `).run(id);
  if (result.changes > 0) {
    addReceipt(id, 'ack', null, 'agent', null);
  }
}

/**
 * Explicit ACK helper (alias for markRead with actor).
 */
export function ackMessage(id, actor = 'agent', detail = null) {
  const result = getDb().prepare(`
    UPDATE messages
    SET status = CASE WHEN status IN ('pending', 'delivered') THEN 'read' ELSE status END,
        read_at = COALESCE(read_at, datetime('now')),
        ack_at = COALESCE(ack_at, datetime('now'))
    WHERE id = ?
  `).run(id);
  if (result.changes > 0) {
    addReceipt(id, 'ack', null, actor, detail);
  }
  return getMessage(id);
}

/**
 * Mark all pending/delivered messages for an agent as read.
 */
export function markAllRead(agentId) {
  return getDb().prepare(`
    UPDATE messages
    SET status = 'read',
        read_at = datetime('now'),
        ack_at = COALESCE(ack_at, datetime('now'))
    WHERE (to_agent = ? OR to_agent = 'broadcast') AND status IN ('pending', 'delivered')
      AND ${INTERNAL_ROUTE_SQL}
  `).run(agentId);
}

/**
 * Get unread count for an agent.
 */
export function getUnreadCount(agentId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
      AND ${INTERNAL_ROUTE_SQL}
      AND status IN ('pending', 'delivered')
  `).get(agentId);
  return row.cnt;
}

/**
 * Expire old messages past their TTL.
 */
export function expireMessages() {
  return getDb().prepare(`
    UPDATE messages SET status = 'expired'
    WHERE expires_at IS NOT NULL
      AND expires_at < datetime('now')
      AND status IN ('pending', 'delivered')
  `).run();
}

/**
 * Prune old read/expired/delivered messages.
 * - read/expired/failed: after keepDays (default 30)
 * - delivered: after deliveredKeepDays (default 3) -- delivered means consumed, no longer needed
 * - system kind pending/delivered: after systemKeepDays (default 3) -- failure notifications, not actionable
 */
export function pruneMessages(keepDays = 30, deliveredKeepDays = 3, systemKeepDays = 3) {
  const db = getDb();
  // Prune read/expired/failed after keepDays
  db.prepare(`
    DELETE FROM messages
    WHERE status IN ('read', 'expired', 'failed')
      AND created_at < datetime('now', '-' || ? || ' days')
  `).run(keepDays);
  // Prune delivered messages after deliveredKeepDays
  db.prepare(`
    DELETE FROM messages
    WHERE status = 'delivered'
      AND created_at < datetime('now', '-' || ? || ' days')
  `).run(deliveredKeepDays);
  // Prune system/result notifications after systemKeepDays regardless of status
  // (runs table is the canonical record; these queue messages are just transient notifications)
  return db.prepare(`
    DELETE FROM messages
    WHERE kind IN ('system', 'result')
      AND created_at < datetime('now', '-' || ? || ' days')
  `).run(systemKeepDays);
}

/**
 * Record a delivery attempt (success or failure) for receipt auditing.
 */
export function recordMessageAttempt(messageId, opts = {}) {
  const ok = opts.ok !== false;
  const actor = opts.actor || 'system';
  const error = ok ? null : (opts.error || 'Delivery failed');
  const db = getDb();
  const row = db.prepare('SELECT delivery_attempts FROM messages WHERE id = ?').get(messageId);
  if (!row) return null;
  const nextAttempt = (row.delivery_attempts || 0) + 1;
  db.prepare(`
    UPDATE messages
    SET delivery_attempts = COALESCE(delivery_attempts, 0) + 1,
        last_error = ?
    WHERE id = ?
  `).run(error, messageId);
  addReceipt(messageId, ok ? 'attempt' : 'error', nextAttempt, actor, error);
  return getMessage(messageId);
}

/**
 * List receipt events for a message.
 */
export function listMessageReceipts(messageId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM message_receipts
    WHERE message_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(messageId, limit);
}

function addReceipt(messageId, eventType, attempt = null, actor = 'system', detail = null, db = getDb()) {
  try {
    db.prepare(`
      INSERT INTO message_receipts (id, message_id, event_type, attempt, actor, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), messageId, eventType, attempt, actor, detail);
  } catch (err) {
    process.stderr.write(`[messages] receipt insert error: ${err.message}\n`);
  }
}

function parseMetadata(msg) {
  if (msg && msg.metadata && typeof msg.metadata === 'string') {
    try { msg.metadata = JSON.parse(msg.metadata); } catch (err) {
      process.stderr.write(`[messages] JSON parse error for metadata: ${err.message}\n`);
    }
  }
  return msg;
}
