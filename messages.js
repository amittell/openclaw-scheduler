// Message queue — inter-agent communication
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

// Valid message kinds (extended with typed contract kinds)
const VALID_KINDS = new Set([
  'text', 'task', 'result', 'status', 'system', 'spawn',
  'decision', 'constraint', 'fact', 'preference',
]);

/**
 * Send a message from one agent to another.
 */
export function sendMessage(opts) {
  const db = getDb();
  const id = randomUUID();
  const kind = opts.kind || 'text';

  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid message kind '${kind}'. Valid: ${[...VALID_KINDS].join(', ')}`);
  }

  db.prepare(`
    INSERT INTO messages (
      id, from_agent, to_agent, team_id, member_id, task_id, reply_to,
      kind, subject, body, metadata, priority, channel, status,
      expires_at, job_id, run_id, owner, ack_required
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
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
    opts.expires_at || null,
    opts.job_id || null,
    opts.run_id || null,
    opts.owner || null,
    opts.ack_required ? 1 : 0
  );

  return getMessage(id);
}

/**
 * Get a message by ID.
 */
export function getMessage(id) {
  const msg = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (msg && msg.metadata) {
    try { msg.metadata = JSON.parse(msg.metadata); } catch {}
  }
  return msg;
}

// Typed priority for kind-based sorting (lower number = higher priority)
const KIND_PRIORITY = {
  constraint: 0,
  decision: 1,
  fact: 2,
  task: 3,
  preference: 4,
  // Everything else gets 5 (text, result, status, system, spawn)
};

function kindPriority(kind) {
  return KIND_PRIORITY[kind] ?? 5;
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
      ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
      LIMIT ?
    `).all(...whereParams, limit).map(parseMetadata);
  }

  if (includeDelivered) {
    return getDb().prepare(`
      SELECT * FROM messages
      WHERE ${whereSql}
        AND status IN ('pending', 'delivered')
      ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
      LIMIT ?
    `).all(...whereParams, limit).map(parseMetadata);
  }

  return getDb().prepare(`
    SELECT * FROM messages
    WHERE ${whereSql}
      AND status = 'pending'
    ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
    LIMIT ?
  `).all(...whereParams, limit).map(parseMetadata);
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
  `).run(agentId);
}

/**
 * Get unread count for an agent.
 */
export function getUnreadCount(agentId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
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
 * - delivered: after deliveredKeepDays (default 3) — delivered means consumed, no longer needed
 * - system kind pending/delivered: after systemKeepDays (default 3) — failure notifications, not actionable
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

function addReceipt(messageId, eventType, attempt = null, actor = 'system', detail = null) {
  try {
    getDb().prepare(`
      INSERT INTO message_receipts (id, message_id, event_type, attempt, actor, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), messageId, eventType, attempt, actor, detail);
  } catch {
    // Backward compatibility for very old schemas before init/migrate.
  }
}

function parseMetadata(msg) {
  if (msg && msg.metadata && typeof msg.metadata === 'string') {
    try { msg.metadata = JSON.parse(msg.metadata); } catch {}
  }
  return msg;
}
