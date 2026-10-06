import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');

const AGENT_SHELL = Object.freeze({ OPENCLAW_SHELL: 'exec' });
const CHAT = '100200300';
// A session a different enqueue would be refusing to duplicate.
const LIVE_KEY = 'agent:main:subagent:11111111-2222-4333-8444-555555555555';

/**
 * Regression coverage for the 2026-10-05 double-dispatch race: two enqueue
 * processes started two sessions on the same label because the ledger row
 * was written unconditionally in both routes. A fresh enqueue is now refused
 * (exit 4, machine-parseable JSON on stdout) while the label's row still
 * holds a live in-flight run; --force-retry is the explicit takeover the
 * designed recovery paths use, and stale/wedged rows are taken over without
 * the flag.
 *
 * (a) gateway route: fresh enqueue on a live row is refused, nothing is
 *     written, no session is started.
 * (b) --force-retry takes over the live row with a NEW session and stamps
 *     forcedRetryAt.
 * (c) a stale row (no fresh heartbeat for 3+ min) is taken over without the
 *     flag -- takeover is how a dead run recovers.
 * (d) fresh awaiting-spawn rows are refused; stale (15+ min) awaiting-spawn
 *     rows are taken over.
 * (e) two genuinely concurrent fresh enqueues: exactly one wins, the other
 *     is refused, and the row holds only the winner's session.
 * (f) reuse mode continues the row's own session on a live row (v1 caveat:
 *     the guard covers fresh spawns only).
 * (g) tool route (OpenClaw agent shell): the guard runs atomically inside the
 *     awaiting-spawn ledger transaction and refuses with the same contract.
 */

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-inflight-guard-'));
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const labelsPath = join(stateDir, 'labels.json');
  const callsPath = join(root, 'openclaw-calls.jsonl');
  const dbPath = join(root, 'scheduler.db');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, '.openclaw'), { recursive: true });
  // spawnPollMax 0: the post-spawn canary does exactly one store read and no
  // sleep, so an accepted enqueue finishes in well under a second.
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'inflight-guard', spawnPollMax: 0, spawnPollDelayMs: 1 }));
  writeFileSync(join(root, '.openclaw', 'openclaw.json'), '{}\n');
  writeFileSync(labelsPath, '{}\n');

  const stubPath = join(binDir, 'openclaw');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const paramsIdx = args.indexOf('--params');",
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    'const params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : null;',
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, params }) + '\\n');`,
    'const sleepMs = Number(process.env.STUB_AGENT_SLEEP_MS || 0);',
    'if (method === \'agent\' && sleepMs > 0) {',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);',
    '}',
    "process.stdout.write(method === 'agent' ? JSON.stringify({ ok: true, runId: 'run-gw' }) : '{}');",
    '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  const fixture = { root, configDir, binDir, stateDir, labelsPath, callsPath, dbPath };
  // Give the real scheduler CLI its schema (watcher/watchdog jobs, outbox).
  const init = spawnSync(process.execPath, [join(REPO_DIR, 'cli.js'), '--json', 'jobs', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.root, SCHEDULER_DB: fixture.dbPath },
  });
  assert.equal(init.status, 0, init.stderr);
  return fixture;
}

function envFor(fixture, extra = {}) {
  const base = { ...process.env };
  delete base.OPENCLAW_SHELL;
  delete base.OPENCLAW_SUBAGENT_EXEC;
  delete base.STUB_AGENT_SLEEP_MS;
  return {
    ...base,
    HOME: fixture.root,
    PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
    DISPATCH_CONFIG_DIR: fixture.configDir,
    DISPATCH_STATE_DIR: fixture.stateDir,
    DISPATCH_LABELS_PATH: fixture.labelsPath,
    SCHEDULER_DB: fixture.dbPath,
    OPENCLAW_GATEWAY_TOKEN: '',
    // Never reach a live Gateway from the done activity check.
    OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
    ...extra,
  };
}

function enqueueArgs(label, extras = []) {
  return [
    'enqueue',
    '--label', label,
    '--message', 'Run the guarded smoke task.',
    '--timeout', '600',
    '--no-monitor',
    '--delivery-mode', 'none',
    ...extras,
  ];
}

function runDispatch(fixture, args, extraEnv = {}) {
  return spawnSync(process.execPath, [INDEX_PATH, ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: envFor(fixture, extraEnv),
  });
}

function runDispatchAsync(fixture, args, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [INDEX_PATH, ...args], {
      env: envFor(fixture, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ status: null, stdout, stderr: `${stderr}\n(assistant killed after 90s)` });
    }, 90_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function readLabels(fixture) {
  return JSON.parse(readFileSync(fixture.labelsPath, 'utf8'));
}

function readCalls(fixture) {
  if (!existsSync(fixture.callsPath)) return [];
  return readFileSync(fixture.callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function parseBody(result, context) {
  assert.ok(result.stdout.trim(), `expected JSON on stdout; ${context} stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function seedLiveRow(fixture, overrides = {}) {
  const row = {
    sessionKey: LIVE_KEY,
    agent: 'main',
    mode: 'fresh',
    status: 'running',
    spawnedAt: iso(30_000),
    lastPing: iso(10_000),
    runId: 'run-live',
    timeoutSeconds: 600,
    deliverTo: CHAT,
    deliveryMode: 'announce',
    deliverChannel: 'telegram',
    ...overrides,
  };
  writeFileSync(fixture.labelsPath, JSON.stringify({ guarded: row }, null, 2));
  return row;
}

test('(a) gateway route: fresh enqueue on a live in-flight row is refused (exit 4, row untouched, no session started)', () => {
  const fixture = buildFixture();
  try {
    const seeded = seedLiveRow(fixture);
    const result = runDispatch(fixture, enqueueArgs('guarded'));

    assert.equal(result.status, 4, `refusal must exit 4; stderr=${result.stderr} stdout=${result.stdout}`);
    const body = parseBody(result, 'refusal');
    assert.equal(body.ok, false);
    assert.equal(body.refused, 'in-flight', 'machine-parseable refusal reason');
    assert.equal(body.label, 'guarded');
    assert.equal(body.existing.status, 'running');
    assert.equal(body.existing.sessionKey, LIVE_KEY);
    assert.ok(body.existing.ageSeconds >= 5 && body.existing.ageSeconds < 60,
      `age must reflect the fresh heartbeat (~10s); got ${body.existing.ageSeconds}`);
    assert.match(body.message, /--force-retry/);
    assert.match(result.stderr, /--force-retry/, 'the human remedy names the flag');
    assert.deepEqual(readLabels(fixture), { guarded: seeded }, 'the row is not modified');
    assert.equal(readCalls(fixture).filter((call) => call.method === 'agent').length, 0, 'no session started');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(b) --force-retry takes over the live row with a new session and a forcedRetryAt stamp', () => {
  const fixture = buildFixture();
  try {
    seedLiveRow(fixture);
    const result = runDispatch(fixture, enqueueArgs('guarded', ['--force-retry']));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const accepted = parseBody(result, 'accept');
    assert.equal(accepted.status, 'accepted');
    const row = readLabels(fixture).guarded;
    assert.equal(row.status, 'running');
    assert.notEqual(row.sessionKey, LIVE_KEY, 'takeover starts a new session');
    assert.equal(row.sessionKey, accepted.sessionKey);
    assert.equal(row.runId, 'run-gw');
    assert.ok(row.forcedRetryAt, 'the row records the explicit takeover');
    assert.equal(row.claimedAt, undefined, 'the claim placeholder is replaced by the spawn');
    assert.equal(readCalls(fixture).filter((call) => call.method === 'agent').length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(c) a stale row (no fresh heartbeat for 3+ min) is taken over without the flag', () => {
  const fixture = buildFixture();
  try {
    // Watcher dead (lastPing 10 min old) and spawn anchor long gone: the run
    // is not live, so a plain fresh enqueue must be allowed through.
    seedLiveRow(fixture, { lastPing: iso(10 * 60_000), spawnedAt: iso(30 * 60_000) });
    const result = runDispatch(fixture, enqueueArgs('guarded'));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = readLabels(fixture).guarded;
    assert.equal(row.status, 'running');
    assert.notEqual(row.sessionKey, LIVE_KEY);
    assert.equal(row.forcedRetryAt, undefined, 'stale takeover does not need the flag');
    assert.equal(readCalls(fixture).filter((call) => call.method === 'agent').length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(d) fresh awaiting-spawn rows are refused; stale (15+ min) rows are taken over', () => {
  const fixture = buildFixture();
  try {
    const fresh = {
      agent: 'main',
      status: 'awaiting-spawn',
      spawnVia: 'sessions_spawn',
      preparedAt: iso(2 * 60_000),
      deliverTo: CHAT,
      deliveryMode: 'announce',
      deliverChannel: 'telegram',
    };
    writeFileSync(fixture.labelsPath, JSON.stringify({ guarded: fresh }, null, 2));
    const refused = runDispatch(fixture, enqueueArgs('guarded'));
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    const body = parseBody(refused, 'refusal');
    assert.equal(body.refused, 'in-flight');
    assert.equal(body.existing.status, 'awaiting-spawn');
    assert.equal(body.existing.sessionKey, null, 'a prepared spawn has no child key yet');
    assert.ok(body.existing.ageSeconds >= 90 && body.existing.ageSeconds < 300);
    assert.deepEqual(readLabels(fixture), { guarded: fresh }, 'the prepared row is not modified');

    // Same row, 20 min old: the requesting agent never adopted it -- a new
    // enqueue must be able to take the label over without the flag.
    const stale = { ...fresh, preparedAt: iso(20 * 60_000) };
    writeFileSync(fixture.labelsPath, JSON.stringify({ guarded: stale }, null, 2));
    const taken = runDispatch(fixture, enqueueArgs('guarded'));
    assert.equal(taken.status, 0, taken.stderr || taken.stdout);
    const row = readLabels(fixture).guarded;
    assert.equal(row.status, 'running');
    assert.notEqual(row.spawnedAt, stale.preparedAt);
    assert.equal(row.forcedRetryAt, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(e) two genuinely concurrent fresh enqueues: exactly one wins, the other is refused, the row holds only the winner', { timeout: 90_000 }, async () => {
  const fixture = buildFixture();
  try {
    // The stub gateway holds each `agent` call for 5s, so both processes are
    // inside the spawn window when the second one reaches the ledger.
    const env = { STUB_AGENT_SLEEP_MS: '5000' };
    const [first, second] = await Promise.all([
      runDispatchAsync(fixture, enqueueArgs('race'), env),
      runDispatchAsync(fixture, enqueueArgs('race'), env),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [0, 4],
      `exactly one winner and one refusal; got ${statuses} (stderr: ${first.stderr} | ${second.stderr})`);
    const accepted = first.status === 0 ? first : second;
    const refused = first.status === 0 ? second : first;
    const winner = parseBody(accepted, 'accept');
    const loser = parseBody(refused, 'refusal');
    assert.equal(loser.refused, 'in-flight');
    assert.equal(loser.existing.sessionKey, winner.sessionKey,
      'the loser must have seen the winner\'s reserved claim row');
    const row = readLabels(fixture).race;
    assert.equal(row.sessionKey, winner.sessionKey, 'the row holds the winner\'s session only');
    assert.equal(row.runId, 'run-gw');
    assert.equal(row.forcedRetryAt, undefined);
    const agentCalls = readCalls(fixture).filter((call) => call.method === 'agent');
    assert.equal(agentCalls.length, 1, 'only the winner started a session');
    assert.equal(agentCalls[0].params.sessionKey, winner.sessionKey);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(f) reuse mode continues the row\'s own session on a live row (v1 caveat)', () => {
  const fixture = buildFixture();
  try {
    seedLiveRow(fixture);
    const result = runDispatch(fixture, [
      'enqueue', '--label', 'guarded',
      '--message', 'Continue the interrupted work.',
      '--mode', 'reuse', '--timeout', '600',
      '--no-monitor', '--delivery-mode', 'none',
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = readLabels(fixture).guarded;
    assert.equal(row.sessionKey, LIVE_KEY, 'reuse keeps the row\'s session');
    assert.equal(row.runId, 'run-gw');
    assert.equal(row.forcedRetryAt, undefined);
    const agentCalls = readCalls(fixture).filter((call) => call.method === 'agent');
    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0].params.sessionKey, LIVE_KEY, 'the continuation lands in the same session');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(g) tool route: an agent-shell fresh enqueue on a live row is refused with the same contract', () => {
  const fixture = buildFixture();
  try {
    const seeded = seedLiveRow(fixture);
    const result = runDispatch(fixture, enqueueArgs('guarded'), AGENT_SHELL);

    assert.equal(result.status, 4, `refusal must exit 4; stderr=${result.stderr} stdout=${result.stdout}`);
    const body = parseBody(result, 'refusal');
    assert.equal(body.refused, 'in-flight');
    assert.equal(body.existing.sessionKey, LIVE_KEY);
    assert.deepEqual(readLabels(fixture), { guarded: seeded }, 'the awaiting-spawn transaction wrote nothing');
    assert.equal(readCalls(fixture).filter((call) => call.method === 'agent').length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
