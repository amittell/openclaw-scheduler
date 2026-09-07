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

function startWorker(script, args, options = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
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

test('a delayed legacy bootstrap cannot overwrite a new writer after its missing-file check', { timeout: 30_000 }, async (t) => {
  const { root } = fixture(t);
  const stateDir = join(root, 'bootstrap-state');
  const labelsPath = join(stateDir, 'labels.json');
  const legacyPath = join(root, 'legacy.json');
  const observed = join(root, 'missing-observed');
  const resume = join(root, 'resume-bootstrap');
  writeFileSync(legacyPath, '{"value":0}\n');
  const pathsUrl = pathToFileURL(join(REPO_DIR, 'dispatch/paths.mjs')).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [who, stateDir, legacyPath, observed, resume] = process.argv.slice(1);
    const labelsPath = stateDir + '/labels.json';
    if (who === 'A') {
      const original = fs.existsSync;
      let intercepted = false;
      fs.existsSync = function (path) {
        const exists = original(path);
        if (path === labelsPath && !exists && !intercepted) {
          intercepted = true;
          fs.writeFileSync(observed, 'missing');
          const deadline = Date.now() + 15_000;
          while (!original(resume)) {
            if (Date.now() > deadline) throw new Error('bootstrap barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return exists;
      };
      syncBuiltinESMExports();
    }
    const { resolveLabelsPath } = await import(${JSON.stringify(pathsUrl)});
    const { withLabelsLock } = await import(${JSON.stringify(LOCK_URL)});
    resolveLabelsPath({ env: { DISPATCH_STATE_DIR: stateDir }, legacyCandidates: [legacyPath] });
    if (who === 'B') {
      withLabelsLock(labelsPath, () => {
        const state = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
        state.value++;
        fs.writeFileSync(labelsPath, JSON.stringify(state));
      });
    }
  `;
  const args = [stateDir, legacyPath, observed, resume];
  const first = startWorker(script, ['A', ...args]);
  const workers = [first];
  try {
    await waitForFile(observed);
    const second = startWorker(script, ['B', ...args]);
    workers.push(second);
    const created = await second.done;
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(readFileSync(labelsPath, 'utf8')).value, 1);
    writeFileSync(resume, 'continue');
    const delayed = await first.done;
    assert.equal(delayed.status, 0, delayed.stderr);
    assert.equal(JSON.parse(readFileSync(labelsPath, 'utf8')).value, 1,
      'late bootstrap must retain the update written after its initial missing check');
  } finally {
    for (const worker of workers) worker.child.kill('SIGKILL');
    await Promise.all(workers.map((worker) => worker.done));
  }
});

for (const mode of ['concurrent-claimers', 'completed-before-claim', 'completed-during-dispatch', 'edited-during-dispatch']) {
  test(`recovery owns fresh ledger mutations and preserves concurrent state: ${mode}`, { timeout: 30_000 }, async (t) => {
    const { root, labelsPath } = fixture(t);
    const recoveryPath = join(REPO_DIR, 'dispatch/529-recovery.mjs');
    const callsPath = join(root, 'fixture-calls.jsonl');
    const stubPath = join(root, 'owned-cli.mjs');
    const initial = {
      retry: { status: 'error', error: 'synthetic 529 overload',
        updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(), retryCount: 0 },
      unrelated: { marker: 0 },
    };
    writeFileSync(labelsPath, JSON.stringify(initial));
    writeFileSync(stubPath, `
      import { withLabelsLock } from ${JSON.stringify(LOCK_URL)};
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      const verb = process.argv[2];
      // This separate child must acquire the actual mutex successfully. A
      // recovery parent holding ownership across dispatch would fail here.
      withLabelsLock(process.env.DISPATCH_LABELS_PATH, () => {
        appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ verb }) + '\\n');
        if (verb === 'send' && ${JSON.stringify(mode)}.endsWith('-during-dispatch')) {
          const labels = JSON.parse(readFileSync(process.env.DISPATCH_LABELS_PATH, 'utf8'));
          if (${JSON.stringify(mode)} === 'completed-during-dispatch') {
            labels.retry.status = 'done';
            labels.retry.error = null;
          } else {
            labels.retry.error = 'different failure after claim';
          }
          // Deliberately retain updatedAt: timestamp equality is insufficient
          // to prove this is still the entry recovery claimed.
          labels.retry.note = 'concurrent change';
          writeFileSync(process.env.DISPATCH_LABELS_PATH, JSON.stringify(labels));
        }
      }, { timeoutMs: 150 });
    `);
    const databaseUrl = pathToFileURL(join(REPO_DIR, 'node_modules/better-sqlite3/lib/index.js')).href;
    const script = `
      import Database from ${JSON.stringify(databaseUrl)};
      import { writeFileSync } from 'node:fs';
      const original = Database.prototype.exec;
      Database.prototype.exec = function (sql) {
        if (sql === 'BEGIN IMMEDIATE') writeFileSync(process.argv[2], 'attempting actual mutex');
        return original.call(this, sql);
      };
      await import(process.argv[1]);
    `;
    const env = {
      ...process.env,
      HOME: join(root, 'home'), OPENCLAW_SCHEDULER_HOME: join(root, 'scheduler'),
      SCHEDULER_DB: ':memory:', DISPATCH_STATE_DIR: root, DISPATCH_LABELS_PATH: labelsPath,
      DISPATCH_INDEX_PATH: stubPath, OPENCLAW_SCHEDULER_CLI: stubPath,
    };
    const workers = [];
    try {
      withLabelsLock(labelsPath, () => {
        const markers = [];
        for (let i = 0; i < (mode === 'concurrent-claimers' ? 2 : 1); i++) {
          const marker = join(root, `attempt-${i}`);
          markers.push(marker);
          workers.push(startWorker(script, [pathToFileURL(recoveryPath).href, marker], { env }));
        }
        const deadline = Date.now() + 15_000;
        while (markers.some((marker) => !existsSync(marker))) {
          assert.ok(Date.now() < deadline, 'recovery did not attempt the actual mutex');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        assert.deepEqual(JSON.parse(readFileSync(labelsPath, 'utf8')), initial,
          'recovery must not mutate while another owner holds the mutex');
        assert.equal(existsSync(callsPath), false, 'no subprocess before a successful retry claim');
        initial.unrelated.marker = 1;
        if (mode === 'completed-before-claim') initial.retry.status = 'done';
        writeFileSync(labelsPath, JSON.stringify(initial));
      });
      for (const result of await Promise.all(workers.map((worker) => worker.done))) {
        assert.equal(result.status, 0, result.stderr);
      }
      const final = JSON.parse(readFileSync(labelsPath, 'utf8'));
      const calls = existsSync(callsPath)
        ? readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
      assert.equal(final.unrelated.marker, 1);
      if (mode === 'completed-before-claim') {
        assert.deepEqual(calls, []);
        assert.equal(final.retry.status, 'done');
        assert.equal(final.retry.retryCount, 0);
      } else {
        assert.deepEqual(calls, [{ verb: 'send' }, { verb: 'msg' }], 'one claimant dispatches once');
        assert.equal(final.retry.retryCount, 1);
        if (mode === 'concurrent-claimers') {
          assert.equal(final.retry.status, 'running');
          assert.equal(final.retry.error, null);
        } else {
          assert.equal(final.retry.note, 'concurrent change');
          assert.equal(final.retry.status, mode === 'completed-during-dispatch' ? 'done' : 'error');
          assert.equal(final.retry.error, mode === 'completed-during-dispatch' ? null : 'different failure after claim');
        }
      }
    } finally {
      for (const worker of workers) worker.child.kill('SIGKILL');
      await Promise.all(workers.map((worker) => worker.done));
    }
  });
}

test('the actual npm archive contains and runs dispatch writers and their mutex', { timeout: 60_000 }, (t) => {
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
  const runtimePaths = ['dispatch/index.mjs', 'dispatch/watcher.mjs', 'dispatch/label-lock.mjs',
    'dispatch/paths.mjs', 'dispatch/529-recovery.mjs'];
  for (const path of runtimePaths) {
    assert.ok(packed.files.some((entry) => entry.path === path), `archive missing ${path}`);
  }
  const unpack = spawnSync('tar', ['-xzf', join(root, packed.filename), '-C', root], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(unpack.status, 0, unpack.stderr);
  const packageDir = join(root, 'package');
  for (const path of runtimePaths) {
    assert.deepEqual(readFileSync(join(packageDir, path)), readFileSync(join(REPO_DIR, path)),
      `archive changed ${path}`);
  }
  symlinkSync(realpathSync(join(REPO_DIR, 'node_modules')), join(packageDir, 'node_modules'), 'dir');
  for (const entrypoint of ['index.mjs', 'watcher.mjs', '529-recovery.mjs']) {
    const result = spawnSync(process.execPath, [join(packageDir, 'dispatch', entrypoint)], {
      cwd: packageDir, env, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, entrypoint === '529-recovery.mjs' ? 0 : 2, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    const expected = { 'watcher.mjs': /--label is required/, 'index.mjs': /Usage:/i,
      '529-recovery.mjs': /no 529 errors found/ };
    assert.match(result.stdout + result.stderr, expected[entrypoint]);
  }
  const packedLock = pathToFileURL(join(packageDir, 'dispatch/label-lock.mjs')).href;
  const result = runSync(`
    import { withLabelsLock } from ${JSON.stringify(packedLock)};
    process.stdout.write(withLabelsLock(process.argv[1], () => 'archive mutex entered'));
  `, [join(root, 'packed-labels.json')], { cwd: packageDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'archive mutex entered');
});
