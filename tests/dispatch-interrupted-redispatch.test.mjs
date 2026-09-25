import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const WATCHER_PATH = join(REPO_DIR, 'dispatch', 'watcher.mjs');
const SCHEMA_PATH = join(REPO_DIR, 'schema.sql');

/**
 * Regression coverage for the 2026-09-21 interrupted-redispatch gap:
 *
 * A long dispatch (2h budget) died mid-task with terminal status
 * "interrupted" (transcript readable, no terminal reply) and nothing
 * re-dispatched the work until a human noticed 45 min later. The watcher now
 * re-dispatches interrupted terminal resolutions via
 * `dispatch enqueue --mode reuse` with a continuation prompt, up to
 * DISPATCH_INTERRUPT_RETRIES times (default 2), tracking a separate
 * interruptRetryCount in labels.json (independent of the 529 retryCount and
 * the gateway-restart gwRestartRetryCount) and backing off
 * 60s * retryCount before the next attempt.
 *
 * (1) First interrupted tick: counter + backoff window persisted, watcher
 *     stays pending (no respawn yet) and the label is NOT marked terminal.
 * (2) Tick after the backoff window: respawn dispatched via
 *     `enqueue --mode reuse` with the continuation prompt and the original
 *     delivery target; watcher stays pending.
 * (3) Max retries: terminal interrupted status stands, exit code 0 (once mode),
 *     no respawn, check-in announcements stay accurate.
 * (4) Clean done: interruptRetryCount resets to 0.
 * (5) DISPATCH_INTERRUPT_RETRIES=0 disables the redispatch entirely.
 * (6) Redispatch enqueue carries the original agent and verify-cmd forward.
 * (7) Respawn failure: counter advanced + fresh backoff scheduled, label stays
 *     non-terminal; the budget-exhausted tick is terminal.
 */

function makeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `dispatch-interrupted-${name}-`));
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, '{}\n');
  const dbPath = join(root, 'scheduler.db');
  const db = new Database(dbPath);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.close();
  return { root, labelsPath, dbPath };
}

function runWatcher(args, env) {
  const result = spawnSync(process.execPath, [WATCHER_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function watcherEnv(fix, extra = {}) {
  return {
    ...process.env,
    SCHEDULER_DB: fix.dbPath,
    DISPATCH_STATE_DIR: fix.root,
    DISPATCH_LABELS_PATH: fix.labelsPath,
    DISPATCH_INDEX_PATH: extra.stubPath,
    OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
    ...extra,
  };
}

function readLabels(fix) {
  return JSON.parse(readFileSync(fix.labelsPath, 'utf8'));
}

function stubInterruptedIndex(fix, { logEnqueue = true } = {}) {
  const stubPath = join(fix.root, 'index-stub.mjs');
  const enqueueLog = join(fix.root, 'enqueue.log');
  writeFileSync(stubPath, `
import { appendFileSync } from 'node:fs';
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
  }) + '\\n');
  process.exit(0);
}
if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    lastReply: null,
    diagnosticReply: null,
    completion: null,
  }) + '\\n');
  process.exit(0);
}
if (sub === 'enqueue') {
${logEnqueue ? `  appendFileSync(${JSON.stringify(enqueueLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');` : ''}
  process.stdout.write(JSON.stringify({ ok: true, label: 'int-x', status: 'accepted', mode: 'reuse' }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
process.exit(0);
`);
  return { stubPath, enqueueLog };
}

test('(1) first interrupted tick: counter + backoff persisted, no respawn yet', () => {
  const fix = makeFixture('first');
  try {
    const { stubPath, enqueueLog } = stubInterruptedIndex(fix);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(result.status, 0, `watcher must stay pending; stderr=${result.stderr}`);
    assert.match(result.stderr, /WATCHER_PENDING.*interrupted redispatch scheduled/,
      'watcher should report the scheduled redispatch');
    const after = readLabels(fix)['int-x'];
    assert.equal(after.interruptRetryCount, 1, 'counter incremented to 1');
    assert.ok(after.watcherRetryAfter, 'backoff window persisted');
    const delayMs = new Date(after.watcherRetryAfter).getTime() - Date.now();
    assert.ok(delayMs > 100_000 && delayMs <= 120_000,
      `backoff must be 120s * 1 (got ${delayMs}ms)`);
    assert.equal(existsSync(enqueueLog), false, 'no respawn before the backoff window');
    // Separate from the 529 / gateway-restart counters.
    assert.equal(after.retryCount, undefined, '529 retryCount untouched');
    assert.equal(after.gwRestartRetryCount, undefined, 'gwRestartRetryCount untouched');
    // While a retry is pending the label must not be marked terminal.
    assert.equal(after.status, 'running', 'label stays non-terminal while a redispatch is pending');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(2) tick after backoff: respawn via enqueue --mode reuse with continuation prompt', () => {
  const fix = makeFixture('respawn');
  try {
    const { stubPath, enqueueLog } = stubInterruptedIndex(fix);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        model: 'gpufarm/qwen3.8-27b',
        thinking: 'high',
        origin: 'telegram:484946046',
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
        interruptRetryCount: 1,
        watcherRetryAfter: new Date(Date.now() - 1000).toISOString(),
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(result.status, 0, `watcher must stay pending after dispatch; stderr=${result.stderr}`);
    assert.match(result.stderr, /interrupted redispatch dispatched/,
      'watcher should report the dispatched redispatch');
    assert.ok(existsSync(enqueueLog), 'enqueue must have been invoked');
    const args = JSON.parse(readFileSync(enqueueLog, 'utf8'));
    assert.equal(args[0], 'enqueue', 'subcommand is enqueue');
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag('--label'), 'int-x');
    assert.equal(flag('--mode'), 'reuse', 'continues the same session');
    assert.equal(flag('--spawn-via'), 'gateway', 'scheduler-originated redispatch never becomes an agent handoff');
    assert.match(flag('--message'), /interrupted before completion/i, 'continuation prompt present');
    assert.match(flag('--message'), /do not redo completed steps/i, 'continuation prompt present');
    assert.equal(flag('--model'), 'gpufarm/qwen3.8-27b', 'original model preserved');
    assert.equal(flag('--thinking'), 'high', 'original thinking preserved');
    assert.equal(flag('--timeout'), '7200', 'original timeout preserved');
    assert.equal(flag('--deliver-to'), '484946046', 'delivery target preserved');
    assert.equal(flag('--delivery-mode'), 'announce');
    assert.equal(flag('--deliver-channel'), 'telegram');
    const after = readLabels(fix)['int-x'];
    assert.equal(after.watcherRetryAfter, undefined, 'backoff window cleared after dispatch');
    assert.equal(after.interruptRetryCount, 1, 'counter not double-incremented on the dispatch tick');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(6) redispatch enqueue carries agent and verify-cmd forward', () => {
  const fix = makeFixture('carry');
  try {
    const { stubPath, enqueueLog } = stubInterruptedIndex(fix);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:kebab:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'kebab',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        verifyCmd: 'test -f /nonexistent-verify-target',
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
        interruptRetryCount: 1,
        watcherRetryAfter: new Date(Date.now() - 1000).toISOString(),
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(result.status, 0, `watcher must stay pending after dispatch; stderr=${result.stderr}`);
    assert.ok(existsSync(enqueueLog), 'enqueue must have been invoked');
    const args = JSON.parse(readFileSync(enqueueLog, 'utf8'));
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag('--agent'), 'kebab', 'original label agent carried to the redispatch enqueue');
    assert.equal(flag('--verify-cmd'), 'test -f /nonexistent-verify-target',
      'original verify-cmd carried to the redispatch enqueue');
    assert.equal(flag('--mode'), 'reuse');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(7) respawn failure advances the counter, stays non-terminal; exhausted tick is terminal', () => {
  const fix = makeFixture('fail');
  try {
    // Stub where `enqueue` fails (exit 1), simulating a respawn that cannot land.
    const stubPath = join(fix.root, 'index-stub.mjs');
    const enqueueLog = join(fix.root, 'enqueue.log');
    writeFileSync(stubPath, `
import { appendFileSync } from 'node:fs';
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
  }) + '\\n');
  process.exit(0);
}
if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    lastReply: null,
    diagnosticReply: null,
    completion: null,
  }) + '\\n');
  process.exit(0);
}
if (sub === 'enqueue') {
  appendFileSync(${JSON.stringify(enqueueLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  process.stderr.write('stub enqueue failure\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
process.exit(0);
`);

    // Dispatch tick with one retry left: respawn fails.
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
        interruptRetryCount: 1,
        watcherRetryAfter: new Date(Date.now() - 1000).toISOString(),
      },
    }, null, 2));

    const failed = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(failed.status, 0, `watcher must stay pending after a failed respawn; stderr=${failed.stderr}`);
    assert.match(failed.stderr, /interrupted redispatch failed/, 'failure reported');
    const afterFail = readLabels(fix)['int-x'];
    assert.equal(afterFail.interruptRetryCount, 2,
      'counter advanced on respawn failure so the budget is consumed');
    assert.ok(afterFail.watcherRetryAfter,
      'stale backoff window replaced with a fresh one');
    const freshDelayMs = new Date(afterFail.watcherRetryAfter).getTime() - Date.now();
    assert.ok(freshDelayMs > 100_000 && freshDelayMs <= 240_000,
      `fresh backoff must be 120s * 2 (got ${freshDelayMs}ms)`);
    assert.notEqual(afterFail.status, 'error',
      'label must not be terminal while the budget is not exhausted');

    // Next tick after the fresh backoff: budget exhausted -> terminal.
    const labels = readLabels(fix);
    labels['int-x'].watcherRetryAfter = new Date(Date.now() - 1000).toISOString();
    writeFileSync(fix.labelsPath, JSON.stringify(labels, null, 2));

    const exhausted = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(exhausted.status, 0, 'once-mode terminal exit must be 0');
    assert.match(exhausted.stdout, /session went idle before completing/,
      'terminal interrupted announcement emitted');
    const afterExhausted = readLabels(fix)['int-x'];
    assert.equal(afterExhausted.status, 'error', 'terminal status once the budget is exhausted');
    assert.match(afterExhausted.summary || '', /interrupted/);
    assert.equal(afterExhausted.interruptRetryCount, 2, 'counter not incremented past max');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(3) max retries: terminal interrupted status stands, no respawn', () => {
  const fix = makeFixture('max');
  try {
    const { stubPath, enqueueLog } = stubInterruptedIndex(fix);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
        interruptRetryCount: 2,
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
      }),
    );

    assert.equal(result.status, 0, 'once-mode terminal exit must be 0');
    assert.match(result.stdout, /session went idle before completing/,
      'terminal interrupted announcement emitted');
    const after = readLabels(fix)['int-x'];
    // Current terminal behavior stands at max retries: markLabelError with the
    // interrupted summary (the check-in script treats error and interrupted
    // identically as terminal states).
    assert.equal(after.status, 'error', 'terminal status preserved (current behavior)');
    assert.match(after.summary || '', /interrupted/, 'terminal summary carries the interrupted reason');
    assert.equal(after.interruptRetryCount, 2, 'counter not incremented past max');
    assert.equal(existsSync(enqueueLog), false, 'no respawn at max retries');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(4) clean done resets interruptRetryCount to 0', () => {
  const fix = makeFixture('reset');
  try {
    const stubPath = join(fix.root, 'index-stub.mjs');
    writeFileSync(stubPath, `
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'done',
    summary: 'completed',
    sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
  }) + '\\n');
  process.exit(0);
}
if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'done',
    lastReply: 'All done: pushed abc1234, 12 passed, 0 failed.',
    completion: { summary_human: 'All done: pushed abc1234, 12 passed, 0 failed.' },
  }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
process.exit(0);
`);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'running',
        agent: 'main',
        mode: 'reuse',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
        interruptRetryCount: 1,
        retryCount: 1,
        gwRestartRetryCount: 1,
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, { stubPath }),
    );

    assert.equal(result.status, 0, `done path must exit 0; stderr=${result.stderr}`);
    assert.match(result.stderr, /WATCHER_ALREADY_DELIVERED|WATCHER_PENDING/,
      'completion routed through the durable outbox');
    const db = new Database(fix.dbPath);
    const outboxRow = db.prepare(
      "SELECT channel, target, body FROM delivery_outbox WHERE completion_label = 'int-x' LIMIT 1",
    ).get();
    db.close();
    assert.ok(outboxRow, 'completion enqueued in the durable outbox');
    assert.equal(outboxRow.channel, 'telegram', 'outbox channel matches the original delivery route');
    assert.equal(outboxRow.target, '484946046', 'outbox target matches the original delivery route');
    assert.match(outboxRow.body, /All done: pushed abc1234/, 'completion text in the outbox body');
    const after = readLabels(fix)['int-x'];
    assert.equal(after.status, 'done', 'label marked done');
    assert.equal(after.interruptRetryCount, 0, 'interruptRetryCount reset on clean done');
    assert.equal(after.retryCount, 0, '529 retryCount reset on clean done');
    assert.equal(after.gwRestartRetryCount, 0, 'gwRestartRetryCount reset on clean done');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(5) DISPATCH_INTERRUPT_RETRIES=0 disables the redispatch', () => {
  const fix = makeFixture('disabled');
  try {
    const { stubPath, enqueueLog } = stubInterruptedIndex(fix);
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
      },
    }, null, 2));

    const result = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '0',
      }),
    );

    assert.equal(result.status, 0, 'once-mode terminal exit must be 0');
    assert.match(result.stdout, /session went idle before completing/,
      'terminal interrupted announcement emitted');
    const after = readLabels(fix)['int-x'];
    // Current terminal behavior (markLabelError) stands when redispatch is
    // disabled; the check-in script treats error and interrupted identically
    // as terminal states.
    assert.ok(['error', 'interrupted'].includes(after.status),
      `terminal status preserved, got ${after.status}`);
    assert.equal(after.interruptRetryCount, undefined, 'counter never set when disabled');
    assert.equal(existsSync(enqueueLog), false, 'no respawn when disabled');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

/**
 * (8) REGRESSION -- sm-round8-fix (2026-09-23): an interrupted session that
 * produced artifacts ("successful tool result observed in JSONL") used to be
 * marked terminal by emitInterruptedOutcome() BEFORE reaching the interrupt
 * auto-redispatch block, so nothing re-dispatched the work until a human
 * noticed hours later. Artifact-producing deaths must fall through to the same
 * redispatch decision (continue-from-transcript, reuse mode, per-label budget)
 * instead of going terminal.
 */
test('(8) artifact-interrupt falls through to auto-redispatch (not terminal)', () => {
  const fix = makeFixture('artifact');
  try {
    const stubPath = join(fix.root, 'index-stub.mjs');
    const enqueueLog = join(fix.root, 'enqueue.log');
    writeFileSync(stubPath, `
import { appendFileSync } from 'node:fs';
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
    sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
  }) + '\\n');
  process.exit(0);
}
if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: 'int-x',
    status: 'interrupted',
    lastReply: null,
    diagnosticReply: null,
    completion: null,
    artifactEvidence: { found: true, reason: 'successful tool result observed in JSONL' },
  }) + '\\n');
  process.exit(0);
}
if (sub === 'enqueue') {
  appendFileSync(${JSON.stringify(enqueueLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  process.stdout.write(JSON.stringify({ ok: true, label: 'int-x', status: 'accepted', mode: 'reuse' }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
process.exit(0);
`);

    // First artifact-interrupt tick: must schedule a redispatch, NOT go terminal.
    // The label starts from the PRODUCTION state: dispatch/index.mjs auto-resolve
    // persists status 'interrupted' before this watcher runs, so the first-tick
    // branch must reset it to 'running' while the redispatch is pending.
    // (Copilot r4084521899.)
    writeFileSync(fix.labelsPath, JSON.stringify({
      'int-x': {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'interrupted',
        summary: 'Auto-resolved as interrupted: session done but no terminal reply observed',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 7200,
        deliverTo: '484946046',
        deliveryMode: 'announce',
        deliverChannel: 'telegram',
      },
    }, null, 2));

    const first = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(first.status, 0, `watcher must stay pending; stderr=${first.stderr}`);
    assert.match(first.stderr, /WATCHER_PENDING.*interrupted redispatch scheduled/,
      'artifact-interrupt must schedule a redispatch, not go terminal');
    // Pending protocol: stdout stays empty (deliverable-only); the artifact
    // diagnostic surfaces on stderr. (Copilot r4084521857.)
    assert.equal((first.stdout || '').trim(), '', 'stdout must stay empty on a pending tick');
    assert.match(first.stderr, /interrupted after producing artifacts/,
      'artifact summary surfaced on stderr (pending path)');
    const afterFirst = readLabels(fix)['int-x'];
    assert.equal(afterFirst.interruptRetryCount, 1, 'counter incremented to 1');
    assert.ok(afterFirst.watcherRetryAfter, 'backoff window persisted');
    assert.equal(afterFirst.status, 'running',
      'label stays non-terminal while an artifact-redispatch is pending');
    assert.equal(existsSync(enqueueLog), false, 'no respawn before the backoff window');

    // Tick after the backoff: respawn dispatched via enqueue --mode reuse.
    const labels = readLabels(fix);
    labels['int-x'].watcherRetryAfter = new Date(Date.now() - 1000).toISOString();
    writeFileSync(fix.labelsPath, JSON.stringify(labels, null, 2));

    const second = runWatcher(
      ['--label', 'int-x', '--timeout', '3600', '--poll-interval', '20', '--once'],
      watcherEnv(fix, {
        stubPath,
        DISPATCH_INTERRUPT_RETRIES: '2',
        DISPATCH_INTERRUPT_RETRY_BASE_DELAY_MS: '120000',
      }),
    );

    assert.equal(second.status, 0, `watcher must stay pending after dispatch; stderr=${second.stderr}`);
    assert.match(second.stderr, /interrupted redispatch dispatched/,
      'watcher should report the dispatched artifact-redispatch');
    assert.ok(existsSync(enqueueLog), 'enqueue must have been invoked');
    const args = JSON.parse(readFileSync(enqueueLog, 'utf8'));
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag('--label'), 'int-x');
    assert.equal(flag('--mode'), 'reuse', 'continues the same session');
    assert.match(flag('--message'), /interrupted before completion/i, 'continuation prompt present');
    assert.equal(flag('--deliver-to'), '484946046', 'delivery target preserved');
    const afterSecond = readLabels(fix)['int-x'];
    assert.equal(afterSecond.watcherRetryAfter, undefined, 'backoff window cleared after dispatch');
    assert.equal(afterSecond.interruptRetryCount, 1, 'counter not double-incremented on the dispatch tick');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});
