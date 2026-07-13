#!/usr/bin/env node
/**
 * inbox-consumer.mjs
 *
 * Drains the durable external delivery outbox and then consumes legacy externally
 * routed message rows. Internal agent messages are never delivered by this script.
 *
 * Usage:
 *   node scripts/inbox-consumer.mjs [--to <legacy-fallback-target>] [--channel telegram] [--agent main] [--limit 50]
 *   node scripts/inbox-consumer.mjs --watch
 *
 * Env fallbacks:
 *   INBOX_DELIVERY_TO (optional legacy fallback)
 *   INBOX_DELIVERY_CHANNEL (default: telegram)
 *   INBOX_AGENT (default: main)
 *   INBOX_LIMIT (default: 50)
 */

import { dirname, basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { watch } from 'fs';
import { hostname } from 'os';
import { getDb } from '../db.js';
import { resolveSchedulerDbPath } from '../paths.js';
import { deliverMessage, invokeGatewayTool } from '../gateway.js';
import { ackMessage, recordMessageAttempt } from '../messages.js';
import {
  claimDueDeliveries,
  markDeliveryDelivered,
  renewDeliveryClaim,
  retryDelivery,
} from '../delivery-outbox.js';
import { materializeDeliveryAttachment } from '../attachment-store.js';

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
export function formatMessageForDelivery(msg, { brand = 'Scheduler' } = {}) {
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
  const truncateUtf8 = (value, maxBytes) => {
    let result = '';
    let bytes = 0;
    for (const character of String(value || '')) {
      const characterBytes = Buffer.byteLength(character, 'utf8');
      if (bytes + characterBytes > maxBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  };
  const boundedBrand = truncateUtf8(brand || 'Scheduler', 128) || 'Scheduler';
  const subject = truncateUtf8(msg.subject || 'Notification', 256) || 'Notification';
  const header = `${boundedBrand} | ${subject} | ${age}`;

  return `${header}\n\n${body}`;
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

export function selectPendingMessages(db, agentId, limit) {
  // Compatibility path for rows created before delivery_outbox existed. Route
  // fields are mandatory here so internal agent messages remain agent context.
  return db.prepare(`
    SELECT id, from_agent, to_agent, subject, body, kind, created_at, priority,
           delivery_to, channel
    FROM messages
    WHERE (to_agent = ? OR to_agent = 'broadcast')
      AND status = 'pending'
      AND (channel IS NOT NULL OR delivery_to IS NOT NULL)
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

function gatewayFailure(response) {
  if (response == null || typeof response !== 'object') return 'empty response';
  if (response.ok === false) return String(response.error || 'gateway delivery failed');
  if (response.result?.ok === false) return String(response.result.error || 'gateway delivery failed');
  if (response.result?.isError === true) {
    const detail = response.result.error || response.result.content || 'gateway delivery failed';
    return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500);
  }
  return null;
}

async function deliverPersistedAttachment(delivery, attachment, invokeTool = invokeGatewayTool, db = null) {
  const mediaPath = materializeDeliveryAttachment(attachment, db ? { db } : {});
  const response = await invokeTool('message', {
    action: 'send',
    channel: delivery.channel,
    target: delivery.target,
    message: attachment.name,
    media: mediaPath,
  });
  const failure = gatewayFailure(response);
  if (failure) throw new Error(`Gateway message failed for attachment '${attachment.name}': ${failure}`);
  return response;
}

function startDeliveryClaimHeartbeat(delivery, opts = {}) {
  const leaseMs = parsePositiveInt(opts.leaseMs, 120_000);
  const defaultIntervalMs = Math.max(100, Math.floor(leaseMs / 3));
  const intervalMs = parsePositiveInt(opts.heartbeatIntervalMs, defaultIntervalMs);
  if (intervalMs >= leaseMs) {
    throw new Error('delivery claim heartbeat interval must be shorter than the claim lease');
  }

  let stopped = false;
  let definitiveLoss = null;
  let transientError = null;
  const renew = () => {
    if (stopped || definitiveLoss) return false;
    try {
      const outcome = renewDeliveryClaim(delivery.id, delivery.claim_token, {
        db: opts.db,
        leaseMs,
      });
      if (!outcome?.renewed) {
        definitiveLoss = new Error(`Delivery ${delivery.id} lost its claim during processing`);
        return false;
      }
      transientError = null;
      return true;
    } catch (err) {
      transientError = err;
      return false;
    }
  };
  const assertOwned = () => {
    if (stopped) throw new Error(`Delivery ${delivery.id} claim heartbeat is stopped`);
    if (definitiveLoss) throw definitiveLoss;
    if (!renew()) {
      if (definitiveLoss) throw definitiveLoss;
      throw new Error(`Delivery ${delivery.id} claim heartbeat failed: ${transientError?.message || 'unknown error'}`, {
        cause: transientError || undefined,
      });
    }
  };

  assertOwned();
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();
  return {
    assertOwned,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function drainDeliveryOutbox(db, opts) {
  const {
    limit,
    brand,
    owner = `inbox-consumer:${hostname()}:${process.pid}`,
    leaseMs = 120_000,
    interDeliveryDelayMs = 1500,
    deliverText = deliverMessage,
    invokeTool = invokeGatewayTool,
    heartbeatIntervalMs,
  } = opts;
  const deliveryLimit = parsePositiveInt(limit, 50);
  let delivered = 0;
  let attempted = 0;
  const deliveryErrors = [];

  while (attempted < deliveryLimit) {
    const delivery = claimDueDeliveries({ db, owner, limit: 1, leaseMs })[0];
    if (!delivery) break;
    attempted += 1;
    let heartbeat = null;
    try {
      heartbeat = startDeliveryClaimHeartbeat(delivery, {
        db,
        leaseMs,
        heartbeatIntervalMs,
      });
      if (attempted > 1 && interDeliveryDelayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, interDeliveryDelayMs));
      }
      heartbeat.assertOwned();
      const text = formatMessageForDelivery({
        body: delivery.body,
        subject: delivery.job_name || 'Notification',
        created_at: delivery.created_at,
      }, { brand });
      if (text) await deliverText(delivery.channel, delivery.target, text);
      heartbeat.assertOwned();

      for (const attachment of delivery.attachments || []) {
        await deliverPersistedAttachment(delivery, attachment, invokeTool, db);
        heartbeat.assertOwned();
      }

      heartbeat.assertOwned();
      heartbeat.stop();
      const completed = markDeliveryDelivered(delivery.id, delivery.claim_token, { db });
      if (!completed?.transitioned) {
        throw new Error(`Delivery ${delivery.id} lost its claim before completion`);
      }
      delivered += 1;
    } catch (err) {
      heartbeat?.stop();
      const outcome = retryDelivery(delivery.id, delivery.claim_token, err, { db });
      if (outcome?.reason !== 'claim_mismatch') {
        deliveryErrors.push(err);
      } else {
        deliveryErrors.push(new Error(`${err.message}; delivery claim no longer belongs to this consumer`));
      }
    } finally {
      heartbeat?.stop();
    }
  }

  return { delivered, attempted, errors: deliveryErrors };
}

export async function drainLegacyMessages(db, opts) {
  const {
    to,
    channel,
    agentId,
    limit,
    brand,
    interDeliveryDelayMs = 1500,
    deliverText = deliverMessage,
  } = opts;
  const msgs = selectPendingMessages(db, agentId, limit);
  let delivered = 0;
  const deliveryErrors = [];

  for (const msg of msgs) {
    const msgTarget = msg.delivery_to || to;
    const msgChannel = msg.channel || channel;
    const text = formatMessageForDelivery(msg, { brand });

    if (!msgTarget || !msgChannel) {
      const error = new Error(`Legacy message ${msg.id} has no complete external delivery route`);
      recordMessageAttempt(msg.id, {
        ok: false,
        actor: 'inbox-consumer',
        error: error.message,
      });
      deliveryErrors.push(error);
      continue;
    }

    if (!text) {
      ackMessage(msg.id, 'inbox-consumer', 'Suppressed (empty after sentinel strip)');
      delivered += 1;
      continue;
    }

    try {
      if (delivered > 0 && interDeliveryDelayMs > 0) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, interDeliveryDelayMs));
      }
      await deliverText(msgChannel, msgTarget, text);
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

  return { delivered, attempted: msgs.length, errors: deliveryErrors };
}

export async function drainOnce(db, opts) {
  const outbox = await drainDeliveryOutbox(db, opts);
  const legacy = await drainLegacyMessages(db, opts);
  const delivered = outbox.delivered + legacy.delivered;
  const deliveryErrors = [...outbox.errors, ...legacy.errors];

  if (delivered > 0) {
    process.stdout.write(`[inbox-consumer] delivered ${delivered} item(s) (${outbox.delivered} outbox, ${legacy.delivered} legacy)\n`);
  }
  if (deliveryErrors.length > 0) {
    throw new Error(`Delivery failed for ${deliveryErrors.length} item(s): ${deliveryErrors.map(error => error.message).join('; ')}`);
  }
  return delivered;
}

export async function main(argv = process.argv.slice(2)) {
const args = parseArgs(argv);
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

  // Periodic poll fallback — catches messages that slip through WAL checkpoints.
  // When SQLite checkpoints the WAL (merges it back into the main DB), the WAL
  // file is reset and the watcher may miss a subsequent write. This belt-and-
  // suspenders poll ensures delivery within at most INBOX_POLL_INTERVAL_MS.
  const pollIntervalMs = parsePositiveInt(process.env.INBOX_POLL_INTERVAL_MS, 60000);
  const pollInterval = setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      const n = await drainOnce(db, { to: deliveryTo, channel, agentId, limit, brand });
      if (n > 0) {
        process.stdout.write(`[inbox-consumer] poll fallback delivered ${n} pending message(s)\n`);
      }
    } catch (err) {
      process.stderr.write(`[inbox-consumer] poll fallback error: ${err.message}\n`);
    } finally {
      draining = false;
    }
  }, pollIntervalMs);
  process.stdout.write(`[inbox-consumer] poll fallback enabled (interval=${pollIntervalMs}ms)\n`);

  const shutdown = (signal) => {
    if (timer) clearTimeout(timer);
    clearInterval(pollInterval);
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
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) await main();
