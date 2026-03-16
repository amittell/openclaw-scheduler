#!/usr/bin/env node
/**
 * inbox-consumer.mjs — Drain pending chilisaus queue messages → Telegram
 *
 * Reads pending messages addressed to the 'main' agent from the scheduler DB,
 * formats them, delivers directly via the gateway, and marks them read.
 *
 * Design (Option 3):
 *   - Scripts write to queue ONLY when they have found signal worth surfacing
 *   - This consumer is intentionally "dumb" — it just formats and delivers
 *   - Dispatcher announce mode handles failures separately (immediate, no queue)
 *   - No LLM involved in the consumer itself — scripts already made the judgment call
 *
 * Modes:
 *   Normal (no args):  drain pending messages and exit — called by cron every 1 min
 *   Watch (--watch):   daemon mode — watches scheduler.db-wal for changes and drains
 *                      immediately on each write, with 200ms debounce
 *
 * Exit codes:
 *   0 — success: no messages, OR messages delivered successfully
 *   1 — hard error (DB failure, delivery failure)
 *
 * Env vars:
 *   OPENCLAW_GATEWAY_URL    — gateway base URL (default: http://127.0.0.1:18789)
 *   OPENCLAW_GATEWAY_TOKEN  — bearer token (or use ~/.openclaw/credentials/.gateway-token)
 *   INBOX_DELIVERY_CHANNEL  — Telegram channel name (default: telegram)
 *   INBOX_DELIVERY_TO       — Telegram target ID (default: 484946046)
 *   SCHEDULER_DB            — override scheduler DB path
 */

import { join } from 'path';
import { watch } from 'fs';
import { getDb } from './db.js';
import { deliverMessage } from './gateway.js';

const SCHEDULER_DIR  = join(process.env.HOME, '.openclaw', 'scheduler');
const _WAL_FILE       = join(SCHEDULER_DIR, 'scheduler.db-wal');
const DELIVERY_TO    = process.env.INBOX_DELIVERY_TO      || '484946046';
const DELIVERY_CH    = process.env.INBOX_DELIVERY_CHANNEL || 'telegram';

const WATCH_MODE = process.argv.includes('--watch');

// Messages that fail delivery this many times are marked 'failed' to prevent infinite retry loops.
const MAX_DELIVERY_ATTEMPTS = 5;

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(dateStr) {
  const ms  = Date.now() - new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60)  return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

const KIND_ICON = {
  result:     '📊',
  task:       '📋',
  status:     '📡',
  fact:       '💡',
  decision:   '⚖️',
  constraint: '🔒',
  preference: '🎯',
  system:     '⚙️',
  spawn:      '🚀',
  text:       '💬',
};

function formatMessages(msgs) {
  const header = `📬 *Inbox* (${msgs.length} message${msgs.length !== 1 ? 's' : ''})`;
  const parts  = [header];

  for (const msg of msgs) {
    const icon    = KIND_ICON[msg.kind] || '📩';
    const age     = timeAgo(msg.created_at);
    const from    = msg.from_agent || 'unknown';
    const subject = msg.subject ? `*${msg.subject}*` : null;
    const body    = (msg.body || '').trim().slice(0, 600);

    parts.push('');
    if (subject) {
      parts.push(`${icon} ${subject}`);
      parts.push(`_${from}_ · ${msg.kind} · ${age}`);
    } else {
      parts.push(`${icon} _${from}_ · ${msg.kind} · ${age}`);
    }
    if (body) parts.push(body);
  }

  return parts.join('\n');
}

// ── Drain function (shared by both modes) ──────────────────────────────────

async function drainMessages(db, deliver) {
  const msgs = db.prepare(`
    SELECT id, from_agent, to_agent, subject, body, kind, created_at, priority, delivery_attempts
    FROM messages
    WHERE (to_agent = 'main' OR to_agent = 'broadcast')
      AND status IN ('pending', 'delivered')
    ORDER BY priority DESC, created_at ASC
    LIMIT 50
  `).all();

  if (msgs.length === 0) {
    return 0;
  }

  const text         = formatMessages(msgs);
  const ids          = msgs.map(m => m.id);
  const placeholders = ids.map(() => '?').join(', ');

  try {
    // Deliver directly — bypasses announce, guarantees delivery on normal path
    await deliver(DELIVERY_CH, DELIVERY_TO, text);
  } catch (err) {
    // Delivery failed — do NOT mark messages as read so they retry on the next drain cycle.
    // Increment the attempt counter and record the error on every message in this batch.
    // Once a message exceeds MAX_DELIVERY_ATTEMPTS it is marked 'failed' so it stops looping.
    const errText = String(err?.message ?? err).slice(0, 500);
    process.stderr.write(`[inbox-consumer] delivery failed (will retry): ${err?.stack ?? errText}\n`);
    db.prepare(`
      UPDATE messages
      SET delivery_attempts = delivery_attempts + 1,
          last_error        = ?,
          status            = CASE
            WHEN delivery_attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'failed'
            ELSE status
          END
      WHERE id IN (${placeholders})
    `).run(errText, ...ids);
    throw err; // re-throw so the caller (watch-mode debouncedDrain) logs it at the right level
  }

  // Delivery confirmed — mark as read
  db.prepare(`
    UPDATE messages
    SET status = 'read', read_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...ids);

  console.log(`[inbox-consumer] Delivered ${msgs.length} message(s) → ${DELIVERY_CH}:${DELIVERY_TO}`);
  return msgs.length;
}

// ── Main ───────────────────────────────────────────────────────────────────

try {
  const db = getDb();

  if (!WATCH_MODE) {
    // ── Normal mode: drain once and exit ──────────────────────────────────
    await drainMessages(db, deliverMessage);
    process.exit(0);
  }

  // ── Watch/daemon mode ─────────────────────────────────────────────────
  console.log('[inbox-consumer] starting in watch mode');

  // Drain once on startup
  await drainMessages(db, deliverMessage);

  console.log(`[inbox-consumer] watching scheduler.db-wal for changes...`);

  // Debounce state
  let debounceTimer = null;
  let draining = false;

  async function debouncedDrain() {
    if (draining) return; // skip if already running
    draining = true;
    try {
      await drainMessages(db, deliverMessage);
    } catch (err) {
      process.stderr.write(`[inbox-consumer] drain error: ${err.stack || err.message}\n`);
    } finally {
      draining = false;
    }
  }

  // Watch the scheduler directory for WAL file changes.
  // macOS kqueue doesn't reliably fire on direct file watches for SQLite WAL
  // (the file descriptor stays open), but directory watches do fire correctly.
  const watcher = watch(SCHEDULER_DIR, (eventType, filename) => {
    if (filename !== 'scheduler.db-wal') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      debouncedDrain();
    }, 200);
  });

  watcher.on('error', (err) => {
    process.stderr.write(`[inbox-consumer] watcher error: ${err.message}\n`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`[inbox-consumer] received ${signal}, shutting down`);
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Keep the process alive (fs.watch keeps the event loop running)

} catch (err) {
  process.stderr.write(`[inbox-consumer] ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
}
