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
 * Usage: node index.mjs <subcommand> [options]
 */

import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { onStarted, onStuck } from './hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || homedir();

// ── Config ───────────────────────────────────────────────────

const LABELS_PATH = process.env.DISPATCH_LABELS_PATH || join(__dirname, 'labels.json');

/** Load dispatch config from config.json (falls back to {} on error) */
function loadConfig() {
  try {
    const cfgPath = join(__dirname, 'config.json');
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch { return {}; }
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

/** Parse --flag value pairs from argv */
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

// ── Labels Ledger ────────────────────────────────────────────

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

function getLabel(name) {
  return loadLabels()[name] || null;
}

function setLabel(name, data) {
  const labels = loadLabels();
  labels[name] = { ...labels[name], ...data, updatedAt: new Date().toISOString() };
  saveLabels(labels);
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
  if (GATEWAY_TOKEN) args.push('--token', GATEWAY_TOKEN);

  try {
    const result = execFileSync('openclaw', args, {
      encoding: 'utf-8',
      timeout:  timeout + 5000,
      stdio:    ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch (err) {
    const stderr = err.stderr?.trim() || '';
    const stdout = err.stdout?.trim() || '';
    if (stdout) try { return JSON.parse(stdout); } catch {}
    throw new Error(`gateway call ${method} failed: ${stderr || stdout || err.message}`, {
      cause: err,
    });
  }
}

/**
 * Invoke a gateway tool via HTTP API with session context.
 * Uses /tools/invoke endpoint so gateway evaluates with full session-tree
 * visibility (sees subagents, unlike raw gatewayCall RPC).
 */
function gatewayToolInvoke(tool, args = {}, sessionKey = 'agent:main:main', opts = {}) {
  try {
    const body = JSON.stringify({ tool, args, sessionKey });
    const raw = execFileSync('curl', [
      '-s', '-X', 'POST',
      'http://127.0.0.1:18789/tools/invoke',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${GATEWAY_TOKEN}`,
      '-d', body,
    ], { encoding: 'utf-8', timeout: (opts.timeout || 15000) + 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const outer = JSON.parse(raw.trim());
    if (outer?.result?.content?.[0]?.text) return JSON.parse(outer.result.content[0].text);
    return outer?.result || null;
  } catch {
    return null;
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
 * @returns {{ shouldResolve: boolean, reason: string, lastActivity: number|null, is529?: boolean, errorMsg?: string }}
 */
function checkSessionDone(sessionKey, sessionsStore, thresholdMs, sessionEverFound = true) {
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
  if (!sessionsStore[sessionKey]) {
    return {
      shouldResolve: true,
      reason:       logCheck.found
        ? `529/overload error detected: ${logCheck.error}`
        : sessionEverFound
          ? 'session not found in sessions store'
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
 *   --deliver-to <target>    Delivery target (e.g. Telegram chat ID). Enables deliver:true on the gateway call
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
  const deliverTo      = flags['deliver-to']       || null;
  const deliverChannel = flags['deliver-channel']   || 'telegram';
  const deliverMode    = flags['delivery-mode']     || 'announce';
  const mode        = flags.mode             || 'fresh';

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
    const configPath = join(HOME_DIR, '.openclaw', 'openclaw.json');
    parts.push(`---`);
    parts.push(`CHECK_IN: To report progress, use curl:`);
    parts.push(`GW_TOKEN=$(python3 -c "import json; print(json.load(open('` + configPath + `'))['gateway']['auth']['token'])")`);
    parts.push(`curl -s -X POST http://127.0.0.1:18789/tools/invoke -H 'Content-Type: application/json' -H "Authorization: Bearer $GW_TOKEN" -d '{"tool":"message","args":{"action":"send","channel":"telegram","target":"${deliverTo}","message":"📍 [${label}] <your status here>"},"sessionKey":"main"}'`);
    parts.push(`Call this every ~5 minutes with a brief progress update.`);
    parts.push(`---`);
    parts.push(``);
  }

  parts.push(`[Subagent Task]: ${message}`);

  // Append agent-side done signal instructions (Fix 2 — push-based completion)
  const doneScriptPath = __dirname + '/index.mjs';
  parts.push(``);
  parts.push(`---`);
  parts.push(`COMPLETION SIGNAL: When your task is fully complete, run this as your LAST action:`);
  parts.push(`node '${doneScriptPath}' done --label '${label.replace(/'/g, "'\\''")}' --summary "<one-line summary of what you did>"`);
  parts.push(`This lets the watcher know you're done without waiting for idle timeout.`);
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
      spawnedAt:      new Date().toISOString(),
      timeoutSeconds: timeoutS,
      status:         'running',
      summary:        null,
      error:          null,
    });

    // Fire dispatch.started hook (best-effort)
    await onStarted({
      label, job_id: idem, run_id: response?.runId || idem,
      agent, mode, session_key: sessionKey,
    }).catch(() => {});

    // ── Send "Starting" notification via gateway HTTP API ─────
    if (deliverTo && GATEWAY_TOKEN) {
      try {
        await fetch('http://127.0.0.1:18789/tools/invoke', {
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
    let schedulerWatcherOk = false;
    if (deliverTo && deliverMode !== 'none') {
      try {
        const watcherPath = join(__dirname, 'watcher.mjs');
        const escapedLabel = label.replace(/'/g, "'\\''");
        // Watcher timeout = session timeout + 120s buffer for startup/polling
        const watcherTimeoutS = timeoutS + 120;
        const watcherCmd = `'${process.execPath}' '${watcherPath}' --label '${escapedLabel}' --timeout ${watcherTimeoutS} --poll-interval 20`;

        const jobSpec = JSON.stringify({
          name:                     `${agentBrand}-deliver:${label}`,
          schedule_cron:            '0 0 31 2 *',  // never-cron; run_now triggers it once
          session_target:           'shell',
          payload_kind:             'shellCommand',
          payload_message:          watcherCmd,
          delivery_mode:            'announce-always',
          delivery_channel:         deliverChannel,
          delivery_to:              deliverTo,
          delivery_guarantee:       'at-least-once',
          ttl_hours:                72,    // 3-day audit window, then auto-prune
          overlap_policy:           'skip',
          run_timeout_ms:           (watcherTimeoutS + 60) * 1000,  // shell job timeout > watcher timeout
          run_now:                  true,
        });
        const schedulerCli = join(HOME_DIR, '.openclaw', 'scheduler', 'cli.js');
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
    const check = ageMs < STARTUP_GRACE_MS
      ? { shouldResolve: false }
      : checkSessionDone(entry.sessionKey, sessionsStore, 10 * 60 * 1000);
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
          status:  'done',
          summary: `Auto-resolved: ${check.reason}`,
        });
        syncAction = `auto-resolved: ${check.reason}`;
      }
    }
  }

  // Build liveness from sessions.json store
  if (entry.sessionKey && sessionsStore) {
    const sessionEntry = sessionsStore[entry.sessionKey];
    if (sessionEntry) {
      liveness = {
        updatedAt: sessionEntry.updatedAt,
        ageMs:     sessionEntry.updatedAt ? Date.now() - sessionEntry.updatedAt : null,
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
    const check = checkSessionDone(entry.sessionKey, stuckSessionsStore, effectiveThreshMs);

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
          status:  'done',
          summary: `Auto-resolved: ${check.reason}`,
        });
        autoResolved.push({ label: name, reason: check.reason });
      }
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
    const check = checkSessionDone(entry.sessionKey, syncStore, 10 * 60 * 1000);

    if (check.shouldResolve) {
      const newStatus = check.is529 ? 'error' : 'done';
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
            status:  'done',
            summary: `Synced: ${check.reason}`,
          });
        }
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
 *   --label <string>    Required. Label to mark as done
 *   --summary <string>  Optional. One-line completion summary
 */
function cmdDone(flags) {
  const label   = flags.label;
  const summary = flags.summary || 'completed (agent signal)';
  if (!label) die('--label is required', 2);

  const existing = getLabel(label);
  if (!existing) die(`No session found for label "${label}"`, 1);

  setLabel(label, {
    status:  'done',
    summary,
  });

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

  const ageMs = sessionEntry.updatedAt ? Date.now() - sessionEntry.updatedAt : null;

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

Usage: node index.mjs <subcommand> [flags]

Subcommands:
  enqueue  --label <l> --message <m>|--message-file <f> [--agent <a>] [--thinking <t>]
           [--timeout <s>] [--mode fresh|reuse] [--model <m>]
           [--deliver-to <id>] [--deliver-channel <ch>] [--delivery-mode <m>]

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
  case 'done':      cmdDone(flags);            break;
  default:          usage(); process.exit(2);
}
