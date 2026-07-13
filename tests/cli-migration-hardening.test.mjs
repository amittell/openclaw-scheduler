import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import {
  convertOpenClawJob,
  cronFromSchedule,
  extractListedJobIds,
  parseMigrationArgs,
} from '../migrate.js';

const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'cli.js');
const binPath = join(root, 'bin', 'openclaw-scheduler.js');
const migratePath = join(root, 'migrate.js');
const consolidatePath = join(root, 'migrate-consolidate.js');

function tempRoot(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(script, args, { env = {}, input } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    input,
    windowsHide: true,
  });
}

function parseStdout(result) {
  assert.notEqual(result.stdout.trim(), '', `expected JSON stdout; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function validShellJob(overrides = {}) {
  return {
    name: 'CLI hardening probe',
    schedule_cron: '0 * * * *',
    schedule_tz: 'UTC',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf ready',
    run_timeout_ms: 5000,
    delivery_mode: 'none',
    origin: 'system',
    ...overrides,
  };
}

test('help, version, schema, capabilities, and validation avoid database initialization', t => {
  const dir = tempRoot(t, 'scheduler-no-db-');
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'file');
  const env = { SCHEDULER_DB: join(blocker, 'scheduler.db') };

  const help = runNode(cliPath, [], { env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: openclaw-scheduler/);

  const version = runNode(cliPath, ['version', '--json'], { env });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(parseStdout(version).version, '0.4.0');

  const launcherVersion = runNode(binPath, ['--json', 'version'], { env });
  assert.equal(launcherVersion.status, 0, launcherVersion.stderr);
  assert.equal(parseStdout(launcherVersion).version, '0.4.0');

  const schema = runNode(cliPath, ['schema', 'jobs', '--json'], { env });
  assert.equal(schema.status, 0, schema.stderr);
  assert.deepEqual(parseStdout(schema).fields.execution_intent.enum, ['execute', 'plan', 'fire-and-forget']);

  const capabilities = runNode(cliPath, ['capabilities', '--json'], { env });
  assert.equal(capabilities.status, 0, capabilities.stderr);
  assert.equal(parseStdout(capabilities).schema_version, 28);

  const launcherCapabilities = runNode(binPath, ['--json', 'capabilities'], { env });
  assert.equal(launcherCapabilities.status, 0, launcherCapabilities.stderr);
  assert.equal(parseStdout(launcherCapabilities).schema_version, 28);

  const specPath = join(dir, 'job.json');
  writeFileSync(specPath, JSON.stringify(validShellJob()));
  const validateFile = runNode(cliPath, ['jobs', 'validate', '--file', specPath, '--json'], { env });
  assert.equal(validateFile.status, 0, validateFile.stderr);
  assert.equal(parseStdout(validateFile).valid, true);

  const validateStdin = runNode(cliPath, ['jobs', 'validate', '--stdin', '--json'], {
    env,
    input: JSON.stringify(validShellJob({ name: 'stdin validation' })),
  });
  assert.equal(validateStdin.status, 0, validateStdin.stderr);
  assert.equal(parseStdout(validateStdin).valid, true);

  const dryRun = runNode(cliPath, ['jobs', 'add', '--file', specPath, '--dry-run', '--json'], { env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(parseStdout(dryRun).dry_run, true);
});

test('CLI emits structured failures and nonzero not-found exits', t => {
  const dir = tempRoot(t, 'scheduler-errors-');
  const env = { SCHEDULER_DB: join(dir, 'scheduler.db') };

  for (const args of [
    ['jobs', 'get', 'missing', '--json'],
    ['jobs', 'enable', 'missing', '--json'],
    ['jobs', 'run', 'missing', '--json'],
    ['runs', 'get', 'missing', '--json'],
    ['runs', 'output', 'missing', '--json'],
    ['msg', 'ack', 'missing', '--json'],
    ['alias', 'remove', 'missing', '--json'],
    ['agents', 'get', 'missing', '--json'],
  ]) {
    const result = runNode(cliPath, args, { env });
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
    const payload = parseStdout(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'NOT_FOUND');
  }

  const invalid = runNode(cliPath, ['jobs', 'validate', '{broken', '--json'], { env });
  assert.notEqual(invalid.status, 0);
  assert.equal(parseStdout(invalid).code, 'INVALID_JSON');
});

test('jobs add and update accept file and stdin JSON payloads', t => {
  const dir = tempRoot(t, 'scheduler-payloads-');
  const env = { SCHEDULER_DB: join(dir, 'scheduler.db') };
  const specPath = join(dir, 'job.json');
  writeFileSync(specPath, JSON.stringify(validShellJob()));

  const added = runNode(cliPath, ['jobs', 'add', '--file', specPath, '--json'], { env });
  assert.equal(added.status, 0, added.stderr);
  const addedPayload = parseStdout(added);
  assert.equal(addedPayload.ok, true);
  assert.ok(addedPayload.job.id);

  const updated = runNode(cliPath, ['jobs', 'update', addedPayload.job.id, '--stdin', '--json'], {
    env,
    input: JSON.stringify({ name: 'Updated through stdin' }),
  });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(parseStdout(updated).job.name, 'Updated through stdin');
});

test('doctor reports schema v28 and lease, queue, outbox, and approval diagnostics', t => {
  const dir = tempRoot(t, 'scheduler-doctor-');
  const result = runNode(cliPath, ['doctor', '--json'], {
    env: { SCHEDULER_DB: join(dir, 'scheduler.db') },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.database.schema_version, 28);
  assert.equal(payload.database.latest_schema_version, 28);
  assert.ok('dispatcher_lease' in payload.diagnostics);
  assert.ok('dispatch_queue' in payload.diagnostics);
  assert.ok('delivery_outbox' in payload.diagnostics);
  assert.ok('approvals' in payload.diagnostics);
  assert.deepEqual(payload.database.integrity_check, ['ok']);
  assert.equal(payload.database.foreign_key_violations, 0);
});

test('schema v28 consolidation repairs missing required indexes before taking the no-op path', t => {
  const dir = tempRoot(t, 'scheduler-index-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const initialized = runNode(cliPath, ['doctor', '--json'], { env });
  assert.equal(initialized.status, 0, initialized.stderr);

  const db = new Database(dbPath);
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 28);
    db.exec('DROP INDEX idx_delivery_outbox_group_part');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_outbox_group_part'").get().count,
      0,
    );
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);

  const repairedDb = new Database(dbPath, { readonly: true });
  try {
    assert.equal(
      repairedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_outbox_group_part'").get().count,
      1,
    );
  } finally {
    repairedDb.close();
  }

  const noOp = runNode(consolidatePath, [], { env });
  assert.equal(noOp.status, 0, noOp.stderr);
  assert.match(noOp.stdout, /DB already at v28/);
});

test('schema v28 consolidation recreates a completely missing approvals table', t => {
  const dir = tempRoot(t, 'scheduler-approvals-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const initialized = runNode(cliPath, ['doctor', '--json'], { env });
  assert.equal(initialized.status, 0, initialized.stderr);

  const db = new Database(dbPath);
  try {
    db.exec('DROP TABLE approvals');
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);

  const repairedDb = new Database(dbPath, { readonly: true });
  try {
    const columns = new Set(repairedDb.prepare('PRAGMA table_info(approvals)').all().map(column => column.name));
    for (const column of [
      'dispatch_queue_id', 'decision_version', 'risk_level', 'approver_scope',
      'binding_hash', 'gate_kind', 'decision_context',
    ]) {
      assert(columns.has(column), `recreated approvals table missing ${column}`);
    }
    assert.equal(
      repairedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_approvals_dispatch_queue'").get().count,
      1,
    );
  } finally {
    repairedDb.close();
  }
});

test('doctor fails closed on foreign-key corruption', t => {
  const dir = tempRoot(t, 'scheduler-doctor-fk-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const initialized = runNode(cliPath, ['doctor', '--json'], { env });
  assert.equal(initialized.status, 0, initialized.stderr);

  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO runs (id, job_id, status) VALUES ('orphan-run', 'missing-job', 'error')").run();
  } finally {
    db.close();
  }

  const result = runNode(cliPath, ['doctor', '--json'], { env });
  assert.notEqual(result.status, 0);
  const payload = parseStdout(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.database.foreign_key_violations, 1);
  assert.equal(payload.database.foreign_key_violation_samples[0].table, 'runs');
});

test('database open failures fail closed with a structured DB_INIT_FAILED error', t => {
  const dir = tempRoot(t, 'scheduler-db-fail-');
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'file');
  const result = runNode(cliPath, ['status', '--json'], {
    env: { SCHEDULER_DB: join(blocker, 'scheduler.db') },
  });
  assert.notEqual(result.status, 0);
  const payload = parseStdout(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'DB_INIT_FAILED');
  assert.equal(payload.details.phase, 'database open');
});

test('schedule conversion preserves cron and at schedules and rejects unsafe intervals', () => {
  const cron = cronFromSchedule({ kind: 'cron', expr: ' 7 3 * * 1 ', tz: 'America/New_York' });
  assert.equal(cron.fields.schedule_cron, ' 7 3 * * 1 ');
  assert.equal(cron.fields.schedule_tz, 'America/New_York');

  const at = cronFromSchedule({ kind: 'at', at: '2028-01-02T03:04:05-05:00' });
  assert.equal(at.fields.schedule_kind, 'at');
  assert.equal(at.fields.schedule_at, '2028-01-02 08:04:05');
  assert.equal(at.fields.delete_after_run, 1);

  const retainedAt = convertOpenClawJob({
    id: 'retained-at',
    name: 'Retained one shot',
    schedule: { kind: 'at', at: '2028-01-02T03:04:05Z' },
    deleteAfterRun: false,
    sessionTarget: 'main',
    payload: { kind: 'systemEvent', text: 'Retain this completed reminder.' },
    delivery: { mode: 'none' },
  });
  assert.equal(retainedAt.spec.delete_after_run, 0);

  const exact = cronFromSchedule({ kind: 'every', everyMs: 15 * 60_000 });
  assert.equal(exact.exact, true);
  assert.equal(exact.fields.schedule_cron, '0,15,30,45 * * * *');

  assert.throws(
    () => cronFromSchedule({ kind: 'every', everyMs: 45 * 60_000 }),
    err => err.code === 'INEXACT_EVERY',
  );
  const approximated = cronFromSchedule(
    { kind: 'every', everyMs: 45 * 60_000 },
    { allowInexactEvery: true },
  );
  assert.equal(approximated.exact, false);
  assert.equal(approximated.warnings.length, 1);
});

test('OpenClaw job conversion preserves command, delivery, origin, and migrated environment policy', () => {
  const converted = convertOpenClawJob({
    id: 'command-job',
    name: 'Command job',
    enabled: true,
    schedule: { kind: 'cron', expr: '*/10 * * * *', tz: 'UTC' },
    payload: {
      kind: 'command',
      argv: ['node', 'scripts/report.mjs'],
      cwd: '/srv/reporting',
      env: { NODE_ENV: 'production' },
      timeoutSeconds: 30,
    },
    delivery: { mode: 'announce', channel: 'telegram', to: '123456789' },
  });
  assert.equal(converted.spec.session_target, 'shell');
  assert.equal(converted.spec.payload_kind, 'shellCommand');
  assert.match(converted.spec.payload_message, /cd '\/srv\/reporting' && env NODE_ENV='production'/);
  assert.equal(converted.spec.delivery_to, '123456789');
  assert.equal(converted.spec.origin, 'openclaw-cron:command-job');
  assert.equal(converted.spec.shell_env_policy, 'inherit');
  assert.equal(converted.spec.run_timeout_ms, 30_000);
});

test('migration argument and OpenClaw list parsers accept supported shapes', () => {
  const options = parseMigrationArgs(['--dry-run', '--json', '--allow-inexact-every', '--openclaw-bin', '/opt/openclaw']);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
  assert.equal(options.allowInexactEvery, true);
  assert.equal(options.openclawBin, '/opt/openclaw');
  assert.deepEqual(extractListedJobIds({ jobs: [{ id: 'a' }, { jobId: 'b' }, { id: 'a' }] }), ['a', 'b']);
});

test('default migration reads current jobs through openclaw cron list/get JSON', t => {
  const dir = tempRoot(t, 'scheduler-openclaw-cli-');
  const fake = join(dir, 'openclaw-fixture.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'cron' && args[1] === 'list' && args[2] === '--json') {
  process.stdout.write(JSON.stringify({ jobs: [{ id: 'fixture-job' }] }));
} else if (args[0] === 'cron' && args[1] === 'get' && args[2] === 'fixture-job' && args[3] === '--json') {
  process.stdout.write(JSON.stringify({
    id: 'fixture-job',
    name: 'Fixture job',
    enabled: true,
    schedule: { kind: 'cron', expr: '5 4 * * *', tz: 'UTC' },
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message: 'Summarize queued work.', timeoutSeconds: 10 },
    delivery: { mode: 'none' }
  }));
} else {
  process.stderr.write('unexpected args: ' + JSON.stringify(args));
  process.exitCode = 2;
}
`);
  chmodSync(fake, 0o755);
  const dbPath = join(dir, 'scheduler.db');
  const result = runNode(migratePath, ['--openclaw-bin', fake, '--json'], {
    env: { SCHEDULER_DB: dbPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = parseStdout(result);
  assert.equal(report.ok, true);
  assert.equal(report.source.kind, 'openclaw-cli');
  assert.equal(report.summary.imported, 1);

  const get = runNode(cliPath, ['jobs', 'get', 'fixture-job', '--json'], {
    env: { SCHEDULER_DB: dbPath },
  });
  assert.equal(get.status, 0, get.stderr);
  const job = parseStdout(get);
  assert.equal(job.schedule_cron, '5 4 * * *');
  assert.equal(job.delivery_mode, 'none');
  assert.equal(job.shell_env_policy, 'inherit');
});

test('legacy JSON import is explicit and preserves one-shot schedule semantics', t => {
  const dir = tempRoot(t, 'scheduler-legacy-json-');
  const source = join(dir, 'jobs.json');
  writeFileSync(source, JSON.stringify({
    jobs: [{
      id: 'legacy-at',
      name: 'Legacy one shot',
      enabled: true,
      schedule: { kind: 'at', at: '2029-03-04T05:06:07Z' },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'Run the one-shot reminder.' },
      delivery: { mode: 'none' },
    }],
  }));
  const dbPath = join(dir, 'scheduler.db');
  const result = runNode(migratePath, ['--legacy-json', source, '--json'], {
    env: { SCHEDULER_DB: dbPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseStdout(result).summary.imported, 1);

  const get = runNode(cliPath, ['jobs', 'get', 'legacy-at', '--json'], {
    env: { SCHEDULER_DB: dbPath },
  });
  assert.equal(get.status, 0, get.stderr);
  const job = parseStdout(get);
  assert.equal(job.schedule_kind, 'at');
  assert.equal(job.schedule_at, '2029-03-04 05:06:07');
  assert.equal(job.delete_after_run, 1);
});

test('migration reports inexact intervals and exits nonzero until approximation is explicit', t => {
  const dir = tempRoot(t, 'scheduler-inexact-every-');
  const source = join(dir, 'jobs.json');
  writeFileSync(source, JSON.stringify({
    jobs: [{
      id: 'legacy-every',
      name: 'Legacy 45 minute interval',
      enabled: true,
      schedule: { kind: 'every', everyMs: 45 * 60_000 },
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'Run the interval reminder.' },
      delivery: { mode: 'none' },
    }],
  }));

  const rejectedDb = join(dir, 'rejected.db');
  const rejected = runNode(migratePath, ['--legacy-json', source, '--dry-run', '--json'], {
    env: { SCHEDULER_DB: rejectedDb },
  });
  assert.notEqual(rejected.status, 0);
  const rejectedReport = parseStdout(rejected);
  assert.equal(rejectedReport.ok, false);
  assert.equal(rejectedReport.summary.failed, 1);
  assert.equal(rejectedReport.results[0].code, 'INEXACT_EVERY');
  assert.equal(existsSync(rejectedDb), false, 'dry-run must not create or migrate the target database');

  const allowedDb = join(dir, 'allowed.db');
  const allowed = runNode(
    migratePath,
    ['--legacy-json', source, '--allow-inexact-every', '--dry-run', '--json'],
    { env: { SCHEDULER_DB: allowedDb } },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  const allowedReport = parseStdout(allowed);
  assert.equal(allowedReport.ok, true);
  assert.equal(allowedReport.summary.would_import, 1);
  assert.equal(allowedReport.summary.warnings, 1);
  assert.equal(existsSync(allowedDb), false, 'dry-run must not create or migrate the target database');
});
