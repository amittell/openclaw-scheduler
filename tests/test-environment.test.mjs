import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { createTestEnvironment } from '../scripts/test-environment.mjs';
import { resolveSchedulerHome } from '../paths.js';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

test('fixture HOME remains authoritative after clearing inherited runtime paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-test-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = {
    HOME: join(root, 'parent'),
    SCHEDULER_HOME: join(root, 'outside-scheduler'),
    SCHEDULER_DB: join(root, 'outside.db'),
    OPENCLAW_STATE_DIR: join(root, 'outside-openclaw'),
    OPENCLAW_CONFIG_PATH: join(root, 'outside-openclaw.json'),
    OPENCLAW_SCHEDULER_HOME: join(root, 'outside-dispatch'),
    DISPATCH_LABELS_PATH: join(root, 'outside-labels.json'),
    NODE_V8_COVERAGE: join(root, 'coverage'),
    AGENTCLI_CONTRACT: 'handoff-v4',
  };
  const snapshot = { ...parent };
  const fixtureHome = join(root, 'fixture');
  // Negative control: HOME alone cannot override an inherited explicit path.
  assert.equal(resolveSchedulerHome({ ...parent, HOME: fixtureHome }), parent.SCHEDULER_HOME);
  const isolated = createTestEnvironment(join(root, 'suite'), { env: parent });
  assert.equal(resolveSchedulerHome({ ...isolated, HOME: fixtureHome }), join(fixtureHome, '.openclaw', 'scheduler'));
  assert.equal(isolated.SCHEDULER_DB, join(root, 'suite', 'scheduler.db'));
  for (const key of ['SCHEDULER_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_SCHEDULER_HOME', 'DISPATCH_LABELS_PATH']) {
    assert.equal(isolated[key], undefined, key);
  }
  assert.equal(isolated.NODE_V8_COVERAGE, parent.NODE_V8_COVERAGE);
  assert.equal(isolated.AGENTCLI_CONTRACT, parent.AGENTCLI_CONTRACT);
  assert.deepEqual(parent, snapshot, 'caller environment is unchanged');
});

test('every test-all phase isolates hook Git selectors and leaves the invoking repository untouched', t => {
  // Node resolves the copied runner's module URL, so its explicit sibling paths
  // must refer to the same canonical root even when TMPDIR has a symlink alias.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-test-runner-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduler = join(root, 'scheduler');
  const agentcli = join(root, 'agentcli');
  const sentinel = join(root, 'publisher');
  const evidence = join(root, 'evidence');
  for (const dir of [join(scheduler, 'scripts'), join(scheduler, 'tests'), join(agentcli, 'bin'), join(agentcli, 'test'), sentinel, evidence]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const name of ['test-all.mjs', 'test-environment.mjs']) {
    copyFileSync(join(sourceRoot, 'scripts', name), join(scheduler, 'scripts', name));
  }
  for (const dir of [scheduler, agentcli]) writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(agentcli, 'bin', 'agentcli.js'), '');
  const clean = createTestEnvironment(join(root, 'git-home'));
  function git(args, env = clean) {
    const result = spawnSync('git', args, { cwd: sentinel, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Publisher sentinel']);
  git(['config', 'user.email', 'publisher@example.invalid']);
  git(['commit', '--allow-empty', '-m', 'preserve publisher']);
  git(['remote', 'add', 'origin', join(root, 'never-contact.git')]);
  const sentinelGit = join(sentinel, '.git');
  const before = {
    head: git(['rev-parse', 'HEAD']),
    config: readFileSync(join(sentinelGit, 'config'), 'utf8'),
    reflog: readFileSync(join(sentinelGit, 'logs', 'HEAD'), 'utf8'),
  };
  const poisoned = {
    ...process.env,
    HOME: join(root, 'outside-home'),
    XDG_CONFIG_HOME: join(root, 'outside-config'),
    GIT_DIR: sentinelGit,
    GIT_WORK_TREE: sentinel,
    GIT_INDEX_FILE: join(sentinelGit, 'index'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.inherited.url',
    GIT_CONFIG_VALUE_0: join(root, 'never-contact-either.git'),
    SCHEDULER_HOME: join(root, 'outside-scheduler'),
    OPENCLAW_STATE_DIR: join(root, 'outside-state'),
    OPENCLAW_CONFIG_PATH: join(root, 'outside-state', 'openclaw.json'),
    OPENCLAW_SCHEDULER_HOME: join(root, 'outside-dispatch'),
    DISPATCH_STATE_DIR: join(root, 'outside-dispatch-state'),
    REQUIRE_AGENTCLI_INTEGRATION: '1',
    SKIP_AGENTCLI_INTEGRATION: '0',
    SKIP_AGENTCLI_OWNED_INTEGRATION: '0',
    AGENTCLI_PATH: agentcli,
    NODE_V8_COVERAGE: join(root, 'coverage'),
    FIXTURE_TEST_EVIDENCE: evidence,
  };
  // Model a Git hook, not this test worker: node:test suppresses nested --test.
  delete poisoned.NODE_TEST_CONTEXT;
  // This valid hook environment really selects the publisher, irrespective of cwd.
  assert.equal(resolve(git(['rev-parse', '--absolute-git-dir'], poisoned)), realpathSync(sentinelGit));
  const probe = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
    import { join, resolve } from 'node:path';
    const env = process.env;
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'SCHEDULER_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_SCHEDULER_HOME', 'DISPATCH_STATE_DIR']) {
      assert.equal(env[key], undefined, key);
    }
    assert.equal(env.SCHEDULER_DB, phase === 'legacy' ? ':memory:' : join(env.HOME, 'scheduler.db'));
    assert.equal(env.XDG_CONFIG_HOME, join(env.HOME, '.config'));
    assert.equal(env.GIT_CONFIG_GLOBAL, join(env.HOME, '.gitconfig'));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(env.NODE_V8_COVERAGE.endsWith('coverage'));
    if (phase.startsWith('agentcli')) {
      assert.equal(env.SCHEDULER_PATH, ${JSON.stringify(scheduler)});
      assert.equal(env.AGENTCLI_PATH, ${JSON.stringify(agentcli)});
      assert.equal(env.REQUIRE_AGENTCLI_INTEGRATION, '1');
    }
    const cwd = join(env.HOME, 'fixture-repo');
    mkdirSync(cwd);
    function git(...args) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Synthetic mirror test');
    git('config', 'user.email', 'mirror@example.invalid');
    git('commit', '--allow-empty', '-m', 'base');
    git('remote', 'add', 'origin', join(env.HOME, 'local.git'));
    assert.equal(resolve(git('rev-parse', '--show-toplevel')), realpathSync(cwd));
    writeFileSync(join(env.FIXTURE_TEST_EVIDENCE, phase + '.json'), JSON.stringify({ home: env.HOME }));
  `;
  const phases = [
    ['legacy', join(scheduler, 'test.js')],
    ['focused', join(scheduler, 'tests', 'probe.test.mjs')],
    ['docs', join(scheduler, 'scripts', 'validate-doc-examples.mjs')],
    ['agentcli-scheduler', join(scheduler, 'test-integration-agentcli.js')],
    ['agentcli-owned', join(agentcli, 'test', 'integration-scheduler.test.js')],
  ];
  for (const [phase, path] of phases) writeFileSync(path, `const phase = ${JSON.stringify(phase)};\n${probe}`);
  const run = spawnSync(process.execPath, [join(scheduler, 'scripts', 'test-all.mjs')], {
    cwd: scheduler, env: poisoned, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /All 5 verification step\(s\) passed/);
  const homes = phases.map(([phase]) => {
    const receipt = join(evidence, phase + '.json');
    assert.ok(existsSync(receipt), `${phase} did not execute: ${run.stdout}\n${run.stderr}`);
    return JSON.parse(readFileSync(receipt, 'utf8')).home;
  });
  assert.equal(new Set(homes).size, 5, 'every phase has an independent HOME');
  assert.ok(homes.every(home => !existsSync(home)), 'all per-phase homes were cleaned up');
  assert.equal(git(['rev-parse', 'HEAD']), before.head);
  assert.equal(readFileSync(join(sentinelGit, 'config'), 'utf8'), before.config);
  assert.equal(readFileSync(join(sentinelGit, 'logs', 'HEAD'), 'utf8'), before.reflog);
  for (const name of ['outside-home', 'outside-config', 'outside-scheduler', 'outside-state', 'outside-dispatch', 'outside-dispatch-state']) {
    assert.equal(existsSync(join(root, name)), false, `${name} must stay untouched`);
  }
});

test('every test entry point isolates itself before loading scheduler modules', () => {
  // `node test.js` and `node --test tests/<file>` bypass test-all.mjs, so each
  // entry point must apply the isolation itself, ahead of every other import.
  const entries = [
    ['test.js', './tests/isolate-environment.mjs'],
    ...readdirSync(join(sourceRoot, 'tests'))
      .filter(name => name.endsWith('.test.mjs'))
      .map(name => [join('tests', name), './isolate-environment.mjs']),
  ];
  assert.ok(entries.some(([file]) => file === join('tests', 'test-environment.test.mjs')));
  for (const [file, specifier] of entries) {
    const firstImport = readFileSync(join(sourceRoot, file), 'utf8').match(/^import\b.*$/m)?.[0];
    assert.equal(firstImport, `import '${specifier}';`, file);
  }
});

test('a directly started test process cannot reach the invoking Gateway, credentials or database', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-test-direct-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operatorHome = join(root, 'operator');
  const operatorBin = join(root, 'operator-bin');
  const cliReceipt = join(root, 'operator-cli-ran');
  mkdirSync(join(operatorHome, '.openclaw'), { recursive: true });
  mkdirSync(operatorBin);
  writeFileSync(join(operatorHome, '.openclaw', 'openclaw.json'), JSON.stringify({
    gateway: { port: 18789, auth: { token: 'operator-token' } },
  }));
  // Stands in for the installed CLI, which would dial ws://127.0.0.1:18789.
  writeFileSync(join(operatorBin, 'openclaw'), `#!/bin/sh\necho ran >> ${JSON.stringify(cliReceipt)}\n`, { mode: 0o755 });
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, `
    import ${JSON.stringify(pathToFileURL(join(sourceRoot, 'tests', 'isolate-environment.mjs')).href)};
    import { spawnSync } from 'node:child_process';
    const env = process.env;
    const cli = childEnv => spawnSync('openclaw', ['gateway', 'call', 'health', '--json'], { env: childEnv }).status;
    process.stdout.write(JSON.stringify({
      home: env.HOME,
      db: env.SCHEDULER_DB,
      url: env.OPENCLAW_GATEWAY_URL,
      token: env.OPENCLAW_GATEWAY_TOKEN ?? null,
      stateDir: env.OPENCLAW_STATE_DIR ?? null,
      inheritedCli: cli(env),
      // A fixture that rebuilds its environment from PATH alone loses the URL.
      rebuiltCli: cli({ PATH: env.PATH }),
    }));
  `);
  const invoker = {
    ...process.env,
    HOME: operatorHome,
    PATH: `${operatorBin}${delimiter}${process.env.PATH}`,
    OPENCLAW_GATEWAY_TOKEN: 'operator-token',
    OPENCLAW_STATE_DIR: join(operatorHome, '.openclaw'),
  };
  delete invoker.OPENCLAW_GATEWAY_URL;
  const probeWith = env => {
    const run = spawnSync(process.execPath, [probe], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };

  const direct = probeWith({ ...invoker, SCHEDULER_DB: join(operatorHome, 'live.db') });
  assert.notEqual(direct.home, operatorHome);
  assert.equal(direct.db, join(direct.home, 'scheduler.db'));
  assert.equal(direct.url, 'http://127.0.0.1:9');
  assert.equal(direct.token, null);
  assert.equal(direct.stateDir, null);
  assert.equal(direct.inheritedCli, 127);
  assert.equal(direct.rebuiltCli, 127);
  assert.equal(existsSync(direct.home), false, 'the per-process HOME is removed on exit');

  // The legacy suite's documented `SCHEDULER_DB=:memory: node test.js` keeps its in-memory database.
  assert.equal(probeWith({ ...invoker, SCHEDULER_DB: ':memory:' }).db, ':memory:');

  // A test file started by test-all.mjs keeps the runner's environment.
  const runnerHome = join(root, 'runner');
  const runner = probeWith(createTestEnvironment(runnerHome, { env: invoker, dbPath: ':memory:' }));
  assert.equal(runner.home, runnerHome);
  assert.equal(runner.db, ':memory:');
  assert.equal(runner.token, null);
  assert.equal(runner.inheritedCli, 127);

  assert.equal(existsSync(cliReceipt), false, 'the invoking openclaw CLI never ran');
});
