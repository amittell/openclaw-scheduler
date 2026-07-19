#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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
  ], { cwd: installRoot });
  const installedPackage = join(installRoot, 'node_modules', 'openclaw-scheduler');
  const version = JSON.parse(run(process.execPath, [
    join(installedPackage, 'bin', 'openclaw-scheduler.js'),
    'version',
    '--json',
  ], { cwd: installRoot }));
  const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  if (version.version !== expectedVersion) {
    throw new Error(`installed package version ${version.version} does not match ${expectedVersion}`);
  }
  const doctor = JSON.parse(run(process.execPath, [
    join(installedPackage, 'bin', 'openclaw-scheduler.js'),
    'doctor',
    '--json',
  ], {
    cwd: installRoot,
    env: {
      ...process.env,
      SCHEDULER_DB: join(fixture, 'installed-smoke.db'),
    },
  }));
  if (doctor.ok !== true || doctor.database?.schema_version !== 29) {
    throw new Error(`installed package doctor failed: ${JSON.stringify(doctor)}`);
  }

  const unexpectedArchives = readdirSync(packageRoot).filter(name => name.endsWith('.tgz'));
  if (unexpectedArchives.length > 0) {
    throw new Error(`packed artifact contains nested archives: ${unexpectedArchives.join(', ')}`);
  }
  process.stdout.write(`Verified packed openclaw-scheduler ${expectedVersion}.\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
