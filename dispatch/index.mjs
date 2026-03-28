#!/usr/bin/env node
/**
 * dispatch — Sub-agent dispatch CLI for OpenClaw
 *
 * Spawns and steers isolated agent sessions via the OpenClaw Gateway API.
 * Tracks label→session mappings in a local JSON ledger.
 *
 * Subcommands:
 *   enqueue    Spawn a session via gateway, store label→sessionKey, return immediately
 *   status     Query session status by label
 *   stuck      Find sessions running past threshold with no activity
 *   result     Get last assistant message from a session
 *   send       Send a message INTO a running session (mid-session steering)
 *   steer      Alias for send — explicitly for mid-session course correction
 *   heartbeat  Check session liveness
 *   list       List all tracked labels
 *   sync       Reconcile labels.json with sessions store state
 *   done       Agent-side completion signal — set label status=done immediately
 *
 * Exit codes:
 *   0  — success / nothing stuck
 *   1  — stuck runs found, or hard error
 *   2  — argument error
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
import { onStarted, onFinished, onStuck } from './hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || homedir();
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
let labelsCache = null;
let labelsCacheSignature = null;

// ── Invocation Directory ─────────────────────────────────────
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

// ── Config ───────────────────────────────────────────────────

const LABELS_PATH = process.env.DISPATCH_LABELS_PATH || join(INVOKE_DIR, 'labels.json');

/** Load dispatch config from config.json.
 *  Resolution order:
 *    1. DISPATCH_CONFIG_DIR env var (branded wrapper deployments)
 *    2. INVOKE_DIR (argv[1] dirname — supports symlink-based branding)
 *    3. __dirname (dispatch module directory — fallback)
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

// ── Helpers ──────────────────────────────────────────────────

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

function taskRequiresGitSha(taskPrompt) {
  if (!taskPrompt || typeof taskPrompt !== 'string') return false;

  const commandPattern = /\bgit\s+(push|rebase|cherry-pick)\b|(?:^|\s)--force-with-lease\b|(?:^|\s)--force-push\b/ig;
  let match;
  while ((match = commandPattern.exec(taskPrompt)) !== null) {
    const before = taskPrompt.slice(Math.max(0, match.index - 40), match.index);
    const negatedContext = /\b(?:do\s+not|don't|dont|never)\s+(?:use|run|call|invoke)?\s*$/i.test(before)
      || /\bavoid\s+(?:using\s+)?$/i.test(before)
      || /\bwithout\s+(?:using\s+)?$/i.test(before);
    if (!negatedContext) return true;
  }
  return false;
}

// ── Labels Ledger ────────────────────────────────────────────

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
    const labels = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
    labelsCache = labels;
    labelsCacheSignature = signature;
    return labels;
  } catch {
    labelsCache = {};
    labelsCacheSignature = 'missing';
    return labelsCache;
  }
}

function saveLabels(labels) {
  const tmp = LABELS_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
  renameSync(tmp, LABELS_PATH);
  labelsCache = labels;
  labelsCacheSignature = getLabelsSignature();
}

function mutateLabels(mutator) {
  const labels = loadLabels();
  const changed = mutator(labels);
  if (changed !== false) {
    saveLabels(labels);
  }
  return labels;
}

function getLabel(name) {
  return loadLabels()[name] || null;
}

function setLabel(name, data) {
  const labels = mutateLabels((current) => {
    current[name] = { ...current[name], ...data, updatedAt: new Date().toISOString() };
  });
  return labels[name];
}

// ── Gateway Calls ────────────────────────────────────────────

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

// ── Gateway Error Log Check ──────────────────────────────────

/**
 * Check the gateway error log for 529/FailoverError/overload errors
 * matching a specific session key.
 *
 * Scans the last N bytes of gateway.err.log for diagnostic lane task errors
 * that reference the session key and match overload patterns.
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

      // Extract the error message
      const errorMatch = line.match(/error="([^"]+)"/);
      if (!errorMatch) continue;

      const errorMsg = errorMatch[1];
      if (OVERLOAD_PATTERNS.some(p => p.test(errorMsg))) {
        // Extract timestamp
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
        return {
          found: true,
          error: `FailoverError (529): ${errorMsg}`,
          timestamp: tsMatch ? tsMatch[1] : null,
        };
      }
    }

    return { found: false, error: null, timestamp: null };
  } catch {
    return { found: false, error: null, timestamp: null };
  }
}

// ── Sessions Store (Direct Read) ─────────────────────────────

/**
 * Read the sessions.json store for an agent directly from disk.
 * This is the ground truth for session state — sessions spawned via the
 * dispatcher HTTP agent endpoint appear here but NOT in sessions_list API.
 *
 * Sessions are NOT pruned on completion — completed sessions stay in the file.
 *
 * @param {string} agent - Agent ID (default: 'main')
 * @returns {Object|null} - The sessions store object, or null on error
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
 * Auto-detect the originating channel from the most recently active main session.
 * Reads sessions.json, finds sessions active within the last 10 minutes,
 * excludes subagent sessions, returns deliveryContext.to of the most recent one.
 *
 * @returns {string|null} - e.g. "telegram:-1001234567890", or null if not found
 */
function getActiveOriginFromSessions() {
  const store = readSessionsStore("main");
  if (!store) return null;

  let best = null;
  let bestTime = 0;
  const TEN_MIN_MS = 10 * 60 * 1000;

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

    if (updatedAt > bestTime) {
      // Prefer deliveryContext.to if available
      const deliveryTo = session.deliveryContext?.to || null;
      if (deliveryTo) {
        bestTime = updatedAt;
        // deliveryContext.to format: "telegram:-1001234567890"
        // Convert to origin format: "telegram:-1001234567890"
        best = deliveryTo;
      }
    }
  }

  return best;
}

/**
 * Parse the agent ID from a session key.
 * Session key format: agent:{agentId}:...
 * Falls back to 'main' for malformed keys.
 */
function agentFromSessionKey(sessionKey) {
  if (!sessionKey) return 'main';
  const parts = sessionKey.split(':');
  if (parts.length >= 2 && parts[0] === 'agent') return parts[1];
  return 'main';
}

// ── Gateway Session State Check ──────────────────────────────

/**
 * Determine if a session should be auto-resolved as "done" based on sessions.json state.
 *
 * Decision logic (in priority order):
 *   1. Store unavailable (null)                    → do NOT resolve (safe default)
 *   2. Session key NOT in store                    → resolve (never spawned or spawn failure)
 *   3. Session found but idle past threshold       → resolve (completed)
 *   4. Session has recent activity                 → do NOT resolve
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
    // Store unavailable — safe default is to NOT auto-resolve
    return {
      shouldResolve: false,
      reason:       'sessions store unavailable for state check',
      lastActivity:  null,
    };
  }

  // 1. Not in sessions store → session never appeared or already cleaned up
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
        reason:       'session young, not yet in sessions store — deferring',
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
        // Session is alive in gateway — do NOT auto-resolve
        return {
          shouldResolve: false,
          reason:       'session not in sessions.json but confirmed active via gateway API',
          lastActivity:  liveSession.updatedAt || null,
        };
      }
    } catch {
      // Gateway unreachable — safe default: do NOT auto-resolve
      return {
        shouldResolve: false,
        reason:       'sessions store miss + gateway API unreachable — deferring',
        lastActivity:  null,
      };
    }

    return {
      shouldResolve: true,
      reason:       logCheck.found
        ? `529/overload error detected: ${logCheck.error}`
        : sessionEverFound
          ? 'session not found in sessions store or gateway API'
          : 'session never found — spawn likely failed',
      lastActivity:  null,
      is529:         logCheck.found,
      errorMsg:      logCheck.error || null,
    };
  }

  // 2. Session exists in store, check idle time.
  const entry        = sessionsStore[sessionKey];
  const lastActivity = entry.updatedAt || 0;
  const silenceMs    = Date.now() - lastActivity;

  if (silenceMs >= thresholdMs) {
    return {
      shouldResolve: true,
      reason:       logCheck.found
        ? `529/overload error detected: ${logCheck.error}`
        : `session idle ${Math.round(silenceMs / 60000)}min in sessions store (completed)`,
      lastActivity,
      is529:         logCheck.found,
      errorMsg:      logCheck.error || null,
    };
  }

  // Session has recent activity — might still be working
  return {
    shouldResolve: false,
    reason:       'session has recent activity in sessions store',
    lastActivity,
  };
}

// ── Watchdog Helpers ─────────────────────────────────────────

/**
 * Disarm (disable) a watchdog job for a label if one is registered.
 * Best-effort — failures are logged but don't throw.
 */
function disarmWatchdog(label) {
  const entry = getLabel(label);
  if (!entry?.watchdogJobId) return;
  try {
    const schedulerCli = join(__dirname, '..', 'cli.js');
    execFileSync(process.execPath, [schedulerCli, 'jobs', 'disable', entry.watchdogJobId], {
      encoding: 'utf-8',
      timeout:  5000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    });
    process.stderr.write(`[${BRAND}] watchdog disarmed for ${label}\n`);
  } catch (err) {
    process.stderr.write(`[${BRAND}] watchdog disarm failed for ${label}: ${err.message}\n`);
  }
}

// ── Session Helpers ──────────────────────────────────────────

/** Build a unique session key for a new subagent session. */
function makeSessionKey(agentId) {
  return `agent:${agentId}:subagent:${randomUUID()}`;
}

// ── Subcommands ──────────────────────────────────────────────

/**
 * enqueue — spawn a session via gateway API.
 *
 * Flags:
 *   --label <string>         Required. Human-readable name
 *   --message <string>       Required. Prompt sent to the agent
 *   --agent <string>         Agent ID (default: main)
 *   --thinking <string>      Reasoning level: low|high|xhigh (default: not set)
 *   --timeout <seconds>      Run timeout in seconds (default: 300)
 *   --origin <origin>        Required. Where the job was dispatched from (e.g. "telegram:<your-user-id>", "system")
 *   --deliver-to <target>    Delivery target (e.g. Telegram chat ID). Enables deliver:true on the gateway call.
 *                            Defaults to origin chat ID when --origin is a "telegram:<id>" string.
 *   --deliver-channel <ch>   Delivery channel for --deliver-to (default: telegram)
 *   --delivery-mode <mode>   announce|announce-always|none (default: announce)
 *   --mode <fresh|reuse>
 *       fresh  — always spawn new session (default)
 *       reuse  — look up prior session_key for this label, send into it
 *   --session-key <key>      Explicit session key override
 *   --model <string>         Model override (e.g. anthropic/claude-sonnet-4-6)
 */
async function cmdEnqueue(flags) {
  const label   = flags.label;
  let   message = flags.message;
  if (!label) die('--label is required', 2);
  // Support --message-file for multiline prompts without shell escaping issues
  if (!message && flags['message-file']) {
    try {
      message = readFileSync(flags['message-file'], 'utf-8').trim();
    } catch (err) {
      die(`--message-file: could not read file: ${err.message}`, 2);
    }
  }
  if (!message) die('--message or --message-file is required', 2);

  const agent       = flags.agent            || 'main';
  const thinking    = flags.thinking         || null;
  const timeoutS    = parseInt(flags.timeout || '300', 10);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) die('--timeout must be a positive integer', 2);
  let origin = flags.origin || null;

  // Auto-detect origin from active sessions if not explicitly provided
  if (!origin) {
    origin = getActiveOriginFromSessions();
    if (origin) {
      process.stderr.write(`[${BRAND}] auto-detected origin from active session: ${origin}\n`);
    }
  }

  // ── Auto-derive deliver-to from origin ─────────────────────────────────
  // If origin is "telegram:<id>", use <id> as the default deliver-to target.
  let defaultDeliverTo   = null;
  let defaultDeliverCh   = 'telegram';
  if (origin) {
    const originMatch = /^([^:]+):(.+)$/.exec(origin);
    if (originMatch) {
      defaultDeliverCh  = originMatch[1];
      defaultDeliverTo  = originMatch[2];
    }
  }

  const deliverTo      = flags['deliver-to']       || defaultDeliverTo;
  const deliverChannel = flags['deliver-channel']   || defaultDeliverCh || 'telegram';
  const deliverMode    = flags['delivery-mode']     || 'announce';
  const mode        = flags.mode             || 'fresh';

  // ── Watchdog monitoring flags ─────────────────────────────
  const noMonitorRaw    = flags['no-monitor'];
  const noMonitor       = !!noMonitorRaw;
  const monitorEnabled  = !noMonitor && flags.monitor !== 'false';
  const monitorInterval = flags['monitor-interval'] || config.watchdogIntervalCron || '*/15 * * * *';
  const monitorTimeout  = parseInt(flags['monitor-timeout'] || String(config.watchdogTimeoutMin ?? 60), 10);
  if (!Number.isFinite(monitorTimeout) || monitorTimeout <= 0) die('--monitor-timeout must be a positive integer', 2);

  // ── Delivery enforcement for agentTurn jobs ─────────────────
  // agentTurn jobs must have a delivery target OR explicitly opt out via --no-monitor "<reason>"
  const isAgentTurn = !flags['payload-kind'] || flags['payload-kind'] === 'agentTurn';
  if (isAgentTurn && !deliverTo && !noMonitor) {
    die(
      "REJECTED: --deliver-to is required for dispatch jobs.\n" +
      "Pass --deliver-to <chat_id> (e.g. --deliver-to -1001234567890 for a group, " +
      "or --deliver-to 123456789 for a DM).\n" +
      "Alternatively, pass --origin telegram:<chat_id> to auto-derive the delivery target.\n" +
      "Pass --no-monitor \"<reason>\" only if you explicitly want to skip delivery (audit trail required).",
      2
    );
  }

  // Dynamic branding: resolve per-agent brand name
  const agentBrand = config.agents?.[agent]?.name || (agent !== 'main' ? agent : null) || config.name || 'dispatch';
  const model       = flags.model            || null;

  // ── Session key resolution ──────────────────────────────────
  let sessionKey = flags['session-key'] || null;

  if (!sessionKey && mode === 'reuse') {
    const existing = getLabel(label);
    if (existing?.sessionKey) {
      sessionKey = existing.sessionKey;
      process.stderr.write(`[${agentBrand}] mode=reuse → continuing session ${sessionKey}\n`);
    } else {
      die(`mode=reuse: no prior session found for label "${label}". Use --mode fresh.`);
    }
  }

  const isFresh = !sessionKey;
  if (isFresh) {
    sessionKey = makeSessionKey(agent);
  }

  const idem = randomUUID();

  // ── Patch session (model, thinking, spawnDepth) if fresh ────
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

  // ── Build the task message ──────────────────────────────────
  const parts = [
    `[Subagent Context] You are running as a subagent (depth 1/3). Results auto-announce to your requester; do not busy-poll for status.`,
    ``,
  ];

  // Prepend CHECK_IN template when delivery target is set
  if (deliverTo) {
    parts.push(`---`);
    parts.push(`CHECK_IN: To report progress, use curl:`);
    parts.push(`GW_TOKEN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.openclaw/openclaw.json','utf8')).gateway.auth.token)")`);
    parts.push(`curl -s -X POST ${GATEWAY_URL}/tools/invoke -H 'Content-Type: application/json' -H "Authorization: Bearer $GW_TOKEN" -d '{"tool":"message","args":{"action":"send","channel":"${deliverChannel || 'telegram'}","target":"${deliverTo}","message":"📍 [${label}] <your status here>"},"sessionKey":"main"}'`);
    parts.push(`Call this every ~5 minutes with a brief progress update.`);
    parts.push(`---`);
    parts.push(``);
  }

  parts.push(`[Subagent Task]: ${message}`);

  // Append agent-side done signal instructions (Fix 2 — push-based completion)
  // Always point to dispatch/index.mjs (__dirname) — the canonical done handler.
  const doneScriptPath = join(__dirname, 'index.mjs');
  parts.push(``);
  parts.push(`---`);
  parts.push(`COMPLETION SIGNAL — READ CAREFULLY:`);
  parts.push(``);
  parts.push(`Only call this command after ALL of the following are true:`);
  parts.push(`  1. All file edits are saved`);
  parts.push(`  2. All commits are pushed (git push completed successfully)`);
  parts.push(`  3. All API calls (e.g. GitHub comment replies) are done`);
  parts.push(`  4. You have verified the work is complete`);
  parts.push(``);
  parts.push(`Call this as your ABSOLUTE FINAL action — nothing else runs after this:`);
  parts.push(`  node '${doneScriptPath}' done --label '${label.replace(/'/g, "'\\''")}' \\`);
  parts.push(`    --summary "<what you actually did>" \\`);
  parts.push(`    --checklist '{"work_complete":true,"tests_passed":true,"pushed":true}' \\`);
  parts.push(`    [--sha "<git commit SHA if applicable>"]`);
  parts.push(``);
  parts.push(`Checklist rules:`);
  parts.push(`  - work_complete MUST be true — you are asserting you have finished ALL assigned work`);
  parts.push(`  - If tests failed or push failed, do NOT set tests_passed:true or pushed:true — instead continue working`);
  parts.push(`  - Only include tests_passed/pushed if they apply to your task`);
  parts.push(`If your task involved git commits, --sha is required and must be the actual SHA of your pushed commit. The done script will reject invented or placeholder SHAs.`);
  parts.push(`Do NOT call done while planning, reading files, or mid-task. If you have not yet pushed a commit, you are not done.`);
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

  // ── Call gateway agent method ───────────────────────────────
  // Gateway deliver is used as a fast-path secondary. The scheduler watcher
  // (created below) is the primary delivery path with retry + audit trail.
  // Both may fire — at-least-once semantics, duplicates acceptable.
  try {
    const response = gatewayCall('agent', {
      message:        taskMessage,
      sessionKey,
      idempotencyKey: idem,
      deliver:        !!deliverTo,
      lane:           'subagent',
      timeout:        timeoutS,
      label:          label,
      thinking:       thinking || undefined,
      ...(deliverTo ? {
        channel:      deliverChannel,
        replyTo:      deliverTo,
        replyChannel: deliverChannel,
      } : {}),
    }, { timeout: 15000 });

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
      spawnedAt:      new Date().toISOString(),
      timeoutSeconds: timeoutS,
      // Fix 4: Store timeout so cmdDone threshold logic can use it correctly.
      timeout:        timeoutS,
      status:         'running',
      summary:        null,
      error:          null,
      // Store task prompt for gate checks in done (first 2000 chars)
      taskPrompt:     message.slice(0, 2000),
    });

    // Fire dispatch.started hook (best-effort)
    await onStarted({
      label, job_id: idem, run_id: response?.runId || idem,
      agent, mode, session_key: sessionKey,
    }).catch(() => {});

    // ── Send "Starting" notification via gateway HTTP API ─────
    if (deliverTo && GATEWAY_TOKEN) {
      try {
        await fetch(`${GATEWAY_URL}/tools/invoke`, {
          method: 'POST',
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

    // ── Register scheduler watcher for delivery ───────────────
    // Creates a one-shot shell job that runs watcher.mjs (blocks until session
    // completes, outputs result). The scheduler's handleDelivery delivers with
    // retry, alias resolution, and audit trail in scheduler.db.
    // Gateway deliver:true is kept as a fast-path secondary (see deliver flag above).
    const sq = s => String(s).replace(/'/g, "'\\''");
    let schedulerWatcherOk = false;
    if (deliverTo && deliverMode !== 'none') {
      try {
        const watcherPath = join(__dirname, 'watcher.mjs');
        // Watcher timeout = session timeout + 120s buffer for startup/polling
        const watcherTimeoutS = timeoutS + 120;
        const watcherCmd = `DISPATCH_LABELS_PATH='${sq(LABELS_PATH)}' '${sq(process.execPath)}' '${sq(watcherPath)}' --label '${sq(label)}' --timeout ${watcherTimeoutS} --poll-interval 20`;

        const nowUtc = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const jobSpec = JSON.stringify({
          name:                     `${agentBrand}-deliver:${label}`,
          schedule_kind:            'at',
          schedule_at:              nowUtc,
          session_target:           'shell',
          payload_kind:             'shellCommand',
          payload_message:          watcherCmd,
          delivery_mode:            'announce-always',
          delivery_channel:         deliverChannel,
          delivery_to:              deliverTo,
          delivery_guarantee:       'at-least-once',
          ttl_hours:                config.deliver_watcher_ttl_hours ?? 48,  // configurable TTL (deliver_watcher_ttl_hours); default 48h
          overlap_policy:           'skip',
          run_timeout_ms:           (watcherTimeoutS + 60) * 1000,  // shell job timeout > watcher timeout
          origin:                   origin || 'system',
        });
        const schedulerCli = join(__dirname, '..', 'cli.js');
        execFileSync(process.execPath, [schedulerCli, 'jobs', 'add', jobSpec], {
          encoding: 'utf-8',
          timeout:  10000,
          stdio:    ['pipe', 'pipe', 'pipe'],
        });
        schedulerWatcherOk = true;
        process.stderr.write(`[${agentBrand}] scheduler watcher registered: ${agentBrand}-deliver:${label}\n`);
      } catch (err) {
        process.stderr.write(`[${agentBrand}] scheduler watcher FAILED (gateway fallback active): ${err.message}\n`);
      }
    }

    // ── Register watchdog monitoring job ─────────────────────
    let watchdogJobOk = false;
    let watchdogJobId = null;
    if (monitorEnabled && deliverTo) {
      try {
        const checkCmd = `'${sq(process.execPath)}' '${sq(join(__dirname, 'index.mjs'))}' stuck --label '${sq(label)}' --threshold-min ${monitorTimeout}`;
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
          origin:                   origin || 'system',
        });
        const schedulerCli = join(__dirname, '..', 'cli.js');
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

    out({
      ok:         true,
      label,
      sessionKey,
      runId:      response?.runId || idem,
      mode:       isFresh ? 'fresh' : 'reuse',
      agent,
      status:     'accepted',
      delivery:   deliverTo ? {
        scheduler: schedulerWatcherOk,
        gateway:   !!deliverTo,
        target:    deliverTo,
        channel:   deliverChannel,
      } : null,
      watchdog:   monitorEnabled ? {
        enabled:  watchdogJobOk,
        jobId:    watchdogJobId,
        interval: monitorInterval,
        timeout:  monitorTimeout,
        ...(monitorEnabled && !deliverTo ? { skipped: true, reason: 'no --deliver-to target' } : {}),
      } : null,
      message:    schedulerWatcherOk
        ? 'Session spawned. Delivery via scheduler (primary) + gateway (secondary).'
        : deliverTo
          ? 'Session spawned. Delivery via gateway only (scheduler watcher failed).'
          : 'Session spawned via gateway. Agent is running.',
    });

    // ── Post-spawn verification (Fix 3) ────────────────────────────────
    // Canary: poll sessions.json up to 3 times at 10s intervals to confirm the
    // session appeared in the store. Non-fatal — output is already written above.
    // If the session never shows up, stderr gets a loud warning and ledger status
    // is set to 'spawn-warning'. The watcher provides the definitive error path.
    const SPAWN_POLL_MAX = 3;
    const SPAWN_POLL_DELAY_MS = 10_000;
    let spawnConfirmed = false;
    for (let spawnPoll = 0; spawnPoll < SPAWN_POLL_MAX; spawnPoll++) {
      await sleep(SPAWN_POLL_DELAY_MS);
      const spawnStore = readSessionsStore(agent);
      if (spawnStore && sessionKey in spawnStore) {
        spawnConfirmed = true;
        break;
      }
    }
    if (!spawnConfirmed) {
      process.stderr.write(
        `[${agentBrand}] WARNING: session ${sessionKey} did not appear in gateway after ` +
        `${(SPAWN_POLL_MAX * SPAWN_POLL_DELAY_MS) / 1000}s — spawn may have failed\n`
      );
      setLabel(label, { status: 'spawn-warning' });
    }
  } catch (err) {
    die(`gateway agent call failed: ${err.message}`);
  }
}

/**
 * status — show session status for a label.
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

    // ── Heartbeat-based liveness guard ──────────────────────────────────
    // The watcher process writes lastPing every 60s while the session is live.
    // If the ping is fresh, the watcher is alive and working — defer auto-resolve
    // to avoid killing sessions during slow tool calls, docker builds, etc.
    //
    // PING_STALE_MS:   3× the 60s ping interval — if we haven't heard from the
    //                  watcher in 3 min, it's probably dead; fall through to check.
    // hardCeilingMs:   job timeout * 1.5 — absolute max regardless of ping age.
    //                  Catches zombie watchers (watcher alive but session is stuck).
    // idleThresholdMs: max(job timeout, 10 min) — replaces the old hardcoded 10-min
    //                  threshold so longer jobs aren't killed at exactly 10 min.
    const PING_STALE_MS  = 3 * 60 * 1000;
    const idleThresholdMs = Math.max((entry.timeoutSeconds || 600) * 1000, 10 * 60 * 1000);
    // hardCeilingMs must be >= idleThresholdMs to avoid the ceiling undercutting the
    // idle floor (e.g. timeoutSeconds=300 → ceiling=7.5 min < idle=10 min would force
    // zombie-guard threshold for sessions that should still use idleThresholdMs).
    const hardCeilingMs  = Math.max((entry.timeoutSeconds || 600) * 1000 * 1.5, idleThresholdMs * 1.5);

    let check;
    if (ageMs < STARTUP_GRACE_MS) {
      // Within startup grace — never auto-resolve
      check = { shouldResolve: false };
    } else if (entry.lastPing) {
      const pingAgeMs = Date.now() - new Date(entry.lastPing).getTime();
      if (pingAgeMs < PING_STALE_MS && ageMs < hardCeilingMs) {
        // Watcher alive and within job ceiling — defer auto-resolve
        check = { shouldResolve: false };
      } else {
        // Ping stale OR past hard ceiling: fall through to session store check
        const thresh = ageMs >= hardCeilingMs ? 2 * 60 * 1000 : idleThresholdMs;
        check = checkSessionDone(entry.sessionKey, sessionsStore, thresh, true, spawnedAtMs);
      }
    } else {
      // No lastPing — backward compat (sessions dispatched before heartbeat feature).
      // Use idleThresholdMs (job-aware) instead of the old hardcoded 10 min.
      const thresh = ageMs >= hardCeilingMs ? 2 * 60 * 1000 : idleThresholdMs;
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
          summary: `Auto-resolved: session went idle without calling done. Work may be incomplete. (${check.reason})`,
        });
        syncAction = `auto-resolved as interrupted: ${check.reason}`;
      }
      // Disarm watchdog when session is auto-resolved
      disarmWatchdog(label);
    }
  }

  // Build liveness from sessions.json store
  if (entry.sessionKey && sessionsStore) {
    const sessionEntry = sessionsStore[entry.sessionKey];
    if (sessionEntry) {
      liveness = {
        updatedAt: sessionEntry.updatedAt,
        ageMs:     sessionEntry.updatedAt
          ? Date.now() - (typeof sessionEntry.updatedAt === 'number' ? sessionEntry.updatedAt : new Date(sessionEntry.updatedAt).getTime())
          : null,
        sessionId: sessionEntry.sessionId,
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
    summary:    current.summary || null,
    error:      current.error || null,
    liveness,
    ...(syncAction ? { syncAction } : {}),
  });
}

/**
 * stuck — find sessions running past threshold.
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
    `).get(`%-deliver:${label}`);
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

  const labels = loadLabels();
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

    // ── Per-job timeout: don't flag until the job's own timeout has elapsed ──
    const jobTimeoutMs      = entry.timeoutSeconds ? entry.timeoutSeconds * 1000 : 0;
    const effectiveThreshMs = Math.max(jobTimeoutMs, thresholdMs);

    const spawnedAt = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
    const ageMs     = Date.now() - spawnedAt;

    if (ageMs < effectiveThreshMs) continue;

    // ── Skip if session is within startup grace period ────────────────────
    const STARTUP_GRACE_MS = config.startupGraceMs ?? 300_000;
    if (ageMs < STARTUP_GRACE_MS) continue;

    // ── Skip if an active watcher is already monitoring this session ──────
    if (hasActiveWatcher(name)) {
      watcherSkipped.push({ label: name, reason: 'active dispatch-deliver watcher' });
      continue;
    }

    // ── Check sessions store state before alerting ───────────
    const stuckSessionsStore = getSessionsStoreForEntry(entry);
    const check = checkSessionDone(entry.sessionKey, stuckSessionsStore, effectiveThreshMs, true, spawnedAt);

    if (check.shouldResolve) {
      // Gateway says this session is done — auto-mark and skip alert
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
          summary: `Auto-resolved: session went idle without calling done. Work may be incomplete. (${check.reason})`,
        });
        autoResolved.push({ label: name, reason: check.reason });
      }
      // Disarm watchdog when session is auto-resolved
      disarmWatchdog(name);
      continue;
    }

    // Session is still active (or gateway unavailable) — evaluate as potentially stuck
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
    const lines = autoResolved.map(r => `  ✓ ${r.label}: ${r.reason}`).join('\n');
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
    `• ${s.label} (running ${s.ageMin}min, silent ${s.silenceMin}min)`
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
 * sync — reconcile labels.json with sessions store state.
 * Auto-resolves any "running" sessions that the sessions store considers done.
 *
 * Flags:
 *   --dry-run    Show what would change without modifying labels.json
 */
function cmdSync(flags) {
  const dryRun = flags['dry-run'] === true;

  const labels  = loadLabels();
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

    // ── Heartbeat-based liveness guard (mirrors cmdStatus logic) ─────────
    // Skip auto-resolve when the watcher's lastPing heartbeat is fresh.
    // See cmdStatus for full commentary on PING_STALE_MS / hardCeilingMs.
    const PING_STALE_MS_SYNC  = 3 * 60 * 1000;
    const idleThresholdMsSync = Math.max((entry.timeoutSeconds || 600) * 1000, 10 * 60 * 1000);
    // hardCeilingMsSync must be >= idleThresholdMsSync (mirrors cmdStatus fix).
    const hardCeilingMsSync   = Math.max((entry.timeoutSeconds || 600) * 1000 * 1.5, idleThresholdMsSync * 1.5);

    if (entry.lastPing) {
      const pingAgeMs = Date.now() - new Date(entry.lastPing).getTime();
      if (pingAgeMs < PING_STALE_MS_SYNC && elapsedMs < hardCeilingMsSync) {
        // Watcher alive and within ceiling — skip auto-resolve for this cycle
        continue;
      }
    }

    const syncThresh = elapsedMs >= hardCeilingMsSync ? 2 * 60 * 1000 : idleThresholdMsSync;
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
            summary: `Auto-resolved: session went idle without calling done. Work may be incomplete. (${check.reason})`,
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
 * result — get the last assistant reply from a session.
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

  // Try to get the session transcript to find last assistant message
  let lastReply = null;
  if (entry.sessionKey) {
    try {
      const result = gatewayCall('chat.history', {
        sessionKey: entry.sessionKey,
      }, { timeout: 10000 });

      if (result?.messages?.length) {
        for (let i = result.messages.length - 1; i >= 0; i--) {
          const e = result.messages[i];
          if (e.role === 'assistant' && e.content) {
            lastReply = typeof e.content === 'string'
              ? e.content
              : Array.isArray(e.content)
                ? e.content.map(c => c.text || '').join('')
                : JSON.stringify(e.content);
            break;
          }
        }
      }
    } catch {}
  }

  // ── Watchdog cleanup: disable watchdog job when result is available ──
  if (lastReply && entry.watchdogJobId) {
    disarmWatchdog(label);
  }

  out({
    ok:         true,
    label,
    sessionKey: entry.sessionKey,
    status:     entry.status,
    spawnedAt:  entry.spawnedAt,
    summary:    entry.summary || (lastReply ? lastReply.slice(0, 500) : null),
    lastReply:  lastReply || null,
    error:      entry.error || null,
  });
}

/**
 * done — agent-side completion signal (push-based).
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

  // Structural completion checklist — replaces planning-phrase guard.
  // Agents must assert completion status explicitly via structured fields.
  if (!checklistRaw) {
    die(
      'REJECTED: --checklist is required. Pass --checklist with JSON object asserting completion status. ' +
      "Example: --checklist '{\"work_complete\":true}' " +
      'work_complete MUST be true — you are asserting all assigned work is finished. ' +
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

  // Validate optional fields if present — reject if any are explicitly false
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

  // Bug 1 fix: truncate summary to 300 chars (delivery path silently truncates at 500)
  const MAX_SUMMARY = 300;
  let summary = rawSummary;
  if (rawSummary.length > MAX_SUMMARY) {
    process.stderr.write(
      `[${BRAND}] warn: --summary truncated from ${rawSummary.length} chars to ${MAX_SUMMARY} chars\n`,
    );
    summary = rawSummary.slice(0, MAX_SUMMARY);
  }

  const existing = getLabel(label);

  // ── Fix 1: Minimum runtime guard ────────────────────────────────────────
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
            `REJECTED: Session ran for only ${elapsedS}s — suspiciously short for this task scope. ` +
            `If work is genuinely complete, re-run with --force-done --reason "explanation".`,
            1,
          );
        }
        // --force-done present — require --reason
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

  // ── Fix 2: SHA required when task involves git operations ────────────────
  // If the stored task prompt references git operations, --sha is mandatory.
  // Fix 1 (edge case): old labels enqueued before 6dfa458 have no taskPrompt stored.
  //   When taskPrompt is absent, skip the git-SHA check to avoid breaking existing labels,
  //   but log a warning so operators know the guard was bypassed.
  // Fix 2 (edge case): tightened regex uses word boundaries so prose mentions like
  //   "do NOT use git push" do NOT trigger the gate; only actual commands do.
  if (existing) {
    const taskPrompt = existing.taskPrompt;
    if (!taskPrompt) {
      // taskPrompt absent — label enqueued before guard was added; skip check but warn.
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
    // Sanitize: must be a valid git SHA (7–40 hex chars)
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      die(`REJECTED: --sha "${sha}" is not a valid git SHA (must be 7–40 hex characters). Pass the actual commit SHA.`, 1);
    }
    // Verify the commit exists in the local git environment
    try {
      execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { stdio: 'pipe' });
    } catch {
      die(`REJECTED: SHA ${sha} not found in local git. Push your commits before calling done.`, 1);
    }
  }

  // ── Fix 3: Session activity check ────────────────────────────────────────
  // A session that was spawned 2h ago but did nothing (e.g. immediately called done)
  // would pass the wall-clock guard. Check message count via the gateway sessions API
  // to catch idle sessions regardless of wall-clock age.
  // Escape hatches: --force-done (already accepted above) or --skip-activity-check.
  if (existing && existing.sessionKey && !flags['skip-activity-check'] && !forceDone) {
    try {
      const sessionInfoRes = await fetch(
        `${GATEWAY_URL}/sessions/${existing.sessionKey}`,
        {
          headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (sessionInfoRes.ok) {
        const sessionInfo = await sessionInfoRes.json().catch(() => null);
        const msgCount = sessionInfo?.messageCount ?? sessionInfo?.messages?.length ?? null;
        if (msgCount !== null && msgCount <= 2) {
          die(
            `REJECTED: Session has only ${msgCount} messages — likely did not complete the assigned work. ` +
            `Use --force-done --reason if work is genuinely complete, or --skip-activity-check to bypass this check.`,
            1,
          );
        }
      }
      // Non-2xx (session not found, etc.) → skip check gracefully
    } catch (activityErr) {
      // Gateway API unavailable or timed out — skip check, log warning, do NOT fail.
      process.stderr.write(
        `[${BRAND}] warn: session activity check unavailable for label=${label}: ${activityErr.message} — skipping check\n`,
      );
    }
  }

  if (!existing) {
    // Label was never registered (e.g. direct subagent spawn, not via enqueue).
    // This is not an error — the work completed, the label just wasn't tracked.
    process.stderr.write(`[${BRAND}] warn: no session found for label "${label}" — registering as done\n`);
    setLabel(label, { status: 'done', summary, ...(sha ? { sha } : {}) });

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
        deliverTo,
        deliveryChannel,
      }).catch(() => {});
    } else {
      process.stderr.write(`[${BRAND}] warn: no deliverTo in config — completion not delivered for "${label}"\n`);
    }

    out({ ok: true, label, status: 'done', summary, message: 'Label not previously registered; marked done.' });
    return;
  }

  setLabel(label, {
    status:  'done',
    summary,
    ...(sha ? { sha } : {}),
  });

  // Disarm watchdog when agent signals done
  disarmWatchdog(label);

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
  }).catch(() => {});

  out({ ok: true, label, status: 'done', summary, message: 'Label marked done via agent signal.' });
}

/**
 * send / steer — send a message into a running session.
 *
 * Flags:
 *   --label <string>     Required (unless --session-key)
 *   --message <string>   Required. Message to send
 *   --session-key <key>  Optional. Direct session key (bypasses label lookup)
 */
async function cmdSend(flags) {
  const label     = flags.label;
  const message   = flags.message;
  const directKey = flags['session-key'];

  if (!message) die('--message is required', 2);
  if (!label && !directKey) die('--label or --session-key is required', 2);

  let sessionKey = directKey;
  if (!sessionKey) {
    const entry = getLabel(label);
    if (!entry?.sessionKey) die(`No session found for label "${label}"`);
    sessionKey = entry.sessionKey;
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
 * heartbeat — check session liveness.
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
 * list — list all tracked labels and their sessions.
 *
 * Flags:
 *   --status <status>    Filter by status (running|done|error)
 *   --limit <n>          Max entries (default: 20)
 */
function cmdList(flags) {
  const filterStatus = flags.status || null;
  const limit        = parseInt(flags.limit || '20', 10);

  const labels = loadLabels();
  let entries = Object.entries(labels).map(([name, data]) => ({
    label: name,
    ...data,
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

// ── Usage ────────────────────────────────────────────────────

function usage() {
  process.stdout.write(`
${BRAND} 🌶️ — sub-agent dispatch CLI (native gateway API)

Usage: openclaw-scheduler <subcommand> [flags]

Subcommands:
  enqueue  --label <l> --message <m>|--message-file <f> [--agent <a>] [--thinking <t>]
           [--timeout <s>] [--mode fresh|reuse] [--model <m>]
           [--origin <o>]  (auto-detected from active session; override with e.g. "telegram:<your-group-id>")
           [--deliver-to <id>] [--deliver-channel <ch>] [--delivery-mode <m>]
           (--deliver-to defaults to origin chat ID when --origin is "telegram:<id>")
           [--no-monitor] [--monitor-interval <cron>] [--monitor-timeout <min>]

  status   --label <l>

  stuck    [--threshold-min <n>]      (exits 1 if stuck sessions found)

  result   --label <l>

  send     --label <l> --message <m> [--session-key <k>]

  steer    --label <l> --message <m>  (alias for send)

  heartbeat --label <l>  OR  --session-key <k>

  list     [--status running|done|error] [--limit <n>]

  sync     [--dry-run]                 (reconcile labels.json with sessions store)

  done     --label <l> [--summary <s>] (agent-side completion signal; marks label as done)
`);
}

// ── Main ─────────────────────────────────────────────────────

const [,, subcommand, ...rest] = process.argv;
const flags = parseFlags(rest);

switch (subcommand) {
  case 'enqueue':   await cmdEnqueue(flags);   break;
  case 'status':    cmdStatus(flags);          break;
  case 'stuck':     await cmdStuck(flags);     break;
  case 'result':    cmdResult(flags);          break;
  case 'send':      await cmdSend(flags);      break;
  case 'steer':     await cmdSend(flags);      break;
  case 'heartbeat': cmdHeartbeat(flags);       break;
  case 'list':      cmdList(flags);            break;
  case 'sync':      cmdSync(flags);            break;
  case 'done':      await cmdDone(flags);       break;
  default:          usage(); process.exit(2);
}
