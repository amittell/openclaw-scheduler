import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { executeMain, executeShell, executeWatchdog } from '../dispatcher-strategies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.js');

function noop() {}

function makeWatchdogJob(overrides = {}) {
  return {
    id: 'watchdog-job',
    name: 'watchdog:test',
    watchdog_target_label: 'dispatch:test',
    watchdog_check_cmd: 'node check.js',
    watchdog_alert_channel: 'telegram',
    watchdog_alert_target: '123',
    watchdog_self_destruct: 1,
    watchdog_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    watchdog_timeout_min: 60,
    run_timeout_ms: 30_000,
    ...overrides,
  };
}

test('watchdog ignores arbitrary stdout without an explicit terminal contract', async () => {
  const deliveries = [];
  const deleted = [];
  const updated = [];

  const result = await executeWatchdog(makeWatchdogJob(), {}, {
    runShellCommand: async () => ({ exitCode: 0, stdout: 'Done.', stderr: '' }),
    handleDelivery: async (...args) => deliveries.push(args),
    updateJob: (...args) => updated.push(args),
    deleteJob: (...args) => deleted.push(args),
    log: noop,
  });

  assert.equal(deliveries.length, 0);
  assert.equal(updated.length, 0);
  assert.equal(deleted.length, 0);
  assert.match(result.summary, /non-terminal output|still running/i);
  assert.doesNotMatch(result.summary, /completed|disarmed/i);
});

test('watchdog disarms only after a structured terminal payload proves completion', async () => {
  const deliveries = [];
  const deleted = [];
  const updated = [];

  const result = await executeWatchdog(makeWatchdogJob(), {}, {
    runShellCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ terminal: true, status: 'done', summary: 'Implemented the scheduler delivery fix.' }),
      stderr: '',
    }),
    handleDelivery: async (...args) => deliveries.push(args),
    updateJob: (...args) => updated.push(args),
    deleteJob: (...args) => deleted.push(args),
    log: noop,
  });

  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0][1], /completed -- watchdog disarmed/i);
  assert.match(deliveries[0][1], /Implemented the scheduler delivery fix\./);
  assert.deepEqual(updated, [['watchdog-job', { enabled: 0 }]]);
  assert.deepEqual(deleted, [['watchdog-job']]);
  assert.match(result.summary, /completed -- watchdog disarmed/i);
});

test('watchdog accepts dispatch result JSON only when it carries a terminal status', async () => {
  const deliveries = [];

  const running = await executeWatchdog(makeWatchdogJob(), {}, {
    runShellCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, status: 'running', summary: null, completion: null }),
      stderr: '',
    }),
    handleDelivery: async (...args) => deliveries.push(args),
    updateJob: noop,
    deleteJob: noop,
    log: noop,
  });

  assert.equal(deliveries.length, 0);
  assert.match(running.summary, /still running/i);

  const completed = await executeWatchdog(makeWatchdogJob(), {}, {
    runShellCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        status: 'done',
        summary: 'Queued durable delivery.',
        completion: { deliveryText: 'Queued durable delivery.' },
      }),
      stderr: '',
    }),
    handleDelivery: async (...args) => deliveries.push(args),
    updateJob: noop,
    deleteJob: noop,
    log: noop,
  });

  assert.equal(deliveries.length, 1);
  assert.match(completed.summary, /completed -- watchdog disarmed/i);
  assert.match(deliveries[0][1], /Queued durable delivery\./);
});

test('dispatch watchdog checks terminal result output, not stuck-list stdout', () => {
  const dispatchIndexSrc = readFileSync(join(__dirname, '..', 'dispatch', 'index.mjs'), 'utf8');
  assert.match(dispatchIndexSrc, /result --label/);
});

test('main fire-and-forget delivery instructions use the scheduler post office, not the message tool', async () => {
  const prompts = [];

  const result = await executeMain({
    id: 'job-42',
    name: 'background-summary',
    execution_intent: 'fire-and-forget',
    payload_message: 'Summarize the current queue.',
    payload_thinking: null,
    delivery_mode: 'announce-always',
    delivery_channel: 'telegram',
    delivery_to: 'chat-123',
  }, { run: { id: 'run-1' } }, {
    sendSystemEvent: async (prompt) => { prompts.push(prompt); },
    buildExecutionIntentNote: () => '',
    log: noop,
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /scheduler post office/i);
  assert.match(prompts[0], /messages send/);
  assert.match(prompts[0], /--kind result/);
  assert.match(prompts[0], /--channel 'telegram'/);
  assert.match(prompts[0], /--delivery-to 'chat-123'/);
  assert.doesNotMatch(prompts[0], /send your results using the message tool/i);
  assert.equal(result.skipDelivery, true);
});

test('completion watcher shell jobs deliver stdout only and keep stderr diagnostics internal', async () => {
  const result = await executeShell({
    id: 'job-deliver-ok',
    name: 'dispatch-deliver:clean-result',
    payload_message: 'node watcher.mjs',
    delivery_mode: 'announce-always',
    run_timeout_ms: 30_000,
  }, { run: { id: 'run-deliver-ok' } }, {
    runShellCommand: async () => ({
      stdout: '🌶️ *dispatch* [clean-result] completed:\n\nReal worker result',
      stderr: '[watcher] debug line that must stay internal',
      error: null,
    }),
    normalizeShellResult: (shellExec) => ({
      status: 'ok',
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: shellExec.stdout,
      stderr: shellExec.stderr,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: shellExec.stdout.length,
      stderrBytes: shellExec.stderr.length,
      stdoutTruncated: false,
      stderrTruncated: false,
      summary: `stdout:\n${shellExec.stdout}\n\nstderr:\n${shellExec.stderr}`,
      deliveryText: `stdout:\n${shellExec.stdout}\n\nstderr:\n${shellExec.stderr}`,
      imageAttachments: [],
      errorMessage: null,
      contextSummary: {},
    }),
    log: noop,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.deliveryOverride, '🌶️ *dispatch* [clean-result] completed:\n\nReal worker result');
  assert.doesNotMatch(result.deliveryOverride, /debug line/);
});

test('completion watcher stderr-only success is treated as delivery failure, not a completion', async () => {
  const logs = [];
  const result = await executeShell({
    id: 'job-deliver-empty',
    name: 'chilisaus-deliver:empty-result',
    payload_message: 'node watcher.mjs',
    delivery_mode: 'announce-always',
    run_timeout_ms: 30_000,
  }, { run: { id: 'run-deliver-empty' } }, {
    runShellCommand: async () => ({
      stdout: '',
      stderr: '[watcher] [empty-result] completion delivery suppressed (no meaningful reply or summary)',
      error: null,
    }),
    normalizeShellResult: (shellExec) => ({
      status: 'ok',
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: shellExec.stdout,
      stderr: shellExec.stderr,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: shellExec.stderr.length,
      stdoutTruncated: false,
      stderrTruncated: false,
      summary: `stderr:\n${shellExec.stderr}`,
      deliveryText: `stderr:\n${shellExec.stderr}`,
      imageAttachments: [],
      errorMessage: null,
      contextSummary: {},
    }),
    log: (level, msg, meta) => logs.push({ level, msg, meta }),
  });

  assert.equal(result.status, 'error');
  assert.match(result.deliveryOverride, /Completion delivery watcher/);
  assert.match(result.deliveryOverride, /without a deliverable result/i);
  assert.doesNotMatch(result.deliveryOverride, /completion delivery suppressed/);
  assert.ok(logs.some(entry => entry.level === 'warn' && /no deliverable stdout/.test(entry.msg)));
});

test('messages send accepts channel and delivery-to overrides for durable delivery', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-test-'));
  const dbPath = join(tempDir, 'scheduler.sqlite');

  t.after(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  setDbPath(dbPath);
  await initDb();
  closeDb();

  const run = spawnSync(process.execPath, [
    cliPath,
    'messages', 'send',
    '--from', 'scheduler-fire-and-forget:job-42',
    '--to', 'main',
    '--kind', 'result',
    '--channel', 'telegram',
    '--delivery-to', 'chat-123',
    '--body', 'Queued completion summary',
  ], {
    env: { ...process.env, SCHEDULER_DB: dbPath },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr || run.stdout);

  setDbPath(dbPath);
  const row = getDb().prepare(`
    SELECT from_agent, to_agent, kind, body, channel, delivery_to
    FROM messages
    ORDER BY created_at DESC
    LIMIT 1
  `).get();

  assert.deepEqual(row, {
    from_agent: 'scheduler-fire-and-forget:job-42',
    to_agent: 'main',
    kind: 'result',
    body: 'Queued completion summary',
    channel: 'telegram',
    delivery_to: 'chat-123',
  });
});
