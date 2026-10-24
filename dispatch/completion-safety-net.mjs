#!/usr/bin/env node
/**
 * dispatch completion-delivery safety net.
 *
 * Scans labels.json for sessions in 'done' state whose completion was never
 * delivered (completionDeliveredAt is null) even though a delivery target was
 * recorded. This happens when the one-shot delivery watcher job
 * (`<brand>-deliver:<label>`) is deleted (delete_after_run), expires
 * (ttl_hours), or is lost on a scheduler/gateway restart: nothing else
 * re-delivers the completion, and the completion_debts row stays open forever.
 *
 * For each candidate the safety net:
 *   - skips if a live watcher run is active (no race with the normal path);
 *   - re-derives the completion from the transcript using the same
 *     conservative logic as `result` (only a clean terminal assistant reply
 *     or a recorded structured completion counts -- never a partial or
 *     diagnostic fragment);
 *   - re-enqueues via the durable outbox (enqueueCompletionNotification).
 *     Its idempotency key (`dispatch-completion:<scope>:<routeHash>`) makes
 *     repeated runs a no-op dedupe, so the script is safe to run every 10
 *     minutes.
 *   - on confirmed outbox delivery: closes the debt and stamps completionDeliveredAt.
 *
 * Bounds:
 *   - only labels updated within MAX_LABEL_AGE_MS (default 48h, matching
 *     deliver_watcher_ttl_hours) are recovered -- ancient terminal labels are
 *     not revived;
 *   - per-completion-scope retry cap (completionRetryCount, default 3) so a label that
 *     can never produce a clean completion is not hammered;
 *   - MIN_SINCE_LAST_ATTEMPT_MS (default 5 min) between attempts.
 *
 * Idempotency:
 *   - completionDeliveredAt set -> skip (already delivered);
 *   - outbox idempotency key -> duplicate enqueue is a no-op dedupe;
 *   - claim/reconcile under the labels lock keeps concurrent runs safe.
 *
 * Run by scheduler every 10 minutes as a safety net (mirrors 529-recovery.mjs).
 *
 * Exit codes:
 *   0 -- all good (nothing to recover, or recoveries dispatched)
 *   1 -- hard error
 */

import { readFileSync, writeFileSync, renameSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { getDb, initDb } from '../db.js';
import {
  extractTerminalAssistantReplyFromEntries,
  resolveCompletionDelivery,
} from './completion.mjs';
import {
  projectOpenClawTranscriptEntries,
  readOpenClawSessionStore,
  readOpenClawTranscriptTail,
} from './session-store.mjs';
import {
  buildCompletionDeliveryScope,
  enqueueCompletionNotification,
  labelCompletionIdentity,
  recordCompletionDelivered,
  recordCompletionDeliveryDebt,
} from './hooks.mjs';
import { effectiveDeliveryTarget } from './source-context.mjs';
import { resolveLabelsPath } from './paths.mjs';
import { withLabelsLock } from './label-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || homedir();
const LABELS_PATH = resolveLabelsPath({ legacyCandidates: [join(__dirname, 'labels.json')] });

const MAX_RECOVERIES = 3;
// Only recover labels whose terminal state is recent (matches the delivery
// watcher TTL by default -- don't revive ancient done labels).
const MAX_LABEL_AGE_MS = Number(process.env.COMPLETION_SAFETY_NET_MAX_AGE_MS
  || 48 * 60 * 60 * 1000);
// Minimum time since the last safety-net attempt (give the watcher time to
// handle it first -- 5 minutes).
const MIN_SINCE_LAST_ATTEMPT_MS = 5 * 60 * 1000;

function loadLabels() {
  try {
    const parsed = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.assign(Object.create(null), parsed)
      : Object.create(null);
  } catch {
    return Object.create(null);
  }
}

function saveLabels(labels) {
  const tmp = LABELS_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
  renameSync(tmp, LABELS_PATH);
}

function parseTimestampMs(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Terminal anchor for the age window: the label's updatedAt is refreshed by
 * the watcher/done path when the session reaches 'done', so it marks the
 * terminal state. Fall back to spawnedAt when updatedAt is absent.
 */
function terminalAgeMs(entry, now) {
  const ms = parseTimestampMs(entry.updatedAt) ?? parseTimestampMs(entry.spawnedAt);
  return ms == null ? null : now - ms;
}

function rejectionReason(entry, now, scope) {
  if (!entry || entry.status !== 'done') return 'label not in done state';
  if (entry.completionDeliveredAt) return 'completion already delivered';
  if (entry.deliveryMode === 'none') return 'delivery disabled for this label';
  if (!effectiveDeliveryTarget(entry)) return 'no delivery target recorded';
  const ageMs = terminalAgeMs(entry, now);
  if (ageMs == null) return 'no terminal timestamp';
  if (ageMs > MAX_LABEL_AGE_MS) {
    return `label too old (${Math.round(ageMs / 60000)}min)`;
  }
  const sameScope = entry.completionRetryScope === scope;
  const lastAttemptMs = sameScope ? parseTimestampMs(entry.lastCompletionAttemptAt) : null;
  if (lastAttemptMs != null && now - lastAttemptMs < MIN_SINCE_LAST_ATTEMPT_MS) {
    return `attempted ${Math.round((now - lastAttemptMs) / 1000)}s ago (min interval not reached)`;
  }
  const retryCount = sameScope ? (entry.completionRetryCount ?? 0) : 0;
  if (!Number.isInteger(retryCount) || retryCount < 0) return 'invalid retry count';
  if (retryCount >= MAX_RECOVERIES) {
    return `max recoveries exhausted (${retryCount}/${MAX_RECOVERIES})`;
  }
  return null;
}

export function claimAttempt(name) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    const now = Date.now();
    const identity = completionIdentity(name, entry);
    const reason = rejectionReason(entry, now, identity.deliveryScope);
    if (reason) return { reason };
    entry.completionRetryCount = entry.completionRetryScope === identity.deliveryScope
      ? (entry.completionRetryCount ?? 0) + 1 : 1;
    entry.completionRetryScope = identity.deliveryScope;
    entry.lastCompletionAttemptAt = new Date(now).toISOString();
    saveLabels(labels);
    return { entry, identity: Object.freeze(identity), signature: JSON.stringify(entry) };
  });
}

/**
 * Re-derive the completion conservatively, mirroring cmdResult:
 *   - sessionId comes from the sessions store when available (it is the
 *     canonical id, and the store may hold a newer one than the label);
 *   - the transcript tail must yield a clean terminal assistant reply;
 *   - otherwise a recorded structured completion (from the done signal) is
 *     used;
 *   - anything else (diagnostic fragments, partial replies) is NOT delivered.
 */
function deriveCompletion(entry) {
  // The sessions store is read per-agent, so resolve the agent the same way
  // cmdResult does: the label's agent wins, else the session key's agent.
  const keyAgent = entry.sessionKey?.startsWith('agent:')
    ? entry.sessionKey.slice('agent:'.length).split(':')[0]
    : null;
  const resultAgent = entry.agent || keyAgent || 'main';
  let sessionId = entry.sessionId || null;
  if (entry.sessionKey) {
    try {
      const store = readOpenClawSessionStore(resultAgent, { env: process.env, homeDir: HOME_DIR });
      const storeEntry = store.entries?.[entry.sessionKey];
      if (storeEntry?.sessionId) sessionId = storeEntry.sessionId;
    } catch {
      // store unavailable -- fall back to the label's recorded sessionId
    }
  }

  let terminalReply = null;
  if (sessionId) {
    try {
      const transcript = readOpenClawTranscriptTail(resultAgent, sessionId, {
        env: process.env,
        homeDir: HOME_DIR,
        limit: 200,
      });
      const entries = projectOpenClawTranscriptEntries(transcript.events);
      terminalReply = extractTerminalAssistantReplyFromEntries(entries);
    } catch {
      terminalReply = null;
    }
  }

  const completion = resolveCompletionDelivery({
    lastReply: terminalReply,
    completion: entry.completion,
    fallbackSummary: entry.summary,
  });
  return completion.deliveryText ? completion : null;
}

function hasActiveWatcher(label, entry) {
  let db = null;
  try {
    const dbPath = process.env.SCHEDULER_DB || join(HOME_DIR, '.openclaw', 'scheduler', 'scheduler.db');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT DISTINCT j.id, j.name
      FROM jobs j
      JOIN runs r ON r.job_id = j.id
      WHERE (
          r.status = 'running'
          OR (r.status = 'pending' AND r.started_at > datetime('now','-5 minutes'))
        )
    `).all();
    // The recorded job belongs to this label's run. Legacy labels only have
    // the literal watcher name (including the optional numeric handoff suffix).
    // SQL LIKE or a prefix match would let backup-extra suppress backup.
    if (entry.deliveryWatcherJobId) {
      return rows.some(row => row.id === entry.deliveryWatcherJobId);
    }
    const suffix = `-deliver:${label}`;
    return rows.some(row => row.name.endsWith(suffix)
      || row.name.replace(/:handoff:\d+$/, '').endsWith(suffix));
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function completionIdentity(name, entry) {
  const identity = labelCompletionIdentity(name, entry);
  return { ...identity, deliveryScope: buildCompletionDeliveryScope({ label: name, ...identity }) };
}

// The label lock spans the synchronous claim/outbox transaction. A reused
// label must never receive an old run's body, route, debt or delivery stamp.
export function enqueueClaim(name, claim, delivery) {
  return withLabelsLock(LABELS_PATH, () => {
    const entry = loadLabels()[name];
    if (!entry || JSON.stringify(entry) !== claim.signature
      || completionIdentity(name, entry).deliveryScope !== claim.identity.deliveryScope) {
      return { ok: false, reason: 'label-changed' };
    }
    const target = effectiveDeliveryTarget(claim.entry);
    return enqueueCompletionNotification({
      label: name,
      summary: delivery.summary,
      completion: claim.entry.completion || null,
      resolvedDelivery: delivery,
      deliverTo: target.target,
      deliveryChannel: target.channel,
      ...claim.identity,
      origin: claim.entry.origin || null,
      sourceContext: claim.entry.sourceContext || null,
      metadata: { delivery_source: 'safety-net', safety_net_attempt: claim.entry.completionRetryCount },
    });
  });
}

export function reconcileConfirmedDelivery(name, claimedEntry) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    const identity = completionIdentity(name, claimedEntry);
    if (!entry || JSON.stringify(entry) !== JSON.stringify(claimedEntry)
      || completionIdentity(name, entry).deliveryScope !== identity.deliveryScope) return false;
    const counts = getDb().prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
      FROM delivery_outbox WHERE completion_label = ? AND completion_scope = ?
    `).get(name, identity.deliveryScope);
    if (!counts.total || counts.delivered !== counts.total) return false;
    recordCompletionDelivered({
      label: name, ...identity, closeReason: 'confirmed-completion-delivered',
      metadata: { delivery_source: 'safety-net' },
    });
    entry.completionDeliveredAt = new Date().toISOString();
    entry.completionDeliverySource = 'safety-net';
    saveLabels(labels);
    return true;
  });
}

// -- Main ----------------------------------------------------

export async function runSafetyNet() {
  try {
    await initDb();
  } catch (err) {
    process.stderr.write(`[completion-safety-net] scheduler database unavailable: ${err.message}\n`);
    process.exit(1);
  }

  const labels = loadLabels();
  const results = [];
  for (const [name, entry] of Object.entries(labels)) {
    // Only look at done-state sessions that still lack a recorded delivery.
    if (entry?.status !== 'done') continue;
    if (entry.completionDeliveredAt) continue;
    if (entry.deliveryMode === 'none') continue;
    if (!effectiveDeliveryTarget(entry)) continue;

    // Observe confirmation even after retries are exhausted or the age window expires.
    if (reconcileConfirmedDelivery(name, entry)) {
      results.push({ label: name, action: 'recovered' });
      continue;
    }

    // Never race a live watcher run for this label. Checked before claiming an
    // attempt so a live watcher does not burn one of the bounded retries.
    if (hasActiveWatcher(name, entry)) {
      results.push({ label: name, action: 'skip', reason: 'active dispatch-deliver watcher' });
      continue;
    }

    // Re-validate under the labels lock: a watcher or competing safety-net
    // process may have handled this label since the initial scan.
    const claim = claimAttempt(name);
    if (claim.reason) {
      results.push({ label: name, action: 'skip', reason: claim.reason });
      continue;
    }

    process.stderr.write(`[completion-safety-net] recovering [${name}] (attempt ${claim.entry.completionRetryCount}/${MAX_RECOVERIES})\n`);

    // Re-derive the completion conservatively. No clean terminal reply and no
    // recorded structured completion -> skip; never fabricate a delivery.
    const derived = deriveCompletion(claim.entry);
    if (!derived) {
      results.push({ label: name, action: 'skip', reason: 'no clean terminal completion re-derivable' });
      continue;
    }

    const identity = claim.identity;
    let deliveryResult;
    try {
      deliveryResult = await enqueueClaim(name, claim, derived);
    } catch (err) {
      recordCompletionDeliveryDebt({
        label: name,
        sessionKey: identity.sessionKey,
        runId: identity.runId,
        deliveryScope: identity.deliveryScope,
        openReason: 'completion-delivery-failed',
        metadata: {
          delivery_source: 'safety-net',
          error: err.message,
        },
      });
      results.push({ label: name, action: 'recover_failed', reason: err.message });
      continue;
    }

    const enqueued = deliveryResult.ok || deliveryResult.deduped === true;
    if (enqueued) {
      // Enqueue/claim ownership is not channel confirmation. Recheck only the
      // immutable claim after the await; a replacement label is left untouched.
      const confirmed = reconcileConfirmedDelivery(name, claim.entry);
      results.push({ label: name, action: confirmed ? 'recovered' : 'enqueued' });
    } else if (deliveryResult.reason === 'label-changed') {
      results.push({ label: name, action: 'skip', reason: 'label changed before enqueue' });
    } else if (deliveryResult.suppressed) {
      // No meaningful user-facing completion text -- the debt is already
      // recorded by enqueueCompletionNotification.
      results.push({ label: name, action: 'skip', reason: 'no clean user-facing completion' });
    } else {
      results.push({ label: name, action: 'recover_failed', reason: deliveryResult.error || deliveryResult.reason || 'unknown error' });
    }
  }

  // Output summary -- scheduler delivers stdout if non-empty and delivery_mode=announce
  if (results.length > 0) {
    const recovered = results.filter(r => r.action === 'recovered');
    const enqueued = results.filter(r => r.action === 'enqueued');
    const skipped = results.filter(r => r.action === 'skip');
    const failed = results.filter(r => r.action === 'recover_failed');

    const lines = [];
    if (recovered.length) lines.push(`✅ Delivered: ${recovered.map(r => r.label).join(', ')}`);
    if (enqueued.length) lines.push(`Queued: ${enqueued.map(r => r.label).join(', ')}`);
    if (failed.length) lines.push(`❌ Failed: ${failed.map(r => r.label).join(', ')}`);
    if (skipped.length) lines.push(`⏭️ Skipped: ${skipped.map(r => `${r.label} (${r.reason})`).join(', ')}`);

    // Only produce stdout (which triggers delivery) if we actually recovered or
    // failed something.
    if (recovered.length || enqueued.length || failed.length) {
      process.stdout.write(`🌶️ Completion Safety Net:\n${lines.join('\n')}\n`);
    } else {
      process.stderr.write(`[completion-safety-net] scan complete: ${skipped.length} skipped\n`);
    }
  } else {
    process.stderr.write('[completion-safety-net] scan complete: no undelivered done labels found\n');
  }

}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    // Node canonicalizes the loaded module, but argv can retain a symlinked
    // install or temporary directory (including macOS /var -> /private/var).
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await runSafetyNet();
}
