import './isolate-environment.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import migrateConsolidate from '../migrate-consolidate.js';
import {
  canEnqueueDispatch, createJob, deleteJob, getDispatchBacklogCount, getJob,
  nextRunFromCron, scheduleRetry, shouldRetry, updateJob, validateJobSpec,
} from '../jobs.js';
import { createRun, finishRun, getRun } from '../runs.js';
import { enqueueDispatch, setDispatchStatus } from '../dispatch-queue.js';
import { commitCompletionBookkeeping, completeRunFenced, shouldRunPostCompletionEffects } from '../run-completion.js';
import { transitionRunTerminal } from '../run-state.js';
import { createDeliveryHelpers } from '../dispatcher-delivery.js';
import { executeShell, finalizeDispatch } from '../dispatcher-strategies.js';
import { createScheduleBookkeeping } from '../dispatcher-maintenance.js';
import { getBackoffMs, sqliteNow } from '../dispatcher-utils.js';
import { normalizeShellResult } from '../shell-result.js';

// Measured 2026-11-13/14: the gateway's final text for an agent turn is every
// reply payload of the run joined with a blank line, so the AILY daily status
// delivery began with the model's step narration ahead of its report heading.
const MARKER = '**AILY daily status**';
const NARRATION = 'Fetching git + GitHub state.\n\nAll data in. Updating checkpoint, then sending the report.';
const REPORT = `${MARKER} - 2026-11-14\n\n- 3 pull requests merged\n- CI green on main`;
const REPLY = `${NARRATION}\n\n${REPORT}`;
const NOT_FOUND = /delivery_from marker not found .*delivering the full text/;

const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'cli.js');
const tmpRoot = mkdtempSync(join(tmpdir(), 'scheduler-delivery-from-'));
const v4FixturePath = join(root, 'tests', 'fixtures', 'handoff-v4-approval-proof-job.json');

after(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function memoryDb() {
  setDbPath(':memory:');
  await initDb();
  return getDb();
}

async function openFile(name) {
  closeDb();
  setDbPath(join(tmpRoot, `${name}.db`));
  await initDb();
  return getDb();
}

function agentJob(overrides = {}) {
  return createJob({
    name: 'AILY daily status',
    schedule_cron: '0 8 * * *',
    session_target: 'isolated',
    payload_kind: 'agentTurn',
    payload_message: 'Report the daily status.',
    delivery_mode: 'announce-always',
    delivery_channel: 'telegram',
    delivery_to: '123456789',
    delivery_summary: 'none',
    run_timeout_ms: 300_000,
    origin: 'system',
    ...overrides,
  });
}

function finalizeFixture(job, extraDeps = {}) {
  const logs = [];
  const log = (level, msg, meta) => logs.push({ level, msg, meta });
  const { updateJobAfterRun } = createScheduleBookkeeping({
    getDb, getJob, updateJob, deleteJob, sqliteNow, nextRunFromCron, getBackoffMs, log: () => {},
  });
  const { handleDelivery } = createDeliveryHelpers({ log: () => {}, resolveDeliveryAlias: () => null });
  const run = createRun(job.id);
  const deps = {
    getDb, getJob, updateJob, deleteJob, finishRun, completeRunFenced, transitionRunTerminal,
    commitCompletionBookkeeping, shouldRunPostCompletionEffects, updateJobAfterRun, shouldRetry,
    scheduleRetry, canEnqueueDispatch, getDispatchBacklogCount, enqueueDispatch, setDispatchStatus,
    sqliteNow, handleDelivery, log, alertTransitFailure: async () => ({ sent: true }),
    updateIdempotencyResultHash: () => {}, releaseIdempotencyKey: () => {}, setAgentStatus: () => {},
    handleTriggeredChildren: () => {}, dequeueJob: () => false,
    ...extraDeps,
  };
  const ctx = { run, dispatchRecord: null, idemKey: null, v02Outcomes: null, v4Artifact: null };
  return { run, deps, ctx, logs };
}

// The DispatchResult executeAgent builds from a gateway reply.
function agentResult(content, status = 'ok') {
  return {
    status,
    summary: content.slice(0, 5000),
    content,
    errorMessage: status === 'error' ? 'Agent signalled TASK_FAILED' : null,
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: false,
    skipJobUpdate: false,
    skipChildren: true,
    skipDequeue: true,
    skipAgentCleanup: true,
    idemAction: 'noop',
  };
}

function outboxBodies(runId) {
  return getDb().prepare('SELECT body FROM delivery_outbox WHERE run_id = ? ORDER BY part_index').all(runId)
    .map(row => row.body);
}

function warnings(logs) {
  return logs.filter(entry => entry.level === 'warn');
}

// -- selection rules -------------------------------------------------------

test('selectDeliveryFrom: one marker line delivers from that line to the end', async () => {
  const { selectDeliveryFrom } = await import('../delivery-from.js');
  assert.deepEqual(selectDeliveryFrom(REPLY, MARKER), { found: true, matches: 1, text: REPORT });
});

test('selectDeliveryFrom: the last line that starts with the marker wins', async () => {
  const { selectDeliveryFrom } = await import('../delivery-from.js');
  const text = `${MARKER} coming up after the fetch.\nFetching.\n\n${REPORT}`;
  assert.deepEqual(selectDeliveryFrom(text, MARKER), { found: true, matches: 2, text: REPORT });
});

test('selectDeliveryFrom: a marker later in a line does not count', async () => {
  const { selectDeliveryFrom } = await import('../delivery-from.js');
  const midLine = `Sending ${MARKER} now.\nDone.`;
  assert.deepEqual(selectDeliveryFrom(midLine, MARKER), { found: false, matches: 0, text: midLine });
  assert.equal(selectDeliveryFrom(`${midLine}\n\n${REPORT}`, MARKER).text, REPORT);
  assert.equal(selectDeliveryFrom(`${REPORT}\nquoted again: ${MARKER}`, MARKER).text, `${REPORT}\nquoted again: ${MARKER}`);
});

test('selectDeliveryFrom: leading whitespace before the marker is allowed and the rest is unchanged', async () => {
  const { selectDeliveryFrom } = await import('../delivery-from.js');
  assert.equal(selectDeliveryFrom(`narration\r\n \t${MARKER} x\r\nline two\r\n`, MARKER).text, `${MARKER} x\r\nline two\r\n`);
  assert.equal(selectDeliveryFrom(MARKER, MARKER).text, MARKER);
});

test('selectDeliveryFrom: an unset or blank marker returns the text unchanged', async () => {
  const { selectDeliveryFrom } = await import('../delivery-from.js');
  for (const marker of [null, undefined, '', '   ']) {
    assert.deepEqual(selectDeliveryFrom(REPLY, marker), { found: false, matches: 0, text: REPLY });
  }
});

test('applyDeliveryFrom: no matching line returns the same text and logs one warning', async () => {
  const { applyDeliveryFrom } = await import('../delivery-from.js');
  const logs = [];
  const job = { id: 'j1', name: 'probe', delivery_from: '## Missing' };
  const returned = applyDeliveryFrom(job, REPLY, { log: (level, msg) => logs.push({ level, msg }), runId: 'r1' });
  assert.equal(returned, REPLY);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].msg, NOT_FOUND);
});

test('applyDeliveryFrom: unset markers and handoff v4 jobs change nothing and log nothing', async () => {
  const { applyDeliveryFrom } = await import('../delivery-from.js');
  const logs = [];
  const log = (level, msg) => logs.push({ level, msg });
  for (const job of [
    { name: 'unset' },
    { name: 'null', delivery_from: null },
    { name: 'empty', delivery_from: '' },
    { name: 'v4', delivery_from: MARKER, handoff_version: 4 },
  ]) {
    assert.equal(applyDeliveryFrom(job, REPLY, { log }), REPLY, job.name);
  }
  assert.deepEqual(logs, []);
});

// -- the delivered body ------------------------------------------------------

test('agent reply is delivered from the marker; the run record keeps the full reply', async () => {
  await memoryDb();
  const job = agentJob({ delivery_from: MARKER });
  const { run, deps, ctx, logs } = finalizeFixture(job);
  await finalizeDispatch(job, ctx, agentResult(REPLY), deps);
  assert.deepEqual(outboxBodies(run.id), [REPORT]);
  const stored = getRun(run.id);
  assert.equal(stored.status, 'ok');
  assert.equal(stored.summary, REPLY, 'runs.summary keeps the narration and the report');
  assert.deepEqual(warnings(logs), []);
});

test('without delivery_from the delivered body is byte-identical to the reply', async () => {
  await memoryDb();
  for (const value of [undefined, null]) {
    const job = agentJob(value === undefined ? {} : { delivery_from: value });
    assert.equal(getJob(job.id).delivery_from, null);
    const { run, deps, ctx, logs } = finalizeFixture(job);
    await finalizeDispatch(job, ctx, agentResult(REPLY), deps);
    assert.deepEqual(outboxBodies(run.id), [REPLY]);
    assert.deepEqual(warnings(logs), []);
  }
});

test('marker absent: the full reply is delivered and one warning is logged', async () => {
  await memoryDb();
  const job = agentJob({ delivery_from: '## Weekly report' });
  const { run, deps, ctx, logs } = finalizeFixture(job);
  await finalizeDispatch(job, ctx, agentResult(REPLY), deps);
  assert.deepEqual(outboxBodies(run.id), [REPLY]);
  const warned = warnings(logs);
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, NOT_FOUND);
  assert.equal(getRun(run.id).summary, REPLY);
});

test('a soft-failed agent run keeps its failure header above the selected report', async () => {
  await memoryDb();
  const job = agentJob({ delivery_from: MARKER, delivery_mode: 'announce' });
  const { run, deps, ctx } = finalizeFixture(job);
  await finalizeDispatch(job, ctx, agentResult(REPLY, 'error'), deps);
  const [body] = outboxBodies(run.id);
  assert.match(body, /^\u26a0\ufe0f Job soft-failed \((?:will retry|no retry scheduled)\): AILY daily status\n\n/);
  assert.ok(body.endsWith(`\n\n${REPORT}`), body);
  assert.ok(!body.includes('Fetching git'), 'the narration is not delivered');
  assert.equal(getRun(run.id).summary, REPLY);
});

test('delivery_summary summarizes only the report and the stored full body is the whole reply', async () => {
  await memoryDb();
  const longReport = `${REPORT}\n${'- repository checked and up to date\n'.repeat(20)}`;
  const longReply = `${NARRATION}\n\n${longReport}`;
  const job = agentJob({ delivery_from: MARKER, delivery_summary: 'llm' });
  const artifacts = [];
  const { run, deps, ctx } = finalizeFixture(job, {
    storeRunArtifact: (kind, runId, text) => {
      const path = join(tmpRoot, `${kind}-${runId}.txt`);
      writeFileSync(path, text);
      artifacts.push(path);
      return path;
    },
  });
  const prompts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages.at(-1).content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Three pull requests merged and CI is green.' } }] }) };
  };
  try {
    await finalizeDispatch(job, ctx, agentResult(longReply), deps);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(longReport), 'the summary prompt carries the report');
  assert.ok(!prompts[0].includes('Fetching git'), 'the summary prompt does not carry the narration');
  assert.deepEqual(outboxBodies(run.id), ['Three pull requests merged and CI is green.']);
  const context = JSON.parse(getRun(run.id).context_summary);
  assert.equal(context.agent_delivery.raw_chars, longReport.length);
  assert.equal(readFileSync(context.agent_delivery.full_body.path, 'utf8'), longReply);
  assert.equal(context.agent_delivery.full_body.bytes, Buffer.byteLength(longReply, 'utf8'));
});

test('shell jobs deliver stdout from the marker and keep the failure header', async () => {
  const stdout = `${NARRATION}\n${REPORT}\n`;
  const runShell = (job, failed) => executeShell(job, { run: { id: `run-${job.name}` } }, {
    runShellCommand: async () => ({
      stdout,
      stderr: '',
      error: failed ? Object.assign(new Error('Command failed'), { code: 1 }) : null,
      exitCode: failed ? 1 : 0,
    }),
    normalizeShellResult,
    log: () => {},
  });
  const base = {
    payload_message: 'report.sh',
    run_timeout_ms: 30_000,
    shell_env_policy: 'minimal',
    delivery_mode: 'announce-always',
    delivery_from: MARKER,
  };

  const ok = await runShell({ ...base, id: 'shell-ok', name: 'shell-ok' }, false);
  assert.equal(ok.deliveryOverride, REPORT);
  assert.ok(ok.content.includes('Fetching git'), 'result.content keeps the full output');
  assert.ok(ok.summary.includes('Fetching git'), 'result.summary keeps the full output');

  const failed = await runShell({ ...base, id: 'shell-fail', name: 'shell-fail' }, true);
  assert.equal(failed.status, 'error');
  assert.equal(failed.deliveryOverride, `\u26a0\ufe0f Shell job failed: shell-fail\n\n${REPORT}`);

  const unset = await runShell({ ...base, id: 'shell-unset', name: 'shell-unset', delivery_from: null }, false);
  assert.equal(unset.deliveryOverride, `stdout:\n${NARRATION}\n${REPORT}`);
});

// -- validation ------------------------------------------------------------

test('validation accepts a one-line marker and rejects line breaks, control characters, and bad lengths', async () => {
  await memoryDb();
  const spec = {
    name: 'validation probe',
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_message: 'true',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    origin: 'system',
  };
  assert.equal(validateJobSpec({ ...spec, delivery_from: MARKER }).delivery_from, MARKER);
  assert.equal(validateJobSpec({ ...spec, delivery_from: 'x'.repeat(200) }).delivery_from.length, 200);
  assert.equal(validateJobSpec({ ...spec, delivery_from: null }).delivery_from, null);
  for (const [value, message] of [
    ['first\nsecond', /single line/],
    ['first\r\nsecond', /single line/],
    ['first\rsecond', /single line/],
    ['first\u2028second', /single line/],
    ['x'.repeat(201), /max length of 200/],
    ['tab\there', /control characters/],
    ['bell\u0007', /control characters/],
    ['del\u007f', /control characters/],
    ['', /cannot be empty/],
    ['   ', /cannot be empty/],
    [42, /must be a string/],
    [['**X**'], /must be a string/],
  ]) {
    assert.throws(() => validateJobSpec({ ...spec, delivery_from: value }), message, JSON.stringify(value));
    assert.throws(() => createJob({ ...spec, delivery_from: value }), message, JSON.stringify(value));
  }

  const job = createJob({ ...spec, delivery_from: MARKER });
  assert.equal(getJob(job.id).delivery_from, MARKER);
  assert.throws(() => updateJob(job.id, { delivery_from: 'a\nb' }), /single line/);
  assert.equal(getJob(job.id).delivery_from, MARKER, 'a rejected update leaves the marker unchanged');
  assert.equal(updateJob(job.id, { delivery_from: '## Report' }).delivery_from, '## Report');
  assert.equal(updateJob(job.id, { delivery_from: null }).delivery_from, null, 'null clears the marker');
  assert.equal(updateJob(job.id, { name: 'renamed probe' }).delivery_from, null);
});

test('handoff v4 jobs cannot carry a delivery_from marker', async () => {
  await memoryDb();
  const fixture = JSON.parse(readFileSync(v4FixturePath, 'utf8'));
  assert.doesNotThrow(() => validateJobSpec(fixture), 'the v4 fixture is valid without the field');
  assert.throws(
    () => validateJobSpec({ ...fixture, delivery_from: MARKER }),
    error => error.code === 'HANDOFF_V4_DELIVERY_FROM_UNSUPPORTED',
  );
  const job = createJob(fixture);
  assert.throws(
    () => updateJob(job.id, { delivery_from: MARKER }),
    error => error.code === 'HANDOFF_V4_DELIVERY_FROM_UNSUPPORTED',
  );
  assert.equal(updateJob(job.id, { delivery_from: null }).delivery_from, null, 'clearing is allowed');
});

// -- migration -------------------------------------------------------------

function schemaVersion(db) {
  return db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
}

function jobColumns(db) {
  return db.prepare('PRAGMA table_info(jobs)').all();
}

test('an existing v31 database gains delivery_from on the next start and stays at schema 31', async () => {
  let db = await openFile('existing-v31');
  const before = agentJob({ name: 'job created before the upgrade' });
  // The jobs table as origin/main (schema v31) creates it: no delivery_from.
  db.exec('ALTER TABLE jobs DROP COLUMN delivery_from');
  assert.equal(jobColumns(db).some(column => column.name === 'delivery_from'), false);
  assert.equal(schemaVersion(db), 31);

  db = await openFile('existing-v31');
  const added = jobColumns(db).filter(column => column.name === 'delivery_from');
  assert.equal(added.length, 1, 'the next start adds the column');
  assert.equal(added[0].type, 'TEXT');
  assert.equal(added[0].dflt_value, 'NULL');
  assert.equal(added[0].notnull, 0);
  assert.equal(schemaVersion(db), 31, 'no schema version is recorded for the column');
  assert.equal(getJob(before.id).delivery_from, null, 'existing rows read NULL (deliver the full text)');
  assert.equal(migrateConsolidate(), false, 'the upgraded database is a consolidation no-op');

  db = await openFile('existing-v31');
  assert.equal(jobColumns(db).filter(column => column.name === 'delivery_from').length, 1, 'a second start changes nothing');
  assert.equal(migrateConsolidate(), false);

  // What an older v31 release does with this database: its consolidation
  // check refuses only a schema version above 31, and it writes jobs with a
  // column list that does not name delivery_from.
  assert.ok(schemaVersion(db) <= 31);
  db.prepare(`
    INSERT INTO jobs (id, name, schedule_cron, session_target, payload_kind, payload_message, delivery_mode, run_timeout_ms, origin)
    VALUES ('older-release-job', 'older release job', '0 * * * *', 'shell', 'shellCommand', 'true', 'none', 5000, 'system')
  `).run();
  const olderRow = db.prepare("SELECT * FROM jobs WHERE id = 'older-release-job'").get();
  assert.equal(olderRow.delivery_from, null);
  assert.equal(olderRow.name, 'older release job');
});

test('the consolidation migration is idempotent on a database that already has delivery_from', async () => {
  let db = await openFile('rerun');
  const job = agentJob({ delivery_from: MARKER });
  // Force the full consolidation path (as the existing index-repair test does).
  db.exec('DROP INDEX idx_delivery_outbox_group_part');
  assert.equal(migrateConsolidate(), true, 'the full migration ran');
  db = await openFile('rerun');
  assert.equal(jobColumns(db).filter(column => column.name === 'delivery_from').length, 1);
  assert.equal(getJob(job.id).delivery_from, MARKER, 'the stored marker survives the migration');
  assert.equal(schemaVersion(db), 31);
  assert.equal(migrateConsolidate(), false);
});

// -- CLI -------------------------------------------------------------------

function cli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
}

function cliJson(result) {
  assert.notEqual(result.stdout.trim(), '', `expected JSON stdout; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('CLI: jobs add, update, validate, get, list and schema handle delivery_from', () => {
  const env = { SCHEDULER_DB: join(tmpRoot, 'cli.db') };
  const spec = {
    name: 'CLI delivery_from probe',
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf ready',
    delivery_mode: 'none',
    run_timeout_ms: 5_000,
    origin: 'system',
  };

  const schema = cli(['schema', 'jobs', '--json'], env);
  assert.equal(schema.status, 0, schema.stderr);
  const field = cliJson(schema).fields.delivery_from;
  assert.equal(field.type, 'string');
  assert.equal(field.nullable, true);
  assert.equal(field.maxLength, 200);

  const valid = cli(['jobs', 'validate', JSON.stringify({ ...spec, delivery_from: MARKER }), '--json'], env);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.equal(cliJson(valid).normalized.delivery_from, MARKER);
  for (const [value, message] of [
    ['line one\nline two', /single line/],
    ['x'.repeat(201), /max length of 200/],
    ['nul\u0000byte', /control characters/],
  ]) {
    const rejected = cli(['jobs', 'validate', JSON.stringify({ ...spec, delivery_from: value }), '--json'], env);
    assert.notEqual(rejected.status, 0, `jobs validate accepted ${JSON.stringify(value)}`);
    assert.match(cliJson(rejected).error, message);
  }

  const added = cli(['jobs', 'add', JSON.stringify({ ...spec, delivery_from: MARKER }), '--json'], env);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const jobId = cliJson(added).job.id;
  assert.equal(cliJson(added).job.delivery_from, MARKER);

  const got = cli(['jobs', 'get', jobId, '--json'], env);
  assert.equal(got.status, 0, got.stderr);
  assert.equal(cliJson(got).delivery_from, MARKER);
  const listed = cli(['jobs', 'list', '--json'], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(cliJson(listed).find(job => job.id === jobId).delivery_from, MARKER);

  const badUpdate = cli(['jobs', 'update', jobId, JSON.stringify({ delivery_from: 'a\rb' }), '--json'], env);
  assert.notEqual(badUpdate.status, 0);
  assert.match(cliJson(badUpdate).error, /single line/);
  assert.equal(cliJson(cli(['jobs', 'get', jobId, '--json'], env)).delivery_from, MARKER);

  const cleared = cli(['jobs', 'update', jobId, JSON.stringify({ delivery_from: null }), '--json'], env);
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.equal(cliJson(cleared).job.delivery_from, null);
  assert.equal(cliJson(cli(['jobs', 'get', jobId, '--json'], env)).delivery_from, null);
});
