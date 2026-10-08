import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');
const SESSION_KEY = 'agent:main:subagent:33333333-4444-5555-6666-777777777777';
const SESSION_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-token-estimate-'));
  const stateDir = join(root, 'state');
  const agentDir = join(stateDir, 'agents', 'main', 'agent');
  mkdirSync(agentDir, { recursive: true });
  return { root, stateDir, agentDir, databasePath: join(agentDir, 'openclaw-agent.sqlite') };
}

/**
 * Seed a "running" session whose store entry totalTokens is whatever the test
 * chooses (typically absent or 0, mirroring a long mid-turn dispatch run),
 * with a bounded transcript tail ending in an assistant message.
 */
function seedRunningSession(databasePath, { totalTokens, totalTokensFresh, totalTokensVersion, assistantUsage, storeStatus = 'running' }) {
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session_nodes (
      session_key TEXT PRIMARY KEY,
      current_session_id TEXT,
      entry_json TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      status TEXT,
      last_activity_at INTEGER,
      last_interaction_at INTEGER
    );
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY,
      updated_at INTEGER,
      created_at INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      status TEXT,
      transcript_updated_at INTEGER,
      transcript_observed_at INTEGER,
      model_provider TEXT,
      model TEXT
    );
    CREATE TABLE transcript_events (
      session_id TEXT,
      seq INTEGER,
      event_json TEXT,
      created_at INTEGER,
      PRIMARY KEY (session_id, seq)
    );
  `);
  const now = Date.now();
  const entry = { sessionId: SESSION_ID, thinkingLevel: 'low', status: 'running' };
  if (totalTokens !== undefined) entry.totalTokens = totalTokens;
  if (totalTokensFresh !== undefined) entry.totalTokensFresh = totalTokensFresh;
  if (totalTokensVersion !== undefined) entry.totalTokensVersion = totalTokensVersion;
  database.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, updated_at, created_at,
      status, last_activity_at, last_interaction_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_KEY,
    SESSION_ID,
    JSON.stringify(entry),
    now - 1000,
    now - 5000,
    storeStatus,
    now - 900,
    now - 900,
  );
  database.prepare(`
    INSERT INTO session_windows (
      session_id, updated_at, created_at, started_at, ended_at, status,
      transcript_updated_at, transcript_observed_at, model_provider, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    now - 800,
    now - 5000,
    now - 4900,
    storeStatus === 'running' ? null : now - 5,
    storeStatus,
    now,
    now - 1,
    'gpufarm',
    'qwen-test',
  );
  const insertEvent = (event, createdAt) => {
    database.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_events WHERE session_id = ?), ?, ?)
    `).run(SESSION_ID, SESSION_ID, JSON.stringify(event), createdAt);
  };
  insertEvent({
    type: 'message',
    id: 'event-user',
    timestamp: new Date(now - 4000).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Start the task' }],
      timestamp: now - 4000,
    },
  }, now - 4000);
  insertEvent({
    type: 'message',
    id: 'event-assistant',
    timestamp: new Date(now).toISOString(),
    message: {
      role: 'assistant',
      api: 'gpufarm',
      provider: 'gpufarm',
      model: 'qwen-test',
      stopReason: assistantUsage ? 'toolUse' : 'end_turn',
      ...(assistantUsage ? { usage: assistantUsage } : {}),
      content: [{ type: 'text', text: 'Working on it' }],
      timestamp: now,
    },
  }, now);
  database.close();
  return now;
}

function runStatus(fixture, label) {
  const dispatchState = join(fixture.root, 'dispatch-state');
  const configDir = join(fixture.root, 'config');
  mkdirSync(dispatchState, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
  writeFileSync(
    join(dispatchState, 'labels.json'),
    JSON.stringify({
      [label]: {
        sessionKey: SESSION_KEY,
        runId: 'run-estimate',
        agent: 'main',
        thinking: 'low',
        status: 'running',
        spawnedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    }),
  );
  const env = {
    ...process.env,
    HOME: fixture.root,
    OPENCLAW_STATE_DIR: fixture.stateDir,
    DISPATCH_CONFIG_DIR: configDir,
    DISPATCH_STATE_DIR: dispatchState,
    DISPATCH_LABELS_PATH: join(dispatchState, 'labels.json'),
    OPENCLAW_GATEWAY_TOKEN: '',
    PATH: `${fixture.root}:${process.env.PATH || ''}`,
  };
  const run = spawnSync(
    process.execPath,
    [INDEX_PATH, 'status', '--label', label],
    { encoding: 'utf8', env, timeout: 20_000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('status exposes a transcript-based tokensEstimate when the store totalTokens is absent', () => {
  const fixture = createFixture();
  try {
    seedRunningSession(fixture.databasePath, {
      totalTokens: undefined, // mid-run dispatch: bootstrap never wrote a total
      assistantUsage: { input: 1000, output: 200, cacheRead: 90000, cacheWrite: 33000, reasoningTokens: 0, totalTokens: 123456, cost: 0 },
    });
    const status = runStatus(fixture, 'estimate-present');
    assert.equal(status.status, 'running');
    assert.equal(status.liveness.tokens, null);
    assert.equal(status.liveness.tokensEstimate, 123456);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('tokensEstimate falls back to the usage part sum when the usage object has no totalTokens', () => {
  const fixture = createFixture();
  try {
    seedRunningSession(fixture.databasePath, {
      totalTokens: 0, // bootstrap-written zero must not suppress the estimate
      assistantUsage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 },
    });
    const status = runStatus(fixture, 'estimate-parts');
    assert.equal(status.status, 'running');
    assert.equal(status.liveness.tokens, null);
    assert.equal(status.liveness.tokensEstimate, 1150);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('status leaves tokens authoritative and skips the estimate when totalTokens is fresh', () => {
  const fixture = createFixture();
  try {
    seedRunningSession(fixture.databasePath, {
      totalTokens: 321,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      assistantUsage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 999, cost: 0 },
    });
    const status = runStatus(fixture, 'estimate-skipped');
    assert.equal(status.status, 'running');
    assert.equal(status.liveness.tokens, 321);
    assert.equal(status.liveness.tokensEstimate, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stale stored total (totalTokensFresh false) does not suppress the transcript estimate', () => {
  const fixture = createFixture();
  try {
    // Compaction/fork paths retain the prior positive total but mark it stale;
    // the estimate must fill the gap while tokens still reports the stale total.
    seedRunningSession(fixture.databasePath, {
      totalTokens: 321,
      totalTokensFresh: false,
      totalTokensVersion: undefined,
      assistantUsage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 999, cost: 0 },
    });
    const status = runStatus(fixture, 'estimate-stale-total');
    assert.equal(status.status, 'running');
    assert.equal(status.liveness.tokens, 321);
    assert.equal(status.liveness.tokensEstimate, 999);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('tokensEstimate is null when the tail has no assistant usage', () => {
  const fixture = createFixture();
  try {
    seedRunningSession(fixture.databasePath, {
      totalTokens: undefined,
      assistantUsage: undefined,
    });
    const status = runStatus(fixture, 'estimate-none');
    assert.equal(status.status, 'running');
    assert.equal(status.liveness.tokens, null);
    assert.equal(status.liveness.tokensEstimate, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
