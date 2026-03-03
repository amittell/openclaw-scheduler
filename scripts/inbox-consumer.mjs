#!/usr/bin/env node
/**
 * inbox-consumer.mjs
 *
 * Drains pending scheduler messages for an agent and delivers them to a channel target.
 * Intended for signal-only queue patterns where scripts enqueue actionable messages.
 *
 * Usage:
 *   node scripts/inbox-consumer.mjs --to <target-id> [--channel telegram] [--agent main] [--limit 50]
 *   node scripts/inbox-consumer.mjs --to <target-id> --watch
 *
 * Env fallbacks:
 *   INBOX_DELIVERY_TO
 *   INBOX_DELIVERY_CHANNEL (default: telegram)
 *   INBOX_AGENT (default: main)
 *   INBOX_LIMIT (default: 50)
 */

import { dirname, basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { watch } from 'fs';
import { getDb } from '../db.js';
import { deliverMessage } from '../gateway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { watch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--watch') {
      out.watch = true;
      continue;
    }
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      out[key] = value;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parsePositiveInt(input, fallback) {
  const n = Number.parseInt(String(input ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function timeAgo(dateStr) {
  const ts = new Date(`${dateStr}Z`).getTime();
  if (!Number.isFinite(ts)) return 'unknown';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatMessages(msgs, agentId) {
  const lines = [`Inbox for ${agentId}: ${msgs.length} message(s)`];
  for (const msg of msgs) {
    lines.push('');
    lines.push(`[${msg.kind}] from=${msg.from_agent} age=${timeAgo(msg.created_at)} priority=${msg.priority}`);
    if (msg.subject) lines.push(`subject: ${msg.subject}`);
    if (msg.body) lines.push(msg.body.trim().slice(0, 1200));
    lines.push('---');
  }
  return lines.join('\n').trim();
}

function selectPendingMessages(db, agentId, limit) {
  return db.prepare(`
    SELECT id, from_agent, to_agent, subject, body, kind, created_at, priority
    FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
      AND status IN ('pending', 'delivered')
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
      created_at ASC
    LIMIT ?
  `).all(agentId, limit);
}

function markReadBatch(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`
    UPDATE messages
    SET status = 'read', read_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...ids);
}

async function drainOnce(db, { to, channel, agentId, limit }) {
  const msgs = selectPendingMessages(db, agentId, limit);
  if (msgs.length === 0) {
    return 0;
  }
  const text = formatMessages(msgs, agentId);
  await deliverMessage(channel, to, text);
  markReadBatch(db, msgs.map((m) => m.id));
  process.stdout.write(`[inbox-consumer] delivered ${msgs.length} message(s) to ${channel}:${to}\n`);
  return msgs.length;
}

const args = parseArgs(process.argv.slice(2));
const deliveryTo = args.to || process.env.INBOX_DELIVERY_TO || '';
const channel = args.channel || process.env.INBOX_DELIVERY_CHANNEL || 'telegram';
const agentId = args.agent || process.env.INBOX_AGENT || 'main';
const limit = parsePositiveInt(args.limit || process.env.INBOX_LIMIT, 50);
const watchMode = Boolean(args.watch);

if (!deliveryTo) {
  process.stderr.write('[inbox-consumer] missing delivery target; pass --to or set INBOX_DELIVERY_TO\n');
  process.exit(1);
}

const defaultDbPath = resolve(join(__dirname, '..', 'scheduler.db'));
const dbPath = resolve(process.env.SCHEDULER_DB || defaultDbPath);
const watchDir = dirname(dbPath);
const walFile = `${basename(dbPath)}-wal`;

try {
  const db = getDb();

  if (!watchMode) {
    await drainOnce(db, { to: deliveryTo, channel, agentId, limit });
    process.exit(0);
  }

  process.stdout.write(`[inbox-consumer] watching ${join(watchDir, walFile)}\n`);
  await drainOnce(db, { to: deliveryTo, channel, agentId, limit });

  let timer = null;
  let draining = false;

  const runDebouncedDrain = async () => {
    if (draining) return;
    draining = true;
    try {
      await drainOnce(db, { to: deliveryTo, channel, agentId, limit });
    } catch (err) {
      process.stderr.write(`[inbox-consumer] drain error: ${err.message}\n`);
    } finally {
      draining = false;
    }
  };

  const watcher = watch(watchDir, (_eventType, filename) => {
    if (filename !== walFile) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runDebouncedDrain();
    }, 250);
  });

  const shutdown = (signal) => {
    if (timer) clearTimeout(timer);
    watcher.close();
    process.stdout.write(`[inbox-consumer] ${signal}; exiting\n`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (err) {
  process.stderr.write(`[inbox-consumer] error: ${err.stack || err.message}\n`);
  process.exit(1);
}
