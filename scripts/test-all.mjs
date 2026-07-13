#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const focusedOnly = argv.has('--focused-only');
const agentcliOnly = argv.has('--agentcli-only');
const skipDocs = argv.has('--skip-docs');
const skipAgentcli = argv.has('--skip-agentcli') || process.env.SKIP_AGENTCLI_INTEGRATION === '1';
const skipAgentcliOwned = argv.has('--skip-agentcli-owned')
  || process.env.SKIP_AGENTCLI_OWNED_INTEGRATION === '1';
const requireAgentcli = agentcliOnly || argv.has('--require-agentcli') || process.env.REQUIRE_AGENTCLI_INTEGRATION === '1';
const failures = [];
let executed = 0;

if (agentcliOnly && skipAgentcli) {
  process.stderr.write('Cannot combine --agentcli-only with an agentcli integration skip option.\n');
  process.exit(2);
}

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

if (!focusedOnly && !agentcliOnly) {
  runStep('legacy integration suite', process.execPath, ['test.js'], {
    env: { ...process.env, SCHEDULER_DB: ':memory:' },
  });
}

const focusedTests = agentcliOnly
  ? []
  : readdirSync(join(root, 'tests'), { withFileTypes: true })
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

if (!skipDocs && !agentcliOnly) {
  runStep('documentation examples', process.execPath, [join('scripts', 'validate-doc-examples.mjs')]);
}

const agentcliRoot = resolve(process.env.AGENTCLI_PATH || join(root, '..', 'agentcli'));
const agentcliPackage = join(agentcliRoot, 'package.json');
const agentcliBin = join(agentcliRoot, 'bin', 'agentcli.js');
const agentcliIntegration = join(agentcliRoot, 'test', 'integration-scheduler.test.js');
const missingAgentcliFiles = [agentcliPackage, agentcliBin, agentcliIntegration]
  // These are fixed filenames beneath the explicitly selected local test checkout.
  // codeql[js/path-injection]
  .filter(file => !existsSync(file));

function hasStaleV2FieldVersionAssertion() {
  if (process.env.AGENTCLI_STALE_V2_FIELD_ASSERTION === '1') return true;
  if (missingAgentcliFiles.length > 0) return false;
  try {
    const packageVersion = JSON.parse(
      // codeql[js/path-injection]
      readFileSync(agentcliPackage, 'utf8'),
    ).version;
    // The integration source is a fixed file beneath the selected local checkout.
    // codeql[js/path-injection]
    const integrationSource = readFileSync(agentcliIntegration, 'utf8');
    return packageVersion === '0.4.0'
      && integrationSource.includes("assert.equal(result.handoff.field_version, '2', 'field_version should be 2')");
  } catch {
    return false;
  }
}

if (!skipAgentcli && missingAgentcliFiles.length === 0) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-agentcli-'));
  try {
    const integrationEnv = {
      ...process.env,
      AGENTCLI_PATH: agentcliRoot,
      REQUIRE_AGENTCLI_INTEGRATION: '1',
      SCHEDULER_PATH: root,
      SCHEDULER_DB: join(isolatedHome, 'scheduler.db'),
      OPENCLAW_SCHEDULER_HOME: isolatedHome,
    };
    runStep('scheduler agentcli contract integration', process.execPath, ['test-integration-agentcli.js'], {
      env: integrationEnv,
    });
    if (skipAgentcliOwned) {
      process.stdout.write('\n==> agentcli-owned integration explicitly skipped by --skip-agentcli-owned or SKIP_AGENTCLI_OWNED_INTEGRATION=1\n');
    } else {
      const staleV2Assertion = hasStaleV2FieldVersionAssertion();
      if (staleV2Assertion) {
        process.stdout.write('\n==> agentcli-owned integration: excluding its stale field_version=2-only assertion against handoff v3\n');
      }
      const ownedArgs = staleV2Assertion
        ? [
            '--test',
            '--test-skip-pattern=apply sends v0\\.2 fields when scheduler supports handoff v2',
            agentcliIntegration,
          ]
        : ['--test', agentcliIntegration];
      runStep('agentcli scheduler integration', process.execPath, ownedArgs, {
        cwd: agentcliRoot,
        env: integrationEnv,
      });
    }
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
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
