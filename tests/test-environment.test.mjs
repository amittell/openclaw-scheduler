import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
