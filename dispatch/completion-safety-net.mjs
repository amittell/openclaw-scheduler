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
 *   - on success: closes the completion debt and stamps completionDeliveredAt.
 *
 * Bounds:
 *   - only labels updated within MAX_LABEL_AGE_MS (default 48h, matching
 *     deliver_watcher_ttl_hours) are recovered -- ancient terminal labels are
 *     not revived;
 *   - per-label retry cap (completionRetryCount, default 3) so a label that
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

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { initDb } from '../db.js';
import {
  extractTerminalAssistantReplyFromEntries,
} from './completion.mjs';
import {
  projectOpenClawTranscriptEntries,
  readOpenClawSessionStore,
  readOpenClawTranscriptTail,
} from './session-store.mjs';
import {
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

function rejectionReason(entry, now) {
  if (!entry || entry.status !== 'done') return 'label not in done state';
  if (entry.completionDeliveredAt) return 'completion already delivered';
  if (entry.deliveryMode === 'none') return 'delivery disabled for this label';
  if (!effectiveDeliveryTarget(entry)) return 'no delivery target recorded';
  const ageMs = terminalAgeMs(entry, now);
  if (ageMs == null) return 'no terminal timestamp';
  if (ageMs > MAX_LABEL_AGE_MS) {
    return `label too old (${Math.round(ageMs / 60000)}min)`;
  }
  const lastAttemptMs = parseTimestampMs(entry.lastCompletionAttemptAt);
  if (lastAttemptMs != null && now - lastAttemptMs < MIN_SINCE_LAST_ATTEMPT_MS) {
    return `attempted ${Math.round((now - lastAttemptMs) / 1000)}s ago (min interval not reached)`;
  }
  const retryCount = entry.completionRetryCount || 0;
  if (!Number.isInteger(retryCount) || retryCount < 0) return 'invalid retry count';
  if (retryCount >= MAX_RECOVERIES) {
    return `max recoveries exhausted (${retryCount}/${MAX_RECOVERIES})`;
  }
  return null;
}

function claimAttempt(name) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    const now = Date.now();
    const reason = rejectionReason(entry, now);
    if (reason) return { reason };
    entry.completionRetryCount = (entry.completionRetryCount || 0) + 1;
    entry.lastCompletionAttemptAt = new Date(now).toISOString();
    saveLabels(labels);
    return { entry, signature: JSON.stringify(entry) };
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
 */function deriveCompletion(entry) {
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

  if (terminalReply) return { lastReply: terminalReply, source: 'jsonl-terminal' };
  if (entry.completion && typeof entry.completion === 'object' && !Array.isArray(entry.completion)) {
    return { completion: entry.completion, source: 'recorded-completion' };
  }
  return null;
}

function hasActiveWatcher(label) {
  let db = null;
  try {
    const dbPath = process.env.SCHEDULER_DB || join(HOME_DIR, '.openclaw', 'scheduler', 'scheduler.db');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT COUNT(*) AS c
      FROM jobs j
      JOIN runs r ON r.job_id = j.id
      WHERE j.name LIKE ?
        AND (
          r.status = 'running'
          OR (r.status = 'pending' AND r.started_at > datetime('now','-5 minutes'))
        )
    `).get(`%-deliver:${label}%`);
    return (row?.c || 0) > 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function reconcileDelivery(name, claim, delivered) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    // A watcher or competing process may have updated this label while we
    // dispatched. Only reconcile the exact entry this process claimed.
    if (!entry || JSON.stringify(entry) !== claim.signature) return false;
    if (delivered) {
      entry.completionDeliveredAt = new Date().toISOString();
      entry.completionDeliverySource = 'safety-net';
    }
    saveLabels(labels);
    return true;
  });
}

function resolveSchedulerCliPath() {
  const candidates = [
    process.env.OPENCLAW_SCHEDULER_CLI,
    process.env.SCHEDULER_CLI,
    join(__dirname, '..', 'cli.js'),
    join(HOME_DIR, '.openclaw', 'packages', 'openclaw-scheduler', 'node_modules', 'openclaw-scheduler', 'cli.js'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }

  return join(__dirname, '..', 'cli.js');
}

function notify(message) {
  try {
    const cliPath = resolveSchedulerCliPath();
    execFileSync(process.execPath, [cliPath, 'msg', 'send', 'scheduler', 'main', message], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {}
}

// -- Main ----------------------------------------------------

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

  // Never race a live watcher run for this label. Checked before claiming an
  // attempt so a live watcher does not burn one of the bounded retries.
  if (hasActiveWatcher(name)) {
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

  const identity = labelCompletionIdentity(name, claim.entry);
  const target = effectiveDeliveryTarget(claim.entry);
  let deliveryResult;
  try {
    deliveryResult = await enqueueCompletionNotification({
      label: name,
      summary: claim.entry.summary || null,
      completion: derived.completion || null,
      ...(derived.lastReply
        ? { resolvedDelivery: { deliveryText: derived.lastReply, summary: derived.lastReply, source: 'safety-net' } }
        : {}),
      deliverTo: target.target,
      deliveryChannel: target.channel,
      sessionKey: identity.sessionKey,
      runId: identity.runId,
      deliveryScope: identity.deliveryScope,
      origin: claim.entry.origin || null,
      sourceContext: claim.entry.sourceContext || null,
      metadata: {
        delivery_source: 'safety-net',
        last_label_status: 'done',
        safety_net_attempt: claim.entry.completionRetryCount,
      },
    });
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

  const delivered = deliveryResult.ok
    || deliveryResult.deduped === true
    || deliveryResult.reason === 'already-claimed';

  if (delivered) {
    // Close the debt and stamp the label (under the lock, against the exact
    // entry we claimed).
    const postIdentity = labelCompletionIdentity(name, loadLabels()[name] || claim.entry);
    recordCompletionDelivered({
      label: name,
      sessionKey: postIdentity.sessionKey,
      runId: postIdentity.runId,
      deliveryScope: postIdentity.deliveryScope,
      closeReason: 'safety-net-completion-delivered',
      metadata: {
        delivery_source: 'safety-net',
        last_label_status: 'done',
      },
    });
    reconcileDelivery(name, claim, true);
    notify(`🌶️ Dispatch completion safety net: [${name}] completion delivered`);
    results.push({ label: name, action: 'recovered', deduped: deliveryResult.deduped === true });
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
  const skipped = results.filter(r => r.action === 'skip');
  const failed = results.filter(r => r.action === 'recover_failed');

  const lines = [];
  if (recovered.length) lines.push(`✅ Delivered: ${recovered.map(r => r.label).join(', ')}`);
  if (failed.length) lines.push(`❌ Failed: ${failed.map(r => r.label).join(', ')}`);
  if (skipped.length) lines.push(`⏭️ Skipped: ${skipped.map(r => `${r.label} (${r.reason})`).join(', ')}`);

  // Only produce stdout (which triggers delivery) if we actually recovered or
  // failed something.
  if (recovered.length || failed.length) {
    process.stdout.write(`🌶️ Completion Safety Net:\n${lines.join('\n')}\n`);
  } else {
    process.stderr.write(`[completion-safety-net] scan complete: ${skipped.length} skipped\n`);
  }
} else {
  process.stderr.write('[completion-safety-net] scan complete: no undelivered done labels found\n');
}
