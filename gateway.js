// Gateway API client — talks to OpenClaw's HTTP endpoints
import { execSync } from 'child_process';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

/**
 * Invoke a tool via the Gateway's /tools/invoke HTTP endpoint.
 */
export async function invokeGatewayTool(tool, args, sessionKey = 'main') {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {}),
    },
    body: JSON.stringify({ tool, args, sessionKey }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${tool} failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

/**
 * Send a system event to the main session (replaces heartbeat wake).
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

/**
 * Spawn an isolated session for an agent turn (for isolated jobs).
 * Uses sessions_spawn via tools/invoke.
 */
export async function spawnIsolatedRun(job, runId) {
  const args = {
    task: job.payload_message,
    label: `scheduler:${job.id}:${runId}`,
    ...(job.agent_id ? { agentId: job.agent_id } : {}),
    ...(job.payload_model ? { model: job.payload_model } : {}),
    ...(job.payload_thinking ? { thinking: job.payload_thinking } : {}),
    ...(job.payload_timeout_seconds ? { runTimeoutSeconds: job.payload_timeout_seconds } : {}),
    cleanup: 'keep', // we manage lifecycle
  };

  return invokeGatewayTool('sessions_spawn', args);
}

/**
 * List sessions matching a filter — used for implicit heartbeat.
 */
export async function listSessions(opts = {}) {
  return invokeGatewayTool('sessions_list', {
    ...(opts.activeMinutes ? { activeMinutes: opts.activeMinutes } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.messageLimit ? { messageLimit: opts.messageLimit } : {}),
  });
}

/**
 * Get session history — used to check if a session is still active.
 */
export async function getSessionHistory(sessionKey, limit = 1) {
  return invokeGatewayTool('sessions_history', { sessionKey, limit });
}

/**
 * Send a message into a session.
 */
export async function sendToSession(sessionKey, message) {
  return invokeGatewayTool('sessions_send', { sessionKey, message });
}

/**
 * Send a message to a channel (for delivery).
 */
export async function sendMessage(channel, target, message) {
  const args = {
    action: 'send',
    message,
    ...(channel ? { channel } : {}),
    ...(target ? { target } : {}),
  };
  return invokeGatewayTool('message', args);
}
