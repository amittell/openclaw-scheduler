#!/usr/bin/env node
/**
 * dispatch watcher -- polls a session until done, outputs the result.
 *
 * Used by scheduler shell jobs for async delivery with retry + audit trail.
 * The scheduler runs this as a shell job with delivery_mode='announce-always',
 * so stdout is delivered via handleDelivery (retry, alias, audit).
 *
 * Detection strategy:
 *   1. Check `status --label` -- if auto-resolved to 'done', use it
 *   2. If status says 'running' but session is idle (no activity for >60s),
 *      also check `result --label` for a lastReply -- if found, session completed
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
 *   0 -- session completed, result on stdout
 *   1 -- timeout or error
 *   2 -- argument error
 */

import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  extractTerminalAssistantReplyFromEntries,
  hasCompletionSignal,
  resolveCompletionDelivery,
} from './completion.mjs';
import {
  claimCompletionDelivery,
  enqueueCompletionNotification,
  recordCompletionDelivered,
  recordCompletionDeliveryDebt,
} from './hooks.mjs';
import { getDispatchLivenessPolicy } from './liveness.mjs';
import { resolveLabelsPath } from './paths.mjs';
import { assertRouteMatchesSource, parseOriginRoute, parseSourceContext } from './source-context.mjs';
import { sendMessage } from '../messages.js';
import { ensureArtifactsDir, resolveArtifactsDir } from '../paths.js';
import {
  agentIdFromSessionKey as validatedAgentIdFromSessionKey,
  assertValidAgentId,
  assertValidSessionId,
  assertValidSessionKey,
  assertValidSessionStore,
  assertSessionKeyForAgent,
  resolveAgentSessionsStorePath,
  resolveSessionTranscriptPath,
  toNullPrototypeRecord,
} from '../identifiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = process.env.DISPATCH_INDEX_PATH || join(__dirname, 'index.mjs');
const LABELS_PATH = resolveLabelsPath({ legacyCandidates: [join(__dirname, 'labels.json')] });
const HOME_DIR = process.env.HOME || homedir();
let labelsCache = null;
let labelsCacheSignature = null;
let labelsCacheError = null;

const MAX_529_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30000; // 30 seconds

const MAX_GW_RESTART_RETRIES = 2; // Max retries for gateway-restart-kill recovery

const FLAT_WINDOW_MS = 3 * 60 * 1000; // 3 min flat = genuinely stuck
const ACTIVITY_POLL_MS = 30_000;
const COMPLETION_INLINE_LIMIT_BYTES = parsePositiveEnvInt('DISPATCH_COMPLETION_INLINE_LIMIT_BYTES', 60 * 1024);

/** How often the watcher writes lastPing to labels.json (heartbeat signal).
 *  The watchdog guard in index.mjs treats pings older than 3x this as stale,
 *  so PING_INTERVAL_MS must stay well below PING_STALE_MS (3 * 60_000). */
const PING_INTERVAL_MS = 60_000; // 60 seconds

function parsePositiveEnvInt(name, fallback) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function sliceUtf8Bytes(text, maxBytes) {
  const source = String(text ?? '');
  if (byteLength(source) <= maxBytes) return source;

  let usedBytes = 0;
  let endIndex = 0;
  for (const char of source) {
    const charBytes = byteLength(char);
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    endIndex += char.length;
  }
  return source.slice(0, endIndex).trimEnd();
}

function completionArtifactPath(label) {
  const safeLabel = String(label || 'completion')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'completion';
  const dir = ensureArtifactsDir(join(resolveArtifactsDir({ env: process.env }), 'dispatch-completions'));
  return join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}.txt`);
}

function formatCompletionStdout(label, deliveryText) {
  const header = `🌶️ *dispatch* [${label}] completed:\n\n`;
  const body = String(deliveryText ?? '');
  const bodyBytes = byteLength(body);

  if (bodyBytes <= COMPLETION_INLINE_LIMIT_BYTES) {
    return `${header}${body}\n`;
  }

  let artifactNote;
  try {
    const artifactPath = completionArtifactPath(label);
    writeFileSync(artifactPath, body, 'utf8');
    artifactNote = `\n\nFull completion report saved to ${artifactPath} (${bodyBytes} bytes). Inline delivery capped at ${COMPLETION_INLINE_LIMIT_BYTES} bytes to avoid dumping an oversized report.`;
  } catch (err) {
    artifactNote = `\n\nFull completion report was ${bodyBytes} bytes, but saving the oversized report failed: ${err.message}. Inline delivery capped at ${COMPLETION_INLINE_LIMIT_BYTES} bytes.`;
  }

  const bodyBudget = Math.max(0, COMPLETION_INLINE_LIMIT_BYTES - byteLength(artifactNote));
  const inlineBody = sliceUtf8Bytes(body, bodyBudget);
  return `${header}${inlineBody}${artifactNote}\n`;
}

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

// -- Gateway RPC (sync, matches index.mjs pattern) -----------

/**
 * Sync gateway RPC call via `openclaw gateway call`.
 * Returns parsed JSON or null on failure.
 */
function gatewayCall(method, params = {}, opts = {}) {
  const timeout = opts.timeout || 15000;
  const args = ['gateway', 'call', method, '--json'];
  args.push('--params', JSON.stringify(params));
  args.push('--timeout', String(timeout));
  const childEnv = GW_TOKEN ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: GW_TOKEN } : process.env;

  try {
    const result = execFileSync('openclaw', args, {
      encoding: 'utf-8',
      timeout: timeout + 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    return JSON.parse(result.trim());
  } catch (err) {
    const stdout = err.stdout?.trim() || '';
    if (stdout) try { return JSON.parse(stdout); } catch {}
    return null;
  }
}

function agentFromSessionKey(sessionKey, fallbackAgentId = 'main') {
  try {
    return validatedAgentIdFromSessionKey(sessionKey, fallbackAgentId, 'watcher sessionKey');
  } catch (error) {
    process.stderr.write(`[watcher] refusing unsafe session metadata: ${error.message}\n`);
    return null;
  }
}

/**
 * Get current totalTokens for a session.
 * Tries sessions.json first (ground truth), falls back to sessions.list API.
 * Returns number or null if unavailable.
 */
function getSessionTokens(sessionKey) {
  try {
    assertValidSessionKey(sessionKey, 'watcher sessionKey');
  } catch (error) {
    process.stderr.write(`[watcher] refusing unsafe session metadata: ${error.message}\n`);
    return null;
  }
  // Primary: sessions.json direct read
  const agent = agentFromSessionKey(sessionKey);
  if (!agent) return null;
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
  let agent;
  try {
    agent = agentFromSessionKey(sessionKey);
    if (!agent) return null;
  } catch (error) {
    process.stderr.write(`[watcher] refusing unsafe session metadata: ${error.message}\n`);
    return null;
  }
  const store = readSessionsStore(agent);
  return (store && sessionKey in store) ? store[sessionKey] : null;
}

/** Parse --flag value pairs from argv (supports both --flag value and --flag=value) */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx > 0) {
        flags[a.slice(2, eqIdx)] = a.slice(eqIdx + 1);
      } else if (next && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
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

// -- 529/Overload Detection & Retry --------------------------

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
function getLabelsSignature() {
  try {
    const stats = statSync(LABELS_PATH);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

function assertValidWatcherLabelMetadata(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`label ${JSON.stringify(name)} must contain an object`);
  }
  const explicitAgent = entry.agent === null || entry.agent === undefined
    ? null
    : assertValidAgentId(entry.agent, `agent for label ${JSON.stringify(name)}`);
  const sessionKey = entry.sessionKey === null || entry.sessionKey === undefined
    ? null
    : assertValidSessionKey(entry.sessionKey, `sessionKey for label ${JSON.stringify(name)}`);
  if (entry.sessionId !== null && entry.sessionId !== undefined) {
    assertValidSessionId(entry.sessionId, `sessionId for label ${JSON.stringify(name)}`);
  }
  if (sessionKey?.startsWith('agent:') && explicitAgent) {
    assertSessionKeyForAgent(sessionKey, explicitAgent, `sessionKey for label ${JSON.stringify(name)}`);
  }
  if (entry.sourceContext != null) {
    const source = parseSourceContext(entry.sourceContext, `sourceContext for label ${JSON.stringify(name)}`);
    assertRouteMatchesSource(
      source,
      entry.deliverChannel,
      entry.deliverTo,
      `delivery route for label ${JSON.stringify(name)}`,
    );
    const origin = parseOriginRoute(entry.origin, `origin for label ${JSON.stringify(name)}`);
    if (!origin) throw new Error(`origin for label ${JSON.stringify(name)} must match sourceContext`);
    assertRouteMatchesSource(source, origin.channel, origin.target, `origin for label ${JSON.stringify(name)}`);
  }
  return entry;
}

function rejectUnsafeWatcherMetadata(labels) {
  let changed = false;
  for (const [name, candidate] of Object.entries(labels)) {
    try {
      assertValidWatcherLabelMetadata(name, candidate);
    } catch (error) {
      const reason = `Rejected unsafe legacy session metadata for label ${JSON.stringify(name)}: ${error.message}`;
      const entry = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate
        : {};
      delete entry.agent;
      delete entry.sessionKey;
      delete entry.sessionId;
      delete entry.origin;
      delete entry.deliverTo;
      delete entry.deliverChannel;
      delete entry.sourceContext;
      entry.deliveryMode = 'none';
      entry.deliveryDisabled = true;
      entry.deliveryDisabledReason = 'unsafe persisted routing metadata';
      entry.status = 'error';
      entry.error = reason;
      entry.summary = reason;
      entry.metadataRejectedAt = new Date().toISOString();
      labels[name] = entry;
      process.stderr.write(`[watcher] ${reason}\n`);
      changed = true;
    }
  }
  return changed;
}

function loadLabels() {
  const signature = getLabelsSignature();
  if (labelsCache && labelsCacheSignature === signature) {
    return labelsCache;
  }
  try {
    const labels = toNullPrototypeRecord(
      JSON.parse(readFileSync(LABELS_PATH, 'utf-8')),
      'labels ledger',
    );
    if (rejectUnsafeWatcherMetadata(labels)) {
      saveLabels(labels);
      return labels;
    }
    labelsCache = labels;
    labelsCacheSignature = signature;
    labelsCacheError = null;
    return labels;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      process.stderr.write(`[watcher] Refusing invalid labels ledger: ${error.message}\n`);
      labelsCacheError = error;
    } else {
      labelsCacheError = null;
    }
    labelsCache = Object.create(null);
    labelsCacheSignature = signature;
    return labelsCache;
  }
}

/**
 * Save labels.json directly.
 */
function saveLabels(labels) {
  const tmp = LABELS_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
  renameSync(tmp, LABELS_PATH);
  labelsCache = labels;
  labelsCacheSignature = getLabelsSignature();
  labelsCacheError = null;
}

function mutateLabels(mutator) {
  const labels = loadLabels();
  if (labelsCacheError) {
    throw new Error(
      `Refusing to mutate invalid labels ledger: ${labelsCacheError.message}`,
      { cause: labelsCacheError },
    );
  }
  const changed = mutator(labels);
  if (changed !== false) {
    saveLabels(labels);
  }
  return labels;
}

function updateExistingLabel(label, mutator) {
  return mutateLabels((labels) => {
    if (!labels[label]) return false;
    const changed = mutator(labels[label], labels);
    if (changed === false) return false;
    labels[label].updatedAt = new Date().toISOString();
    return true;
  });
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
  updateExistingLabel(label, (entry) => {
    entry.retryCount = count;
  });
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
  updateExistingLabel(label, (entry) => {
    entry.gwRestartRetryCount = count;
  });
}

/**
 * Send a notification via the scheduler messages table.
 */
function notify(message) {
  if (process.env.OPENCLAW_SCHEDULER_NOTIFY_DISABLED === '1') {
    process.stderr.write(`[watcher] notify suppressed (test mode): ${message}\n`);
    return;
  }
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
    updateExistingLabel(label, (entry) => {
      entry.status = 'error';
      entry.error = `max_retries_exceeded (${retryCount}x 529): ${errorMsg}`;
    });
    notify(`🌶️ Dispatch: [${label}] hit max retries (${MAX_529_RETRIES}x 529 overload) -- giving up`);
    return { retry: false };
  }

  const newRetryCount = retryCount + 1;
  const delayMs = RETRY_BASE_DELAY_MS * newRetryCount;

  process.stderr.write(
    `[watcher] 529 detected for [${label}] (attempt ${newRetryCount}/${MAX_529_RETRIES}). ` +
    `Waiting ${delayMs / 1000}s before retry...\n`
  );
  notify(`🌶️ Dispatch: [${label}] hit 529 overload -- retry ${newRetryCount}/${MAX_529_RETRIES} in ${delayMs / 1000}s`);

  // Update retryCount in labels.json BEFORE sleeping (persist intent)
  setRetryCount(label, newRetryCount);

  return { retry: true, delayMs, newRetryCount };
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

    // Reload labels after execFileSync (child may have modified labels.json)
    updateExistingLabel(label, (entry) => {
      entry.status = 'running';
      entry.error = null;
    });

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
      if (entry?.origin) enqueueArgs.push('--origin', entry.origin);
      if (entry?.sourceContext) enqueueArgs.push('--source-context', JSON.stringify(entry.sourceContext));
      if (entry?.deliverTo) {
        enqueueArgs.push('--deliver-to', entry.deliverTo);
        if (entry?.deliveryMode) enqueueArgs.push('--delivery-mode', entry.deliveryMode);
        if (entry?.deliverChannel) enqueueArgs.push('--deliver-channel', entry.deliverChannel);
      }

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
    if (entry?.origin) enqueueArgs.push('--origin', entry.origin);
    if (entry?.sourceContext) enqueueArgs.push('--source-context', JSON.stringify(entry.sourceContext));
    if (entry?.deliverTo) {
      enqueueArgs.push('--deliver-to', entry.deliverTo);
      if (entry?.deliveryMode) enqueueArgs.push('--delivery-mode', entry.deliveryMode);
      if (entry?.deliverChannel) enqueueArgs.push('--deliver-channel', entry.deliverChannel);
    }

    execFileSync(process.execPath, enqueueArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // enqueue sets the label to 'running' with a new sessionKey -- also reset error field
    updateExistingLabel(label, (entry) => {
      entry.error = null;
    });

    process.stderr.write(`[watcher] respawned [${label}] via fresh enqueue after gateway restart\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[watcher] respawn after gw restart failed: ${err.message}\n`);
    return false;
  }
}

// -- Gateway Steer & Kill -------------------------------------

/**
 * Send a steer message into a running session via gateway API (sync).
 */
function steerSession(sessionKey, message) {
  try {
    sessionKey = assertValidSessionKey(sessionKey, 'watcher steer sessionKey');
  } catch (error) {
    process.stderr.write(`[watcher] steer refused unsafe session metadata: ${error.message}\n`);
    return false;
  }
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
  try {
    sessionKey = assertValidSessionKey(sessionKey, 'watcher kill sessionKey');
  } catch (error) {
    process.stderr.write(`[watcher] kill refused unsafe session metadata: ${error.message}\n`);
    return false;
  }
  if (!GW_TOKEN) {
    process.stderr.write(`[watcher] kill skipped: no gateway token\n`);
    return false;
  }
  try {
    gatewayCall('subagents.kill', { target: sessionKey }, { timeout: 10000 });
    return true;
  } catch (err) {
    process.stderr.write(`[watcher] kill failed: ${err.message}\n`);
    return false;
  }
}

/**
 * Read the sessions.json store for an agent directly from disk.
 * Primary ground truth for session state -- sessions spawned via dispatcher
 * HTTP agent endpoint appear here but NOT in sessions_list API results.
 *
 * @param {string} agent - Agent ID (default: 'main')
 * @returns {Object|null} - Sessions store object, or null on read error
 */
function readSessionsStore(agent = 'main') {
  let sessionsPath;
  try {
    sessionsPath = resolveAgentSessionsStorePath(HOME_DIR, agent);
  } catch (error) {
    process.stderr.write(`[watcher] refusing unsafe sessions store path: ${error.message}\n`);
    return null;
  }
  try {
    return assertValidSessionStore(
      JSON.parse(readFileSync(sessionsPath, 'utf-8')),
      `sessions store for agent ${JSON.stringify(agent)}`,
    );
  } catch (error) {
    if (error instanceof SyntaxError || error?.code) return null;
    process.stderr.write(`[watcher] refusing unsafe sessions store metadata: ${error.message}\n`);
    return null;
  }
}

/**
 * Get the mtime (in milliseconds) of a session's JSONL file.
 *
 * Unlike sessions.json (which is NOT flushed during active turns), the JSONL
 * file at ~/.openclaw/agents/<agentDir>/sessions/<sessionId>.jsonl is written
 * continuously as the session processes messages. Use this as a reliable
 * activity signal when totalTokens and updatedAt are flat.
 *
 * Fix rationale: for spawned subagent sessions, OpenClaw does NOT flush
 * totalTokens or updatedAt during active turns -- so sessions.json stays stale
 * while the session is actively working. The JSONL mtime advances on every
 * tool call, model reply, and streaming chunk, making it a much more reliable
 * liveness signal. Without this, the watcher hits FLAT_WINDOW_MS mid-turn and
 * marks the session done prematurely, causing zombie sessions with no delivery.
 *
 * @param {string} sessionId - Internal session UUID (entry.sessionId from sessions.json)
 * @param {string} agentDir - Agent directory (default: 'main')
 * @returns {number|null} mtimeMs if file exists, null otherwise
 */
function getSessionJsonlMtime(sessionId, agentDir = 'main') {
  if (!sessionId) return null;
  try {
    const jsonlPath = resolveSessionTranscriptPath(HOME_DIR, agentDir, sessionId);
    return statSync(jsonlPath).mtimeMs;
  } catch (error) {
    if (!error?.code) {
      process.stderr.write(`[watcher] refusing unsafe session transcript path: ${error.message}\n`);
    }
    return null;
  }
}


/**
 * Read the last N non-empty lines from a session's JSONL file and return them
 * as parsed objects. Returns null if file doesn't exist or is unreadable.
 *
 * @param {string} sessionId - Internal session UUID
 * @param {string} agentDir - Agent directory (default: 'main')
 * @param {number} n - Number of lines to read from end (default: 3)
 * @returns {Array|null} parsed JSON objects, or null
 */
function readJsonlLastLines(sessionId, agentDir = 'main', n = 3) {
  if (!sessionId) return null;
  try {
    const jsonlPath = resolveSessionTranscriptPath(HOME_DIR, agentDir, sessionId);
    const content = readFileSync(jsonlPath, 'utf-8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (error) {
    if (!error?.code) {
      process.stderr.write(`[watcher] refusing unsafe session transcript path: ${error.message}\n`);
    }
    return null;
  }
}

function readJsonlTailEntries(sessionId, agentDir = 'main', n = 200) {
  return readJsonlLastLines(sessionId, agentDir, n);
}

function getSessionTerminalReply(sessionId, agentDir = 'main') {
  const entries = readJsonlTailEntries(sessionId, agentDir, 200);
  return extractTerminalAssistantReplyFromEntries(entries);
}

function formatDiagnosticSnippet(reply) {
  if (!reply || typeof reply !== 'string') return '';
  const normalized = reply.trim();
  if (!normalized) return '';

  const maxLen = 1200;
  const clipped = normalized.length > maxLen
    ? normalized.slice(0, maxLen) + '\n\n..[truncated]'
    : normalized;

  return `\n\nLast assistant report observed:\n${clipped}`;
}

function contentHasTurnAbortMarker(content) {
  if (!content) return false;
  if (typeof content === 'string') return content.includes('<turn_aborted>');
  if (!Array.isArray(content)) return false;
  return content.some(part => {
    const text = part?.text || part?.input_text || part?.content || '';
    return typeof text === 'string' && text.includes('<turn_aborted>');
  });
}

function entryRole(entry) {
  return entry?.role
    || entry?.message?.role
    || entry?.payload?.role
    || entry?.payload?.message?.role
    || null;
}

function entryHasTurnAborted(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'turn_aborted') return true;
  if (entry.payload?.type === 'turn_aborted') return true;

  const role = entryRole(entry);
  if (role !== 'user') return false;
  return contentHasTurnAbortMarker(entry.content)
    || contentHasTurnAbortMarker(entry.message?.content)
    || contentHasTurnAbortMarker(entry.payload?.content)
    || contentHasTurnAbortMarker(entry.payload?.message?.content);
}

function entryStartsPostAbortActivity(entry) {
  if (!entry || typeof entry !== 'object' || entryHasTurnAborted(entry)) return false;
  const role = entryRole(entry);
  if (role === 'assistant' || role === 'user') return true;

  const payloadType = entry.payload?.type || null;
  return entry.type === 'response_item' && [
    'message',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
  ].includes(payloadType);
}

function getJsonlTurnAbortReasonFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entryHasTurnAborted(entry)) {
      const reason = entry?.payload?.reason || entry?.reason || 'interrupted';
      return `turn_aborted observed in session JSONL (${reason})`;
    }
    if (entryStartsPostAbortActivity(entry)) return null;
  }

  return null;
}

function entryArtifactEvidenceReason(entry) {
  if (!entry || typeof entry !== 'object') return null;

  if (entry.role === 'toolResult' && entry.isError !== true) {
    return 'successful tool result observed in JSONL';
  }
  if (entry.type === 'tool_result' && entry.isError !== true) {
    return 'successful tool result observed in JSONL';
  }

  const payload = entry.payload || {};
  if (payload.type === 'patch_apply_end' && payload.success === true) {
    return 'successful patch/tool event observed in JSONL';
  }
  if (payload.type === 'function_call_output') {
    return 'completed tool output observed in JSONL';
  }
  if (payload.type === 'custom_tool_call' && payload.status === 'completed') {
    return `completed tool call observed in JSONL${payload.name ? ` (${payload.name})` : ''}`;
  }
  if (payload.type === 'custom_tool_call_output') {
    const output = typeof payload.output === 'string' ? payload.output : '';
    if (!/aborted by user/i.test(output)) return 'completed tool output observed in JSONL';
  }

  if (Array.isArray(entry.content)) {
    const toolResult = entry.content.find(part => part?.type === 'tool_result' || part?.type === 'toolResult');
    if (toolResult && toolResult.isError !== true) return 'successful tool result observed in JSONL';
  }

  return null;
}

function getJsonlArtifactEvidenceFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const reason = entryArtifactEvidenceReason(entries[i]);
    if (reason) return { found: true, reason };
  }

  return null;
}

/**
 * Check if a session is currently mid-turn by inspecting its JSONL tail.
 * Returns a reason string if mid-turn is detected, null if safe to proceed.
 *
 * Mid-turn signals:
 *   - Last entry is role=assistant with content containing type=tool_use
 *     -> assistant dispatched a tool call, tool hasn't returned yet
 *   - Last entry is role=user with content containing type=tool_result
 *     -> tool result just delivered, assistant hasn't replied yet
 *   - JSONL modified within FLAT_WINDOW_MS (combined with above)
 *
 * Safe signals (return null):
 *   - JSONL doesn't exist or hasn't been modified in >FLAT_WINDOW_MS
 *   - Last assistant entry has type=text only (complete reply)
 *
 * @param {string} sessionId - Internal session UUID
 * @param {string} agentDir - Agent directory (default: 'main')
 * @returns {string|null} reason string if mid-turn, null if safe to proceed
 */
function getJsonlMidTurnReason(sessionId, agentDir = 'main') {
  if (!sessionId) return null;

  let jsonlPath;
  try {
    jsonlPath = resolveSessionTranscriptPath(HOME_DIR, agentDir, sessionId);
  } catch (error) {
    process.stderr.write(`[watcher] refusing unsafe session transcript path: ${error.message}\n`);
    return null;
  }
  let mtimeMs;
  try {
    mtimeMs = statSync(jsonlPath).mtimeMs;
  } catch {
    return null; // File doesn't exist -- session is genuinely gone, safe to proceed
  }

  // If JSONL hasn't been modified in >FLAT_WINDOW_MS, session isn't actively running
  if (Date.now() - mtimeMs > FLAT_WINDOW_MS) {
    return null;
  }

  const lastLines = readJsonlLastLines(sessionId, agentDir, 3);
  if (!lastLines || lastLines.length === 0) return null;

  const last = lastLines[lastLines.length - 1];

  // Check last entry: role=assistant with tool_use in content array
  // (assistant dispatched a tool call, awaiting tool result)
  if (last?.role === 'assistant') {
    const content = Array.isArray(last.content) ? last.content : [];
    const hasToolUse = content.some(c => c?.type === 'tool_use');
    if (hasToolUse) {
      const toolName = content.find(c => c?.type === 'tool_use')?.name || 'unknown';
      return `last assistant entry has tool_use (${toolName}) -- awaiting tool result`;
    }
    // Top-level type=tool_use (non-array content format)
    if (last.type === 'tool_use') {
      return `last entry is tool_use (${last.name || 'unknown'}) -- awaiting tool result`;
    }
  }

  // Check last entry: role=user with tool_result in content
  // (tool result just delivered, assistant hasn't replied yet)
  if (last?.role === 'user') {
    const content = Array.isArray(last.content) ? last.content : [];
    if (content.some(c => c?.type === 'tool_result')) {
      return 'last entry is tool_result (tool executed, awaiting assistant reply)';
    }
  }

  // Top-level type=tool_result (alternative format)
  if (last?.type === 'tool_result') {
    return 'last entry is tool_result (tool executed, awaiting assistant reply)';
  }

  return null; // Last assistant entry appears to be a complete text reply -- safe to proceed
}

/**
 * Check the JSONL tail for a pending tool handoff without requiring recent
 * file activity. Long-running tool calls can leave the transcript flat for
 * minutes, so stale mtime alone is not enough to declare the agent stuck.
 *
 * @param {string} sessionId - Internal session UUID
 * @param {string} agentDir - Agent directory (default: 'main')
 * @returns {string|null} reason string if a tool handoff appears pending
 */
function getJsonlPendingToolReason(sessionId, agentDir = 'main') {
  const lastLines = readJsonlLastLines(sessionId, agentDir, 3);
  if (!lastLines || lastLines.length === 0) return null;

  const last = lastLines[lastLines.length - 1];

  if (last?.role === 'assistant') {
    const content = Array.isArray(last.content) ? last.content : [];
    const toolUse = content.find(c => c?.type === 'tool_use');
    if (toolUse) {
      return `last assistant entry has tool_use (${toolUse.name || 'unknown'}) -- awaiting tool result`;
    }
    if (last.type === 'tool_use') {
      return `last entry is tool_use (${last.name || 'unknown'}) -- awaiting tool result`;
    }
  }

  if (last?.role === 'user') {
    const content = Array.isArray(last.content) ? last.content : [];
    if (content.some(c => c?.type === 'tool_result')) {
      return 'last entry is tool_result (tool executed, awaiting assistant reply)';
    }
  }

  if (last?.type === 'tool_result') {
    return 'last entry is tool_result (tool executed, awaiting assistant reply)';
  }

  return null;
}

function parseTimestampMs(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Detect an agent session that has stopped making progress even though the
 * watcher process itself is still alive and writing lastPing.
 *
 * This closes the failure mode where OpenClaw's Codex app-server retires a
 * timed-out turn, but dispatch status keeps reporting "running" because the
 * delivery watcher is still polling.
 */
function getRunningSessionStallReason(status, thresholdMs) {
  if (!status?.sessionKey) return null;

  const sessionAgent = agentFromSessionKey(status.sessionKey);
  const entry = getSessionStoreEntry(status.sessionKey);
  if (!entry) return null;

  const sessionId = entry.sessionId || null;
  const now = Date.now();
  const activityTimes = [
    parseTimestampMs(entry.updatedAt),
    parseTimestampMs(entry.lastActivityAt),
    parseTimestampMs(entry.sessionStartedAt),
    parseTimestampMs(entry.startedAt),
  ].filter(t => typeof t === 'number');

  const jsonlMtime = sessionId ? getSessionJsonlMtime(sessionId, sessionAgent) : null;
  if (typeof jsonlMtime === 'number') activityTimes.push(jsonlMtime);

  if (typeof status?.liveness?.ageMs === 'number' && status.liveness.ageMs < thresholdMs) {
    return null;
  }

  const lastActivityMs = activityTimes.length ? Math.max(...activityTimes) : null;
  if (lastActivityMs !== null && now - lastActivityMs < thresholdMs) {
    return null;
  }

  const pendingToolReason = sessionId ? getJsonlPendingToolReason(sessionId, sessionAgent) : null;
  if (pendingToolReason) {
    process.stderr.write(
      `[watcher] ${status.label || 'session'} stale telemetry but pending tool handoff detected: ${pendingToolReason}\n`
    );
    return null;
  }

  const idleMinutes = lastActivityMs === null
    ? Math.ceil(thresholdMs / 60000)
    : Math.max(1, Math.floor((now - lastActivityMs) / 60000));
  return (
    `agent session stalled: no session/jsonl activity for ~${idleMinutes}min ` +
    `while delivery watcher remained alive; likely app-server turn retired or stopped producing events`
  );
}

function getSessionJsonlEntriesFromStatus(status, maxLines = 200) {
  if (!status?.sessionKey) return null;

  const sessionAgent = agentFromSessionKey(status.sessionKey);
  const entry = getSessionStoreEntry(status.sessionKey);
  const sessionId = entry?.sessionId || status?.liveness?.sessionId || null;
  return sessionId ? readJsonlTailEntries(sessionId, sessionAgent, maxLines) : null;
}

function getSessionTurnAbortReason(status) {
  return getJsonlTurnAbortReasonFromEntries(getSessionJsonlEntriesFromStatus(status, 80));
}

function getSessionArtifactEvidence(status) {
  return getJsonlArtifactEvidenceFromEntries(getSessionJsonlEntriesFromStatus(status, 200));
}

function getInterruptedArtifactEvidence(result, status, verify = null) {
  if (verify?.configured && verify.ok) {
    return { found: true, reason: `verify-cmd passed (${verify.command || 'configured verification'})` };
  }
  if (result?.artifactEvidence?.found) return result.artifactEvidence;
  if (status?.artifactEvidence?.found) return status.artifactEvidence;
  return getSessionArtifactEvidence(status);
}

/**
 * Read the last assistant entry's stop_reason from the session JSONL.
 * Returns the stop_reason string (e.g. 'end_turn', 'tool_use') or null if unavailable.
 *
 * Uses readJsonlLastLines with n=10 to scan enough history to find the last
 * assistant message even if several tool_result entries follow it.
 *
 * @param {string} sessionId - Internal session UUID
 * @param {string} agentDir - Agent directory (default: 'main')
 * @returns {string|null} stop_reason string or null
 */
function getSessionStopReason(sessionId, agentDir = 'main') {
  const lastLines = readJsonlLastLines(sessionId, agentDir, 10);
  if (!lastLines) return null;
  // Walk backwards to find last role=assistant entry
  for (let i = lastLines.length - 1; i >= 0; i--) {
    const entry = lastLines[i];
    if (entry?.role === 'assistant') {
      return entry?.stop_reason ?? null;
    }
  }
  return null;
}

/**
 * Returns true if the session has cleanly finished with stop_reason=end_turn.
 * Requires:
 *   - stop_reason === 'end_turn' on the last assistant entry
 *   - getJsonlMidTurnReason() returns null (no in-flight tool calls or pending results)
 *
 * Used for Path 2a early delivery: skip FLAT_WINDOW_MS wait when session is
 * verifiably done via JSONL stop_reason signal.
 *
 * @param {string} sessionId - Internal session UUID
 * @param {string} agentDir - Agent directory (default: 'main')
 * @returns {boolean}
 */
function isSessionCleanlyFinished(sessionId, agentDir = 'main') {
  if (getJsonlMidTurnReason(sessionId, agentDir) !== null) return false;
  const stopReason = getSessionStopReason(sessionId, agentDir);
  return stopReason === 'end_turn';
}

/**
 * Update labels.json to mark the watched label as done (best-effort, atomic write).
 * Called before exit to ensure labels.json is reconciled even if sync fails.
 */
function markLabelDone(label, summary) {
  try {
    updateExistingLabel(label, (entry) => {
      if (entry.status === 'done') return false;
      entry.status = 'done';
      entry.summary = summary || entry.summary || null;
    });
  } catch (e) {
    process.stderr.write(`[watcher] markLabelDone failed: ${e.message}\n`);
  }
}

/**
 * Update labels.json to mark the watched label as 'error' (best-effort, atomic write).
 * Used instead of markLabelDone for sessions that did NOT complete
 * successfully: gateway-restart-kill, timeout with no result, spawn failure.
 * This ensures the scheduler run status reflects the true failure outcome.
 */
function markLabelError(label, errorSummary) {
  try {
    updateExistingLabel(label, (entry) => {
      if (entry.status === 'done') return false;
      entry.status = 'error';
      entry.error = errorSummary || 'failed without result';
      entry.summary = errorSummary || 'failed without result';
    });
  } catch (e) {
    process.stderr.write(`[watcher] markLabelError failed: ${e.message}\n`);
  }
}

function markLabelInterrupted(label, summary) {
  try {
    updateExistingLabel(label, (entry) => {
      if (entry.status === 'done') return false;
      entry.status = 'interrupted';
      entry.summary = summary || 'interrupted before clean completion';
      delete entry.error;
    });
  } catch (e) {
    process.stderr.write(`[watcher] markLabelInterrupted failed: ${e.message}\n`);
  }
}

function getLabelEntry(label) {
  try {
    const labels = loadLabels();
    return labels[label] || null;
  } catch (err) {
    process.stderr.write(`[watcher] label load failed for ${label}: ${err.message}\n`);
    return null;
  }
}

function runVerifyCmd(label, entry) {
  if (!entry?.verifyCmd) return { configured: false, ok: false };

  process.stderr.write(`[watcher] running verify-cmd for ${label}: ${entry.verifyCmd}\n`);
  try {
    execSync(entry.verifyCmd, { stdio: 'pipe', timeout: 60000, shell: true });
    process.stderr.write(`[watcher] verify-cmd passed for ${label}\n`);
    return { configured: true, ok: true, command: entry.verifyCmd };
  } catch (verifyErr) {
    const stderr = verifyErr.stderr ? verifyErr.stderr.toString().trim() : verifyErr.message;
    const message = stderr || `exit code ${verifyErr.status ?? 1}`;
    process.stderr.write(`[watcher] verify-cmd failed: ${message}\n`);
    return { configured: true, ok: false, message, command: entry.verifyCmd };
  }
}

let exitZeroOnTerminal = false;

/**
 * Format and output the delivery message, then exit 0.
 * Also marks the label as done in labels.json before exiting.
 *
 * If the label has a verifyCmd stored, it is run first.
 * If the verify command exits non-zero, the job is marked as error and
 * an alert is written to stdout (delivery target receives the failure notice).
 */
function deliverResult(label, lastReply, fallbackSummary, completionPayload = null) {
  // -- verify-cmd check -----------------------------------------------------
  // Run the stored verify-cmd (if any) before declaring the job done.
  // A non-zero exit flips the job to error state and sends an alert instead.
  const entry = getLabelEntry(label);
  const verify = runVerifyCmd(label, entry);
  if (verify.configured && !verify.ok) {
    const errMsg = `verify-cmd failed: ${verify.message || 'non-zero exit'}`;
    markLabelError(label, errMsg);
    // Output failure notice -- scheduler delivers this to the delivery target
    process.stdout.write(
      `🌶️ *dispatch* [${label}] ⚠️ VERIFICATION FAILED\n\n` +
      `The agent session completed but the post-completion verify-cmd exited non-zero.\n\n` +
      `**Verify command:** \`${entry.verifyCmd}\`\n` +
      `**Error:** ${verify.message || 'non-zero exit'}\n\n` +
      `Job marked as \`error\`. The agent may have reported done without completing the actual work.\n`
    );
    process.exit(exitZeroOnTerminal ? 0 : 1);
  }

  // Every authoritative successful completion clears transient recovery debt.
  // Keeping this at the delivery boundary covers normal polling, once mode,
  // and the exact-deadline path uniformly.
  const retryCount = getRetryCount(label);
  if (retryCount > 0) setRetryCount(label, 0);
  const gatewayRetryCount = getGwRestartRetryCount(label);
  if (gatewayRetryCount > 0) setGwRestartRetryCount(label, 0);

  // Update labels.json before exiting -- prevents stuck detector false positives
  const completion = resolveCompletionDelivery({
    lastReply,
    completion: completionPayload,
    fallbackSummary,
  });
  markLabelDone(label, completion.summary);

  if (completion.deliveryText) {
    const claimEntry = getLabelEntry(label);
    if (claimEntry?.deliverTo && claimEntry?.deliveryMode !== 'none') {
      const deliveryResult = enqueueCompletionNotification({
        label,
        summary: completion.summary,
        completion: completionPayload,
        resolvedDelivery: completion,
        deliverTo: claimEntry.deliverTo,
        deliveryChannel: claimEntry.deliverChannel || 'telegram',
        sessionKey: claimEntry.sessionKey || null,
        runId: claimEntry.runId || null,
        origin: claimEntry.origin || null,
        sourceContext: claimEntry.sourceContext || null,
        metadata: {
          delivery_source: completion.source || 'watcher',
          last_label_status: claimEntry.status || 'done',
        },
      });
      if (deliveryResult.ok) {
        updateExistingLabel(label, (entry) => {
          entry.completionDeliveredAt = new Date().toISOString();
          entry.completionDeliverySource = completion.source || 'watcher';
          entry.completionOutboxIds = deliveryResult.outboxIds;
        });
      }
      if (
        deliveryResult.ok
        || deliveryResult.deduped
        || deliveryResult.reason === 'already-claimed'
      ) {
        markWatcherAlreadyDelivered(label);
        process.exit(0);
      }
      process.stderr.write(
        `[watcher] durable completion enqueue failed for ${label}: ` +
        `${deliveryResult.error || deliveryResult.reason || 'unknown error'}\n`,
      );
      process.exit(1);
    }

    // Atomic guard against the done-path (cmdDone) delivering the same
    // completion. The preflight completionDeliveredAt check narrows the window;
    // this claim closes it -- if the done-path already owns delivery, stand down.
    if (!claimCompletionDelivery({
      label,
      sessionKey: claimEntry?.sessionKey || null,
      runId: claimEntry?.runId || null,
    })) {
      markWatcherAlreadyDelivered(label);
    }
    updateExistingLabel(label, (entry) => {
      entry.completionDeliveredAt = new Date().toISOString();
      entry.completionDeliverySource = completion.source || 'watcher';
    });
    const deliveredEntry = getLabelEntry(label);
    recordCompletionDelivered({
      label,
      sessionKey: deliveredEntry?.sessionKey || null,
      runId: deliveredEntry?.runId || null,
      metadata: {
        delivery_source: completion.source || 'watcher',
        last_label_status: deliveredEntry?.status || 'done',
      },
    });
    process.stdout.write(formatCompletionStdout(label, completion.deliveryText));
    process.exit(0);
  }

  const failureSummary = 'completed without a clean user-facing completion';
  process.stderr.write(`[watcher] [${label}] completion delivery suppressed (no meaningful reply or summary)\n`);
  markLabelError(label, failureSummary);
  const failedEntry = getLabelEntry(label);
  recordCompletionDeliveryDebt({
    label,
    sessionKey: failedEntry?.sessionKey || null,
    runId: failedEntry?.runId || null,
    openReason: 'no-clean-user-facing-completion',
    noReply: true,
    metadata: {
      last_label_status: failedEntry?.status || 'done',
    },
  });
  process.stdout.write(
    `⚠️ dispatch [${label}] completed, but no clean user-facing completion was captured. ` +
    `Internal diagnostics were suppressed; check scheduler run logs for details.\n`
  );
  process.exit(exitZeroOnTerminal ? 0 : 1);
}

function emitInterruptedOutcome(label, summary, result = null) {
  process.stderr.write(`[watcher] [${label}] session auto-resolved as interrupted -- work may be incomplete\n`);
  const entry = getLabelEntry(label);
  const verify = runVerifyCmd(label, entry);
  const statusLike = result?.sessionKey
    ? {
        sessionKey: result.sessionKey,
        artifactEvidence: result?.artifactEvidence || null,
        liveness: result?.recovery?.sessionId ? { sessionId: result.recovery.sessionId } : null,
      }
    : null;
  const artifactEvidence = getInterruptedArtifactEvidence(result, statusLike, verify);
  if (verify.configured && verify.ok) {
    const recoveredReply = result?.lastReply || result?.diagnosticReply || null;
    const completionPayload = result?.completion || (recoveredReply ? null : {
      summary_human: summary
        ? `The session stopped before sending the done signal, but verification passed. ${summary}`
        : 'The session stopped before sending the done signal, but verification passed.',
      details: {
        interrupted: true,
        verify_cmd: entry.verifyCmd,
      },
    });
    deliverResult(
      label,
      recoveredReply,
      'completed after interrupted session; verify-cmd passed',
      completionPayload,
    );
  }

  if (artifactEvidence?.found) {
    const artifactSummary = `interrupted after producing artifacts: ${artifactEvidence.reason}`;
    markLabelInterrupted(label, artifactSummary);
    process.stdout.write(
      `⚠️ dispatch [${label}] interrupted after producing artifacts -- work may be incomplete\n` +
      `Summary: ${artifactEvidence.reason}` +
      `${summary ? `\nContext: ${summary}` : ''}` +
      `${formatDiagnosticSnippet(result?.diagnosticReply || result?.lastReply || null)}\n`
    );
    process.exit(exitZeroOnTerminal ? 0 : 1);
  }

  markLabelError(label, summary || 'interrupted: session went idle without calling done');
  process.stdout.write(
    `⚠️ dispatch [${label}] session went idle before completing -- work may be incomplete` +
    `${formatDiagnosticSnippet(result?.diagnosticReply || result?.lastReply || null)}\n`
  );
  process.exit(exitZeroOnTerminal ? 0 : 1);
}

function emitTimeoutOutcome(label, message, result = null) {
  process.stdout.write(`${message}${formatDiagnosticSnippet(result?.diagnosticReply || result?.lastReply || null)}\n`);
  process.exit(exitZeroOnTerminal ? 0 : 1);
}

// -- Watcher heartbeat interval ref --------------------------------------
// Populated after label is validated (in main body). Cleared on exit.
// The interval writes lastPing to labels.json so the watchdog guard in
// index.mjs knows this watcher process is alive and actively monitoring.
let _pingInterval = null;

// -- Sync on Exit --------------------------------------------
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
    // Best-effort -- never block exit
  }
});

// -- Main ----------------------------------------------------

const flags = parseFlags(process.argv.slice(2));
const label       = flags.label;
const timeoutS    = parseInt(flags.timeout || '600', 10);
const pollS       = parseInt(flags['poll-interval'] || '20', 10);
const once        = flags.once === true || flags.once === 'true';
exitZeroOnTerminal = once;

function getCurrentLivenessPolicy() {
  const entry = loadLabels()[label] || { timeoutSeconds: timeoutS };
  return getDispatchLivenessPolicy(entry, { defaultTimeoutSeconds: timeoutS });
}

function hasStructuredCompletion(result) {
  return hasCompletionSignal(result?.completion);
}

function getCleanTerminalReply(status) {
  if (!status?.sessionKey) return null;
  const entry = getSessionStoreEntry(status.sessionKey);
  const sessionId = entry?.sessionId || null;
  const sessionAgent = agentFromSessionKey(status.sessionKey);
  const terminalJsonlReply = sessionId ? getSessionTerminalReply(sessionId, sessionAgent) : null;
  if (!sessionId || !terminalJsonlReply) return null;
  return isSessionCleanlyFinished(sessionId, sessionAgent) ? terminalJsonlReply : null;
}

function getStrictTerminalReply(result, status) {
  const terminalJsonlReply = getCleanTerminalReply(status);
  if (!terminalJsonlReply) return null;
  return result?.lastReply || terminalJsonlReply;
}

if (!label) {
  process.stderr.write('[watcher] --label is required\n');
  process.exit(2);
}

function touchWatcherPing(label) {
  updateExistingLabel(label, (entry) => {
    if (entry.status !== 'running') return false;
    entry.lastPing = new Date().toISOString();
  });
}

function markWatcherPending(label, reason = 'target still running') {
  process.stderr.write(`[watcher] WATCHER_PENDING label=${label} reason=${reason}\n`);
  process.exit(0);
}

function markWatcherAlreadyDelivered(label) {
  process.stderr.write(`[watcher] WATCHER_ALREADY_DELIVERED label=${label}\n`);
  process.exit(0);
}

function clearWatcherRetryAfter(label) {
  updateExistingLabel(label, (entry) => {
    if (!entry.watcherRetryAfter) return false;
    delete entry.watcherRetryAfter;
  });
}

function handleOnce529(label, errorMsg) {
  const labels = loadLabels();
  const entry = labels[label] || {};
  const retryCount = getRetryCount(label);

  if (retryCount >= MAX_529_RETRIES) {
    markLabelError(label, `max_retries_exceeded (${retryCount}x 529): ${errorMsg}`);
    process.stdout.write(
      `🌶️ *dispatch* [${label}] failed after ${MAX_529_RETRIES} retries (529 overload)\n` +
      `Error: ${errorMsg}\n`
    );
    process.exit(0);
  }

  const retryAfterMs = parseTimestampMs(entry.watcherRetryAfter);
  if (!retryAfterMs) {
    const retryResult = attempt529Retry(label, retryCount, errorMsg);
    if (!retryResult.retry) return handleOnce529(label, errorMsg);
    updateExistingLabel(label, (current) => {
      current.watcherRetryAfter = new Date(Date.now() + retryResult.delayMs).toISOString();
    });
    markWatcherPending(label, `529 retry scheduled for future tick (${retryResult.delayMs / 1000}s)`);
  }

  if (Date.now() < retryAfterMs) {
    markWatcherPending(label, '529 retry backoff active');
  }

  if (respawnSession(label)) {
    clearWatcherRetryAfter(label);
    markWatcherPending(label, '529 retry dispatched');
  }

  markLabelError(label, `529 retry failed -- could not respawn session: ${errorMsg}`);
  process.stdout.write(
    `🌶️ *dispatch* [${label}] 529 retry failed -- could not respawn session\n` +
    `Error: ${errorMsg}\n`
  );
  process.exit(0);
}

function runOnceAndExit() {
  try {
    touchWatcherPing(label);
  } catch {
    // Best-effort -- a quick-poll tick must not fail because heartbeat metadata raced.
  }

  const preflightEntry = getLabelEntry(label);
  if (preflightEntry?.completionDeliveredAt) {
    markWatcherAlreadyDelivered(label);
  }

  const status = dispatch('status', ['--label', label]);
  if (!status?.ok) {
    markWatcherPending(label, 'status unavailable');
  }

  if (status.status === 'error') {
    const errorMsg = status.error || status.summary || '';
    if (is529Error(errorMsg)) {
      handleOnce529(label, errorMsg);
    }
  }

  if (status.status !== 'running') {
    const terminalResult = dispatch('result', ['--label', label]);
    const terminalCompletion = terminalResult?.completion || status?.completion || null;

    if (status.status === 'done') {
      const currentRetryCount = getRetryCount(label);
      if (currentRetryCount > 0) setRetryCount(label, 0);
      const gwRetryCount = getGwRestartRetryCount(label);
      if (gwRetryCount > 0) setGwRestartRetryCount(label, 0);
      deliverResult(label, terminalResult?.lastReply, status.summary, terminalCompletion);
    }

    if (status.status === 'interrupted') {
      emitInterruptedOutcome(label, status.summary, terminalResult);
    }

    const summary = status.error || status.summary || `terminal failure (${status.status || 'unknown'})`;
    markLabelError(label, summary);
    process.stdout.write(`🌶️ *dispatch* [${label}] failed\nSummary: ${summary}\n`);
    process.exit(0);
  }

  if (status.sessionKey) {
    const terminalJsonlReply = getCleanTerminalReply(status);
    if (terminalJsonlReply) {
      const result = dispatch('result', ['--label', label]);
      if (hasStructuredCompletion(result)) {
        deliverResult(label, result?.lastReply || terminalJsonlReply, 'completed (stop_reason=end_turn)', result?.completion || null);
      }
      deliverResult(label, terminalJsonlReply, 'completed (stop_reason=end_turn)', null);
    }
  }

  const ageMs = status.liveness?.ageMs;
  const livenessPolicy = getCurrentLivenessPolicy();
  const idleResultCheckMs = livenessPolicy.idleProbeMs;
  const idleFailureMs = livenessPolicy.idleFailureMs;
  if (ageMs != null && ageMs >= idleResultCheckMs) {
    const result = dispatch('result', ['--label', label]);
    if (hasStructuredCompletion(result)) {
      deliverResult(label, result?.lastReply || null, null, result?.completion || null);
    }
    const terminalReply = getStrictTerminalReply(result, status);
    if (terminalReply) {
      deliverResult(label, terminalReply, 'completed (stop_reason=end_turn)', null);
    }

    const turnAbortReason = getSessionTurnAbortReason(status);
    if (turnAbortReason) {
      emitInterruptedOutcome(label, turnAbortReason, {
        ...result,
        sessionKey: status.sessionKey,
        artifactEvidence: result?.artifactEvidence || getSessionArtifactEvidence(status),
      });
    }

    const stallReason = ageMs >= idleFailureMs
      ? getRunningSessionStallReason(status, idleFailureMs)
      : null;
    if (stallReason) {
      const artifactEvidence = result?.artifactEvidence || getSessionArtifactEvidence(status);
      if (artifactEvidence?.found) {
        emitInterruptedOutcome(label, stallReason, {
          ...result,
          sessionKey: status.sessionKey,
          artifactEvidence,
        });
      }
      process.stderr.write(`[watcher] [${label}] ${stallReason}\n`);
      markLabelError(label, stallReason);
      process.stdout.write(
        `❌ *dispatch* [${label}] failed\n` +
        `Summary: ${stallReason}\n`
      );
      process.exit(0);
    }
  }

  markWatcherPending(label);
}

if (once) {
  runOnceAndExit();
}

// -- Start heartbeat -----------------------------------------------------
// Write lastPing to labels.json every PING_INTERVAL_MS while the session is
// still running. The watchdog guard in index.mjs reads lastPing to know this
// watcher process is alive -- preventing premature auto-resolve during slow
// tool calls, docker builds, long pytest runs, etc.
// Cleared automatically by the process.on('exit') handler above.
//
// Race-condition note: labels.json is cached by file mtime/size to avoid reparsing on
// every heartbeat tick, but each tick still re-validates the on-disk signature before
// patching lastPing. Worst case a concurrent writer wins one tick; the next tick repairs it.
_pingInterval = setInterval(() => {
  try {
    updateExistingLabel(label, (entry) => {
      if (entry.status !== 'running') return false;
      entry.lastPing = new Date().toISOString();
    });
  } catch {
    // Best-effort -- never crash the watcher over a ping failure
  }
}, PING_INTERVAL_MS);
_pingInterval.unref(); // don't prevent Node.js from exiting naturally

const spawnTime = Date.now();
let deadline = spawnTime + timeoutS * 1000;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;
let recoverySessionKey = null;  // captured during polling for steer/kill

// Module-level state accessible by SIGTERM handler
let lastKnownReply = null;
let lastKnownCompletion = null;

// -- SIGTERM handler (scheduler kills watcher with SIGTERM before SIGKILL) --
// Hand off to a fresh watcher instead of converting the kill into a fake success.
process.on('SIGTERM', () => {
  process.stderr.write(`[watcher] SIGTERM received for ${label} -- attempting watcher handoff\n`);

  let latestStatus = null;
  try {
    latestStatus = dispatch('status', ['--label', label]);
  } catch {}

  try {
    const result = dispatch('result', ['--label', label]);
    if (result?.lastReply) lastKnownReply = result.lastReply;
    if (result?.completion) lastKnownCompletion = result.completion;
  } catch {}

  if (latestStatus?.status === 'done') {
    deliverResult(label, lastKnownReply, latestStatus.summary || null, lastKnownCompletion || latestStatus?.completion || null);
  }

  if (latestStatus?.status === 'interrupted') {
    markLabelError(label, latestStatus.summary || 'interrupted: session went idle without calling done');
    process.exit(1);
  }

  if (latestStatus?.status && latestStatus.status !== 'running') {
    const summary = latestStatus.error || latestStatus.summary || `terminal failure (${latestStatus.status})`;
    markLabelError(label, summary);
    process.stdout.write(`🌶️ *dispatch* [${label}] failed\nSummary: ${summary}\n`);
    process.exit(1);
  }

  const handoff = dispatch('watcher-handoff', ['--label', label, '--reason', 'sigterm']);
  if (handoff?.ok && (handoff.scheduled || handoff.reason === 'label already terminal' || handoff.reason === 'delivery disabled for this label')) {
    process.stderr.write(`[watcher] SIGTERM handoff ${handoff.scheduled ? 'scheduled' : 'skipped'} for ${label}\n`);
    process.exit(0);
  }

  const failureSummary = 'interrupted by watcher timeout (handoff failed)';
  markLabelError(label, failureSummary);
  process.stdout.write(`⚠️ dispatch [${label}] watcher interrupted and handoff failed\nSummary: ${failureSummary}\n`);
  process.exit(1);
});

// -- Rolling deadline vars ------------------------------------
let lastTokens = null;
let preDeadlineJsonlMtime = null;  // JSONL mtime sampled each poll cycle for subagent activity signal
let preDeadlineSessionId = null;   // reset on respawn to avoid cross-session mtime comparison
const ROLLING_EXTEND_MS = 5 * 60 * 1000;            // extend by 5min when active
const MAX_DEADLINE_EXTENSION = 4 * 60 * 60 * 1000;  // absolute hard ceiling for any deadline extension

/**
 * Attempt to push the watcher deadline forward by ROLLING_EXTEND_MS, capped at
 * spawnTime + min(timeoutS, MAX_DEADLINE_EXTENSION).  This prevents a watcher
 * from outliving its own timeout boundary via repeated JSONL mtime extensions.
 * MAX_DEADLINE_EXTENSION (4h) is the absolute hard ceiling for any watcher.
 * Returns true if the deadline was actually moved.
 * @param {string} reason - Human-readable reason for the log line
 */
function tryExtendDeadline(reason) {
  const proposed = Date.now() + ROLLING_EXTEND_MS;
  const cap = spawnTime + Math.min(timeoutS * 1000, MAX_DEADLINE_EXTENSION);
  const extension = Math.min(proposed, cap);
  if (extension <= deadline) return false;
  deadline = extension;
  process.stderr.write(
    `[watcher] [${label}] ${reason}, deadline extended to +${Math.round((deadline - Date.now()) / 60000)}min\n`
  );
  return true;
}

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

  // -- Rolling deadline: extend when session shows token activity --
  const currentTokens = status?.liveness?.tokens ?? null;
  if (currentTokens !== null && lastTokens !== null && currentTokens > lastTokens) {
    tryExtendDeadline(`activity detected (${lastTokens}->${currentTokens} tokens)`);
  }
  if (currentTokens !== null) lastTokens = currentTokens;

  // -- Rolling deadline: extend on JSONL mtime advance (subagent sessions) --
  // Subagent sessions never populate totalTokens in sessions.json, so the token
  // signal above is always null for them. Use JSONL file mtime as an alternative
  // activity signal to prevent killing working subagent sessions mid-task.
  if (status.sessionKey) {
    const storeEntry = getSessionStoreEntry(status.sessionKey);
    const sessionId = storeEntry?.sessionId || null;
    const sessionAgent = agentFromSessionKey(status.sessionKey);

    // Reset mtime baseline when the tracked session changes (e.g. after respawn)
    if (sessionId && preDeadlineSessionId !== null && preDeadlineSessionId !== sessionId) {
      preDeadlineJsonlMtime = null;
    }
    if (sessionId) preDeadlineSessionId = sessionId;

    const curMtime = sessionId ? getSessionJsonlMtime(sessionId, sessionAgent) : null;
    if (curMtime !== null) {
      if (preDeadlineJsonlMtime !== null && curMtime > preDeadlineJsonlMtime + 1000) {
        tryExtendDeadline('JSONL mtime advanced (subagent active)');
      }
      preDeadlineJsonlMtime = curMtime;
    }
  }

  // Track session presence -- two independent signals, either is sufficient.
  // 1. Sessions.json store (primary ground truth for dispatcher-spawned sessions)
  // 2. Liveness field from dispatch status (secondary; also built from sessions.json
  //    in production, but test mocks may provide it directly)
  if (!sessionEverFound && status.sessionKey) {
    const sessionAgent = status.agent || 'main';
    const watcherStore = readSessionsStore(sessionAgent);
    if (watcherStore !== null && status.sessionKey in watcherStore) {
      // Found in sessions.json -- authoritative
      sessionEverFound = true;
    } else if (status.liveness && !status.liveness.error) {
      // Not in sessions.json (or store unavailable) but liveness signal says alive --
      // session may still be initializing. Trust liveness as a secondary signal.
      sessionEverFound = true;
    }
  }

  // -- Path 0a: agent-side done signal (push-based) ----------
  // If the agent ran `dispatch done --label <label>`, status is 'done' immediately.
  // This is the fast path -- no need to poll for idle timeout.
  // (Handled by Path 1 below since cmdDone sets status='done' in labels.json)

  // -- Path 0b: 529/overload auto-retry ----------------------
  if (status.status === 'error') {
    const errorMsg = status.error || status.summary || '';
    if (is529Error(errorMsg)) {
      const retryCount = getRetryCount(label);
      const retryResult = attempt529Retry(label, retryCount, errorMsg);

      if (!retryResult.retry) {
        // Max retries exceeded -- deliver error
        process.stdout.write(
          `🌶️ *dispatch* [${label}] failed after ${MAX_529_RETRIES} retries (529 overload)\n` +
          `Error: ${errorMsg}\n`
        );
        process.exit(1);
      }

      // Wait with backoff then respawn
      await sleep(retryResult.delayMs);

      if (respawnSession(label)) {
        // Session respawned -- reset consecutive failures for the fresh session
        consecutiveFailures = 0;
        process.stderr.write(`[watcher] [${label}] retry ${retryResult.newRetryCount} dispatched, continuing poll...\n`);
        await sleep(pollS * 1000);
        continue;
      } else {
        // Respawn failed -- deliver error
        process.stdout.write(
          `🌶️ *dispatch* [${label}] 529 retry failed -- could not respawn session\n` +
          `Error: ${errorMsg}\n`
        );
        process.exit(1);
      }
    }
  }

  // -- Path 1: status auto-resolved to done ------------------
  if (status.status !== 'running') {
    const terminalResult = dispatch('result', ['--label', label]);
    const terminalCompletion = terminalResult?.completion || status?.completion || null;
    const hasTerminalCompletionEvidence = Boolean(
      terminalResult?.lastReply
      || terminalResult?.completion?.deliveryText
      || terminalResult?.completion?.summary
      || status?.completion?.deliveryText
      || status?.completion?.summary
    );

    // -- Spawn failure detection -----------------------------------------
    // If the session was auto-resolved to 'done' (or 'spawn-warning') but was
    // never seen in the gateway, it never ran -- unless a terminal completion
    // payload/reply proves the work already finished before this watcher saw it.
    if (!sessionEverFound && (status.status === 'spawn-warning' || status.status === 'error' || (status.status === 'done' && !hasTerminalCompletionEvidence))) {
      const spawnErrMsg =
        `[dispatch] SPAWN FAILURE: session ${status.sessionKey || '(unknown)'} never appeared ` +
        `in gateway -- spawn likely failed (auth timeout, quota, or gateway error). Label: ${label}`;
      process.stderr.write(spawnErrMsg + '\n');
      markLabelError(label, `spawn-failure: session never appeared in gateway`);
      process.stdout.write(
        `🌶️ *dispatch* [${label}] SPAWN FAILURE: session never appeared in gateway -- ` +
        `spawn likely failed (auth timeout, quota, or gateway error)\n`
      );
      process.exit(1);
    }

    // -- Gateway-restart-kill detection ----------------------------------
    // When a gateway restart kills an in-flight session, the session disappears
    // from sessions.json and the status command auto-resolves it as 'done' with
    // a "session not found in sessions store" summary. This is NOT a real
    // completion -- the task was interrupted mid-run. Detect this pattern and
    // re-dispatch up to MAX_GW_RESTART_RETRIES times.
    //
    // Key distinction vs spawn failure:
    //   spawn failure:          sessionEverFound=false (session never appeared)
    //   gateway-restart-kill:   sessionEverFound=true  (session ran, then was killed)
    //
    // If the session DID produce a lastReply before being killed, deliver it normally.
    if (sessionEverFound && isGatewayRestartKill(status.summary)) {
      const gwCheckResult = dispatch('result', ['--label', label]);
      if (!gwCheckResult?.lastReply && !hasCompletionSignal(gwCheckResult?.completion)) {
        // No result captured -- session was killed before completing
        const retryCount = getGwRestartRetryCount(label);
        if (retryCount >= MAX_GW_RESTART_RETRIES) {
          markLabelError(label,
            `gateway-restart-kill: max retries exceeded (${retryCount}x -- ${status.summary})`);
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
          `[watcher] gateway-restart-kill detected for [${label}] -- ` +
          `attempt ${newRetryCount}/${MAX_GW_RESTART_RETRIES}\n`
        );
        notify(
          `🌶️ Dispatch: [${label}] session killed by gateway restart -- ` +
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
      // lastReply or completion payload present -- session completed before/during kill; fall through to normal delivery
    }

    // Reset gw-restart retry count on successful completion
    const gwRetryCount = getGwRestartRetryCount(label);
    if (gwRetryCount > 0) {
      setGwRestartRetryCount(label, 0);
      process.stderr.write(
        `[watcher] [${label}] completed after ${gwRetryCount} gw-restart retry(ies), reset gwRestartRetryCount\n`
      );
    }

    // -- Interrupted: session auto-resolved as incomplete ------------------
    // When cmdStatus auto-resolves a session as 'interrupted' (idle without
    // calling done), deliver the lastReply for diagnostics but exit non-zero
    // so the scheduler run is marked as error, not success.
    //
    // NOTE: Always resolve as 'interrupted', never 'done'. Only agent-side cmdDone may set status=done.
    if (status.status === 'interrupted') {
      const interruptedResult = dispatch('result', ['--label', label]);
      emitInterruptedOutcome(label, status.summary, interruptedResult);
    }

    // Reset 529 retryCount on successful completion
    if (status.status === 'done') {
      const currentRetryCount = getRetryCount(label);
      if (currentRetryCount > 0) {
        setRetryCount(label, 0);
        process.stderr.write(`[watcher] [${label}] completed after ${currentRetryCount} retry(ies), reset retryCount\n`);
      }
    }
    deliverResult(label, terminalResult?.lastReply, status.summary, terminalCompletion);
  }

  // -- Path 2a: stop_reason early delivery (clean end_turn) --
  // If the last assistant message has stop_reason=end_turn and no tool calls
  // are in flight, deliver immediately without waiting for FLAT_WINDOW_MS.
  // This is the fast path for sessions that write stop_reason to JSONL.
  if (status.sessionKey) {
    const _e2a = getSessionStoreEntry(status.sessionKey);
    const _sid2a = _e2a?.sessionId || null;
    const _adir2a = agentFromSessionKey(status.sessionKey);
    const terminalJsonlReply = _sid2a ? getSessionTerminalReply(_sid2a, _adir2a) : null;
    if (_sid2a && terminalJsonlReply && isSessionCleanlyFinished(_sid2a, _adir2a)) {
      process.stderr.write(`[watcher] stop_reason=end_turn detected -- delivering early\n`);
      const result = dispatch('result', ['--label', label]);
      if (hasStructuredCompletion(result)) {
        deliverResult(label, result?.lastReply || terminalJsonlReply, 'completed (stop_reason=end_turn)', result?.completion || null);
        // deliverResult exits
      }
      deliverResult(label, terminalJsonlReply, 'completed (stop_reason=end_turn)', null);
    }
  }

  // -- Path 2: status says 'running' but session may be idle -
  // If the session has no recent activity, proactively check for a result.
  // This catches the gap where the session completed but status hasn't
  // auto-resolved yet. The watchdog guard in index.mjs defers auto-resolve
  // while this watcher's lastPing heartbeat is fresh (written every 60s);
  // this path handles normal completion before the ping goes stale.
  const ageMs = status.liveness?.ageMs;
  const livenessPolicy = getCurrentLivenessPolicy();
  const idleResultCheckMs = livenessPolicy.idleProbeMs;
  const idleFailureMs = livenessPolicy.idleFailureMs;
  if (ageMs != null && ageMs >= idleResultCheckMs) {
    const result = dispatch('result', ['--label', label]);
    if (hasStructuredCompletion(result)) {
      deliverResult(label, result?.lastReply || null, null, result?.completion || null);
    }
    const terminalReply = getStrictTerminalReply(result, status);
    if (terminalReply) {
      deliverResult(label, terminalReply, 'completed (stop_reason=end_turn)', null);
    }

    const turnAbortReason = getSessionTurnAbortReason(status);
    if (turnAbortReason) {
      emitInterruptedOutcome(label, turnAbortReason, {
        ...result,
        sessionKey: status.sessionKey,
        artifactEvidence: result?.artifactEvidence || getSessionArtifactEvidence(status),
      });
    }

    const stallReason = ageMs >= idleFailureMs
      ? getRunningSessionStallReason(status, idleFailureMs)
      : null;
    if (stallReason) {
      const artifactEvidence = result?.artifactEvidence || getSessionArtifactEvidence(status);
      if (artifactEvidence?.found) {
        emitInterruptedOutcome(label, stallReason, {
          ...result,
          sessionKey: status.sessionKey,
          artifactEvidence,
        });
      }
      process.stderr.write(`[watcher] [${label}] ${stallReason}\n`);
      markLabelError(label, stallReason);
      process.stdout.write(
        `❌ *dispatch* [${label}] failed\n` +
        `Summary: ${stallReason}\n`
      );
      process.exit(1);
    }
  }


  await sleep(pollS * 1000);
}

// Timed out -- try one last result check
const finalResult = dispatch('result', ['--label', label]);
const finalStatus = dispatch('status', ['--label', label]);
if (hasStructuredCompletion(finalResult)) {
  deliverResult(
    label,
    finalResult?.lastReply || null,
    finalStatus?.summary || null,
    finalResult?.completion || finalStatus?.completion || null,
  );
}
if (finalStatus?.status === 'done') {
  const rc = getRetryCount(label);
  if (rc > 0) setRetryCount(label, 0);
  deliverResult(
    label,
    finalResult?.lastReply || null,
    finalStatus?.summary || null,
    finalResult?.completion || finalStatus?.completion || null,
  );
}
// If status is interrupted (auto-resolved as incomplete), exit non-zero
if (finalStatus?.status === 'interrupted') {
  process.stderr.write(`[watcher] [${label}] final status=interrupted -- session idle without completion\n`);
  emitInterruptedOutcome(label, finalStatus?.summary, finalResult);
}

// -- Token-based activity check before steering ----------------------------
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

const statusAtDeadline = dispatch('status', ['--label', label]);
let tokenSessionKey = statusAtDeadline?.sessionKey || recoverySessionKey || null;
let baselineTokens = getTokenCount(tokenSessionKey);
let flatSince = Date.now();

// Capture the internal sessionId (UUID) from sessions.json -- this is the filename
// of the JSONL file, distinct from the sessionKey (agent:main:subagent:UUID).
// The JSONL is updated continuously during active turns, making it a reliable
// activity signal when sessions.json totalTokens/updatedAt are stale.
const _deadlineEntry = getSessionStoreEntry(tokenSessionKey);
const sessionInternalId = _deadlineEntry?.sessionId || null;
const sessionAgent = tokenSessionKey ? agentFromSessionKey(tokenSessionKey) : 'main';
let lastJsonlMtime = getSessionJsonlMtime(sessionInternalId, sessionAgent);

process.stderr.write(`[watcher] deadline hit for ${label} -- watching token activity (baseline: ${baselineTokens})\n`);
if (sessionInternalId) {
  process.stderr.write(`[watcher] ${label} JSONL tracking: sessionId=${sessionInternalId} mtime=${lastJsonlMtime}\n`);
}

// If the session already completed (gateway pruned it -> null tokens), exit cleanly.
if (statusAtDeadline?.status === 'done' || baselineTokens === null) {
  const r = dispatch('result', ['--label', label]);
  if (statusAtDeadline?.status === 'done') {
    const retryCount = getRetryCount(label);
    if (retryCount > 0) setRetryCount(label, 0);
    const gatewayRetryCount = getGwRestartRetryCount(label);
    if (gatewayRetryCount > 0) setGwRestartRetryCount(label, 0);
    // Route the authoritative deadline completion through the same durable
    // outbox path as every other watcher completion, even without a structured
    // payload. deliverResult exits after enqueueing or explicit fallback.
    deliverResult(
      label,
      r?.lastReply || null,
      statusAtDeadline?.summary || 'completed',
      r?.completion || statusAtDeadline?.completion || null,
    );
  }
  if (hasStructuredCompletion(r)) {
    deliverResult(label, r?.lastReply || null, statusAtDeadline?.summary || null, r?.completion || null);
  }
  // Truly no result and no tokens -- telemetry unavailable
  if (baselineTokens === null) {
    // Check if session is actually in the store (just mid-tool-call with no tokens yet)
    const entry = getSessionStoreEntry(tokenSessionKey);
    if (!entry) {
      // Session truly not found -- telemetry unavailable, exit
      process.stderr.write(`[watcher] token telemetry unavailable for ${label}; session not in store\n`);
      markLabelError(label, `timed out after ${timeoutS}s -- token telemetry unavailable`);
      emitTimeoutOutcome(label, `⏱ dispatch [${label}] timed out after ${timeoutS}s -- token telemetry unavailable; no steer/kill attempted`, r);
    }
    // Session IS in store but no tokens -- mid-tool-call, fall through to activity window
    // Use updatedAt as activity signal instead of tokens
    process.stderr.write(`[watcher] ${label} in store but no tokens (mid-tool-call?) -- using updatedAt as activity signal\n`);
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
    // deliverResult calls process.exit(0) internally
    deliverResult(label, r?.lastReply || null, st.summary, r?.completion || st?.completion || null);
  }
  const r2 = dispatch('result', ['--label', label]);
  if (hasStructuredCompletion(r2)) {
    // deliverResult calls process.exit(0) internally
    deliverResult(label, r2?.lastReply || null, null, r2?.completion || null);
  }

  // Token growth?
  const cur = getTokenCount(tokenSessionKey);
  if (cur === null) {
    // Check updatedAt as fallback -- if session is still in store and recently updated, keep waiting
    const entry = getSessionStoreEntry(tokenSessionKey);
    if (!entry) {
      process.stderr.write(`[watcher] token telemetry lost for ${label}; session gone from store\n`);
      markLabelError(label, `timed out after ${timeoutS}s -- token telemetry lost`);
      const tokenLostResult = dispatch('result', ['--label', label]);
      emitTimeoutOutcome(label, `⏱ dispatch [${label}] timed out after ${timeoutS}s -- token telemetry lost; no steer/kill attempted`, tokenLostResult);
    }
    // Still in store -- check if updatedAt advanced (tool call still running)
    // Normalize: updatedAt may be seconds or milliseconds depending on agent framework version
    const rawUpdatedAt = entry.updatedAt;
    const updatedAt = (typeof rawUpdatedAt === 'number' && rawUpdatedAt < 1e12)
      ? rawUpdatedAt * 1000   // seconds -> milliseconds
      : rawUpdatedAt;
    if (typeof updatedAt === 'number' && updatedAt > flatSince) {
      process.stderr.write(`[watcher] ${label} no tokens but updatedAt advanced -- tool call active, resetting flat timer\n`);
      flatSince = Date.now();
    } else {
      process.stderr.write(`[watcher] ${label} no tokens, updatedAt not advancing -- may be stuck\n`);
    }
    // Don't exit -- let FLAT_WINDOW_MS timeout handle the stuck case normally
    continue;
  }
  // Normal token comparison (skip if in token-free sentinel mode)
  if (baselineTokens !== -1 && cur > baselineTokens) {
    process.stderr.write(`[watcher] ${label} still active (${baselineTokens}->${cur} tokens), resetting flat timer\n`);
    baselineTokens = cur;
    flatSince = Date.now();
  } else if (baselineTokens === -1 && cur > 0) {
    // Tokens appeared for the first time -- switch from sentinel to real token tracking
    process.stderr.write(`[watcher] ${label} tokens now available (${cur}), switching to token tracking\n`);
    baselineTokens = cur;
    flatSince = Date.now();
  }

  // -- JSONL mtime check -----------------------------------------------------
  // Most reliable activity signal for spawned subagent sessions: OpenClaw does
  // NOT flush totalTokens or updatedAt in sessions.json during active turns, but
  // the JSONL file IS written continuously. If the mtime advanced since last
  // check by >1s, the session is actively processing -- reset the flat timer.
  const curJsonlMtime = getSessionJsonlMtime(sessionInternalId, sessionAgent);
  if (curJsonlMtime !== null) {
    if (lastJsonlMtime !== null && curJsonlMtime > lastJsonlMtime + 1000) {
      process.stderr.write(
        `[watcher] ${label} JSONL mtime advanced (${lastJsonlMtime}->${curJsonlMtime}ms), ` +
        `session active -- resetting flat timer\n`
      );
      lastJsonlMtime = curJsonlMtime;
      flatSince = Date.now();
    } else if (lastJsonlMtime === null) {
      // First observation -- just record, don't reset yet
      process.stderr.write(`[watcher] ${label} JSONL mtime first observation: ${curJsonlMtime}\n`);
      lastJsonlMtime = curJsonlMtime;
    }
  }
}

// -- Pre-steer JSONL sanity check ------------------------------------------
// Before triggering recovery, verify the session is not currently
// mid-turn. A mid-turn session has an in-flight tool call (JSONL last entry
// is tool_use or tool_result) -- steering or declaring it done would interrupt
// active work and produce a partial/zombie result.
//
// If mid-turn is detected AND the JSONL was modified recently, extend the flat
// window one time to let the turn complete naturally.
if (sessionInternalId) {
  const midTurnReason = getJsonlMidTurnReason(sessionInternalId, sessionAgent);
  if (midTurnReason) {
    process.stderr.write(
      `[watcher] ${label} pre-steer sanity check: ${midTurnReason} -- ` +
      `session is mid-turn, extending flat window once\n`
    );
    notify(`🌶️ Dispatch: [${label}] pre-steer: mid-turn detected (${midTurnReason}), extending wait`);
    flatSince = Date.now();
    // Re-enter the flat window loop for one more FLAT_WINDOW_MS extension
    while (Date.now() - flatSince < FLAT_WINDOW_MS) {
      await sleep(ACTIVITY_POLL_MS);

      // Check for completion
      const stExt = dispatch('status', ['--label', label]);
      if (stExt?.status === 'done') {
        const rExt = dispatch('result', ['--label', label]);
        // deliverResult calls process.exit(0) internally
        deliverResult(label, rExt?.lastReply || null, stExt.summary, rExt?.completion || stExt?.completion || null);
      }
      const rExt2 = dispatch('result', ['--label', label]);
      if (hasStructuredCompletion(rExt2)) {
        // deliverResult calls process.exit(0) internally
        deliverResult(label, rExt2?.lastReply || null, null, rExt2?.completion || null);
      }

      // JSONL mtime check during extended wait
      const extMtime = getSessionJsonlMtime(sessionInternalId, sessionAgent);
      if (extMtime !== null && lastJsonlMtime !== null && extMtime > lastJsonlMtime + 1000) {
        process.stderr.write(
          `[watcher] ${label} JSONL mtime advanced during extended wait (${lastJsonlMtime}->${extMtime}ms), resetting flat timer\n`
        );
        lastJsonlMtime = extMtime;
        flatSince = Date.now();
      } else if (extMtime !== null) {
        lastJsonlMtime = extMtime;
      }

      // Token growth check during extended wait
      const extTokens = getTokenCount(tokenSessionKey);
      if (extTokens !== null && baselineTokens !== -1 && extTokens > baselineTokens) {
        process.stderr.write(`[watcher] ${label} tokens advanced during extended wait, resetting flat timer\n`);
        baselineTokens = extTokens;
        flatSince = Date.now();
      }
    }
    // Extended window expired -- proceed to steer regardless
    process.stderr.write(`[watcher] ${label} extended mid-turn wait expired -- proceeding to steer\n`);
  }
}

// 3 min of genuinely flat tokens -- now steer
process.stderr.write(`[watcher] ${label} inactive 3min post-deadline -- entering steer\n`);

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
    // deliverResult calls process.exit(0) internally
    deliverResult(label, r3?.lastReply || null, st2.summary, r3?.completion || st2?.completion || null);
  }
  const r3 = dispatch('result', ['--label', label]);
  if (hasStructuredCompletion(r3)) {
    // deliverResult calls process.exit(0) internally
    deliverResult(label, r3?.lastReply || null, null, r3?.completion || null);
  }

  if (!round.msg && steerSessionKey) {
    process.stderr.write(`[watcher] killing stuck session ${label}\n`);
    await killSession(steerSessionKey);
    // Wait up to 30s for confirmation
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const st3 = dispatch('status', ['--label', label]);
      if (st3?.status === 'done') {
        // Check if a result was captured before marking as error
        const r4 = dispatch('result', ['--label', label]);
        if (hasStructuredCompletion(r4)) {
          deliverResult(label, r4?.lastReply || null, st3.summary, r4?.completion || st3?.completion || null); // deliverResult calls process.exit(0)
        }
        markLabelError(label, 'timed out -- killed after steer attempts (no result captured)');
        emitTimeoutOutcome(label, `⏱ dispatch [${label}] killed after steer attempts -- no result captured`, r4);
      }
    }
  }
}

markLabelError(label, `timed out after ${timeoutS}s -- killed after steer attempts`);
const timeoutResult = dispatch('result', ['--label', label]);
emitTimeoutOutcome(label, `⏱ dispatch [${label}] timed out after ${timeoutS}s -- session killed after steer attempts`, timeoutResult);
