#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnvironment } from './test-environment.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-package-'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

try {
  const packOutput = run(npmCommand, [
    'pack',
    '--json',
    '--pack-destination', fixture,
  ]);
  const packResult = JSON.parse(packOutput);
  if (!Array.isArray(packResult) || !packResult[0]?.filename) {
    throw new Error('npm pack did not return an artifact filename');
  }
  const tarball = join(fixture, packResult[0].filename);
  run('tar', ['-xzf', tarball], { cwd: fixture });
  const packageRoot = join(fixture, 'package');
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (packedManifest.optionalDependencies?.['@amittell/agentcli'] !== '^0.5.0') {
    throw new Error('packed artifact must declare @amittell/agentcli ^0.5.0 as an optional dependency');
  }

  const requiredFiles = [
    'index.js',
    'index.d.ts',
    'bin/openclaw-scheduler.js',
    'scripts/validate-doc-examples.mjs',
    'scripts/verify-published-agentcli.mjs',
    'skills/durable-scheduler/SKILL.md',
    'tests/v04-evidence-lifecycle.test.mjs',
    'handoff-artifact.js',
    'evidence-runtime.js',
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(join(packageRoot, relativePath))) {
      throw new Error(`packed artifact is missing ${relativePath}`);
    }
  }

  run(process.execPath, ['scripts/validate-doc-examples.mjs'], { cwd: packageRoot });

  writeFileSync(join(fixture, 'consumer.ts'), `
import {
  runs,
  v02Runtime,
  type JobSpec,
  type SchedulerDatabase,
} from './package/index.js';

const spec: JobSpec = {
  name: 'strict consumer',
  payload_message: 'printf ok',
  payload_kind: 'shellCommand',
  session_target: 'shell',
  run_timeout_ms: 30_000,
};
const snapshot = v02Runtime.buildEvidenceExecutionSnapshot({ ...spec, id: 'strict-consumer' });
declare const database: SchedulerDatabase;
database.prepare('SELECT 1').all();
void runs;
void snapshot;
`, 'utf8');
  writeFileSync(join(fixture, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ['consumer.ts', 'package/index.d.ts'],
  }, null, 2)}\n`, 'utf8');
  run(process.execPath, [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', join(fixture, 'tsconfig.json'),
  ], { cwd: fixture });

  const installRoot = join(fixture, 'installed-consumer');
  const consumerHome = join(fixture, 'consumer-home');
  const consumerEnv = createTestEnvironment(consumerHome);
  // Exercise the installed guard against fixture records, with every runtime
  // path isolated from the operator's environment and installed daemon.
  delete consumerEnv.SCHEDULER_VERSION_GUARD_DEV;
  consumerEnv.npm_config_cache = join(fixture, 'npm-cache');
  mkdirSync(installRoot);
  writeFileSync(join(installRoot, 'package.json'), '{"name":"package-smoke","private":true}\n', 'utf8');
  run(npmCommand, [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--ignore-scripts=false',
    tarball,
  ], { cwd: installRoot, env: consumerEnv });
  const installedPackage = join(installRoot, 'node_modules', 'openclaw-scheduler');
  const version = JSON.parse(run(process.execPath, [
    join(installedPackage, 'bin', 'openclaw-scheduler.js'),
    'version',
    '--json',
  ], { cwd: installRoot, env: consumerEnv }));
  const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  if (version.version !== expectedVersion) {
    throw new Error(`installed package version ${version.version} does not match ${expectedVersion}`);
  }
  const daemonRecordPath = join(consumerHome, '.openclaw', 'scheduler', 'daemon-version.json');
  mkdirSync(dirname(daemonRecordPath), { recursive: true });
  const writeDaemonRecord = version => writeFileSync(daemonRecordPath, JSON.stringify({
    version,
    written_at: new Date().toISOString(),
    pid: process.pid,
    package_path: installedPackage,
  }));
  writeDaemonRecord(expectedVersion);
  const doctor = JSON.parse(run(process.execPath, [
    join(installedPackage, 'bin', 'openclaw-scheduler.js'),
    'doctor',
    '--json',
  ], {
    cwd: installRoot,
    env: consumerEnv,
  }));
  if (doctor.ok !== true || doctor.database?.schema_version !== 30) {
    throw new Error(`installed package doctor failed: ${JSON.stringify(doctor)}`);
  }
  assert.equal(doctor.version_guard?.status, 'match');
  assert.equal(doctor.version_guard.daemon_version, expectedVersion);
  assert.equal(doctor.version_guard.daemon_path, daemonRecordPath);

  writeDaemonRecord('0.0.0-package-mismatch');
  const mismatch = spawnSync(process.execPath, [
    join(installedPackage, 'bin', 'openclaw-scheduler.js'),
    'doctor',
    '--json',
  ], { cwd: installRoot, env: consumerEnv, encoding: 'utf8' });
  assert.ifError(mismatch.error);
  assert.equal(mismatch.status, 1, 'installed doctor must refuse a mismatching fixture daemon');
  assert.match(mismatch.stderr, /scheduler version mismatch/);
  const mismatchDoctor = JSON.parse(mismatch.stdout);
  assert.equal(mismatchDoctor.version_guard?.status, 'mismatch');
  assert.equal(mismatchDoctor.version_guard.daemon_version, '0.0.0-package-mismatch');
  assert.equal(mismatchDoctor.version_guard.daemon_path, daemonRecordPath);

  const unexpectedArchives = readdirSync(packageRoot).filter(name => name.endsWith('.tgz'));
  if (unexpectedArchives.length > 0) {
    throw new Error(`packed artifact contains nested archives: ${unexpectedArchives.join(', ')}`);
  }
  process.stdout.write(`Verified packed openclaw-scheduler ${expectedVersion}.\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
