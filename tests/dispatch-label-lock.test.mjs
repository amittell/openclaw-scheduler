import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withLabelsLock } from '../dispatch/label-lock.mjs';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_URL = pathToFileURL(join(REPO_DIR, 'dispatch/label-lock.mjs')).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-label-lock-'));
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, '{"value":0}\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, labelsPath };
}

function runSync(script, args = [], options = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], {
    encoding: 'utf8', timeout: 15_000, ...options,
  });
}

function startWorker(script, args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const done = new Promise((resolve) => {
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitForFile(path) {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `worker did not create ${path}`);
    await delay(10);
  }
}

const PROBE = `
  import { withLabelsLock } from ${JSON.stringify(LOCK_URL)};
  try {
    withLabelsLock(process.argv[1], () => process.stdout.write('entered'), { timeoutMs: 150 });
  } catch (error) {
    if (!error.message.startsWith('labels lock timeout')) throw error;
    process.stdout.write('busy');
  }
`;

function assertProbe(labelsPath, expected) {
  const result = runSync(PROBE, [labelsPath]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
}

test('a live owner excludes other processes; normal release permits reacquisition', (t) => {
  const { labelsPath } = fixture(t);
  withLabelsLock(labelsPath, () => {
    assertProbe(labelsPath, 'busy');
    assert.equal(readFileSync(labelsPath, 'utf8'), '{"value":0}\n');
  });
  assertProbe(labelsPath, 'entered');
  assert.equal(existsSync(labelsPath + '.lock.sqlite3'), true);
});

test('throwing callbacks release ownership and nested ledgers preserve the outer owner', (t) => {
  const { root, labelsPath } = fixture(t);
  const otherPath = join(root, 'other.json');
  const failure = new Error('callback failed');
  assert.throws(() => withLabelsLock(labelsPath, () => { throw failure; }), (error) => error === failure);
  assertProbe(labelsPath, 'entered');
  withLabelsLock(labelsPath, () => {
    assert.equal(withLabelsLock(join(root, '.', 'labels.json'), () => 42), 42);
    withLabelsLock(otherPath, () => {
      assertProbe(labelsPath, 'busy');
      assertProbe(otherPath, 'busy');
    });
    assertProbe(otherPath, 'entered');
    assertProbe(labelsPath, 'busy');
  });
  assertProbe(labelsPath, 'entered');
});

test('crashed owner releases the OS mutex and concurrent successors retain all 800 updates', { timeout: 60_000 }, async (t) => {
  const { root, labelsPath } = fixture(t);
  const entered = join(root, 'owner-entered');
  // Legacy metadata cannot confer ownership or trigger unlink of the new mutex.
  // An upgrade must first quiesce all old writers; this represents their leftover file.
  const legacy = JSON.stringify({ pid: 2147483647, ts: 1 });
  writeFileSync(labelsPath + '.lock', legacy);
  const owner = startWorker(`
    import { withLabelsLock } from ${JSON.stringify(LOCK_URL)};
    import { writeFileSync } from 'node:fs';
    withLabelsLock(process.argv[1], () => {
      writeFileSync(process.argv[2], 'owned');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      throw new Error('test owner was not terminated');
    });
  `, [labelsPath, entered]);
  const workers = [owner];
  try {
    await waitForFile(entered);
    assertProbe(labelsPath, 'busy');
    assert.equal(owner.child.kill('SIGKILL'), true);
    const killed = await owner.done;
    assert.equal(killed.signal, 'SIGKILL');
    const successor = `
      import { withLabelsLock } from ${JSON.stringify(LOCK_URL)};
      import { readFileSync, writeFileSync, renameSync } from 'node:fs';
      for (let i = 0; i < 200; i++) {
        withLabelsLock(process.argv[1], () => {
          const state = JSON.parse(readFileSync(process.argv[1], 'utf8'));
          state.value++;
          const tmp = process.argv[1] + '.tmp.' + process.pid;
          writeFileSync(tmp, JSON.stringify(state));
          renameSync(tmp, process.argv[1]);
        });
      }
    `;
    for (let i = 0; i < 4; i++) workers.push(startWorker(successor, [labelsPath]));
    for (const result of await Promise.all(workers.slice(1).map((worker) => worker.done))) {
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(JSON.parse(readFileSync(labelsPath, 'utf8')).value, 800);
    assert.equal(readFileSync(labelsPath + '.lock', 'utf8'), legacy);
    assertProbe(labelsPath, 'entered');
  } finally {
    for (const worker of workers) worker.child.kill('SIGKILL');
    await Promise.all(workers.map((worker) => worker.done));
  }
});

test('an invalid mutex file fails closed without entering or replacing it', (t) => {
  const { labelsPath } = fixture(t);
  const mutexPath = labelsPath + '.lock.sqlite3';
  const original = 'invalid mutex database; never unlink a possible live owner';
  writeFileSync(mutexPath, original);
  let entered = false;
  assert.throws(() => withLabelsLock(labelsPath, () => { entered = true; }));
  assert.equal(entered, false);
  assert.equal(readFileSync(mutexPath, 'utf8'), original);
});

test('the actual npm archive contains and runs both dispatch entrypoints and their mutex', { timeout: 60_000 }, (t) => {
  const { root } = fixture(t);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: join(root, 'state'),
    OPENCLAW_SCHEDULER_HOME: join(root, 'scheduler'),
    DISPATCH_CONFIG_DIR: join(root, 'config'),
    DISPATCH_STATE_DIR: join(root, 'state'),
    DISPATCH_LABELS_PATH: join(root, 'state/labels.json'),
    SCHEDULER_DB: ':memory:',
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
  };
  // Pack/extract only: use already-installed dependencies, never npm install.
  const pack = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    cwd: REPO_DIR, env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(pack.error, undefined);
  assert.equal(pack.status, 0, pack.stderr);
  const [packed] = JSON.parse(pack.stdout);
  for (const path of ['dispatch/index.mjs', 'dispatch/watcher.mjs', 'dispatch/label-lock.mjs']) {
    assert.ok(packed.files.some((entry) => entry.path === path), `archive missing ${path}`);
  }
  const unpack = spawnSync('tar', ['-xzf', join(root, packed.filename), '-C', root], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(unpack.status, 0, unpack.stderr);
  const packageDir = join(root, 'package');
  for (const path of ['dispatch/index.mjs', 'dispatch/watcher.mjs', 'dispatch/label-lock.mjs']) {
    assert.deepEqual(readFileSync(join(packageDir, path)), readFileSync(join(REPO_DIR, path)),
      `archive changed ${path}`);
  }
  symlinkSync(realpathSync(join(REPO_DIR, 'node_modules')), join(packageDir, 'node_modules'), 'dir');
  for (const entrypoint of ['index.mjs', 'watcher.mjs']) {
    const result = spawnSync(process.execPath, [join(packageDir, 'dispatch', entrypoint)], {
      cwd: packageDir, env, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(result.stdout + result.stderr, entrypoint === 'watcher.mjs' ? /--label is required/ : /Usage:/i);
  }
  const packedLock = pathToFileURL(join(packageDir, 'dispatch/label-lock.mjs')).href;
  const result = runSync(`
    import { withLabelsLock } from ${JSON.stringify(packedLock)};
    process.stdout.write(withLabelsLock(process.argv[1], () => 'archive mutex entered'));
  `, [join(root, 'packed-labels.json')], { cwd: packageDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'archive mutex entered');
});
