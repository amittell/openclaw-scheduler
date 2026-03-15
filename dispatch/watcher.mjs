#!/usr/bin/env node
/**
 * dispatch watcher — polls a session until done, outputs the result.
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
 *   (30s * retryCount). It respawns via `dispatch enqueue --mode reuse` to continue
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
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { sendMessage } from '../messages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.DISPATCH_INDEX_PATH || join(__dirname, 'index.mjs');
const LABELS_PATH = process.env.DISPATCH_LABELS_PATH || join(__dirname, 'labels.json');
const HOME_DIR = process.env.HOME || homedir();

const MAX_529_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30000; // 30 seconds

const MAX_GW_RESTART_RETRIES = 2; // Max retries for gateway-restart-kill recovery

// Startup grace period before declaring a session as spawn-failure.
// Sessions take 2-5min to start processing due to LLM API queuing.
const _STARTUP_GRACE_MS = 300_000; // 5 minutes — reserved for future startup-gate logic

/** How often the watcher writes lastPing to labels.json (heartbeat signal).
 *  The watchdog guard in index.mjs treats pings older than 3× this as stale,
 *  so PING_INTERVAL_MS must stay well below PING_STALE_MS (3 * 60_000). */
const PING_INTERVAL_MS = 60_000; // 60 seconds

function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = join(HOME_DIR, '.openclaw', 'openclaw.json');
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
 * Get current totalTokens for a session.
 * Tries sessions.json first (ground truth), falls back to sessions.list API.
 * Returns number or null if unavailable.
 */
function getSessionTokens(sessionKey) {
  // Primary: sessions.json direct read
  const agent = sessionKey ? (sessionKey.split(':')[1] || 'main') : 'main';
  const store = readSessionsStore(agent);
  if (store && sessionKey in store) {
    const tokens = store[sessionKey]?.totalTokens;
    if (typeof tokens === 'number') return tokens;
  }
  // Fallback: gateway sessions.list API (may not see dispatcher-spawned sessions)
  const result = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 8000 });
  const session = result?.sessions?.find(s => s.key === sessionKey);
  return session?.totalTokens ?? null;
}

/** Returns the session entry from sessions.json, or null if not found. */
function getSessionStoreEntry(sessionKey) {
  if (!sessionKey) return null;
  const agent = sessionKey.split(':')[1] || 'main';
  const store = readSessionsStore(agent);
  return (store && sessionKey in store) ? store[sessionKey] : null;
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
 * Run a dispatch subcommand and return parsed JSON, or null on failure.
 */
function dispatch(subcmd, args) {
  try {
    const result = execFileSync(process.execPath, [INDEX_PATH, subcmd, ...args], {
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
  /rate.limit/i,
  /too.many.requests/i,
];

/**
 * Check if an error message matches a 529/overload pattern.
 */
function is529Error(errorMsg) {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  return OVERLOAD_PATTERNS.some(p => p.test(errorMsg));
}

/**
 * Regex patterns that indicate the session was not found in the sessions store.
 * This is the telltale signature of a gateway-restart-kill: the gateway restarted,
 * wiped in-flight sessions, and the status command auto-resolved the label as 'done'
 * because the sessionKey disappeared from sessions.json.
 */
const GW_KILL_PATTERNS = [
  /session not found in sessions store/i,
  /session not found in gateway store/i,
  /session never found/i,
  /Auto-resolved.*session not found/i,
  /Auto-resolved.*never found/i,
];

/**
 * Check if a status summary indicates the session was killed by a gateway restart.
 */
function isGatewayRestartKill(summary) {
  if (!summary || typeof summary !== 'string') return false;
  return GW_KILL_PATTERNS.some(p => p.test(summary));
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
 * Get the current gateway-restart retry count for a label (default 0).
 */
function getGwRestartRetryCount(label) {
  const labels = loadLabels();
  return labels[label]?.gwRestartRetryCount || 0;
}

/**
 * Update the gateway-restart retry count for a label.
 */
function setGwRestartRetryCount(label, count) {
  const labels = loadLabels();
  if (labels[label]) {
    labels[label].gwRestartRetryCount = count;
    labels[label].updatedAt = new Date().toISOString();
    saveLabels(labels);
  }
}

/**
 * Send a notification via the scheduler messages table.
 */
function notify(message) {
  try {
    sendMessage({
      from_agent: 'dispatch',
      to_agent: 'main',
      body: message,
      kind: 'text',
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
    notify(`🌶️ Dispatch: [${label}] hit max retries (${MAX_529_RETRIES}x 529 overload) — giving up`);
    return false;
  }

  const newRetryCount = retryCount + 1;
  const delayMs = RETRY_BASE_DELAY_MS * newRetryCount;

  process.stderr.write(
    `[watcher] 529 detected for [${label}] (attempt ${newRetryCount}/${MAX_529_RETRIES}). ` +
    `Waiting ${delayMs / 1000}s before retry...\n`
  );
  notify(`🌶️ Dispatch: [${label}] hit 529 overload — retry ${newRetryCount}/${MAX_529_RETRIES} in ${delayMs / 1000}s`);

  // Update retryCount in labels.json BEFORE sleeping (persist intent)
  setRetryCount(label, newRetryCount);

  return { delayMs, newRetryCount };
}

/**
 * Re-enqueue a label via dispatch enqueue --mode reuse.
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

    execFileSync(process.execPath, [
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

      execFileSync(process.execPath, enqueueArgs, {
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
 * Re-enqueue a label after a gateway-restart kill.
 * Always uses fresh mode since the original session is gone (the gateway restart
 * wiped it). Resets label status to 'running' on success so the watcher can
 * continue polling the new session.
 */
function respawnAfterGwRestart(label) {
  try {
    const labels = loadLabels();
    const entry = labels[label];
    if (!entry) throw new Error(`label "${label}" not found`);

    const continuationMsg =
      `[Auto-retry after gateway restart] Previous run was killed by gateway restart. ` +
      `Resume from the beginning.`;

    const enqueueArgs = [
      INDEX_PATH, 'enqueue',
      '--label', label,
      '--message', continuationMsg,
      '--mode', 'fresh',
    ];
    if (entry?.model) enqueueArgs.push('--model', entry.model);
    if (entry?.thinking) enqueueArgs.push('--thinking', entry.thinking);

    execFileSync(process.execPath, enqueueArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // enqueue sets the label to 'running' with a new sessionKey — also reset error field
    const refreshed = loadLabels();
    if (refreshed[label]) {
      refreshed[label].error = null;
      refreshed[label].updatedAt = new Date().toISOString();
      saveLabels(refreshed);
    }

    process.stderr.write(`[watcher] respawned [${label}] via fresh enqueue after gateway restart\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[watcher] respawn after gw restart failed: ${err.message}\n`);
    return false;
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
 * Read the sessions.json store for an agent directly from disk.
 * Primary ground truth for session state — sessions spawned via dispatcher
 * HTTP agent endpoint appear here but NOT in sessions_list API results.
 *
 * @param {string} agent - Agent ID (default: 'main')
 * @returns {Object|null} - Sessions store object, or null on read error
 */
function readSessionsStore(agent = 'main') {
  try {
    const sessionsPath = join(HOME_DIR, '.openclaw', 'agents', agent, 'sessions', 'sessions.json');
    return JSON.parse(readFileSync(sessionsPath, 'utf-8'));
  } catch {
    return null;
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
 * Update labels.json to mark the watched label as 'error' (best-effort, atomic write).
 * Used instead of markDoneSync/markLabelDone for sessions that did NOT complete
 * successfully: gateway-restart-kill, timeout with no result, spawn failure.
 * This ensures the scheduler run status reflects the true failure outcome.
 */
function markLabelError(label, errorSummary) {
  try {
    const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
    if (labels[label]) {
      labels[label].status = 'error';
      labels[label].summary = errorSummary || 'failed without result';
      labels[label].updatedAt = new Date().toISOString();
      const tmp = LABELS_PATH + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
      execFileSync('mv', [tmp, LABELS_PATH], { timeout: 5000 });
    }
  } catch (e) {
    process.stderr.write(`[watcher] markLabelError failed: ${e.message}\n`);
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
    process.stdout.write(`🌶️ *dispatch* [${label}] completed:\n\n${reply}\n`);
  } else {
    process.stdout.write(
      `🌶️ *dispatch* [${label}] completed (no reply captured)\n` +
      `Summary: ${fallbackSummary || 'none'}\n`
    );
  }
  process.exit(0);
}

// ── Watcher heartbeat interval ref ──────────────────────────────────────
// Populated after label is validated (in main body). Cleared on exit.
// The interval writes lastPing to labels.json so the watchdog guard in
// index.mjs knows this watcher process is alive and actively monitoring.
let _pingInterval = null;

// ── Sync on Exit ────────────────────────────────────────────
// Best-effort sync of labels.json with gateway state on every watcher exit.
// Ensures stale 'running' entries are reconciled promptly, preventing
// false positives from the stuck detector.
process.on('exit', () => {
  if (_pingInterval !== null) {
    clearInterval(_pingInterval);
    _pingInterval = null;
  }
  try {
    execFileSync(process.execPath, [INDEX_PATH, 'sync'], {
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

// ── Start heartbeat ─────────────────────────────────────────────────────
// Write lastPing to labels.json every PING_INTERVAL_MS while the session is
// still running. The watchdog guard in index.mjs reads lastPing to know this
// watcher process is alive — preventing premature auto-resolve during slow
// tool calls, docker builds, long pytest runs, etc.
// Cleared automatically by the process.on('exit') handler above.
//
// Race-condition note: loadLabels() always reads fresh from disk (no in-memory cache),
// so each heartbeat tick gets the latest state before patching only the lastPing field.
// The read-modify-write window is tiny (synchronous) and worst-case a concurrent writer
// wins one tick, which is benign — the next tick will re-establish the ping.
_pingInterval = setInterval(() => {
  try {
    const lbs = loadLabels();
    if (lbs[label]?.status === 'running') {
      lbs[label].lastPing = new Date().toISOString();
      saveLabels(lbs);
    }
  } catch {
    // Best-effort — never crash the watcher over a ping failure
  }
}, PING_INTERVAL_MS);
_pingInterval.unref(); // don't prevent Node.js from exiting naturally

const deadline = Date.now() + timeoutS * 1000;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;
let recoverySessionKey = null;  // captured during polling for steer/kill

// Track whether the session has EVER appeared in the gateway sessions list.
// Used to distinguish spawn failures (session never appeared) from normal
// completions (session appeared, ran, then cleaned up).
let sessionEverFound = false;

while (Date.now() < deadline) {
  const status = dispatch('status', ['--label', label]);

  if (!status?.ok) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      process.stdout.write(`⚠️ dispatch [${label}] watcher: gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive status failures\n`);
      process.exit(1);
    }
    await sleep(pollS * 1000);
    continue;
  }

  consecutiveFailures = 0;

  // Capture sessionKey for recovery steer/kill
  if (status.sessionKey) recoverySessionKey = status.sessionKey;

  // Track session presence — two independent signals, either is sufficient.
  // 1. Sessions.json store (primary ground truth for dispatcher-spawned sessions)
  // 2. Liveness field from dispatch status (secondary; also built from sessions.json
  //    in production, but test mocks may provide it directly)
  if (!sessionEverFound && status.sessionKey) {
    const sessionAgent = status.agent || 'main';
    const watcherStore = readSessionsStore(sessionAgent);
    if (watcherStore !== null && status.sessionKey in watcherStore) {
      // Found in sessions.json — authoritative
      sessionEverFound = true;
    } else if (status.liveness && !status.liveness.error) {
      // Not in sessions.json (or store unavailable) but liveness signal says alive —
      // session may still be initializing. Trust liveness as a secondary signal.
      sessionEverFound = true;
    }
  }

  // ── Path 0a: agent-side done signal (push-based) ──────────
  // If the agent ran `dispatch done --label <label>`, status is 'done' immediately.
  // This is the fast path — no need to poll for idle timeout.
  // (Handled by Path 1 below since cmdDone sets status='done' in labels.json)

  // ── Path 0b: 529/overload auto-retry ──────────────────────
  if (status.status === 'error') {
    const errorMsg = status.error || status.summary || '';
    if (is529Error(errorMsg)) {
      const retryCount = getRetryCount(label);
      const retryResult = attempt529Retry(label, retryCount, errorMsg);

      if (retryResult === false) {
        // Max retries exceeded — deliver error
        process.stdout.write(
          `🌶️ *dispatch* [${label}] failed after ${MAX_529_RETRIES} retries (529 overload)\n` +
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
          `🌶️ *dispatch* [${label}] 529 retry failed — could not respawn session\n` +
          `Error: ${errorMsg}\n`
        );
        process.exit(1);
      }
    }
  }

  // ── Path 1: status auto-resolved to done ──────────────────
  if (status.status !== 'running') {
    // ── Spawn failure detection ─────────────────────────────────────────
    // If the session was auto-resolved to 'done' (or 'spawn-warning') but was
    // never seen in the gateway, it never ran — this is a spawn failure.
    // Causes: auth timeout, quota exhaustion, gateway error at spawn time.
    if (!sessionEverFound && (status.status === 'done' || status.status === 'spawn-warning')) {
      const spawnErrMsg =
        `[dispatch] SPAWN FAILURE: session ${status.sessionKey || '(unknown)'} never appeared ` +
        `in gateway — spawn likely failed (auth timeout, quota, or gateway error). Label: ${label}`;
      process.stderr.write(spawnErrMsg + '\n');
      markLabelError(label, `spawn-failure: session never appeared in gateway`);
      process.stdout.write(
        `🌶️ *dispatch* [${label}] SPAWN FAILURE: session never appeared in gateway — ` +
        `spawn likely failed (auth timeout, quota, or gateway error)\n`
      );
      process.exit(1);
    }

    // ── Gateway-restart-kill detection ──────────────────────────────────
    // When a gateway restart kills an in-flight session, the session disappears
    // from sessions.json and the status command auto-resolves it as 'done' with
    // a "session not found in sessions store" summary. This is NOT a real
    // completion — the task was interrupted mid-run. Detect this pattern and
    // re-dispatch up to MAX_GW_RESTART_RETRIES times.
    //
    // Key distinction vs spawn failure:
    //   spawn failure:          sessionEverFound=false (session never appeared)
    //   gateway-restart-kill:   sessionEverFound=true  (session ran, then was killed)
    //
    // If the session DID produce a lastReply before being killed, deliver it normally.
    if (sessionEverFound && isGatewayRestartKill(status.summary)) {
      const gwCheckResult = dispatch('result', ['--label', label]);
      if (!gwCheckResult?.lastReply) {
        // No result captured — session was killed before completing
        const retryCount = getGwRestartRetryCount(label);
        if (retryCount >= MAX_GW_RESTART_RETRIES) {
          markLabelError(label,
            `gateway-restart-kill: max retries exceeded (${retryCount}x — ${status.summary})`);
          notify(`🌶️ Dispatch: [${label}] gateway-restart-kill: max retries exceeded (${MAX_GW_RESTART_RETRIES}x)`);
          process.stdout.write(
            `🌶️ *dispatch* [${label}] failed: session killed by gateway restart, ` +
            `max retries (${MAX_GW_RESTART_RETRIES}) exceeded\n` +
            `Summary: ${status.summary}\n`
          );
          process.exit(1);
        }
        const newRetryCount = retryCount + 1;
        process.stderr.write(
          `[watcher] gateway-restart-kill detected for [${label}] — ` +
          `attempt ${newRetryCount}/${MAX_GW_RESTART_RETRIES}\n`
        );
        notify(
          `🌶️ Dispatch: [${label}] session killed by gateway restart — ` +
          `re-dispatching (${newRetryCount}/${MAX_GW_RESTART_RETRIES})`
        );
        setGwRestartRetryCount(label, newRetryCount);
        if (respawnAfterGwRestart(label)) {
          process.stderr.write(
            `[watcher] [${label}] gw-restart retry ${newRetryCount} dispatched, continuing poll...\n`
          );
          await sleep(pollS * 1000);
          continue;
        } else {
          markLabelError(label,
            `gateway-restart-kill: respawn failed (attempt ${newRetryCount})`);
          process.stdout.write(
            `🌶️ *dispatch* [${label}] failed: session killed by gateway restart, respawn failed\n`
          );
          process.exit(1);
        }
      }
      // lastReply present — session completed before/during kill; fall through to normal delivery
    }

    // Reset gw-restart retry count on successful completion
    const gwRetryCount = getGwRestartRetryCount(label);
    if (gwRetryCount > 0) {
      setGwRestartRetryCount(label, 0);
      process.stderr.write(
        `[watcher] [${label}] completed after ${gwRetryCount} gw-restart retry(ies), reset gwRestartRetryCount\n`
      );
    }

    // Reset 529 retryCount on successful completion
    if (status.status === 'done') {
      const currentRetryCount = getRetryCount(label);
      if (currentRetryCount > 0) {
        setRetryCount(label, 0);
        process.stderr.write(`[watcher] [${label}] completed after ${currentRetryCount} retry(ies), reset retryCount\n`);
      }
    }
    const result = dispatch('result', ['--label', label]);
    deliverResult(label, result?.lastReply, status.summary);
  }

  // ── Path 2: status says 'running' but session may be idle ─
  // If the session has no recent activity, proactively check for a result.
  // This catches the gap where the session completed but status hasn't
  // auto-resolved yet. The watchdog guard in index.mjs defers auto-resolve
  // while this watcher's lastPing heartbeat is fresh (written every 60s);
  // this path handles normal completion before the ping goes stale.
  const ageMs = status.liveness?.ageMs;
  if (ageMs != null && ageMs >= IDLE_RESULT_CHECK_MS) {
    const result = dispatch('result', ['--label', label]);
    if (result?.lastReply) {
      deliverResult(label, result.lastReply, null);
    }
  }


  await sleep(pollS * 1000);
}

// Timed out — try one last result check
const finalResult = dispatch('result', ['--label', label]);
const finalStatus = dispatch('status', ['--label', label]);
if (finalResult?.lastReply) {
  const rc = getRetryCount(label);
  if (rc > 0) setRetryCount(label, 0);
  deliverResult(label, finalResult.lastReply, finalStatus?.summary || null);
}
// If status is explicitly done, exit cleanly even without lastReply
if (finalStatus?.status === 'done') {
  markDoneSync(finalStatus?.summary || 'completed');
  process.stdout.write(`✅ dispatch [${label}] completed (status=done, no lastReply captured)\n`);
  process.exit(0);
}

// ── Token-based activity check before steering ────────────────────────────
// Only steer if tokens have been flat for 3+ minutes post-deadline.
// If the session is still making model calls (tokens growing), stay silent.
function getTokenCount(sessionKey) {
  const gatewayTokens = sessionKey ? getSessionTokens(sessionKey) : null;
  if (typeof gatewayTokens === 'number') return gatewayTokens;
  try {
    const result = dispatch('status', ['--label', label]);
    // sessions.list via gateway would be better but dispatch status has liveness
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

const statusAtDeadline = dispatch('status', ['--label', label]);
let tokenSessionKey = statusAtDeadline?.sessionKey || recoverySessionKey || null;
let baselineTokens = getTokenCount(tokenSessionKey);
let flatSince = Date.now();

process.stderr.write(`[watcher] deadline hit for ${label} — watching token activity (baseline: ${baselineTokens})\n`);

// If the session already completed (gateway pruned it → null tokens), exit cleanly.
if (statusAtDeadline?.status === 'done' || baselineTokens === null) {
  const r = dispatch('result', ['--label', label]);
  if (r?.lastReply) {
    markDoneSync('completed before deadline monitoring');
    deliverResult(label, r.lastReply, statusAtDeadline?.summary || null);
    process.exit(0);
  }
  // Status is explicitly done — exit cleanly, no timeout noise
  if (statusAtDeadline?.status === 'done') {
    markDoneSync(statusAtDeadline?.summary || 'completed');
    process.stdout.write(`✅ dispatch [${label}] completed (status=done at deadline)\n`);
    process.exit(0);
  }
  // Truly no result and no tokens — telemetry unavailable
  if (baselineTokens === null) {
    // Check if session is actually in the store (just mid-tool-call with no tokens yet)
    const entry = getSessionStoreEntry(tokenSessionKey);
    if (!entry) {
      // Session truly not found — telemetry unavailable, exit
      process.stderr.write(`[watcher] token telemetry unavailable for ${label}; session not in store\n`);
      markLabelError(label, `timed out after ${timeoutS}s — token telemetry unavailable`);
      process.stdout.write(`⏱ dispatch [${label}] timed out after ${timeoutS}s — token telemetry unavailable; no steer/kill attempted\n`);
      process.exit(1);
    }
    // Session IS in store but no tokens — mid-tool-call, fall through to activity window
    // Use updatedAt as activity signal instead of tokens
    process.stderr.write(`[watcher] ${label} in store but no tokens (mid-tool-call?) — using updatedAt as activity signal\n`);
    baselineTokens = -1; // sentinel: token-free mode
  }
}

while (Date.now() - flatSince < FLAT_WINDOW_MS) {
  await sleep(ACTIVITY_POLL_MS);

  // Delivered?
  const st = dispatch('status', ['--label', label]);
  if (st?.sessionKey && !tokenSessionKey) tokenSessionKey = st.sessionKey;
  if (st?.status === 'done') {
    const r = dispatch('result', ['--label', label]);
    markDoneSync('completed during activity window');
    deliverResult(label, r?.lastReply, st.summary);
  }
  const r2 = dispatch('result', ['--label', label]);
  if (r2?.lastReply) {
    markDoneSync('completed during activity window');
    deliverResult(label, r2.lastReply, null);
  }

  // Token growth?
  const cur = getTokenCount(tokenSessionKey);
  if (cur === null) {
    // Check updatedAt as fallback — if session is still in store and recently updated, keep waiting
    const entry = getSessionStoreEntry(tokenSessionKey);
    if (!entry) {
      process.stderr.write(`[watcher] token telemetry lost for ${label}; session gone from store\n`);
      markLabelError(label, `timed out after ${timeoutS}s — token telemetry lost`);
      process.stdout.write(`⏱ dispatch [${label}] timed out after ${timeoutS}s — token telemetry lost; no steer/kill attempted\n`);
      process.exit(1);
    }
    // Still in store — check if updatedAt advanced (tool call still running)
    const updatedAt = entry.updatedAt;
    if (typeof updatedAt === 'number' && updatedAt > flatSince) {
      process.stderr.write(`[watcher] ${label} no tokens but updatedAt advanced — tool call active, resetting flat timer\n`);
      flatSince = Date.now();
    } else {
      process.stderr.write(`[watcher] ${label} no tokens, updatedAt not advancing — may be stuck\n`);
    }
    // Don't exit — let FLAT_WINDOW_MS timeout handle the stuck case normally
    continue;
  }
  // Normal token comparison (skip if in token-free sentinel mode)
  if (baselineTokens !== -1 && cur > baselineTokens) {
    process.stderr.write(`[watcher] ${label} still active (${baselineTokens}→${cur} tokens), resetting flat timer\n`);
    baselineTokens = cur;
    flatSince = Date.now();
  } else if (baselineTokens === -1 && cur > 0) {
    // Tokens appeared for the first time — switch from sentinel to real token tracking
    process.stderr.write(`[watcher] ${label} tokens now available (${cur}), switching to token tracking\n`);
    baselineTokens = cur;
    flatSince = Date.now();
  }
}

// 3 min of genuinely flat tokens — now steer
process.stderr.write(`[watcher] ${label} inactive 3min post-deadline — entering steer\n`);

// Get sessionKey for steer/kill
const statusForSteer = dispatch('status', ['--label', label]);
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

  const st2 = dispatch('status', ['--label', label]);
  if (st2?.status === 'done') {
    const r3 = dispatch('result', ['--label', label]);
    markDoneSync('completed during steer recovery');
    deliverResult(label, r3?.lastReply, st2.summary);
  }
  const r3 = dispatch('result', ['--label', label]);
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
      const st3 = dispatch('status', ['--label', label]);
      if (st3?.status === 'done') {
        markLabelError(label, 'timed out — killed after steer attempts (no result captured)');
        process.stdout.write(`⏱ dispatch [${label}] killed after steer attempts — no result captured\n`);
        process.exit(1);
      }
    }
  }
}

markLabelError(label, `timed out after ${timeoutS}s — killed after steer attempts`);
process.stdout.write(`⏱ dispatch [${label}] timed out after ${timeoutS}s — session killed after steer attempts\n`);
process.exit(1);
