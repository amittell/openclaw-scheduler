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
function buildFixture() {
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

  // A deployed host already has the scheduler schema (completion debts, jobs).
  const init = spawnSync(process.execPath, [join(REPO_DIR, 'cli.js'), '--json', 'jobs', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: root, SCHEDULER_DB: dbPath },
  });
  assert.equal(init.status, 0, init.stderr);

  return { root, configDir, binDir, stateDir, labelsPath, callsPath, dbPath };
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
    assert.deepEqual(handoff.params, { sessionKey: CHILD_KEY, message: 'Focus on the failing test', mode: 'followup' });

    const steer = runDispatch(fixture, ['steer', '--label', 'running', '--message', 'Switch approach'], SUBAGENT_SHELL);
    assert.equal(steer.status, 0, steer.stderr || steer.stdout);
    assert.deepEqual(parseJson(steer).params, { sessionKey: CHILD_KEY, message: 'Switch approach', mode: 'steer' });
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
    assert.equal(plan.spawn.params.sessionKey, CHILD_KEY);
    assert.equal(plan.spawn.params.mode, 'followup');
    assert.match(plan.spawn.params.message, /Now add the dark variant\./);
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
