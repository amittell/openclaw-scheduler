#!/usr/bin/env node
/**
 * dispatch 529 recovery — scheduler safety net for 529/overload errors.
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
 *   0 — all good (nothing to retry, or retries dispatched)
 *   1 — error
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = join(__dirname, 'labels.json');
const INDEX_PATH = join(__dirname, 'index.mjs');
const HOME_DIR = process.env.HOME || homedir();

const MAX_RETRIES = 3;
// Only recover errors that happened within the last 60 minutes
// (don't revive ancient failures)
const MAX_ERROR_AGE_MS = 60 * 60 * 1000;
// Minimum time since last retry before the safety net triggers
// (give the watcher time to handle it first — 5 minutes)
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
  writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2) + '\n');
}

function notify(message) {
  try {
    const checkinPath = join(HOME_DIR, '.openclaw', 'workspace', 'scripts', 'agent-checkin.mjs');
    execFileSync('node', [checkinPath, message], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {}
}

function respawnSession(label, entry) {
  const continuationMsg = `[Auto-retry after 529 overload — scheduler safety net] This is an automatic retry. Please continue your previous task from where you left off.`;

  // Try send (reuse session) first
  try {
    execFileSync('node', [
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
    if (entry?.deliverTo) {
      args.push('--deliver-to', entry.deliverTo);
      args.push('--delivery-mode', 'announce');
    }

    execFileSync('node', args, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'fresh';
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────

const labels = loadLabels();
const now = Date.now();
const results = [];
  for (const [name, entry] of Object.entries(labels)) {
  // Only look at error-state sessions
  if (entry.status !== 'error') continue;

  const errorMsg = entry.error || '';
  if (!is529Error(errorMsg)) continue;

  // Check age — don't retry very old errors
  const updatedAt = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
  const errorAge = now - updatedAt;
  if (errorAge > MAX_ERROR_AGE_MS) {
    results.push({ label: name, action: 'skip', reason: `error too old (${Math.round(errorAge / 60000)}min)` });
    continue;
  }

  // Check if watcher already handled it (updated recently)
  if (errorAge < MIN_SINCE_LAST_UPDATE_MS) {
    results.push({ label: name, action: 'skip', reason: `updated ${Math.round(errorAge / 1000)}s ago (watcher may be handling)` });
    continue;
  }

  // Check retry count
  const retryCount = entry.retryCount || 0;
  if (retryCount >= MAX_RETRIES) {
    results.push({ label: name, action: 'skip', reason: `max retries exhausted (${retryCount}/${MAX_RETRIES})` });
    continue;
  }

  // Attempt retry
  const newRetryCount = retryCount + 1;
  process.stderr.write(`[529-recovery] retrying [${name}] (attempt ${newRetryCount}/${MAX_RETRIES})\n`);

  // Update labels.json first (claim the retry)
  const freshLabels = loadLabels();
  if (freshLabels[name]) {
    freshLabels[name].retryCount = newRetryCount;
    freshLabels[name].updatedAt = new Date().toISOString();
    saveLabels(freshLabels);
  }

  const method = respawnSession(name, entry);
  if (method) {
    // Mark as running
    const updated = loadLabels();
    if (updated[name]) {
      updated[name].status = 'running';
      updated[name].error = null;
      updated[name].updatedAt = new Date().toISOString();
      saveLabels(updated);
    }
    notify(`🌶️ Dispatch 529 recovery: [${name}] retried (${newRetryCount}/${MAX_RETRIES}) via ${method}`);
    results.push({ label: name, action: 'retried', method, retryCount: newRetryCount });
  } else {
    notify(`🌶️ Dispatch 529 recovery: [${name}] retry FAILED (${newRetryCount}/${MAX_RETRIES})`);
    results.push({ label: name, action: 'retry_failed', retryCount: newRetryCount });
  }
}

// Output summary — scheduler delivers stdout if non-empty and delivery_mode=announce
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
