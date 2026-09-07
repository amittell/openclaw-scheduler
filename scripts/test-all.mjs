#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createTestEnvironment } from './test-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const focusedOnly = argv.has('--focused-only');
const agentcliOnly = argv.has('--agentcli-only');
const skipDocs = argv.has('--skip-docs');
const skipAgentcli = argv.has('--skip-agentcli') || process.env.SKIP_AGENTCLI_INTEGRATION === '1';
const skipAgentcliOwned = argv.has('--skip-agentcli-owned')
  || process.env.SKIP_AGENTCLI_OWNED_INTEGRATION === '1';
const requireAgentcli = agentcliOnly || argv.has('--require-agentcli') || process.env.REQUIRE_AGENTCLI_INTEGRATION === '1';
const agentcliContract = process.env.AGENTCLI_CONTRACT || null;
const agentcliFocusedTests = new Set([
  'handoff-v4-e2e.test.mjs',
  'handoff-v4-runtime.test.mjs',
]);
const installedAgentcliPackage = join(
  root,
  'node_modules',
  '@amittell',
  'agentcli',
  'package.json',
);
const failures = [];
let executed = 0;

if (agentcliOnly && skipAgentcli) {
  process.stderr.write('Cannot combine --agentcli-only with an agentcli integration skip option.\n');
  process.exit(2);
}

function runStep(name, command, args, { cwd = root, envOverrides = {}, dbPath } = {}) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-test-'));
  process.stdout.write(`\n==> ${name}\n`);
  let result;
  try {
    result = spawnSync(command, args, {
      cwd,
      env: { ...createTestEnvironment(isolatedHome, { dbPath }), ...envOverrides },
      stdio: 'inherit',
      windowsHide: true,
    });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
  executed++;
  if (result.error) {
    failures.push(`${name}: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    const suffix = result.signal ? ` (signal ${result.signal})` : '';
    failures.push(`${name}: exited ${result.status ?? 'without a status'}${suffix}`);
  }
}

if (!focusedOnly && !agentcliOnly) {
  runStep('legacy integration suite', process.execPath, ['test.js'], {
    dbPath: ':memory:',
  });
}

const allFocusedTests = readdirSync(join(root, 'tests'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
const canRunAgentcliFocusedTests = existsSync(installedAgentcliPackage);
const focusedTests = agentcliOnly
  ? (agentcliContract === 'handoff-v4' && canRunAgentcliFocusedTests
      ? allFocusedTests.filter(testFile => agentcliFocusedTests.has(testFile))
      : [])
  : allFocusedTests.filter(
      testFile => !agentcliFocusedTests.has(testFile) || canRunAgentcliFocusedTests,
    );

for (const testFile of focusedTests) {
  runStep(`focused ${testFile}`, process.execPath, ['--test', join('tests', testFile)]);
}

if (!skipDocs && !agentcliOnly) {
  runStep('documentation examples', process.execPath, [join('scripts', 'validate-doc-examples.mjs')]);
}

const agentcliRoot = resolve(root, '..', 'agentcli');
if (process.env.AGENTCLI_PATH && resolve(process.env.AGENTCLI_PATH) !== agentcliRoot) {
  throw new Error(`AGENTCLI_PATH must resolve to the sibling checkout ${agentcliRoot}`);
}
const agentcliPackage = join(agentcliRoot, 'package.json');
const agentcliBin = join(agentcliRoot, 'bin', 'agentcli.js');
const agentcliIntegration = join(agentcliRoot, 'test', 'integration-scheduler.test.js');
const missingAgentcliFiles = [agentcliPackage, agentcliBin, agentcliIntegration]
  .filter(file => !existsSync(file));

if (!skipAgentcli && missingAgentcliFiles.length === 0) {
  const integrationEnv = {
    AGENTCLI_PATH: agentcliRoot,
    REQUIRE_AGENTCLI_INTEGRATION: '1',
    SCHEDULER_PATH: root,
  };
  runStep('scheduler agentcli contract integration', process.execPath, ['test-integration-agentcli.js'], {
    envOverrides: integrationEnv,
  });
  if (skipAgentcliOwned) {
    process.stdout.write('\n==> agentcli-owned integration explicitly skipped by --skip-agentcli-owned or SKIP_AGENTCLI_OWNED_INTEGRATION=1\n');
  } else {
    runStep('agentcli scheduler integration', process.execPath, ['--test', agentcliIntegration], {
      cwd: agentcliRoot,
      envOverrides: integrationEnv,
    });
  }
} else if (!skipAgentcli && requireAgentcli) {
  executed++;
  const detail = `required agentcli checkout is incomplete at ${agentcliRoot}: missing ${missingAgentcliFiles.join(', ')}`;
  process.stderr.write(`\n==> agentcli integration failed: ${detail}\n`);
  failures.push(detail);
} else if (!skipAgentcli) {
  process.stdout.write(`\n==> agentcli integration explicitly unavailable: checkout incomplete at ${agentcliRoot}\n`);
  process.stdout.write('    Hosted CI and npm run test:agentcli require the pinned cross-repository integration.\n');
} else {
  process.stdout.write('\n==> agentcli integration explicitly skipped by --skip-agentcli or SKIP_AGENTCLI_INTEGRATION=1\n');
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} verification step(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nAll ${executed} verification step(s) passed.\n`);
}
