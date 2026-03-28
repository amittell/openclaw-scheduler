// Task Tracker — dead-man's-switch monitoring for sub-agent teams
import { getDb } from './db.js';
import { randomUUID } from 'crypto';

// ── Helpers ─────────────────────────────────────────────────
function sqliteNow() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function parseSqliteDate(s) {
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
}

// ── Create a new tracked task group ─────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.name - Human label e.g. "v5-agent-team"
 * @param {string[]} opts.expectedAgents - Array of agent labels
 * @param {number} [opts.timeoutS=600] - Timeout in seconds
 * @param {string} [opts.createdBy='main'] - Who spawned the task group
 * @param {string} [opts.deliveryChannel] - Where to send updates
 * @param {string} [opts.deliveryTo] - Target for updates
 * @returns {{ id: string, name: string, status: string, agents: Array<{agent_label: string, status: string}> }}
 */
export function createTaskGroup({ name, expectedAgents, timeoutS = 600, createdBy = 'main', deliveryChannel, deliveryTo }) {
  if (!Array.isArray(expectedAgents) || expectedAgents.length === 0) {
    throw new Error('expectedAgents must be a non-empty array');
  }
  const db = getDb();
  const id = randomUUID();
  const now = sqliteNow();

  db.prepare(`
    INSERT INTO task_tracker (id, name, created_at, created_by, expected_agents, timeout_s, status, delivery_channel, delivery_to)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(id, name, now, createdBy, JSON.stringify(expectedAgents), timeoutS, deliveryChannel || null, deliveryTo || null);

  const insertAgent = db.prepare(`
    INSERT INTO task_tracker_agents (id, tracker_id, agent_label, status)
    VALUES (?, ?, ?, 'pending')
  `);

  const agents = [];
  for (const label of expectedAgents) {
    const agentId = randomUUID();
    insertAgent.run(agentId, id, label);
    agents.push({ agent_label: label, status: 'pending' });
  }

  return { id, name, status: 'active', created_at: now, created_by: createdBy, agents };
}

// ── Get task group by id ────────────────────────────────────
/**
 * @param {string} id
 * @returns {object|undefined}
 */
export function getTaskGroup(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM task_tracker WHERE id = ?').get(id);
}

// ── List active task groups ─────────────────────────────────
/**
 * @returns {object[]}
 */
export function listActiveTaskGroups() {
  const db = getDb();
  return db.prepare("SELECT * FROM task_tracker WHERE status = 'active' ORDER BY created_at DESC").all();
}

// ── Agent reports it started ────────────────────────────────
/**
 * @param {string} trackerId
 * @param {string} agentLabel
 * @param {string} [sessionKey] - Optional OC session key for auto-correlation
 */
export function agentStarted(trackerId, agentLabel, sessionKey) {
  const db = getDb();
  const now = sqliteNow();
  db.prepare(`
    UPDATE task_tracker_agents
    SET status = 'running', started_at = ?, last_heartbeat = ?, session_key = COALESCE(?, session_key)
    WHERE tracker_id = ? AND agent_label = ?
  `).run(now, now, sessionKey || null, trackerId, agentLabel);
}

// ── Register session key (orchestrator sets this after spawning) ──
/**
 * Link an OpenClaw session key to a tracker agent.
 * The dispatcher uses this for auto-correlation — sub-agents don't
 * need to actively heartbeat; the dispatcher detects them via sessions_list.
 * @param {string} trackerId
 * @param {string} agentLabel
 * @param {string} sessionKey  - e.g. "agent:main:subagent:abc-123"
 */
export function registerAgentSession(trackerId, agentLabel, sessionKey) {
  const db = getDb();
  const now = sqliteNow();
  db.prepare(`
    UPDATE task_tracker_agents
    SET session_key = ?, last_heartbeat = ?,
        status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
        started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END
    WHERE tracker_id = ? AND agent_label = ?
  `).run(sessionKey, now, now, trackerId, agentLabel);
}

// ── Touch heartbeat (called by auto-correlation) ────────────
/**
 * @param {string} trackerId
 * @param {string} agentLabel
 */
export function touchAgentHeartbeat(trackerId, agentLabel) {
  const db = getDb();
  const now = sqliteNow();
  db.prepare(`
    UPDATE task_tracker_agents
    SET last_heartbeat = ?,
        status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
        started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END
    WHERE tracker_id = ? AND agent_label = ?
  `).run(now, now, trackerId, agentLabel);
}

// ── Agent reports completion ────────────────────────────────
/**
 * @param {string} trackerId
 * @param {string} agentLabel
 * @param {string} [exitMessage]
 */
export function agentCompleted(trackerId, agentLabel, exitMessage) {
  const db = getDb();
  const now = sqliteNow();
  db.prepare(`
    UPDATE task_tracker_agents
    SET status = 'completed', finished_at = ?, exit_message = ?
    WHERE tracker_id = ? AND agent_label = ?
  `).run(now, exitMessage || null, trackerId, agentLabel);
}

// ── Agent reports failure ───────────────────────────────────
/**
 * @param {string} trackerId
 * @param {string} agentLabel
 * @param {string} [error]
 */
export function agentFailed(trackerId, agentLabel, error) {
  const db = getDb();
  const now = sqliteNow();
  db.prepare(`
    UPDATE task_tracker_agents
    SET status = 'failed', finished_at = ?, error = ?
    WHERE tracker_id = ? AND agent_label = ?
  `).run(now, error || null, trackerId, agentLabel);
}

// ── Check for dead agents (timeout exceeded) ────────────────
/**
 * Find agents with status IN ('pending','running') whose tracker has timed out.
 * An agent is NOT dead if it sent a heartbeat within the last 5 minutes
 * (session correlation keeps them alive).
 * @returns {Array<{tracker_id: string, agent_label: string, agent_id: string}>}
 */
export function checkDeadAgents() {
  const db = getDb();
  const now = sqliteNow();

  // Find agents in active trackers that have exceeded timeout
  // BUT: spare agents with a recent heartbeat (within 5 min) — they're still alive
  const deadAgents = db.prepare(`
    SELECT a.id as agent_id, a.tracker_id, a.agent_label, a.status as agent_status,
           t.timeout_s, t.created_at as tracker_created_at
    FROM task_tracker_agents a
    JOIN task_tracker t ON a.tracker_id = t.id
    WHERE a.status IN ('pending', 'running')
      AND t.status = 'active'
      AND (julianday(?) - julianday(t.created_at)) * 86400 >= t.timeout_s
      AND (a.last_heartbeat IS NULL
           OR (julianday(?) - julianday(a.last_heartbeat)) * 86400 > MIN(300, COALESCE(t.timeout_s, 300)))
  `).all(now, now);

  // Mark them as dead
  const markDead = db.prepare(`
    UPDATE task_tracker_agents
    SET status = 'dead', finished_at = ?, error = 'Timed out (dead-man switch)'
    WHERE id = ?
  `);

  for (const agent of deadAgents) {
    markDead.run(now, agent.agent_id);
  }

  // Check group completion for each affected tracker
  const trackerIds = [...new Set(deadAgents.map(a => a.tracker_id))];
  for (const trackerId of trackerIds) {
    checkGroupCompletion(trackerId);
  }

  return deadAgents;
}

// ── Check if all agents in a group are done ─────────────────
/**
 * If all agents are in terminal state (completed/failed/dead), mark the tracker.
 * Status = 'completed' if all succeeded, 'failed' if any failed/dead.
 * @param {string} trackerId
 * @returns {object|null} - The updated tracker, or null if not yet complete
 */
export function checkGroupCompletion(trackerId) {
  const db = getDb();
  const now = sqliteNow();

  const tracker = db.prepare('SELECT * FROM task_tracker WHERE id = ?').get(trackerId);
  if (!tracker || tracker.status !== 'active') return null;

  const agents = db.prepare('SELECT * FROM task_tracker_agents WHERE tracker_id = ?').all(trackerId);
  if (agents.length === 0) return null;

  const terminalStatuses = ['completed', 'failed', 'dead'];
  const allTerminal = agents.every(a => terminalStatuses.includes(a.status));
  if (!allTerminal) return null;

  // Determine group status
  const anyFailed = agents.some(a => a.status === 'failed' || a.status === 'dead');
  const groupStatus = anyFailed ? 'failed' : 'completed';

  // Build summary
  const summaryParts = agents.map(a => {
    const label = a.agent_label;
    if (a.status === 'completed') return `[ok] ${label}: ${a.exit_message || 'done'}`;
    if (a.status === 'failed') return `[FAILED] ${label}: ${a.error || 'failed'}`;
    if (a.status === 'dead') return `[DEAD] ${label}: timed out`;
    return `[${a.status}] ${label}`;
  });
  const summary = summaryParts.join('\n');

  db.prepare(`
    UPDATE task_tracker
    SET status = ?, completed_at = ?, summary = ?
    WHERE id = ?
  `).run(groupStatus, now, summary, trackerId);

  return { ...tracker, status: groupStatus, completed_at: now, summary };
}

// ── Get status summary for a task group ─────────────────────
/**
 * @param {string} trackerId
 * @returns {{ name: string, status: string, agents: Array<{label: string, status: string, duration: number|null, exit_message?: string, error?: string}>, elapsed: number, remaining_timeout: number }}
 */
export function getTaskGroupStatus(trackerId) {
  const db = getDb();

  const tracker = db.prepare('SELECT * FROM task_tracker WHERE id = ?').get(trackerId);
  if (!tracker) return null;

  const agents = db.prepare('SELECT * FROM task_tracker_agents WHERE tracker_id = ? ORDER BY agent_label').all(trackerId);

  const now = new Date();
  const createdAt = parseSqliteDate(tracker.created_at) || new Date();
  const elapsedS = Math.floor((now - createdAt) / 1000);
  const remainingTimeout = Math.max(0, tracker.timeout_s - elapsedS);

  const agentStatuses = agents.map(a => {
    let duration = null;
    if (a.started_at && a.finished_at) {
      const start = parseSqliteDate(a.started_at);
      const end = parseSqliteDate(a.finished_at);
      if (start && end) duration = Math.floor((end - start) / 1000);
    } else if (a.started_at) {
      const start = parseSqliteDate(a.started_at);
      if (start) duration = Math.floor((now - start) / 1000);
    }

    return {
      label: a.agent_label,
      status: a.status,
      session_key: a.session_key || undefined,
      last_heartbeat: a.last_heartbeat || undefined,
      duration,
      exit_message: a.exit_message || undefined,
      error: a.error || undefined,
    };
  });

  return {
    id: tracker.id,
    name: tracker.name,
    status: tracker.status,
    agents: agentStatuses,
    elapsed: elapsedS,
    remaining_timeout: remainingTimeout,
    summary: tracker.summary || undefined,
    delivery_channel: tracker.delivery_channel,
    delivery_to: tracker.delivery_to,
  };
}
