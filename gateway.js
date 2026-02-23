// Gateway API client — independent dispatch via chat completions + system events
import { execSync, spawn } from 'child_process';
import { getDb } from './db.js';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

function authHeaders() {
  return GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {};
}

// ── Chat Completions (independent dispatch) ─────────────────

/**
 * Run an agent turn via the OpenAI-compatible chat completions endpoint.
 * Returns the full response including the assistant message.
 * 
 * This is the primary dispatch mechanism for isolated jobs.
 * Each call gets its own session (or use sessionKey for continuity).
 */
export async function runAgentTurn(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    timeoutMs = 300000,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(agentId ? { 'x-openclaw-agent-id': agentId } : {}),
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
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
  } finally {
    clearTimeout(timer);
  }
}

// ── System Events (main session) ────────────────────────────

/**
 * Send a system event to the main session.
 */
export async function sendSystemEvent(text, mode = 'now') {
  try {
    const result = execSync(
      `openclaw system event --text ${JSON.stringify(text)} --mode ${mode} --json`,
      { encoding: 'utf8', timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    throw new Error(`system event failed: ${err.message}`);
  }
}

// ── Tools Invoke (for session listing, messages) ────────────

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
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${tool} failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  return resp.json();
}

/**
 * List active sessions (for implicit heartbeat).
 */
export async function listSessions(opts = {}) {
  return invokeGatewayTool('sessions_list', {
    ...(opts.activeMinutes ? { activeMinutes: opts.activeMinutes } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
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

/**
 * Send a message to a Telegram/channel target via message tool.
 * Automatically resolves delivery aliases (e.g. '@team_room', 'owner_dm').
 */
export async function deliverMessage(channel, target, message) {
  let resolvedChannel = channel;
  let resolvedTarget = target;

  // Resolve alias: try '@name' strip and bare name lookup
  if (target) {
    const alias = resolveDeliveryAlias(target);
    if (alias) {
      resolvedChannel = alias.channel;
      resolvedTarget = alias.target;
    }
  }

  return invokeGatewayTool('message', {
    action: 'send',
    message,
    ...(resolvedChannel ? { channel: resolvedChannel } : {}),
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
  });
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
