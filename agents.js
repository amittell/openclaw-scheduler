// Agent registry — track agent status and capabilities
import { getDb } from './db.js';

/**
 * Register or update an agent.
 */
export function upsertAgent(id, opts = {}) {
  if (!id || typeof id !== 'string') throw new Error('Agent id must be a non-empty string');
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
    id,
    opts.name || null,
    opts.status || 'idle',
    opts.session_key || null,
    opts.capabilities ? JSON.stringify(opts.capabilities) : null
  );
  return getAgent(id);
}

/**
 * Get an agent by ID.
 */
export function getAgent(id) {
  const agent = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
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
    if (a.capabilities) try { a.capabilities = JSON.parse(a.capabilities); } catch (e) { process.stderr.write('Warning: failed to parse capabilities JSON: ' + e.message + '\n'); }
    return a;
  });
}

/**
 * Update agent status.
 */
export function setAgentStatus(id, status, sessionKey) {
  getDb().prepare(`
    UPDATE agents SET status = ?, session_key = ?, last_seen_at = datetime('now')
    WHERE id = ?
  `).run(status, sessionKey || null, id);
}

/**
 * Mark agent as seen (heartbeat).
 */
export function touchAgent(id) {
  getDb().prepare(`
    UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?
  `).run(id);
}
