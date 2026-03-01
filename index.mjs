#!/usr/bin/env node
/**
 * chilisaus — Sub-agent dispatch CLI for OpenClaw
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
 *
 * Exit codes:
 *   0  — success / nothing stuck
 *   1  — stuck runs found, or hard error
 *   2  — argument error
 *
 * Usage: node index.mjs <subcommand> [options]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { emitEvent, onStarted, onFinished, onStuck } from './hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────

const LABELS_PATH = join(__dirname, 'labels.json');

/** Load gateway auth token from config or env */
function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const configPath = join(process.env.HOME || '~', '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gateway?.auth?.token || null;
  } catch { return null; }
}

const GATEWAY_TOKEN = getGatewayToken();

// ── Helpers ──────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`[chilisaus] ${msg}\n`);
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
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
    throw new Error(`gateway call ${method} failed: ${stderr || stdout || err.message}`);
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
 *   --deliver-to <target>    Delivery target (kept for compat)
 *   --delivery-mode <mode>   announce|announce-always|none (default: announce)
 *   --mode <fresh|reuse>
 *       fresh  — always spawn new session (default)
 *       reuse  — look up prior session_key for this label, send into it
 *   --session-key <key>      Explicit session key override
 *   --model <string>         Model override (e.g. anthropic/claude-sonnet-4-6)
 */
async function cmdEnqueue(flags) {
  const label   = flags.label;
  const message = flags.message;
  if (!label)   die('--label is required', 2);
  if (!message) die('--message is required', 2);

  const agent      = flags.agent           || 'main';
  const thinking   = flags.thinking        || null;
  const timeoutS   = parseInt(flags.timeout || '300', 10);
  const deliverTo  = flags['deliver-to']   || null;
  const deliverMode = flags['delivery-mode'] || 'announce';
  const mode       = flags.mode            || 'fresh';
  const model      = flags.model           || null;

  // ── Session key resolution ──────────────────────────────────
  let sessionKey = flags['session-key'] || null;

  if (!sessionKey && mode === 'reuse') {
    const existing = getLabel(label);
    if (existing?.sessionKey) {
      sessionKey = existing.sessionKey;
      process.stderr.write(`[chilisaus] mode=reuse → continuing session ${sessionKey}\n`);
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
        die(`sessions.patch (thinking) failed: ${err.message}`);
      }
    }
  }

  // ── Build the task message ──────────────────────────────────
  const taskMessage = [
    `[Subagent Context] You are running as a subagent (depth 1/3). Results auto-announce to your requester; do not busy-poll for status.`,
    ``,
    `[Subagent Task]: ${message}`,
  ].join('\n');

  // ── Call gateway agent method ───────────────────────────────
  try {
    const response = gatewayCall('agent', {
      message:        taskMessage,
      sessionKey,
      idempotencyKey: idem,
      deliver:        false,
      lane:           'subagent',
      timeout:        timeoutS,
      label:          label,
      thinking:       thinking || undefined,
    }, { timeout: 15000 });

    // Update ledger
    setLabel(label, {
      sessionKey,
      runId:     response?.runId || idem,
      agent,
      mode:      isFresh ? 'fresh' : 'reuse',
      model:     model || null,
      thinking,
      spawnedAt: new Date().toISOString(),
      status:    'running',
      summary:   null,
      error:     null,
    });

    // Fire dispatch.started hook (best-effort)
    await onStarted({
      label, job_id: idem, run_id: response?.runId || idem,
      agent, mode, session_key: sessionKey,
    }).catch(() => {});

    out({
      ok:         true,
      label,
      sessionKey,
      runId:      response?.runId || idem,
      mode:       isFresh ? 'fresh' : 'reuse',
      agent,
      status:     'accepted',
      message:    'Session spawned via gateway. Agent is running.',
    });
  } catch (err) {
    die(`gateway agent call failed: ${err.message}`);
  }
}

/**
 * status — show session status for a label.
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

  // Check session liveness via gateway sessions.list
  let liveness = null;
  if (entry.sessionKey) {
    try {
      const result = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 8000 });
      const session = result?.sessions?.find(s => s.key === entry.sessionKey);
      if (session) {
        liveness = {
          updatedAt: session.updatedAt,
          ageMs:     session.updatedAt ? Date.now() - session.updatedAt : null,
          sessionId: session.sessionId,
          model:     session.model || null,
          tokens:    session.totalTokens || null,
        };
      } else {
        liveness = { error: 'session not found in store (may have expired)' };
      }
    } catch (err) {
      liveness = { error: 'failed to query gateway: ' + err.message };
    }
  }

  out({
    ok:         true,
    label,
    sessionKey: entry.sessionKey,
    runId:      entry.runId,
    agent:      entry.agent,
    mode:       entry.mode,
    status:     entry.status,
    spawnedAt:  entry.spawnedAt,
    updatedAt:  entry.updatedAt,
    summary:    entry.summary || null,
    error:      entry.error || null,
    liveness,
  });
}

/**
 * stuck — find sessions running past threshold.
 * Exits 1 if any stuck sessions found.
 *
 * Flags:
 *   --threshold-min <n>   Minutes without activity to consider stuck (default: 15)
 */
async function cmdStuck(flags) {
  const thresholdMin = parseFloat(flags['threshold-min'] || '15');
  const thresholdMs  = thresholdMin * 60 * 1000;

  const labels = loadLabels();
  const stuckSessions = [];

  // Pre-fetch all sessions once to avoid N gateway calls
  let sessionCache = null;
  try {
    const result = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 10000 });
    sessionCache = result?.sessions || [];
  } catch {}

  for (const [name, entry] of Object.entries(labels)) {
    if (entry.status !== 'running') continue;

    const spawnedAt = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
    const ageMs     = Date.now() - spawnedAt;

    if (ageMs < thresholdMs) continue;

    // Double-check with gateway
    let lastActivity = spawnedAt;
    if (sessionCache) {
      const session = sessionCache.find(s => s.key === entry.sessionKey);
      if (session?.updatedAt) lastActivity = session.updatedAt;
    }

    const silenceMs = Date.now() - lastActivity;
    if (silenceMs >= thresholdMs) {
      stuckSessions.push({
        label:      name,
        sessionKey: entry.sessionKey,
        agent:      entry.agent,
        spawnedAt:  entry.spawnedAt,
        ageMin:     Math.round(ageMs / 60000),
        silenceMin: Math.round(silenceMs / 60000),
      });
    }
  }

  if (!stuckSessions.length) {
    out({ ok: true, stuck_count: 0, stuck_sessions: [], threshold_min: thresholdMin });
    process.exit(0);
  }

  const lines = stuckSessions.map(s =>
    `• ${s.label} (running ${s.ageMin}min, silent ${s.silenceMin}min)`
  ).join('\n');

  process.stdout.write(
    `⚠️ ${stuckSessions.length} stuck session${stuckSessions.length > 1 ? 's' : ''}:\n${lines}\n`
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

  try {
    const result = gatewayCall('sessions.list', { activeMinutes: 1440 }, { timeout: 8000 });
    const session = result?.sessions?.find(s => s.key === sessionKey);

    if (!session) {
      out({ ok: false, sessionKey, alive: false, message: 'Session not found in store' });
      return;
    }

    const ageMs = session.updatedAt ? Date.now() - session.updatedAt : null;

    out({
      ok:        true,
      sessionKey,
      label:     label || null,
      alive:     ageMs !== null && ageMs < 10 * 60 * 1000,
      ageMs,
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
      sessionId: session.sessionId,
      model:     session.model || null,
    });
  } catch (err) {
    out({ ok: false, sessionKey, alive: false, error: err.message });
  }
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
chilisaus 🌶️ — sub-agent dispatch CLI (native gateway API)

Usage: node index.mjs <subcommand> [flags]

Subcommands:
  enqueue  --label <l> --message <m> [--agent <a>] [--thinking <t>]
           [--timeout <s>] [--mode fresh|reuse] [--model <m>]
           [--deliver-to <id>] [--delivery-mode <m>]

  status   --label <l>

  stuck    [--threshold-min <n>]      (exits 1 if stuck sessions found)

  result   --label <l>

  send     --label <l> --message <m> [--session-key <k>]

  steer    --label <l> --message <m>  (alias for send)

  heartbeat --label <l>  OR  --session-key <k>

  list     [--status running|done|error] [--limit <n>]
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
  default:          usage(); process.exit(2);
}
