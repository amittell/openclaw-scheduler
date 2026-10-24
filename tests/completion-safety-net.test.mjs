import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { readFileSync as readFileSyncImported } from 'node:fs';
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
  const schema = readFileSyncImported(join(REPO_DIR, 'schema.sql'), 'utf8');
  const db = new Database(dbPath);
  try {
    db.exec(schema);
  } finally {
    db.close();
  }
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

function runSafetyNet(fixture, { db = null } = {}) {
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
  const run = spawnSync(process.execPath, [SAFETY_NET_PATH], {
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

test('done label with a lost watcher gets its completion re-delivered and the debt closed', () => {
  const fixture = createFixture();
  try {
    seedSession(fixture.databasePath, {
      terminalReply: 'The work is complete. The fix is verified and tests pass.',
    });
    const label = 'lost-watcher-done';
    writeLabels(fixture, { [label]: doneLabel() });
    const { run, env } = runSafetyNet(fixture);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /✅ Delivered: lost-watcher-done/, run.stdout);

    const labels = readLabels(fixture);
    assert.ok(labels[label].completionDeliveredAt, 'completionDeliveredAt stamped');
    assert.equal(labels[label].completionDeliverySource, 'safety-net');
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
      assert.equal(debt.status, 'closed', 'completion debt closed');
      assert.match(debt.close_reason, /safety-net/);
    } finally {
      db.close();
    }
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
        lastCompletionAttemptAt: new Date(Date.now() - 60_000).toISOString(),
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
