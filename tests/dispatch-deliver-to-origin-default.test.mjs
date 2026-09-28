import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { effectiveDeliveryTarget } from '../dispatch/source-context.mjs';
import { setDbPath, getDb, applyBundledSchema } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');
const WATCHER_PATH = join(REPO_DIR, 'dispatch', 'watcher.mjs');

/**
 * Regression coverage for the deliver-to-origin-default fix:
 *
 * Root cause: a dispatch run whose request source (origin) was recorded but
 * which had no explicit --deliver-to resolved to deliverTo=null. The completion
 * payload was recorded (status done) but the durable outbox enqueue was skipped
 * (the "deliverTo && deliveryMode !== 'none'" guard), so the requester was
 * never announced the result. The failure path had the same gap: the watcher
 * job's delivery_to and the watchdog alert target were null.
 *
 * Fix: the origin (request source) is the programmatic default delivery target
 * for BOTH the completion and failure paths. An explicit --deliver-to always
 * wins. effectiveDeliveryTarget() resolves {target, channel} from the label
 * entry (explicit deliverTo first, else the origin route).
 *
 * (a) completion delivered to origin by default (watcher done path)
 * (b) failure path: watcher job arming uses origin target as delivery_to
 * (c) explicit --deliver-to overrides origin
 * (d) effectiveDeliveryTarget unit cases
 */

function makeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `dispatch-origin-default-${name}-`));
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, '{}\n');
  const dbPath = join(root, 'scheduler.db');
  setDbPath(dbPath);
  const db = getDb();
  applyBundledSchema('test fixture schema');
  db.close();
  return { root, labelsPath, dbPath };
}

function readLabels(fix) {
  return JSON.parse(readFileSync(fix.labelsPath, 'utf8'));
}

function baseEnv(fix, extra = {}) {
  return {
    ...process.env,
    SCHEDULER_DB: fix.dbPath,
    DISPATCH_STATE_DIR: fix.root,
    DISPATCH_LABELS_PATH: fix.labelsPath,
    OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
    ...extra,
  };
}

// -- (a) completion delivered to origin by default (watcher done path) -------

/**
 * Stub index that reports a clean done with a completion payload. The watcher's
 * internal enqueueCompletionNotification (real code + real DB) must route the
 * completion to the ORIGIN target even though the label has no deliverTo.
 */
function stubDoneIndex(fix, label) {
  const stubPath = join(fix.root, 'index-stub-done.mjs');
  writeFileSync(stubPath, `
import { readFileSync } from 'node:fs';
const sub = process.argv[2];
const LABEL = ${JSON.stringify(label)};
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: LABEL,
    status: 'done',
    summary: 'All done: origin-default completion',
  }) + '\\n');
  process.exit(0);
}
if (sub === 'result') {
  process.stdout.write(JSON.stringify({
    ok: true,
    label: LABEL,
    status: 'done',
    lastReply: 'All done: origin-default completion',
    completion: { summary_human: 'All done: origin-default completion' },
  }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, changes: 0, details: [] }) + '\\n');
process.exit(0);
`);
  return stubPath;
}

test('(a) completion delivered to origin by default when no --deliver-to', () => {
  const fix = makeFixture('a-completion');
  const label = 'origin-completion-a';
  const originTarget = '484946046';
  try {
    const stubPath = stubDoneIndex(fix, label);
    // Label has an ORIGIN but NO deliverTo (the exact incident shape).
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey: 'agent:main:subagent:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 3600,
        origin: `telegram:${originTarget}`,
        deliverTo: null,
        deliverChannel: null,
        deliveryMode: 'announce',
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      WATCHER_PATH, '--label', label, '--timeout', '600', '--poll-interval', '20', '--once',
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: baseEnv(fix, { DISPATCH_INDEX_PATH: stubPath }),
    });
    if (result.error) throw result.error;

    assert.equal(result.status, 0, `watcher done path must exit 0; stderr=${result.stderr}`);
    assert.match(result.stderr, /WATCHER_ALREADY_DELIVERED|WATCHER_PENDING/,
      'completion routed through the durable outbox');

    const db = new Database(fix.dbPath);
    const outboxRow = db.prepare(
      "SELECT channel, target, body FROM delivery_outbox WHERE completion_label = ? LIMIT 1",
    ).get(label);
    db.close();
    assert.ok(outboxRow, 'completion enqueued in the durable outbox (not silently dropped)');
    assert.equal(outboxRow.channel, 'telegram', 'outbox channel is the origin channel');
    assert.equal(outboxRow.target, originTarget, 'outbox target defaults to the ORIGIN target');
    assert.match(outboxRow.body, /origin-default completion/, 'completion text in the outbox body');

    const after = readLabels(fix)[label];
    assert.equal(after.status, 'done', 'label marked done');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

// -- (b) + (c) failure path: watcher job arming uses the effective target ----

/**
 * Stub scheduler CLI that captures the job spec passed to `jobs add` and
 * returns a valid {job:{id}} envelope. scheduleDeliveryWatcherJob invokes
 * `node <cli> --json jobs add <specJson>`.
 */
function stubSchedulerCli(fix, capturePath) {
  const cliPath = join(fix.root, 'scheduler-cli-stub.js');
  writeFileSync(cliPath, `
const fs = require('fs');
const args = process.argv.slice(2);
// find the job spec: the last arg that parses as JSON with a name
let spec = null;
for (let i = args.length - 1; i >= 0; i--) {
  try {
    const v = JSON.parse(args[i]);
    if (v && typeof v === 'object' && (v.name || v.job_type)) { spec = v; break; }
  } catch {}
}
if (spec) fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(spec, null, 2));
process.stdout.write(JSON.stringify({ ok: true, job: { id: 'stub-watcher-job' } }));
`);
  return cliPath;
}

function runWatcherHandoff(fix, label, cliPath, capturePath) {
  const result = spawnSync(process.execPath, [
    INDEX_PATH, 'watcher-handoff', '--label', label,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    env: baseEnv(fix, { OPENCLAW_SCHEDULER_CLI: cliPath }),
  });
  if (result.error) throw result.error;
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch {}
  const spec = readFileSync(capturePath, 'utf8');
  return { result, parsed, spec: JSON.parse(spec) };
}

test('(b) failure path: watcher job delivery_to defaults to origin target', () => {
  const fix = makeFixture('b-failure-origin');
  const label = 'origin-failure-b';
  const originTarget = '999000111';
  try {
    const capturePath = join(fix.root, 'captured-job.json');
    const cliPath = stubSchedulerCli(fix, capturePath);
    // ORIGIN only, no deliverTo.
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey: 'agent:main:subagent:11111111-2222-4333-8444-555555555555',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 3600,
        origin: `telegram:${originTarget}`,
        deliverTo: null,
        deliverChannel: null,
        deliveryMode: 'announce',
      },
    }, null, 2));

    const { parsed, spec } = runWatcherHandoff(fix, label, cliPath, capturePath);
    assert.ok(parsed, 'watcher-handoff returned JSON');
    assert.equal(parsed.scheduled, true, `watcher job scheduled; got ${JSON.stringify(parsed)}`);
    assert.equal(spec.delivery_to, originTarget, 'watcher job delivery_to defaults to the ORIGIN target');
    assert.equal(spec.delivery_channel, 'telegram', 'watcher job delivery_channel is the origin channel');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(c) explicit --deliver-to overrides origin for the watcher job', () => {
  const fix = makeFixture('c-explicit-wins');
  const label = 'origin-explicit-c';
  const originTarget = '777000888';
  const explicitTarget = '555666777';
  try {
    const capturePath = join(fix.root, 'captured-job.json');
    const cliPath = stubSchedulerCli(fix, capturePath);
    // Both ORIGIN and an explicit deliverTo are present.
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey: 'agent:main:subagent:22222222-3333-4444-5555-666666666666',
        status: 'running',
        agent: 'main',
        mode: 'fresh',
        spawnedAt: new Date().toISOString(),
        timeoutSeconds: 3600,
        origin: `telegram:${originTarget}`,
        deliverTo: explicitTarget,
        deliverChannel: 'telegram',
        deliveryMode: 'announce',
      },
    }, null, 2));

    const { parsed, spec } = runWatcherHandoff(fix, label, cliPath, capturePath);
    assert.ok(parsed, 'watcher-handoff returned JSON');
    assert.equal(parsed.scheduled, true, `watcher job scheduled; got ${JSON.stringify(parsed)}`);
    assert.equal(spec.delivery_to, explicitTarget, 'explicit --deliver-to wins over origin');
    assert.notEqual(spec.delivery_to, originTarget, 'delivery_to is NOT the origin when explicit is set');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

// -- (d) effectiveDeliveryTarget unit cases ---------------------------------

test('(d) effectiveDeliveryTarget: explicit deliverTo wins over origin', () => {
  const t = effectiveDeliveryTarget({ deliverTo: 'B', deliverChannel: 'telegram', origin: 'telegram:A' });
  assert.deepEqual(t, { target: 'B', channel: 'telegram' });
});

test('(d) effectiveDeliveryTarget: origin used when deliverTo absent', () => {
  const t = effectiveDeliveryTarget({ deliverTo: null, deliverChannel: null, origin: 'telegram:A' });
  assert.deepEqual(t, { target: 'A', channel: 'telegram' });
});

test('(d) effectiveDeliveryTarget: explicit deliverChannel honored with explicit deliverTo', () => {
  const t = effectiveDeliveryTarget({ deliverTo: 'B', deliverChannel: 'slack', origin: 'telegram:A' });
  assert.deepEqual(t, { target: 'B', channel: 'slack' });
});

test('(d) effectiveDeliveryTarget: null for a non-route origin (system)', () => {
  const t = effectiveDeliveryTarget({ deliverTo: null, deliverChannel: null, origin: 'system' });
  assert.equal(t, null);
});

test('(d) effectiveDeliveryTarget: null when there is no origin and no deliverTo', () => {
  const t = effectiveDeliveryTarget({ deliverTo: null, deliverChannel: null, origin: null });
  assert.equal(t, null);
});

test('(d) effectiveDeliveryTarget: null for undefined input', () => {
  assert.equal(effectiveDeliveryTarget(undefined), null);
  assert.equal(effectiveDeliveryTarget(null), null);
});

test('(d) effectiveDeliveryTarget: origin channel is used for the target channel', () => {
  const t = effectiveDeliveryTarget({ deliverTo: null, deliverChannel: null, origin: 'slack:12345' });
  assert.deepEqual(t, { target: '12345', channel: 'slack' });
});
