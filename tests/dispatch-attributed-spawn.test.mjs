import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDispatchGatewayTimeoutSeconds } from '../dispatch/liveness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');

const AGENT_SHELL = Object.freeze({ OPENCLAW_SHELL: 'exec' });
const SUBAGENT_SHELL = Object.freeze({ OPENCLAW_SUBAGENT_EXEC: '1' });
const CHAT = '100200300';
const CHILD_KEY = 'agent:main:subagent:0b7c2f4e-3d1a-4c55-9e0f-1a2b3c4d5e6f';
const GUARDED_METHODS = new Set(['agent', 'sessions.send', 'sessions.steer', 'chat.send', 'sessions.create']);

// Mirrors OpenClaw 2026.9.6 src/gateway/operator-cli-message-input.ts as seen
// through `openclaw gateway call --json`: a cli_error envelope on stdout, exit 1.
function buildFixture({ initDb = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-attributed-spawn-'));
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
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'spawn-test', spawnPollMax: 0 }));
  writeFileSync(join(root, '.openclaw', 'openclaw.json'), '{}\n');
  writeFileSync(labelsPath, '{}\n');

  const stubPath = join(binDir, 'openclaw');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    'const args = process.argv.slice(2);',
    "const paramsIndex = args.indexOf('--params');",
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    'const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : null;',
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, params }) + '\\n');`,
    "const agentExec = process.env.OPENCLAW_SHELL === 'exec';",
    "const subagentExec = process.env.OPENCLAW_SUBAGENT_EXEC === '1';",
    "const sessionMessage = ['sessions.send', 'sessions.steer', 'chat.send'].includes(method);",
    "const createsInitialTurn = method === 'sessions.create' && params",
    "  && (['message', 'task'].some((k) => typeof params[k] === 'string' && params[k].trim())",
    '    || (Array.isArray(params.attachments) && params.attachments.length > 0));',
    'let refusal = null;',
    'if (subagentExec && sessionMessage) {',
    "  refusal = 'Subagent session messages must use the task completion path. Return your result or blocker in the child turn; do not use the CLI to contact other sessions.';",
    "} else if (agentExec && (createsInitialTurn || sessionMessage || method === 'agent')) {",
    '  refusal = `Gateway ${method} from agent exec would lose inter-session attribution. `',
    "    + 'Use the attributed session-messaging tool available to this run, or return the result '",
    "    + 'through normal subagent completion. Do not retry through another CLI route or remove the exec marker.';",
    '}',
    'if (refusal) {',
    "  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'cli_error', message: refusal } }));",
    '  process.exit(1);',
    '}',
    "if (method === 'sessions.patch' && params?.model === 'rejected/model') {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'model not allowed' } }));",
    '  process.exit(1);',
    '}',
    "if (method === 'sessions.patch' && params?.key) {",
    "  const sessionsDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
    "  const sessionsPath = path.join(sessionsDir, 'sessions.json');",
    '  fs.mkdirSync(sessionsDir, { recursive: true });',
    '  let sessions = {};',
    "  try { sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')); } catch {}",
    "  sessions[params.key] = { ...(sessions[params.key] || {}), sessionId: 'session-gw', updatedAt: Date.now(), startedAt: Date.now() };",
    '  fs.writeFileSync(sessionsPath, JSON.stringify(sessions));',
    '}',
    "process.stdout.write(method === 'agent' ? JSON.stringify({ ok: true, runId: 'run-gw' }) : '{}');",
    '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  const fixture = { root, configDir, binDir, stateDir, labelsPath, callsPath, dbPath };
  // A deployed host already has the scheduler schema (completion debts, jobs).
  if (initDb) initSchedulerDb(fixture);
  return fixture;
}

function initSchedulerDb(fixture) {
  const init = spawnSync(process.execPath, [join(REPO_DIR, 'cli.js'), '--json', 'jobs', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.root, SCHEDULER_DB: fixture.dbPath },
  });
  assert.equal(init.status, 0, init.stderr);
}

// Delegates to the real scheduler CLI, but fails watchdog registration while
// the flag file exists: a partial arming after the watcher job was added.
function watchdogFailingCli(fixture) {
  const flagPath = join(fixture.root, 'fail-watchdog');
  const cliPath = join(fixture.root, 'scheduler-cli-wrapper.mjs');
  writeFileSync(cliPath, [
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `if (args.includes('--watchdog') && existsSync(${JSON.stringify(flagPath)})) {`,
    "  process.stderr.write('injected watchdog registration failure\\n');",
    '  process.exit(1);',
    '}',
    `const run = spawnSync(process.execPath, [${JSON.stringify(join(REPO_DIR, 'cli.js'))}, ...args], { stdio: 'inherit' });`,
    'process.exit(run.status ?? 1);',
    '',
  ].join('\n'));
  writeFileSync(flagPath, '');
  return { env: { OPENCLAW_SCHEDULER_CLI: cliPath }, flagPath };
}

// Simulates the session a sessions_spawn tool call created before adopt runs.
function seedSession(fixture, sessionKey) {
  const sessionsDir = join(fixture.root, '.openclaw', 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsPath = join(sessionsDir, 'sessions.json');
  const sessions = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, 'utf8')) : {};
  sessions[sessionKey] = { sessionId: 'session-child', updatedAt: Date.now(), startedAt: Date.now() };
  writeFileSync(sessionsPath, JSON.stringify(sessions));
}

function runDispatch(fixture, args, env = {}) {
  const base = { ...process.env };
  delete base.OPENCLAW_SHELL;
  delete base.OPENCLAW_SUBAGENT_EXEC;
  return spawnSync(process.execPath, [INDEX_PATH, ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
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
      ...env,
    },
  });
}

function readLabels(fixture) {
  return JSON.parse(readFileSync(fixture.labelsPath, 'utf8'));
}

function readCalls(fixture) {
  if (!existsSync(fixture.callsPath)) return [];
  return readFileSync(fixture.callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function jobNames(fixture) {
  const db = new Database(fixture.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name FROM jobs ORDER BY name').all().map(row => row.name);
  } finally {
    db.close();
  }
}

function enqueueArgs(label, extras = []) {
  return [
    'enqueue',
    '--label', label,
    '--message', 'Make the app-v2 theme the default and run the theme tests.',
    '--mode', 'fresh',
    '--thinking', 'high',
    '--timeout', '1200',
    '--deliver-to', CHAT,
    '--delivery-mode', 'announce',
    ...extras,
  ];
}

function parseJson(result) {
  assert.ok(result.stdout.trim(), `expected JSON on stdout; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

// A child that finished while its label was still awaiting adopt.
function finishBeforeAdopt(fixture, label, summary = 'Finished the requested change; checks pass.') {
  patchLabel(fixture, label, { preparedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  const done = runDispatch(fixture, [
    'done', '--label', label, '--summary', summary, '--checklist', '{"work_complete":true}',
  ], SUBAGENT_SHELL);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  return parseJson(done);
}

function outboxBodiesContaining(fixture, text) {
  const db = new Database(fixture.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox WHERE instr(body, ?) > 0').get(text).n;
  } finally {
    db.close();
  }
}

const HANDOFF_RUN_FIELDS = [
  'completedBeforeAdopt', 'completionScope', 'adoptedAt', 'arming', 'preparedAt', 'taskFile', 'taskSha256', 'monitor',
];

function outboxCount(fixture) {
  const db = new Database(fixture.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n;
  } finally {
    db.close();
  }
}

function patchLabel(fixture, label, patch) {
  const labels = readLabels(fixture);
  labels[label] = { ...labels[label], ...patch };
  writeFileSync(fixture.labelsPath, JSON.stringify(labels, null, 2) + '\n');
}

// OpenClaw 2026.9.6 tool contracts (src/agents/tools in the 9.6 tree). The
// plans must be valid tool input, and must leave completion delivery to
// dispatch's done signal and scheduler watcher.
const SESSIONS_SPAWN_PARAMS = new Set([ // sessions-spawn-tool.ts createSessionsSpawnToolSchema
  'task', 'taskName', 'label', 'runtime', 'agentId', 'model', 'runTimeoutSeconds', 'thinking', 'cwd',
  'mode', 'cleanup', 'expectsCompletionMessage', 'completionTarget', 'sandbox', 'context', 'lightContext',
  'attachments', 'attachAs',
]);
const SESSIONS_SPAWN_REJECTED = [ // UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS, plus timeoutSeconds
  'target', 'transport', 'channel', 'to', 'threadId', 'thread_id', 'replyTo', 'reply_to', 'timeoutSeconds',
];
const SESSIONS_SEND_PARAMS = new Set([ // sessions-send-tool.ts SessionsSendToolSchema
  'sessionKey', 'label', 'agentId', 'message', 'timeoutSeconds', 'watch', 'mode',
]);

function assertSessionsSpawnContract(params) {
  for (const key of Object.keys(params)) assert.ok(SESSIONS_SPAWN_PARAMS.has(key), `sessions_spawn has no parameter ${key}`);
  for (const key of SESSIONS_SPAWN_REJECTED) assert.equal(Object.hasOwn(params, key), false, `sessions_spawn rejects ${key}`);
  assert.ok(typeof params.task === 'string' && params.task.trim(), 'task is required');
  assert.equal(params.mode, 'run', 'session mode needs a thread-binding channel');
  assert.ok(['delete', 'keep'].includes(params.cleanup));
  assert.ok(Number.isInteger(params.runTimeoutSeconds) && params.runTimeoutSeconds >= 0);
  // Omitted, this defaults to true and OpenClaw hands the result to the requester.
  assert.equal(params.expectsCompletionMessage, false, 'dispatch delivers the completion');
}

function assertSessionsSendContract(params, mode) {
  for (const key of Object.keys(params)) assert.ok(SESSIONS_SEND_PARAMS.has(key), `sessions_send has no parameter ${key}`);
  assert.ok(typeof params.message === 'string' && params.message.trim(), 'message is required');
  assert.ok(['notify', 'steer', 'followup', 'resume'].includes(params.mode));
  assert.equal(params.mode, mode);
  // Omitted, timeoutSeconds is 30 for followup and the caller waits for the
  // child's reply inline; 0 returns once the turn is accepted.
  assert.equal(params.timeoutSeconds, 0, 'fire-and-forget: dispatch delivers the completion');
  assert.notEqual(params.watch, true);
}

test('enqueue from an agent exec shell prepares sessions_spawn and makes no Gateway calls', () => {
  const fixture = buildFixture();
  try {
    const label = 'app-v2-theme-default';
    const result = runDispatch(fixture, enqueueArgs(label, ['--model', 'test/model-a']), AGENT_SHELL);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readCalls(fixture), [], 'no agent, sessions.patch, or other Gateway call from the marked shell');

    const plan = parseJson(result);
    assert.equal(plan.ok, true);
    assert.equal(plan.status, 'awaiting-spawn');
    assert.equal(plan.label, label);
    assert.equal(plan.spawn.tool, 'sessions_spawn');
    const expectedRunTimeout = getDispatchGatewayTimeoutSeconds({
      timeoutSeconds: 1200,
      thinking: 'high',
      lane: 'subagent',
    });
    assertSessionsSpawnContract(plan.spawn.params);
    const { task, ...params } = plan.spawn.params;
    assert.deepEqual(params, {
      label,
      agentId: 'main',
      model: 'test/model-a',
      thinking: 'high',
      runTimeoutSeconds: expectedRunTimeout,
      mode: 'run',
      cleanup: 'keep',
      expectsCompletionMessage: false,
    });
    assert.match(task, /\[Subagent Task\]: ORIGIN_CHAT_ID: 100200300/);
    assert.match(task, new RegExp(`done --label '${label}'`));
    assert.match(task, /--checklist/);
    assert.match(task, /DELIVERY RULE/);
    assert.doesNotMatch(task, /CHECK_IN|tools\/invoke|curl /, 'no Gateway messaging from the child');
    assert.doesNotMatch(task, /\[Subagent Context\]/, 'OpenClaw supplies the subagent context');
    assert.match(plan.adopt.command, new RegExp(`'${INDEX_PATH}' adopt --label '${label}' --session-key <childSessionKey> --run-id <runId>$`));
    assert.match(plan.adopt.command, new RegExp(`DISPATCH_LABELS_PATH='${fixture.labelsPath}'`));
    assert.match(result.stderr, /no session started for \[app-v2-theme-default\]/);

    assert.equal(plan.taskFile.startsWith(join(fixture.stateDir, 'spawn-tasks') + '/'), true);
    assert.equal(statSync(plan.taskFile).mode & 0o777, 0o600, 'task file is private');
    const taskText = readFileSync(plan.taskFile, 'utf8');
    assert.equal(taskText, task);

    const row = readLabels(fixture)[label];
    assert.equal(row.status, 'awaiting-spawn');
    assert.equal(row.spawnVia, 'sessions_spawn');
    assert.equal(row.sessionKey, null);
    assert.equal(row.runId, null);
    assert.equal(row.spawnedAt, null);
    assert.equal(row.agent, 'main');
    assert.equal(row.mode, 'fresh');
    assert.equal(row.model, 'test/model-a');
    assert.equal(row.thinking, 'high');
    assert.equal(row.origin, `telegram:${CHAT}`);
    assert.equal(row.deliverTo, CHAT);
    assert.equal(row.deliverChannel, 'telegram');
    assert.equal(row.deliveryMode, 'announce');
    assert.equal(row.deliveryDisabled, false);
    assert.equal(row.timeoutSeconds, 1200);
    assert.equal(row.gatewayTimeoutSeconds, expectedRunTimeout);
    assert.equal(row.idleThresholdSeconds, 300);
    assert.deepEqual(row.monitor, { enabled: true, interval: '*/15 * * * *', timeoutMin: 60 });
    assert.match(row.taskPrompt, /Make the app-v2 theme the default/);
    assert.equal(row.taskFile, plan.taskFile);
    assert.equal(row.taskSha256, createHash('sha256').update(taskText).digest('hex'));
    assert.ok(Date.parse(row.preparedAt) > 0);
    assert.deepEqual(jobNames(fixture), [], 'no watcher or watchdog before adopt');

    const status = runDispatch(fixture, ['status', '--label', label], AGENT_SHELL);
    assert.equal(status.status, 0, status.stderr);
    const view = parseJson(status);
    assert.equal(view.status, 'awaiting-spawn');
    assert.equal(view.stale, false);
    assert.equal(view.liveness, null);
    assert.match(view.message, /call sessions_spawn and run adopt/);
    assert.deepEqual(readCalls(fixture), [], 'status does not probe a session for a pending row');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a subagent exec shell also selects the tool route', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('subagent-shell'), SUBAGENT_SHELL);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(parseJson(result).spawn.tool, 'sessions_spawn');
    assert.deepEqual(readCalls(fixture), []);
    assert.equal(readLabels(fixture)['subagent-shell'].status, 'awaiting-spawn');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('adopt arms the watcher and watchdog once, and refuses a different key', () => {
  const fixture = buildFixture();
  try {
    const label = 'adopt-me';
    const prepared = runDispatch(fixture, enqueueArgs(label), AGENT_SHELL);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    seedSession(fixture, CHILD_KEY);

    const adopted = runDispatch(fixture, [
      'adopt', '--label', label, '--session-key', CHILD_KEY, '--run-id', 'run-child-1',
    ], AGENT_SHELL);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    const accepted = parseJson(adopted);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.adopted, true);
    assert.equal(accepted.spawnVia, 'sessions_spawn');
    assert.equal(accepted.sessionKey, CHILD_KEY);
    assert.equal(accepted.runId, 'run-child-1');
    assert.equal(accepted.delivery.status, 'enabled');
    assert.equal(accepted.delivery.scheduler, true);
    assert.equal(accepted.delivery.gateway, false);
    assert.equal(accepted.watchdog.enabled, true);
    assert.ok(accepted.watchdog.jobId);
    assert.match(accepted.message, /Session adopted\. Delivery via scheduler watcher\./);

    const guarded = readCalls(fixture).filter(call => GUARDED_METHODS.has(call.method) || call.method === 'sessions.patch');
    assert.deepEqual(guarded, [], 'adopt makes no guarded Gateway call');
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);

    const row = readLabels(fixture)[label];
    assert.equal(row.status, 'running');
    assert.equal(row.sessionKey, CHILD_KEY);
    assert.equal(row.runId, 'run-child-1');
    assert.ok(Date.parse(row.spawnedAt) > 0);
    assert.ok(row.deliveryWatcherJobId);
    assert.equal(row.watchdogJobId, accepted.watchdog.jobId);

    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      const debt = db.prepare('SELECT session_key, status FROM completion_debts WHERE task_label = ?').get(label);
      assert.deepEqual(debt, { session_key: CHILD_KEY, status: 'tracking' }, 'delivery claim reserved for this run');
    } finally {
      db.close();
    }

    const again = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.equal(parseJson(again).alreadyAdopted, true);
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`], 're-adopt registers nothing');

    const otherKey = 'agent:main:subagent:99999999-8888-4777-8666-555555555555';
    const conflict = runDispatch(fixture, ['adopt', '--label', label, '--session-key', otherKey], AGENT_SHELL);
    assert.equal(conflict.status, 1, conflict.stderr || conflict.stdout);
    assert.match(conflict.stderr, /is running with session .*refusing to adopt/);
    assert.equal(readLabels(fixture)[label].sessionKey, CHILD_KEY);

    const status = runDispatch(fixture, ['status', '--label', label], AGENT_SHELL);
    assert.equal(parseJson(status).status, 'running');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('adopt refuses an unprepared label, another agent\'s key, and a non-child key', () => {
  const fixture = buildFixture();
  try {
    const missing = runDispatch(fixture, ['adopt', '--label', 'never-enqueued', '--session-key', CHILD_KEY]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No awaiting-spawn dispatch for label "never-enqueued"/);
    assert.deepEqual(readLabels(fixture), {});

    const label = 'agent-bound';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    const wrongAgent = runDispatch(fixture, [
      'adopt', '--label', label, '--session-key', 'agent:kebab:subagent:0b7c2f4e-3d1a-4c55-9e0f-1a2b3c4d5e6f',
    ]);
    assert.equal(wrongAgent.status, 2);
    assert.match(wrongAgent.stderr, /agent "kebab" does not match agent_id "main"/);

    const notChild = runDispatch(fixture, ['adopt', '--label', label, '--session-key', 'agent:main:main']);
    assert.equal(notChild.status, 2);
    assert.match(notChild.stderr, /childSessionKey sessions_spawn returned/);

    assert.equal(readLabels(fixture)[label].status, 'awaiting-spawn');
    assert.deepEqual(jobNames(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('--spawn-via gateway from an agent shell reports the refusal and records nothing', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('forced-gateway', ['--spawn-via', 'gateway']), AGENT_SHELL);
    assert.equal(result.status, 3, result.stderr || result.stdout);
    const failure = parseJson(result);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'ATTRIBUTED_SPAWN_REQUIRED');
    assert.equal(failure.error.method, 'agent');
    assert.match(failure.error.gatewayError, /would lose inter-session attribution/);
    assert.match(failure.error.message, /--spawn-via tool/);
    assert.match(result.stderr, /ATTRIBUTED_SPAWN_REQUIRED/);
    // The unguarded thinking patch precedes the refused turn, as it must for a
    // Gateway spawn to start with the requested settings.
    assert.deepEqual(readCalls(fixture).map(call => call.method), ['sessions.patch', 'agent']);
    assert.deepEqual(readLabels(fixture), {}, 'no ledger row');
    assert.deepEqual(jobNames(fixture), [], 'no watcher or watchdog');

    const invalid = runDispatch(fixture, enqueueArgs('bad-route', ['--spawn-via', 'curl']), AGENT_SHELL);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--spawn-via must be auto, gateway, or tool/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an unmarked shell keeps the Gateway spawn', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('unmarked', ['--model', 'test/model-a']));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const accepted = parseJson(result);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.runId, 'run-gw');
    assert.match(accepted.message, /Session spawned\. Delivery via scheduler \(primary\) \+ gateway \(secondary\)\./);
    const methods = readCalls(fixture).map(call => call.method);
    assert.deepEqual(methods.filter(method => method !== 'chat.history'), ['sessions.patch', 'sessions.patch', 'agent']);
    const agentCall = readCalls(fixture).find(call => call.method === 'agent').params;
    assert.match(agentCall.message, /^\[Subagent Context\]/);
    assert.match(agentCall.message, /CHECK_IN/);
    const row = readLabels(fixture).unmarked;
    assert.equal(row.status, 'running');
    assert.equal(row.spawnVia, 'gateway');
    assert.deepEqual(jobNames(fixture), ['spawn-test-deliver:unmarked', 'watchdog:unmarked']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('send and steer from an agent shell print a sessions_send call for the stored session', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(fixture.labelsPath, JSON.stringify({
      running: { sessionKey: CHILD_KEY, agent: 'main', status: 'running' },
    }));
    const send = runDispatch(fixture, ['send', '--label', 'running', '--message', 'Focus on the failing test'], AGENT_SHELL);
    assert.equal(send.status, 0, send.stderr || send.stdout);
    const handoff = parseJson(send);
    assert.equal(handoff.status, 'handoff');
    assert.equal(handoff.tool, 'sessions_send');
    assertSessionsSendContract(handoff.params, 'followup');
    assert.equal(handoff.params.sessionKey, CHILD_KEY, 'the stored session');
    assert.equal(handoff.params.message, 'Focus on the failing test');

    const steer = runDispatch(fixture, ['steer', '--label', 'running', '--message', 'Switch approach'], SUBAGENT_SHELL);
    assert.equal(steer.status, 0, steer.stderr || steer.stdout);
    const steerPlan = parseJson(steer);
    assertSessionsSendContract(steerPlan.params, 'steer');
    assert.equal(steerPlan.params.sessionKey, CHILD_KEY);
    assert.match(steerPlan.message, /if the child is idle, use send/);
    assert.deepEqual(readCalls(fixture), [], 'no Gateway agent call');

    const forced = runDispatch(fixture, ['send', '--label', 'running', '--message', 'x', '--send-via', 'gateway'], AGENT_SHELL);
    assert.equal(forced.status, 3, forced.stderr || forced.stdout);
    assert.equal(parseJson(forced).error.code, 'ATTRIBUTED_SPAWN_REQUIRED');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('enqueue --mode reuse from an agent shell prepares sessions_send and adopt keeps the key', () => {
  const fixture = buildFixture();
  try {
    const label = 'continue-me';
    writeFileSync(fixture.labelsPath, JSON.stringify({
      [label]: {
        sessionKey: CHILD_KEY,
        agent: 'main',
        status: 'done',
        completion: { summary: 'previous run' },
        completionDeliveredAt: new Date().toISOString(),
      },
    }));
    const result = runDispatch(fixture, [
      'enqueue', '--label', label, '--message', 'Now add the dark variant.',
      '--mode', 'reuse', '--timeout', '600', '--deliver-to', CHAT,
    ], AGENT_SHELL);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = parseJson(result);
    assert.equal(plan.spawn.tool, 'sessions_send');
    assertSessionsSendContract(plan.spawn.params, 'followup');
    assert.equal(plan.spawn.params.sessionKey, CHILD_KEY);
    assert.match(plan.spawn.params.message, /Now add the dark variant\./);
    assert.match(plan.message, /do not repost it/);
    assert.match(plan.adopt.command, new RegExp(`--session-key '${CHILD_KEY}' --run-id <runId>$`));
    assert.deepEqual(readCalls(fixture), []);

    const row = readLabels(fixture)[label];
    assert.equal(row.status, 'awaiting-spawn');
    assert.equal(row.spawnVia, 'sessions_send');
    assert.equal(row.sessionKey, CHILD_KEY);
    assert.equal(row.completion, null, 'previous completion cleared');
    assert.equal(row.completionDeliveredAt, null, 'previous delivery receipt cleared');

    const otherKey = 'agent:main:subagent:99999999-8888-4777-8666-555555555555';
    const wrong = runDispatch(fixture, ['adopt', '--label', label, '--session-key', otherKey]);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /must be the label's session/);

    seedSession(fixture, CHILD_KEY);
    const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY, '--run-id', 'run-followup']);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    assert.equal(parseJson(adopted).spawnVia, 'sessions_send');
    assert.equal(readLabels(fixture)[label].status, 'running');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('status marks an old awaiting-spawn row stale without deleting it', () => {
  const fixture = buildFixture();
  try {
    const preparedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeFileSync(fixture.labelsPath, JSON.stringify({
      forgotten: { agent: 'main', status: 'awaiting-spawn', spawnVia: 'sessions_spawn', preparedAt },
    }));
    const result = runDispatch(fixture, ['status', '--label', 'forgotten']);
    assert.equal(result.status, 0, result.stderr);
    const view = parseJson(result);
    assert.equal(view.stale, true);
    assert.ok(view.ageSeconds >= 20 * 60);
    assert.match(view.message, /never adopted/);
    assert.equal(readLabels(fixture).forgotten.status, 'awaiting-spawn');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('adopt finishes a partial arming: a repeat registers only the missing watchdog', () => {
  const fixture = buildFixture();
  try {
    const label = 'partial-arming';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);
    const failing = watchdogFailingCli(fixture);

    const first = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY, '--run-id', 'run-1'], {
      ...AGENT_SHELL, ...failing.env,
    });
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const partial = parseJson(first);
    assert.equal(partial.ok, false);
    assert.equal(partial.error.code, 'ADOPT_ARMING_INCOMPLETE');
    assert.deepEqual(partial.arming, { complete: false, missing: ['watchdog'] });
    assert.match(partial.message, /run adopt again with the same session key/);
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`]);
    let row = readLabels(fixture)[label];
    assert.equal(row.status, 'running');
    assert.ok(row.arming.watcherArmedAt && row.arming.claimReservedAt);
    assert.equal(row.arming.watchdogArmedAt, undefined);
    assert.equal(row.arming.armedAt, undefined);

    rmSync(failing.flagPath);
    const second = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], {
      ...AGENT_SHELL, ...failing.env,
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const finished = parseJson(second);
    assert.equal(finished.ok, true);
    assert.equal(finished.rearmed, true);
    assert.deepEqual(finished.arming, { complete: true, missing: [] });
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`], 'watcher not registered twice');
    row = readLabels(fixture)[label];
    assert.ok(row.arming.armedAt);
    assert.equal(row.watchdogJobId, finished.watchdog.jobId);
    assert.equal(row.runId, 'run-1');

    const third = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(third.status, 0, third.stderr || third.stdout);
    assert.equal(parseJson(third).alreadyAdopted, true);
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('adopt after a crash between the ledger transition and arming arms each job once', () => {
  const fixture = buildFixture();
  try {
    const label = 'crashed-adopt';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);
    // The state an adopt leaves when it dies right after its ledger write.
    const now = new Date().toISOString();
    patchLabel(fixture, label, {
      status: 'running', sessionKey: CHILD_KEY, runId: 'run-2', spawnedAt: now, adoptedAt: now,
      arming: { sessionKey: CHILD_KEY },
    });

    const resumed = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const accepted = parseJson(resumed);
    assert.equal(accepted.rearmed, true);
    assert.equal(accepted.runId, 'run-2');
    assert.deepEqual(accepted.arming, { complete: true, missing: [] });
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);

    const again = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(parseJson(again).alreadyAdopted, true);
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failed completion-claim reservation is reported, and a repeat adopt reserves it', () => {
  const fixture = buildFixture({ initDb: false });
  try {
    const label = 'claim-first';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);

    // No scheduler schema yet: the claim write fails, then the job
    // registration through the scheduler CLI creates the schema.
    const first = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(first.status, 1, first.stderr || first.stdout);
    assert.deepEqual(parseJson(first).arming, { complete: false, missing: ['claim'] });
    assert.match(first.stderr, /completion debt reservation failed/);
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);

    const second = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(parseJson(second).arming, { complete: true, missing: [] });
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`], 'no job registered twice');
    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT session_key FROM completion_debts WHERE task_label = ?').get(label).session_key, CHILD_KEY);
    } finally {
      db.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('before adopt, status, sync, stuck, and the watcher leave the label alone, and done delivers once', () => {
  const fixture = buildFixture();
  try {
    const label = 'fast-child';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    const pendingRow = readLabels(fixture)[label];

    const sync = runDispatch(fixture, ['sync']);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(parseJson(sync).changes, 0);
    const stuck = runDispatch(fixture, ['stuck', '--threshold-min', '0']);
    assert.equal(stuck.status, 0, stuck.stderr || stuck.stdout);
    assert.equal(parseJson(stuck).stuck_count, 0);
    const watcher = spawnSync(process.execPath, [
      join(REPO_DIR, 'dispatch', 'watcher.mjs'), '--label', label, '--timeout', '60', '--once',
    ], {
      encoding: 'utf8',
      timeout: 45_000,
      env: {
        ...process.env,
        HOME: fixture.root,
        PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
        DISPATCH_CONFIG_DIR: fixture.configDir,
        DISPATCH_STATE_DIR: fixture.stateDir,
        DISPATCH_LABELS_PATH: fixture.labelsPath,
        SCHEDULER_DB: fixture.dbPath,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
    });
    assert.equal(watcher.status, 0, watcher.stderr);
    assert.match(watcher.stderr, /WATCHER_PENDING label=fast-child reason=label awaiting adopt/);
    assert.equal(watcher.stdout, '');
    assert.deepEqual(readLabels(fixture)[label], pendingRow, 'nothing touched the pending row');

    const doneArgs = [
      'done', '--label', label, '--summary', 'Made app-v2 the default theme; theme tests pass.',
      '--checklist', '{"work_complete":true}',
    ];
    const tooSoon = runDispatch(fixture, doneArgs, SUBAGENT_SHELL);
    assert.equal(tooSoon.status, 1);
    assert.match(tooSoon.stderr, /Session ran for only/, 'the runtime guard counts from preparation');

    patchLabel(fixture, label, { preparedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    const done = runDispatch(fixture, doneArgs, SUBAGENT_SHELL);
    assert.equal(done.status, 0, done.stderr || done.stdout);
    assert.equal(parseJson(done).delivery.delivered, true);
    let row = readLabels(fixture)[label];
    assert.equal(row.status, 'done');
    assert.equal(row.completedBeforeAdopt, true);
    assert.ok(pendingRow.preparedRunId, 'prepare mints a run id');
    assert.deepEqual(row.completionScope, { sessionKey: null, runId: pendingRow.preparedRunId });
    assert.ok(row.completionDeliveredAt);
    const delivered = outboxCount(fixture);
    assert.ok(delivered > 0, 'done enqueued the completion');

    const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY, '--run-id', 'run-3'], AGENT_SHELL);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    const report = parseJson(adopted);
    assert.equal(report.status, 'done');
    assert.equal(report.completedBeforeAdopt, true);
    assert.equal(report.delivery.delivered, true);
    row = readLabels(fixture)[label];
    assert.equal(row.sessionKey, CHILD_KEY);
    assert.equal(row.runId, 'run-3');
    assert.deepEqual(jobNames(fixture), [], 'a finished run gets no watcher or watchdog');
    assert.equal(outboxCount(fixture), delivered, 'adopt did not deliver again');

    const again = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(parseJson(again).alreadyAdopted, true);
    const other = runDispatch(fixture, ['adopt', '--label', label, '--session-key', 'agent:main:subagent:99999999-8888-4777-8666-555555555555']);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /is done with session .*refusing to adopt/);
    assert.equal(outboxCount(fixture), delivered);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a leftover watcher does not deliver the previous turn while a continuation awaits adopt', () => {
  const fixture = buildFixture();
  try {
    const label = 'continued';
    // The previous run finished cleanly in CHILD_KEY and its reply is on disk.
    const sessionsDir = join(fixture.root, '.openclaw', 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [CHILD_KEY]: { sessionId: 'session-previous', updatedAt: Date.now() - 60_000, status: 'done' },
    }));
    writeFileSync(join(sessionsDir, 'session-previous.jsonl'), [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Make app-v2 the default theme.' }] }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Previous run: theme switched.' }], stop_reason: 'end_turn' }),
    ].join('\n') + '\n');
    writeFileSync(fixture.labelsPath, JSON.stringify({
      [label]: { sessionKey: CHILD_KEY, agent: 'main', status: 'done', deliverTo: CHAT, deliverChannel: 'telegram' },
    }));
    const prepared = runDispatch(fixture, [
      'enqueue', '--label', label, '--message', 'Now add the dark variant.', '--mode', 'reuse',
      '--timeout', '600', '--deliver-to', CHAT,
    ], AGENT_SHELL);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const pendingRow = readLabels(fixture)[label];

    const watcher = spawnSync(process.execPath, [
      join(REPO_DIR, 'dispatch', 'watcher.mjs'), '--label', label, '--timeout', '60', '--once',
    ], {
      encoding: 'utf8',
      timeout: 45_000,
      env: {
        ...process.env,
        HOME: fixture.root,
        PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
        DISPATCH_CONFIG_DIR: fixture.configDir,
        DISPATCH_STATE_DIR: fixture.stateDir,
        DISPATCH_LABELS_PATH: fixture.labelsPath,
        SCHEDULER_DB: fixture.dbPath,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
    });
    assert.equal(watcher.status, 0, watcher.stderr);
    assert.match(watcher.stderr, /reason=label awaiting adopt/);
    assert.equal(outboxCount(fixture), 0, 'the previous turn is not delivered as this run');
    assert.deepEqual(readLabels(fixture)[label], pendingRow);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('adopt retries a completion that done could not deliver, under done\'s scope, once', () => {
  const fixture = buildFixture({ initDb: false });
  try {
    const label = 'fast-child-undelivered';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    patchLabel(fixture, label, { preparedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    // No completion tables yet, so done records the result but cannot enqueue it.
    const done = runDispatch(fixture, [
      'done', '--label', label, '--summary', 'Made app-v2 the default theme; theme tests pass.',
      '--checklist', '{"work_complete":true}',
    ], SUBAGENT_SHELL);
    assert.equal(done.status, 0, done.stderr || done.stdout);
    assert.equal(parseJson(done).delivery.delivered, false);
    assert.equal(readLabels(fixture)[label].completionDeliveredAt ?? null, null);

    initSchedulerDb(fixture);
    const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    assert.equal(parseJson(adopted).delivery.delivered, true);
    assert.ok(readLabels(fixture)[label].completionDeliveredAt);
    const delivered = outboxCount(fixture);
    assert.ok(delivered > 0);

    const again = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(parseJson(again).alreadyAdopted, true);
    assert.equal(outboxCount(fixture), delivered, 'delivered once');
    assert.deepEqual(jobNames(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const CHILD_KEY_2 = 'agent:main:subagent:1c8d3f5a-4e2b-4d66-8f10-2b3c4d5e6f70';

test('label reuse: a run that finished before adopt does not leak into the next run\'s arming retry', () => {
  const fixture = buildFixture();
  try {
    const label = 'reused-after-done-first';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    finishBeforeAdopt(fixture, label);
    const first = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(parseJson(first).completedBeforeAdopt, true);
    const delivered = outboxCount(fixture);

    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    const pending = readLabels(fixture)[label];
    assert.equal(pending.status, 'awaiting-spawn');
    for (const field of ['completedBeforeAdopt', 'completionScope', 'adoptedAt', 'arming']) {
      assert.equal(Object.hasOwn(pending, field), false, `${field} from the previous run is cleared`);
    }

    seedSession(fixture, CHILD_KEY_2);
    const failing = watchdogFailingCli(fixture);
    const partial = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY_2], {
      ...AGENT_SHELL, ...failing.env,
    });
    assert.equal(partial.status, 1, partial.stderr || partial.stdout);
    assert.deepEqual(parseJson(partial).arming, { complete: false, missing: ['watchdog'] });

    rmSync(failing.flagPath);
    const retry = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY_2], {
      ...AGENT_SHELL, ...failing.env,
    });
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    const armed = parseJson(retry);
    assert.equal(armed.status, 'accepted', 'the running run is armed, not reported as finished');
    assert.equal(armed.rearmed, true);
    assert.equal(armed.completedBeforeAdopt, undefined);
    assert.deepEqual(armed.arming, { complete: true, missing: [] });
    assert.deepEqual(jobNames(fixture), [`spawn-test-deliver:${label}`, `watchdog:${label}`]);

    assert.equal(parseJson(runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY_2], AGENT_SHELL)).alreadyAdopted, true);
    assert.equal(outboxCount(fixture), delivered, 'nothing delivered for the running run');
    assert.equal(readLabels(fixture)[label].status, 'running');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: after an adopted run, a run that finishes before adopt still binds its key', () => {
  const fixture = buildFixture();
  try {
    const label = 'reused-after-adopt';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);
    assert.equal(runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL).status, 0);

    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    finishBeforeAdopt(fixture, label);
    const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY_2], AGENT_SHELL);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    const report = parseJson(adopted);
    assert.equal(report.completedBeforeAdopt, true);
    assert.equal(report.sessionKey, CHILD_KEY_2);
    assert.equal(readLabels(fixture)[label].sessionKey, CHILD_KEY_2);
    assert.equal(parseJson(runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY_2], AGENT_SHELL)).alreadyAdopted, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: a Gateway run after a tool-route run starts without handoff state', () => {
  const fixture = buildFixture();
  try {
    const label = 'tool-then-gateway';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    finishBeforeAdopt(fixture, label);
    assert.equal(runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL).status, 0);

    const gateway = runDispatch(fixture, enqueueArgs(label));
    assert.equal(gateway.status, 0, gateway.stderr || gateway.stdout);
    const row = readLabels(fixture)[label];
    assert.equal(row.status, 'running');
    assert.equal(row.spawnVia, 'gateway');
    for (const field of HANDOFF_RUN_FIELDS) {
      assert.equal(Object.hasOwn(row, field), false, `${field} from the tool-route run is cleared`);
    }
    const jobsBefore = jobNames(fixture);

    const same = runDispatch(fixture, ['adopt', '--label', label, '--session-key', row.sessionKey], AGENT_SHELL);
    assert.equal(same.status, 0, same.stderr || same.stdout);
    assert.equal(parseJson(same).alreadyAdopted, true, 'a Gateway run is never re-armed or reported as finished');
    const stale = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /refusing to adopt/);
    assert.deepEqual(jobNames(fixture), jobsBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: a tool-route run after a Gateway run arms its own session', () => {
  const fixture = buildFixture();
  try {
    const label = 'gateway-then-tool';
    assert.equal(runDispatch(fixture, enqueueArgs(label)).status, 0);
    const gatewayKey = readLabels(fixture)[label].sessionKey;

    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    const pending = readLabels(fixture)[label];
    assert.equal(pending.status, 'awaiting-spawn');
    assert.equal(pending.sessionKey, null);
    assert.equal(Object.hasOwn(pending, 'arming'), false);

    seedSession(fixture, CHILD_KEY);
    const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    assert.deepEqual(parseJson(adopted).arming, { complete: true, missing: [] });
    const row = readLabels(fixture)[label];
    assert.equal(row.arming.sessionKey, CHILD_KEY);
    assert.equal(row.spawnVia, 'sessions_spawn');
    assert.notEqual(row.sessionKey, gatewayKey);
    // The Gateway run's jobs stay registered, as when a Gateway run is replaced.
    assert.deepEqual(jobNames(fixture), [
      `spawn-test-deliver:${label}`, `spawn-test-deliver:${label}`, `watchdog:${label}`, `watchdog:${label}`,
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: a Gateway continuation of a partially armed run is not re-armed by a stale adopt', () => {
  const fixture = buildFixture();
  try {
    const label = 'partial-then-gateway-reuse';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);
    const failing = watchdogFailingCli(fixture);
    const partial = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], {
      ...AGENT_SHELL, ...failing.env,
    });
    assert.equal(partial.status, 1, partial.stderr || partial.stdout);
    rmSync(failing.flagPath);

    // The scheduler's own redispatch continues the same session through the Gateway.
    const continued = runDispatch(fixture, [
      'enqueue', '--label', label, '--message', 'Continue.', '--mode', 'reuse', '--timeout', '1200',
      '--deliver-to', CHAT, '--spawn-via', 'gateway',
    ]);
    assert.equal(continued.status, 0, continued.stderr || continued.stdout);
    const row = readLabels(fixture)[label];
    assert.equal(row.sessionKey, CHILD_KEY);
    assert.equal(row.spawnVia, 'gateway');
    assert.equal(Object.hasOwn(row, 'arming'), false);
    const jobsBefore = jobNames(fixture);
    assert.deepEqual(jobsBefore, [`spawn-test-deliver:${label}`, `spawn-test-deliver:${label}`, `watchdog:${label}`]);

    const stale = runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL);
    assert.equal(stale.status, 0, stale.stderr || stale.stdout);
    assert.equal(parseJson(stale).alreadyAdopted, true);
    assert.deepEqual(jobNames(fixture), jobsBefore, 'no second watchdog for the Gateway run');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a tool-route continuation applies requested model and thinking with sessions.patch first', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(fixture.labelsPath, JSON.stringify({
      cont: { sessionKey: CHILD_KEY, agent: 'main', status: 'done' },
    }));
    const result = runDispatch(fixture, [
      'enqueue', '--label', 'cont', '--message', 'Add the dark variant.', '--mode', 'reuse',
      '--model', 'test/model-b', '--thinking', 'high', '--timeout', '600', '--deliver-to', CHAT,
    ], AGENT_SHELL);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readCalls(fixture), [
      { method: 'sessions.patch', params: { key: CHILD_KEY, model: 'test/model-b' } },
      { method: 'sessions.patch', params: { key: CHILD_KEY, thinkingLevel: 'high' } },
    ], 'overrides applied to the continued session; no agent call');
    const plan = parseJson(result);
    assertSessionsSendContract(plan.spawn.params, 'followup');
    const row = readLabels(fixture).cont;
    assert.equal(row.model, 'test/model-b');
    assert.equal(row.thinking, 'high');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a rejected override aborts a tool-route continuation before anything is recorded', () => {
  const fixture = buildFixture();
  try {
    const before = { cont: { sessionKey: CHILD_KEY, agent: 'main', status: 'done' } };
    writeFileSync(fixture.labelsPath, JSON.stringify(before));
    const result = runDispatch(fixture, [
      'enqueue', '--label', 'cont', '--message', 'Add the dark variant.', '--mode', 'reuse',
      '--model', 'rejected/model', '--timeout', '600', '--deliver-to', CHAT,
    ], AGENT_SHELL);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /sessions\.patch \(model\) failed: .*model not allowed/);
    assert.equal(result.stdout, '', 'no plan printed');
    assert.deepEqual(readLabels(fixture), before, 'no pending row');
    assert.equal(existsSync(join(fixture.stateDir, 'spawn-tasks')), false, 'no task file');
    assert.deepEqual(readCalls(fixture).map(call => call.method), ['sessions.patch']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: two runs that finish before adopt are each delivered exactly once', () => {
  const fixture = buildFixture();
  try {
    const label = 'twice-done-first';
    const runs = [
      { key: CHILD_KEY, summary: 'Run one: switched the default theme.' },
      { key: CHILD_KEY_2, summary: 'Run two: added the dark variant.' },
    ];
    for (const run of runs) {
      assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
      const done = finishBeforeAdopt(fixture, label, run.summary);
      assert.equal(done.delivery.delivered, true, `${run.summary} enqueued by done`);
      const adopted = runDispatch(fixture, ['adopt', '--label', label, '--session-key', run.key], AGENT_SHELL);
      assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
      const report = parseJson(adopted);
      assert.equal(report.ok, true);
      assert.equal(report.completedBeforeAdopt, true);
      assert.equal(report.delivery.delivered, true);
    }
    for (const run of runs) {
      assert.equal(outboxBodiesContaining(fixture, run.summary), 1, `${run.summary} delivered exactly once`);
    }
    const scopes = new Set(Object.values(readLabels(fixture)).map(row => JSON.stringify(row.completionScope)));
    assert.equal(scopes.size, 1, 'one label row');
    assert.notEqual(readLabels(fixture)[label].completionScope.runId, null, 'the prepared run id scopes the claim');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('label reuse: two adopted continuations of one session without --run-id are each delivered once', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(fixture.labelsPath, JSON.stringify({
      cont: { sessionKey: CHILD_KEY, agent: 'main', status: 'done' },
    }));
    seedSession(fixture, CHILD_KEY);
    const summaries = ['Continuation one: added tests.', 'Continuation two: fixed the flaky case.'];
    const runIds = [];
    for (const summary of summaries) {
      const prepared = runDispatch(fixture, [
        'enqueue', '--label', 'cont', '--message', 'Continue.', '--mode', 'reuse', '--timeout', '600', '--deliver-to', CHAT,
      ], AGENT_SHELL);
      assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
      const adopted = runDispatch(fixture, ['adopt', '--label', 'cont', '--session-key', CHILD_KEY], AGENT_SHELL);
      assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
      runIds.push(parseJson(adopted).runId);
      patchLabel(fixture, 'cont', { preparedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
      const done = runDispatch(fixture, [
        'done', '--label', 'cont', '--summary', summary, '--checklist', '{"work_complete":true}',
      ], SUBAGENT_SHELL);
      assert.equal(done.status, 0, done.stderr || done.stdout);
      assert.equal(parseJson(done).delivery.delivered, true);
    }
    assert.ok(runIds.every(Boolean) && runIds[0] !== runIds[1], 'each run has its own id without --run-id');
    for (const summary of summaries) {
      assert.equal(outboxBodiesContaining(fixture, summary), 1, `${summary} delivered exactly once`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('done after adopt measures its runtime guard from preparation, not from adopt', () => {
  const fixture = buildFixture();
  try {
    const label = 'guard-from-prepare';
    assert.equal(runDispatch(fixture, enqueueArgs(label), AGENT_SHELL).status, 0);
    seedSession(fixture, CHILD_KEY);
    // The parent took five minutes to run adopt; the child had been working since.
    patchLabel(fixture, label, { preparedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    assert.equal(runDispatch(fixture, ['adopt', '--label', label, '--session-key', CHILD_KEY], AGENT_SHELL).status, 0);
    const done = runDispatch(fixture, [
      'done', '--label', label, '--summary', 'Theme switched; tests pass.', '--checklist', '{"work_complete":true}',
    ], SUBAGENT_SHELL);
    assert.equal(done.status, 0, done.stderr || done.stdout);
    assert.equal(readLabels(fixture)[label].status, 'done');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
