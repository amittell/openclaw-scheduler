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
import { resolveSchedulerDbPath } from '../paths.js';
import { deliverMessage } from '../gateway.js';
import { ackMessage, recordMessageAttempt } from '../messages.js';

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
  if (!dateStr) return 'unknown';
  const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  const ts = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z').getTime();
  if (isNaN(ts)) return 'unknown';
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
    SELECT id, from_agent, to_agent, subject, body, kind, created_at, priority,
           delivery_to, channel
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

async function drainOnce(db, { to, channel, agentId, limit }) {
  const msgs = selectPendingMessages(db, agentId, limit);
  if (msgs.length === 0) {
    return 0;
  }

  // Group messages by kind for independent delivery attempts
  const groups = new Map();
  for (const msg of msgs) {
    const target = msg.delivery_to || to || '_default_target';
    const ch = msg.channel || channel || '_default_channel';
    const key = `${msg.kind || '_default'}:${ch}:${target}`;
    if (!groups.has(key)) groups.set(key, { msgs: [] });
    groups.get(key).msgs.push(msg);
  }

  let delivered = 0;
  const groupErrors = [];
  for (const [, group] of groups) {
    // Determine routing: use per-message delivery_to/channel when present,
    // fall back to the default --to / --channel args.
    // All messages in a group share the same kind, but may have different targets
    // if they were enqueued with explicit delivery_to. To keep grouping meaningful,
    // we use the first message's delivery_to as the representative for the group.
    const firstMsg = group.msgs[0];
    const msgTarget = firstMsg.delivery_to || to;
    const msgChannel = firstMsg.channel || channel;

    try {
      const text = formatMessages(group.msgs, agentId);
      await deliverMessage(msgChannel, msgTarget, text);
      for (const msg of group.msgs) {
        recordMessageAttempt(msg.id, { ok: true, actor: 'inbox-consumer' });
        ackMessage(msg.id, 'inbox-consumer', `Delivered to ${msgChannel}:${msgTarget}`);
      }
      delivered += group.msgs.length;
    } catch (err) {
      for (const msg of group.msgs) {
        recordMessageAttempt(msg.id, {
          ok: false,
          actor: 'inbox-consumer',
          error: err.message || 'delivery failed',
        });
      }
      groupErrors.push(err);
      // continue to next group instead of throwing
    }
  }

  if (delivered > 0) {
    process.stdout.write(`[inbox-consumer] delivered ${delivered} message(s)\n`);
  }
  if (groupErrors.length > 0) {
    throw new Error(`Delivery failed for ${groupErrors.length} group(s): ${groupErrors.map(e => e.message).join('; ')}`);
  }
  return delivered;
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

const dbPath = resolve(resolveSchedulerDbPath({ env: process.env }));
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
