import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createDeliveryHelpers } from '../dispatcher-delivery.js';
import {
  buildCompletionDeliveryScope,
  claimCompletionDelivery,
  enqueueCompletionNotification,
  recordCompletionDelivered,
  resetCompletionDeliveryClaim,
} from '../dispatch/hooks.mjs';
import {
  claimDelivery,
  enqueueDelivery,
  enqueueMultipartDelivery,
  getDeliveryCheckpoint,
  markDeliveryDelivered,
} from '../delivery-outbox.js';
import { formatMessageForDelivery } from '../scripts/inbox-consumer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const schemaPath = join(repoRoot, 'schema.sql');
const hooksUrl = pathToFileURL(join(repoRoot, 'dispatch', 'hooks.mjs')).href;
const watcherPath = join(repoRoot, 'dispatch', 'watcher.mjs');
const dispatchIndexPath = join(repoRoot, 'dispatch', 'index.mjs');
const testRoot = mkdtempSync(join(tmpdir(), 'scheduler-v04-delivery-'));
const dbPath = join(testRoot, 'scheduler.db');

function initializeDatabase(path) {
  const db = new Database(path);
  db.exec(readFileSync(schemaPath, 'utf8'));
  db.close();
}

before(async () => {
  setDbPath(dbPath);
  await initDb();
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM delivery_outbox;
    DELETE FROM completion_debts;
    DELETE FROM messages;
  `);
});

after(() => {
  closeDb();
  rmSync(testRoot, { recursive: true, force: true });
});

test('completion claims are independent for two runs that reuse one label', () => {
  const label = 'shared-label';
  const first = { label, sessionKey: 'session-shared', runId: 'run-one' };
  const second = { label, sessionKey: 'session-shared', runId: 'run-two' };
  const firstScope = buildCompletionDeliveryScope(first);
  const secondScope = buildCompletionDeliveryScope(second);

  assert.notEqual(firstScope, secondScope);
  resetCompletionDeliveryClaim(first);
  resetCompletionDeliveryClaim(second);
  assert.equal(claimCompletionDelivery(first), true);
  assert.equal(claimCompletionDelivery(first), false);
  assert.equal(claimCompletionDelivery(second), true);
  recordCompletionDelivered({ ...first, metadata: { path: 'done' } });
  recordCompletionDelivered({ ...second, metadata: { path: 'watcher' } });

  const rows = getDb().prepare(`
    SELECT task_label, delivery_scope, status
    FROM completion_debts
    WHERE task_label = ?
    ORDER BY delivery_scope
  `).all(label);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.delivery_scope)), new Set([firstScope, secondScope]));
  assert.ok(rows.every(row => row.status === 'closed'));
});

test('completion enqueue writes only to the durable outbox and deduplicates the run scope', () => {
  const request = {
    label: 'outbox-only',
    sessionKey: 'session-outbox',
    runId: 'run-outbox',
    deliverTo: 'chat-42',
    deliveryChannel: 'telegram',
    completion: { summary_human: 'Completed the durable outbox validation successfully.' },
  };

  const first = enqueueCompletionNotification(request);
  const duplicate = enqueueCompletionNotification(request);
  assert.equal(first.ok, true);
  assert.equal(first.enqueued, true);
  assert.equal(first.partCount, 1);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.reason, 'already-claimed');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);

  const outbox = getDb().prepare('SELECT id, run_id, channel, target, body, status FROM delivery_outbox').get();
  assert.deepEqual(
    { channel: outbox.channel, target: outbox.target, status: outbox.status },
    { channel: 'telegram', target: 'chat-42', status: 'pending' },
  );
  assert.match(outbox.body, /Completed the durable outbox validation successfully/);
  assert.equal(outbox.run_id, null);
  const debt = getDb().prepare(`
    SELECT status, close_reason FROM completion_debts WHERE task_label = ?
  `).get(request.label);
  assert.deepEqual(debt, { status: 'delivering', close_reason: null });

  const claimed = claimDelivery(outbox.id, { owner: 'v04-completion-test' });
  markDeliveryDelivered(claimed.id, claimed.claim_token);
  const deliveredDebt = getDb().prepare(`
    SELECT status, close_reason FROM completion_debts WHERE task_label = ?
  `).get(request.label);
  assert.deepEqual(deliveredDebt, { status: 'closed', close_reason: 'confirmed-completion-delivered' });
});

test('multipart outbox rows provide durable per-part idempotency checkpoints', () => {
  const body = Array.from(
    { length: 180 },
    (_, index) => `Delivery checkpoint ${index + 1}: ${'validated '.repeat(5)}`,
  ).join('\n');
  const first = enqueueMultipartDelivery({
    channel: 'telegram',
    target: 'chat-multipart',
    body,
    idempotencyKey: 'multipart-checkpoint',
    maxPartBytes: 700,
  });
  const duplicate = enqueueMultipartDelivery({
    channel: 'telegram',
    target: 'chat-multipart',
    body,
    idempotencyKey: 'multipart-checkpoint',
    maxPartBytes: 700,
  });

  assert.ok(first.partCount > 1);
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.deliveries.map(row => row.id), first.deliveries.map(row => row.id));
  assert.ok(first.deliveries.every(row => Buffer.byteLength(row.body, 'utf8') <= 700));
  assert.deepEqual(
    first.deliveries.map(row => row.idempotency_key),
    first.deliveries.map((_, index) => `multipart-checkpoint:part:${index + 1}/${first.partCount}`),
  );

  assert.equal(
    claimDelivery(first.deliveries[1].id, { owner: 'v04-out-of-order' }),
    null,
  );

  const claimed = claimDelivery(first.deliveries[0].id, { owner: 'v04-test' });
  assert.equal(claimed.status, 'claimed');
  markDeliveryDelivered(claimed.id, claimed.claim_token);
  const checkpoint = getDeliveryCheckpoint('multipart-checkpoint');
  assert.equal(checkpoint.partCount, first.partCount);
  assert.equal(checkpoint.statusCounts.delivered, 1);
  assert.equal(checkpoint.statusCounts.pending, first.partCount - 1);
  assert.equal(checkpoint.complete, false);
});

test('schema v27 single-part rows remain idempotently equivalent after multipart upgrade', () => {
  const legacy = enqueueDelivery({
    channel: 'telegram',
    target: 'chat-legacy-single',
    body: 'legacy single-part body',
    idempotencyKey: 'legacy-single-part-key',
  });
  assert.equal(legacy.delivery_group_id, null);
  assert.equal(legacy.part_index, null);
  assert.equal(legacy.part_count, null);

  const upgraded = enqueueMultipartDelivery({
    channel: 'telegram',
    target: 'chat-legacy-single',
    body: 'legacy single-part body',
    idempotencyKey: 'legacy-single-part-key',
  });
  assert.equal(upgraded.deduped, true);
  assert.equal(upgraded.id, legacy.id);
  assert.equal(upgraded.partCount, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);
  assert.throws(
    () => enqueueMultipartDelivery({
      channel: 'telegram',
      target: 'chat-legacy-single',
      body: 'changed body must still collide',
      idempotencyKey: 'legacy-single-part-key',
    }),
    error => error.code === 'DELIVERY_IDEMPOTENCY_COLLISION',
  );
});

test('durable Telegram parts remain one gateway send after the formatted header is added', () => {
  const multipart = enqueueMultipartDelivery({
    channel: 'telegram',
    target: 'chat-header-budget',
    body: '🧪'.repeat(2500),
    idempotencyKey: 'telegram-header-budget',
  });
  assert(multipart.partCount > 1);
  for (const delivery of multipart.deliveries) {
    const formatted = formatMessageForDelivery({
      body: delivery.body,
      subject: '🧪'.repeat(200),
      created_at: delivery.created_at,
    }, { brand: '🧪'.repeat(200) });
    assert(Buffer.byteLength(formatted, 'utf8') <= 4096);
  }
});

test('normal scheduler delivery uses durable multipart checkpoints for long Telegram text', () => {
  const { handleDelivery } = createDeliveryHelpers({
    log: () => {},
    resolveDeliveryAlias: () => null,
  });
  const delivery = handleDelivery({
    id: null,
    name: 'multipart normal delivery',
    delivery_mode: 'announce-always',
    delivery_channel: 'telegram',
    delivery_to: 'chat-normal-multipart',
  }, 'validated output '.repeat(700), {
    idempotencyKey: 'normal-multipart-delivery',
  });
  assert(delivery.partCount > 1);
  assert.equal(delivery.deliveries.length, delivery.partCount);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM delivery_outbox WHERE delivery_group_id = ?')
      .get(delivery.delivery_group_id).count,
    delivery.partCount,
  );
  assert.equal(claimDelivery(delivery.deliveries[1].id, { owner: 'normal-multipart' }), null);
});

test('legacy completion schema reserves the active run and rejects a stale-run claim', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-legacy-'));
  const legacyDbPath = join(fixture, 'legacy.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE completion_debts (
      task_label TEXT PRIMARY KEY,
      session_key TEXT,
      source TEXT NOT NULL DEFAULT 'dispatch',
      status TEXT NOT NULL DEFAULT 'tracking',
      open_reason TEXT,
      close_reason TEXT,
      opened_at TEXT,
      closed_at TEXT,
      last_visible_update_at TEXT,
      final_reported_at TEXT,
      no_reply INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacyDb.close();

  try {
    const script = `
      const hooks = await import(${JSON.stringify(hooksUrl)});
      const active = { label: 'legacy-label', sessionKey: 'session-new', runId: 'run-new' };
      const stale = { label: 'legacy-label', sessionKey: 'session-old', runId: 'run-old' };
      hooks.resetCompletionDeliveryClaim(active);
      const staleClaim = hooks.claimCompletionDelivery(stale);
      const activeClaim = hooks.claimCompletionDelivery(active);
      process.stdout.write(JSON.stringify({ staleClaim, activeClaim }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SCHEDULER_DB: legacyDbPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { staleClaim: false, activeClaim: true });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('completion claim storage failures are explicit and fail closed', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-claim-error-'));
  const emptyDbPath = join(fixture, 'empty.db');
  try {
    const script = `
      const hooks = await import(${JSON.stringify(hooksUrl)});
      let direct;
      try {
        hooks.claimCompletionDelivery({ label: 'missing-table', sessionKey: 'session', runId: 'run' });
        direct = { threw: false };
      } catch (error) {
        direct = { threw: true, code: error.code, message: error.message };
      }
      const enqueue = hooks.enqueueCompletionNotification({
        label: 'missing-table',
        sessionKey: 'session',
        runId: 'run',
        deliverTo: 'target',
        deliveryChannel: 'telegram',
        completion: { summary_human: 'Completed without an available claim store.' }
      });
      process.stdout.write(JSON.stringify({ direct, enqueue }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, SCHEDULER_DB: emptyDbPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.direct.threw, true);
    assert.equal(output.direct.code, 'COMPLETION_CLAIM_UNAVAILABLE');
    assert.match(output.direct.message, /no such table: completion_debts/);
    assert.equal(output.enqueue.ok, false);
    assert.equal(output.enqueue.delivered, false);
    assert.equal(output.enqueue.reason, 'completion-claim-unavailable');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('deadline completion resets overload retries and enqueues without stdout delivery', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-watcher-'));
  const fixtureDbPath = join(fixture, 'scheduler.db');
  const labelsPath = join(fixture, 'labels.json');
  const mockDispatchPath = join(fixture, 'mock-dispatch.mjs');
  const statusCountPath = join(fixture, 'status-count');
  const resultCountPath = join(fixture, 'result-count');
  const label = 'deadline-completion';
  const sessionKey = 'agent:main:subagent:deadline';
  initializeDatabase(fixtureDbPath);
  writeFileSync(labelsPath, JSON.stringify({
    [label]: {
      status: 'running',
      sessionKey,
      runId: 'gateway-run-deadline',
      agent: 'main',
      deliverTo: 'deadline-target',
      deliverChannel: 'telegram',
      deliveryMode: 'announce-always',
      retryCount: 2,
      gwRestartRetryCount: 1,
      spawnedAt: new Date().toISOString(),
      timeoutSeconds: 1,
    },
  }, null, 2));
  writeFileSync(mockDispatchPath, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const subcommand = process.argv[2];
    if (subcommand === 'status') {
      const count = existsSync(${JSON.stringify(statusCountPath)})
        ? Number(readFileSync(${JSON.stringify(statusCountPath)}, 'utf8'))
        : 0;
      writeFileSync(${JSON.stringify(statusCountPath)}, String(count + 1));
      process.stdout.write(JSON.stringify({
        ok: true,
        status: count === 0 ? 'running' : 'done',
        sessionKey: ${JSON.stringify(sessionKey)},
        summary: 'Completed exactly as the watcher deadline elapsed.',
        liveness: count === 0 ? { ageMs: 0, tokens: null } : null
      }));
    } else if (subcommand === 'result') {
      const count = existsSync(${JSON.stringify(resultCountPath)})
        ? Number(readFileSync(${JSON.stringify(resultCountPath)}, 'utf8'))
        : 0;
      writeFileSync(${JSON.stringify(resultCountPath)}, String(count + 1));
      process.stdout.write(JSON.stringify({
        ok: true,
        status: count === 0 ? 'running' : 'done',
        sessionKey: ${JSON.stringify(sessionKey)},
        lastReply: count === 0 ? null : 'Completed exactly as the watcher deadline elapsed.',
        completion: count === 0
          ? null
          : { summary_human: 'Completed exactly as the watcher deadline elapsed.' }
      }));
    } else {
      process.stdout.write(JSON.stringify({ ok: true }));
    }
  `);

  try {
    const result = spawnSync(process.execPath, [
      watcherPath,
      '--label', label,
      '--timeout', '0',
      '--poll-interval', '1',
    ], {
      env: {
        ...process.env,
        HOME: fixture,
        SCHEDULER_DB: fixtureDbPath,
        DISPATCH_LABELS_PATH: labelsPath,
        DISPATCH_INDEX_PATH: mockDispatchPath,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /WATCHER_ALREADY_DELIVERED/);

    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    assert.equal(labels[label].status, 'done');
    assert.equal(labels[label].retryCount, 0);
    assert.equal(labels[label].gwRestartRetryCount, 0);
    assert.ok(Array.isArray(labels[label].completionOutboxIds));

    const db = new Database(fixtureDbPath, { readonly: true });
    const outboxRows = db.prepare('SELECT body, status FROM delivery_outbox').all();
    const debts = db.prepare('SELECT status FROM completion_debts WHERE task_label = ?').all(label);
    db.close();
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0].status, 'pending');
    assert.match(outboxRows[0].body, /Completed exactly as the watcher deadline elapsed/);
    assert.deepEqual(debts.map(row => row.status), ['delivering']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('route-less watcher retains stdout compatibility after a durable scoped claim', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-no-route-'));
  const fixtureDbPath = join(fixture, 'scheduler.db');
  const labelsPath = join(fixture, 'labels.json');
  const mockDispatchPath = join(fixture, 'mock-dispatch.mjs');
  const label = 'no-route-completion';
  initializeDatabase(fixtureDbPath);
  writeFileSync(labelsPath, JSON.stringify({
    [label]: {
      status: 'running',
      sessionKey: 'agent:main:subagent:no-route',
      runId: 'gateway-run-no-route',
      agent: 'main',
      spawnedAt: new Date().toISOString(),
      timeoutSeconds: 60,
    },
  }));
  writeFileSync(mockDispatchPath, `
    const subcommand = process.argv[2];
    const completion = { summary_human: 'Completed through the route-less watcher compatibility path.' };
    process.stdout.write(JSON.stringify({
      ok: true,
      status: subcommand === 'sync' ? 'ok' : 'done',
      sessionKey: 'agent:main:subagent:no-route',
      summary: completion.summary_human,
      completion
    }));
  `);

  try {
    const result = spawnSync(process.execPath, [
      watcherPath,
      '--label', label,
      '--timeout', '60',
      '--poll-interval', '1',
      '--once',
    ], {
      env: {
        ...process.env,
        HOME: fixture,
        SCHEDULER_DB: fixtureDbPath,
        DISPATCH_LABELS_PATH: labelsPath,
        DISPATCH_INDEX_PATH: mockDispatchPath,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^🌶️ \*dispatch\* \[no-route-completion\] completed:/);
    assert.match(result.stdout, /Completed through the route-less watcher compatibility path/);

    const db = new Database(fixtureDbPath, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 0);
    const debt = db.prepare('SELECT status FROM completion_debts WHERE task_label = ?').get(label);
    db.close();
    assert.equal(debt.status, 'closed');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('routed watcher exits successfully after durable completion enqueue', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-routed-watcher-'));
  const fixtureDbPath = join(fixture, 'scheduler.db');
  const labelsPath = join(fixture, 'labels.json');
  const mockDispatchPath = join(fixture, 'mock-dispatch.mjs');
  const label = 'routed-completion';
  initializeDatabase(fixtureDbPath);
  writeFileSync(labelsPath, JSON.stringify({
    [label]: {
      status: 'running',
      sessionKey: 'agent:main:subagent:routed',
      runId: 'gateway-run-routed',
      agent: 'main',
      deliverTo: 'routed-target',
      deliverChannel: 'telegram',
      deliveryMode: 'announce-always',
      spawnedAt: new Date().toISOString(),
      timeoutSeconds: 60,
    },
  }));
  writeFileSync(mockDispatchPath, `
    const subcommand = process.argv[2];
    const completion = { summary_human: 'Completed through the durable routed watcher path.' };
    process.stdout.write(JSON.stringify({
      ok: true,
      status: subcommand === 'sync' ? 'ok' : 'done',
      sessionKey: 'agent:main:subagent:routed',
      summary: completion.summary_human,
      completion
    }));
  `);

  try {
    const result = spawnSync(process.execPath, [
      watcherPath,
      '--label', label,
      '--timeout', '60',
      '--poll-interval', '1',
      '--once',
    ], {
      env: {
        ...process.env,
        HOME: fixture,
        SCHEDULER_DB: fixtureDbPath,
        DISPATCH_LABELS_PATH: labelsPath,
        DISPATCH_INDEX_PATH: mockDispatchPath,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /WATCHER_ALREADY_DELIVERED/);
    assert.doesNotMatch(result.stderr, /durable completion enqueue failed/);

    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    assert.equal(labels[label].status, 'done');
    assert.ok(Array.isArray(labels[label].completionOutboxIds));
    const db = new Database(fixtureDbPath, { readonly: true });
    const rows = db.prepare('SELECT body, status FROM delivery_outbox').all();
    const debt = db.prepare('SELECT status FROM completion_debts WHERE task_label = ?').get(label);
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.match(rows[0].body, /Completed through the durable routed watcher path/);
    assert.equal(debt.status, 'delivering');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('enqueue prompt provides a literal checkpoint command without claiming an environment variable exists', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-prompt-'));
  const fixtureDbPath = join(fixture, 'scheduler.db');
  const configDir = join(fixture, 'config');
  const binDir = join(fixture, 'bin');
  const labelsPath = join(fixture, 'labels.json');
  const callsPath = join(fixture, 'gateway-calls.jsonl');
  const openclawPath = join(binDir, 'openclaw');
  const sessionKey = 'agent:main:subagent:checkpoint-prompt';
  const sessionsDir = join(fixture, '.openclaw', 'agents', 'main', 'sessions');
  initializeDatabase(fixtureDbPath);
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'dispatch-test' }));
  writeFileSync(labelsPath, '{}\n');
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
    [sessionKey]: {
      sessionId: 'checkpoint-prompt-session',
      updatedAt: Date.now(),
      totalTokens: 1,
    },
  }));
  writeFileSync(openclawPath, `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const paramsIndex = args.indexOf('--params');
    const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;
    const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : null;
    fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, params }) + '\\n');
    process.stdout.write(JSON.stringify(method === 'agent' ? { ok: true, runId: 'prompt-run' } : {}));
  `);
  chmodSync(openclawPath, 0o755);

  try {
    const result = spawnSync(process.execPath, [
      dispatchIndexPath,
      'enqueue',
      '--label', 'checkpoint-prompt',
      '--message', 'Validate checkpoint delivery behavior.',
      '--session-key', sessionKey,
      '--origin', 'system',
      '--timeout', '300',
      '--delivery-mode', 'none',
      '--no-monitor',
    ], {
      env: {
        ...process.env,
        HOME: fixture,
        SCHEDULER_DB: fixtureDbPath,
        DISPATCH_CONFIG_DIR: configDir,
        DISPATCH_LABELS_PATH: labelsPath,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const prompt = calls.find(call => call.method === 'agent')?.params?.message;
    assert.match(prompt, /messages send --from 'checkpoint-prompt' --to main --kind status --body/);
    assert.doesNotMatch(prompt, /Environment variable CHECKPOINT_NOTIFY_CMD is set/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
