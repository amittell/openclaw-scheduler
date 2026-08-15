import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import Database from 'better-sqlite3';
import { enqueueCompletionNotification } from '../dispatch/hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');

const GROUP_SOURCE = Object.freeze({
  channel: 'telegram',
  target: '-5268075089',
  messageId: '11981',
  threadId: 'topic-77',
});
const DM_SOURCE = Object.freeze({
  channel: 'telegram',
  target: '484946046',
  messageId: '812',
  threadId: null,
});

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-source-routing-'));
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const openClawDir = join(root, '.openclaw');
  const labelsPath = join(root, 'state', 'labels.json');
  const callsPath = join(root, 'openclaw-calls.jsonl');
  const dbPath = join(root, 'scheduler.db');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(openClawDir, { recursive: true });
  mkdirSync(dirname(labelsPath), { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'route-test' }));
  writeFileSync(join(openClawDir, 'openclaw.json'), '{}\n');
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
    "if (method === 'sessions.patch' && params?.key) {",
    "  const sessionsDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
    "  const sessionsPath = path.join(sessionsDir, 'sessions.json');",
    '  fs.mkdirSync(sessionsDir, { recursive: true });',
    '  let sessions = {};',
    "  try { sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')); } catch {}",
    "  sessions[params.key] = { ...(sessions[params.key] || {}), sessionId: 'session-route-test', updatedAt: Date.now(), startedAt: Date.now() };",
    '  fs.writeFileSync(sessionsPath, JSON.stringify(sessions));',
    '}',
    "process.stdout.write(method === 'agent' ? JSON.stringify({ ok: true, runId: 'run-route-test' }) : '{}');",
    '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);

  return { root, configDir, binDir, labelsPath, callsPath, dbPath };
}

function runDispatch(fixture, args) {
  return spawnSync(process.execPath, [INDEX_PATH, ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      HOME: fixture.root,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      DISPATCH_CONFIG_DIR: fixture.configDir,
      DISPATCH_STATE_DIR: dirname(fixture.labelsPath),
      DISPATCH_LABELS_PATH: fixture.labelsPath,
      SCHEDULER_DB: fixture.dbPath,
      OPENCLAW_GATEWAY_TOKEN: '',
    },
  });
}

function enqueueArgs(label, source, extras = []) {
  return [
    'enqueue',
    '--label', label,
    '--message', 'Perform a source-routing smoke task.',
    '--timeout', '300',
    '--source-context', JSON.stringify(source),
    ...extras,
  ];
}

function readLabels(fixture) {
  return JSON.parse(readFileSync(fixture.labelsPath, 'utf8'));
}

function readCalls(fixture) {
  if (!existsSync(fixture.callsPath)) return [];
  return readFileSync(fixture.callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('authoritative group source rejects the RequestHub-dev delivery mismatch before side effects', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('wrong-group', GROUP_SOURCE, [
      '--deliver-to', '-1003892419349',
      '--deliver-channel', 'telegram',
    ]));
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /does not match authoritative source/u);
    assert.deepEqual(readLabels(fixture), {});
    assert.deepEqual(readCalls(fixture), []);
    assert.equal(existsSync(fixture.dbPath), false, 'scheduler DB must not be opened for a rejected route');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('matching group source persists message and topic identifiers across labels, watcher DB, handoff, and status/result/route', () => {
  const fixture = buildFixture();
  try {
    const accepted = runDispatch(fixture, enqueueArgs('matching-group', GROUP_SOURCE, [
      '--deliver-to', GROUP_SOURCE.target,
      '--deliver-channel', GROUP_SOURCE.channel,
      '--origin', `${GROUP_SOURCE.channel}:${GROUP_SOURCE.target}`,
      '--no-monitor', 'focused route test',
    ]));
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.deepEqual(JSON.parse(accepted.stdout).sourceContext, GROUP_SOURCE);

    const label = readLabels(fixture)['matching-group'];
    assert.deepEqual(label.sourceContext, GROUP_SOURCE);
    assert.equal(label.origin, 'telegram:-5268075089');
    assert.equal(label.deliverTo, GROUP_SOURCE.target);

    const db = new Database(fixture.dbPath, { readonly: true });
    const initialWatcher = db.prepare(`
      SELECT source_channel, source_target, source_message_id, source_thread_id
      FROM jobs WHERE name = 'route-test-deliver:matching-group'
    `).get();
    assert.deepEqual(initialWatcher, {
      source_channel: GROUP_SOURCE.channel,
      source_target: GROUP_SOURCE.target,
      source_message_id: GROUP_SOURCE.messageId,
      source_thread_id: GROUP_SOURCE.threadId,
    });
    db.close();

    const handoff = runDispatch(fixture, ['watcher-handoff', '--label', 'matching-group', '--reason', 'test']);
    assert.equal(handoff.status, 0, handoff.stderr || handoff.stdout);
    assert.equal(JSON.parse(handoff.stdout).scheduled, true);
    const handoffDb = new Database(fixture.dbPath, { readonly: true });
    const handoffWatcher = handoffDb.prepare(`
      SELECT source_channel, source_target, source_message_id, source_thread_id
      FROM jobs WHERE name LIKE 'route-test-deliver:matching-group:handoff:%'
      ORDER BY created_at DESC LIMIT 1
    `).get();
    assert.deepEqual(handoffWatcher, initialWatcher);
    handoffDb.close();

    const labels = readLabels(fixture);
    labels['matching-group'].status = 'done';
    writeFileSync(fixture.labelsPath, JSON.stringify(labels, null, 2) + '\n');
    for (const command of ['status', 'result', 'route']) {
      const output = runDispatch(fixture, [command, '--label', 'matching-group']);
      assert.equal(output.status, 0, output.stderr || output.stdout);
      assert.deepEqual(JSON.parse(output.stdout).sourceContext, GROUP_SOURCE, command);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('matching DM source is accepted and normalized', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('matching-dm', DM_SOURCE, [
      '--deliver-to', DM_SOURCE.target,
      '--deliver-channel', 'TELEGRAM',
      '--delivery-mode', 'none',
      '--no-monitor', 'manual completion handling',
    ]));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const label = readLabels(fixture)['matching-dm'];
    assert.deepEqual(label.sourceContext, DM_SOURCE);
    assert.equal(label.deliverChannel, 'telegram');
    assert.equal(label.deliverTo, DM_SOURCE.target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('authoritative source rejects channel mismatch and conflicting legacy origin deterministically', () => {
  const fixture = buildFixture();
  try {
    const channelMismatch = runDispatch(fixture, enqueueArgs('channel-mismatch', GROUP_SOURCE, [
      '--deliver-to', GROUP_SOURCE.target,
      '--deliver-channel', 'slack',
    ]));
    assert.equal(channelMismatch.status, 2, channelMismatch.stderr || channelMismatch.stdout);
    assert.match(channelMismatch.stderr, /explicit delivery route slack:/u);

    const originMismatch = runDispatch(fixture, enqueueArgs('origin-mismatch', GROUP_SOURCE, [
      '--origin', 'telegram:-1003892419349',
    ]));
    assert.equal(originMismatch.status, 2, originMismatch.stderr || originMismatch.stdout);
    assert.match(originMismatch.stderr, /--origin telegram:-1003892419349 does not match/u);
    assert.deepEqual(readLabels(fixture), {});
    assert.deepEqual(readCalls(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('source envelopes reject non-identifier fields before persistence', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, enqueueArgs('private-source-field', {
      ...GROUP_SOURCE,
      messageText: 'private inbound content must never be stored',
    }));
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /unsupported field\(s\): messageText/u);
    assert.deepEqual(readLabels(fixture), {});
    assert.deepEqual(readCalls(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manual/local legacy origin fallback remains compatible without source context', () => {
  const fixture = buildFixture();
  try {
    const result = runDispatch(fixture, [
      'enqueue',
      '--label', 'manual-local',
      '--message', 'Run a local smoke task.',
      '--timeout', '300',
      '--origin', 'system',
      '--delivery-mode', 'none',
      '--no-monitor', 'manual local task',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const label = readLabels(fixture)['manual-local'];
    assert.equal(label.sourceContext, null);
    assert.equal(label.origin, 'system');
    assert.equal(label.deliverTo, null);
    assert.ok(readCalls(fixture).some(call => call.method === 'agent'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('completion enqueue refuses to overwrite an authoritative source route', () => {
  assert.throws(() => enqueueCompletionNotification({
    label: 'completion-route-guard',
    summary: 'done',
    deliverTo: '-1003892419349',
    deliveryChannel: 'telegram',
    sourceContext: GROUP_SOURCE,
  }), /does not match authoritative source/u);
});
