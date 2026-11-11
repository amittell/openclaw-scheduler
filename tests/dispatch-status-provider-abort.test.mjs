import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');
const SESSION_KEY = 'agent:main:subagent:ab0rt001-4444-5555-6666-777777777777';
const SESSION_ID = 'ab0rt001-4444-5555-6666-777777777777';

/**
 * Regression coverage for the Codex P2 review on PR #84:
 *
 * The provider-abort signature (assistant stopReason="aborted" /
 * openclaw:prompt-error "This operation was aborted") was only recognized in
 * dispatch/watcher.mjs. dispatch/index.mjs kept a separate, older
 * entryHasTurnAborted, so a direct `status` poll could keep reporting a
 * provider-aborted session as running until the watcher reached its idle
 * probe or another timeout-based resolution occurred.
 *
 * The detector now lives in dispatch/turn-abort.mjs and is shared by both
 * paths. These tests drive the REAL index.mjs status command end-to-end
 * against a seeded SQLite session store:
 *
 * (1) transcript tail with the provider-abort signature -> status
 *     auto-resolves the label as interrupted immediately (syncAction set).
 * (2) transcript tail with a clean end_turn reply -> status stays running
 *     (no false abort classification).
 */

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `dispatch-status-provider-abort-${name}-`));
  const stateDir = join(root, 'state');
  const agentDir = join(stateDir, 'agents', 'main', 'agent');
  const dispatchState = join(root, 'dispatch-state');
  const configDir = join(root, 'config');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dispatchState, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
  return {
    root,
    stateDir,
    dispatchState,
    configDir,
    labelsPath: join(dispatchState, 'labels.json'),
    databasePath: join(agentDir, 'openclaw-agent.sqlite'),
  };
}

function seedStore(fixture, events) {
  const database = new Database(fixture.databasePath);
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
  database.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, updated_at, created_at,
      status, last_activity_at, last_interaction_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_KEY,
    SESSION_ID,
    JSON.stringify({ sessionId: SESSION_ID, thinkingLevel: 'low', status: 'running' }),
    now - 1000,
    now - 5000,
    'running',
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
    null,
    'running',
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
  events.forEach((event, index) => insertEvent(event, now - 4000 + index * 100));
  database.close();
  return now;
}

function writeLabels(fixture, label, now) {
  writeFileSync(
    fixture.labelsPath,
    JSON.stringify({
      [label]: {
        sessionKey: SESSION_KEY,
        agent: 'main',
        thinking: 'low',
        status: 'running',
        spawnedAt: new Date(now - 60_000).toISOString(),
        updatedAt: new Date(now - 60_000).toISOString(),
        lastPing: new Date(now - 10_000).toISOString(),
      },
    }),
  );
}

function runStatus(fixture, label) {
  const env = {
    ...process.env,
    HOME: fixture.root,
    OPENCLAW_STATE_DIR: fixture.stateDir,
    DISPATCH_CONFIG_DIR: fixture.configDir,
    DISPATCH_STATE_DIR: fixture.dispatchState,
    DISPATCH_LABELS_PATH: fixture.labelsPath,
    OPENCLAW_GATEWAY_TOKEN: '',
    PATH: `${fixture.root}:${process.env.PATH || ''}`,
  };
  const run = spawnSync(
    process.execPath,
    [INDEX_PATH, 'status', '--label', label],
    { encoding: 'utf8', env, timeout: 20_000 },
  );
  assert.equal(run.status, 0, `status must exit 0; stderr=${run.stderr} stdout=${run.stdout}`);
  return JSON.parse(run.stdout);
}

test('(1) status auto-resolves a provider-aborted session as interrupted immediately', () => {
  const fixture = createFixture('abort');
  try {
    const now = seedStore(fixture, [
      {
        type: 'message',
        id: 'event-user',
        timestamp: new Date(Date.now() - 4000).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'do the thing' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-artifact',
          output: 'Wrote song_manifest.json (3058 bytes)',
        },
      },
      {
        type: 'message',
        id: 'event-assistant-abort',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
        },
      },
      {
        type: 'custom',
        id: 'event-prompt-error',
        timestamp: new Date(Date.now() - 900).toISOString(),
        customType: 'openclaw:prompt-error',
        data: { error: 'This operation was aborted' },
      },
    ]);
    writeLabels(fixture, 'provider-abort-x', now);

    const status = runStatus(fixture, 'provider-abort-x');
    assert.equal(status.status, 'interrupted', 'provider-abort signature must resolve the label as interrupted on a direct status poll');
    assert.match(status.syncAction || '', /auto-resolved as interrupted/, 'syncAction must name the auto-resolution');
    assert.match(status.summary || '', /turn_aborted observed/, 'summary must carry the abort reason');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(2) status keeps a clean end_turn session running (no false abort)', () => {
  const fixture = createFixture('clean');
  try {
    const now = seedStore(fixture, [
      {
        type: 'message',
        id: 'event-user',
        timestamp: new Date(Date.now() - 4000).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'do the thing' }],
        },
      },
      {
        type: 'message',
        id: 'event-assistant-done',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'All done. The file was written and verified.' }],
          stopReason: 'end_turn',
          usage: { input: 100, output: 50, totalTokens: 150, cost: 0 },
        },
      },
    ]);
    writeLabels(fixture, 'provider-abort-clean', now);

    const status = runStatus(fixture, 'provider-abort-clean');
    assert.equal(status.status, 'running', 'a non-aborted session must NOT be classified as interrupted by status');
    assert.equal(status.syncAction, undefined, 'no auto-resolution action expected');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
