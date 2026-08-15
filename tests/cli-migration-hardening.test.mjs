import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const handoffV4JobFixturePath = join(
  root,
  'tests',
  'fixtures',
  'handoff-v4-approval-proof-job.json',
);

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
  assert.equal(parseStdout(version).version, packageVersion);

  const launcherVersion = runNode(binPath, ['--json', 'version'], { env });
  assert.equal(launcherVersion.status, 0, launcherVersion.stderr);
  assert.equal(parseStdout(launcherVersion).version, packageVersion);

  const schema = runNode(cliPath, ['schema', 'jobs', '--json'], { env });
  assert.equal(schema.status, 0, schema.stderr);
  assert.deepEqual(parseStdout(schema).fields.execution_intent.enum, ['execute', 'plan', 'fire-and-forget']);

  const capabilities = runNode(cliPath, ['capabilities', '--json'], { env });
  assert.equal(capabilities.status, 0, capabilities.stderr);
  assert.equal(parseStdout(capabilities).schema_version, 30);

  const launcherCapabilities = runNode(binPath, ['--json', 'capabilities'], { env });
  assert.equal(launcherCapabilities.status, 0, launcherCapabilities.stderr);
  assert.equal(parseStdout(launcherCapabilities).schema_version, 30);

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

test('jobs list hydrates persisted v4 artifacts only when explicitly requested', t => {
  const dir = tempRoot(t, 'scheduler-list-handoff-v4-');
  const env = { SCHEDULER_DB: join(dir, 'scheduler.db') };
  const fixture = JSON.parse(readFileSync(handoffV4JobFixturePath, 'utf8'));

  const addedV4 = runNode(
    cliPath,
    ['jobs', 'add', '--file', handoffV4JobFixturePath, '--json'],
    { env },
  );
  assert.equal(addedV4.status, 0, addedV4.stderr);

  const addedLegacy = runNode(
    cliPath,
    ['jobs', 'add', JSON.stringify(validShellJob({ name: 'Legacy list probe' })), '--json'],
    { env },
  );
  assert.equal(addedLegacy.status, 0, addedLegacy.stderr);
  const legacyJobId = parseStdout(addedLegacy).job.id;

  const compact = runNode(cliPath, ['jobs', 'list', '--json'], { env });
  assert.equal(compact.status, 0, compact.stderr);
  const compactV4 = parseStdout(compact).find(job => job.id === fixture.id);
  assert.ok(compactV4);
  assert.equal(compactV4.handoff_artifact_digest, fixture.handoff_artifact_digest);
  assert.equal(Object.hasOwn(compactV4, 'handoff_artifact_payload'), false);

  const hydrated = runNode(
    cliPath,
    ['jobs', 'list', '--include-handoff-artifacts', '--json'],
    { env },
  );
  assert.equal(hydrated.status, 0, hydrated.stderr);
  const hydratedJobs = parseStdout(hydrated);
  const hydratedV4 = hydratedJobs.find(job => job.id === fixture.id);
  const hydratedLegacy = hydratedJobs.find(job => job.id === legacyJobId);
  assert.deepEqual(hydratedV4.handoff_artifact_payload, fixture.handoff_artifact_payload);
  assert.equal(Object.hasOwn(hydratedLegacy, 'handoff_artifact_payload'), false);

  const disabled = runNode(cliPath, ['jobs', 'disable', fixture.id, '--json'], { env });
  assert.equal(disabled.status, 0, disabled.stderr);
  const hydratedDisabled = runNode(
    cliPath,
    ['jobs', 'list', '--include-handoff-artifacts', '--json'],
    { env },
  );
  assert.equal(hydratedDisabled.status, 0, hydratedDisabled.stderr);
  const disabledV4 = parseStdout(hydratedDisabled).find(job => job.id === fixture.id);
  assert.equal(disabledV4.enabled, 0);
  assert.deepEqual(disabledV4.handoff_artifact_payload, fixture.handoff_artifact_payload);
});

test('hydrated v4 job reads fail closed for invalid or missing persisted artifacts', t => {
  const dir = tempRoot(t, 'scheduler-list-invalid-handoff-v4-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const fixture = JSON.parse(readFileSync(handoffV4JobFixturePath, 'utf8'));

  const added = runNode(
    cliPath,
    ['jobs', 'add', '--file', handoffV4JobFixturePath, '--json'],
    { env },
  );
  assert.equal(added.status, 0, added.stderr);

  const db = new Database(dbPath);
  try {
    db.exec('DROP TRIGGER trg_handoff_artifacts_no_update');
    db.prepare('UPDATE handoff_artifacts SET payload = ? WHERE digest = ?')
      .run('{broken', fixture.handoff_artifact_digest);
  } finally {
    db.close();
  }

  const invalid = runNode(
    cliPath,
    ['jobs', 'list', '--include-handoff-artifacts', '--json'],
    { env },
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(parseStdout(invalid).code, 'HANDOFF_ARTIFACT_INVALID');

  const missingDb = new Database(dbPath);
  try {
    missingDb.exec('DROP TRIGGER trg_handoff_artifacts_no_delete');
    missingDb.prepare('DELETE FROM handoff_artifacts WHERE digest = ?')
      .run(fixture.handoff_artifact_digest);
  } finally {
    missingDb.close();
  }

  const missing = runNode(
    cliPath,
    ['jobs', 'list', '--include-handoff-artifacts', '--json'],
    { env },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(parseStdout(missing).code, 'HANDOFF_ARTIFACT_REQUIRED');
});

test('hydrated v4 job reads validate the artifact against the persisted job row', t => {
  const dir = tempRoot(t, 'scheduler-list-mismatched-handoff-v4-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const fixture = JSON.parse(readFileSync(handoffV4JobFixturePath, 'utf8'));
  const added = runNode(
    cliPath,
    ['jobs', 'add', '--file', handoffV4JobFixturePath, '--json'],
    { env },
  );
  assert.equal(added.status, 0, added.stderr);

  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE jobs SET effective_task_hash = ? WHERE id = ?')
      .run(`sha256:${'f'.repeat(64)}`, fixture.id);
  } finally {
    db.close();
  }

  const mismatched = runNode(
    cliPath,
    ['jobs', 'list', '--include-handoff-artifacts', '--json'],
    { env },
  );
  assert.notEqual(mismatched.status, 0);
  assert.equal(parseStdout(mismatched).code, 'HANDOFF_ARTIFACT_INVALID');
  assert.match(parseStdout(mismatched).error, /effective task hash|execution binding/);
});

test('doctor reports schema v30 and lease, queue, outbox, and approval diagnostics', t => {
  const dir = tempRoot(t, 'scheduler-doctor-');
  const result = runNode(cliPath, ['doctor', '--json'], {
    env: { SCHEDULER_DB: join(dir, 'scheduler.db') },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = parseStdout(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.database.schema_version, 30);
  assert.equal(payload.database.latest_schema_version, 30);
  assert.ok('dispatcher_lease' in payload.diagnostics);
  assert.ok('dispatch_queue' in payload.diagnostics);
  assert.ok('delivery_outbox' in payload.diagnostics);
  assert.ok('approvals' in payload.diagnostics);
  assert.equal(payload.diagnostics.evidence_records.verification_mode, 'cryptographic');
  assert.equal(payload.diagnostics.evidence_records.checked, 0);
  assert.equal(payload.diagnostics.evidence_records.verification_complete, true);
  assert.deepEqual(payload.database.integrity_check, ['ok']);
  assert.equal(payload.database.foreign_key_violations, 0);
});

test('doctor bounds evidence verification by default and supports an explicit deep pass', t => {
  const dir = tempRoot(t, 'scheduler-doctor-evidence-sampling-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    const samplePlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT run_id FROM evidence_records
      ORDER BY created_at DESC, run_id DESC LIMIT 500
    `).all();
    assert(
      samplePlan.some(row => /idx_evidence_records_created_run/.test(row.detail)),
      `doctor evidence sample is not index-backed: ${JSON.stringify(samplePlan)}`,
    );
    const insert = db.prepare(`
      INSERT INTO evidence_records (id, run_id, job_id, algorithm, hash, payload)
      VALUES (?, ?, 'sampling-job', 'sha256', 'sha256:invalid', 'null')
    `);
    db.transaction(() => {
      for (let index = 0; index < 501; index++) {
        insert.run(`sampling-evidence-${index}`, `sampling-run-${index}`);
      }
    })();
  } finally {
    db.close();
  }

  const sampled = runNode(cliPath, ['doctor', '--json'], { env });
  assert.notEqual(sampled.status, 0);
  const sampledPayload = parseStdout(sampled);
  assert.equal(sampledPayload.diagnostics.evidence_records.total, 501);
  assert.equal(sampledPayload.diagnostics.evidence_records.checked, 500);
  assert.equal(sampledPayload.diagnostics.evidence_records.unchecked, 1);
  assert.equal(sampledPayload.diagnostics.evidence_records.verification_complete, false);
  assert(sampledPayload.warnings.some(warning => /doctor --deep/.test(warning)));

  const deep = runNode(cliPath, ['doctor', '--deep', '--json'], { env });
  assert.notEqual(deep.status, 0);
  const deepPayload = parseStdout(deep);
  assert.equal(deepPayload.diagnostics.evidence_records.checked, 501);
  assert.equal(deepPayload.diagnostics.evidence_records.unchecked, 0);
  assert.equal(deepPayload.diagnostics.evidence_records.verification_complete, true);
});

test('current databases remain readable while another process holds the write lock', t => {
  const dir = tempRoot(t, 'scheduler-current-read-lock-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);

  const writer = new Database(dbPath);
  try {
    writer.pragma('journal_mode = WAL');
    writer.exec('BEGIN IMMEDIATE');
    const status = runNode(cliPath, ['status', '--json'], { env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = parseStdout(status);
    assert.equal(statusPayload.db_init_ok, true);
    assert.equal(statusPayload.diagnostics.evidence_records.verification_mode, 'checksum');
  } finally {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close();
  }
});

test('schema v30 consolidation repairs missing required indexes before taking the no-op path', t => {
  const dir = tempRoot(t, 'scheduler-index-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const initialized = runNode(cliPath, ['doctor', '--json'], { env });
  assert.equal(initialized.status, 0, initialized.stderr);

  const db = new Database(dbPath);
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 30);
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
  assert.match(noOp.stdout, /DB already at v30/);
});

test('schema v29 consolidation backfills retained v4 evidence verification metadata', t => {
  const dir = tempRoot(t, 'scheduler-evidence-metadata-backfill-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  const allowedSignersPath = join(dir, 'allowed_signers');
  const privateKeyPath = join(dir, 'private-signing-key');
  writeFileSync(allowedSignersPath, 'migration-principal ssh-ed25519 AAAATEST\n');
  writeFileSync(privateKeyPath, 'PRIVATE-MATERIAL-MUST-NOT-BE-BACKFILLED\n');

  const evidenceDeclaration = {
    provider: 'ssh',
    methods: ['ssh-signature'],
    provider_config: {
      principal: 'migration-principal',
      allowed_signers_path: allowedSignersPath,
      key_path: privateKeyPath,
    },
  };
  const added = runNode(
    cliPath,
    ['jobs', 'add', JSON.stringify(validShellJob({
      name: 'Evidence metadata migration probe',
    })), '--json'],
    { env },
  );
  assert.equal(added.status, 0, added.stderr);
  const jobId = parseStdout(added).job.id;
  const runId = 'evidence-metadata-migration-run';
  const evidenceId = 'evidence-metadata-migration-record';
  const artifactDigest = `sha256:${'a'.repeat(64)}`;
  const db = new Database(dbPath);
  try {
    db.prepare(`
      INSERT INTO runs (
        id, job_id, status, finished_at, evidence_declaration_snapshot,
        handoff_artifact_digest
      ) VALUES (?, ?, 'ok', datetime('now'), ?, ?)
    `).run(runId, jobId, JSON.stringify(evidenceDeclaration), artifactDigest);
    db.prepare(`
      INSERT INTO evidence_records (
        id, run_id, job_id, algorithm, hash, payload,
        handoff_artifact_digest, evidence_verified, evidence_envelope
      ) VALUES (?, ?, ?, 'sha256', ?, '{}', ?, 1, ?)
    `).run(
      evidenceId,
      runId,
      jobId,
      `sha256:${'b'.repeat(64)}`,
      artifactDigest,
      JSON.stringify({ method: 'ssh-signature', principal: 'envelope-principal' }),
    );
  } finally {
    db.close();
  }

  const migrated = runNode(consolidatePath, [], { env });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /Consolidation migration applied/);

  const upgraded = new Database(dbPath, { readonly: true });
  try {
    const row = upgraded.prepare('SELECT * FROM evidence_records WHERE id = ?').get(evidenceId);
    assert.equal(row.evidence_method, 'ssh-signature');
    assert.equal(row.evidence_provider, 'ssh');
    assert.equal(row.evidence_principal, 'migration-principal');
    assert.equal(row.evidence_allowed_signers_path, allowedSignersPath);
    assert.equal(JSON.stringify(row).includes(privateKeyPath), false);
    assert.equal(JSON.stringify(row).includes('PRIVATE-MATERIAL'), false);
  } finally {
    upgraded.close();
  }

  const repeated = runNode(consolidatePath, [], { env });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /nothing to do/);
});

test('schema v28 consolidation repairs malformed correctness-critical unique indexes', t => {
  const dir = tempRoot(t, 'scheduler-index-definition-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP INDEX idx_delivery_outbox_group_part;
      CREATE INDEX idx_delivery_outbox_group_part
      ON delivery_outbox(delivery_group_id);
    `);
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);
  const repairedDb = new Database(dbPath);
  try {
    const listed = repairedDb.prepare('PRAGMA index_list(delivery_outbox)').all()
      .find(index => index.name === 'idx_delivery_outbox_group_part');
    assert.equal(listed.unique, 1);
    assert.deepEqual(
      repairedDb.prepare('PRAGMA index_info(idx_delivery_outbox_group_part)').all()
        .sort((left, right) => left.seqno - right.seqno)
        .map(column => column.name),
      ['delivery_group_id', 'part_index'],
    );
    repairedDb.prepare(`
      INSERT INTO delivery_outbox (
        id, channel, target, body, delivery_group_id, part_index
      ) VALUES (?, 'test', 'target', 'body', 'group-one', 1)
    `).run('unique-part-one');
    assert.throws(
      () => repairedDb.prepare(`
        INSERT INTO delivery_outbox (
          id, channel, target, body, delivery_group_id, part_index
        ) VALUES (?, 'test', 'target', 'body', 'group-one', 1)
      `).run('unique-part-two'),
      /UNIQUE constraint failed/,
    );
  } finally {
    repairedDb.close();
  }
});

test('older runtime refuses a database with a newer schema version', t => {
  const dir = tempRoot(t, 'scheduler-newer-schema-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (31)').run();
  } finally {
    db.close();
  }

  const rejected = runNode(cliPath, ['status', '--json'], { env });
  assert.notEqual(rejected.status, 0);
  const payload = parseStdout(rejected);
  assert.equal(payload.code, 'DB_INIT_FAILED');
  assert.equal(payload.details.phase, 'consolidation migration');
  assert.match(payload.error, /newer than supported version 30/);
  const untouched = new Database(dbPath, { readonly: true });
  try {
    assert.equal(untouched.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 31);
  } finally {
    untouched.close();
  }
});

test('schema consolidation repairs complete baseline objects before its no-op path', t => {
  const dir = tempRoot(t, 'scheduler-schema-apply-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.exec('DROP TABLE delivery_aliases');
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);
  const repairedDb = new Database(dbPath, { readonly: true });
  try {
    assert.equal(
      repairedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'delivery_aliases'").get().count,
      1,
    );
  } finally {
    repairedDb.close();
  }
  const noOp = runNode(consolidatePath, [], { env });
  assert.equal(noOp.status, 0, noOp.stderr);
  assert.match(noOp.stdout, /DB already at v30/);
});

test('schema consolidation normalizes legacy output-triggered delivery and rejects unknown modes', t => {
  const dir = tempRoot(t, 'scheduler-delivery-mode-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.prepare(`
      INSERT INTO jobs (
        id, name, schedule_cron, session_target, payload_kind,
        payload_message, run_timeout_ms, delivery_mode, delivery_channel,
        delivery_to, origin
      ) VALUES (
        'legacy-output-delivery', 'Legacy output delivery', '0 * * * *',
        'shell', 'shellCommand', 'printf ready', 5000,
        'announce-on-output', 'telegram', 'test-target', 'system'
      )
    `).run();
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);
  const repairedDb = new Database(dbPath);
  try {
    assert.equal(
      repairedDb.prepare("SELECT delivery_mode FROM jobs WHERE id = 'legacy-output-delivery'").get().delivery_mode,
      'announce-always',
    );
    repairedDb.prepare(`
      UPDATE jobs SET delivery_mode = 'operator-unknown'
      WHERE id = 'legacy-output-delivery'
    `).run();
  } finally {
    repairedDb.close();
  }

  const rejected = runNode(consolidatePath, [], { env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unsupported persisted delivery mode\(s\): operator-unknown/);
  const unchanged = new Database(dbPath, { readonly: true });
  try {
    assert.equal(
      unchanged.prepare("SELECT delivery_mode FROM jobs WHERE id = 'legacy-output-delivery'").get().delivery_mode,
      'operator-unknown',
    );
  } finally {
    unchanged.close();
  }
});

test('schema v29 consolidation strengthens queue binding nullability without losing references', t => {
  const dir = tempRoot(t, 'scheduler-queue-binding-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.prepare(`
      INSERT INTO jobs (
        id, name, schedule_cron, session_target, payload_kind,
        payload_message, run_timeout_ms, delivery_mode, origin
      ) VALUES ('queue-repair-job', 'Queue repair', '0 * * * *', 'shell',
        'shellCommand', 'true', 5000, 'none', 'system')
    `).run();
    db.prepare(`
      INSERT INTO job_dispatch_queue (
        id, job_id, dispatch_kind, status, scheduled_for, binding_scheduled_for
      ) VALUES ('queue-repair-dispatch', 'queue-repair-job', 'manual', 'awaiting_approval',
        '2026-07-13 04:00:00', '2026-07-13 04:00:00')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, job_id, status, dispatch_queue_id)
      VALUES ('queue-repair-run', 'queue-repair-job', 'awaiting_approval', 'queue-repair-dispatch')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, job_id, status, finished_at)
      VALUES ('queue-repair-source-run', 'queue-repair-job', 'ok', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO approvals (
        id, job_id, run_id, dispatch_queue_id, status, binding_hash
      ) VALUES ('queue-repair-approval', 'queue-repair-job', 'queue-repair-run',
        'queue-repair-dispatch', 'pending', 'sha256:test')
    `).run();

    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE job_dispatch_queue_nullable (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        dispatch_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        scheduled_for TEXT NOT NULL,
        binding_scheduled_for TEXT,
        source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        processed_at TEXT,
        claim_owner TEXT,
        claim_token TEXT,
        claim_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        replay_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        handoff_artifact_digest TEXT,
        source_run_handoff_artifact_digest TEXT
      );
      INSERT INTO job_dispatch_queue_nullable SELECT * FROM job_dispatch_queue;
      UPDATE job_dispatch_queue_nullable SET binding_scheduled_for = NULL;
      UPDATE job_dispatch_queue_nullable
      SET source_run_id = 'queue-repair-source-run'
      WHERE id = 'queue-repair-dispatch';
      DROP TABLE job_dispatch_queue;
      ALTER TABLE job_dispatch_queue_nullable RENAME TO job_dispatch_queue;
    `);
    db.pragma('foreign_keys = ON');
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Consolidation migration applied/);
  const repairedDb = new Database(dbPath);
  try {
    const bindingColumn = repairedDb.prepare('PRAGMA table_info(job_dispatch_queue)').all()
      .find(column => column.name === 'binding_scheduled_for');
    assert.equal(bindingColumn.notnull, 1);
    assert.equal(
      repairedDb.prepare("SELECT binding_scheduled_for FROM job_dispatch_queue WHERE id = 'queue-repair-dispatch'").get().binding_scheduled_for,
      '2026-07-13 04:00:00',
    );
    assert.equal(
      repairedDb.prepare("SELECT dispatch_queue_id FROM runs WHERE id = 'queue-repair-run'").get().dispatch_queue_id,
      'queue-repair-dispatch',
    );
    assert.equal(
      repairedDb.prepare("SELECT dispatch_queue_id FROM approvals WHERE id = 'queue-repair-approval'").get().dispatch_queue_id,
      'queue-repair-dispatch',
    );
    assert.equal(
      repairedDb.pragma('foreign_key_list(job_dispatch_queue)')
        .some(foreignKey => foreignKey.from === 'source_run_id'),
      false,
    );
    repairedDb.prepare("DELETE FROM runs WHERE id = 'queue-repair-source-run'").run();
    assert.equal(
      repairedDb.prepare(
        "SELECT source_run_id FROM job_dispatch_queue WHERE id = 'queue-repair-dispatch'",
      ).get().source_run_id,
      'queue-repair-source-run',
    );
    assert.deepEqual(repairedDb.pragma('foreign_key_check'), []);
  } finally {
    repairedDb.close();
  }
});

test('schema v27 predecessor upgrades every handoff v3 field and index', t => {
  const dir = tempRoot(t, 'scheduler-schema-v27-upgrade-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP INDEX idx_delivery_outbox_group_part;
      DROP INDEX idx_delivery_outbox_group_status;
      DROP INDEX idx_delivery_outbox_completion;
      DROP INDEX idx_evidence_records_created_run;
      DROP INDEX idx_evidence_records_job;
      DROP INDEX idx_evidence_records_hash;
      DROP TABLE evidence_records;
      DROP INDEX idx_completion_debts_task;
      DROP INDEX idx_completion_debts_scope;
      DROP TABLE completion_debts;
      CREATE TABLE completion_debts (
        task_label TEXT PRIMARY KEY,
        session_key TEXT,
        source TEXT NOT NULL DEFAULT 'dispatch',
        status TEXT NOT NULL DEFAULT 'tracking',
        open_reason TEXT,
        close_reason TEXT,
        opened_at TEXT,
        closed_at TEXT,
        last_checkin_at TEXT,
        last_progress_at TEXT,
        last_visible_update_at TEXT,
        final_reported_at TEXT,
        last_reminder_at TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        awaiting_user INTEGER NOT NULL DEFAULT 0,
        no_reply INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_completion_debts_status ON completion_debts(status, updated_at);
      CREATE INDEX idx_completion_debts_session ON completion_debts(session_key) WHERE session_key IS NOT NULL;
      ALTER TABLE jobs DROP COLUMN approval_risk_level;
      ALTER TABLE jobs DROP COLUMN approval_approver_scope;
      ALTER TABLE jobs DROP COLUMN output_format;
      ALTER TABLE jobs DROP COLUMN verify_shell;
      ALTER TABLE jobs DROP COLUMN verify_timeout_s;
      ALTER TABLE jobs DROP COLUMN verify_on_failure;
      ALTER TABLE runs DROP COLUMN evidence_required;
      ALTER TABLE runs DROP COLUMN evidence_execution_snapshot;
      ALTER TABLE runs DROP COLUMN evidence_declaration_snapshot;
      ALTER TABLE runs DROP COLUMN evidence_ref_snapshot;
      ALTER TABLE runs DROP COLUMN delegation_validation;
      ALTER TABLE runs DROP COLUMN approval_used;
      ALTER TABLE runs DROP COLUMN output_format;
      ALTER TABLE runs DROP COLUMN structured_output;
      ALTER TABLE runs DROP COLUMN structured_output_valid;
      ALTER TABLE runs DROP COLUMN structured_output_warning;
      ALTER TABLE runs DROP COLUMN structured_output_bytes;
      ALTER TABLE runs DROP COLUMN structured_output_sha256;
      ALTER TABLE runs DROP COLUMN structured_output_path;
      ALTER TABLE runs DROP COLUMN verification_result;
      ALTER TABLE approvals DROP COLUMN risk_level;
      ALTER TABLE approvals DROP COLUMN approver_scope;
      ALTER TABLE approvals DROP COLUMN binding_hash;
      ALTER TABLE approvals DROP COLUMN gate_kind;
      ALTER TABLE approvals DROP COLUMN decision_context;
      ALTER TABLE job_dispatch_queue DROP COLUMN binding_scheduled_for;
      ALTER TABLE delivery_outbox DROP COLUMN delivery_group_id;
      ALTER TABLE delivery_outbox DROP COLUMN part_index;
      ALTER TABLE delivery_outbox DROP COLUMN part_count;
      ALTER TABLE delivery_outbox DROP COLUMN completion_label;
      ALTER TABLE delivery_outbox DROP COLUMN completion_scope;
      DELETE FROM schema_migrations WHERE version >= 28;
    `);
  } finally {
    db.close();
  }

  const upgraded = runNode(cliPath, ['doctor', '--deep', '--json'], { env });
  assert.equal(upgraded.status, 0, `${upgraded.stderr}\n${upgraded.stdout}`);
  assert.equal(parseStdout(upgraded).database.schema_version, 30);
  const upgradedDb = new Database(dbPath, { readonly: true });
  try {
    const expectedColumns = {
      jobs: [
        'approval_risk_level', 'approval_approver_scope', 'output_format',
        'verify_shell', 'verify_timeout_s', 'verify_on_failure',
        'source_channel', 'source_target', 'source_message_id', 'source_thread_id',
      ],
      runs: [
        'evidence_required', 'evidence_execution_snapshot',
        'evidence_declaration_snapshot', 'evidence_ref_snapshot',
        'delegation_validation', 'approval_used', 'output_format',
        'structured_output', 'structured_output_valid',
        'structured_output_warning', 'structured_output_bytes',
        'structured_output_sha256', 'structured_output_path',
        'verification_result',
      ],
      approvals: [
        'risk_level', 'approver_scope', 'binding_hash', 'gate_kind',
        'decision_context',
      ],
      job_dispatch_queue: ['binding_scheduled_for'],
      delivery_outbox: [
        'delivery_group_id', 'part_index', 'part_count',
        'completion_label', 'completion_scope',
      ],
      evidence_records: [
        'evidence_provider', 'evidence_principal',
        'evidence_allowed_signers_path',
      ],
    };
    for (const [table, columns] of Object.entries(expectedColumns)) {
      const actual = new Map(
        upgradedDb.prepare(`PRAGMA table_info(${table})`).all()
          .map(column => [column.name, column]),
      );
      for (const column of columns) assert(actual.has(column), `${table}.${column} was not upgraded`);
    }
    const queueBinding = upgradedDb.prepare('PRAGMA table_info(job_dispatch_queue)').all()
      .find(column => column.name === 'binding_scheduled_for');
    assert.equal(queueBinding.notnull, 1);
    for (const objectName of [
      'evidence_records', 'idx_evidence_records_created_run',
      'idx_delivery_outbox_group_part', 'idx_delivery_outbox_group_status',
      'idx_delivery_outbox_completion', 'idx_completion_debts_task',
      'idx_completion_debts_scope',
    ]) {
      assert.equal(
        upgradedDb.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get(objectName).count,
        1,
        `${objectName} was not upgraded`,
      );
    }
  } finally {
    upgradedDb.close();
  }
});

test('schema v28 consolidation removes redundant completion-debt uniqueness', t => {
  const dir = tempRoot(t, 'scheduler-completion-unique-repair-');
  const dbPath = join(dir, 'scheduler.db');
  const env = { SCHEDULER_DB: dbPath };
  assert.equal(runNode(cliPath, ['doctor', '--json'], { env }).status, 0);
  const db = new Database(dbPath);
  try {
    db.exec(`
      DROP INDEX idx_completion_debts_scope;
      ALTER TABLE completion_debts RENAME TO completion_debts_source;
      CREATE TABLE completion_debts (
        id TEXT PRIMARY KEY,
        task_label TEXT NOT NULL,
        delivery_scope TEXT NOT NULL,
        session_key TEXT,
        source TEXT NOT NULL DEFAULT 'dispatch',
        status TEXT NOT NULL DEFAULT 'tracking',
        open_reason TEXT,
        close_reason TEXT,
        opened_at TEXT,
        closed_at TEXT,
        last_checkin_at TEXT,
        last_progress_at TEXT,
        last_visible_update_at TEXT,
        final_reported_at TEXT,
        last_reminder_at TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        awaiting_user INTEGER NOT NULL DEFAULT 0,
        no_reply INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_label, delivery_scope)
      );
      INSERT INTO completion_debts SELECT * FROM completion_debts_source;
      DROP TABLE completion_debts_source;
      CREATE UNIQUE INDEX idx_completion_debts_scope
      ON completion_debts(task_label, delivery_scope);
    `);
  } finally {
    db.close();
  }

  const repaired = runNode(consolidatePath, [], { env });
  assert.equal(repaired.status, 0, repaired.stderr);
  const repairedDb = new Database(dbPath, { readonly: true });
  try {
    const tableSql = repairedDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'completion_debts'",
    ).get().sql;
    assert.doesNotMatch(tableSql, /UNIQUE\s*\(\s*task_label\s*,\s*delivery_scope\s*\)/i);
    assert.equal(
      repairedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_completion_debts_scope'").get().count,
      1,
    );
  } finally {
    repairedDb.close();
  }
});

test('schema v29 consolidation recreates a completely missing approvals table', t => {
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
      'handoff_artifact_digest', 'source_run_id', 'source_run_handoff_artifact_digest',
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
