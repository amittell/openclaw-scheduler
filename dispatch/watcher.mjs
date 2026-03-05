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

function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = join(process.env.HOME || '~', '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gateway?.auth?.token || null;
  } catch {
    return null;
  }
}

const GW_TOKEN = getGatewayToken();

// ── Gateway RPC (sync, matches index.mjs pattern) ───────────

/**
 * Sync gateway RPC call via `openclaw gateway call`.
 * Returns parsed JSON or null on failure.
 */
function gatewayCall(method, params = {}, opts = {}) {
  const timeout = opts.timeout || 15000;
  const args = ['gateway', 'call', method, '--json'];
  args.push('--params', JSON.stringify(params));
  args.push('--timeout', String(timeout));
  if (GW_TOKEN) args.push('--token', GW_TOKEN);

  try {
    const result = execFileSync('openclaw', args, {
      encoding: 'utf-8',
      timeout: timeout + 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch (err) {
    const stdout = err.stdout?.trim() || '';
    if (stdout) try { return JSON.parse(stdout); } catch {}
    return null;
  }
}

/**
 * Get current totalTokens for a session from gateway sessions.list.
 * Returns number or null if unavailable.
 */
function getSessionTokens(sessionKey) {
  const result = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 8000 });
  const session = result?.sessions?.find(s => s.key === sessionKey);
  return session?.totalTokens ?? null;
}

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

// ── Gateway Steer & Kill ─────────────────────────────────────

/**
 * Send a steer message into a running session via gateway API (sync).
 */
function steerSession(sessionKey, message) {
  if (!GW_TOKEN) {
    process.stderr.write(`[watcher] steer skipped: no gateway token\n`);
    return false;
  }
  try {
    gatewayCall('agent', {
      message,
      sessionKey,
      deliver: false,
      lane: 'nested',
    }, { timeout: 15000 });
    return true;
  } catch (err) {
    process.stderr.write(`[watcher] steer failed: ${err.message}\n`);
    return false;
  }
}

/**
 * Kill a session via gateway subagents API (sync).
 */
function killSession(sessionKey) {
  if (!GW_TOKEN) {
    process.stderr.write(`[watcher] kill skipped: no gateway token\n`);
    return;
  }
  try {
    gatewayCall('subagents.kill', { target: sessionKey }, { timeout: 10000 });
  } catch (err) {
    process.stderr.write(`[watcher] kill failed: ${err.message}\n`);
  }
}

/**
 * Update labels.json to mark the watched label as done (best-effort, atomic write).
 * Called before exit to ensure labels.json is reconciled even if sync fails.
 */
function markLabelDone(label, summary) {
  try {
    const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
    if (labels[label] && labels[label].status !== 'done') {
      labels[label].status = 'done';
      labels[label].summary = summary || labels[label].summary || null;
      labels[label].updatedAt = new Date().toISOString();
      const tmp = LABELS_PATH + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
      execFileSync('mv', [tmp, LABELS_PATH], { timeout: 5000 });
    }
  } catch (e) {
    process.stderr.write(`[watcher] markLabelDone failed: ${e.message}\n`);
  }
}

/**
 * Format and output the delivery message, then exit 0.
 * Also marks the label as done in labels.json before exiting.
 */
function deliverResult(label, lastReply, fallbackSummary) {
  // Update labels.json before exiting — prevents stuck detector false positives
  const summary = fallbackSummary || (lastReply ? lastReply.slice(0, 500) : null);
  markLabelDone(label, summary);

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

// ── Sync on Exit ────────────────────────────────────────────
// Best-effort sync of labels.json with gateway state on every watcher exit.
// Ensures stale 'running' entries are reconciled promptly, preventing
// false positives from the stuck detector.
process.on('exit', () => {
  try {
    execFileSync('node', [INDEX_PATH, 'sync'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Best-effort — never block exit
  }
});

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
let recoverySessionKey = null;  // captured during polling for steer/kill

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

  // Capture sessionKey for recovery steer/kill
  if (status.sessionKey) recoverySessionKey = status.sessionKey;

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
  const rc = getRetryCount(label);
  if (rc > 0) setRetryCount(label, 0);
  deliverResult(label, finalResult.lastReply, null);
}

// ── Token-based activity check before steering ────────────────────────────
// Only steer if tokens have been flat for 3+ minutes post-deadline.
// If the session is still making model calls (tokens growing), stay silent.
function getTokenCount(sessionKey) {
  const gatewayTokens = sessionKey ? getSessionTokens(sessionKey) : null;
  if (typeof gatewayTokens === 'number') return gatewayTokens;
  try {
    const result = chilisaus('status', ['--label', label]);
    // sessions.list via gateway would be better but chilisaus status has liveness
    const tokens = result?.liveness?.tokens;
    return typeof tokens === 'number' ? tokens : null;
  } catch { return null; }
}

function markDoneSync(summary) {
  try {
    const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
    if (labels[label]) {
      labels[label].status = 'done';
      labels[label].summary = summary;
      labels[label].updatedAt = new Date().toISOString();
      const tmp = LABELS_PATH + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(labels, null, 2));
      execFileSync('mv', [tmp, LABELS_PATH], { timeout: 5000 });
    }
  } catch (e) {
    process.stderr.write(`[watcher] markDoneSync failed: ${e.message}\n`);
  }
}

const FLAT_WINDOW_MS = 3 * 60 * 1000; // 3 min flat = genuinely stuck
const ACTIVITY_POLL_MS = 30_000;

const statusAtDeadline = chilisaus('status', ['--label', label]);
let tokenSessionKey = statusAtDeadline?.sessionKey || recoverySessionKey || null;
let baselineTokens = getTokenCount(tokenSessionKey);
let flatSince = Date.now();

process.stderr.write(`[watcher] deadline hit for ${label} — watching token activity (baseline: ${baselineTokens})\n`);

if (baselineTokens === null) {
  process.stderr.write(`[watcher] token telemetry unavailable for ${label}; skipping steer/kill recovery\n`);
  markDoneSync(`timed out after ${timeoutS}s — token telemetry unavailable`);
  process.stdout.write(`⏱ chilisaus [${label}] timed out after ${timeoutS}s — token telemetry unavailable; no steer/kill attempted\n`);
  process.exit(1);
}

while (Date.now() - flatSince < FLAT_WINDOW_MS) {
  await sleep(ACTIVITY_POLL_MS);

  // Delivered?
  const st = chilisaus('status', ['--label', label]);
  if (st?.sessionKey && !tokenSessionKey) tokenSessionKey = st.sessionKey;
  if (st?.status === 'done') {
    const r = chilisaus('result', ['--label', label]);
    markDoneSync('completed during activity window');
    deliverResult(label, r?.lastReply, st.summary);
  }
  const r2 = chilisaus('result', ['--label', label]);
  if (r2?.lastReply) {
    markDoneSync('completed during activity window');
    deliverResult(label, r2.lastReply, null);
  }

  // Token growth?
  const cur = getTokenCount(tokenSessionKey);
  if (cur === null) {
    process.stderr.write(`[watcher] token telemetry lost for ${label}; skipping steer/kill recovery\n`);
    markDoneSync(`timed out after ${timeoutS}s — token telemetry lost`);
    process.stdout.write(`⏱ chilisaus [${label}] timed out after ${timeoutS}s — token telemetry lost; no steer/kill attempted\n`);
    process.exit(1);
  }
  if (cur > baselineTokens) {
    process.stderr.write(`[watcher] ${label} still active (${baselineTokens}→${cur} tokens), resetting flat timer\n`);
    baselineTokens = cur;
    flatSince = Date.now();
  }
}

// 3 min of genuinely flat tokens — now steer
process.stderr.write(`[watcher] ${label} inactive 3min post-deadline — entering steer\n`);

// Get sessionKey for steer/kill
const statusForSteer = chilisaus('status', ['--label', label]);
const steerSessionKey = statusForSteer?.sessionKey || null;

const steerRounds = [
  { waitMs: 30_000,  msg: "Watcher check: if you're done, please send your final reply now. If still working, continue and ignore this." },
  { waitMs: 60_000,  msg: "Watcher final check: please send your final reply now, or the session will be terminated in 2 minutes." },
  { waitMs: 120_000, msg: null }, // kill round
];

for (const round of steerRounds) {
  if (round.msg && steerSessionKey) {
    process.stderr.write(`[watcher] steering ${label}: "${round.msg.slice(0, 60)}..."\n`);
    await steerSession(steerSessionKey, round.msg);
  }
  await sleep(round.waitMs);

  const st2 = chilisaus('status', ['--label', label]);
  if (st2?.status === 'done') {
    const r3 = chilisaus('result', ['--label', label]);
    markDoneSync('completed during steer recovery');
    deliverResult(label, r3?.lastReply, st2.summary);
  }
  const r3 = chilisaus('result', ['--label', label]);
  if (r3?.lastReply) {
    markDoneSync('completed during steer recovery');
    deliverResult(label, r3.lastReply, null);
  }

  if (!round.msg && steerSessionKey) {
    process.stderr.write(`[watcher] killing stuck session ${label}\n`);
    await killSession(steerSessionKey);
    // Wait up to 30s for confirmation
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const st3 = chilisaus('status', ['--label', label]);
      if (st3?.status === 'done') {
        markDoneSync('killed after steer+backoff — confirmed done');
        process.stdout.write(`🌶️ *chilisaus* [${label}] killed after steer attempts\n`);
        process.exit(0);
      }
    }
  }
}

markDoneSync(`timed out after ${timeoutS}s — killed after steer attempts`);
process.stdout.write(`⏱ chilisaus [${label}] timed out after ${timeoutS}s — session killed after steer attempts\n`);
process.exit(1);
