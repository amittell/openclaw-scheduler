// Agent registry -- track agent status and capabilities
import { getDb } from './db.js';
import { assertValidAgentId, assertSessionKeyForAgent } from './identifiers.js';

function validateStoredAgent(agent) {
  if (!agent) return agent;
  try {
    assertValidAgentId(agent.id, 'stored agent id');
    if (agent.session_key !== null && agent.session_key !== undefined) {
      assertSessionKeyForAgent(
        agent.session_key,
        agent.id,
        `stored session_key for agent ${agent.id}`,
      );
    }
  } catch (error) {
    throw new Error(`Unsafe agent registry metadata: ${error.message}`, { cause: error });
  }
  return agent;
}

/**
 * Register or update an agent.
 */
export function upsertAgent(id, opts = {}) {
  const validatedId = assertValidAgentId(id);
  const sessionKey = opts.session_key === null || opts.session_key === undefined
    ? null
    : assertSessionKeyForAgent(opts.session_key, validatedId);
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, name, status, session_key, capabilities)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, agents.name),
      status = COALESCE(excluded.status, agents.status),
      session_key = COALESCE(excluded.session_key, agents.session_key),
      capabilities = COALESCE(excluded.capabilities, agents.capabilities),
      last_seen_at = datetime('now')
  `).run(
    validatedId,
    opts.name || null,
    opts.status || 'idle',
    sessionKey,
    opts.capabilities ? JSON.stringify(opts.capabilities) : null
  );
  return getAgent(validatedId);
}

/**
 * Get an agent by ID.
 */
export function getAgent(id) {
  const validatedId = assertValidAgentId(id);
  const agent = validateStoredAgent(
    getDb().prepare('SELECT * FROM agents WHERE id = ?').get(validatedId),
  );
  if (agent && agent.capabilities) {
    try { agent.capabilities = JSON.parse(agent.capabilities); } catch (e) { process.stderr.write('Warning: failed to parse capabilities JSON: ' + e.message + '\n'); }
  }
  return agent;
}

/**
 * List all agents.
 */
export function listAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY id').all().map(a => {
    validateStoredAgent(a);
    if (a.capabilities) try { a.capabilities = JSON.parse(a.capabilities); } catch (e) { process.stderr.write('Warning: failed to parse capabilities JSON: ' + e.message + '\n'); }
    return a;
  });
}

/**
 * Update agent status.
 */
export function setAgentStatus(id, status, sessionKey) {
  const validatedId = assertValidAgentId(id);
  const validatedSessionKey = sessionKey === null || sessionKey === undefined
    ? null
    : assertSessionKeyForAgent(sessionKey, validatedId);
  getDb().prepare(`
    UPDATE agents SET status = ?, session_key = ?, last_seen_at = datetime('now')
    WHERE id = ?
  `).run(status, validatedSessionKey, validatedId);
}

/**
 * Mark agent as seen (heartbeat).
 */
export function touchAgent(id) {
  const validatedId = assertValidAgentId(id);
  getDb().prepare(`
    UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?
  `).run(validatedId);
}
