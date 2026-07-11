#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const focusedOnly = argv.has('--focused-only');
const skipDocs = argv.has('--skip-docs');
const skipAgentcli = argv.has('--skip-agentcli') || process.env.SKIP_AGENTCLI_INTEGRATION === '1';
const failures = [];
let executed = 0;

function runStep(name, command, args, { cwd = root, env = process.env } = {}) {
  process.stdout.write(`\n==> ${name}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
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

if (!focusedOnly) {
  runStep('legacy integration suite', process.execPath, ['test.js'], {
    env: { ...process.env, SCHEDULER_DB: ':memory:' },
  });
}

const focusedTests = readdirSync(join(root, 'tests'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => entry.name)
  .sort((a, b) => a.localeCompare(b));

for (const testFile of focusedTests) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-test-'));
  try {
    runStep(`focused ${testFile}`, process.execPath, ['--test', join('tests', testFile)], {
      env: {
        ...process.env,
        SCHEDULER_DB: join(isolatedHome, 'scheduler.db'),
        OPENCLAW_SCHEDULER_HOME: isolatedHome,
      },
    });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

if (!skipDocs) {
  runStep('documentation examples', process.execPath, [join('scripts', 'validate-doc-examples.mjs')]);
}

const agentcliRoot = resolve(process.env.AGENTCLI_PATH || join(root, '..', 'agentcli'));
const agentcliIntegration = join(agentcliRoot, 'test', 'integration-scheduler.test.js');
if (!skipAgentcli && existsSync(join(agentcliRoot, 'package.json')) && existsSync(agentcliIntegration)) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-agentcli-'));
  try {
    runStep('agentcli scheduler integration', process.execPath, ['--test', agentcliIntegration], {
      cwd: agentcliRoot,
      env: {
        ...process.env,
        SCHEDULER_PATH: root,
        SCHEDULER_DB: join(isolatedHome, 'scheduler.db'),
        OPENCLAW_SCHEDULER_HOME: isolatedHome,
      },
    });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
} else if (!skipAgentcli) {
  process.stdout.write(`\n==> agentcli scheduler integration (skipped: sibling checkout not found at ${agentcliRoot})\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} verification step(s) failed:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nAll ${executed} verification step(s) passed.\n`);
}
