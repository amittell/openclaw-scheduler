#!/usr/bin/env node
/**
 * dispatch -- Sub-agent dispatch CLI for OpenClaw
 *
 * Spawns and steers isolated agent sessions via the OpenClaw Gateway API.
 * Tracks label->session mappings in a local JSON ledger.
 *
 * Subcommands:
 *   enqueue    Spawn a session via gateway, store label->sessionKey, return immediately
 *   status     Query session status by label
 *   stuck      Find sessions running past threshold with no activity
 *   result     Get last assistant message from a session
 *   send       Send a message INTO a running session (mid-session steering)
 *   steer      Alias for send -- explicitly for mid-session course correction
 *   heartbeat  Check session liveness
 *   list       List all tracked labels
 *   sync       Reconcile labels.json with sessions store state
 *   done       Agent-side completion signal -- set label status=done immediately
 *
 * Exit codes:
 *   0  -- success / nothing stuck
 *   1  -- stuck runs found, or hard error
 *   2  -- argument error
 *
 * Usage: openclaw-scheduler <subcommand> [options]
 */

import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync, renameSync } from 'fs';
import { dirname, join, resolve as pathResolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import {
  buildCompletionSignalInstructions,
  buildTerminalCompletionPayload,
  extractLastMeaningfulAssistantReplyFromEntries,
  extractTerminalAssistantReplyFromEntries,
  getCompletionAuthoritativeSummary,
  hasCompletionSignal,
  resolveCompletionDelivery,
  taskRequiresGitSha,
} from './completion.mjs';
import {
  buildAutoResolvedIncompleteSummary,
  getDispatchGatewayTimeoutSeconds,
  getDispatchLivenessPolicy,
} from './liveness.mjs';
import { resolveDispatchStateDir, resolveLabelsPath } from './paths.mjs';
import {
  onStarted,
  onFinished,
  onStuck,
  enqueueCompletionNotification,
  resetCompletionDeliveryClaim,
} from './hooks.mjs';
import { resolveMessageInput } from './message-input.mjs';
import { resolveDefaultDispatchModel } from './default-model.mjs';
import { buildDispatchDeliverySurface } from '../scripts/dispatch-cli-utils.mjs';
import {
  agentIdFromSessionKey as validatedAgentIdFromSessionKey,
  assertValidAgentId,
  assertValidSessionId,
  assertValidSessionKey,
  assertValidSessionStore,
  assertSessionKeyForAgent,
  buildGatewayEndpointUrl,
  buildGatewaySessionUrl,
  parseGatewayBaseUrl,
  resolveAgentSessionsStorePath,
  resolveSessionTranscriptPath,
  toNullPrototypeRecord,
} from '../identifiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || homedir();
const GATEWAY_BASE_URL = parseGatewayBaseUrl(
  process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
);
const gatewayEndpointUrl = endpoint => buildGatewayEndpointUrl(GATEWAY_BASE_URL, endpoint);
const GATEWAY_TOOLS_INVOKE_URL = gatewayEndpointUrl('tools/invoke');
let labelsCache = null;
let labelsCacheSignature = null;
let labelsCacheError = null;

// -- Invocation Directory -------------------------------------
// When invoked via symlink (e.g. my-brand/index.mjs -> dispatch/index.mjs),
// __dirname resolves to the real path (dispatch/). INVOKE_DIR resolves to the
// symlink's directory so config.json, labels.json, and self-references use the
// wrapper's directory instead of the shared module's.

const INVOKE_DIR = (() => {
  try {
    const argv1 = process.argv[1];
    if (argv1) return dirname(pathResolve(argv1));
  } catch {}
  return __dirname;
})();

// -- Config ---------------------------------------------------

const LABELS_STATE_DIR = resolveDispatchStateDir();
const LABELS_PATH = resolveLabelsPath({
  legacyCandidates: [join(INVOKE_DIR, 'labels.json'), join(__dirname, 'labels.json')],
});

/** Load dispatch config from config.json.
 *  Resolution order:
 *    1. DISPATCH_CONFIG_DIR env var (branded wrapper deployments)
 *    2. INVOKE_DIR (argv[1] dirname -- supports symlink-based branding)
 *    3. __dirname (dispatch module directory -- fallback)
 */
function loadConfig() {
  const searchDirs = [];
  if (process.env.DISPATCH_CONFIG_DIR) searchDirs.push(pathResolve(process.env.DISPATCH_CONFIG_DIR));
  if (!searchDirs.includes(INVOKE_DIR)) searchDirs.push(INVOKE_DIR);
  if (!searchDirs.includes(__dirname)) searchDirs.push(__dirname);

  for (const dir of searchDirs) {
    try {
      const cfgPath = join(dir, 'config.json');
      return JSON.parse(readFileSync(cfgPath, 'utf-8'));
    } catch { /* try next */ }
  }
  return {};
}

const config = loadConfig();
const BRAND = config.name ?? 'dispatch';
const DEFAULT_DISPATCH_MODEL = resolveDefaultDispatchModel({
  dispatchConfig: config,
  env: process.env,
  homeDir: HOME_DIR,
});

/** Load gateway auth token from config or env */
function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = join(HOME_DIR, '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gateway?.auth?.token || null;
  } catch { return null; }
}

const GATEWAY_TOKEN = getGatewayToken();

// -- Helpers --------------------------------------------------

function die(msg, code = 1) {
  process.stderr.write(`[${BRAND}] ${msg}\n`);
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function deployedSchedulerDispatchPath(fileName) {
  return join(
    HOME_DIR,
    '.openclaw',
    'packages',
    'openclaw-scheduler',
    'node_modules',
    'openclaw-scheduler',
    'dispatch',
    fileName,
  );
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

function currentDirLooksLikeBrandWrapper() {
  return !existsSync(join(__dirname, '..', 'cli.js'));
}

function resolveDispatchScriptPath(fileName) {
  const localPath = join(__dirname, fileName);
  const deployedPath = deployedSchedulerDispatchPath(fileName);
  const preferDeployed = currentDirLooksLikeBrandWrapper();
  const candidates = [
    fileName === 'index.mjs' ? process.env.DISPATCH_INDEX_PATH : null,
    preferDeployed ? deployedPath : localPath,
    preferDeployed ? localPath : deployedPath,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }

  return localPath;
}

function resolvePersistentNodePath() {
  const explicit = process.env.OPENCLAW_NODE_PATH ||
    process.env.OPENCLAW_NODE ||
    process.env.NODE_BINARY;
  if (explicit) return explicit;

  const execPath = process.execPath || 'node';
  const homebrewNode = execPath.startsWith('/opt/homebrew/')
    ? '/opt/homebrew/bin/node'
    : execPath.startsWith('/usr/local/')
      ? '/usr/local/bin/node'
      : null;
  const isVersionedHomebrewPath = /\/(?:Cellar|opt)\/node(?:@[^/]+)?\//.test(execPath);

  if (homebrewNode && isVersionedHomebrewPath) {
    try {
      if (existsSync(homebrewNode)) return homebrewNode;
    } catch {}
  }

  return execPath;
}

function dispatchConfigDirForChild() {
  return process.env.DISPATCH_CONFIG_DIR || INVOKE_DIR;
}

function toTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
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

// -- Labels Ledger --------------------------------------------

function getLabelsSignature() {
  try {
    const stats = statSync(LABELS_PATH);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
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
    labelsCache = labels;
    labelsCacheSignature = signature;
    labelsCacheError = null;
    return labels;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      process.stderr.write(`[${BRAND}] Refusing invalid labels ledger: ${error.message}\n`);
      labelsCacheError = error;
    } else {
      labelsCacheError = null;
    }
    labelsCache = Object.create(null);
    labelsCacheSignature = signature;
    return labelsCache;
  }
}

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

function assertValidLabelSessionMetadata(name, entry) {
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
  return entry;
}

function quarantineLabelSessionMetadata(name, error) {
  const reason = `Rejected unsafe legacy session metadata for label ${JSON.stringify(name)}: ${error.message}`;
  const labels = mutateLabels((current) => {
    const entry = current[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      current[name] = {};
    }
    delete current[name].agent;
    delete current[name].sessionKey;
    delete current[name].sessionId;
    current[name].status = 'error';
    current[name].error = reason;
    current[name].summary = reason;
    current[name].metadataRejectedAt = new Date().toISOString();
  });
  process.stderr.write(`[${BRAND}] ${reason}\n`);
  return labels[name];
}

function getLabel(name) {
  const entry = loadLabels()[name] || null;
  if (!entry) return null;
  try {
    return assertValidLabelSessionMetadata(name, entry);
  } catch (error) {
    return quarantineLabelSessionMetadata(name, error);
  }
}

function loadValidatedLabels() {
  const labels = loadLabels();
  for (const [name, entry] of Object.entries(labels)) {
    try {
      assertValidLabelSessionMetadata(name, entry);
    } catch (error) {
      quarantineLabelSessionMetadata(name, error);
    }
  }
  return loadLabels();
}

function setLabel(name, data) {
  const labels = mutateLabels((current) => {
    const updated = { ...current[name], ...data, updatedAt: new Date().toISOString() };
    assertValidLabelSessionMetadata(name, updated);
    current[name] = updated;
  });
  return labels[name];
}

function setLabelDone(name, data) {
  const labels = mutateLabels((current) => {
    const updated = {
      ...current[name],
      ...data,
      status: 'done',
      error: null,
      updatedAt: new Date().toISOString(),
    };
    assertValidLabelSessionMetadata(name, updated);
    current[name] = updated;
  });
  return labels[name];
}

function effectiveCompletionSummary(entry, lastReply = null) {
  if (!entry || typeof entry !== 'object') return null;

  if (hasCompletionSignal(entry.completion)) {
    const authoritativeSummary = getCompletionAuthoritativeSummary(entry.completion);
    if (authoritativeSummary) return authoritativeSummary;
  }

  if (entry.summary) return entry.summary;

  if (lastReply) {
    const resolved = resolveCompletionDelivery({
      lastReply,
      completion: null,
      fallbackSummary: null,
    });
    if (resolved?.summary) return resolved.summary;
    return lastReply.slice(0, 500);
  }

  return null;
}

// -- Gateway Calls --------------------------------------------

/**
 * Call a gateway RPC method via `openclaw gateway call`.
 * Returns parsed JSON response.
 */
function gatewayCall(method, params = {}, opts = {}) {
  const timeout     = opts.timeout || 15000;
  const expectFinal = opts.expectFinal || false;

  const args = ['gateway', 'call', method, '--json'];
  args.push('--params', JSON.stringify(params));
  args.push('--timeout', String(timeout));
  if (expectFinal) args.push('--expect-final');
  const childEnv = GATEWAY_TOKEN ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN } : process.env;

  try {
    const result = execFileSync('openclaw', args, {
      encoding: 'utf-8',
      timeout:  timeout + 5000,
      stdio:    ['pipe', 'pipe', 'pipe'],
      env:      childEnv,
    });
    // Strip non-JSON prefix lines (e.g. plugin init logs leaking to stdout)
    const trimmed = result.trim();
    const jsonStart = trimmed.indexOf('{');
    const cleaned = jsonStart > 0 ? trimmed.slice(jsonStart) : trimmed;
    return JSON.parse(cleaned);
  } catch (err) {
    const stderr = err.stderr?.trim() || '';
    const stdout = err.stdout?.trim() || '';
    if (stdout) {
      const idx = stdout.indexOf('{');
      const cleanStdout = idx > 0 ? stdout.slice(idx) : stdout;
      try { return JSON.parse(cleanStdout); } catch {}
    }
    throw new Error(`gateway call ${method} failed: ${stderr || stdout || err.message}`, {
      cause: err,
    });
  }
}

// -- Gateway Error Log Check ----------------------------------

/**
 * Check the gateway error log for the most recent diagnostic lane task error
 * matching a specific session key.
 *
 * Scans the last N bytes of gateway.err.log for diagnostic lane task errors
 * that reference the session key and returns the newest error line.
 *
 * @param {string} sessionKey - The session key to check
 * @returns {{ found: boolean, error: string|null, timestamp: string|null }}
 */
function getGatewayLaneTaskError(sessionKey) {
  try {
    const logPath = join(HOME_DIR, '.openclaw', 'logs', 'gateway.err.log');
    if (!existsSync(logPath)) return { found: false, error: null, timestamp: null };

    // Read last 512KB of the log (sufficient for recent errors)
    const fileStat = statSync(logPath);
    const readSize = Math.min(fileStat.size, 512 * 1024);
    const fd = openSync(logPath, 'r');
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, fileStat.size - readSize));
    closeSync(fd);

    const tail = buf.toString('utf-8');
    const lines = tail.split('\n');

    // Search backwards for the most recent match
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes(sessionKey)) continue;
      if (!line.includes('lane task error')) continue;

      const errorMatch = line.match(/error="([^"]+)"/);
      if (!errorMatch) continue;

      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
      return {
        found: true,
        error: errorMatch[1],
        timestamp: tsMatch ? tsMatch[1] : null,
      };
    }

    return { found: false, error: null, timestamp: null };
  } catch {
    return { found: false, error: null, timestamp: null };
  }
}

/**
 * Check the gateway error log for 529/FailoverError/overload errors
 * matching a specific session key.
 *
 * @param {string} sessionKey - The session key to check
 * @returns {{ found: boolean, error: string|null, timestamp: string|null }}
 */
function check529InGatewayLog(sessionKey) {
  const OVERLOAD_PATTERNS = [
    /529/i,
    /failover\s*error/i,
    /overload/i,
    /temporarily\s+overloaded/i,
  ];

  const laneError = getGatewayLaneTaskError(sessionKey);
  if (!laneError.found || !laneError.error) return { found: false, error: null, timestamp: null };
  if (!OVERLOAD_PATTERNS.some(p => p.test(laneError.error))) return { found: false, error: null, timestamp: null };

  return {
    found: true,
    error: `FailoverError (529): ${laneError.error}`,
    timestamp: laneError.timestamp,
  };
}

// -- Sessions Store (Direct Read) -----------------------------

/**
 * Read the sessions.json store for an agent directly from disk.
 * This is the ground truth for session state -- sessions spawned via the
 * dispatcher HTTP agent endpoint appear here but NOT in sessions_list API.
 *
 * Sessions are NOT pruned on completion -- completed sessions stay in the file.
 *
 * @param {string} agent - Agent ID (default: 'main')
 * @returns {Object|null} - The sessions store object, or null on error
 */
function readSessionsStore(agent = 'main') {
  let sessionsPath;
  try {
    sessionsPath = resolveAgentSessionsStorePath(HOME_DIR, agent);
  } catch (error) {
    process.stderr.write(`[${BRAND}] Refusing unsafe sessions store path: ${error.message}\n`);
    return null;
  }
  try {
    return assertValidSessionStore(
      JSON.parse(readFileSync(sessionsPath, 'utf-8')),
      `sessions store for agent ${JSON.stringify(agent)}`,
    );
  } catch (error) {
    if (error instanceof SyntaxError || error?.code) return null;
    process.stderr.write(`[${BRAND}] Refusing unsafe sessions store metadata: ${error.message}\n`);
    return null;
  }
}

function getSessionJsonlPath(agent = 'main', sessionId) {
  if (!sessionId) return null;
  try {
    return resolveSessionTranscriptPath(HOME_DIR, agent, sessionId);
  } catch (error) {
    process.stderr.write(`[${BRAND}] Refusing unsafe session transcript path: ${error.message}\n`);
    return null;
  }
}

function inspectSessionActivitySignal(sessionKey, sessionsStore) {
  if (!sessionKey || !sessionsStore?.[sessionKey]) {
    return {
      found: false,
      hasStartedSignal: false,
      hasActivitySignal: false,
      messageCount: null,
      jsonlExists: false,
      hasTokens: false,
      updatedAtMs: null,
      sessionStartedAtMs: null,
      sessionId: null,
    };
  }

  const agent = agentFromSessionKey(sessionKey) || 'main';
  const entry = sessionsStore[sessionKey];
  const jsonlPath = getSessionJsonlPath(agent, entry.sessionId);
  const jsonlExists = jsonlPath ? existsSync(jsonlPath) : false;
  const hasTokens = typeof entry.totalTokens === 'number' && entry.totalTokens > 0;
  const sessionStartedAtMs = toTimestampMs(entry.sessionStartedAt || entry.startedAt);
  const updatedAtMs = toTimestampMs(entry.updatedAt);
  const hasStartedSignal = Boolean(entry.sessionId) || sessionStartedAtMs !== null || updatedAtMs !== null;
  let messageCount = null;

  try {
    const history = gatewayCall('chat.history', { sessionKey }, { timeout: 8000 });
    if (Array.isArray(history?.messages)) {
      messageCount = history.messages.length;
    }
  } catch {}

  return {
    found: true,
    hasStartedSignal,
    hasActivitySignal: jsonlExists || hasTokens || (typeof messageCount === 'number' && messageCount > 0),
    messageCount,
    jsonlExists,
    hasTokens,
    updatedAtMs,
    sessionStartedAtMs,
    sessionId: entry.sessionId || null,
  };
}

function inspectSessionBootstrapFailure(sessionKey, sessionsStore, spawnedAtMs, startupGraceMs) {
  if (!sessionKey || !sessionsStore?.[sessionKey]) {
    return { shouldResolve: false, reason: null, errorMsg: null };
  }

  const ageMs = spawnedAtMs ? Date.now() - spawnedAtMs : Infinity;
  if (ageMs < startupGraceMs) {
    return { shouldResolve: false, reason: null, errorMsg: null };
  }

  const laneError = getGatewayLaneTaskError(sessionKey);
  if (laneError.found && laneError.error) {
    return {
      shouldResolve: true,
      reason: `diagnostic lane error: ${laneError.error}`,
      errorMsg: `spawn-failure: ${laneError.error}`,
    };
  }

  // A Codex session can enter the sessions store before chat.history, JSONL, or
  // token counters are written. Treat that as "still booting"; the watcher and
  // job timeout own later failure handling. Only fail fast when the gateway has
  // recorded an explicit lane error above.
  return { shouldResolve: false, reason: null, errorMsg: null };
}

function readJsonlTailEntries(sessionId, agent = 'main', maxLines = 200) {
  if (!sessionId) return null;
  try {
    const jsonlPath = getSessionJsonlPath(agent, sessionId);
    if (!jsonlPath) return null;
    return readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .slice(-maxLines)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Auto-detect the originating channel from the most recently active main session.
 * Reads sessions.json, finds sessions active within the last 10 minutes,
 * excludes subagent sessions, returns deliveryContext.to of the most recent one.
 *
 * @returns {string|null} - e.g. "telegram:-100200000000", or null if not found
 */
/**
 * Infer the chat type ("group" | "direct" | "") from a session object and its key.
 * Checks session.chatType first, then falls back to key pattern matching.
 * Key patterns:  agent:main:<channel>:group:<id>   → group
 *                agent:main:<channel>:direct:<id>  → direct
 */
function inferChatType(key, session) {
  if (session.chatType) return session.chatType;
  if (key.includes(":group:")) return "group";
  if (key.includes(":direct:")) return "direct";
  return "";
}

function parseOriginTarget(origin) {
  const match = /^([^:]+):(.+)$/.exec(origin || '');
  if (!match) return { channel: null, target: null };
  return { channel: match[1], target: match[2] };
}

function originFromDeliveryTarget(deliverTo, deliverChannel = 'telegram') {
  if (!deliverTo) return null;
  return `${deliverChannel || 'telegram'}:${deliverTo}`;
}

function getActiveOriginFromSessions() {
  const store = readSessionsStore("main");
  if (!store) return null;

  const TEN_MIN_MS = 10 * 60 * 1000;

  /** @type {Array<{origin: string, updatedAt: number, chatType: string}>} */
  const candidates = [];

  for (const [key, session] of Object.entries(store)) {
    // Only consider main sessions, not subagents
    // Pattern: agent:main:<channel>:<type>:<id>  but NOT agent:main:subagent:*
    if (!key.startsWith("agent:main:")) continue;
    if (key.includes(":subagent:")) continue;

    const updatedAt = session.updatedAt
      ? (typeof session.updatedAt === "number"
          ? session.updatedAt
          : new Date(session.updatedAt).getTime())
      : 0;

    // Must be recently active
    if (Date.now() - updatedAt > TEN_MIN_MS) continue;

    // Prefer deliveryContext.to if available
    const deliveryTo = session.deliveryContext?.to || null;
    if (!deliveryTo) continue;

    candidates.push({
      origin: deliveryTo,
      updatedAt,
      chatType: inferChatType(key, session),
    });
  }

  if (candidates.length === 0) return null;

  // Tiebreaker: prefer group sessions over direct/DM sessions.
  // When both a DM and a group session are recently active, the DM session
  // often has a more recent updatedAt (agent just replied there), but the
  // triggering context was the group chat.  Within the same chat type, prefer
  // the most recently updated session.
  const typeScore = (chatType) => {
    if (chatType === "group")  return 2;
    if (chatType === "direct") return 0;
    return 1; // unknown / other
  };

  candidates.sort((a, b) => {
    const scoreDiff = typeScore(b.chatType) - typeScore(a.chatType);
    if (scoreDiff !== 0) return scoreDiff;
    return b.updatedAt - a.updatedAt;
  });

  return candidates[0].origin;
}

/**
 * Parse the agent ID from a session key.
 * Session key format: agent:{agentId}:...
 * Bare validated keys use the main agent; malformed keys are rejected.
 */
function agentFromSessionKey(sessionKey) {
  if (!sessionKey) return assertValidAgentId('main');
  return validatedAgentIdFromSessionKey(sessionKey, 'main');
}

function getSessionJsonlMtimeMs(agent, sessionId) {
  const jsonlPath = getSessionJsonlPath(agent, sessionId);
  if (!jsonlPath) return null;
  try {
    return statSync(jsonlPath).mtimeMs;
  } catch {
    return null;
  }
}

function getJsonlPendingToolReason(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const last = entries[entries.length - 1];

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

function getJsonlTerminalReplyReason(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const terminalReply = extractTerminalAssistantReplyFromEntries(entries);
  if (!terminalReply) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.role === 'assistant') {
      return entry.stop_reason === 'end_turn'
        ? 'terminal assistant reply observed in JSONL'
        : null;
    }
  }

  return null;
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

function getJsonlTurnAbortReason(entries) {
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

function getJsonlArtifactEvidence(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const reason = entryArtifactEvidenceReason(entries[i]);
    if (reason) return { found: true, reason };
  }

  return null;
}

function checkSessionTurnAborted(labelEntry, sessionsStore) {
  if (!labelEntry?.sessionKey) return { shouldResolve: false };

  const agent = labelEntry.agent || agentFromSessionKey(labelEntry.sessionKey) || 'main';
  const sessionEntry = sessionsStore?.[labelEntry.sessionKey] || null;
  const sessionId = sessionEntry?.sessionId || labelEntry.sessionId || null;
  if (!sessionId) return { shouldResolve: false };

  const entries = readJsonlTailEntries(sessionId, agent, 80);
  const reason = getJsonlTurnAbortReason(entries);
  if (!reason) return { shouldResolve: false };

  return {
    shouldResolve: true,
    reason,
    lastActivity: getSessionJsonlMtimeMs(agent, sessionId),
    sessionStatus:
      typeof sessionEntry?.status === 'string' ? sessionEntry.status.trim().toLowerCase() : '',
  };
}

// -- Gateway Session State Check ------------------------------

/**
 * Determine if a session should be auto-resolved as "done" based on sessions.json state.
 *
 * Decision logic (in priority order):
 *   1. Store unavailable (null)                    -> do NOT resolve (safe default)
 *   2. Session key NOT in store                    -> resolve (never spawned or spawn failure)
 *   3. Session found but idle past threshold       -> resolve (completed)
 *   4. Session has recent activity                 -> do NOT resolve
 *
 * @param {string}      sessionKey       - The session key to check
 * @param {Object|null} sessionsStore    - Sessions.json object (null = unavailable)
 * @param {number}      thresholdMs      - Silence threshold in ms
 * @param {boolean}     [sessionEverFound=true] - Whether the session was ever seen in the store.
 *                                                Pass false to get a distinct "spawn likely failed"
 *                                                reason instead of "session not found in sessions store".
 * @param {number}      [spawnedAtMs=0]  - Timestamp (ms) when the session was spawned (0 = unknown)
 * @returns {{ shouldResolve: boolean, reason: string, lastActivity: number|null, is529?: boolean, errorMsg?: string }}
 */
function checkSessionDone(sessionKey, sessionsStore, thresholdMs, sessionEverFound = true, spawnedAtMs = 0) {
  // 0. Check gateway error log for 529/overload errors FIRST.
  //    If we find a 529, we should resolve as error, not done.
  const logCheck = check529InGatewayLog(sessionKey);

  if (sessionsStore === null) {
    // Store unavailable -- safe default is to NOT auto-resolve
    return {
      shouldResolve: false,
      reason:       'sessions store unavailable for state check',
      lastActivity:  null,
    };
  }

  // 1. Not in sessions store -> session never appeared or already cleaned up
  //    BUT: young sessions (<5 min old) may simply not have propagated yet,
  //    especially right after a gateway restart. Don't auto-resolve those.
  //    Also: in openclaw 2026.3.13+, subagent sessions are tracked via
  //    SessionBindingService and are NOT written to sessions.json. Fall back
  //    to the gateway sessions.list API before concluding the session is done.
  const YOUNG_SESSION_MS = 5 * 60 * 1000;
  if (!sessionsStore[sessionKey]) {
    const ageMs = spawnedAtMs ? Date.now() - spawnedAtMs : Infinity;
    if (ageMs < YOUNG_SESSION_MS) {
      return {
        shouldResolve: false,
        reason:       'session young, not yet in sessions store -- deferring',
        lastActivity:  null,
      };
    }

    // Gateway API fallback: check if session is actually still active.
    // Subagents in 2026.3.13+ are NOT written to sessions.json, so absence
    // from the store does not mean the session is gone.
    try {
      const listResult = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 8000 });
      const liveSession = listResult?.sessions?.find(s => s.key === sessionKey);
      if (liveSession) {
        // Session is alive in gateway -- do NOT auto-resolve
        return {
          shouldResolve: false,
          reason:       'session not in sessions.json but confirmed active via gateway API',
          lastActivity:  liveSession.updatedAt || null,
        };
      }
    } catch {
      // Gateway unreachable -- safe default: do NOT auto-resolve
      return {
        shouldResolve: false,
        reason:       'sessions store miss + gateway API unreachable -- deferring',
        lastActivity:  null,
      };
    }

    return {
      shouldResolve: true,
      reason:       logCheck.found
        ? `529/overload error detected: ${logCheck.error}`
        : sessionEverFound
          ? 'session not found in sessions store or gateway API'
          : 'session never found -- spawn likely failed',
      lastActivity:  null,
      is529:         logCheck.found,
      errorMsg:      logCheck.error || null,
    };
  }

  // 2. Session exists in store, check idle time.
  const entry = sessionsStore[sessionKey];
  const agent = agentFromSessionKey(sessionKey) || 'main';
  const updatedAtMs = toTimestampMs(entry.updatedAt);
  const lastActivityAtMs = toTimestampMs(entry.lastActivityAt);
  const jsonlMtimeMs = getSessionJsonlMtimeMs(agent, entry.sessionId);
  const activityTimes = [updatedAtMs, lastActivityAtMs, jsonlMtimeMs].filter(t => typeof t === 'number');
  const lastActivity = activityTimes.length ? Math.max(...activityTimes) : null;
  const silenceMs = lastActivity === null ? Infinity : Date.now() - lastActivity;
  const sessionStatus = typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : '';

  if (isTerminalAbnormalSessionStatus(sessionStatus)) {
    const terminalReason = entry.abortedLastRun === true
      ? `gateway sessions store status=${sessionStatus} (abortedLastRun=true)`
      : `gateway sessions store status=${sessionStatus}`;
    return {
      shouldResolve: true,
      reason: terminalReason,
      lastActivity,
      sessionStatus,
    };
  }

  if (entry.sessionId) {
    const entries = readJsonlTailEntries(entry.sessionId, agent, 20);
    const turnAbortReason = getJsonlTurnAbortReason(entries);
    if (turnAbortReason) {
      return {
        shouldResolve: true,
        reason:       turnAbortReason,
        lastActivity,
      };
    }

    const pendingToolReason = getJsonlPendingToolReason(entries);
    if (pendingToolReason) {
      return {
        shouldResolve: false,
        reason:       `session JSONL shows pending work: ${pendingToolReason}`,
        lastActivity,
      };
    }

    const terminalReplyReason = getJsonlTerminalReplyReason(entries);
    if (terminalReplyReason) {
      return {
        shouldResolve: false,
        reason:       `${terminalReplyReason}; watcher/result path should deliver completion`,
        lastActivity,
      };
    }
  }

  if (silenceMs >= thresholdMs) {
    return {
      shouldResolve: true,
      reason:       logCheck.found
        ? `529/overload error detected: ${logCheck.error}`
        : `session idle ${Math.round(silenceMs / 60000)}min in sessions store (completed)`,
      lastActivity,
      is529:         logCheck.found,
      errorMsg:      logCheck.error || null,
      sessionStatus,
    };
  }

  // Session has recent activity -- might still be working
  return {
    shouldResolve: false,
    reason:       'session has recent activity in sessions store',
    lastActivity,
    sessionStatus,
  };
}

// openclaw's SessionEntry.status vocabulary is exactly
// running|done|failed|killed|timeout (src/config/sessions/types.ts,
// isTerminalSessionStatus). Only the abnormal terminal states mean the agent
// stopped without signalling done, so only those may short-circuit liveness to
// "interrupted". 'done' is a clean turn end handled by the done path / normal
// idle liveness -- treating it as terminal here would race a late cmdDone and
// emit a spurious "interrupted" announce.
const TERMINAL_ABNORMAL_SESSION_STATUSES = new Set(['timeout', 'failed', 'killed']);

function isTerminalAbnormalSessionStatus(status) {
  return TERMINAL_ABNORMAL_SESSION_STATUSES.has(status);
}

function hasTerminalSessionStoreStatus(sessionEntry) {
  const sessionStatus =
    typeof sessionEntry?.status === 'string' ? sessionEntry.status.trim().toLowerCase() : '';
  return isTerminalAbnormalSessionStatus(sessionStatus);
}

// -- Watchdog Helpers -----------------------------------------

/**
 * Disarm (disable) a watchdog job for a label if one is registered.
 * Best-effort -- failures are logged but don't throw.
 */
function disarmWatchdog(label) {
  const entry = getLabel(label);
  if (!entry?.watchdogJobId) return;
  try {
    const schedulerCli = resolveSchedulerCliPath();
    execFileSync(process.execPath, [schedulerCli, 'jobs', 'delete', entry.watchdogJobId], {
      encoding: 'utf-8',
      timeout:  5000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    });
    process.stderr.write(`[${BRAND}] watchdog deleted for ${label}\n`);
  } catch (err) {
    process.stderr.write(`[${BRAND}] watchdog disarm failed for ${label}: ${err.message}\n`);
  }
}

function disarmDeliveryWatcher(label) {
  const entry = getLabel(label);
  if (!entry?.deliveryWatcherJobId) return;
  try {
    const schedulerCli = resolveSchedulerCliPath();
    execFileSync(process.execPath, [schedulerCli, 'jobs', 'delete', entry.deliveryWatcherJobId], {
      encoding: 'utf-8',
      timeout:  5000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    });
    setLabel(label, { deliveryWatcherJobId: null });
    process.stderr.write(`[${BRAND}] delivery watcher deleted for ${label}\n`);
  } catch (err) {
    process.stderr.write(`[${BRAND}] delivery watcher disarm failed for ${label}: ${err.message}\n`);
  }
}


function quoteForSingleQuotedShell(value) {
  return String(value).replace(/'/g, "'\"'\"'");
}

/**
 * Schedule a quick-poll delivery watcher shell job for a dispatch label.
 * Used both for the initial watcher registration and SIGTERM handoffs.
 */
function scheduleDeliveryWatcherJob({
  label,
  deliverTo,
  deliverChannel = 'telegram',
  timeoutSeconds = 300,
  idleThresholdSeconds = 300,
  origin = 'system',
  agentBrand = BRAND,
  nameSuffix = '',
}) {
  if (!label) throw new Error('label is required');
  if (!deliverTo) throw new Error('deliverTo is required');

  const schedulerCli = resolveSchedulerCliPath();
  const watcherPath = resolveDispatchScriptPath('watcher.mjs');
  const dispatchIndexPath = resolveDispatchScriptPath('index.mjs');
  const nodePath = resolvePersistentNodePath();
  const watcherTimeoutS = Number(timeoutSeconds) + 120;
  const idleThresholdS = Number(idleThresholdSeconds) || 300;
  const sq = quoteForSingleQuotedShell;
  const watcherCmd =
    `DISPATCH_CONFIG_DIR='${sq(dispatchConfigDirForChild())}' ` +
    `DISPATCH_STATE_DIR='${sq(LABELS_STATE_DIR)}' ` +
    `DISPATCH_LABELS_PATH='${sq(LABELS_PATH)}' ` +
    `DISPATCH_INDEX_PATH='${sq(dispatchIndexPath)}' ` +
    `'${sq(nodePath)}' '${sq(watcherPath)}' ` +
    `--label '${sq(label)}' --timeout ${watcherTimeoutS} ` +
    `--poll-interval 20 --idle-threshold ${idleThresholdS} --once`;

  const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const jobSpec = {
    name:                     `${agentBrand}-deliver:${label}${nameSuffix}`,
    schedule_kind:            'cron',
    schedule_cron:            config.deliver_watcher_cron || '* * * * *',
    next_run_at:              nowUtc,
    session_target:           'shell',
    payload_kind:             'shellCommand',
    payload_message:          watcherCmd,
    delivery_mode:            'announce-always',
    delivery_channel:         deliverChannel,
    delivery_to:              deliverTo,
    delivery_guarantee:       'at-least-once',
    ttl_hours:                config.deliver_watcher_ttl_hours ?? 48,
    overlap_policy:           'skip',
    run_timeout_ms:           120_000,
    delete_after_run:         1,
    origin:                   origin || 'system',
  };

  const raw = execFileSync(process.execPath, [schedulerCli, '--json', 'jobs', 'add', JSON.stringify(jobSpec)], {
    encoding: 'utf-8',
    timeout:  10000,
    stdio:    ['pipe', 'pipe', 'pipe'],
  });

  const parsed = JSON.parse(raw.trim());
  return parsed?.job || null;
}

// -- Session Helpers ------------------------------------------

/** Build a unique session key for a new subagent session. */
function makeSessionKey(agentId) {
  return `agent:${agentId}:subagent:${randomUUID()}`;
}

// -- Subcommands ----------------------------------------------

/**
 * enqueue -- spawn a session via gateway API.
 *
 * Flags:
 *   --label <string>         Required. Human-readable name
 *   --message <string>       Prompt sent to the agent
 *   --message-file <path>    Read prompt text from a file (`-` = stdin)
 *   --message-env <VAR>      Read prompt text from an environment variable
 *   --message-stdin          Read prompt text from stdin explicitly
 *                            (stdin is also auto-read when piped and no other message source is set)
 *   --agent <string>         Agent ID (default: main)
 *   --thinking <string>      Reasoning level: low|high|xhigh (default: not set)
 *   --timeout <seconds>      Run timeout in seconds (default: 300)
 *   --origin <origin>        Explicit dispatch origin for audit/retries (e.g. "telegram:<chat_id>", "system")
 *                            If omitted but --deliver-to is explicit, dispatch derives origin from that target.
 *                            Active-session auto-detect is preserved only as a manual/local fallback when both are absent.
 *   --deliver-to <target>    Delivery target (e.g. Telegram chat ID). Registers the scheduler watcher for durable final delivery.
 *                            Chat-triggered callers should pass inbound metadata chat_id here, especially for group chats.
 *                            Defaults to origin chat ID when --origin is a "telegram:<id>" string.
 *   --deliver-channel <ch>   Delivery channel for --deliver-to (default: telegram)
 *   --delivery-mode <mode>   announce|announce-always|none (default: announce)
 *   --mode <fresh|reuse>
 *       fresh  -- always spawn new session (default)
 *       reuse  -- look up prior session_key for this label, send into it
 *   --session-key <key>      Explicit session key override
 *   --model <string>         Model override (e.g. anthropic/claude-sonnet-4-6)
 */
async function cmdEnqueue(flags) {
  const label = flags.label;
  if (!label) die('--label is required', 2);

  let message = null;
  try {
    message = await resolveMessageInput({
      message: flags.message,
      messageFile: flags['message-file'],
      messageEnv: flags['message-env'],
      messageStdin: flags['message-stdin'],
    });
  } catch (err) {
    die(err.message, 2);
  }
  if (message === null || message.length === 0) {
    die('--message, --message-file, --message-env, --message-stdin, or piped stdin is required', 2);
  }

  let agent;
  try {
    agent = assertValidAgentId(flags.agent === undefined ? 'main' : flags.agent, '--agent');
  } catch (error) {
    die(error.message, 2);
  }
  const thinking    = flags.thinking         || null;
  const timeoutS    = parseInt(flags.timeout || '300', 10);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) die('--timeout must be a positive integer', 2);
  // Warn loudly when --timeout falls back to default -- silent fallback caused hard-to-debug
  // watcher kills: the flag parser silently drops flags that appear after a multiline --message
  // value in shell heredocs. Operator should always pass --timeout explicitly.
  if (!flags.timeout) {
    process.stderr.write(`[${BRAND}] WARNING: --timeout not specified, defaulting to 300s. ` +
      `Pass --timeout explicitly (≥1200 for thinking=high tasks) to avoid premature watcher kills.\n`);
  }
  const gatewayTimeoutS = getDispatchGatewayTimeoutSeconds({
    timeoutSeconds: timeoutS,
    thinking,
    lane: 'subagent',
  });
  if (gatewayTimeoutS !== timeoutS) {
    process.stderr.write(
      `[${BRAND}] elevating gateway agent timeout from ${timeoutS}s to ${gatewayTimeoutS}s ` +
      `for ${thinking || 'high'}-thinking subagent work; dispatch liveness stays at ${timeoutS}s.\n`,
    );
  }
  const explicitOrigin = flags.origin || null;
  const explicitDeliverTo = flags['deliver-to'] || null;
  const explicitDeliverChannel = flags['deliver-channel'] || null;
  let origin = explicitOrigin;

  // Contract: chat-triggered callers should pass --deliver-to from inbound
  // metadata chat_id. If they omit --origin, derive it from that explicit
  // delivery target so dispatch never falls back to whichever session happened
  // to be active most recently.
  if (!origin && explicitDeliverTo) {
    origin = originFromDeliveryTarget(explicitDeliverTo, explicitDeliverChannel || 'telegram');
  }

  // Preserve active-session inference only as a manual/local fallback when the
  // caller truly omitted both origin and delivery target.
  if (!origin && !explicitDeliverTo) {
    origin = getActiveOriginFromSessions();
    if (origin) {
      process.stderr.write(`[${BRAND}] auto-detected origin from active session: ${origin}\n`);
      process.stderr.write(`[${BRAND}] NOTE: active-session origin detection is a manual/local fallback. ` +
        `Chat-triggered callers should pass --deliver-to from inbound metadata chat_id.\n`);
    }
  }

  // -- Auto-derive deliver-to from origin ---------------------------------
  // If origin is "telegram:<id>", use <id> as the default deliver-to target.
  let defaultDeliverTo   = null;
  let defaultDeliverCh   = explicitDeliverChannel || 'telegram';
  if (origin) {
    const { channel, target } = parseOriginTarget(origin);
    if (channel && target) {
      if (!explicitDeliverChannel) defaultDeliverCh = channel;
      defaultDeliverTo = target;
    }
  }

  const deliverTo      = explicitDeliverTo         || defaultDeliverTo;
  const deliverChannel = explicitDeliverChannel     || defaultDeliverCh || 'telegram';
  const deliverMode    = flags['delivery-mode']     || 'announce';
  const mode        = flags.mode             || 'fresh';

  // -- Auto-inject ORIGIN_CHAT_ID into prompt message ---------
  // Ensures the spawned agent always knows where to send message tool calls,
  // matching the delivery target. Skip if already present (caller is explicit)
  // or if there's no delivery target.
  if (deliverTo && !message.includes('ORIGIN_CHAT_ID:')) {
    message = `ORIGIN_CHAT_ID: ${deliverTo}\n\n${message}`;
  }

  // -- Verify command flag -----------------------------------
  const verifyCmd       = flags['verify-cmd'] || null;

  // -- Watchdog monitoring flags -----------------------------
  const noMonitorRaw    = flags['no-monitor'];
  const noMonitorReason = typeof noMonitorRaw === 'string' && noMonitorRaw.trim()
    ? noMonitorRaw.trim()
    : null;
  const noMonitor       = !!noMonitorRaw;
  const monitorEnabled  = !noMonitor && flags.monitor !== 'false';
  const monitorInterval = flags['monitor-interval'] || config.watchdogIntervalCron || '*/15 * * * *';
  const monitorTimeout  = parseInt(flags['monitor-timeout'] || String(config.watchdogTimeoutMin ?? 60), 10);
  if (!Number.isFinite(monitorTimeout) || monitorTimeout <= 0) die('--monitor-timeout must be a positive integer', 2);

  // -- Delivery enforcement for agentTurn jobs -----------------
  // agentTurn jobs must have a delivery target OR explicitly opt out via --no-monitor "<reason>"
  const isAgentTurn = !flags['payload-kind'] || flags['payload-kind'] === 'agentTurn';
  if (isAgentTurn && !deliverTo && !noMonitor) {
    die(
      "REJECTED: --deliver-to is required for dispatch jobs.\n" +
      "Pass --deliver-to <chat_id> (e.g. --deliver-to -100200000000 for a group, " +
      "or --deliver-to 123456789 for a DM).\n" +
      "Chat-triggered callers should pass inbound metadata chat_id here, especially for group chats.\n" +
      "Alternatively, pass --origin telegram:<chat_id> to auto-derive the delivery target.\n" +
      "Pass --no-monitor \"<reason>\" only if you explicitly want to skip delivery (audit trail required).",
      2
    );
  }

  // Dynamic branding: resolve per-agent brand name
  const agentBrand = config.agents?.[agent]?.name || (agent !== 'main' ? agent : null) || config.name || 'dispatch';
  const model       = flags.model            || DEFAULT_DISPATCH_MODEL;

  // -- Session key resolution ----------------------------------
  let sessionKey = Object.hasOwn(flags, 'session-key') ? flags['session-key'] : null;
  if (sessionKey !== null) {
    try {
      sessionKey = assertSessionKeyForAgent(sessionKey, agent, '--session-key');
    } catch (error) {
      die(error.message, 2);
    }
  }

  if (!sessionKey && mode === 'reuse') {
    const existing = getLabel(label);
    if (existing?.sessionKey) {
      sessionKey = existing.sessionKey;
      process.stderr.write(`[${agentBrand}] mode=reuse -> continuing session ${sessionKey}\n`);
    } else {
      die(`mode=reuse: no prior session found for label "${label}". Use --mode fresh.`);
    }
  }

  const isFresh = !sessionKey;
  if (isFresh) {
    sessionKey = makeSessionKey(agent);
  }
  try {
    sessionKey = assertSessionKeyForAgent(sessionKey, agent, '--session-key');
  } catch (error) {
    die(error.message, 2);
  }

  const idem = randomUUID();

  // -- Patch session (model, thinking, spawnDepth) if fresh ----
  if (isFresh) {
    try {
      gatewayCall('sessions.patch', { key: sessionKey, spawnDepth: 1 }, { timeout: 10000 });
    } catch (err) {
      die(`sessions.patch (spawnDepth) failed: ${err.message}`);
    }

    if (model) {
      try {
        gatewayCall('sessions.patch', { key: sessionKey, model }, { timeout: 10000 });
      } catch (err) {
        die(`sessions.patch (model) failed: ${err.message}`);
      }
    }

    if (thinking) {
      try {
        gatewayCall('sessions.patch', {
          key: sessionKey,
          thinkingLevel: thinking === 'off' ? null : thinking,
        }, { timeout: 10000 });
      } catch (err) {
        process.stderr.write(`[${agentBrand}] sessions.patch (thinking) warning: ${err.message}\n`);
      }
    }
  }

  // -- Build the task message ----------------------------------
  const parts = [
    `[Subagent Context] You are running as a subagent (depth 1/3). Results auto-announce to your requester; do not busy-poll for status.`,
    ``,
  ];

  // -- Checkpoint notify command (mid-run status messages) -----
  // Agents can call this command at logical checkpoints to send status updates
  // that will be delivered to the inbox consumer (and ultimately Telegram).
  const schedulerCliPath = resolveSchedulerCliPath();
  const checkpointNotifyCmd = `node '${schedulerCliPath}' messages send --from '${label.replace(/'/g, "'\\''")}' --to main --kind status --body`;

  // Prepend CHECK_IN template when delivery target is set
  if (deliverTo) {
    parts.push(`---`);
    parts.push(`CHECK_IN: To report progress, use curl:`);
    parts.push(`GW_TOKEN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.openclaw/openclaw.json','utf8')).gateway.auth.token)")`);
    // Sanitize values for safe embedding in JSON inside a shell single-quoted string
    const safeJson = (v) => String(v || '').replace(/[\\'"\n\r]/g, '');
    const safeChannel = safeJson(deliverChannel || 'telegram');
    const safeTarget = safeJson(deliverTo);
    const safeLabel = safeJson(label);
    parts.push(`curl -s -X POST '${GATEWAY_TOOLS_INVOKE_URL}' -H 'Content-Type: application/json' -H "Authorization: Bearer $GW_TOKEN" -d '{"tool":"message","args":{"action":"send","channel":"${safeChannel}","target":"${safeTarget}","message":"[${safeLabel}] <your status here>"},"sessionKey":"main"}'`);
    parts.push(`Call this every ~5 minutes with a brief progress update.`);
    parts.push(`---`);
    parts.push(``);
  }

  parts.push(`[Subagent Task]: ${message}`);

  // -- Checkpoint notify instructions ---------------------------
  parts.push(``);
  parts.push(`---`);
  parts.push(`CHECKPOINT MESSAGING: You can send mid-run status updates using this command:`);
  parts.push(`  ${checkpointNotifyCmd} "<message>"`);
  parts.push(`Call this at logical checkpoints: start of a major step, on conflict/error, before completing.`);
  parts.push(`Example: ${checkpointNotifyCmd} "Starting step 2: running tests"`);
  parts.push(`---`);
  parts.push(``);

  // Append agent-side done signal instructions (Fix 2 -- push-based completion)
  // Always point to dispatch/index.mjs (__dirname) -- the canonical done handler.
  const doneScriptPath = join(__dirname, 'index.mjs');
  parts.push(``);
  parts.push(`---`);
  parts.push(buildCompletionSignalInstructions({
    label,
    taskPrompt: message,
    doneScriptPath,
  }));
  parts.push(`---`);
  parts.push(``);
  parts.push(`---`);
  parts.push(`DELIVERY RULE: Do NOT use the message tool, sessions_send, or any direct messaging to send updates or results to Telegram or any chat. Do NOT reference chat IDs, user IDs, or delivery targets in your work.`);
  parts.push(`Your ONLY output channel is the done signal above. The scheduler handles delivery automatically.`);
  if (origin) {
    parts.push(`Note: This job will be delivered to origin channel: ${origin}`);
  }
  parts.push(`---`);

  const taskMessage = parts.join('\n');

  // -- Call gateway agent method -------------------------------
  // Final user delivery belongs to the scheduler watcher below.
  // Keep the gateway spawn fire-and-forget so raw tool output or internal
  // done payloads cannot leak directly to the chat ahead of the durable
  // post-office delivery path.
  try {
    const response = gatewayCall('agent', {
      message:        taskMessage,
      sessionKey,
      idempotencyKey: idem,
      deliver:        false,
      lane:           'subagent',
      timeout:        gatewayTimeoutS,
      label:          label,
      thinking:       thinking || undefined,
      ...(deliverTo ? {
        channel:      deliverChannel,
        replyTo:      deliverTo,
        replyChannel: deliverChannel,
      } : {}),
    }, { timeout: 15000 });

    const deliveryDisabled = !deliverTo && noMonitor;
    const deliveryDisabledReason = deliveryDisabled
      ? (noMonitorReason || 'explicit opt-out via --no-monitor')
      : null;

    // Update ledger
    setLabel(label, {
      sessionKey,
      runId:     response?.runId || idem,
      agent,
      mode:      isFresh ? 'fresh' : 'reuse',
      model:     model || null,
      thinking,
      origin:         origin || null,
      deliverTo:      deliverTo || null,
      deliverChannel: deliverChannel || null,
      deliveryMode:   deliverMode || null,
      deliveryDisabled,
      deliveryDisabledReason,
      verifyCmd:      verifyCmd || null,
      spawnedAt:      new Date().toISOString(),
      timeoutSeconds: timeoutS,
      gatewayTimeoutSeconds: gatewayTimeoutS,
      idleThresholdSeconds: parseInt(flags['idle-threshold'] || '300', 10),
      // Fix 4: Store timeout so cmdDone threshold logic can use it correctly.
      timeout:        timeoutS,
      status:         'running',
      summary:        null,
      error:          null,
      // Store task prompt for gate checks in done (first 2000 chars)
      taskPrompt:     message.slice(0, 2000),
    });

    // Reserve this run's delivery scope before a stale watcher from an earlier
    // use of the same label can claim the fresh completion.
    if (!deliveryDisabled) {
      resetCompletionDeliveryClaim({
        label,
        sessionKey,
        runId: response?.runId || idem,
      });
    }

    // Fire dispatch.started hook (best-effort)
    await onStarted({
      label, job_id: idem, run_id: response?.runId || idem,
      agent, mode, session_key: sessionKey,
    }).catch(() => {});

    // -- Send "Starting" notification via gateway HTTP API -----
    if (deliverTo && GATEWAY_TOKEN) {
      try {
        await fetch(GATEWAY_TOOLS_INVOKE_URL, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GATEWAY_TOKEN}`,
          },
          body: JSON.stringify({
            tool: 'message',
            args: {
              action: 'send',
              channel: deliverChannel,
              target: deliverTo,
              message: `🌶️ *${agentBrand}* [${label}] starting...`,
            },
            sessionKey: 'main',
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        process.stderr.write(`[${agentBrand}] starting notification failed: ${err.message}\n`);
      }
    }

    // -- Register scheduler watcher for delivery ---------------
    // Creates a quick-poll shell job that runs watcher.mjs once per tick. Empty
    // stdout means "still running" and advances the next tick without delivery.
    // The watcher enqueues terminal output directly into the durable outbox;
    // stdout remains only as a route-less compatibility fallback.
    const sq = s => String(s).replace(/'/g, "'\\''");
    let schedulerWatcherOk = false;
    if (deliverTo && deliverMode !== 'none') {
      try {
        const watcherJob = scheduleDeliveryWatcherJob({
          label,
          deliverTo,
          deliverChannel,
          timeoutSeconds: timeoutS,
          idleThresholdSeconds: flags['idle-threshold'] || '300',
          origin: origin || 'system',
          agentBrand,
        });
        schedulerWatcherOk = true;
        if (watcherJob?.id) {
          setLabel(label, { deliveryWatcherJobId: watcherJob.id });
        }
        process.stderr.write(
          `[${agentBrand}] scheduler watcher registered: ${agentBrand}-deliver:${label}` +
          `${watcherJob?.id ? ` (${watcherJob.id})` : ''}\n`
        );
      } catch (err) {
        process.stderr.write(`[${agentBrand}] scheduler watcher FAILED (gateway fallback active): ${err.message}\n`);
      }
    }

    // -- Register watchdog monitoring job ---------------------
    let watchdogJobOk = false;
    let watchdogJobId = null;
    if (monitorEnabled && deliverTo) {
      try {
        const checkCmd =
          `DISPATCH_CONFIG_DIR='${sq(dispatchConfigDirForChild())}' ` +
          `DISPATCH_STATE_DIR='${sq(LABELS_STATE_DIR)}' ` +
          `DISPATCH_LABELS_PATH='${sq(LABELS_PATH)}' ` +
          `'${sq(resolvePersistentNodePath())}' '${sq(resolveDispatchScriptPath('index.mjs'))}' result --label '${sq(label)}'`;
        const alertChannel = deliverChannel || 'telegram';
        const alertTarget  = deliverTo;
        const watchdogSpec = JSON.stringify({
          name:                     `watchdog:${label}`,
          job_type:                 'watchdog',
          schedule_cron:            monitorInterval,
          session_target:           'shell',
          payload_kind:             'shellCommand',
          payload_message:          checkCmd,
          delivery_mode:            'none',
          run_timeout_ms:           120_000,  // 2 min: watchdog shell check should be fast
          watchdog_target_label:    label,
          watchdog_check_cmd:       checkCmd,
          watchdog_timeout_min:     monitorTimeout,
          watchdog_alert_channel:   alertChannel,
          watchdog_alert_target:    alertTarget,
          watchdog_self_destruct:   1,
          watchdog_started_at:      new Date().toISOString(),
          delete_after_run:         1,             // auto-delete after watchdog fires
          origin:                   origin || 'system',
        });
        const schedulerCli = resolveSchedulerCliPath();
        const addResult = execFileSync(process.execPath, [schedulerCli, 'jobs', 'add', watchdogSpec, '--watchdog', '--json'], {
          encoding: 'utf-8',
          timeout:  10000,
          stdio:    ['pipe', 'pipe', 'pipe'],
        });
        try {
          const parsed = JSON.parse(addResult.trim());
          watchdogJobId = parsed?.job?.id || null;
        } catch {}
        watchdogJobOk = true;

        // Store watchdog job ID in labels ledger for later cleanup
        if (watchdogJobId) {
          setLabel(label, { watchdogJobId });
        }

        process.stderr.write(`[${agentBrand}] watchdog registered: ${monitorInterval}, timeout: ${monitorTimeout}min\n`);
      } catch (err) {
        process.stderr.write(`[${agentBrand}] watchdog registration FAILED: ${err.message}\n`);
      }
    }

    const delivery = buildDispatchDeliverySurface({
      deliverTo,
      deliverChannel,
      deliveryMode: deliverMode,
      deliveryDisabled,
      deliveryDisabledReason,
      ...(deliverTo ? {
        scheduler: schedulerWatcherOk,
        gateway: true,
      } : {}),
    });

    out({
      ok:         true,
      label,
      sessionKey,
      runId:      response?.runId || idem,
      mode:       isFresh ? 'fresh' : 'reuse',
      agent,
      status:     'accepted',
      delivery,
      watchdog:   monitorEnabled ? {
        enabled:  watchdogJobOk,
        jobId:    watchdogJobId,
        interval: monitorInterval,
        timeout:  monitorTimeout,
        ...(monitorEnabled && !deliverTo ? { skipped: true, reason: 'no --deliver-to target' } : {}),
      } : null,
      message:    delivery.status === 'disabled'
        ? `Session spawned. Delivery intentionally disabled${delivery.reason ? ` (${delivery.reason}).` : '.'}`
        : schedulerWatcherOk
          ? 'Session spawned. Delivery via scheduler (primary) + gateway (secondary).'
          : deliverTo
            ? 'Session spawned. Delivery via gateway only (scheduler watcher failed).'
            : 'Session spawned. Delivery target missing or not recorded.',
    });

    // -- Post-spawn verification (Fix 3) --------------------------------
    // Canary: inspect sessions.json immediately, then wait up to 3 intervals to
    // confirm the session appeared in the store. A session store entry with
    // sessionId or startedAt/sessionStartedAt is enough: long first turns may not
    // flush JSONL, token counts, or chat.history until the model call completes.
    // The delivery watcher owns later completion/failure handling.
    const SPAWN_POLL_MAX = 3;
    const SPAWN_POLL_DELAY_MS = 10_000;
    let spawnConfirmed = false;
    for (let spawnPoll = 0; spawnPoll <= SPAWN_POLL_MAX; spawnPoll++) {
      const spawnStore = readSessionsStore(agent);
      const signal = inspectSessionActivitySignal(sessionKey, spawnStore);
      if (signal.hasStartedSignal || signal.hasActivitySignal) {
        spawnConfirmed = true;
        break;
      }
      if (spawnPoll < SPAWN_POLL_MAX) {
        await sleep(SPAWN_POLL_DELAY_MS);
      }
    }
    if (!spawnConfirmed) {
      const laneError = getGatewayLaneTaskError(sessionKey);
      const spawnError = laneError.found && laneError.error
        ? `spawn-failure: ${laneError.error}`
        : `spawn-failure: session ${sessionKey} never produced transcript/history within ` +
          `${(SPAWN_POLL_MAX * SPAWN_POLL_DELAY_MS) / 1000}s`;
      process.stderr.write(`[${agentBrand}] WARNING: ${spawnError}\n`);
      setLabel(label, {
        status: 'error',
        error: spawnError,
        summary: spawnError,
      });
      disarmWatchdog(label);
    }
  } catch (err) {
    die(`gateway agent call failed: ${err.message}`);
  }
}

/**
 * status -- show session status for a label.
 * Syncs from gateway state for "running" sessions before returning.
 *
 * Flags:
 *   --label <string>    Required
 */
function cmdStatus(flags) {
  const label = flags.label;
  if (!label) die('--label is required', 2);

  const entry = getLabel(label);
  if (!entry) {
    out({ ok: true, label, found: false, message: 'No session found for this label' });
    return;
  }

  let liveness   = null;
  let syncAction = null;

  // Read sessions.json store for state checks (replaces sessions_list API call)
  const statusAgent = entry.agent || agentFromSessionKey(entry.sessionKey) || 'main';
  const sessionsStore = readSessionsStore(statusAgent);

  // For "running" sessions, check sessions store and auto-resolve if done
  if (entry.status === 'running' && entry.sessionKey) {
    const spawnedAtMs = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
    const ageMs = Date.now() - spawnedAtMs;
    const STARTUP_GRACE_MS = config.startupGraceMs ?? 300_000;

    const bootstrapFailure = !entry.lastPing
      ? inspectSessionBootstrapFailure(
          entry.sessionKey,
          sessionsStore,
          spawnedAtMs,
          STARTUP_GRACE_MS,
        )
      : { shouldResolve: false, reason: null, errorMsg: null };
    if (bootstrapFailure.shouldResolve) {
      setLabel(label, {
        status:  'error',
        error:   bootstrapFailure.errorMsg,
        summary: `Auto-resolved as spawn failure: ${bootstrapFailure.reason}`,
      });
      syncAction = `auto-resolved as spawn failure: ${bootstrapFailure.reason}`;
      disarmWatchdog(label);
    } else {
      const turnAbortCheck = checkSessionTurnAborted(entry, sessionsStore);
      if (turnAbortCheck.shouldResolve) {
        setLabel(label, {
          status:  'interrupted',
          summary: buildAutoResolvedIncompleteSummary({
            sessionStatus: turnAbortCheck.sessionStatus,
            reason: turnAbortCheck.reason,
          }),
        });
        syncAction = `auto-resolved as interrupted: ${turnAbortCheck.reason}`;
        disarmWatchdog(label);
      } else {
        // -- Heartbeat-based liveness guard --------------------------------
        // The watcher process writes lastPing every 60s while the session is
        // live. If the ping is fresh, the watcher is alive and working --
        // defer auto-resolve to avoid killing sessions during slow tool calls,
        // docker builds, etc.
        //
        // PING_STALE_MS:   3x the 60s ping interval -- if we haven't heard
        //                  from the watcher in 3 min, it's probably dead; fall
        //                  through to check.
        // hardCeilingMs:   timeout/reasoning-aware hard ceiling. High-thinking
        //                  work gets a larger quiet window before hard failure.
        // idleThresholdMs: timeout/reasoning-aware quiet threshold. Ambiguous
        //                  or missing liveness stays running until these thresholds.
        const livenessPolicy = getDispatchLivenessPolicy(entry, {
          startupGraceMs: STARTUP_GRACE_MS,
          defaultTimeoutSeconds: 600,
        });
        const PING_STALE_MS = livenessPolicy.pingStaleMs;
        const idleThresholdMs = livenessPolicy.idleFailureMs;
        const hardCeilingMs = livenessPolicy.hardCeilingMs;
        const sessionEntry = sessionsStore?.[entry.sessionKey];

        let check;
        if (hasTerminalSessionStoreStatus(sessionEntry)) {
          // A gateway-recorded terminal status should win immediately, even if
          // the watcher heartbeat is still fresh from just before the abort.
          check = checkSessionDone(entry.sessionKey, sessionsStore, idleThresholdMs, true, spawnedAtMs);
        } else if (ageMs < STARTUP_GRACE_MS) {
          // Within startup grace -- never auto-resolve
          check = { shouldResolve: false };
        } else if (entry.lastPing) {
          const pingAgeMs = Date.now() - new Date(entry.lastPing).getTime();
          if (pingAgeMs < PING_STALE_MS && ageMs < hardCeilingMs) {
            // Watcher alive and within job ceiling -- defer auto-resolve
            check = { shouldResolve: false };
          } else {
            // Ping stale OR past hard ceiling: fall through to session store check
            const thresh = ageMs >= hardCeilingMs ? livenessPolicy.hardTimeoutIdleMs : idleThresholdMs;
            check = checkSessionDone(entry.sessionKey, sessionsStore, thresh, true, spawnedAtMs);
          }
        } else {
          // No lastPing -- backward compat (sessions dispatched before heartbeat feature).
          // Use idleThresholdMs (job-aware) instead of the old hardcoded 10 min.
          const thresh = ageMs >= hardCeilingMs ? livenessPolicy.hardTimeoutIdleMs : idleThresholdMs;
          check = checkSessionDone(entry.sessionKey, sessionsStore, thresh, true, spawnedAtMs);
        }

        if (check.shouldResolve) {
          if (check.is529) {
            setLabel(label, {
              status:  'error',
              error:   check.errorMsg || `529/overload: ${check.reason}`,
              summary: `Auto-resolved as error: ${check.reason}`,
            });
            syncAction = `auto-resolved as 529 error: ${check.reason}`;
          } else {
            setLabel(label, {
              status:  'interrupted',
              summary: buildAutoResolvedIncompleteSummary({
                sessionStatus: check.sessionStatus,
                reason: check.reason,
              }),
            });
            syncAction = `auto-resolved as interrupted: ${check.reason}`;
          }
          // Disarm watchdog when session is auto-resolved
          disarmWatchdog(label);
        }
      }
    }
  }

  // Build liveness from sessions.json store
  if (entry.sessionKey && sessionsStore) {
    const sessionEntry = sessionsStore[entry.sessionKey];
    if (sessionEntry) {
      if (sessionEntry.sessionId && entry.sessionId !== sessionEntry.sessionId) {
        setLabel(label, { sessionId: sessionEntry.sessionId });
      }
      liveness = {
        updatedAt: sessionEntry.updatedAt,
        ageMs:     sessionEntry.updatedAt
          ? Date.now() - (typeof sessionEntry.updatedAt === 'number' ? sessionEntry.updatedAt : new Date(sessionEntry.updatedAt).getTime())
          : null,
        sessionId: sessionEntry.sessionId,
        status:    sessionEntry.status || null,
        abortedLastRun:
          typeof sessionEntry.abortedLastRun === 'boolean' ? sessionEntry.abortedLastRun : undefined,
        model:     sessionEntry.model || null,
        tokens:    sessionEntry.totalTokens || null,
      };
    } else {
      liveness = { error: 'session not found in sessions store' };
    }
  } else if (entry.sessionKey && !sessionsStore) {
    liveness = { error: 'sessions store unavailable' };
  }

  // Re-read entry in case we just updated it
  const current = getLabel(label) || entry;

  out({
    ok:         true,
    label,
    sessionKey: current.sessionKey,
    runId:      current.runId,
    agent:      current.agent,
    mode:       current.mode,
    status:     current.status,
    spawnedAt:  current.spawnedAt,
    updatedAt:  current.updatedAt,
    summary:    effectiveCompletionSummary(current),
    completion: current.completion || null,
    gatewayTimeoutSeconds: Number(current.gatewayTimeoutSeconds ?? current.timeoutSeconds) || null,
    delivery:   buildDispatchDeliverySurface(current),
    error:      current.error || null,
    liveness,
    ...(syncAction ? { syncAction } : {}),
  });
}

/**
 * stuck -- find sessions running past threshold.
 * Auto-resolves sessions the gateway considers done before alerting.
 * Exits 1 only if genuinely stuck sessions remain after sync.
 *
 * Flags:
 *   --threshold-min <n>   Minutes without activity to consider stuck (default: 15)
 */
/**
 * Check if a dispatch-deliver watcher job is actively running for a label.
 * Uses scheduler DB to check for a running/recent-pending run.
 * Fails open (returns false) on any DB error.
 */
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

async function cmdStuck(flags) {
  const thresholdMin = parseFloat(flags['threshold-min'] || '15');
  const thresholdMs  = thresholdMin * 60 * 1000;

  const labels = loadValidatedLabels();
  const stuckSessions  = [];
  const autoResolved   = [];
  const watcherSkipped = [];

  // Sessions stores are read per-agent (cached within this call)
  const sessionsStoreByAgent = {};
  function getSessionsStoreForEntry(e) {
    const ag = e.agent || agentFromSessionKey(e.sessionKey) || 'main';
    if (!(ag in sessionsStoreByAgent)) sessionsStoreByAgent[ag] = readSessionsStore(ag);
    return sessionsStoreByAgent[ag];
  }

  for (const [name, entry] of Object.entries(labels)) {
    if (entry.status !== 'running') continue;

    // -- Per-job timeout: don't flag until the job's own timeout has elapsed --
    const jobTimeoutMs      = entry.timeoutSeconds ? entry.timeoutSeconds * 1000 : 0;
    const effectiveThreshMs = Math.max(jobTimeoutMs, thresholdMs);

    const spawnedAt = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
    const ageMs     = Date.now() - spawnedAt;

    if (ageMs < effectiveThreshMs) continue;

    // -- Skip if session is within startup grace period --------------------
    const STARTUP_GRACE_MS = config.startupGraceMs ?? 300_000;
    if (ageMs < STARTUP_GRACE_MS) continue;

    // -- Skip if an active watcher is already monitoring this session ------
    if (hasActiveWatcher(name)) {
      watcherSkipped.push({ label: name, reason: 'active dispatch-deliver watcher' });
      continue;
    }

    // -- Check sessions store state before alerting -----------
    const stuckSessionsStore = getSessionsStoreForEntry(entry);
    const check = checkSessionDone(entry.sessionKey, stuckSessionsStore, effectiveThreshMs, true, spawnedAt);

    if (check.shouldResolve) {
      // Gateway says this session is done -- auto-mark and skip alert
      if (check.is529) {
        setLabel(name, {
          status:  'error',
          error:   check.errorMsg || `529/overload: ${check.reason}`,
          summary: `Auto-resolved as error: ${check.reason}`,
        });
        autoResolved.push({ label: name, reason: `529 error: ${check.reason}` });
      } else {
        setLabel(name, {
          status:  'interrupted',
          summary: buildAutoResolvedIncompleteSummary({
            sessionStatus: check.sessionStatus,
            reason: check.reason,
          }),
        });
        autoResolved.push({ label: name, reason: check.reason });
      }
      // Disarm watchdog when session is auto-resolved
      disarmWatchdog(name);
      continue;
    }

    // Session is still active (or gateway unavailable) -- evaluate as potentially stuck
    const lastActivity = check.lastActivity || spawnedAt;
    const silenceMs    = Date.now() - lastActivity;

    if (silenceMs >= effectiveThreshMs) {
      stuckSessions.push({
        label:        name,
        sessionKey:   entry.sessionKey,
        agent:        entry.agent,
        spawnedAt:    entry.spawnedAt,
        ageMin:       Math.round(ageMs / 60000),
        silenceMin:   Math.round(silenceMs / 60000),
        thresholdMin: Math.round(effectiveThreshMs / 60000),
      });
    }
  }

  // Log auto-resolved sessions to stderr (informational, won't trigger delivery)
  if (autoResolved.length > 0) {
    const lines = autoResolved.map(r => `  [ok] ${r.label}: ${r.reason}`).join('\n');
    process.stderr.write(`[${BRAND}] auto-resolved ${autoResolved.length} completed session(s):\n${lines}\n`);
  }

  if (!stuckSessions.length) {
    out({
      ok:                  true,
      stuck_count:         0,
      stuck_sessions:      [],
      auto_resolved_count: autoResolved.length,
      auto_resolved:       autoResolved,
      watcher_skipped:     watcherSkipped,
      threshold_min:       thresholdMin,
    });
    process.exit(0);
  }

  const lines = stuckSessions.map(s =>
    `* ${s.label} (running ${s.ageMin}min, silent ${s.silenceMin}min)`
  ).join('\n');

  process.stdout.write(
    `⚠️ ${BRAND}: ${stuckSessions.length} stuck session${stuckSessions.length > 1 ? 's' : ''}:\n${lines}\n`
  );

  await onStuck(stuckSessions.map(s => ({
    id:         s.sessionKey,
    job_name:   s.label,
    started_at: s.spawnedAt,
    age_s:      s.ageMin * 60,
  }))).catch(() => {});

  process.exit(1);
}

/**
 * sync -- reconcile labels.json with sessions store state.
 * Auto-resolves any "running" sessions that the sessions store considers done.
 *
 * Flags:
 *   --dry-run    Show what would change without modifying labels.json
 */
function cmdSync(flags) {
  const dryRun = flags['dry-run'] === true;

  const labels  = loadValidatedLabels();
  const changes = [];

  // Preload sessions stores per agent
  const syncStoreByAgent = {};
  function getSyncStore(e) {
    const ag = e.agent || agentFromSessionKey(e.sessionKey) || 'main';
    if (!(ag in syncStoreByAgent)) syncStoreByAgent[ag] = readSessionsStore(ag);
    return syncStoreByAgent[ag];
  }

  for (const [name, entry] of Object.entries(labels)) {
    if (entry.status !== 'running') continue;

    const syncStore = getSyncStore(entry);
    const spawnedAtMs = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
    const elapsedMs   = Date.now() - spawnedAtMs;
    const STARTUP_GRACE_MS_SYNC = config.startupGraceMs ?? 300_000;

    const bootstrapFailure = !entry.lastPing
      ? inspectSessionBootstrapFailure(
          entry.sessionKey,
          syncStore,
          spawnedAtMs,
          STARTUP_GRACE_MS_SYNC,
        )
      : { shouldResolve: false, reason: null, errorMsg: null };
    if (bootstrapFailure.shouldResolve) {
      changes.push({ label: name, from: 'running', to: 'error', reason: bootstrapFailure.reason });
      if (!dryRun) {
        setLabel(name, {
          status: 'error',
          error: bootstrapFailure.errorMsg,
          summary: `Synced as spawn failure: ${bootstrapFailure.reason}`,
        });
        disarmWatchdog(name);
      }
      continue;
    }

    const turnAbortCheck = checkSessionTurnAborted(entry, syncStore);
    if (turnAbortCheck.shouldResolve) {
      changes.push({ label: name, from: 'running', to: 'interrupted', reason: turnAbortCheck.reason });
      if (!dryRun) {
        setLabel(name, {
          status:  'interrupted',
          summary: buildAutoResolvedIncompleteSummary({
            sessionStatus: turnAbortCheck.sessionStatus,
            reason: turnAbortCheck.reason,
          }),
        });
        disarmWatchdog(name);
      }
      continue;
    }

    // -- Heartbeat-based liveness guard (mirrors cmdStatus logic) ---------
    // Skip auto-resolve when the watcher's lastPing heartbeat is fresh.
    // See cmdStatus for full commentary on PING_STALE_MS / hardCeilingMs.
    const syncPolicy = getDispatchLivenessPolicy(entry, {
      startupGraceMs: STARTUP_GRACE_MS_SYNC,
      defaultTimeoutSeconds: 600,
    });
    const PING_STALE_MS_SYNC = syncPolicy.pingStaleMs;
    const idleThresholdMsSync = syncPolicy.idleFailureMs;
    const hardCeilingMsSync = syncPolicy.hardCeilingMs;
    const sessionEntry = syncStore?.[entry.sessionKey];

    if (hasTerminalSessionStoreStatus(sessionEntry)) {
      const check = checkSessionDone(entry.sessionKey, syncStore, idleThresholdMsSync, true, spawnedAtMs);
      if (!check.shouldResolve) continue;
      const newStatus = check.is529 ? 'error' : 'interrupted';
      changes.push({ label: name, from: 'running', to: newStatus, reason: check.reason });
      if (!dryRun) {
        if (check.is529) {
          setLabel(name, {
            status:  'error',
            error:   check.errorMsg || `529/overload: ${check.reason}`,
            summary: `Synced as error: ${check.reason}`,
          });
        } else {
          setLabel(name, {
            status:  'interrupted',
            summary: buildAutoResolvedIncompleteSummary({
              sessionStatus: check.sessionStatus,
              reason: check.reason,
            }),
          });
        }
        disarmWatchdog(name);
      }
      continue;
    }

    if (entry.lastPing) {
      const pingAgeMs = Date.now() - new Date(entry.lastPing).getTime();
      if (pingAgeMs < PING_STALE_MS_SYNC && elapsedMs < hardCeilingMsSync) {
        // Watcher alive and within ceiling -- skip auto-resolve for this cycle
        continue;
      }
    }

    const syncThresh = elapsedMs >= hardCeilingMsSync ? syncPolicy.hardTimeoutIdleMs : idleThresholdMsSync;
    const check = checkSessionDone(entry.sessionKey, syncStore, syncThresh, true, spawnedAtMs);

    if (check.shouldResolve) {
      const newStatus = check.is529 ? 'error' : 'interrupted';
      changes.push({ label: name, from: 'running', to: newStatus, reason: check.reason });
      if (!dryRun) {
        if (check.is529) {
          setLabel(name, {
            status:  'error',
            error:   check.errorMsg || `529/overload: ${check.reason}`,
            summary: `Synced as error: ${check.reason}`,
          });
        } else {
          setLabel(name, {
            status:  'interrupted',
            summary: buildAutoResolvedIncompleteSummary({
              sessionStatus: check.sessionStatus,
              reason: check.reason,
            }),
          });
        }
        // Disarm watchdog when session is synced as interrupted
        disarmWatchdog(name);
      }
    }
  }

  out({
    ok:      true,
    dryRun,
    changes: changes.length,
    details: changes,
  });
}

/**
 * result -- get the last assistant reply from a session.
 *
 * Flags:
 *   --label <string>    Required
 */
function cmdResult(flags) {
  const label = flags.label;
  if (!label) die('--label is required', 2);

  const entry = getLabel(label);
  if (!entry) {
    out({ ok: false, label, message: 'No session found for this label' });
    return;
  }

  // Conservative transcript recovery:
  // - lastReply is ONLY populated from a terminal JSONL-scoped assistant reply
  // - diagnosticReply captures the last meaningful assistant text for timeout reporting
  let lastReply = null;
  let diagnosticReply = null;
  let recoverySource = null;
  let recoverySessionId = entry.sessionId || null;
  let artifactEvidence = null;
  const resultAgent = entry.agent || agentFromSessionKey(entry.sessionKey) || 'main';
  const resultStore = entry.sessionKey ? readSessionsStore(resultAgent) : null;
  const resultSessionEntry = entry.sessionKey && resultStore ? resultStore[entry.sessionKey] : null;

  if (resultSessionEntry?.sessionId) {
    recoverySessionId = resultSessionEntry.sessionId;
    if (entry.sessionId !== recoverySessionId) {
      setLabel(label, { sessionId: recoverySessionId });
    }
  }

  if (recoverySessionId) {
    const jsonlEntries = readJsonlTailEntries(recoverySessionId, resultAgent, 200);
    const terminalReply = extractTerminalAssistantReplyFromEntries(jsonlEntries);
    const jsonlDiagnostic = extractLastMeaningfulAssistantReplyFromEntries(jsonlEntries);
    artifactEvidence = getJsonlArtifactEvidence(jsonlEntries);

    if (terminalReply) {
      lastReply = terminalReply;
      recoverySource = 'jsonl-terminal';
    }
    if (jsonlDiagnostic) {
      diagnosticReply = jsonlDiagnostic;
      if (!recoverySource) recoverySource = 'jsonl-diagnostic';
    }
  }

  if (entry.sessionKey) {
    try {
      const result = gatewayCall('chat.history', {
        sessionKey: entry.sessionKey,
      }, { timeout: 10000 });

      if (result?.messages?.length && !diagnosticReply) {
        diagnosticReply = extractLastMeaningfulAssistantReplyFromEntries(result.messages);
        if (diagnosticReply && !recoverySource) recoverySource = 'history-diagnostic';
      }

      if (!lastReply && result?.messages?.length) {
        const historyTerminal = extractTerminalAssistantReplyFromEntries(result.messages);
        if (historyTerminal) {
          lastReply = historyTerminal;
          recoverySource = 'history-terminal';
        }
      }
    } catch {}
  }

  // -- Watchdog cleanup: disable watchdog job when result is available --
  if ((lastReply || hasCompletionSignal(entry.completion)) && entry.watchdogJobId) {
    disarmWatchdog(label);
  }

  out({
    ok:         true,
    label,
    sessionKey: entry.sessionKey,
    status:     entry.status,
    spawnedAt:  entry.spawnedAt,
    summary:    effectiveCompletionSummary(entry, lastReply),
    completion: entry.completion || null,
    delivery:   buildDispatchDeliverySurface(entry),
    lastReply:  lastReply || null,
    diagnosticReply: diagnosticReply || lastReply || null,
    recovery: recoverySource || recoverySessionId ? {
      source: recoverySource || null,
      sessionId: recoverySessionId || null,
    } : null,
    artifactEvidence: artifactEvidence || null,
    error:      entry.error || null,
  });
}


function cmdWatcherHandoff(flags) {
  const label = flags.label;
  const reason = flags.reason || null;
  if (!label) die('--label is required', 2);

  const entry = getLabel(label);
  if (!entry) {
    out({ ok: false, scheduled: false, label, message: 'No session found for this label' });
    return;
  }

  if (entry.status && entry.status !== 'running') {
    out({ ok: true, scheduled: false, label, reason: 'label already terminal', status: entry.status });
    return;
  }

  if (!entry.deliverTo || entry.deliveryMode === 'none') {
    out({ ok: true, scheduled: false, label, reason: 'delivery disabled for this label' });
    return;
  }

  const agentBrand = config.agents?.[entry.agent || 'main']?.name
    || (entry.agent && entry.agent !== 'main' ? entry.agent : null)
    || config.name
    || BRAND;

  const watcherJob = scheduleDeliveryWatcherJob({
    label,
    deliverTo: entry.deliverTo,
    deliverChannel: entry.deliverChannel || 'telegram',
    timeoutSeconds: Number(entry.timeoutSeconds ?? entry.timeout) || 300,
    idleThresholdSeconds: Number(entry.idleThresholdSeconds) || 300,
    origin: entry.origin || 'system',
    agentBrand,
    nameSuffix: `:handoff:${Date.now()}`,
  });

  out({
    ok: true,
    scheduled: true,
    label,
    jobId: watcherJob?.id || null,
    reason,
  });

  if (watcherJob?.id) {
    setLabel(label, { deliveryWatcherJobId: watcherJob.id });
  }
}

/**
 * done -- agent-side completion signal (push-based).
 * Called by the subagent itself as its LAST action when fully complete.
 * Sets labels.json status=done so the watcher resolves immediately.
 *
 * Flags:
 *   --label      <string>  Required. Label to mark as done
 *   --summary    <string>  Optional. One-line completion summary
 *   --checklist  <json>    Required. JSON object asserting completion status.
 *                          Must include work_complete:true. Optional: tests_passed, pushed.
 *   --sha        <sha>     Optional (required when task involves git ops). Git commit SHA.
 *   --force-done           Override minimum runtime guard (requires --reason).
 *   --reason     <string>  Required with --force-done. Explains why short runtime is valid.
 */
async function cmdDone(flags) {
  const label         = flags.label;
  const rawSummary    = flags.summary || 'completed (agent signal)';
  const sha           = flags.sha || null;
  const checklistRaw  = flags.checklist || null;
  const forceDone     = !!(flags['force-done']);
  const forceReason   = flags.reason || null;
  if (!label) die('--label is required', 2);

  // Structural completion checklist -- replaces planning-phrase guard.
  // Agents must assert completion status explicitly via structured fields.
  if (!checklistRaw) {
    die(
      'REJECTED: --checklist is required. Pass --checklist with JSON object asserting completion status. ' +
      "Example: --checklist '{\"work_complete\":true}' " +
      'work_complete MUST be true -- you are asserting all assigned work is finished. ' +
      'Do NOT call done while planning, reading files, or mid-task.',
      1,
    );
  }

  let checklist;
  try {
    checklist = JSON.parse(checklistRaw);
  } catch {
    die("REJECTED: --checklist must be valid JSON. Example: '{\"work_complete\":true}'", 1);
  }

  if (!checklist.work_complete) {
    die(
      'REJECTED: checklist.work_complete must be true. ' +
      'You are asserting all assigned work is done. ' +
      'Do NOT call done until all work is complete.',
      1,
    );
  }

  // Validate optional fields if present -- reject if any are explicitly false
  const optionalValidated = ['tests_passed', 'pushed'];
  for (const field of optionalValidated) {
    if (field in checklist && checklist[field] === false) {
      die(
        `REJECTED: checklist.${field} is false. ` +
        `Do not call done until all required checks pass. ` +
        `Fix the failing ${field.replace('_', ' ')} before calling done.`,
        1,
      );
    }
  }

  // Persist a first-class completion payload with deterministic delivery text
  // so the watcher/post-office path never depends solely on transcript recovery
  // or on whatever raw blob the model chose to print at the end.
  const completion = buildTerminalCompletionPayload({
    summary: rawSummary,
    checklist,
    sha,
  });
  const summary = completion.summary || null;

  const existing = getLabel(label);

  // -- Fix 1: Minimum runtime guard ----------------------------------------
  // Prevent agents from calling done immediately after spawning before doing
  // any real work. Threshold scales with the task's configured timeout.
  if (existing) {
    const spawnedAtMs   = existing.spawnedAt ? new Date(existing.spawnedAt).getTime() : null;
    if (spawnedAtMs !== null) {
      const elapsedMs   = Date.now() - spawnedAtMs;
      // Fix 4: Use stored timeout from label entry; fall back to timeoutSeconds, then 300.
      const taskTimeout = Number(existing.timeout ?? existing.timeoutSeconds) || 300;
      const thresholdMs = taskTimeout > 600 ? 120_000 : 60_000;

      if (elapsedMs < thresholdMs) {
        if (!forceDone) {
          const elapsedS = Math.round(elapsedMs / 1000);
          die(
            `REJECTED: Session ran for only ${elapsedS}s -- suspiciously short for this task scope. ` +
            `If work is genuinely complete, re-run with --force-done --reason "explanation".`,
            1,
          );
        }
        // --force-done present -- require --reason
        if (!forceReason || !forceReason.trim()) {
          die(
            'REJECTED: --force-done requires --reason explaining why short runtime is valid.',
            1,
          );
        }
        // Log warning for audit trail
        process.stderr.write(
          `[${BRAND}] warn: force-done used for label=${label} after ${Math.round(elapsedMs / 1000)}s, reason=${forceReason}\n`,
        );
      }
    }
  }

  // -- Fix 2: SHA required when task involves git operations ----------------
  // If the stored task prompt references git operations, --sha is mandatory.
  // Fix 1 (edge case): old labels enqueued before 6dfa458 have no taskPrompt stored.
  //   When taskPrompt is absent, skip the git-SHA check to avoid breaking existing labels,
  //   but log a warning so operators know the guard was bypassed.
  // Fix 2 (edge case): tightened regex uses word boundaries so prose mentions like
  //   "do NOT use git push" do NOT trigger the gate; only actual commands do.
  if (existing) {
    const taskPrompt = existing.taskPrompt;
    if (!taskPrompt) {
      // taskPrompt absent -- label enqueued before guard was added; skip check but warn.
      process.stderr.write(
        `[${BRAND}] warn: taskPrompt not stored for label=${label} (enqueued before guard), skipping git-SHA check\n`,
      );
    } else {
      if (taskRequiresGitSha(taskPrompt) && !sha) {
        die(
          'REJECTED: Task involves git commits but --sha was not provided. ' +
          'Pass --sha with the actual HEAD SHA of your pushed branch.',
          1,
        );
      }
    }
  }

  // Validate --sha if provided
  if (sha) {
    // Sanitize: must be a valid git SHA (7-40 hex chars)
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      die(`REJECTED: --sha "${sha}" is not a valid git SHA (must be 7-40 hex characters). Pass the actual commit SHA.`, 1);
    }
    // Verify the commit exists in the local git environment
    try {
      execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { stdio: 'pipe' });
    } catch {
      die(`REJECTED: SHA ${sha} not found in local git. Push your commits before calling done.`, 1);
    }
  }

  // -- Fix 3: Session activity check ----------------------------------------
  // A session that was spawned 2h ago but did nothing (e.g. immediately called done)
  // would pass the wall-clock guard. Check message count via the gateway sessions API
  // to catch idle sessions regardless of wall-clock age.
  // Escape hatches: --force-done (already accepted above) or --skip-activity-check.
  if (existing && existing.sessionKey && !flags['skip-activity-check'] && !forceDone) {
    try {
      const sessionInfoRes = await fetch(
        buildGatewaySessionUrl(GATEWAY_BASE_URL, existing.sessionKey),
        {
          headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        }
      );
      if (sessionInfoRes.ok) {
        const sessionInfo = await sessionInfoRes.json().catch(() => null);
        const msgCount = sessionInfo?.messageCount ?? sessionInfo?.messages?.length ?? null;
        if (msgCount !== null && msgCount <= 2) {
          die(
            `REJECTED: Session has only ${msgCount} messages -- likely did not complete the assigned work. ` +
            `Use --force-done --reason if work is genuinely complete, or --skip-activity-check to bypass this check.`,
            1,
          );
        }
      }
      // Non-2xx (session not found, etc.) -> skip check gracefully
    } catch (activityErr) {
      // Gateway API unavailable or timed out -- skip check, log warning, do NOT fail.
      process.stderr.write(
        `[${BRAND}] warn: session activity check unavailable for label=${label}: ${activityErr.message} -- skipping check\n`,
      );
    }
  }

  if (!existing) {
    // Label was never registered (e.g. direct subagent spawn, not via enqueue).
    // This is not an error -- the work completed, the label just wasn't tracked.
    process.stderr.write(`[${BRAND}] warn: no session found for label "${label}" -- registering as done\n`);
    setLabelDone(label, { summary, completion, ...(sha ? { sha } : {}) });

    // No watcher is polling for this label, so actively notify via the gateway
    // post office using delivery config from config.json as fallback target.
    const deliverTo      = config.deliverTo      ?? null;
    const deliveryChannel = config.deliveryChannel ?? null;

    if (deliverTo) {
      await onFinished({
        label,
        job_id:      null,
        run_id:      null,
        agent:       'main',
        status:      'ok',
        duration_ms: 0,
        session_key: null,
        summary,
        completion,
        deliverTo,
        deliveryChannel,
      }).catch(() => {});
    } else {
      process.stderr.write(`[${BRAND}] warn: no deliverTo in config -- completion not delivered for "${label}"\n`);
    }

    out({ ok: true, label, status: 'done', summary, completion, message: 'Label not previously registered; marked done.' });
    return;
  }

  setLabelDone(label, {
    summary,
    completion,
    ...(sha ? { sha } : {}),
  });

  // Disarm watchdog when agent signals done
  disarmWatchdog(label);

  let completionDelivery = null;
  if (existing.deliverTo && existing.deliveryMode !== 'none') {
    completionDelivery = await enqueueCompletionNotification({
      label,
      summary,
      completion,
      deliverTo: existing.deliverTo,
      deliveryChannel: existing.deliverChannel || 'telegram',
      sessionKey: existing.sessionKey || null,
      runId: existing.runId || null,
      origin: existing.origin || null,
      metadata: {
        last_label_status: 'done',
        timeout_seconds: Number(existing.timeoutSeconds ?? existing.timeout) || null,
      },
    });

    if (completionDelivery?.ok) {
      setLabel(label, { completionDeliveredAt: new Date().toISOString() });
      disarmDeliveryWatcher(label);
    }
  }

  // Fire dispatch.finished hook (best-effort)
  const spawnedAtMs = existing.spawnedAt ? new Date(existing.spawnedAt).getTime() : Date.now();
  await onFinished({
    label,
    job_id:      existing.runId || null,
    run_id:      existing.runId || null,
    agent:       existing.agent || 'main',
    status:      'ok',
    duration_ms: Date.now() - spawnedAtMs,
    session_key: existing.sessionKey || null,
    summary,
    completion,
  }).catch(() => {});

  out({
    ok: true,
    label,
    status: 'done',
    summary,
    completion,
    delivery: completionDelivery ? {
      attempted: true,
      delivered: !!completionDelivery.ok,
      reason: completionDelivery.reason || null,
    } : null,
    message: 'Label marked done via agent signal.',
  });
}

/**
 * send / steer -- send a message into a running session.
 *
 * Flags:
 *   --label <string>      Required (unless --session-key)
 *   --message <string>    Message to send
 *   --message-file <path> Read message text from a file (`-` = stdin)
 *   --message-env <VAR>   Read message text from an environment variable
 *   --message-stdin       Read message text from stdin explicitly
 *                         (stdin is also auto-read when piped and no other message source is set)
 *   --session-key <key>   Optional. Direct session key (bypasses label lookup)
 */
async function cmdSend(flags) {
  const label = flags.label;
  const directKey = flags['session-key'];
  let message = null;

  try {
    message = await resolveMessageInput({
      message: flags.message,
      messageFile: flags['message-file'],
      messageEnv: flags['message-env'],
      messageStdin: flags['message-stdin'],
    });
  } catch (err) {
    die(err.message, 2);
  }

  if (message === null || message.length === 0) die('--message, --message-file, --message-env, --message-stdin, or piped stdin is required', 2);
  if (!label && !directKey) die('--label or --session-key is required', 2);

  let sessionKey = directKey;
  if (!sessionKey) {
    const entry = getLabel(label);
    if (!entry?.sessionKey) die(`No session found for label "${label}"`);
    sessionKey = entry.sessionKey;
  }
  try {
    sessionKey = assertValidSessionKey(sessionKey, '--session-key');
  } catch (error) {
    die(error.message, 2);
  }

  const idem = randomUUID();

  try {
    const response = gatewayCall('agent', {
      message,
      sessionKey,
      idempotencyKey: idem,
      deliver:        false,
      lane:           'nested',
    }, { timeout: 15000 });

    out({
      ok:         true,
      label:      label || null,
      sessionKey,
      runId:      response?.runId || idem,
      status:     'sent',
      message:    'Message sent to session.',
    });
  } catch (err) {
    die(`Failed to send message: ${err.message}`);
  }
}

/**
 * heartbeat -- check session liveness.
 *
 * Flags:
 *   --label <string>       Check session for this label
 *   --session-key <key>    Or check directly by key
 */
function cmdHeartbeat(flags) {
  const label     = flags.label;
  const directKey = flags['session-key'];

  if (!label && !directKey) die('--label or --session-key is required', 2);

  let sessionKey = directKey;
  if (!sessionKey) {
    const entry = getLabel(label);
    if (!entry?.sessionKey) die(`No session found for label "${label}"`);
    sessionKey = entry.sessionKey;
  }
  try {
    sessionKey = assertValidSessionKey(sessionKey, '--session-key');
  } catch (error) {
    die(error.message, 2);
  }

  const hbAgent = label ? (getLabel(label)?.agent || agentFromSessionKey(sessionKey)) : agentFromSessionKey(sessionKey);
  const hbStore = readSessionsStore(hbAgent || 'main');

  if (!hbStore) {
    out({ ok: false, sessionKey, alive: false, message: 'Sessions store unavailable' });
    return;
  }

  const sessionEntry = hbStore[sessionKey];
  if (!sessionEntry) {
    out({ ok: false, sessionKey, alive: false, message: 'Session not found in sessions store' });
    return;
  }

  const ageMs = sessionEntry.updatedAt
    ? Date.now() - (typeof sessionEntry.updatedAt === 'number' ? sessionEntry.updatedAt : new Date(sessionEntry.updatedAt).getTime())
    : null;

  out({
    ok:        true,
    sessionKey,
    label:     label || null,
    alive:     ageMs !== null && ageMs < 10 * 60 * 1000,
    ageMs,
    updatedAt: sessionEntry.updatedAt ? new Date(sessionEntry.updatedAt).toISOString() : null,
    sessionId: sessionEntry.sessionId,
    model:     sessionEntry.model || null,
  });
}

/**
 * list -- list all tracked labels and their sessions.
 *
 * Flags:
 *   --status <status>    Filter by status (running|done|error)
 *   --limit <n>          Max entries (default: 20)
 */
function cmdList(flags) {
  const filterStatus = flags.status || null;
  const limit        = parseInt(flags.limit || '20', 10);

  const labels = loadValidatedLabels();
  let entries = Object.entries(labels).map(([name, data]) => ({
    label: name,
    ...data,
    summary: effectiveCompletionSummary(data),
    delivery: buildDispatchDeliverySurface(data),
  }));

  if (filterStatus) {
    entries = entries.filter(e => e.status === filterStatus);
  }

  entries.sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  entries = entries.slice(0, limit);

  out({ ok: true, count: entries.length, labels: entries });
}

// -- Usage ----------------------------------------------------

function usage() {
  process.stdout.write(`
${BRAND} -- sub-agent dispatch CLI (native gateway API)

Usage: openclaw-scheduler <subcommand> [flags]

Subcommands:
  enqueue  --label <l> [--message <m>|--message-file <f>|--message-env <VAR>|--message-stdin]
           [--agent <a>] [--thinking <t>] [--timeout <s>] [--mode fresh|reuse] [--model <m>]
           [--origin <o>]  (recommended explicit value, e.g. "telegram:<chat_id>" or "system")
           [--deliver-to <id>] [--deliver-channel <ch>] [--delivery-mode <m>]
           (--deliver-to should come from inbound metadata chat_id; explicit --deliver-to becomes origin when --origin is omitted)
           (active-session auto-detect is preserved only as a manual/local fallback)
           [--no-monitor] [--monitor-interval <cron>] [--monitor-timeout <min>]
           [--verify-cmd <shell_cmd>]
           (stdin is auto-read when piped and no explicit message source is set)

  status   --label <l>

  stuck    [--threshold-min <n>]      (exits 1 if stuck sessions found)

  result   --label <l>

  watcher-handoff --label <l> [--reason <text>]

  send     --label <l> [--message <m>|--message-file <f>|--message-env <VAR>|--message-stdin]
           [--session-key <k>]

  steer    --label <l> [--message <m>|--message-file <f>|--message-env <VAR>|--message-stdin]
           (alias for send)

  heartbeat --label <l>  OR  --session-key <k>

  list     [--status running|done|error] [--limit <n>]

  sync     [--dry-run]                 (reconcile labels.json with sessions store)

  done     --label <l> [--summary <s>] (agent-side completion signal; marks label as done)
`);
}

// -- Main -----------------------------------------------------

const [,, subcommand, ...rest] = process.argv;
const flags = parseFlags(rest);

switch (subcommand) {
  case 'enqueue':   await cmdEnqueue(flags);   break;
  case 'status':    cmdStatus(flags);          break;
  case 'stuck':     await cmdStuck(flags);     break;
  case 'result':    cmdResult(flags);          break;
  case 'watcher-handoff': cmdWatcherHandoff(flags); break;
  case 'send':      await cmdSend(flags);      break;
  case 'steer':     await cmdSend(flags);      break;
  case 'heartbeat': cmdHeartbeat(flags);       break;
  case 'list':      cmdList(flags);            break;
  case 'sync':      cmdSync(flags);            break;
  case 'done':      await cmdDone(flags);       break;
  default:          usage(); process.exit(2);
}
