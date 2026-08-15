import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import Database from 'better-sqlite3';

import {
  projectOpenClawTranscriptEntries,
  readOpenClawSessionStore,
  readOpenClawTranscriptTail,
} from '../dispatch/session-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');
const WATCHER_PATH = join(REPO_DIR, 'dispatch', 'watcher.mjs');
const SCHEMA_PATH = join(REPO_DIR, 'schema.sql');
const SESSION_KEY = 'agent:main:subagent:11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-sqlite-store-'));
  const stateDir = join(root, 'state');
  const agentDir = join(stateDir, 'agents', 'main', 'agent');
  mkdirSync(agentDir, { recursive: true });
  return { root, stateDir, agentDir, databasePath: join(agentDir, 'openclaw-agent.sqlite') };
}

function initializeSchedulerDatabase(databasePath) {
  const database = new Database(databasePath);
  database.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  database.close();
}

function seedDatabase(databasePath, { status = 'running', assistantText = 'SQLite task completed.' } = {}) {
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
  database.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, updated_at, created_at,
      status, last_activity_at, last_interaction_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_KEY,
    SESSION_ID,
    JSON.stringify({ sessionId: SESSION_ID, totalTokens: 321, thinkingLevel: 'high' }),
    now - 30,
    now - 500,
    status,
    now - 20,
    now - 25,
  );
  database.prepare(`
    INSERT INTO session_windows (
      session_id, updated_at, created_at, started_at, ended_at, status,
      transcript_updated_at, transcript_observed_at, model_provider, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    now - 10,
    now - 500,
    now - 450,
    status === 'done' ? now - 5 : null,
    status,
    now,
    now - 1,
    'openai',
    'gpt-test',
  );
  database.prepare(`
    INSERT INTO transcript_events (session_id, seq, event_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    SESSION_ID,
    1,
    JSON.stringify({
      type: 'message',
      id: 'event-1',
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        stopReason: 'stop',
        timestamp: now,
      },
    }),
    now,
  );
  database.close();
  return now;
}

function writeGatewayStub(root, response) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, 'openclaw');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
    '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return binDir;
}

function writeRecordingGatewayStub(root, callsPath, { rejectModel = null } = {}) {
  const binDir = join(root, 'recording-bin');
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, 'openclaw');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    "const paramsIndex = args.indexOf('--params');",
    'const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};',
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, params }) + '\\n');`,
    `if (method === 'sessions.patch' && params.model === ${JSON.stringify(rejectModel)}) {`,
    "  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'INVALID_REQUEST', message: 'model not allowed' } }));",
    '} else if (method === "agent") {',
    "  process.stdout.write(JSON.stringify({ ok: true, runId: 'accepted-run' }));",
    '} else {',
    '  process.stdout.write(JSON.stringify({ ok: true }));',
    '}',
    '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  return binDir;
}

test('SQLite store maps live session, lifecycle, model, tokens, and transcript activity', () => {
  const fixture = createFixture();
  try {
    const now = seedDatabase(fixture.databasePath);
    const snapshot = readOpenClawSessionStore('main', {
      env: { OPENCLAW_STATE_DIR: fixture.stateDir, HOME: fixture.root },
      homeDir: fixture.root,
    });
    assert.equal(snapshot.source, 'sqlite');
    assert.equal(snapshot.entries[SESSION_KEY].sessionId, SESSION_ID);
    assert.equal(snapshot.entries[SESSION_KEY].status, 'running');
    assert.equal(snapshot.entries[SESSION_KEY].model, 'gpt-test');
    assert.equal(snapshot.entries[SESSION_KEY].modelProvider, 'openai');
    assert.equal(snapshot.entries[SESSION_KEY].totalTokens, 321);
    assert.equal(snapshot.entries[SESSION_KEY].updatedAt, now);

    const transcript = readOpenClawTranscriptTail('main', SESSION_ID, {
      env: { OPENCLAW_STATE_DIR: fixture.stateDir, HOME: fixture.root },
      homeDir: fixture.root,
      limit: 10,
    });
    assert.equal(transcript.source, 'sqlite');
    assert.equal(transcript.events.length, 1);
    assert.equal(transcript.updatedAtMs, now);
    assert.deepEqual(
      projectOpenClawTranscriptEntries(transcript.events).map((entry) => entry.role),
      ['assistant'],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('legacy sessions.json and JSONL remain a fallback when SQLite is absent', () => {
  const fixture = createFixture();
  try {
    const sessionsDir = join(fixture.stateDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: 123 } }),
    );
    writeFileSync(
      join(sessionsDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({ role: 'assistant', content: 'legacy result', stop_reason: 'end_turn' })}\n`,
    );
    const options = {
      env: { OPENCLAW_STATE_DIR: fixture.stateDir, HOME: fixture.root },
      homeDir: fixture.root,
    };
    assert.equal(readOpenClawSessionStore('main', options).source, 'legacy-json');
    assert.equal(readOpenClawTranscriptTail('main', SESSION_ID, options).source, 'legacy-jsonl');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('corrupt SQLite fails safely and uses a valid legacy fallback', () => {
  const fixture = createFixture();
  try {
    writeFileSync(fixture.databasePath, 'not-a-sqlite-database');
    const sessionsDir = join(fixture.stateDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: 123 } }),
    );
    const snapshot = readOpenClawSessionStore('main', {
      env: { OPENCLAW_STATE_DIR: fixture.stateDir, HOME: fixture.root },
      homeDir: fixture.root,
    });
    assert.equal(snapshot.source, 'legacy-json');
    assert.ok(snapshot.sqliteError instanceof Error);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing or unreadable current and legacy stores report unavailable without throwing', () => {
  const fixture = createFixture();
  try {
    const snapshot = readOpenClawSessionStore('main', {
      env: { OPENCLAW_STATE_DIR: fixture.stateDir, HOME: fixture.root },
      homeDir: fixture.root,
    });
    assert.equal(snapshot.source, 'unavailable');
    assert.equal(snapshot.entries, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('status/result recover a false spawn failure from SQLite despite gateway visibility denial', () => {
  const fixture = createFixture();
  try {
    seedDatabase(fixture.databasePath, { status: 'done', assistantText: 'Recovered SQLite result.' });
    const dispatchState = join(fixture.root, 'dispatch-state');
    const labelsPath = join(dispatchState, 'labels.json');
    const configDir = join(fixture.root, 'config');
    mkdirSync(dispatchState, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
    writeFileSync(labelsPath, JSON.stringify({
      'sqlite-recovery': {
        sessionKey: SESSION_KEY,
        runId: 'run-recovery',
        agent: 'main',
        status: 'error',
        error: 'spawn-failure: never produced transcript/history within 30s',
        summary: 'spawn-failure: never produced transcript/history within 30s',
        spawnedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
      },
    }));
    const binDir = writeGatewayStub(fixture.root, {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'session hidden by visibility policy' },
    });
    const env = {
      ...process.env,
      HOME: fixture.root,
      OPENCLAW_STATE_DIR: fixture.stateDir,
      DISPATCH_CONFIG_DIR: configDir,
      DISPATCH_STATE_DIR: dispatchState,
      DISPATCH_LABELS_PATH: labelsPath,
      OPENCLAW_GATEWAY_TOKEN: '',
      PATH: `${binDir}:${process.env.PATH || ''}`,
    };

    const statusRun = spawnSync(
      process.execPath,
      [INDEX_PATH, 'status', '--label', 'sqlite-recovery'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assert.equal(statusRun.status, 0, statusRun.stderr || statusRun.stdout);
    const status = JSON.parse(statusRun.stdout);
    assert.equal(status.status, 'done');
    assert.equal(status.error, null);
    assert.match(status.syncAction, /recovered false spawn failure/);

    const resultRun = spawnSync(
      process.execPath,
      [INDEX_PATH, 'result', '--label', 'sqlite-recovery'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assert.equal(resultRun.status, 0, resultRun.stderr || resultRun.stdout);
    const result = JSON.parse(resultRun.stdout);
    assert.equal(result.lastReply, 'Recovered SQLite result.');
    assert.equal(result.recovery.source, 'sqlite-done');
    assert.equal(JSON.parse(readFileSync(labelsPath, 'utf8'))['sqlite-recovery']?.error, null);

    const heartbeatRun = spawnSync(
      process.execPath,
      [INDEX_PATH, 'heartbeat', '--label', 'sqlite-recovery'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assert.equal(heartbeatRun.status, 0, heartbeatRun.stderr || heartbeatRun.stdout);
    const heartbeat = JSON.parse(heartbeatRun.stdout);
    assert.equal(heartbeat.status, 'done');
    assert.equal(heartbeat.alive, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('watcher recovers a false spawn failure from SQLite and suppresses duplicate completion', () => {
  const fixture = createFixture();
  try {
    seedDatabase(fixture.databasePath, { status: 'done', assistantText: 'Watcher SQLite result.' });
    const dispatchState = join(fixture.root, 'dispatch-state');
    const labelsPath = join(dispatchState, 'labels.json');
    const configDir = join(fixture.root, 'config');
    const schedulerDatabasePath = join(fixture.root, 'scheduler.db');
    mkdirSync(dispatchState, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    initializeSchedulerDatabase(schedulerDatabasePath);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
    writeFileSync(labelsPath, JSON.stringify({
      'sqlite-watcher-recovery': {
        sessionKey: SESSION_KEY,
        runId: 'run-watcher-recovery',
        agent: 'main',
        status: 'error',
        error: 'spawn-failure: never produced transcript/history within 30s',
        summary: 'spawn-failure: never produced transcript/history within 30s',
        spawnedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
        deliveryMode: 'none',
      },
    }));
    const binDir = writeGatewayStub(fixture.root, {
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'session hidden by visibility policy' },
    });
    const env = {
      ...process.env,
      HOME: fixture.root,
      OPENCLAW_STATE_DIR: fixture.stateDir,
      DISPATCH_CONFIG_DIR: configDir,
      DISPATCH_STATE_DIR: dispatchState,
      DISPATCH_LABELS_PATH: labelsPath,
      DISPATCH_INDEX_PATH: INDEX_PATH,
      SCHEDULER_DB: schedulerDatabasePath,
      OPENCLAW_GATEWAY_TOKEN: '',
      OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      PATH: `${binDir}:${process.env.PATH || ''}`,
    };

    const first = spawnSync(
      process.execPath,
      [WATCHER_PATH, '--label', 'sqlite-watcher-recovery', '--once'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /Watcher SQLite result\./);
    const recovered = JSON.parse(readFileSync(labelsPath, 'utf8'))['sqlite-watcher-recovery'];
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.error, null);
    assert.ok(recovered.completionDeliveredAt);

    const duplicate = spawnSync(
      process.execPath,
      [WATCHER_PATH, '--label', 'sqlite-watcher-recovery', '--once'],
      { encoding: 'utf8', env, timeout: 15_000 },
    );
    assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
    assert.equal(duplicate.stdout, '');
    assert.match(duplicate.stderr, /WATCHER_ALREADY_DELIVERED/);

    const deliveryDebts = new Database(schedulerDatabasePath, { readonly: true });
    try {
      assert.equal(
        deliveryDebts.prepare(
          "SELECT COUNT(*) AS count FROM completion_debts WHERE task_label = 'sqlite-watcher-recovery'",
        ).get().count,
        1,
      );
    } finally {
      deliveryDebts.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('accepted agent call with delayed persistence stays running and never sends spawnDepth', () => {
  const fixture = createFixture();
  try {
    const dispatchState = join(fixture.root, 'dispatch-state');
    const labelsPath = join(dispatchState, 'labels.json');
    const configDir = join(fixture.root, 'config');
    const callsPath = join(fixture.root, 'calls.jsonl');
    mkdirSync(dispatchState, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(labelsPath, '{}\n');
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ name: 'test-dispatch', spawnPollMax: 1, spawnPollDelayMs: 1 }),
    );
    writeFileSync(join(fixture.stateDir, 'openclaw.json'), '{}\n');
    const binDir = writeRecordingGatewayStub(fixture.root, callsPath);
    const run = spawnSync(
      process.execPath,
      [
        INDEX_PATH,
        'enqueue',
        '--label',
        'delayed-persistence',
        '--message',
        'Run a harmless smoke task.',
        '--origin',
        'system',
        '--delivery-mode',
        'none',
        '--no-monitor',
        'test fixture has no delivery route',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          HOME: fixture.root,
          OPENCLAW_STATE_DIR: fixture.stateDir,
          DISPATCH_CONFIG_DIR: configDir,
          DISPATCH_STATE_DIR: dispatchState,
          DISPATCH_LABELS_PATH: labelsPath,
          DISPATCH_DEFAULT_MODEL: '',
          OPENCLAW_GATEWAY_TOKEN: '',
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const response = JSON.parse(run.stdout);
    assert.equal(response.status, 'accepted');
    const label = JSON.parse(readFileSync(labelsPath, 'utf8'))['delayed-persistence'];
    assert.equal(label.status, 'running');
    assert.equal(label.error, null);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.some((call) => call.params?.spawnDepth !== undefined), false);
    assert.deepEqual(calls.map((call) => call.method), ['agent']);

    // Even after the startup grace period, an empty canonical store plus an
    // empty/visibility-filtered sessions.list response is not terminal proof.
    seedDatabase(fixture.databasePath);
    const database = new Database(fixture.databasePath);
    database.exec('DELETE FROM transcript_events; DELETE FROM session_windows; DELETE FROM session_nodes;');
    database.close();
    const agedLabels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    agedLabels['delayed-persistence'].spawnedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(labelsPath, `${JSON.stringify(agedLabels)}\n`);

    const statusRun = spawnSync(
      process.execPath,
      [INDEX_PATH, 'status', '--label', 'delayed-persistence'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          HOME: fixture.root,
          OPENCLAW_STATE_DIR: fixture.stateDir,
          DISPATCH_CONFIG_DIR: configDir,
          DISPATCH_STATE_DIR: dispatchState,
          DISPATCH_LABELS_PATH: labelsPath,
          OPENCLAW_GATEWAY_TOKEN: '',
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      },
    );
    assert.equal(statusRun.status, 0, statusRun.stderr || statusRun.stdout);
    assert.equal(JSON.parse(statusRun.stdout).status, 'running');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an explicitly disallowed model patch fails enqueue instead of silently falling back', () => {
  const fixture = createFixture();
  try {
    const dispatchState = join(fixture.root, 'dispatch-state');
    const labelsPath = join(dispatchState, 'labels.json');
    const configDir = join(fixture.root, 'config');
    const callsPath = join(fixture.root, 'calls.jsonl');
    mkdirSync(dispatchState, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(labelsPath, '{}\n');
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
    writeFileSync(join(fixture.stateDir, 'openclaw.json'), '{}\n');
    const binDir = writeRecordingGatewayStub(fixture.root, callsPath, {
      rejectModel: 'disallowed/model',
    });
    const run = spawnSync(
      process.execPath,
      [
        INDEX_PATH,
        'enqueue',
        '--label',
        'bad-model',
        '--message',
        'This must not dispatch.',
        '--origin',
        'system',
        '--model',
        'disallowed/model',
        '--delivery-mode',
        'none',
        '--no-monitor',
        'test fixture has no delivery route',
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          HOME: fixture.root,
          OPENCLAW_STATE_DIR: fixture.stateDir,
          DISPATCH_CONFIG_DIR: configDir,
          DISPATCH_STATE_DIR: dispatchState,
          DISPATCH_LABELS_PATH: labelsPath,
          OPENCLAW_GATEWAY_TOKEN: '',
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /model not allowed/);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map((call) => call.method), ['sessions.patch']);
    assert.deepEqual(JSON.parse(readFileSync(labelsPath, 'utf8')), {});
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
