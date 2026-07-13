/**
 * dispatch-hooks.mjs -- Lifecycle event emitter
 *
 * Fires structured dispatch events to:
 *   1. Loki (always -- structured log stream for Grafana observability)
 *   2. DISPATCH_WEBHOOK_URL (optional -- external systems, dashboards, etc.)
 *   3. Durable delivery outbox (optional -- when opts.deliverTo is set)
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

import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { resolveCompletionDelivery } from './completion.mjs';
import { getDb } from '../db.js';
import { enqueueMultipartDelivery } from '../delivery-outbox.js';

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

const COMPLETION_SCOPE_METADATA_KEY = '_completion_delivery';
const COMPLETION_SCOPE_JSON_PATH = '$._completion_delivery.scope_key';

function hasCompositeCompletionDebtSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(completion_debts)').all().map(column => column.name));
  return columns.has('id') && columns.has('delivery_scope');
}

export function buildCompletionDeliveryScope({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
} = {}) {
  if (deliveryScope != null) {
    if (typeof deliveryScope !== 'string' || !deliveryScope.trim()) {
      throw new Error('deliveryScope must be a non-empty string when provided');
    }
    return deliveryScope.trim();
  }
  if (typeof label !== 'string' || !label.trim()) throw new Error('label is required');
  const identity = JSON.stringify({
    label: label.trim(),
    session_key: sessionKey || null,
    run_id: runId || null,
  });
  return `v1:${createHash('sha256').update(identity).digest('hex')}`;
}

function metadataWithCompletionScope(metadata, { scope, runId }) {
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    [COMPLETION_SCOPE_METADATA_KEY]: {
      scope_key: scope,
      run_id: runId || null,
    },
  };
}

function completionDebtContext({ label, sessionKey = null, runId = null, deliveryScope = null, metadata = null }) {
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  if (!normalizedLabel) throw new Error('label is required');
  const scope = buildCompletionDeliveryScope({
    label: normalizedLabel,
    sessionKey,
    runId,
    deliveryScope,
  });
  return {
    label: normalizedLabel,
    sessionKey: sessionKey || null,
    runId: runId || null,
    scope,
    metadata: metadataWithCompletionScope(metadata, { scope, runId }),
  };
}

function upsertCompletionDebt({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
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
    const context = completionDebtContext({ label, sessionKey, runId, deliveryScope, metadata });
    const metadataJson = safeJson(context.metadata);
    const values = [
      context.label,
      context.sessionKey,
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
    ];

    if (hasCompositeCompletionDebtSchema(db)) {
      db.prepare(`
        INSERT INTO completion_debts (
          id, task_label, delivery_scope, session_key, source, status,
          open_reason, close_reason, opened_at, closed_at,
          last_visible_update_at, final_reported_at, no_reply, metadata,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'dispatch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_label, delivery_scope) DO UPDATE SET
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
      `).run(randomUUID(), context.label, context.scope, ...values.slice(1));
      return db.prepare(
        'SELECT * FROM completion_debts WHERE task_label = ? AND delivery_scope = ?'
      ).get(context.label, context.scope) || null;
    }

    const result = db.prepare(`
      INSERT INTO completion_debts (
        task_label, session_key, source, status, open_reason, close_reason,
        opened_at, closed_at, last_visible_update_at, final_reported_at,
        no_reply, metadata, created_at, updated_at
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
      WHERE json_extract(completion_debts.metadata, '${COMPLETION_SCOPE_JSON_PATH}') = ?
         OR (json_extract(completion_debts.metadata, '${COMPLETION_SCOPE_JSON_PATH}') IS NULL
             AND completion_debts.session_key IS excluded.session_key)
    `).run(...values, context.scope);
    if (result.changes === 0) return null;
    return db.prepare('SELECT * FROM completion_debts WHERE task_label = ?').get(context.label) || null;
  } catch (err) {
    process.stderr.write(`[dispatch-hooks] completion debt tracking failed for ${label}: ${err.message}\n`);
    return null;
  }
}

export function recordCompletionDeliveryDebt({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
  openReason = 'no-clean-user-facing-completion',
  noReply = false,
  metadata = null,
} = {}) {
  return upsertCompletionDebt({
    label,
    sessionKey,
    runId,
    deliveryScope,
    status: 'open',
    openReason,
    noReply,
    metadata,
  });
}

export function recordCompletionDelivered({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
  closeReason = 'confirmed-completion-delivered',
  metadata = null,
} = {}) {
  const now = schedulerNow();
  return upsertCompletionDebt({
    label,
    sessionKey,
    runId,
    deliveryScope,
    status: 'closed',
    closeReason,
    metadata,
    finalReportedAt: now,
    lastVisibleUpdateAt: now,
  });
}

export function recordCompletionEnqueued({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
  metadata = null,
} = {}) {
  return upsertCompletionDebt({
    label,
    sessionKey,
    runId,
    deliveryScope,
    status: 'delivering',
    metadata,
  });
}

// Reserve the new run's scope before its watcher can race a stale watcher from
// an older use of the same label. Legacy schemas can retain only one scope per
// label; the reservation still makes stale-run claims fail closed atomically.
export function resetCompletionDeliveryClaim({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
} = {}) {
  if (!label) return;
  try {
    const db = getDb();
    const hasIdentity = Boolean(sessionKey || runId || deliveryScope);
    if (!hasIdentity) {
      db.prepare('DELETE FROM completion_debts WHERE task_label = ?').run(label);
      return;
    }

    const context = completionDebtContext({ label, sessionKey, runId, deliveryScope });
    const now = schedulerNow();
    const metadataJson = safeJson(context.metadata);
    if (hasCompositeCompletionDebtSchema(db)) {
      db.prepare(`
        DELETE FROM completion_debts
        WHERE task_label = ?
          AND json_extract(metadata, '$._completion_delivery.migrated_legacy_unscoped') = 1
      `).run(context.label);
      db.prepare(`
        INSERT INTO completion_debts (
          id, task_label, delivery_scope, session_key, source, status,
          opened_at, closed_at, final_reported_at, no_reply, metadata,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'dispatch', 'tracking', NULL, NULL, NULL, 0, ?, ?, ?)
        ON CONFLICT(task_label, delivery_scope) DO UPDATE SET
          session_key = excluded.session_key,
          source = 'dispatch',
          status = 'tracking',
          open_reason = NULL,
          close_reason = NULL,
          opened_at = NULL,
          closed_at = NULL,
          final_reported_at = NULL,
          no_reply = 0,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(randomUUID(), context.label, context.scope, context.sessionKey, metadataJson, now, now);
      return;
    }

    db.prepare(`
      INSERT INTO completion_debts (
        task_label, session_key, source, status, opened_at, closed_at,
        final_reported_at, no_reply, metadata, created_at, updated_at
      )
      VALUES (?, ?, 'dispatch', 'tracking', NULL, NULL, NULL, 0, ?, ?, ?)
      ON CONFLICT(task_label) DO UPDATE SET
        session_key = excluded.session_key,
        source = 'dispatch',
        status = 'tracking',
        open_reason = NULL,
        close_reason = NULL,
        opened_at = NULL,
        closed_at = NULL,
        final_reported_at = NULL,
        no_reply = 0,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(context.label, context.sessionKey, metadataJson, now, now);
  } catch (err) {
    process.stderr.write(`[dispatch-hooks] completion debt reservation failed for ${label}: ${err.message}\n`);
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
export function claimCompletionDelivery({
  label,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
} = {}) {
  if (!label) throw new Error('label is required');
  try {
    const db = getDb();
    const now = schedulerNow();
    const context = completionDebtContext({ label, sessionKey, runId, deliveryScope });
    const metadataJson = safeJson(context.metadata);
    if (hasCompositeCompletionDebtSchema(db)) {
      const migratedTerminal = db.prepare(`
        SELECT 1
        FROM completion_debts
        WHERE task_label = ?
          AND status IN ('delivering', 'closed')
          AND json_extract(metadata, '$._completion_delivery.migrated_legacy_unscoped') = 1
          AND (session_key IS NULL OR session_key IS ?)
        LIMIT 1
      `).get(context.label, context.sessionKey);
      if (migratedTerminal) return false;
    }
    const res = hasCompositeCompletionDebtSchema(db)
      ? db.prepare(`
          INSERT INTO completion_debts (
            id, task_label, delivery_scope, session_key, source, status,
            opened_at, metadata, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'dispatch', 'delivering', ?, ?, ?, ?)
          ON CONFLICT(task_label, delivery_scope) DO UPDATE SET
            status = 'delivering',
            session_key = COALESCE(excluded.session_key, completion_debts.session_key),
            opened_at = COALESCE(completion_debts.opened_at, excluded.opened_at),
            metadata = COALESCE(excluded.metadata, completion_debts.metadata),
            updated_at = excluded.updated_at
          WHERE completion_debts.status != 'closed'
            AND (completion_debts.status != 'delivering'
                 OR completion_debts.updated_at <= datetime('now', '${CLAIM_STALE_WINDOW}'))
        `).run(
          randomUUID(), context.label, context.scope, context.sessionKey,
          now, metadataJson, now, now,
        )
      : db.prepare(`
          INSERT INTO completion_debts (
            task_label, session_key, source, status, opened_at, metadata,
            created_at, updated_at
          )
          VALUES (?, ?, 'dispatch', 'delivering', ?, ?, ?, ?)
          ON CONFLICT(task_label) DO UPDATE SET
            status = 'delivering',
            session_key = COALESCE(excluded.session_key, completion_debts.session_key),
            opened_at = COALESCE(completion_debts.opened_at, excluded.opened_at),
            metadata = COALESCE(excluded.metadata, completion_debts.metadata),
            updated_at = excluded.updated_at
          WHERE (json_extract(completion_debts.metadata, '${COMPLETION_SCOPE_JSON_PATH}') = ?
                 OR (json_extract(completion_debts.metadata, '${COMPLETION_SCOPE_JSON_PATH}') IS NULL
                     AND completion_debts.session_key IS excluded.session_key))
            AND completion_debts.status != 'closed'
            AND (completion_debts.status != 'delivering'
                 OR completion_debts.updated_at <= datetime('now', '${CLAIM_STALE_WINDOW}'))
        `).run(context.label, context.sessionKey, now, metadataJson, now, now, context.scope);
    return res.changes > 0;
  } catch (err) {
    const claimError = new Error(
      `completion delivery claim unavailable for ${label}: ${err.message}`,
      { cause: err },
    );
    claimError.code = 'COMPLETION_CLAIM_UNAVAILABLE';
    process.stderr.write(`[dispatch-hooks] ${claimError.message}\n`);
    throw claimError;
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
 * Enqueue a completion notification into the durable delivery outbox.
 * The Inbox Consumer drains pending outbox rows and delivers externally.
 * Used for unregistered-label done signals where no watcher is waiting.
 *
 * @param {string} label           - Dispatch label
 * @param {string} summary         - Legacy fallback summary
 * @param {string} deliverTo       - Target chat/user ID (stored for reference)
 * @param {string} [deliveryChannel='telegram'] - Channel to deliver via (stored for reference)
 * @param {object} [completion=null] - Structured completion payload
 */
async function gatewayNotify(
  label,
  summary,
  deliverTo,
  deliveryChannel = 'telegram',
  completion = null,
  deliveryContext = {},
) {
  return enqueueCompletionNotification({
    label,
    summary,
    deliverTo,
    deliveryChannel,
    completion,
    ...deliveryContext,
  });
}

export function enqueueCompletionNotification({
  label,
  summary = null,
  deliverTo,
  deliveryChannel = 'telegram',
  completion = null,
  sessionKey = null,
  runId = null,
  deliveryScope = null,
  resolvedDelivery = null,
  origin = null,
  metadata = null,
  maxPartBytes = null,
} = {}) {
  const delivery = resolvedDelivery && typeof resolvedDelivery === 'object'
    ? resolvedDelivery
    : resolveCompletionDelivery({ completion, fallbackSummary: summary });
  const bodyText = delivery.deliveryText || null;
  const scope = buildCompletionDeliveryScope({ label, sessionKey, runId, deliveryScope });
  const baseMetadata = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    delivery_channel: deliveryChannel,
    delivery_to: deliverTo,
    origin: origin || null,
    delivery_source: delivery.source || null,
    delivery_scope: scope,
    run_id: runId || null,
  };

  if (!bodyText) {
    recordCompletionDeliveryDebt({
      label,
      sessionKey,
      runId,
      deliveryScope: scope,
      openReason: 'no-clean-user-facing-completion',
      noReply: true,
      metadata: baseMetadata,
    });
    process.stderr.write(`[dispatch-hooks] completion delivery suppressed for ${label}: no meaningful structured summary\n`);
    return { ok: false, delivered: false, suppressed: true, reason: 'no-clean-user-facing-completion' };
  }

  let ownsClaim;
  try {
    ownsClaim = claimCompletionDelivery({
      label,
      sessionKey,
      runId,
      deliveryScope: scope,
    });
  } catch (claimError) {
    recordCompletionDeliveryDebt({
      label,
      sessionKey,
      runId,
      deliveryScope: scope,
      openReason: 'completion-claim-unavailable',
      noReply: false,
      metadata: {
        ...baseMetadata,
        error: claimError.message,
      },
    });
    return {
      ok: false,
      delivered: false,
      reason: 'completion-claim-unavailable',
      error: claimError.message,
    };
  }

  if (!ownsClaim) {
    // The watcher (or a prior done-path enqueue) already owns this completion's
    // delivery. Skip sending so the user gets exactly one announce.
    process.stderr.write(`[dispatch-hooks] completion delivery deduped for ${label}: already claimed by another path\n`);
    return { ok: false, delivered: false, deduped: true, reason: 'already-claimed' };
  }

  try {
    const body = `✅ [${label}] done\n\n${bodyText}`;
    const routeHash = createHash('sha256')
      .update(JSON.stringify({ channel: deliveryChannel, target: deliverTo }))
      .digest('hex')
      .slice(0, 16);
    const idempotencyKey = `dispatch-completion:${scope}:${routeHash}`;
    const outbox = enqueueMultipartDelivery({
      body,
      channel:     deliveryChannel,
      target:      deliverTo,
      idempotencyKey,
      completionLabel: label,
      completionScope: scope,
      ...(maxPartBytes == null ? {} : { maxPartBytes }),
    });
    recordCompletionEnqueued({
      label,
      sessionKey,
      runId,
      deliveryScope: scope,
      metadata: {
        ...baseMetadata,
        outbox_ids: outbox.deliveries.map(item => item.id),
        part_count: outbox.partCount,
      },
    });
    return {
      ok: true,
      delivered: false,
      enqueued: true,
      deduped: outbox.deduped === true,
      bodyText,
      outboxId: outbox.id,
      outboxIds: outbox.deliveries.map(item => item.id),
      partCount: outbox.partCount,
      checkpointKey: outbox.checkpointKey,
    };
  } catch (e) {
    recordCompletionDeliveryDebt({
      label,
      sessionKey,
      runId,
      deliveryScope: scope,
      openReason: 'completion-enqueue-failed',
      noReply: false,
      metadata: {
        ...baseMetadata,
        error: e.message,
      },
    });
    process.stderr.write(`[dispatch-hooks] durable outbox enqueue failed for ${label}: ${e.message}\n`);
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
      gatewayNotify(
        opts.label,
        summary,
        opts.deliverTo,
        opts.deliveryChannel || 'telegram',
        opts.completion || null,
        {
          sessionKey: opts.session_key || null,
          runId: opts.run_id || null,
          origin: opts.origin || null,
        },
      )
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
