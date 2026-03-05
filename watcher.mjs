#!/usr/bin/env node
/**
 * chilisaus watcher — polls a session until done, outputs the result.
 *
 * Used by scheduler shell jobs for async delivery with retry + audit trail.
 * The scheduler runs this as a shell job with delivery_mode='announce-always',
 * so stdout is delivered via handleDelivery (retry, alias, audit).
 *
 * Detection strategy:
 *   1. Check `status --label` — if auto-resolved to 'done', use it
 *   2. If status says 'running' but session is idle (no activity for >60s),
 *      also check `result --label` for a lastReply — if found, session completed
 *      but status hasn't caught up yet (auto-resolve has 10min threshold)
 *
 * 529/Overload auto-retry:
 *   When a session errors with a 529/FailoverError/overload pattern, the watcher
 *   will automatically retry up to MAX_529_RETRIES times with exponential backoff
 *   (30s * retryCount). It respawns via `chilisaus enqueue --mode reuse` to continue
 *   the same session, and tracks retryCount in labels.json.
 *
 * Usage: node watcher.mjs --label <label> [--timeout <seconds>] [--poll-interval <seconds>]
 *
 * Exit codes:
 *   0 — session completed, result on stdout
 *   1 — timeout or error
 *   2 — argument error
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, 'index.mjs');
const LABELS_PATH = join(__dirname, 'labels.json');

const MAX_529_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30000; // 30 seconds

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a.startsWith('--') && next && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
}

/**
 * Run a chilisaus subcommand and return parsed JSON, or null on failure.
 */
function chilisaus(subcmd, args) {
  try {
    const result = execFileSync('node', [INDEX_PATH, subcmd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 529/Overload Detection & Retry ──────────────────────────

/** Regex patterns that indicate a 529/overload error */
const OVERLOAD_PATTERNS = [
  /529/i,
  /failover\s*error/i,
  /overload/i,
  /temporarily\s+overloaded/i,
  /service.*overloaded/i,
];

/**
 * Check if an error message matches a 529/overload pattern.
 */
function is529Error(errorMsg) {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  return OVERLOAD_PATTERNS.some(p => p.test(errorMsg));
}

/**
 * Load labels.json directly (avoids going through CLI for speed).
 */
function loadLabels() {
  try {
    return JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save labels.json directly.
 */
function saveLabels(labels) {
  writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2) + '\n');
}

/**
 * Get the current retryCount for a label (default 0).
 */
function getRetryCount(label) {
  const labels = loadLabels();
  return labels[label]?.retryCount || 0;
}

/**
 * Update retryCount for a label.
 */
function setRetryCount(label, count) {
  const labels = loadLabels();
  if (labels[label]) {
    labels[label].retryCount = count;
    labels[label].updatedAt = new Date().toISOString();
    saveLabels(labels);
  }
}

/**
 * Send a notification via agent-checkin (scheduler messages table).
 */
function notify(message) {
  try {
    const checkinPath = join(process.env.HOME || '~', '.openclaw', 'workspace', 'scripts', 'agent-checkin.mjs');
    execFileSync('node', [checkinPath, message], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    process.stderr.write(`[watcher] notify failed: ${err.message}\n`);
  }
}

/**
 * Attempt to retry a 529'd session.
 * Resets labels.json status to 'running', then re-enqueues with mode=reuse.
 *
 * Returns true if retry was dispatched, false if max retries exceeded.
 */
function attempt529Retry(label, retryCount, errorMsg) {
  if (retryCount >= MAX_529_RETRIES) {
    // Max retries exceeded
    const labels = loadLabels();
    if (labels[label]) {
      labels[label].status = 'error';
      labels[label].error = `max_retries_exceeded (${retryCount}x 529): ${errorMsg}`;
      labels[label].updatedAt = new Date().toISOString();
      saveLabels(labels);
    }
    notify(`🌶️ Chilisaus: [${label}] hit max retries (${MAX_529_RETRIES}x 529 overload) — giving up`);
    return false;
  }

  const newRetryCount = retryCount + 1;
  const delayMs = RETRY_BASE_DELAY_MS * newRetryCount;

  process.stderr.write(
    `[watcher] 529 detected for [${label}] (attempt ${newRetryCount}/${MAX_529_RETRIES}). ` +
    `Waiting ${delayMs / 1000}s before retry...\n`
  );
  notify(`🌶️ Chilisaus: [${label}] hit 529 overload — retry ${newRetryCount}/${MAX_529_RETRIES} in ${delayMs / 1000}s`);

  // Update retryCount in labels.json BEFORE sleeping (persist intent)
  setRetryCount(label, newRetryCount);

  return { delayMs, newRetryCount };
}

/**
 * Re-enqueue a label via chilisaus enqueue --mode reuse.
 * Uses the original label's message from the gateway session.
 */
function respawnSession(label) {
  try {
    // Reset the label status to 'running' so the re-enqueue can proceed
    const labels = loadLabels();
    const entry = labels[label];
    if (!entry) throw new Error(`label "${label}" not found`);

    // We need to re-enqueue. Since we're using mode=reuse, the session key
    // is preserved and we send a continuation message.
    const continuationMsg = `[Auto-retry after 529 overload] Please continue your previous task. Pick up where you left off.`;

    const result = execFileSync('node', [
      INDEX_PATH, 'send',
      '--label', label,
      '--message', continuationMsg,
    ], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Mark as running again in labels.json
    labels[label].status = 'running';
    labels[label].error = null;
    labels[label].updatedAt = new Date().toISOString();
    saveLabels(labels);

    process.stderr.write(`[watcher] respawned [${label}] via send (reuse session)\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[watcher] respawn via send failed: ${err.message}\n`);

    // Fallback: try fresh enqueue if send fails (session may be dead)
    try {
      const labels = loadLabels();
      const entry = labels[label];
      const continuationMsg = `[Auto-retry after 529 overload] This is a retry of a previous task that failed due to API overload. Please continue the task from the beginning.`;

      // Build enqueue args from original label data
      const enqueueArgs = [
        INDEX_PATH, 'enqueue',
        '--label', label,
        '--message', continuationMsg,
        '--mode', 'fresh',
      ];
      if (entry?.model) enqueueArgs.push('--model', entry.model);
      if (entry?.thinking) enqueueArgs.push('--thinking', entry.thinking);

      execFileSync('node', enqueueArgs, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      process.stderr.write(`[watcher] respawned [${label}] via fresh enqueue (fallback)\n`);
      return true;
    } catch (err2) {
      process.stderr.write(`[watcher] respawn fallback also failed: ${err2.message}\n`);
      return false;
    }
  }
}

/**
 * Format and output the delivery message, then exit 0.
 */
function deliverResult(label, lastReply, fallbackSummary) {
  if (lastReply) {
    const maxLen = 3500;
    const reply = lastReply.length > maxLen
      ? lastReply.slice(0, maxLen) + '\n\n…[truncated]'
      : lastReply;
    process.stdout.write(`🌶️ *chilisaus* [${label}] completed:\n\n${reply}\n`);
  } else {
    process.stdout.write(
      `🌶️ *chilisaus* [${label}] completed (no reply captured)\n` +
      `Summary: ${fallbackSummary || 'none'}\n`
    );
  }
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────

const flags = parseFlags(process.argv.slice(2));
const label       = flags.label;
const timeoutS    = parseInt(flags.timeout || '600', 10);
const pollS       = parseInt(flags['poll-interval'] || '20', 10);

// How long a session must be idle before we proactively check result
const IDLE_RESULT_CHECK_MS = 60000;

if (!label) {
  process.stderr.write('[watcher] --label is required\n');
  process.exit(2);
}

const deadline = Date.now() + timeoutS * 1000;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;

while (Date.now() < deadline) {
  const status = chilisaus('status', ['--label', label]);

  if (!status?.ok) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      process.stdout.write(`⚠️ chilisaus [${label}] watcher: gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive status failures\n`);
      process.exit(1);
    }
    await sleep(pollS * 1000);
    continue;
  }

  consecutiveFailures = 0;

  // ── Path 0: 529/overload auto-retry ───────────────────────
  if (status.status === 'error') {
    const errorMsg = status.error || status.summary || '';
    if (is529Error(errorMsg)) {
      const retryCount = getRetryCount(label);
      const retryResult = attempt529Retry(label, retryCount, errorMsg);

      if (retryResult === false) {
        // Max retries exceeded — deliver error
        process.stdout.write(
          `🌶️ *chilisaus* [${label}] failed after ${MAX_529_RETRIES} retries (529 overload)\n` +
          `Error: ${errorMsg}\n`
        );
        process.exit(1);
      }

      // Wait with backoff then respawn
      await sleep(retryResult.delayMs);

      if (respawnSession(label)) {
        // Session respawned — continue polling loop
        process.stderr.write(`[watcher] [${label}] retry ${retryResult.newRetryCount} dispatched, continuing poll...\n`);
        await sleep(pollS * 1000);
        continue;
      } else {
        // Respawn failed — deliver error
        process.stdout.write(
          `🌶️ *chilisaus* [${label}] 529 retry failed — could not respawn session\n` +
          `Error: ${errorMsg}\n`
        );
        process.exit(1);
      }
    }
  }

  // ── Path 1: status auto-resolved to done ──────────────────
  if (status.status !== 'running') {
    // Reset retryCount on successful completion
    if (status.status === 'done') {
      const currentRetryCount = getRetryCount(label);
      if (currentRetryCount > 0) {
        setRetryCount(label, 0);
        process.stderr.write(`[watcher] [${label}] completed after ${currentRetryCount} retry(ies), reset retryCount\n`);
      }
    }
    const result = chilisaus('result', ['--label', label]);
    deliverResult(label, result?.lastReply, status.summary);
  }

  // ── Path 2: status says 'running' but session may be idle ─
  // If the session has no recent activity, proactively check for a result.
  // This catches the gap where the session completed but status hasn't
  // auto-resolved yet (10min threshold in checkSessionDone).
  const ageMs = status.liveness?.ageMs;
  if (ageMs != null && ageMs >= IDLE_RESULT_CHECK_MS) {
    const result = chilisaus('result', ['--label', label]);
    if (result?.lastReply) {
      deliverResult(label, result.lastReply, null);
    }
  }


  await sleep(pollS * 1000);
}

// Timed out — try one last result check
const finalResult = chilisaus('result', ['--label', label]);
if (finalResult?.lastReply) {
  // Reset retryCount on success even if we hit watcher timeout
  const rc = getRetryCount(label);
  if (rc > 0) setRetryCount(label, 0);
  deliverResult(label, finalResult.lastReply, null);
}

process.stdout.write(`⏱ chilisaus [${label}] watcher timed out after ${timeoutS}s — session may still be running\n`);
process.exit(1);
