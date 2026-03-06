/**
 * dispatch-hooks.mjs — Lifecycle event emitter
 *
 * Fires structured dispatch events to:
 *   1. Loki (always — structured log stream for Grafana observability)
 *   2. DISPATCH_WEBHOOK_URL (optional — external systems, dashboards, etc.)
 *
 * All calls are best-effort and non-blocking. A hook failure never
 * prevents dispatch from completing.
 *
 * Event types:
 *   dispatch.started   — job created + queued in scheduler
 *   dispatch.finished  — run completed (ok or error)
 *   dispatch.stuck     — stuck run detected by detector
 *   dispatch.cancelled — run manually cancelled
 */

import { hostname } from 'os';

const LOKI_URL     = process.env.LOKI_PUSH_URL     || '';
const WEBHOOK_URL  = process.env.DISPATCH_WEBHOOK_URL || '';
// Backward-compat: CHILISAUS_HOST from older deployments is still honored.
const HOST         = process.env.DISPATCH_HOST
  || process.env.CHILISAUS_HOST
  || hostname()
  || 'rh-bot.lan';
const TIMEOUT_MS   = 3000;

// ── Loki push ───────────────────────────────────────────────

async function lokiPush(event, payload) {
  if (!LOKI_URL) return; // not configured — skip silently
  const ts     = String(Date.now() * 1_000_000); // nanoseconds
  const logLine = JSON.stringify({ event, host: HOST, ...payload });

  const body = JSON.stringify({
    streams: [{
      stream: { service_name: 'dispatch', host: HOST, event },
      values: [[ts, logLine]],
    }],
  });

  await fetch(LOKI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ── Webhook push ────────────────────────────────────────────

async function webhookPush(event, payload) {
  if (!WEBHOOK_URL) return;
  await fetch(WEBHOOK_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event, ts: Date.now(), host: HOST, ...payload }),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ── Public API ───────────────────────────────────────────────

/**
 * Emit a dispatch lifecycle event. Best-effort — never throws.
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

/** Convenience: dispatch.finished */
export function onFinished(opts) {
  return emitEvent('dispatch.finished', {
    label:       opts.label,
    job_id:      opts.job_id,
    run_id:      opts.run_id,
    agent:       opts.agent,
    status:      opts.status,        // ok | error | timeout | cancelled
    duration_ms: opts.duration_ms || null,
    error:       opts.error || null,
    session_key: opts.session_key || null,
  });
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
