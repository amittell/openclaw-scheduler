/**
 * dispatch-hooks.mjs -- Lifecycle event emitter
 *
 * Fires structured dispatch events to:
 *   1. Loki (always -- structured log stream for Grafana observability)
 *   2. DISPATCH_WEBHOOK_URL (optional -- external systems, dashboards, etc.)
 *   3. Gateway post office (optional -- when opts.deliverTo is set)
 *
 * All calls are best-effort and non-blocking. A hook failure never
 * prevents dispatch from completing.
 *
 * Event types:
 *   dispatch.started   -- job created + queued in scheduler
 *   dispatch.finished  -- run completed (ok or error)
 *   dispatch.stuck     -- stuck run detected by detector
 *   dispatch.cancelled -- run manually cancelled
 */

import { hostname } from 'os';
import { resolveCompletionDelivery } from './completion.mjs';
import { getDb } from '../db.js';
import { sendMessage } from '../messages.js';

const LOKI_URL     = process.env.LOKI_PUSH_URL     || '';
const WEBHOOK_URL  = process.env.DISPATCH_WEBHOOK_URL || '';
const HOST         = process.env.DISPATCH_HOST
  || hostname()
  || 'unknown-host';
const TIMEOUT_MS   = 3000;

function schedulerNow() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function upsertCompletionDebt({
  label,
  sessionKey = null,
  status,
  openReason = null,
  closeReason = null,
  noReply = 0,
  metadata = null,
  finalReportedAt = null,
  lastVisibleUpdateAt = null,
}) {
  if (!label) return null;
  try {
    const db = getDb();
    const now = schedulerNow();
    const metadataJson = safeJson(metadata);

    db.prepare(`
      INSERT INTO completion_debts (
        task_label,
        session_key,
        source,
        status,
        open_reason,
        close_reason,
        opened_at,
        closed_at,
        last_visible_update_at,
        final_reported_at,
        no_reply,
        metadata,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'dispatch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_label) DO UPDATE SET
        session_key = COALESCE(excluded.session_key, completion_debts.session_key),
        source = 'dispatch',
        status = excluded.status,
        open_reason = COALESCE(excluded.open_reason, completion_debts.open_reason),
        close_reason = COALESCE(excluded.close_reason, completion_debts.close_reason),
        opened_at = CASE
          WHEN excluded.status = 'open' THEN COALESCE(completion_debts.opened_at, excluded.opened_at)
          ELSE completion_debts.opened_at
        END,
        closed_at = CASE
          WHEN excluded.status = 'closed' THEN excluded.closed_at
          ELSE completion_debts.closed_at
        END,
        last_visible_update_at = COALESCE(excluded.last_visible_update_at, completion_debts.last_visible_update_at),
        final_reported_at = COALESCE(excluded.final_reported_at, completion_debts.final_reported_at),
        no_reply = excluded.no_reply,
        metadata = COALESCE(excluded.metadata, completion_debts.metadata),
        updated_at = excluded.updated_at
    `).run(
      label,
      sessionKey,
      status,
      openReason,
      closeReason,
      status === 'open' ? now : null,
      status === 'closed' ? now : null,
      lastVisibleUpdateAt,
      finalReportedAt,
      Number(Boolean(noReply)),
      metadataJson,
      now,
      now,
    );

    return db.prepare('SELECT * FROM completion_debts WHERE task_label = ?').get(label);
  } catch (err) {
    process.stderr.write(`[dispatch-hooks] completion debt tracking skipped for ${label}: ${err.message}\n`);
    return null;
  }
}

export function recordCompletionDeliveryDebt({
  label,
  sessionKey = null,
  openReason = 'no-clean-user-facing-completion',
  noReply = false,
  metadata = null,
} = {}) {
  return upsertCompletionDebt({
    label,
    sessionKey,
    status: 'open',
    openReason,
    noReply,
    metadata,
  });
}

export function recordCompletionDelivered({
  label,
  sessionKey = null,
  closeReason = 'confirmed-completion-delivered',
  metadata = null,
} = {}) {
  const now = schedulerNow();
  return upsertCompletionDebt({
    label,
    sessionKey,
    status: 'closed',
    closeReason,
    metadata,
    finalReportedAt: now,
    lastVisibleUpdateAt: now,
  });
}

// Clear any prior-run completion debt so a re-dispatched label starts with a
// clean delivery claim. The debt row is keyed by task_label and durable across
// runs; without this reset a stale 'closed' row from an earlier run would make
// the next run's delivery claim fail and silently suppress its announce.
export function resetCompletionDeliveryClaim({ label } = {}) {
  if (!label) return;
  try {
    getDb().prepare('DELETE FROM completion_debts WHERE task_label = ?').run(label);
  } catch (err) {
    process.stderr.write(`[dispatch-hooks] completion debt reset skipped for ${label}: ${err.message}\n`);
  }
}

const CLAIM_STALE_WINDOW = "-2 minutes";

// Atomic single-writer delivery claim. The done-path (cmdDone) and the delivery
// watcher can both observe a completed label and try to announce it; SQLite
// serializes writers, so exactly one caller transitions the debt row into
// 'delivering' and earns the right to send. A row already 'closed' (delivered)
// or freshly 'delivering' (send in flight) blocks the claim. A 'delivering' row
// older than the stale window is reclaimable so a crashed sender cannot wedge
// delivery forever. Returns true when this caller owns delivery.
export function claimCompletionDelivery({ label, sessionKey = null } = {}) {
  if (!label) return true;
  try {
    const db = getDb();
    const now = schedulerNow();
    const res = db.prepare(`
      INSERT INTO completion_debts (task_label, session_key, source, status, opened_at, created_at, updated_at)
      VALUES (?, ?, 'dispatch', 'delivering', ?, ?, ?)
      ON CONFLICT(task_label) DO UPDATE SET
        status = 'delivering',
        session_key = COALESCE(excluded.session_key, completion_debts.session_key),
        opened_at = COALESCE(completion_debts.opened_at, excluded.opened_at),
        updated_at = excluded.updated_at
      WHERE completion_debts.status != 'closed'
        AND (completion_debts.status != 'delivering'
             OR completion_debts.updated_at <= datetime('now', '${CLAIM_STALE_WINDOW}'))
    `).run(label, sessionKey, now, now, now);
    return res.changes > 0;
  } catch (err) {
    // Missing table / DB error: preserve prior best-effort delivery rather than
    // silently dropping the user's completion announce.
    process.stderr.write(`[dispatch-hooks] completion delivery claim skipped for ${label}: ${err.message}\n`);
    return true;
  }
}

// -- Loki push -----------------------------------------------

async function lokiPush(event, payload) {
  if (!LOKI_URL) return; // not configured -- skip silently
  const ts     = String(Date.now() * 1_000_000); // nanoseconds
  const logLine = JSON.stringify({ event, host: HOST, ...payload });

  const body = JSON.stringify({
    streams: [{
      stream: { service_name: 'dispatch', host: HOST, event },
      values: [[ts, logLine]],
    }],
  });

  const res = await fetch(LOKI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

// -- Webhook push --------------------------------------------

async function webhookPush(event, payload) {
  if (!WEBHOOK_URL) return;
  const res = await fetch(WEBHOOK_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event, ts: Date.now(), host: HOST, ...payload }),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

// -- Post-office notification ---------------------------------

/**
 * Enqueue a completion notification into the messages queue (post office).
 * The Inbox Consumer drains pending messages and delivers to Telegram.
 * Used for unregistered-label done signals where no watcher is waiting.
 *
 * @param {string} label           - Dispatch label
 * @param {string} summary         - Legacy fallback summary
 * @param {string} deliverTo       - Target chat/user ID (stored for reference)
 * @param {string} [deliveryChannel='telegram'] - Channel to deliver via (stored for reference)
 * @param {object} [completion=null] - Structured completion payload
 */
async function gatewayNotify(label, summary, deliverTo, deliveryChannel = 'telegram', completion = null) {
  return enqueueCompletionNotification({
    label,
    summary,
    deliverTo,
    deliveryChannel,
    completion,
  });
}

export async function enqueueCompletionNotification({
  label,
  summary = null,
  deliverTo,
  deliveryChannel = 'telegram',
  completion = null,
  sessionKey = null,
  origin = null,
  metadata = null,
} = {}) {
  const delivery = resolveCompletionDelivery({
    completion,
    fallbackSummary: summary,
  });
  const bodyText = delivery.deliveryText || null;
  const baseMetadata = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    delivery_channel: deliveryChannel,
    delivery_to: deliverTo,
    origin: origin || null,
    delivery_source: delivery.source || null,
  };

  if (!bodyText) {
    recordCompletionDeliveryDebt({
      label,
      sessionKey,
      openReason: 'no-clean-user-facing-completion',
      noReply: true,
      metadata: baseMetadata,
    });
    process.stderr.write(`[dispatch-hooks] completion delivery suppressed for ${label}: no meaningful structured summary\n`);
    return { ok: false, delivered: false, suppressed: true, reason: 'no-clean-user-facing-completion' };
  }

  if (!claimCompletionDelivery({ label, sessionKey })) {
    // The watcher (or a prior done-path enqueue) already owns this completion's
    // delivery. Skip sending so the user gets exactly one announce.
    process.stderr.write(`[dispatch-hooks] completion delivery deduped for ${label}: already claimed by another path\n`);
    return { ok: false, delivered: false, deduped: true, reason: 'already-claimed' };
  }

  try {
    const body = `✅ [${label}] done\n\n${bodyText}`;
    const message = await sendMessage({
      from_agent:  'dispatch',
      to_agent:    'main',
      kind:        'result',
      subject:     label,
      body,
      channel:     deliveryChannel,
      delivery_to: deliverTo,
    });
    recordCompletionDelivered({
      label,
      sessionKey,
      metadata: {
        ...baseMetadata,
        message_id: message?.id || null,
      },
    });
    return { ok: true, delivered: true, bodyText, messageId: message?.id || null };
  } catch (e) {
    recordCompletionDeliveryDebt({
      label,
      sessionKey,
      openReason: 'completion-enqueue-failed',
      noReply: false,
      metadata: {
        ...baseMetadata,
        error: e.message,
      },
    });
    process.stderr.write(`[dispatch-hooks] post-office enqueue failed for ${label}: ${e.message}\n`);
    return { ok: false, delivered: false, reason: 'completion-enqueue-failed', error: e.message };
  }
}

// -- Public API -----------------------------------------------

/**
 * Emit a dispatch lifecycle event. Best-effort -- never throws.
 */
export async function emitEvent(event, payload = {}) {
  const tasks = [
    lokiPush(event, payload).catch(e =>
      process.stderr.write(`[dispatch-hooks] loki failed (${event}): ${e.message}\n`)
    ),
    WEBHOOK_URL
      ? webhookPush(event, payload).catch(e =>
          process.stderr.write(`[dispatch-hooks] webhook failed (${event}): ${e.message}\n`)
        )
      : Promise.resolve(),
  ];
  await Promise.allSettled(tasks);
}

/** Convenience: dispatch.started */
export function onStarted(opts) {
  return emitEvent('dispatch.started', {
    label:      opts.label,
    job_id:     opts.job_id,
    run_id:     opts.run_id,
    agent:      opts.agent,
    mode:       opts.mode,
    session_key: opts.session_key || null,
  });
}

/**
 * Convenience: dispatch.finished
 *
 * Fires to Loki + webhook (always) and optionally to the gateway post office.
 *
 * Extended opts:
 *   deliverTo       {string}  -- If set, send a completion notification via gateway
 *   deliveryChannel {string}  -- Channel for delivery (default: 'telegram')
 *   summary         {string}  -- Legacy fallback summary for notification formatting
 *   completion      {object}  -- Structured completion payload
 */
export async function onFinished(opts) {
  const tasks = [
    emitEvent('dispatch.finished', {
      label:       opts.label,
      job_id:      opts.job_id,
      run_id:      opts.run_id,
      agent:       opts.agent,
      status:      opts.status,        // ok | error | timeout | cancelled
      duration_ms: opts.duration_ms || null,
      error:       opts.error || null,
      session_key: opts.session_key || null,
    }),
  ];

  // Optional gateway post-office delivery (used for unregistered-label done signals)
  if (opts.deliverTo) {
    const summary = opts.summary || opts.status || 'completed';
    tasks.push(
      gatewayNotify(opts.label, summary, opts.deliverTo, opts.deliveryChannel || 'telegram', opts.completion || null)
    );
  }

  return Promise.allSettled(tasks);
}

/** Convenience: dispatch.stuck */
export function onStuck(stuckRuns) {
  return emitEvent('dispatch.stuck', {
    stuck_count: stuckRuns.length,
    runs: stuckRuns.map(r => ({
      run_id:     r.id,
      job_name:   r.job_name,
      started_at: r.started_at,
      age_s:      r.age_s,
    })),
  });
}
