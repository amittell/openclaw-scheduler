import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { withLabelsLock } from '../dispatch/label-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');
const WATCHER_PATH = join(REPO_DIR, 'dispatch', 'watcher.mjs');

/**
 * Regression coverage for the 2026-09-02 false-terminal-incident:
 *
 * (A) A watcher tick that sees a missing/unrecognized label status must NOT
 *     mark the label error with "terminal failure (unknown)" — that is exactly
 *     what killed the pr-review-sweep lane's delivery while the session was
 *     healthy.
 * (B) Concurrent label mutations (enqueue CLI / watcher / status CLI) must not
 *     drop each other's fields. The labels lock is the serialization fix.
 * (C) The status CLI must not auto-resolve a session store status=done into a
 *     task "done" without a terminal reply — that produced the #728 finisher
 *     false "done" (0 commits, no push).
 */

function runChild(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-false-terminal-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const labelsPath = join(stateDir, 'labels.json');
  writeFileSync(labelsPath, '{}\n');
  return { root, stateDir, labelsPath };
}

test('(A) watcher: missing status field never becomes terminal failure (unknown)', () => {
  const { root, stateDir, labelsPath } = makeFixture();
  try {
    // Label is present and running.
    writeFileSync(labelsPath, JSON.stringify({
      'sweep-x': {
        status: 'running',
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        spawnedAt: new Date(Date.now() - 60_000).toISOString(),
        timeoutSeconds: 3600,
        thinking: 'high',
      },
    }, null, 2));

    // Stub the index so `status` returns ok but NO status field (the
    // transient/mid-write read the incident exhibited).
    const stubDir = join(root, 'stub');
    mkdirSync(stubDir);
    const stubPath = join(stubDir, 'index-stub.mjs');
    writeFileSync(stubPath, `
      const out = process.argv.includes('status')
        ? JSON.stringify({ ok: true, label: 'sweep-x' })
        : JSON.stringify({ ok: true });
      process.stdout.write(out + '\\n');
      process.exit(0);
    `);

    const result = runChild([
      WATCHER_PATH,
      '--label', 'sweep-x',
      '--timeout', '3600',
      '--poll-interval', '20',
      '--once',
    ], {
      DISPATCH_STATE_DIR: stateDir,
      DISPATCH_LABELS_PATH: labelsPath,
      DISPATCH_INDEX_PATH: stubPath,
    });

    const after = JSON.parse(readFileSync(labelsPath, 'utf8'))['sweep-x'];
    assert.notEqual(after.status, 'error',
      `watcher must not mark error on missing status; got: ${JSON.stringify(after)} stderr=${result.stderr}`);
    assert.match(result.stderr, /WATCHER_PENDING/, 'watcher should emit WATCHER_PENDING and retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(A2) watcher: found=false label also stays pending, not terminal', () => {
  const { root, stateDir, labelsPath } = makeFixture();
  try {
    writeFileSync(labelsPath, JSON.stringify({
      'sweep-y': { status: 'running', spawnedAt: new Date().toISOString(), timeoutSeconds: 3600 },
    }, null, 2));

    const stubDir = join(root, 'stub2');
    mkdirSync(stubDir);
    const stubPath = join(stubDir, 'index-stub.mjs');
    writeFileSync(stubPath, `
      process.stdout.write(JSON.stringify({ ok: true, label: 'sweep-y', found: false }) + '\\n');
      process.exit(0);
    `);

    const result = runChild([
      WATCHER_PATH,
      '--label', 'sweep-y',
      '--timeout', '3600',
      '--poll-interval', '20',
      '--once',
    ], {
      DISPATCH_STATE_DIR: stateDir,
      DISPATCH_LABELS_PATH: labelsPath,
      DISPATCH_INDEX_PATH: stubPath,
    });

    const after = JSON.parse(readFileSync(labelsPath, 'utf8'))['sweep-y'];
    assert.notEqual(after.status, 'error',
      `found=false must not mark error; got: ${JSON.stringify(after)} stderr=${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(B) labels lock: genuinely concurrent workers never lose increments', async () => {
  const { root, labelsPath } = makeFixture();
  const workers = [];
  try {
    writeFileSync(labelsPath, JSON.stringify({ a: { v: 0 } }, null, 2));

    // 4 real OS processes hammer the same label concurrently. Async spawn()
    // (NOT spawnSync) means all four run at the same time — a broken lock lets
    // two of them interleave their read-modify-write windows and lose updates,
    // so final v < 800 or the file tears. The lock must keep v exact.
    const WORKER_SCRIPT = `
      import { withLabelsLock } from ${JSON.stringify(join(REPO_DIR, 'dispatch', 'label-lock.mjs'))};
      import { readFileSync, writeFileSync, renameSync } from 'node:fs';
      const labelsPath = process.argv[2];
      const iterations = Number(process.argv[3]);
      for (let i = 0; i < iterations; i++) {
        withLabelsLock(labelsPath, () => {
          const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
          labels.a = { ...(labels.a || {}), v: (labels.a?.v || 0) + 1, field: 'writer' };
          const tmp = labelsPath + '.tmp.' + process.pid;
          writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\\n');
          renameSync(tmp, labelsPath);
        });
      }
      process.stdout.write('done ' + iterations + '\\n');
    `;
    const scriptPath = join(root, 'worker.mjs');
    writeFileSync(scriptPath, WORKER_SCRIPT);

    for (let w = 0; w < 4; w++) {
      const child = spawn(process.execPath, [scriptPath, labelsPath, '200'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      workers.push(child);
    }

    const finished = await Promise.all(workers.map((child) => new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => resolve({ status: 1, stdout, stderr: stderr + ' worker timed out' }), 120_000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    })));

    assert(finished.every((f) => f.status === 0), `worker failed: ${finished.map((f) => f.stderr || f.stdout || 'status ' + f.status).join(' | ')}`);

    const final = JSON.parse(readFileSync(labelsPath, 'utf8')).a;
    assert.equal(final.v, 800, `lock must serialize all concurrent increments; got ${JSON.stringify(final)}`);
    assert.equal(final.field, 'writer');
    assert.equal(existsSync(labelsPath + '.lock.sqlite3'), true, 'mutex file remains after release');
    assert.equal(withLabelsLock(labelsPath, () => 'reacquired', { timeoutMs: 200 }), 'reacquired',
      'ownership must be released after all workers finish');
  } finally {
    for (const child of workers) { try { child.kill('SIGKILL'); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
});

test('(C) status CLI: session done without terminal reply is NOT task done', () => {
  const { root, stateDir, labelsPath } = makeFixture();
  try {
    // Seed an OpenClaw agent SQLite store with a session whose store status is
    // 'done' but whose transcript has NO end_turn terminal reply (the #728
    // finisher shape: session ended silently mid-task).
    const agentDir = join(stateDir, 'agents', 'main', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const dbPath = join(agentDir, 'openclaw-agent.sqlite');
    const db = new Database(dbPath);
    db.exec(`
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
    const SESSION_KEY = 'agent:main:subagent:22222222-3333-4444-5555-666666666666';
    const SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    db.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at, created_at, status, last_activity_at, last_interaction_at)
      VALUES (?, ?, ?, ?, ?, 'done', ?, ?)`).run(
      SESSION_KEY, SESSION_ID, JSON.stringify({ sessionId: SESSION_ID }),
      now - 3_600_000, now - 3_700_000, now - 3_600_000, now - 3_600_000,
    );
    db.prepare(`INSERT INTO session_windows
      (session_id, updated_at, created_at, started_at, ended_at, status, transcript_updated_at, transcript_observed_at, model_provider, model)
      VALUES (?, ?, ?, ?, ?, 'done', ?, ?, 'openai', 'gpt-test')`).run(
      SESSION_ID, now - 3_600_000, now - 3_700_000, now - 3_650_000, now - 3_600_000,
      now - 3_600_000, now - 3_600_000,
    );
    // One tool_result, NO terminal assistant end_turn reply.
    db.prepare(`INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 1, ?, ?)`).run(
      SESSION_ID,
      JSON.stringify({ type: 'toolResult', role: 'toolResult', isError: false, timestamp: new Date(now - 3_600_000).toISOString() }),
      now - 3_600_000,
    );
    db.close();

    // A label that references the session, running, old enough to trigger the
    // idle auto-resolve (no lastPing).
    writeFileSync(labelsPath, JSON.stringify({
      'fin-1': {
        status: 'running',
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        spawnedAt: new Date(now - 3_700_000).toISOString(),
        timeoutSeconds: 1800,
        thinking: 'high',
      },
    }, null, 2));

    const result = runChild([INDEX_PATH, 'status', '--label', 'fin-1'], {
      OPENCLAW_STATE_DIR: stateDir,
      HOME: root,
      DISPATCH_STATE_DIR: stateDir,
      DISPATCH_LABELS_PATH: labelsPath,
      GATEWAY_TOKEN: '',
    });
    assert.equal(result.status, 0, `status CLI failed: ${result.stderr}`);
    const after = JSON.parse(readFileSync(labelsPath, 'utf8'))['fin-1'];
    // The fix: NOT auto-resolved as done.
    assert.notEqual(after.status, 'done',
      `session done w/o terminal reply must not mark task done; label=${JSON.stringify(after)} stdout=${result.stdout.slice(-400)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
