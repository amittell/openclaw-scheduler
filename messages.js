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
    INSERT INTO messages (id, from_agent, to_agent, reply_to, kind, subject, body, metadata, priority, channel, status, expires_at, job_id, run_id, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id,
    opts.from_agent,
    opts.to_agent,
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
    opts.owner || null
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

  if (includeRead) {
    return getDb().prepare(`
      SELECT * FROM messages
      WHERE (to_agent = ? OR to_agent = 'broadcast')
      ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
      LIMIT ?
    `).all(agentId, limit).map(parseMetadata);
  }

  return getDb().prepare(`
    SELECT * FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
      AND status IN ('pending', 'delivered')
    ORDER BY ${kindOrder} ASC, priority DESC, created_at ASC
    LIMIT ?
  `).all(agentId, limit).map(parseMetadata);
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
  getDb().prepare(`
    UPDATE messages SET status = 'delivered', delivered_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);
}

/**
 * Mark a message as read.
 */
export function markRead(id) {
  getDb().prepare(`
    UPDATE messages SET status = 'read', read_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'delivered')
  `).run(id);
}

/**
 * Mark all pending/delivered messages for an agent as read.
 */
export function markAllRead(agentId) {
  return getDb().prepare(`
    UPDATE messages SET status = 'read', read_at = datetime('now')
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
 * Prune old read/expired messages (keep last N per agent pair).
 */
export function pruneMessages(keepDays = 30) {
  return getDb().prepare(`
    DELETE FROM messages
    WHERE status IN ('read', 'expired', 'failed')
      AND created_at < datetime('now', '-' || ? || ' days')
  `).run(keepDays);
}

function parseMetadata(msg) {
  if (msg && msg.metadata && typeof msg.metadata === 'string') {
    try { msg.metadata = JSON.parse(msg.metadata); } catch {}
  }
  return msg;
}
