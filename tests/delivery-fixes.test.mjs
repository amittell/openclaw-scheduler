import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

test('delivery watcher jobs are non-blocking cron quick-poll jobs', () => {
  const dispatchIndexSrc = readFileSync(join(__dirname, '..', 'dispatch', 'index.mjs'), 'utf8');
  assert.match(dispatchIndexSrc, /--once/);
  assert.match(dispatchIndexSrc, /schedule_kind:\s+'cron'/);
  assert.match(dispatchIndexSrc, /schedule_cron:\s+config\.deliver_watcher_cron \|\| '\* \* \* \* \*'/);
  assert.match(dispatchIndexSrc, /next_run_at:\s+nowUtc/);
  assert.match(dispatchIndexSrc, /run_timeout_ms:\s+120_000/);
  assert.doesNotMatch(dispatchIndexSrc, /schedule_kind:\s+'at'[\s\S]{0,400}watcherCmd/);
});

test('dispatch monitor jobs resolve stable scheduler paths from branded wrappers', () => {
  const dispatchIndexSrc = readFileSync(join(__dirname, '..', 'dispatch', 'index.mjs'), 'utf8');
  assert.match(dispatchIndexSrc, /function resolveSchedulerCliPath\(\)/);
  assert.match(dispatchIndexSrc, /function resolveDispatchScriptPath\(fileName\)/);
  assert.match(dispatchIndexSrc, /function resolvePersistentNodePath\(\)/);
  assert.match(dispatchIndexSrc, /DISPATCH_CONFIG_DIR='\$\{sq\(dispatchConfigDirForChild\(\)\)\}'/);
  assert.match(dispatchIndexSrc, /DISPATCH_INDEX_PATH='\$\{sq\(dispatchIndexPath\)\}'/);
  assert.match(dispatchIndexSrc, /'\$\{sq\(nodePath\)\}' '\$\{sq\(watcherPath\)\}'/);
  assert.match(dispatchIndexSrc, /'\$\{sq\(resolvePersistentNodePath\(\)\)\}' '\$\{sq\(resolveDispatchScriptPath\('index\.mjs'\)\)\}' result --label/);
  assert.doesNotMatch(dispatchIndexSrc, /'\$\{sq\(process\.execPath\)\}' '\$\{sq\(watcherPath\)\}'/);
  assert.doesNotMatch(dispatchIndexSrc, /'\$\{sq\(process\.execPath\)\}' '\$\{sq\(join\(__dirname, 'index\.mjs'\)\)\}' result --label/);
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

test('completion watcher preserves long normal completion payloads for downstream Telegram chunking', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-long-completion-'));
  const labelsPath = join(tempDir, 'labels.json');
  const mockDispatch = join(tempDir, 'mock-dispatch.mjs');
  const label = 'long-completion';
  const tailSentinel = 'TAIL_SENTINEL: validation tail survived delivery';
  const completionText = [
    'Summary:',
    'Completed the sports model validation and updated the guardrails.',
    '',
    'Root cause:',
    '- Completion delivery was clipping the final report before Telegram chunking could split it.',
    '- The scheduler already had downstream chunking, so the watcher-side ceiling was losing useful tail detail.',
    '',
    'Results:',
    ...Array.from({ length: 220 }, (_, i) => `- Detail ${String(i + 1).padStart(3, '0')}: ${'validated '.repeat(4)}normal completion report line.`),
    '',
    'Validation:',
    '- Focused delivery regression passed.',
    '- Tail content remained present past the old 3500-character watcher ceiling.',
    '',
    'Notes:',
    tailSentinel,
  ].join('\n');
  const watcherPath = join(__dirname, '..', 'dispatch', 'watcher.mjs');

  try {
    writeFileSync(labelsPath, JSON.stringify({
      [label]: {
        status: 'running',
        agent: 'main',
        spawnedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        timeoutSeconds: 600,
      },
    }) + '\n');
    writeFileSync(mockDispatch, `
const sub = process.argv[2];
const payload = {
  ok: true,
  label: ${JSON.stringify(label)},
  status: 'done',
  summary: ${JSON.stringify(completionText)},
  completion: {
    summary: ${JSON.stringify(completionText)},
    deliveryText: ${JSON.stringify(completionText)}
  }
};
if (sub === 'status' || sub === 'result') {
  process.stdout.write(JSON.stringify(payload) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);

    const run = spawnSync(process.execPath, [
      watcherPath, '--label', label, '--timeout', '600', '--poll-interval', '20', '--once',
    ], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_INDEX_PATH: mockDispatch,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.ok(completionText.length > 3500, 'fixture must exceed the old watcher truncation ceiling');
    assert.match(run.stdout, /^🌶️ \*dispatch\* \[long-completion\] completed:/);
    assert.match(run.stdout, /Completed the sports model validation/);
    assert.match(run.stdout, new RegExp(tailSentinel));
    assert.doesNotMatch(run.stdout, /\[truncated\]|\.\.\[truncated\]/i);
    assert.equal(labels[label].status, 'done');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('completion watcher spills oversized completion payloads with a full-report pointer', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-spill-completion-'));
  const labelsPath = join(tempDir, 'labels.json');
  const mockDispatch = join(tempDir, 'mock-dispatch.mjs');
  const artifactsDir = join(tempDir, 'artifacts');
  const label = 'spill-completion';
  const tailSentinel = 'TAIL_SENTINEL: oversized full report retained on disk';
  const completionText = [
    'Summary:',
    'Completed the oversized validation report.',
    '',
    'Results:',
    ...Array.from({ length: 120 }, (_, i) => `- Oversized detail ${i + 1}: ${'payload '.repeat(6)}line.`),
    '',
    'Notes:',
    tailSentinel,
  ].join('\n');
  const watcherPath = join(__dirname, '..', 'dispatch', 'watcher.mjs');

  try {
    writeFileSync(labelsPath, JSON.stringify({
      [label]: {
        status: 'running',
        agent: 'main',
        spawnedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        timeoutSeconds: 600,
      },
    }) + '\n');
    writeFileSync(mockDispatch, `
const sub = process.argv[2];
const payload = {
  ok: true,
  label: ${JSON.stringify(label)},
  status: 'done',
  summary: ${JSON.stringify(completionText)},
  completion: {
    summary: ${JSON.stringify(completionText)},
    deliveryText: ${JSON.stringify(completionText)}
  }
};
if (sub === 'status' || sub === 'result') {
  process.stdout.write(JSON.stringify(payload) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);

    const run = spawnSync(process.execPath, [
      watcherPath, '--label', label, '--timeout', '600', '--poll-interval', '20', '--once',
    ], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_INDEX_PATH: mockDispatch,
        DISPATCH_LABELS_PATH: labelsPath,
        SCHEDULER_ARTIFACTS_DIR: artifactsDir,
        DISPATCH_COMPLETION_INLINE_LIMIT_BYTES: '1200',
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /^🌶️ \*dispatch\* \[spill-completion\] completed:/);
    assert.match(run.stdout, /Completed the oversized validation report/);
    assert.match(run.stdout, /Full completion report saved to /);
    assert.match(run.stdout, /Inline delivery capped at 1200 bytes/);

    const artifactPath = run.stdout.match(/Full completion report saved to (.+?) \(\d+ bytes\)/)?.[1];
    assert.ok(artifactPath, 'spill delivery includes artifact path');
    const fullReport = readFileSync(artifactPath, 'utf8');
    assert.match(fullReport, new RegExp(tailSentinel));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test('completion watcher pending quick-poll tick is skipped without delivery failure', async () => {
  const logs = [];
  const result = await executeShell({
    id: 'job-deliver-pending',
    name: 'chilisaus-deliver:pending-result',
    payload_message: 'node watcher.mjs --once',
    delivery_mode: 'announce-always',
    run_timeout_ms: 30_000,
  }, { run: { id: 'run-deliver-pending' } }, {
    runShellCommand: async () => ({
      stdout: '',
      stderr: '[watcher] WATCHER_PENDING label=pending-result reason=target still running',
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

  assert.equal(result.status, 'skipped');
  assert.equal(result.skipDelivery, true);
  assert.equal(result.deliveryOverride, null);
  assert.equal(result.idemAction, 'release');
  assert.equal(logs.some(entry => /no deliverable stdout/.test(entry.msg)), false);
});

test('watcher --once exits quickly while target session is incomplete', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-once-incomplete-'));
  const labelsPath = join(tempDir, 'labels.json');
  const mockDispatch = join(tempDir, 'mock-dispatch.mjs');
  const label = 'quick-poll-incomplete';
  const sessionKey = 'agent:main:subagent:quick-poll';
  const watcherPath = join(__dirname, '..', 'dispatch', 'watcher.mjs');

  try {
    writeFileSync(labelsPath, JSON.stringify({
      [label]: {
        sessionKey,
        status: 'running',
        agent: 'main',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 600,
      },
    }) + '\n');
    writeFileSync(mockDispatch, `
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: ${JSON.stringify(label)},
    status: 'running',
    sessionKey: ${JSON.stringify(sessionKey)},
    agent: 'main',
    liveness: { ageMs: 5000 }
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);

    const started = Date.now();
    const run = spawnSync(process.execPath, [
      watcherPath, '--label', label, '--timeout', '600', '--poll-interval', '20', '--once',
    ], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_INDEX_PATH: mockDispatch,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsedMs = Date.now() - started;
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

    assert.equal(run.status, 0);
    assert.equal((run.stdout || '').trim(), '');
    assert.match(run.stderr || '', /WATCHER_PENDING/);
    assert.ok(elapsedMs < 2000, `watcher --once should exit quickly, elapsed=${elapsedMs}ms`);
    assert.equal(labels[label].status, 'running');
    assert.ok(labels[label].lastPing, 'watcher --once records one lastPing');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('watcher --once detects stale sessions despite fresh watcher lastPing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-once-stale-'));
  const labelsPath = join(tempDir, 'labels.json');
  const mockDispatch = join(tempDir, 'mock-dispatch.mjs');
  const label = 'quick-poll-stale';
  const sessionKey = 'agent:main:subagent:stale-session';
  const sessionId = 'stale-jsonl-id';
  const watcherPath = join(__dirname, '..', 'dispatch', 'watcher.mjs');
  const sessionsDir = join(tempDir, '.openclaw', 'agents', 'main', 'sessions');

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: new Date(Date.now() - 130 * 60 * 1000).toISOString(),
        model: 'test',
      },
    }) + '\n');
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'Still working.' }],
    }) + '\n');
    const staleDate = new Date(Date.now() - 130 * 60 * 1000);
    utimesSync(jsonlPath, staleDate, staleDate);
    writeFileSync(labelsPath, JSON.stringify({
      [label]: {
        sessionKey,
        status: 'running',
        agent: 'main',
        spawnedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        timeoutSeconds: 7200,
        lastPing: new Date().toISOString(),
      },
    }) + '\n');
    writeFileSync(mockDispatch, `
const sub = process.argv[2];
    if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: ${JSON.stringify(label)},
    status: 'running',
    sessionKey: ${JSON.stringify(sessionKey)},
    agent: 'main',
    liveness: { ageMs: ${130 * 60 * 1000} }
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);

    const run = spawnSync(process.execPath, [
      watcherPath, '--label', label, '--timeout', '7200', '--poll-interval', '20', '--once',
    ], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_INDEX_PATH: mockDispatch,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

    assert.equal(run.status, 0);
    assert.match(run.stdout || '', /agent session stalled/);
    assert.equal(labels[label].status, 'error');
    assert.match(labels[label].error, /agent session stalled/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('watcher --once probes high-thinking idle sessions without failing before idle failure window', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'watcher-once-high-probe-'));
  const labelsPath = join(tempDir, 'labels.json');
  const mockDispatch = join(tempDir, 'mock-dispatch.mjs');
  const label = 'quick-poll-high-probe';
  const sessionKey = 'agent:main:subagent:high-probe-session';
  const sessionId = 'high-probe-jsonl-id';
  const watcherPath = join(__dirname, '..', 'dispatch', 'watcher.mjs');
  const sessionsDir = join(tempDir, '.openclaw', 'agents', 'main', 'sessions');
  const staleMs = 16 * 60 * 1000;

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: new Date(Date.now() - staleMs).toISOString(),
        model: 'test',
      },
    }) + '\n');
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'Still working.' }],
    }) + '\n');
    const staleDate = new Date(Date.now() - staleMs);
    utimesSync(jsonlPath, staleDate, staleDate);
    writeFileSync(labelsPath, JSON.stringify({
      [label]: {
        sessionKey,
        status: 'running',
        agent: 'main',
        spawnedAt: new Date(Date.now() - staleMs).toISOString(),
        timeoutSeconds: 3600,
        thinking: 'high',
        lastPing: new Date().toISOString(),
      },
    }) + '\n');
    writeFileSync(mockDispatch, `
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: ${JSON.stringify(label)},
    status: 'running',
    sessionKey: ${JSON.stringify(sessionKey)},
    agent: 'main',
    liveness: { ageMs: ${staleMs} }
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);

    const run = spawnSync(process.execPath, [
      watcherPath, '--label', label, '--timeout', '3600', '--poll-interval', '20', '--once',
    ], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_INDEX_PATH: mockDispatch,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));

    assert.equal(run.status, 0);
    assert.equal((run.stdout || '').trim(), '');
    assert.match(run.stderr || '', /WATCHER_PENDING/);
    assert.equal(labels[label].status, 'running');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dispatch status keeps running when JSONL is fresher than sessions store', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dispatch-jsonl-live-'));
  const labelsPath = join(tempDir, 'labels.json');
  const sessionKey = 'agent:main:subagent:jsonl-live';
  const sessionId = 'jsonl-live-session';
  const sessionsDir = join(tempDir, '.openclaw', 'agents', 'main', 'sessions');
  const dispatchIndex = join(__dirname, '..', 'dispatch', 'index.mjs');
  const oldIso = new Date(Date.now() - 30 * 60_000).toISOString();

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(labelsPath, JSON.stringify({
      'jsonl-live': {
        sessionKey,
        runId: 'run-jsonl-live',
        agent: 'main',
        status: 'running',
        spawnedAt: oldIso,
        timeoutSeconds: 600,
        updatedAt: oldIso,
      },
    }, null, 2) + '\n');
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 30 * 60_000,
        sessionStartedAt: oldIso,
      },
    }, null, 2) + '\n');
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Still working.' }], stop_reason: 'tool_use' }) + '\n',
    );

    const run = spawnSync(process.execPath, [dispatchIndex, 'status', '--label', 'jsonl-live'], {
      env: {
        ...process.env,
        HOME: tempDir,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'running');
    assert.equal(result.syncAction, undefined);

    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    assert.equal(labels['jsonl-live'].status, 'running');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
