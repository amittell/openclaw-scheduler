// Gateway API client -- independent dispatch via chat completions + system events
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getDb } from './db.js';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const HOME_DIR = process.env.HOME || homedir();
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

let _cachedToken;
let _tokenLoaded = false;

function getGatewayToken() {
  if (!_tokenLoaded) {
    _tokenLoaded = true;
    if (process.env.OPENCLAW_GATEWAY_TOKEN) {
      _cachedToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      try {
        const tokenPath = process.env.OPENCLAW_GATEWAY_TOKEN_PATH
          || join(HOME_DIR, '.openclaw/credentials/.gateway-token');
        _cachedToken = readFileSync(tokenPath, 'utf-8').trim();
      } catch { _cachedToken = null; }
    }
  }
  return _cachedToken;
}

function authHeaders(scopes = null) {
  const token = getGatewayToken();
  return token
    ? {
      'Authorization': `Bearer ${token}`,
      ...(scopes ? { 'x-openclaw-scopes': scopes } : {}),
    }
    : {};
}

// -- Chat Completions (independent dispatch) -----------------

/**
 * Run an agent turn via the OpenAI-compatible chat completions endpoint.
 * Returns the full response including the assistant message.
 *
 * This is the primary dispatch mechanism for isolated jobs.
 * Each call gets its own session (or use sessionKey for continuity).
 *
 * @param {object} opts
 * @param {string} opts.message - The user message to send.
 * @param {string} [opts.agentId='main'] - Agent ID.
 * @param {string} [opts.sessionKey] - Session key for continuity.
 * @param {string} [opts.model] - Model override.
 * @param {string|null} [opts.authProfile] - Auth profile header value.
 * @param {number} [opts.timeoutMs=300000] - Request timeout in milliseconds.
 */
export async function runAgentTurn(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    authProfile,
    timeoutMs = 300000,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        ...(agentId ? { 'x-openclaw-agent-id': agentId } : {}),
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
        ...(authProfile ? { 'x-openclaw-auth-profile': authProfile } : {}),
      },
      body: JSON.stringify({
        model: model || `openclaw:${agentId}`,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Chat completions failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      sessionKey: resp.headers.get('x-openclaw-session-key') || sessionKey,
      raw: data,
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`Agent turn timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Activity-aware wrapper around runAgentTurn.
 *
 * Instead of a hard wall-clock abort, this polls the session's `updatedAt`
 * timestamp and only aborts when the session has been idle for 2x the idle
 * threshold (default: 2 x 120s = 240s of no activity).
 *
 * The absolute ceiling (`absoluteTimeoutMs`, default 5 min) is always enforced
 * as a safety net regardless of activity.
 *
 * @param {Object} opts
 * @param {string} opts.message           - Prompt to send
 * @param {string} opts.agentId           - Agent ID (default: 'main')
 * @param {string} opts.sessionKey        - Session key for matching activity
 * @param {string} opts.model             - Model override
 * @param {number} opts.idleTimeoutMs     - Per-check idle threshold; session aborts after 2x this value of continuous idle time
 * @param {number} opts.pollIntervalMs    - How often to poll session activity (default: 60000)
 * @param {number} opts.absoluteTimeoutMs - Hard ceiling regardless of activity (default: 300000)
 * @param {string} opts.authProfile       - Auth profile override (null, 'inherit', or 'provider:label')
 */
export async function runAgentTurnWithActivityTimeout(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    authProfile,
    idleTimeoutMs = 120000,       // per-check idle threshold (from payload_timeout_seconds)
    pollIntervalMs = 60000,       // check activity every 60s
    absoluteTimeoutMs = 300000,   // hard ceiling (run_timeout_ms)
  } = opts;

  const controller = new AbortController();
  let abortReason = null;

  // Hard absolute ceiling -- always fires regardless of activity
  const absoluteTimer = setTimeout(() => {
    abortReason = 'absolute_timeout';
    controller.abort();
  }, absoluteTimeoutMs);

  // Track last known activity time (initialised to now -- grace period for startup)
  let lastSeenActivity = Date.now();

  const checkActivity = async () => {
    try {
      const result = await listSessions({ kinds: ['subagent', 'isolated'], activeMinutes: 60 });
      // Normalise: gateway wraps result in several layers
      const sessions =
        result?.result?.details?.sessions ||
        result?.result?.sessions ||
        result?.sessions ||
        result || [];
      if (!Array.isArray(sessions)) return;

      const matched = sessions.find(
        s => (s.key || s.sessionKey) === sessionKey
      );

      if (matched && matched.updatedAt) {
        const ts = typeof matched.updatedAt === 'number'
          ? matched.updatedAt
          : new Date(matched.updatedAt).getTime();
        if (ts > lastSeenActivity) {
          lastSeenActivity = ts;           // activity advanced -> reset
        }
      }

      // Check total continuous idle time
      const idleDuration = Date.now() - lastSeenActivity;
      if (idleDuration >= idleTimeoutMs * 2) {
        // Two full idle windows elapsed -- session is truly idle
        abortReason = 'idle_timeout';
        controller.abort();
      }
    } catch {
      // Monitoring failure -- don't abort on transient errors
    }
  };

  // Start polling after the first interval (gives session time to initialise)
  const pollTimer = setInterval(checkActivity, pollIntervalMs);

  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        ...(agentId ? { 'x-openclaw-agent-id': agentId } : {}),
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
        ...(authProfile ? { 'x-openclaw-auth-profile': authProfile } : {}),
      },
      body: JSON.stringify({
        model: model || `openclaw:${agentId}`,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Chat completions failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      sessionKey: resp.headers.get('x-openclaw-session-key') || sessionKey,
      raw: data,
    };
  } catch (err) {
    // Translate AbortError into descriptive messages
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      if (abortReason === 'idle_timeout') {
        throw new Error(
          `Session idle for ${Math.round((idleTimeoutMs * 2) / 1000)}s -- aborted (activity-based timeout)`,
          { cause: err }
        );
      }
      if (abortReason === 'absolute_timeout') {
        throw new Error(
          `Exceeded absolute timeout of ${Math.round(absoluteTimeoutMs / 1000)}s`,
          { cause: err }
        );
      }
    }
    throw err;
  } finally {
    clearTimeout(absoluteTimer);
    clearInterval(pollTimer);
  }
}

// -- System Events (main session) ----------------------------

/**
 * Send a system event to the main session.
 */
const VALID_MODES = new Set(['now', 'queue']);

export async function sendSystemEvent(text, mode = 'now') {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode '${mode}': must be one of ${[...VALID_MODES].join(', ')}`);
  }
  try {
    const result = execFileSync(
      'openclaw', ['system', 'event', '--text', text, '--mode', mode, '--json'],
      { encoding: 'utf8', timeout: 30000 }
    );
    // Strip any non-JSON prefix (e.g. openclaw doctor output) before parsing
    const jsonStart = result.indexOf('{');
    const clean = jsonStart >= 0 ? result.slice(jsonStart) : result;
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`system event failed: ${err.message}`, { cause: err });
  }
}

// -- Tools Invoke (for session listing, messages) ------------

/**
 * Invoke a tool via the Gateway's /tools/invoke endpoint.
 */
export async function invokeGatewayTool(tool, args, sessionKey = 'main') {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ tool, args, sessionKey }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${tool} failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  return resp.json();
}

/**
 * List active sessions (for task tracker auto-correlation).
 * opts.kinds: filter by session kind, e.g. ['subagent']
 * opts.activeMinutes: only sessions active within N minutes
 * opts.limit: max results
 */
export async function listSessions(opts = {}) {
  return invokeGatewayTool('sessions_list', {
    ...(opts.activeMinutes ? { activeMinutes: opts.activeMinutes } : {}),
    ...(opts.limit       ? { limit: opts.limit }       : {}),
    ...(opts.kinds       ? { kinds: opts.kinds }       : {}),
    messageLimit: 0,   // don't fetch message history -- we only need session metadata
  });
}

/**
 * Fetch ALL active sub-agent sessions across every requester.
 * Uses the gateway token's admin view -- not scoped to a single session.
 * Returns an array of session objects (keys like "agent:*:subagent:*").
 */
export async function getAllSubAgentSessions(activeMinutes = 10) {
  try {
    const result = await listSessions({ kinds: ['subagent'], activeMinutes, limit: 200 });
    // Gateway returns { sessions: [...] } or similar -- normalise to array
    const raw = result?.sessions || result?.result?.sessions || result || [];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a delivery alias. Returns { channel, target } or null.
 * Accepts '@name' or bare 'name'. Falls through to null if not found.
 */
export function resolveDeliveryAlias(rawTarget) {
  if (!rawTarget) return null;
  try {
    const db = getDb();
    const name = rawTarget.startsWith('@') ? rawTarget.slice(1) : rawTarget;
    const row = db.prepare('SELECT channel, target FROM delivery_aliases WHERE alias = ?').get(name);
    return row || null;
  } catch {
    return null;
  }
}

function chunkPlainText(message, maxBytes) {
  const text = String(message ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const chunks = [];
  let rest = text;
  const hardLimit = Math.max(256, maxBytes - 12);

  while (rest.length > 0) {
    if (Buffer.byteLength(rest, 'utf8') <= hardLimit) {
      chunks.push(rest);
      break;
    }

    // Walk forward tracking byte count to find the character index at the byte limit
    let byteCount = 0;
    let charLimit = 0;
    for (let i = 0; i < rest.length; i++) {
      const code = rest.codePointAt(i);
      const charBytes = code > 0xFFFF ? 4 : code > 0x7FF ? 3 : code > 0x7F ? 2 : 1;
      if (byteCount + charBytes > hardLimit) break;
      byteCount += charBytes;
      charLimit = i + 1;
      // Skip surrogate pair trailing unit
      if (code > 0xFFFF) i++;
    }

    let splitAt = rest.lastIndexOf('\n', charLimit);
    if (splitAt < charLimit * 0.5) splitAt = rest.lastIndexOf(' ', charLimit);
    if (splitAt < charLimit * 0.5) splitAt = charLimit;

    const part = rest.slice(0, splitAt).trimEnd();
    chunks.push(part);
    rest = rest.slice(splitAt).trimStart();
  }

  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

export function splitMessageForChannel(channel, message) {
  if (channel === 'telegram') {
    return chunkPlainText(message, TELEGRAM_MAX_MESSAGE_LENGTH);
  }
  return [String(message ?? '')];
}

/**
 * Send a message to a Telegram/channel target via message tool.
 * Automatically resolves delivery aliases (e.g. '@team_room', 'owner_dm').
 */
export async function deliverMessage(channel, target, message) {
  let resolvedChannel = channel;
  let resolvedTarget = target;

  // Strip channel prefix from target if present (e.g., "telegram/123456789" -> "123456789")
  // Some jobs store the channel in the delivery_to field as "channel/id".
  if (resolvedTarget && resolvedChannel && resolvedTarget.startsWith(resolvedChannel + '/')) {
    resolvedTarget = resolvedTarget.slice(resolvedChannel.length + 1);
  }

  // Resolve alias: try '@name' strip and bare name lookup
  if (resolvedTarget) {
    const alias = resolveDeliveryAlias(resolvedTarget);
    if (alias) {
      resolvedChannel = alias.channel;
      resolvedTarget = alias.target;
    }
  }

  const parts = splitMessageForChannel(resolvedChannel, message);
  let lastResponse = null;
  for (const part of parts) {
    lastResponse = await invokeGatewayTool('message', {
      action: 'send',
      message: part,
      ...(resolvedChannel ? { channel: resolvedChannel } : {}),
      ...(resolvedTarget ? { target: resolvedTarget } : {}),
    });
  }
  return {
    ok: true,
    parts: parts.length,
    lastResponse,
  };
}

/**
 * Check gateway health.
 */
export async function checkGatewayHealth() {
  try {
    const resp = await fetch(`${GATEWAY_URL}/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the gateway to become reachable, polling at intervals.
 * Returns true if the gateway responded within the timeout, false otherwise.
 * Any HTTP response (even non-200) counts as "up" -- we just need TCP connectivity.
 *
 * @param {number} timeoutMs  - Maximum time to wait (default 30s)
 * @param {number} intervalMs - Polling interval (default 2s)
 * @returns {Promise<boolean>}
 */
export async function waitForGateway(timeoutMs = 30000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${GATEWAY_URL}/health`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(Math.min(intervalMs, 5000)),
      });
      try { await resp.body?.cancel(); } catch {}
      return true; // Any response means gateway is up
    } catch {
      // Not up yet -- wait and retry
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(intervalMs, remaining)));
    }
  }
  return false;
}

/**
 * Write authProfileOverride directly to the gateway's sessions.json store.
 *
 * The gateway reads sessions.json on each agent turn (with mtime-based cache
 * invalidation), so writing here before dispatch ensures the embedded runner
 * picks up the correct auth profile.
 *
 * The x-openclaw-auth-profile HTTP header sent by runAgentTurnWithActivityTimeout
 * is NOT read by the gateway (dead header). This direct store write is the
 * effective mechanism for auth profile propagation to isolated sessions.
 *
 * @param {string} sessionKey - Session key as used in the HTTP request (e.g. 'scheduler:<jobId>')
 * @param {string} authProfile - Auth profile ID (e.g. 'anthropic:gmail')
 * @param {string} [agentId='main'] - Agent ID for store path resolution
 * @returns {{ ok: boolean, error?: string }}
 */
export function applyAuthProfileToSessionStore(sessionKey, authProfile, agentId = 'main') {
  if (!sessionKey || !authProfile) {
    return { ok: false, error: 'sessionKey and authProfile are required' };
  }

  // The gateway may persist session state under either the canonical agent-scoped
  // key or the flat transport key, depending on which path created the session.
  // Keep both aliases in sync so isolated scheduler jobs cannot miss the override.
  const canonicalMatch = sessionKey.match(/^agent:[^:]+:(.+)$/);
  const canonicalKey = sessionKey.startsWith('agent:')
    ? sessionKey
    : `agent:${agentId}:${sessionKey}`;
  const flatSessionKey = canonicalMatch?.[1] || sessionKey;
  const keyAliases = Array.from(new Set([canonicalKey, flatSessionKey]));
  const sessionsPath = join(HOME_DIR, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');

  try {
    if (!existsSync(sessionsPath)) {
      return { ok: false, error: `sessions.json not found at ${sessionsPath}` };
    }

    const raw = readFileSync(sessionsPath, 'utf-8');
    const store = JSON.parse(raw);

    const now = Date.now();
    let changed = false;

    for (const key of keyAliases) {
      const entry = store[key];
      if (!entry) {
        // Session doesn't exist yet -- create a minimal entry.
        // The gateway will populate the rest on the first agent turn.
        store[key] = {
          updatedAt: now,
          authProfileOverride: authProfile,
          authProfileOverrideSource: 'user',
        };
        changed = true;
        continue;
      }

      if (entry.authProfileOverride !== authProfile || entry.authProfileOverrideSource !== 'user') {
        // Update existing entry
        entry.authProfileOverride = authProfile;
        entry.authProfileOverrideSource = 'user';
        entry.updatedAt = now;
        // Clear compaction count so the override sticks across compactions
        delete entry.authProfileOverrideCompactionCount;
        changed = true;
      }
    }

    if (!changed) {
      return { ok: true };
    }

    writeFileSync(sessionsPath, JSON.stringify(store), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to update sessions.json: ${err.message}` };
  }
}

/**
 * Sync the live auth-profiles.json from ~/.openclaw/credentials/ to the agent's
 * auth store at ~/.openclaw/agents/<agentId>/agent/auth-profiles.json.
 *
 * This ensures scheduler sessions always use fresh credentials (tokens, order,
 * default profile) even when no explicit auth_profile is set on the job.
 * Without this, sessions created from a stable session key inherit a stale
 * copy of the auth store that was snapshotted when the session was first created.
 *
 * This is a fast file-copy operation (~1ms) and is safe to call before every
 * agent turn.
 *
 * @param {string} [agentId='main'] - Agent ID for store path resolution
 * @returns {{ ok: boolean, error?: string }}
 */
export function syncAuthStoreToSession(agentId = 'main') {
  const livePath = join(HOME_DIR, '.openclaw', 'credentials', 'auth-profiles.json');
  const agentStorePath = join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');

  try {
    if (!existsSync(livePath)) {
      return { ok: false, error: `Live auth store not found at ${livePath}` };
    }

    // Ensure the agent directory exists
    const agentDir = join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    copyFileSync(livePath, agentStorePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to sync auth store: ${err.message}` };
  }
}
