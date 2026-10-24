import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { applyBundledSchema, closeDb, setDbPath } from '../db.js';
import { claimDelivery, markDeliveryDelivered } from '../delivery-outbox.js';
import { validateJobSpec } from '../jobs.js';
import { buildCompletionDeliveryScope } from '../dispatch/hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const SAFETY_NET_PATH = join(REPO_DIR, 'dispatch', 'completion-safety-net.mjs');
const SESSION_KEY = 'agent:main:subagent:11111111-2222-3333-4444-555555555555';
const SESSION_ID = '99999999-8888-7777-6666-555555555555';
const DELIVER_TO = '484946046';
const DELIVER_CHANNEL = 'telegram';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-completion-safety-net-'));
  const stateDir = join(root, 'state');
  const agentDir = join(stateDir, 'agents', 'main', 'agent');
  const dispatchState = join(root, 'dispatch-state');
  const configDir = join(root, 'config');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dispatchState, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'test-dispatch' }));
  return {
    root,
    stateDir,
    databasePath: join(agentDir, 'openclaw-agent.sqlite'),
    dispatchState,
    labelsPath: join(dispatchState, 'labels.json'),
    configDir,
  };
}

/** Seed the agent session store + transcript, mirroring the status fixtures. */
function seedSession(databasePath, { terminalReply, storeStatus = 'done' }) {
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session_nodes (
      session_key TEXT PRIMARY KEY,
      current_session_id TEXT,
      entry_json TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      status TEXT,
      last_activity_at INTEGER,
      last_interaction_at INTEGER
    );
    CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY,
      updated_at INTEGER,
      created_at INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      status TEXT,
      transcript_updated_at INTEGER,
      transcript_observed_at INTEGER,
      model_provider TEXT,
      model TEXT
    );
    CREATE TABLE transcript_events (
      session_id TEXT,
      seq INTEGER,
      event_json TEXT,
      created_at INTEGER,
      PRIMARY KEY (session_id, seq)
    );
  `);
  const now = Date.now();
  database.prepare(`
    INSERT INTO session_nodes (
      session_key, current_session_id, entry_json, updated_at, created_at,
      status, last_activity_at, last_interaction_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_KEY,
    SESSION_ID,
    JSON.stringify({ sessionId: SESSION_ID, status: storeStatus }),
    now - 1000,
    now - 5000,
    storeStatus,
    now - 900,
    now - 900,
  );
  database.prepare(`
    INSERT INTO session_windows (
      session_id, updated_at, created_at, started_at, ended_at, status,
      transcript_updated_at, transcript_observed_at, model_provider, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    now - 800,
    now - 5000,
    now - 4900,
    storeStatus === 'running' ? null : now - 5,
    storeStatus,
    now,
    now - 1,
    'gpufarm',
    'qwen-test',
  );
  const insertEvent = (event, createdAt) => {
    database.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transcript_events WHERE session_id = ?), ?, ?)
    `).run(SESSION_ID, SESSION_ID, JSON.stringify(event), createdAt);
  };
  insertEvent({
    type: 'message',
    id: 'event-user',
    timestamp: new Date(now - 4000).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Do the task' }],
      timestamp: now - 4000,
    },
  }, now - 4000);
  if (terminalReply) {
    insertEvent({
      type: 'message',
      id: 'event-assistant-terminal',
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        api: 'gpufarm',
        provider: 'gpufarm',
        model: 'qwen-test',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: terminalReply }],
        timestamp: now,
      },
    }, now);
  } else {
    // A mid-turn tool call with no terminal assistant reply: the safety net
    // must not fabricate a completion from this.
    insertEvent({
      type: 'message',
      id: 'event-assistant-tool',
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'assistant',
        api: 'gpufarm',
        provider: 'gpufarm',
        model: 'qwen-test',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Still working on it' },
          { type: 'tool_use', id: 'tool-1', name: 'exec', input: {} },
        ],
        timestamp: now,
      },
    }, now);
  }
  database.close();
}

function writeLabels(fixture, labels) {
  writeFileSync(fixture.labelsPath, JSON.stringify(labels, null, 2) + '\n', 'utf8');
}

function readLabels(fixture) {
  return JSON.parse(readFileSync(fixture.labelsPath, 'utf-8'));
}

/**
 * Apply the package schema to the fixture scheduler DB. The safety net runs in
 * a subprocess that opens the fixture DB file directly, so it must carry the
 * full schema (the test process's own in-memory DB is not visible to it).
 */
function initFixtureDb(fixture) {
  const dbPath = join(fixture.root, 'scheduler.db');
  setDbPath(dbPath);
  try { applyBundledSchema(); } finally { closeDb(); }
  return dbPath;
}

function createWatcherRun(dbPath, label) {
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const jobId = `watcher-job-${label}`;
    db.prepare(`
      INSERT INTO jobs (
        id, name, enabled, schedule_cron, schedule_tz, session_target, agent_id,
        payload_kind, payload_message, payload_timeout_seconds, overlap_policy,
        run_timeout_ms, delivery_mode, delivery_channel, delivery_to, created_at,
        updated_at, delete_after_run, payload_scope, delivery_guarantee, job_type,
        execution_intent, execution_read_only, ttl_hours, origin
      ) VALUES (
        ?, ?, 1, '* * * * *', 'America/New_York', 'shell', 'main',
        'shellCommand', 'true', 120, 'skip', 120000, 'announce-always', ?, ?,
        ?, ?, 1, 'own', 'at-least-once', 'standard', 'execute', 0, 48, 'system'
      )
    `).run(jobId, `test-dispatch-deliver:${label}`, DELIVER_CHANNEL, DELIVER_TO, now, now);
    db.prepare(`
      INSERT INTO runs (
        id, job_id, status, started_at, last_heartbeat, run_timeout_ms
      ) VALUES (?, ?, 'running', ?, ?, 120000)
    `).run(`watcher-run-${label}`, jobId, now, now);
  } finally {
    db.close();
  }
}

function doneLabel(overrides = {}) {
  return {
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    runId: 'run-safety-net',
    agent: 'main',
    status: 'done',
    deliverTo: DELIVER_TO,
    deliverChannel: DELIVER_CHANNEL,
    spawnedAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...overrides,
  };
}

function runSafetyNet(fixture, { db = null, script = SAFETY_NET_PATH } = {}) {
  const dbPath = db || join(fixture.root, 'scheduler.db');
  const env = {
    ...process.env,
    HOME: fixture.root,
    OPENCLAW_STATE_DIR: fixture.stateDir,
    DISPATCH_CONFIG_DIR: fixture.configDir,
    DISPATCH_STATE_DIR: fixture.dispatchState,
    DISPATCH_LABELS_PATH: fixture.labelsPath,
    SCHEDULER_DB: dbPath,
    OPENCLAW_GATEWAY_TOKEN: '',
    PATH: `${fixture.root}:${process.env.PATH || ''}`,
  };
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return { run, env, dbPath };
}
function routeHash() {
  return createHash('sha256')
    .update(JSON.stringify({ channel: DELIVER_CHANNEL, target: DELIVER_TO }))
    .digest('hex')
    .slice(0, 16);
}

function completionScope(label, entry) {
  return buildCompletionDeliveryScope({
    label,
    sessionKey: entry.sessionKey,
    runId: entry.runId,
  });
}

test('enqueue stays pending until all outbox delivery is confirmed', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'lost-watcher-done';
    writeLabels(fixture, { [label]: doneLabel() });
    const { run, env } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Queued: lost-watcher-done/, run.stdout);

    const labels = readLabels(fixture);
    assert.equal(labels[label].completionDeliveredAt, undefined);
    assert.equal(labels[label].completionDeliverySource, undefined);
    assert.equal(labels[label].completionRetryCount, 1);

    const db = new Database(env.SCHEDULER_DB);
    try {
      const outbox = db.prepare(
        `SELECT * FROM delivery_outbox WHERE completion_label = ? ORDER BY created_at DESC LIMIT 1`
      ).get(label);
      assert.ok(outbox, 'outbox row enqueued');
      assert.equal(outbox.status, 'pending');
      assert.equal(outbox.channel, DELIVER_CHANNEL);
      assert.equal(outbox.target, DELIVER_TO);
      assert.equal(outbox.idempotency_key, `dispatch-completion:${completionScope(label, labels[label])}:${routeHash()}`);
      assert.match(outbox.body, /The work is complete/);
      const debt = db.prepare(`SELECT * FROM completion_debts WHERE task_label = ?`).get(label);
      assert.equal(debt.status, 'delivering');
      assert.equal(debt.final_reported_at, null);
      const claimed = claimDelivery(outbox.id, { db, owner: 'fixture' });
      assert.equal(markDeliveryDelivered(outbox.id, claimed.claim_token, { db }).transitioned, true);
      assert.equal(db.prepare('SELECT status FROM completion_debts WHERE task_label = ?').get(label).status, 'closed');
    } finally {
      db.close();
    }
    const confirmed = runSafetyNet(fixture);
    assert.equal(confirmed.run.status, 0, confirmed.run.stderr);
    assert.ok(readLabels(fixture)[label].completionDeliveredAt);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a live watcher run for the label is not raced', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'watcher-active';
    writeLabels(fixture, { [label]: doneLabel() });
    // A running watcher run: the safety net must skip, not double-deliver.
    const dbPath = initFixtureDb(fixture);
    createWatcherRun(dbPath, label);

    const { run, env } = runSafetyNet(fixture, { db: dbPath });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /✅ Delivered/, 'must not deliver while a watcher is live');

    const labels = readLabels(fixture);
    assert.equal(labels[label].completionDeliveredAt, undefined, 'label untouched');
    assert.equal(labels[label].completionRetryCount, undefined,
      'watcher skip happens before the attempt is claimed');
    const check = new Database(env.SCHEDULER_DB);
    try {
      assert.equal(
        check.prepare('SELECT COUNT(*) AS c FROM delivery_outbox WHERE completion_label = ?').get(label).c,
        0,
        'no outbox row created',
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('no clean terminal reply re-derivable -> skipped, no fabricated delivery', () => {
  const fixture = createFixture();
  try {
    // Transcript ends in a tool call; store says done but there is no
    // terminal assistant reply and no recorded structured completion.
    seedSession(fixture.databasePath, { terminalReply: null, storeStatus: 'done' });
    const label = 'no-terminal-reply';
    writeLabels(fixture, { [label]: doneLabel() });

    const { run, env } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /✅ Delivered/, 'must not fabricate a delivery');

    const labels = readLabels(fixture);
    assert.equal(labels[label].completionDeliveredAt, undefined);
    assert.equal(labels[label].completionRetryCount, 1, 'attempt counted (retry cap bounds retries)');
    const check = new Database(env.SCHEDULER_DB);
    try {
      assert.equal(
        check.prepare('SELECT COUNT(*) AS c FROM delivery_outbox WHERE completion_label = ?').get(label).c,
        0,
        'no outbox row created',
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('unrelated prefix and wildcard watcher names do not suppress recovery', () => {
  for (const [label, otherLabel] of [['backup', 'backup-extra'], ['backup_%', 'backup-1']]) {
    const fixture = createFixture();
    try {
      seedSession(fixture.databasePath, { terminalReply: 'Completed the requested work and verified the output.' });
      writeLabels(fixture, { [label]: doneLabel() });
      const dbPath = initFixtureDb(fixture);
      createWatcherRun(dbPath, otherLabel);
      const { run } = runSafetyNet(fixture, { db: dbPath });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.stdout.includes(`Queued: ${label}`), run.stdout);
      assert.equal(readLabels(fixture)[label].completionRetryCount, 1);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('recorded watcher identity takes precedence over another run using the same label', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, { terminalReply: 'Completed the requested work and verified the output.' });
    const label = 'reused-watcher';
    writeLabels(fixture, { [label]: doneLabel({ deliveryWatcherJobId: 'current-run-watcher' }) });
    const dbPath = initFixtureDb(fixture);
    createWatcherRun(dbPath, label);
    const { run } = runSafetyNet(fixture, { db: dbPath });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`Queued: ${label}`), run.stdout);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('the recorded watcher job and legacy handoff watcher still suppress duplicate recovery', () => {
  for (const recorded of [true, false]) {
    const fixture = createFixture();
    try {
      seedSession(fixture.databasePath, { terminalReply: 'Completed the requested work and verified the output.' });
      const label = 'watcher-specific';
      const watcherLabel = recorded ? 'renamed-watcher' : `${label}:handoff:123456`;
      writeLabels(fixture, { [label]: doneLabel(recorded
        ? { deliveryWatcherJobId: `watcher-job-${watcherLabel}` } : {}) });
      const dbPath = initFixtureDb(fixture);
      createWatcherRun(dbPath, watcherLabel);
      const { run } = runSafetyNet(fixture, { db: dbPath });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(readLabels(fixture)[label].completionRetryCount, undefined);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('already-delivered label is a no-op', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'already-delivered';
    writeLabels(fixture, {
      [label]: doneLabel({ completionDeliveredAt: new Date().toISOString() }),
    });

    const { run } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /✅ Delivered/, 'no re-delivery');
    const labels = readLabels(fixture);
    assert.equal(labels[label].completionRetryCount, undefined, 'no attempt recorded');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an idempotency-deduped re-enqueue is treated as delivered and closed', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'dedupe-noop';
    const entry = doneLabel();
    writeLabels(fixture, { [label]: entry });

    // Pre-seed the outbox with the same idempotency key AND an equivalent
    // delivery (same body/scope): a prior enqueue already owns this completion
    // (e.g. delivered by the watcher before its label stamp was lost). The
    // safety net must dedupe, not double-send. The body must match exactly or
    // the idempotency-equivalence check throws a collision.
    const dbPath = initFixtureDb(fixture);
    const terminalReply = 'The work is complete. The fix is verified and tests pass.';
    const seedBody = `✅ [${label}] done\n\n${terminalReply}`;
    const scope = completionScope(label, entry);
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO delivery_outbox (id, channel, target, body, status, idempotency_key, completion_label, completion_scope, delivery_group_id, part_index, part_count)
         VALUES (?, ?, ?, ?, 'delivered', ?, ?, ?, ?, 1, 1)`,
      ).run(
        'seed-outbox-row',
        DELIVER_CHANNEL,
        DELIVER_TO,
        seedBody,
        `dispatch-completion:${scope}:${routeHash()}`,
        label,
        scope,
        `dispatch-completion:${scope}:${routeHash()}`,
      );
    } finally {
      db.close();
    }

    const { run } = runSafetyNet(fixture, { db: dbPath });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /✅ Delivered: dedupe-noop/, 'deduped enqueue still counts as delivered');

    const labels = readLabels(fixture);
    assert.ok(labels[label].completionDeliveredAt, 'stamped after dedupe');
    const check = new Database(dbPath);
    try {
      const rows = check.prepare('SELECT * FROM delivery_outbox WHERE completion_label = ?').all(label);
      assert.equal(rows.length, 1, 'no second outbox row (idempotency dedupe)');
      const debt = check.prepare('SELECT * FROM completion_debts WHERE task_label = ?').get(label);
      assert.equal(debt.status, 'closed');
    } finally {
      check.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ancient done label (past the 48h window) is not revived', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'ancient-done';
    const ancient = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    writeLabels(fixture, {
      [label]: doneLabel({ spawnedAt: ancient, updatedAt: ancient }),
    });

    const { run } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /✅ Delivered/, 'ancient label not revived');
    const labels = readLabels(fixture);
    assert.equal(labels[label].completionDeliveredAt, undefined);
    assert.equal(labels[label].completionRetryCount, undefined, 'no attempt recorded');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('retry cap stops hammering a label that never yields a clean completion', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, { terminalReply: null, storeStatus: 'done' });
    const label = 'retry-capped';
    writeLabels(fixture, {
      [label]: doneLabel({
        completionRetryCount: 3,
        completionRetryScope: completionScope(label, doneLabel()),
        lastCompletionAttemptAt: new Date(Date.now() - 600_000).toISOString(),
      }),
    });

    const { run } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /✅ Delivered/);
    const labels = readLabels(fixture);
    assert.equal(labels[label].completionRetryCount, 3, 'cap not incremented past the limit');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runFixtureCode(fixture, code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_DIR, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: fixture.root, OPENCLAW_STATE_DIR: fixture.stateDir,
      DISPATCH_CONFIG_DIR: fixture.configDir, DISPATCH_STATE_DIR: fixture.dispatchState,
      DISPATCH_LABELS_PATH: fixture.labelsPath, SCHEDULER_DB: join(fixture.root, 'scheduler.db') },
  });
}

test('documented registration validates with a timeout and system origin', () => {
  const doc = readFileSync(join(REPO_DIR, 'dispatch/README.md'), 'utf8');
  const match = [...doc.matchAll(/jobs add '(\{[^']+\})'/g)]
    .map(item => JSON.parse(item[1])).find(item => item.name === 'Chilisaus Completion Safety Net');
  assert.ok(match);
  assert.equal(match.origin, 'system');
  assert.equal(match.run_timeout_ms, 300000);
  assert.doesNotThrow(() => validateJobSpec(match));
});

test('thin transcript retains the normal structured-completion precedence', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, { terminalReply: 'I have finished the requested work.' });
    const completion = { summary_human: 'The backup repair is ready. Deployment remains blocked until the restore check passes.' };
    writeLabels(fixture, { 'structured-result': doneLabel({ completion }) });
    const { run, dbPath } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT body FROM delivery_outbox').get();
      assert.match(row.body, /Deployment remains blocked/);
      assert.doesNotMatch(row.body, /I have finished the requested work/);
    } finally { db.close(); }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a reused label receives a fresh retry budget and interval', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, { terminalReply: 'The backup is verified and the restore check passed.' });
    const label = 'reused';
    writeLabels(fixture, { [label]: doneLabel({ runId: 'new-run', completionRetryCount: 3,
      completionRetryScope: completionScope(label, doneLabel()), lastCompletionAttemptAt: new Date().toISOString() }) });
    const { run } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    const row = readLabels(fixture)[label];
    assert.equal(row.completionRetryCount, 1);
    assert.equal(row.completionRetryScope, completionScope(label, row));
    assert.match(run.stdout, /Queued: reused/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('replacement before enqueue cannot receive the claimed old completion', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, { race: doneLabel() });
    const run = runFixtureCode(fixture, `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { initDb, getDb } from './db.js';
      import { claimAttempt, enqueueClaim } from './dispatch/completion-safety-net.mjs';
      await initDb();
      const claim = claimAttempt('race');
      const replacement = { ...claim.entry, runId: 'replacement-run', summary: 'Replacement must survive' };
      writeFileSync(process.env.DISPATCH_LABELS_PATH, JSON.stringify({ race: replacement }));
      const result = enqueueClaim('race', claim, { deliveryText: 'Old report', summary: 'Old report' });
      assert.equal(result.reason, 'label-changed');
      assert.deepEqual(JSON.parse(readFileSync(process.env.DISPATCH_LABELS_PATH)).race, replacement);
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n, 0);
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM completion_debts').get().n, 0);
    `);
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('delayed old confirmation cannot close or stamp a replacement run', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, { race: doneLabel() });
    const run = runFixtureCode(fixture, `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { initDb, getDb } from './db.js';
      import { claimDelivery, markDeliveryDelivered } from './delivery-outbox.js';
      import { recordCompletionDeliveryDebt, buildCompletionDeliveryScope } from './dispatch/hooks.mjs';
      import { claimAttempt, enqueueClaim, reconcileConfirmedDelivery } from './dispatch/completion-safety-net.mjs';
      await initDb();
      const claim = claimAttempt('race');
      const queued = enqueueClaim('race', claim, { deliveryText: 'Old report', summary: 'Old report' });
      assert.equal(queued.enqueued, true);
      const replacement = { ...claim.entry, runId: 'replacement-run', summary: 'Replacement must survive' };
      writeFileSync(process.env.DISPATCH_LABELS_PATH, JSON.stringify({ race: replacement }));
      const nextScope = buildCompletionDeliveryScope({ label: 'race', sessionKey: replacement.sessionKey, runId: replacement.runId });
      recordCompletionDeliveryDebt({ label: 'race', sessionKey: replacement.sessionKey, runId: replacement.runId,
        deliveryScope: nextScope, openReason: 'replacement-awaits-report' });
      await Promise.resolve();
      assert.equal(reconcileConfirmedDelivery('race', claim.entry), false);
      const delivery = claimDelivery(queued.outboxId, { owner: 'fixture' });
      assert.equal(markDeliveryDelivered(queued.outboxId, delivery.claim_token).transitioned, true);
      assert.equal(reconcileConfirmedDelivery('race', claim.entry), false);
      assert.deepEqual(JSON.parse(readFileSync(process.env.DISPATCH_LABELS_PATH)).race, replacement);
      assert.equal(getDb().prepare('SELECT status FROM completion_debts WHERE delivery_scope = ?').get(nextScope).status, 'open');
      assert.equal(getDb().prepare('SELECT status FROM completion_debts WHERE delivery_scope = ?').get(claim.identity.deliveryScope).status, 'closed');
    `);
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('an existing pending claim is not mistaken for confirmed delivery', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, { terminalReply: 'The backup is verified and the restore check passed.' });
    const label = 'pending-claim';
    writeLabels(fixture, { [label]: doneLabel() });
    const first = runSafetyNet(fixture);
    assert.equal(first.run.status, 0, first.run.stderr);
    const entry = readLabels(fixture)[label];
    entry.lastCompletionAttemptAt = new Date(Date.now() - 360000).toISOString();
    writeLabels(fixture, { [label]: entry });
    const second = runSafetyNet(fixture);
    assert.equal(second.run.status, 0, second.run.stderr);
    assert.equal(readLabels(fixture)[label].completionDeliveredAt, undefined);
    const db = new Database(first.dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n, 1);
      const debt = db.prepare('SELECT * FROM completion_debts').get();
      assert.equal(debt.status, 'delivering');
      assert.equal(debt.final_reported_at, null);
    } finally { db.close(); }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('partial or failed multipart delivery cannot confirm the label', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, { multipart: doneLabel() });
    const run = runFixtureCode(fixture, `
      import assert from 'node:assert/strict';
      import { initDb } from './db.js';
      import { enqueueMultipartDelivery, claimDelivery, markDeliveryDelivered, markDeliveryFailed } from './delivery-outbox.js';
      import { claimAttempt, reconcileConfirmedDelivery } from './dispatch/completion-safety-net.mjs';
      await initDb();
      const claim = claimAttempt('multipart');
      const queued = enqueueMultipartDelivery({ body: 'The verified backup report contains important results. '.repeat(100),
        channel: 'telegram', target: 'test-target', idempotencyKey: 'multipart-fixture',
        completionLabel: 'multipart', completionScope: claim.identity.deliveryScope, maxPartBytes: 3000 });
      assert.ok(queued.deliveries.length > 1);
      const first = queued.deliveries[0];
      const owned = claimDelivery(first.id, { owner: 'fixture' });
      markDeliveryDelivered(first.id, owned.claim_token);
      assert.equal(reconcileConfirmedDelivery('multipart', claim.entry), false);
      const second = queued.deliveries[1];
      const failed = claimDelivery(second.id, { owner: 'fixture' });
      markDeliveryFailed(second.id, failed.claim_token, 'fixture failure');
      assert.equal(reconcileConfirmedDelivery('multipart', claim.entry), false);
    `);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readLabels(fixture).multipart.completionDeliveredAt, undefined);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('the last confirmed multipart part permits a completion stamp', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, { multipart: doneLabel() });
    const run = runFixtureCode(fixture, `
      import assert from 'node:assert/strict';
      import { initDb } from './db.js';
      import { enqueueMultipartDelivery, claimDelivery, markDeliveryDelivered } from './delivery-outbox.js';
      import { claimAttempt, reconcileConfirmedDelivery } from './dispatch/completion-safety-net.mjs';
      await initDb();
      const claim = claimAttempt('multipart');
      const queued = enqueueMultipartDelivery({ body: 'The verified backup report contains important results. '.repeat(100),
        channel: 'telegram', target: 'test-target', idempotencyKey: 'multipart-fixture',
        completionLabel: 'multipart', completionScope: claim.identity.deliveryScope, maxPartBytes: 3000 });
      assert.ok(queued.deliveries.length > 1);
      for (const [index, part] of queued.deliveries.entries()) {
        const owned = claimDelivery(part.id, { owner: 'fixture' });
        markDeliveryDelivered(part.id, owned.claim_token);
        assert.equal(reconcileConfirmedDelivery('multipart', claim.entry), index === queued.deliveries.length - 1);
      }
    `);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(readLabels(fixture).multipart.completionDeliveredAt);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});


test('the CLI runs through a symlinked repository root', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, {});
    const linkedRoot = join(fixture.root, 'linked-repository');
    symlinkSync(REPO_DIR, linkedRoot, 'dir');
    const { run } = runSafetyNet(fixture, {
      script: join(linkedRoot, 'dispatch', 'completion-safety-net.mjs'),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /no undelivered done labels found/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});


test('importing recovery helpers does not run the CLI or open the database', () => {
  const fixture = createFixture();
  try {
    writeLabels(fixture, { untouched: doneLabel() });
    const before = readFileSync(fixture.labelsPath, 'utf8');
    const run = runFixtureCode(fixture, "await import('./dispatch/completion-safety-net.mjs');");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
    assert.equal(existsSync(join(fixture.root, 'scheduler.db')), false);
    assert.equal(readFileSync(fixture.labelsPath, 'utf8'), before);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
