import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
    // Failure modes of the `agent` call: OpenClaw's attribution refusal, a
    // typed INVALID_REQUEST rejection, and an untyped transport failure.
    "const agentMode = method === 'agent' ? (process.env.STUB_AGENT_MODE || '') : '';",
    "if (agentMode === 'attribution') {",
    "  process.stderr.write('Error: refusing this turn because it would lose inter-session attribution\\n');",
    '  process.exit(1);',
    '}',
    "if (agentMode === 'invalid') {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'invalid agent params' } }));",
    '  process.exit(1);',
    '}',
    "if (agentMode === 'uncertain') {",
    "  process.stderr.write('Error: gateway connection reset\\n');",
    '  process.exit(1);',
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
  delete base.STUB_AGENT_MODE;
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

// -- Review follow-ups (PR #77) ------------------------------------------------

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function readClaim(fixture, label) {
  try {
    const row = readLabels(fixture)[label];
    return row && row.claimedAt && row.runId == null && row.sessionKey ? row : null;
  } catch {
    return null; // mid-rename read; the next poll sees the settled file
  }
}

function spawnTaskFiles(fixture) {
  const dir = join(fixture.stateDir, 'spawn-tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.txt'));
}

test('(h) a row that never pings stays live for its gateway lifetime, not 3 minutes', () => {
  const fixture = buildFixture();
  try {
    // An unmonitored run (--no-monitor / no delivery target) has no watcher,
    // so lastPing stays null while the turn is healthy. 5 minutes into a
    // 600s run it is still live: a plain fresh enqueue must be refused.
    seedLiveRow(fixture, {
      lastPing: null,
      spawnedAt: iso(5 * 60_000),
      timeoutSeconds: 600,
      gatewayTimeoutSeconds: 600,
    });
    const refused = runDispatch(fixture, enqueueArgs('guarded'));
    assert.equal(refused.status, 4, refused.stderr || refused.stdout);
    assert.equal(parseBody(refused, 'refusal').existing.sessionKey, LIVE_KEY);

    // Past its gateway lifetime plus the 3-minute window (600s + 180s), the
    // gateway has ended the turn: the label can be taken over.
    seedLiveRow(fixture, {
      lastPing: null,
      spawnedAt: iso(14 * 60_000),
      timeoutSeconds: 600,
      gatewayTimeoutSeconds: 600,
    });
    const taken = runDispatch(fixture, enqueueArgs('guarded'));
    assert.equal(taken.status, 0, taken.stderr || taken.stdout);
    assert.notEqual(readLabels(fixture).guarded.sessionKey, LIVE_KEY);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(i) a certain refusal restores the row the claim replaced; a first-ever label is removed', () => {
  const fixture = buildFixture();
  try {
    // --force-retry claims over a live run, then OpenClaw refuses the explicit
    // Gateway route from an agent shell: the live run's mapping must survive.
    const seeded = seedLiveRow(fixture);
    const refused = runDispatch(
      fixture,
      enqueueArgs('guarded', ['--force-retry', '--spawn-via', 'gateway']),
      { ...AGENT_SHELL, STUB_AGENT_MODE: 'attribution' },
    );
    assert.equal(refused.status, 3, refused.stderr || refused.stdout);
    assert.deepEqual(readLabels(fixture), { guarded: seeded }, 'the replaced row is restored as it was');

    writeFileSync(fixture.labelsPath, '{}\n');
    const fresh = runDispatch(
      fixture,
      enqueueArgs('first', ['--spawn-via', 'gateway']),
      { ...AGENT_SHELL, STUB_AGENT_MODE: 'attribution' },
    );
    assert.equal(fresh.status, 3, fresh.stderr || fresh.stdout);
    assert.deepEqual(readLabels(fixture), {}, 'a first-ever label leaves no claim behind');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(j) a typed INVALID_REQUEST rejection releases the claim; an untyped failure keeps it', () => {
  const fixture = buildFixture();
  try {
    const rejected = runDispatch(fixture, enqueueArgs('typed'), { STUB_AGENT_MODE: 'invalid' });
    assert.notEqual(rejected.status, 0, 'the enqueue fails');
    assert.match(rejected.stderr, /no run started/);
    assert.deepEqual(readLabels(fixture), {}, 'a definite rejection holds no claim');

    const uncertain = runDispatch(fixture, enqueueArgs('typed'), { STUB_AGENT_MODE: 'uncertain' });
    assert.notEqual(uncertain.status, 0, 'the enqueue fails');
    const kept = readLabels(fixture).typed;
    assert.ok(kept, 'an uncertain failure keeps the claim: the session may be live');
    assert.equal(kept.status, 'running');
    assert.equal(kept.runId, null);
    assert.ok(kept.claimedAt);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(k) a spawn whose claim was taken over mid-call does not overwrite the newer run', { timeout: 90_000 }, async () => {
  const fixture = buildFixture();
  try {
    // A holds its gateway call open; B takes the label over with --force-retry
    // and finishes first. A's late success must leave B's mapping alone.
    const first = runDispatchAsync(fixture, enqueueArgs('race'), { STUB_AGENT_SLEEP_MS: '4000' });
    const claimA = await waitFor(() => readClaim(fixture, 'race'), 30_000, "A's claim row");
    const second = runDispatch(fixture, enqueueArgs('race', ['--force-retry']));
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const winner = parseBody(second, 'accept');
    assert.notEqual(winner.sessionKey, claimA.sessionKey);

    const late = await first;
    assert.equal(late.status, 1, `the superseded spawn reports failure; stderr=${late.stderr}`);
    assert.match(late.stderr, /taken over while this spawn was in flight/);
    const row = readLabels(fixture).race;
    assert.equal(row.sessionKey, winner.sessionKey, "the label keeps B's session");
    assert.ok(row.forcedRetryAt, "B's takeover stamp survives");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(l) a claim settled while the spawn was in flight is not reset to running', { timeout: 90_000 }, async () => {
  const fixture = buildFixture();
  try {
    const pending = runDispatchAsync(fixture, enqueueArgs('settle'), { STUB_AGENT_SLEEP_MS: '3000' });
    const claim = await waitFor(() => readClaim(fixture, 'settle'), 30_000, 'the claim row');
    // A terminal update (status/done) lands on the claim during the call.
    writeFileSync(fixture.labelsPath, JSON.stringify({ settle: { ...claim, status: 'done' } }, null, 2));

    const result = await pending;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(parseBody(result, 'settled').status, 'settled');
    const row = readLabels(fixture).settle;
    assert.equal(row.status, 'done', 'the terminal status is kept');
    assert.equal(row.runId, 'run-gw', 'the run id is still recorded');
    assert.equal(row.claimedAt, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(m) a refused tool-route enqueue leaves no task file behind', () => {
  const fixture = buildFixture();
  try {
    seedLiveRow(fixture);
    const before = spawnTaskFiles(fixture).length;
    const result = runDispatch(fixture, enqueueArgs('guarded'), AGENT_SHELL);
    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.equal(spawnTaskFiles(fixture).length, before, 'the refused prompt is not retained');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('(n) a non-forced run clears the forcedRetryAt stamp of an earlier forced run', () => {
  const fixture = buildFixture();
  try {
    // A stale row that an earlier --force-retry stamped: the plain takeover
    // is not a forced retry, so the ledger must not say it was.
    seedLiveRow(fixture, {
      lastPing: iso(10 * 60_000),
      spawnedAt: iso(30 * 60_000),
      forcedRetryAt: iso(30 * 60_000),
    });
    const result = runDispatch(fixture, enqueueArgs('guarded'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readLabels(fixture).guarded.forcedRetryAt, undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
