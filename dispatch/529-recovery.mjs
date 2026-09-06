#!/usr/bin/env node
/**
 * dispatch 529 recovery -- scheduler safety net for 529/overload errors.
 *
 * Scans labels.json for sessions in 'error' state with 529/overload patterns.
 * If retryCount < MAX_RETRIES and the watcher hasn't already handled it,
 * re-enqueues the session.
 *
 * Idempotency:
 *   - Checks retryCount + lastRetryAt to avoid double-retrying if the watcher
 *     already handled it (watcher updates retryCount and status immediately).
 *   - If status is already 'running', skip (watcher handled it).
 *   - If retryCount >= MAX, skip (already exhausted).
 *
 * Run by scheduler every 10 minutes as a safety net.
 *
 * Exit codes:
 *   0 -- all good (nothing to retry, or retries dispatched)
 *   1 -- error
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { resolveLabelsPath } from './paths.mjs';
import { withLabelsLock } from './label-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || homedir();
const LABELS_PATH = resolveLabelsPath({ legacyCandidates: [join(__dirname, 'labels.json')] });
const INDEX_PATH  = process.env.DISPATCH_INDEX_PATH  || join(__dirname, 'index.mjs');

const MAX_RETRIES = 3;
// Only recover errors that happened within the last 60 minutes
// (don't revive ancient failures)
const MAX_ERROR_AGE_MS = 60 * 60 * 1000;
// Minimum time since last retry before the safety net triggers
// (give the watcher time to handle it first -- 5 minutes)
const MIN_SINCE_LAST_UPDATE_MS = 5 * 60 * 1000;

const OVERLOAD_PATTERNS = [
  /529/i,
  /failover\s*error/i,
  /overload/i,
  /temporarily\s+overloaded/i,
  /service.*overloaded/i,
];

function is529Error(errorMsg) {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  return OVERLOAD_PATTERNS.some(p => p.test(errorMsg));
}

function loadLabels() {
  try {
    return JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLabels(labels) {
  const tmp = LABELS_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
  renameSync(tmp, LABELS_PATH);
}

function retryRejection(entry, now) {
  if (!entry || entry.status !== 'error' || !is529Error(entry.error)) {
    return 'label changed since scan';
  }
  const updatedAt = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
  const errorAge = now - updatedAt;
  if (!Number.isFinite(errorAge)) return 'invalid error timestamp';
  if (errorAge > MAX_ERROR_AGE_MS) {
    return `error too old (${Math.round(errorAge / 60000)}min)`;
  }
  if (errorAge < MIN_SINCE_LAST_UPDATE_MS) {
    return `updated ${Math.round(errorAge / 1000)}s ago (watcher may be handling)`;
  }
  const retryCount = entry.retryCount || 0;
  if (!Number.isInteger(retryCount) || retryCount < 0) return 'invalid retry count';
  if (retryCount >= MAX_RETRIES) {
    return `max retries exhausted (${retryCount}/${MAX_RETRIES})`;
  }
  return null;
}

function claimRetry(name) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    const reason = retryRejection(entry, Date.now());
    if (reason) return { reason };
    entry.retryCount = (entry.retryCount || 0) + 1;
    entry.updatedAt = new Date().toISOString();
    saveLabels(labels);
    return { entry, signature: JSON.stringify(entry) };
  });
}

function reconcileRetry(name, claim) {
  return withLabelsLock(LABELS_PATH, () => {
    const labels = loadLabels();
    const entry = labels[name];
    // The child CLI or another watcher may have updated this label while we
    // dispatched. Only reconcile the exact entry this process claimed; keep
    // every concurrent change, including terminal state and same-time writes.
    if (!entry || JSON.stringify(entry) !== claim.signature) return false;
    entry.status = 'running';
    entry.error = null;
    entry.updatedAt = new Date().toISOString();
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

function respawnSession(label, entry) {
  const continuationMsg = `[Auto-retry after 529 overload -- scheduler safety net] This is an automatic retry. Please continue your previous task from where you left off.`;

  // Try send (reuse session) first
  try {
    execFileSync(process.execPath, [
      INDEX_PATH, 'send',
      '--label', label,
      '--message', continuationMsg,
    ], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'send';
  } catch {}

  // Fallback: fresh enqueue
  try {
    const args = [
      INDEX_PATH, 'enqueue',
      '--label', label,
      '--message', continuationMsg,
      '--mode', 'fresh',
    ];
    if (entry?.model) args.push('--model', entry.model);
    if (entry?.thinking) args.push('--thinking', entry.thinking);
    if (entry?.origin) args.push('--origin', entry.origin);
    if (entry?.sourceContext) args.push('--source-context', JSON.stringify(entry.sourceContext));
    if (entry?.deliverTo) {
      args.push('--deliver-to', entry.deliverTo);
      if (entry?.deliveryMode) args.push('--delivery-mode', entry.deliveryMode);
      if (entry?.deliverChannel) args.push('--deliver-channel', entry.deliverChannel);
    }

    execFileSync(process.execPath, args, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'fresh';
  } catch {
    return null;
  }
}

// -- Main ----------------------------------------------------

const labels = loadLabels();
const results = [];
for (const [name, entry] of Object.entries(labels)) {
  // Only look at error-state sessions
  if (entry?.status !== 'error') continue;

  const errorMsg = entry.error || '';
  if (!is529Error(errorMsg)) continue;

  // Re-read and revalidate under ownership: a watcher or competing recovery
  // process may have handled this error since the initial scan.
  const claim = claimRetry(name);
  if (claim.reason) {
    results.push({ label: name, action: 'skip', reason: claim.reason });
    continue;
  }

  const newRetryCount = claim.entry.retryCount;
  process.stderr.write(`[529-recovery] retrying [${name}] (attempt ${newRetryCount}/${MAX_RETRIES})\n`);

  // Child dispatch and notifications can also write labels. Do not hold the
  // synchronous mutex over subprocess work or wait on our own child owner.
  const method = respawnSession(name, claim.entry);
  if (method) {
    reconcileRetry(name, claim);
    notify(`🌶️ Dispatch 529 recovery: [${name}] retried (${newRetryCount}/${MAX_RETRIES}) via ${method}`);
    results.push({ label: name, action: 'retried', method, retryCount: newRetryCount });
  } else {
    notify(`🌶️ Dispatch 529 recovery: [${name}] retry FAILED (${newRetryCount}/${MAX_RETRIES})`);
    results.push({ label: name, action: 'retry_failed', retryCount: newRetryCount });
  }
}

// Output summary -- scheduler delivers stdout if non-empty and delivery_mode=announce
if (results.length > 0) {
  const retried = results.filter(r => r.action === 'retried');
  const skipped = results.filter(r => r.action === 'skip');
  const failed = results.filter(r => r.action === 'retry_failed');

  const lines = [];
  if (retried.length) lines.push(`✅ Retried: ${retried.map(r => r.label).join(', ')}`);
  if (failed.length) lines.push(`❌ Failed: ${failed.map(r => r.label).join(', ')}`);
  if (skipped.length) lines.push(`⏭️ Skipped: ${skipped.map(r => `${r.label} (${r.reason})`).join(', ')}`);

  // Only produce stdout (which triggers delivery) if we actually retried or failed something
  if (retried.length || failed.length) {
    process.stdout.write(`🌶️ 529 Recovery:\n${lines.join('\n')}\n`);
  } else {
    process.stderr.write(`[529-recovery] scan complete: ${skipped.length} skipped\n`);
  }
} else {
  process.stderr.write('[529-recovery] scan complete: no 529 errors found\n');
}
