import './isolate-environment.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import migrateConsolidate from '../migrate-consolidate.js';
import { cancelJob, createJob, getDispatchBacklogCount, pruneOrphanedDispatchJobs } from '../jobs.js';

// The per-job active-backlog probes ran an index->table seek for every
// historical dispatch row of the job: on a production host with 225,000
// unpruned 'done' rows one COUNT(*) stalled the event loop past the dispatcher
// lease TTL. These tests pin the plan of the statements the code actually runs.

const ACTIVE_INDEX = 'idx_dispatch_queue_job_active';
// Exactly the definition created by hand on the affected production hosts.
const HAND_MADE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_dispatch_queue_job_active ON job_dispatch_queue(job_id, status) WHERE status IN ('pending', 'claimed', 'awaiting_approval');";
const ACTIVE_STATUS_PREDICATE = /status IN \('pending', 'claimed', 'awaiting_approval'\)/;

const tmpRoot = mkdtempSync(join(tmpdir(), 'scheduler-dispatch-active-index-'));
const stateDir = join(tmpRoot, 'dispatch');
const labelsPath = join(stateDir, 'labels.json');
mkdirSync(stateDir, { recursive: true });

after(() => {
  closeDb();
  delete process.env.DISPATCH_STATE_DIR;
  delete process.env.DISPATCH_LABELS_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function openFresh(name) {
  setDbPath(join(tmpRoot, `${name}.db`));
  await initDb();
  return getDb();
}

async function reopen(name) {
  closeDb();
  setDbPath(join(tmpRoot, `${name}.db`));
  await initDb();
  return getDb();
}

function indexSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ACTIVE_INDEX)?.sql ?? null;
}

function schemaVersion(db) {
  return db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
}

function shellJob(name) {
  return createJob({
    name,
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    origin: 'system',
  });
}

// Record the SQL text of every statement the code prepares while fn runs.
function captureStatements(db, fn) {
  const seen = [];
  const original = db.prepare;
  db.prepare = function prepare(sql) {
    seen.push(sql);
    return original.call(this, sql);
  };
  try {
    fn();
  } finally {
    delete db.prepare;
  }
  return seen;
}

function activeBacklogStatements(statements) {
  return [...new Set(statements.filter(sql => /job_dispatch_queue/.test(sql) && ACTIVE_STATUS_PREDICATE.test(sql)))];
}

function planOf(db, sql) {
  const params = Array((sql.match(/\?/g) || []).length).fill('probe');
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(' | ');
}

// The production probes: getDispatchBacklogCount, the dispatch-family reaper
// guard (REAPER_GUARD_SQL) and the cancel UPDATE.
function hotStatements(db) {
  process.env.DISPATCH_STATE_DIR = stateDir;
  process.env.DISPATCH_LABELS_PATH = labelsPath;
  writeFileSync(labelsPath, JSON.stringify({ 'index-probe-label': { status: 'done' } }) + '\n');
  const backlogJob = shellJob(`backlog probe ${Math.random()}`);
  const watcher = createJob({
    name: 'dispatch-deliver:index-probe-label',
    schedule_cron: '* * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    delete_after_run: 1,
    ttl_hours: 48,
    origin: 'system',
  });
  db.prepare("UPDATE jobs SET created_at = datetime('now', '-49 hours') WHERE id = ?").run(watcher.id);
  const cancelTarget = shellJob(`cancel probe ${Math.random()}`);

  const backlog = activeBacklogStatements(captureStatements(db, () => getDispatchBacklogCount(backlogJob.id)));
  const reaper = activeBacklogStatements(captureStatements(db, () => pruneOrphanedDispatchJobs()));
  const cancel = activeBacklogStatements(captureStatements(db, () => cancelJob(cancelTarget.id)));
  assert.equal(backlog.length, 1, 'getDispatchBacklogCount prepares one active-backlog query');
  assert.ok(reaper.length >= 1, 'the dispatch-family reaper prepares its active-backlog guard');
  assert.ok(cancel.some(sql => /UPDATE job_dispatch_queue/.test(sql)), 'cancelJob prepares its cancel UPDATE');
  return { backlog, reaper, cancel };
}

function assertHotPlansUseActiveIndex(db) {
  const { backlog, reaper, cancel } = hotStatements(db);
  for (const [label, statements] of Object.entries({ backlog, reaper, cancel })) {
    for (const sql of statements) {
      const plan = planOf(db, sql);
      assert.match(
        plan,
        new RegExp(`USING (COVERING )?INDEX ${ACTIVE_INDEX} \\(job_id=\\? AND status=\\?\\)`),
        `${label} statement must search ${ACTIVE_INDEX}; plan was: ${plan}`,
      );
    }
  }
}

test('net-new install: backlog count, reaper guard and cancel search the active-dispatch index', async () => {
  const db = await openFresh('net-new');
  assertHotPlansUseActiveIndex(db);
  assert.notEqual(indexSql(db), null, `${ACTIVE_INDEX} exists after init`);
  assert.equal(schemaVersion(db), 31);
  assert.equal(migrateConsolidate(), false, 'a net-new database is already a consolidation no-op');
});

test('existing v31 database without the index gets it on the next init, still at schema 31', async () => {
  let db = await openFresh('existing-v31');
  db.exec(`DROP INDEX IF EXISTS ${ACTIVE_INDEX}`);
  assert.equal(indexSql(db), null);
  assert.match(
    planOf(db, "SELECT COUNT(*) AS cnt FROM job_dispatch_queue WHERE job_id = ? AND status IN ('pending', 'claimed', 'awaiting_approval')"),
    /idx_dispatch_queue_job \(job_id=\?\)/,
    'without the index the backlog count falls back to the per-job seek',
  );

  db = await reopen('existing-v31');
  assertHotPlansUseActiveIndex(db);
  assert.notEqual(indexSql(db), null, 'init repaired the missing index');
  assert.equal(schemaVersion(db), 31, 'the repair does not bump the schema version');
  assert.equal(migrateConsolidate(), false, 'the repaired database is a consolidation no-op');
});

test('a database with the hand-made index is a no-op and keeps that index unchanged', async () => {
  let db = await openFresh('hand-made');
  db.exec(`DROP INDEX IF EXISTS ${ACTIVE_INDEX}`);
  db.exec(HAND_MADE_INDEX_SQL);
  const handMade = indexSql(db);

  assert.equal(migrateConsolidate(), false, 'the hand-made definition passes the consolidation check');
  const executed = [];
  const originalExec = db.exec;
  db.exec = function exec(sql) {
    executed.push(sql);
    return originalExec.call(this, sql);
  };
  try {
    await initDb();
    await initDb();
  } finally {
    delete db.exec;
  }
  assert.deepEqual(
    executed.filter(sql => sql.includes(ACTIVE_INDEX)),
    [],
    'init neither dropped nor recreated the hand-made index',
  );
  db = await reopen('hand-made');
  assert.equal(indexSql(db), handMade, 'the hand-made definition is what the database stores');
  const sameShape = db.prepare('PRAGMA index_list(job_dispatch_queue)').all()
    .filter(index => db.prepare(`PRAGMA index_info(${index.name})`).all()
      .map(column => column.name).join(',') === 'job_id,status');
  assert.deepEqual(sameShape.map(index => index.name), [ACTIVE_INDEX], 'no duplicate (job_id, status) index');
  assertHotPlansUseActiveIndex(db);
});

test('a same-named index with another definition is rebuilt to the required shape', async () => {
  let db = await openFresh('wrong-shape');
  db.exec(`DROP INDEX IF EXISTS ${ACTIVE_INDEX}`);
  db.exec(`CREATE INDEX ${ACTIVE_INDEX} ON job_dispatch_queue(job_id, status) WHERE status IN ('claimed', 'pending', 'awaiting_approval')`);

  db = await reopen('wrong-shape');
  assert.match(indexSql(db), /WHERE status IN \('pending', 'claimed', 'awaiting_approval'\)/);
  assertHotPlansUseActiveIndex(db);
  assert.equal(migrateConsolidate(), false);
});
