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

/** Sentinel tokens that should never appear in user-facing delivery. */
const DELIVERY_SENTINELS = ['HEARTBEAT_OK', 'NO_FLUSH', 'IDEMPOTENT_SKIP'];

/**
 * Strip common shell output noise from delivery content:
 * - "stdout:\n" prefix added by the shell strategy
 * - Timestamped INFO log lines like "[2026-03-31 00:21:03] INFO ..."
 * Keep lines that look like actual results.
 */
function cleanShellOutput(text) {
  let cleaned = text;
  // Strip leading "stdout:" or "stderr:" prefix
  cleaned = cleaned.replace(/^stdout:\s*/i, '').replace(/^stderr:\s*/i, '');
  // Remove timestamped log lines (keep everything else)
  const lines = cleaned.split('\n');
  const meaningful = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Skip lines like "[2026-03-31 00:21:03] INFO === Auto-Settle starting ==="
    if (/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\]\s+(INFO|DEBUG|WARN)\s/.test(trimmed)) return false;
    return true;
  });
  return meaningful.join('\n').trim();
}

/**
 * Format a single message for user-facing delivery.
 * Strips debug metadata, sentinel tokens, shell noise, and adds a branded header.
 *
 * Env config:
 *   INBOX_BRAND: display name for the header (default: "Scheduler")
 */
function formatMessageForDelivery(msg, { brand = 'Scheduler' } = {}) {
  let body = (msg.body || '').trim();

  // Strip sentinel tokens from the end of the body
  for (const sentinel of DELIVERY_SENTINELS) {
    if (body.endsWith(sentinel)) {
      body = body.slice(0, -sentinel.length).trim();
    }
  }

  // Clean shell output noise
  body = cleanShellOutput(body);

  if (!body) return null;

  // Header: brand + subject + age
  const age = timeAgo(msg.created_at);
  const subject = msg.subject || 'Notification';
  const header = `${brand} | ${subject} | ${age}`;

  return `${header}\n\n${body}`.slice(0, 4000);
}

/**
 * Legacy debug format for --verbose mode.
 */
function _formatMessagesDebug(msgs, agentId) {
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

async function drainOnce(db, { to, channel, agentId, limit, brand }) {
  const msgs = selectPendingMessages(db, agentId, limit);
  if (msgs.length === 0) {
    return 0;
  }

  let delivered = 0;
  const deliveryErrors = [];

  // Deliver each message individually with clean user-facing formatting.
  // Messages are sent one at a time so a failure on one doesn't block others.
  for (const msg of msgs) {
    const msgTarget = msg.delivery_to || to;
    const msgChannel = msg.channel || channel;
    const text = formatMessageForDelivery(msg, { brand });

    if (!text) {
      // Empty after stripping sentinels -- ack without delivering
      ackMessage(msg.id, 'inbox-consumer', 'Suppressed (empty after sentinel strip)');
      delivered += 1;
      continue;
    }

    try {
      // Small delay between deliveries to avoid gateway rate/concurrency issues
      if (delivered > 0) await new Promise(r => setTimeout(r, 1500));
      await deliverMessage(msgChannel, msgTarget, text);
      recordMessageAttempt(msg.id, { ok: true, actor: 'inbox-consumer' });
      ackMessage(msg.id, 'inbox-consumer', `Delivered to ${msgChannel}:${msgTarget}`);
      delivered += 1;
    } catch (err) {
      recordMessageAttempt(msg.id, {
        ok: false,
        actor: 'inbox-consumer',
        error: err.message || 'delivery failed',
      });
      deliveryErrors.push(err);
    }
  }

  if (delivered > 0) {
    process.stdout.write(`[inbox-consumer] delivered ${delivered} message(s)\n`);
  }
  if (deliveryErrors.length > 0) {
    throw new Error(`Delivery failed for ${deliveryErrors.length} message(s): ${deliveryErrors.map(e => e.message).join('; ')}`);
  }
  return delivered;
}

const args = parseArgs(process.argv.slice(2));
const deliveryTo = args.to || process.env.INBOX_DELIVERY_TO || '';
const channel = args.channel || process.env.INBOX_DELIVERY_CHANNEL || 'telegram';
const agentId = args.agent || process.env.INBOX_AGENT || 'main';
const limit = parsePositiveInt(args.limit || process.env.INBOX_LIMIT, 50);
// Brand resolution: --brand flag > INBOX_BRAND env > dispatch config brand > "Scheduler"
let brand = args.brand || process.env.INBOX_BRAND || '';
if (!brand) {
  try {
    const configDir = process.env.DISPATCH_CONFIG_DIR || join(resolve(resolveSchedulerDbPath({ env: process.env }), '..'), 'dispatch');
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    brand = config.brand || config.name || '';
  } catch (_e) { /* no dispatch config -- use default */ }
}
if (!brand) brand = 'Scheduler';
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
    await drainOnce(db, { to: deliveryTo, channel, agentId, limit, brand });
    process.exit(0);
  }

  process.stdout.write(`[inbox-consumer] watching ${join(watchDir, walFile)}\n`);
  try {
    await drainOnce(db, { to: deliveryTo, channel, agentId, limit, brand });
  } catch (err) {
    process.stderr.write(`[inbox-consumer] initial drain error: ${err.message}\n`);
  }

  let timer = null;
  let draining = false;

  const runDebouncedDrain = async () => {
    if (draining) return;
    draining = true;
    try {
      await drainOnce(db, { to: deliveryTo, channel, agentId, limit, brand });
    } catch (err) {
      process.stderr.write(`[inbox-consumer] drain error: ${err.message}\n`);
    } finally {
      draining = false;
    }
  };

  const watcher = watch(watchDir, (_eventType, filename) => {
    if (filename !== null && filename !== walFile) return;
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
