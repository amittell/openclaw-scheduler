import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  assertContainedPath,
  assertValidAgentId,
  assertValidSessionId,
  assertValidSessionKey,
  assertValidSessionStore,
} from '../identifiers.js';

const SQLITE_FILE = 'openclaw-agent.sqlite';

function normalizeHomeDir(homeDir, env) {
  return homeDir || env.HOME || homedir();
}

function resolveHomeRelativePath(value, homeDir) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
  return pathResolve(trimmed);
}

export function resolveOpenClawStateDir({ env = process.env, homeDir } = {}) {
  const effectiveHome = normalizeHomeDir(homeDir, env);
  return resolveHomeRelativePath(env.OPENCLAW_STATE_DIR, effectiveHome)
    || join(effectiveHome, '.openclaw');
}

export function resolveAgentSessionStorePaths(agentId = 'main', options = {}) {
  const validatedAgentId = assertValidAgentId(agentId, 'agent_id');
  const stateDir = resolveOpenClawStateDir(options);
  const agentsRoot = pathResolve(stateDir, 'agents');
  const agentRoot = assertContainedPath(
    agentsRoot,
    pathResolve(agentsRoot, validatedAgentId),
    'OpenClaw agent state directory',
  );
  const databasePath = assertContainedPath(
    agentRoot,
    pathResolve(agentRoot, 'agent', SQLITE_FILE),
    'OpenClaw agent database path',
  );
  const legacySessionsPath = assertContainedPath(
    agentRoot,
    pathResolve(agentRoot, 'sessions', 'sessions.json'),
    'legacy OpenClaw sessions store path',
  );
  const legacyTranscriptDir = assertContainedPath(
    agentRoot,
    pathResolve(agentRoot, 'sessions'),
    'legacy OpenClaw transcript directory',
  );
  return { agentRoot, databasePath, legacySessionsPath, legacyTranscriptDir, stateDir };
}

function openReadOnlyDatabase(databasePath) {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
    timeout: 500,
  });
  database.pragma('query_only = ON');
  return database;
}

function hasTable(database, tableName) {
  return Boolean(
    database.prepare(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    ).get(tableName),
  );
}

function tableColumns(database, tableName) {
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function selectColumn(alias, columns, name, outputName) {
  return columns.has(name)
    ? `${alias}."${name}" AS "${outputName}"`
    : `NULL AS "${outputName}"`;
}

function finiteTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) return parsedNumber;
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return null;
}

function newestTimestamp(...values) {
  const timestamps = values.map(finiteTimestamp).filter((value) => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function parseEntryJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Promoted columns remain useful during entry repair/migration windows.
    return {};
  }
}

function readSqliteSessionStore(databasePath) {
  if (!existsSync(databasePath)) return null;

  let database;
  try {
    database = openReadOnlyDatabase(databasePath);
    if (!hasTable(database, 'session_nodes')) return null;

    const nodeColumns = tableColumns(database, 'session_nodes');
    if (!nodeColumns.has('session_key')) return null;
    const hasWindows = hasTable(database, 'session_windows');
    const windowColumns = hasWindows ? tableColumns(database, 'session_windows') : new Set();
    const canJoinWindow = hasWindows
      && nodeColumns.has('current_session_id')
      && windowColumns.has('session_id');

    const columns = [
      selectColumn('n', nodeColumns, 'session_key', 'session_key'),
      selectColumn('n', nodeColumns, 'current_session_id', 'current_session_id'),
      selectColumn('n', nodeColumns, 'entry_json', 'entry_json'),
      selectColumn('n', nodeColumns, 'updated_at', 'node_updated_at'),
      selectColumn('n', nodeColumns, 'created_at', 'node_created_at'),
      selectColumn('n', nodeColumns, 'status', 'node_status'),
      selectColumn('n', nodeColumns, 'last_activity_at', 'node_last_activity_at'),
      selectColumn('n', nodeColumns, 'last_interaction_at', 'node_last_interaction_at'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'updated_at', 'window_updated_at'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'created_at', 'window_created_at'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'started_at', 'window_started_at'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'ended_at', 'window_ended_at'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'status', 'window_status'),
      selectColumn(
        'w',
        canJoinWindow ? windowColumns : new Set(),
        'transcript_updated_at',
        'transcript_updated_at',
      ),
      selectColumn(
        'w',
        canJoinWindow ? windowColumns : new Set(),
        'transcript_observed_at',
        'transcript_observed_at',
      ),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'model_provider', 'model_provider'),
      selectColumn('w', canJoinWindow ? windowColumns : new Set(), 'model', 'window_model'),
    ];
    const joinClause = canJoinWindow
      ? 'LEFT JOIN session_windows AS w ON w.session_id = n.current_session_id'
      : '';
    const rows = database.prepare(
      `SELECT ${columns.join(', ')} FROM session_nodes AS n ${joinClause}`,
    ).all();

    const entries = Object.create(null);
    for (const row of rows) {
      let sessionKey;
      try {
        sessionKey = assertValidSessionKey(row.session_key, 'SQLite session key');
      } catch {
        continue;
      }

      const entry = { ...parseEntryJson(row.entry_json) };
      const promotedSessionId = row.current_session_id || entry.sessionId || null;
      if (promotedSessionId) {
        try {
          entry.sessionId = assertValidSessionId(promotedSessionId, 'SQLite current session id');
        } catch {
          continue;
        }
      }

      const updatedAt = newestTimestamp(
        entry.updatedAt,
        row.node_updated_at,
        row.window_updated_at,
        row.transcript_updated_at,
        row.transcript_observed_at,
      );
      if (updatedAt !== null) entry.updatedAt = updatedAt;

      const startedAt = newestTimestamp(
        entry.sessionStartedAt,
        entry.startedAt,
        row.window_started_at,
        row.window_created_at,
        row.node_created_at,
      );
      if (startedAt !== null) {
        entry.sessionStartedAt = finiteTimestamp(entry.sessionStartedAt) ?? startedAt;
        entry.startedAt = finiteTimestamp(entry.startedAt) ?? startedAt;
      }

      const lastActivityAt = newestTimestamp(entry.lastActivityAt, row.node_last_activity_at);
      if (lastActivityAt !== null) entry.lastActivityAt = lastActivityAt;
      const lastInteractionAt = newestTimestamp(
        entry.lastInteractionAt,
        row.node_last_interaction_at,
      );
      if (lastInteractionAt !== null) entry.lastInteractionAt = lastInteractionAt;
      const transcriptUpdatedAt = newestTimestamp(
        row.transcript_updated_at,
        row.transcript_observed_at,
      );
      if (transcriptUpdatedAt !== null) entry.transcriptUpdatedAt = transcriptUpdatedAt;
      const endedAt = finiteTimestamp(row.window_ended_at);
      if (endedAt !== null) entry.endedAt = endedAt;

      const status = row.window_status || row.node_status || entry.status;
      if (typeof status === 'string' && status.trim()) entry.status = status.trim().toLowerCase();
      if (!entry.model && row.window_model) entry.model = row.window_model;
      if (!entry.modelProvider && row.model_provider) entry.modelProvider = row.model_provider;

      entries[sessionKey] = entry;
    }

    return { entries, path: databasePath, source: 'sqlite' };
  } catch (error) {
    return { entries: null, error, path: databasePath, source: 'sqlite' };
  } finally {
    try { database?.close(); } catch {}
  }
}

function readLegacySessionStore(legacySessionsPath) {
  try {
    const entries = assertValidSessionStore(
      JSON.parse(readFileSync(legacySessionsPath, 'utf8')),
      'legacy OpenClaw sessions store',
    );
    return { entries, path: legacySessionsPath, source: 'legacy-json' };
  } catch (error) {
    return { entries: null, error, path: legacySessionsPath, source: 'legacy-json' };
  }
}

/**
 * Read the current OpenClaw session store without mutating it.
 * SQLite is authoritative when its session table is readable; sessions.json is
 * retained only as an older-OpenClaw fallback.
 */
export function readOpenClawSessionStore(agentId = 'main', options = {}) {
  const paths = resolveAgentSessionStorePaths(agentId, options);
  const sqlite = readSqliteSessionStore(paths.databasePath);
  if (sqlite?.entries) return sqlite;

  const legacy = readLegacySessionStore(paths.legacySessionsPath);
  if (legacy.entries) {
    return {
      ...legacy,
      ...(sqlite?.error ? { sqliteError: sqlite.error } : {}),
    };
  }
  return {
    entries: null,
    error: sqlite?.error || legacy.error || null,
    path: sqlite?.path || legacy.path,
    source: 'unavailable',
  };
}

function readSqliteTranscript(databasePath, sessionId, limit) {
  if (!existsSync(databasePath)) return null;
  let database;
  try {
    database = openReadOnlyDatabase(databasePath);
    if (!hasTable(database, 'transcript_events')) return null;
    const transcriptColumns = tableColumns(database, 'transcript_events');
    if (!['session_id', 'event_json', 'seq'].every((name) => transcriptColumns.has(name))) {
      return null;
    }

    const rows = database.prepare(
      `SELECT event_json, ${transcriptColumns.has('created_at') ? 'created_at' : 'NULL AS created_at'}
       FROM transcript_events
       WHERE session_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(sessionId, limit).reverse();
    const events = [];
    let updatedAtMs = null;
    for (const row of rows) {
      updatedAtMs = newestTimestamp(updatedAtMs, row.created_at);
      try {
        const event = JSON.parse(row.event_json);
        if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      } catch {
        // A malformed event does not make the remaining transcript unreadable.
      }
    }

    if (hasTable(database, 'session_windows')) {
      const windowColumns = tableColumns(database, 'session_windows');
      if (windowColumns.has('session_id')) {
        const freshnessColumns = [
          'updated_at',
          'transcript_updated_at',
          'transcript_observed_at',
          'ended_at',
        ].filter((name) => windowColumns.has(name));
        if (freshnessColumns.length) {
          const row = database.prepare(
            `SELECT ${freshnessColumns.join(', ')} FROM session_windows WHERE session_id = ? LIMIT 1`,
          ).get(sessionId);
          if (row) updatedAtMs = newestTimestamp(updatedAtMs, ...Object.values(row));
        }
      }
    }

    return { events, path: databasePath, source: 'sqlite', updatedAtMs };
  } catch (error) {
    return { events: null, error, path: databasePath, source: 'sqlite', updatedAtMs: null };
  } finally {
    try { database?.close(); } catch {}
  }
}

function readLegacyTranscript(legacyTranscriptDir, sessionId, limit) {
  const transcriptPath = assertContainedPath(
    legacyTranscriptDir,
    pathResolve(legacyTranscriptDir, `${sessionId}.jsonl`),
    'legacy OpenClaw transcript path',
  );
  try {
    const events = readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return {
      events,
      path: transcriptPath,
      source: 'legacy-jsonl',
      updatedAtMs: statSync(transcriptPath).mtimeMs,
    };
  } catch (error) {
    return { events: null, error, path: transcriptPath, source: 'legacy-jsonl', updatedAtMs: null };
  }
}

/** Read a bounded transcript tail from SQLite, with JSONL fallback for older OpenClaw. */
export function readOpenClawTranscriptTail(agentId, sessionId, options = {}) {
  const validatedAgentId = assertValidAgentId(agentId || 'main', 'agent_id');
  const validatedSessionId = assertValidSessionId(sessionId, 'session_id');
  const requestedLimit = Number.parseInt(String(options.limit ?? 200), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(5000, Math.max(1, requestedLimit))
    : 200;
  const paths = resolveAgentSessionStorePaths(validatedAgentId, options);
  const sqlite = readSqliteTranscript(paths.databasePath, validatedSessionId, limit);
  if (sqlite?.events) return sqlite;

  const legacy = readLegacyTranscript(paths.legacyTranscriptDir, validatedSessionId, limit);
  if (legacy.events) {
    return {
      ...legacy,
      ...(sqlite?.error ? { sqliteError: sqlite.error } : {}),
    };
  }
  return {
    events: null,
    error: sqlite?.error || legacy.error || null,
    path: sqlite?.path || legacy.path,
    source: 'unavailable',
    updatedAtMs: null,
  };
}

/**
 * Project OpenClaw transcript event envelopes to the message-shaped entries
 * consumed by the dispatch completion/liveness helpers. Legacy JSONL rows that
 * are already message-shaped pass through unchanged.
 */
export function projectOpenClawTranscriptEntries(events) {
  if (!Array.isArray(events)) return null;
  return events.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
    const nestedMessage = event.message
      || (event.payload && typeof event.payload === 'object' ? event.payload.message : null);
    if (!nestedMessage || typeof nestedMessage !== 'object' || Array.isArray(nestedMessage)) {
      return event;
    }
    return {
      ...nestedMessage,
      eventId: event.id || null,
      parentId: event.parentId || null,
      timestamp: nestedMessage.timestamp ?? event.timestamp ?? null,
      transcriptEventType: event.type || null,
    };
  });
}
