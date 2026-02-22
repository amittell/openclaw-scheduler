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

/**
 * Add a job to OpenClaw's built-in cron (for dispatch).
 * Returns the created job.
 */
export async function addCronJob(opts) {
  const result = await invokeGatewayTool('cron', {
    action: 'add',
    job: opts,
  });
  return result;
}

/**
 * Run an existing OpenClaw cron job immediately.
 */
export async function runCronJob(jobId) {
  return invokeGatewayTool('cron', {
    action: 'run',
    jobId,
    runMode: 'force',
  });
}

/**
 * Get cron run history for a job.
 */
export async function getCronRuns(jobId) {
  return invokeGatewayTool('cron', {
    action: 'runs',
    jobId,
  });
}

/**
 * List active sessions (for implicit heartbeat).
 */
export async function listSessions(opts = {}) {
  return invokeGatewayTool('sessions_list', {
    ...(opts.activeMinutes ? { activeMinutes: opts.activeMinutes } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.messageLimit ? { messageLimit: opts.messageLimit } : {}),
  });
}

/**
 * Send a message to a channel (for delivery).
 */
export async function sendMessage(channel, target, message) {
  return invokeGatewayTool('message', {
    action: 'send',
    message,
    ...(channel ? { channel } : {}),
    ...(target ? { target } : {}),
  });
}
