import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { createTestEnvironment } from '../scripts/test-environment.mjs';

const root = mkdtempSync(join(tmpdir(), 'scheduler-job-selection-'));
const originalEnv = { ...process.env };
const env = createTestEnvironment(join(root, 'home'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
const { validateJobSpec, createJob, updateJob, getJob } = await import('../jobs.js');
const { initDb, closeDb, setDbPath } = await import('../db.js');
setDbPath(join(root, 'api.db'));
after(() => {
  closeDb();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

const spec = overrides => ({
  name: 'Selection validation fixture', enabled: 0,
  schedule_cron: '0 * * * *', session_target: 'isolated', payload_kind: 'agentTurn',
  payload_message: 'Fixture only; never dispatched', run_timeout_ms: 1000,
  delivery_mode: 'none', delivery_opt_out_reason: 'owned validation fixture', origin: 'system',
  ...overrides,
});
const invalid = [
  ['profile without model', { auth_profile: 'work' }, /primary.*concrete provider\/model/],
  ['inherited profile without model', { auth_profile: 'inherit' }, /primary.*concrete provider\/model/],
  ['profile with bare model', { payload_model: 'model', auth_profile: 'work' }, /primary.*concrete provider\/model/],
  ['inline profile with bare model', { payload_model: 'model@work' }, /primary.*concrete provider\/model/],
  ...['openclaw', 'openclaw/default', 'openclaw:main', 'openclaw/main', 'agent:main'].flatMap(model => [
    [`explicit profile with ${model}`, { payload_model: model, auth_profile: 'work' }, /primary.*concrete provider\/model/],
    [`inherited profile with ${model}`, { payload_model: model, auth_profile: 'inherit' }, /primary.*concrete provider\/model/],
  ]),
  ['conflicting inline profile', { payload_model: 'vendor/model@work', auth_profile: 'other' }, /primary.*Conflicting/],
  ['invalid profile grammar', { payload_model: 'vendor/model', auth_profile: 'bad/profile' }, /primary.*Profile must/],
  ['wrong routing owner', { agent_id: 'ops', payload_model: 'agent:main' }, /primary.*owner/],
  ['fallback profile without model', { auth_profile_fallback: 'backup' }, /fallback.*concrete provider\/model/],
  ['fallback profile with bare primary', { payload_model: 'model', auth_profile_fallback: 'backup' }, /fallback.*concrete provider\/model/],
  ['fallback inherits explicit primary profile', { payload_model: 'vendor/model', auth_profile: 'work', payload_model_fallback: 'agent:main' }, /fallback.*concrete provider\/model/],
  ['fallback inherits inherited primary profile', { payload_model: 'vendor/model', auth_profile: 'inherit', payload_model_fallback: 'openclaw' }, /fallback.*concrete provider\/model/],
  ['fallback has inherited profile', { payload_model: 'vendor/model', payload_model_fallback: 'model', auth_profile_fallback: 'inherit' }, /fallback.*concrete provider\/model/],
  ['fallback inline profile with bare model', { payload_model_fallback: 'model@backup' }, /fallback.*concrete provider\/model/],
  ['fallback suffix conflicts with inherited field', { payload_model: 'vendor/model', auth_profile: 'work', payload_model_fallback: 'vendor/other@backup' }, /fallback.*Conflicting/],
];

test('job validation refuses incompatible primary and effective fallback selections', () => {
  for (const [name, overrides, pattern] of invalid) {
    assert.throws(() => validateJobSpec(spec(overrides)), pattern, name);
  }
});

test('job validation preserves supported models, profile inheritance and agent ownership', () => {
  const valid = [
    {}, { payload_model: 'model' }, { payload_model: 'vendor/model' },
    { payload_model: 'vendor/model', auth_profile: 'work' },
    { payload_model: 'vendor/model', auth_profile: 'inherit' },
    { payload_model: 'vendor/model@work' },
    { payload_model: 'vendor/model@work', auth_profile: 'work' },
    { payload_model: 'vendor/model@work', auth_profile: 'inherit' },
    { payload_model: 'vendor/model@20260101', auth_profile: 'inherit' },
    { payload_model: 'vendor/model@q4_k_m', auth_profile: 'work' },
    { payload_model: 'vendor/model@20260101@q4_k_m', auth_profile: 'work' },
    { agent_id: 'ops', payload_model: 'agent:ops' },
    { agent_id: 'ops', payload_model: 'openclaw/default' },
    { payload_model: 'openclaw:main', payload_model_fallback: 'agent:main' },
    { payload_model: 'vendor/model', auth_profile_fallback: 'backup' },
    { payload_model: 'vendor/model', auth_profile: 'inherit', auth_profile_fallback: 'backup' },
    { payload_model: 'vendor/model', auth_profile: 'work', payload_model_fallback: 'vendor/other' },
    { payload_model: 'vendor/model', payload_model_fallback: 'vendor/other', auth_profile_fallback: 'inherit' },
    { payload_model: 'vendor/model@work', payload_model_fallback: 'vendor/other@backup' },
    { payload_model: '   ', auth_profile: '   ', payload_model_fallback: '   ', auth_profile_fallback: '   ' },
    { session_target: 'main', payload_kind: 'systemEvent', agent_id: 'ops.tools' },
    { session_target: 'shell', payload_kind: 'shellCommand', agent_id: 'ops.tools' },
  ];
  for (const overrides of valid) {
    const input = spec(overrides);
    const before = structuredClone(input);
    assert.doesNotThrow(() => validateJobSpec(input), JSON.stringify(overrides));
    assert.deepEqual(input, before, 'validation must not replace inherited or suffix selections');
  }
});

test('merged selection updates are validated without preventing an unrelated legacy disable', () => {
  const current = spec({ payload_model: 'vendor/model', auth_profile: 'work', payload_model_fallback: 'vendor/other' });
  for (const patch of [{ payload_model: null }, { payload_model_fallback: 'openclaw' }, { auth_profile_fallback: 'bad/profile' }]) {
    assert.throws(() => validateJobSpec(patch, current, 'update'), /model\/profile selection is invalid/);
  }
  assert.doesNotThrow(() => validateJobSpec({ payload_model: 'vendor/changed' }, current, 'update'));
  assert.doesNotThrow(() => validateJobSpec({ auth_profile: 'inherit' }, current, 'update'));
  assert.doesNotThrow(() => validateJobSpec({ payload_model: null, payload_model_fallback: null, auth_profile: null }, current, 'update'));
  assert.doesNotThrow(() => validateJobSpec({ enabled: 0 }, spec({ auth_profile: 'work' }), 'update'));
  for (const enabled of [true, 1, '1']) {
    assert.throws(() => validateJobSpec({ enabled }, spec({ auth_profile: 'work' }), 'update'), /primary.*concrete provider\/model/);
  }
  assert.throws(() => validateJobSpec({ session_target: 'isolated', payload_kind: 'agentTurn' },
    spec({ session_target: 'shell', payload_kind: 'shellCommand', auth_profile: 'work' }), 'update'), /primary.*concrete provider\/model/);
});

test('create and update refuse incompatible selections before changing owned job rows', async () => {
  await initDb();
  const job = createJob(spec({ payload_model: 'vendor/model', auth_profile: 'work' }));
  const before = getJob(job.id);
  assert.throws(() => createJob(spec({ name: 'must not persist', auth_profile: 'inherit' })), /primary.*concrete provider\/model/);
  assert.throws(() => updateJob(job.id, { payload_model: 'agent:main' }), /primary.*concrete provider\/model/);
  assert.deepEqual(getJob(job.id), before);
  const db = new Database(join(root, 'api.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 1); }
  finally { db.close(); }
});

test('CLI validate, dry-run, add and update refuse incompatible selections before persistence', () => {
  const cliHome = join(root, 'cli-home');
  const cliEnv = createTestEnvironment(cliHome);
  const cli = resolve(import.meta.dirname, '..', 'cli.js');
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: root, env: cliEnv, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, payload: JSON.parse(result.stdout) };
  };
  const good = run(['jobs', 'add', '--stdin'], spec({ payload_model: 'vendor/model', auth_profile: 'inherit' }));
  assert.equal(good.status, 0);
  assert.equal(good.payload.job.auth_profile, 'inherit');
  const readRows = () => {
    const db = new Database(cliEnv.SCHEDULER_DB, { readonly: true });
    try { return db.prepare('SELECT * FROM jobs ORDER BY id').all(); }
    finally { db.close(); }
  };
  const before = readRows();
  for (const overrides of [
    { auth_profile: 'work' }, { payload_model: 'agent:main', auth_profile: 'inherit' },
    { payload_model: 'vendor/model', auth_profile: 'work', payload_model_fallback: 'model' },
  ]) {
    for (const args of [['jobs', 'validate', '--stdin'], ['jobs', 'add', '--stdin', '--dry-run'], ['jobs', 'add', '--stdin']]) {
      const result = run(args, spec(overrides));
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.payload.ok, false);
      assert.match(result.payload.error, /model\/profile selection is invalid/);
      assert.deepEqual(readRows(), before);
    }
  }
  const changed = run(['jobs', 'update', good.payload.job.id, '--stdin'], { payload_model: 'openclaw' });
  assert.notEqual(changed.status, 0);
  assert.match(changed.payload.error, /primary.*concrete provider\/model/);
  assert.deepEqual(readRows(), before);
  assert.equal(existsSync(join(cliHome, '.openclaw')), false, 'validation does not discover Gateway session state');
});

test('selection helper is packaged and can be imported without Gateway configuration', () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('agent-selection.js'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const selection = await import('./agent-selection.js'); selection.normalizeAgentSelection({ modelRef: 'vendor/model', authProfile: 'work' });"], {
    cwd: packageRoot, env: { ...env, OPENCLAW_GATEWAY_URL: 'invalid://not-a-gateway' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
});
