import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createTestEnvironment } from '../scripts/test-environment.mjs';
import {
  DAEMON_RECORD_STALE_MS,
  compareVersions,
  daemonRestartInstruction,
  guardVersionMismatch,
  isDaemonRecordStale,
  isPidAlive,
  readDaemonVersionFile,
  resolveDaemonVersionPath,
  writeDaemonVersionFile,
} from '../version-guard.js';

const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'cli.js');
const dispatcherPath = join(root, 'dispatcher.js');
const dispatchPath = join(root, 'dispatch', 'index.mjs');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function fixtureHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'scheduler-version-guard-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// Test env for CLI/dispatch subprocesses: the guard is ENABLED (this file
// tests the guard), but the test-environment default dev opt-out is stripped
// so checkouts behave like production installs here.
function cliEnv(home, { extra = {} } = {}) {
  const schedulerHome = join(home, 'scheduler');
  const env = {
    ...createTestEnvironment(home, { dbPath: join(schedulerHome, 'scheduler.db') }),
    SCHEDULER_HOME: schedulerHome,
    OPENCLAW_SCHEDULER_HOME: schedulerHome,
    ...extra,
  };
  delete env.SCHEDULER_VERSION_GUARD_DEV;
  return env;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

function runDispatch(args, env) {
  return spawnSync(process.execPath, [dispatchPath, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

function writeDaemonVersion(home, version, { now = () => new Date(), packagePath = '/daemon/install' } = {}) {
  const schedulerHome = join(home, 'scheduler');
  if (!existsSync(schedulerHome)) mkdirSync(schedulerHome, { recursive: true });
  writeDaemonVersionFile({
    version,
    env: { HOME: home, SCHEDULER_HOME: schedulerHome },
    now,
    packagePath,
  });
}

test('compareVersions classifies match, mismatch, and unknown', () => {
  const cliPathArg = '/opt/homebrew/lib/node_modules/openclaw-scheduler/package.json';
  const daemonPathArg = '/Users/x/.openclaw/scheduler/daemon-version.json';

  const match = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: '0.6.10',
    cliPath: cliPathArg,
    daemonPath: daemonPathArg,
  });
  assert.equal(match.status, 'match');
  assert.equal(match.message, null);

  const mismatch = compareVersions({
    cliVersion: '0.6.7',
    daemonVersion: '0.6.9',
    cliPath: cliPathArg,
    daemonPath: daemonPathArg,
  });
  assert.equal(mismatch.status, 'mismatch');
  assert.match(mismatch.message, /version mismatch/i);
  assert.match(mismatch.message, /0\.6\.7/);
  assert.match(mismatch.message, /0\.6\.9/);
  assert.match(mismatch.message, /\/opt\/homebrew\/lib\/node_modules\/openclaw-scheduler/);
  assert.match(mismatch.message, /daemon-version\.json/);

  const unknown = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: null,
    cliPath: cliPathArg,
    daemonPath: daemonPathArg,
  });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.message, /no daemon version record/i);
});

test('compareVersions names the daemon install path when the record carries it', () => {
  const mismatch = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: '0.5.0',
    cliPath: '/cli/install/package.json',
    daemonPath: '/home/x/.openclaw/scheduler/daemon-version.json',
    daemonRecord: {
      version: '0.5.0',
      written_at: new Date().toISOString(),
      pid: process.pid,
      package_path: '/home/x/.openclaw/scheduler',
    },
  });
  assert.equal(mismatch.status, 'mismatch');
  assert.match(mismatch.message, /daemon install \/home\/x\/\.openclaw\/scheduler/);
});

test('compareVersions treats a stale record as unknown, not a match', () => {
  const staleAt = new Date(Date.now() - DAEMON_RECORD_STALE_MS - 1000).toISOString();
  const stale = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: '0.6.10',
    cliPath: '/cli/package.json',
    daemonPath: '/home/x/.openclaw/scheduler/daemon-version.json',
    daemonRecord: { version: '0.6.10', written_at: staleAt, pid: process.pid },
  });
  assert.equal(stale.status, 'unknown');
  assert.match(stale.message, /stale/i);
  assert.equal(stale.daemonVersion, null);

  // A matching fresh record still matches.
  const fresh = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: '0.6.10',
    cliPath: '/cli/package.json',
    daemonPath: '/home/x/.openclaw/scheduler/daemon-version.json',
    daemonRecord: { version: '0.6.10', written_at: new Date().toISOString(), pid: process.pid },
  });
  assert.equal(fresh.status, 'match');
});

test('compareVersions treats a dead-PID record as unknown even when fresh', () => {
  // Pick a PID that is very unlikely to exist on this host.
  let deadPid = 99999;
  if (process.platform !== 'win32') {
    while (isPidAlive(deadPid) === true && deadPid < 999990) deadPid += 7;
  }
  const stale = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: '0.6.9',
    cliPath: '/cli/package.json',
    daemonPath: '/home/x/.openclaw/scheduler/daemon-version.json',
    daemonRecord: { version: '0.6.9', written_at: new Date().toISOString(), pid: deadPid },
  });
  assert.equal(stale.status, 'unknown');
});

test('daemonRestartInstruction branches on platform', () => {
  assert.match(daemonRestartInstruction('darwin'), /launchctl kickstart/);
  assert.match(daemonRestartInstruction('linux'), /systemctl --user restart openclaw-scheduler/);
  assert.doesNotMatch(daemonRestartInstruction('linux'), /launchctl/);
  assert.doesNotMatch(daemonRestartInstruction('darwin'), /systemctl/);
  assert.match(daemonRestartInstruction('win32'), /platform service manager/i);
});

test('writeDaemonVersionFile writes atomically and round-trips under both home env vars', t => {
  const home = fixtureHome(t);
  const env = { HOME: home, SCHEDULER_HOME: join(home, 'scheduler') };
  const written = writeDaemonVersionFile({ version: packageVersion, env, now: () => new Date('2026-10-18T12:00:00Z') });
  assert.equal(written, join(home, 'scheduler', 'daemon-version.json'));
  const record = readDaemonVersionFile(env);
  assert.equal(record.version, packageVersion);
  assert.equal(record.written_at, '2026-10-18T12:00:00.000Z');
  assert.equal(record.path, written);
  // The record persists the daemon package path for remediation.
  assert.equal(record.package_path, root);

  // No temp files are left behind after a successful write.
  const dirEntries = readdirSync(join(home, 'scheduler'));
  assert.equal(dirEntries.filter(name => name.includes('.tmp')).length, 0, 'no temp files left behind');

  // OPENCLAW_SCHEDULER_HOME (the dispatch-side var) resolves to the same file.
  const dispatchEnv = { HOME: home, OPENCLAW_SCHEDULER_HOME: join(home, 'scheduler') };
  assert.equal(resolveDaemonVersionPath(dispatchEnv), written);
  assert.equal(readDaemonVersionFile(dispatchEnv).version, packageVersion);
});

test('resolveDaemonVersionPath rejects traversal and relative homes', () => {
  assert.equal(resolveDaemonVersionPath({ SCHEDULER_HOME: '../etc', HOME: null, USERPROFILE: null }), null, 'relative home is rejected');
  assert.equal(resolveDaemonVersionPath({ SCHEDULER_HOME: '../../root/daemon-version.json', HOME: null, USERPROFILE: null }), null);
  assert.equal(resolveDaemonVersionPath({ SCHEDULER_HOME: '', HOME: null, USERPROFILE: null }), null, 'empty explicit home with no HOME resolves nowhere');
  assert.equal(resolveDaemonVersionPath({ HOME: null, USERPROFILE: null }), null, 'no HOME at all resolves nowhere');
});

test('guardVersionMismatch is enabled for git-clone and npm installs by default; dev opt-out via SCHEDULER_VERSION_GUARD_DEV', () => {
  const env = { HOME: tmpdir(), SCHEDULER_DB: join(tmpdir(), 'x', 'scheduler.db') };
  // A source checkout is a supported git-clone-style install: the guard runs
  // (no daemon record here -> unknown), unlike the old heuristic that
  // disabled it for every non-node_modules path.
  const checkout = guardVersionMismatch({ env });
  assert.equal(checkout.status, 'unknown', 'checkout installs keep the guard enabled by default');

  // Explicit dev/test opt-out disables the guard entirely.
  assert.equal(guardVersionMismatch({ env: { ...env, SCHEDULER_VERSION_GUARD_DEV: '1' } }), null, 'SCHEDULER_VERSION_GUARD_DEV opts out');

  // In-memory test DBs still do not trip the guard.
  assert.equal(guardVersionMismatch({ env: { ...env, SCHEDULER_DB: ':memory:' } }), null, 'in-memory DB must not trip the guard');
});

test('isDaemonRecordStale flags old timestamps and dead PIDs', () => {
  const now = () => new Date('2026-10-18T12:00:00Z');
  assert.equal(isDaemonRecordStale(null, { now }), true);
  assert.equal(isDaemonRecordStale({ version: '1', written_at: 'garbage', pid: 1 }, { now }), true);
  assert.equal(isDaemonRecordStale({ version: '1', written_at: '2026-10-18T11:59:00Z', pid: process.pid }, { now }), false);
  assert.equal(isDaemonRecordStale({ version: '1', written_at: '2026-10-18T11:57:00Z', pid: process.pid }, { now }), true, 'older than refresh + tolerance is stale');
});

test('cli doctor reports version match and exits 0', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, packageVersion);
  const result = runCli(['doctor', '--json'], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.version_guard.status, 'match');
  assert.equal(payload.version_guard.cli_version, packageVersion);
  assert.equal(payload.version_guard.daemon_version, packageVersion);
});

test('cli doctor reports version mismatch, exits 1, and names both versions and both install paths', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0', { packagePath: '/old/daemon/install' });
  const result = runCli(['doctor', '--json'], cliEnv(home));
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.version_guard.status, 'mismatch');
  assert.equal(payload.version_guard.daemon_version, '0.5.0');
  assert.equal(payload.version_guard.cli_version, packageVersion);
  assert.match(payload.version_guard.cli_path, /package\.json$/);
  assert.match(payload.version_guard.daemon_path, /daemon-version\.json/);
  assert.match(result.stderr, /version mismatch/i);
  assert.match(result.stderr, /0\.5\.0/);
  // The remediation names the daemon install path recorded by the daemon.
  assert.match(result.stderr, /\/old\/daemon\/install/);
});

test('cli doctor --deep --no-version-guard still initializes the database (flag order independent)', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
  // --deep before --no-version-guard: the DB must be initialized either way.
  const result = runCli(['doctor', '--deep', '--no-version-guard', '--json'], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.version_guard.status, 'mismatch');
  assert.equal(payload.version_guard.skipped, true);
  assert.equal(payload.database.missing_tables.length, 0, 'schema was initialized');
  assert.equal(payload.database.init_ok, true);

  // Reversed order behaves the same.
  const reversed = runCli(['doctor', '--no-version-guard', '--deep', '--json'], cliEnv(home));
  assert.equal(reversed.status, 0, reversed.stderr);
  assert.equal(JSON.parse(reversed.stdout).database.missing_tables.length, 0);
});

test('cli doctor warns (exit 0) when no daemon version record exists', t => {
  const home = fixtureHome(t);
  const result = runCli(['doctor', '--json'], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version_guard.status, 'unknown');
  assert.equal(payload.version_guard.daemon_version, null);
  assert.ok(payload.warnings.some(warning => /version guard/i.test(warning)));
});

test('cli doctor warns (exit 0) when the daemon record is stale', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, packageVersion, { now: () => new Date(Date.now() - DAEMON_RECORD_STALE_MS - 60_000) });
  const result = runCli(['doctor', '--json'], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version_guard.status, 'unknown');
  assert.equal(payload.version_guard.daemon_version, null);
  assert.match(payload.version_guard.message ?? result.stderr, /stale/i);
});

test('cli commands hard-fail on mismatch and pass with SCHEDULER_VERSION_GUARD set', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');

  const failed = runCli(['status', '--json'], cliEnv(home));
  assert.equal(failed.status, 1, failed.stderr);
  const failedPayload = JSON.parse(failed.stdout);
  assert.equal(failedPayload.code, 'VERSION_MISMATCH');
  assert.match(failedPayload.error, /version mismatch/i);
  assert.match(failedPayload.error, /0\.5\.0/);
  assert.match(failedPayload.error, /0\.6\.\d+/);

  const warned = runCli(['status', '--json'], cliEnv(home, { extra: { SCHEDULER_VERSION_GUARD: '1' } }));
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /version mismatch/i);
  assert.doesNotMatch(warned.stdout, /VERSION_MISMATCH/);

  const matched = runCli(['status', '--json'], (() => {
    writeDaemonVersion(home, packageVersion);
    return cliEnv(home);
  })());
  assert.equal(matched.status, 0, matched.stderr);
  assert.doesNotMatch(matched.stderr, /version mismatch/i);
});

test('mismatch remediation uses platform-appropriate restart instructions', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
  const result = runCli(['status', '--json'], cliEnv(home));
  const message = JSON.parse(result.stdout).error;
  if (process.platform === 'darwin') {
    assert.match(message, /launchctl kickstart/);
    assert.doesNotMatch(message, /systemctl/);
  } else if (process.platform === 'linux') {
    assert.match(message, /systemctl --user restart openclaw-scheduler/);
    assert.doesNotMatch(message, /launchctl/);
  }
});

test('dispatch enqueue fails loudly on mismatch; list stays available', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
  const env = cliEnv(home);

  const enqueued = runDispatch(['enqueue', '--label', 'vg-guard-probe', '--message', 'probe', '--deliver-to', '123456789'], env);
  assert.equal(enqueued.status, 1, enqueued.stderr);
  assert.match(enqueued.stderr, /version mismatch/i);
  assert.match(enqueued.stderr, /0\.5\.0/);
  assert.match(enqueued.stderr, /daemon-version\.json/);

  const listed = runDispatch(['list'], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stderr, /version mismatch/i);

  // With SCHEDULER_VERSION_GUARD set the guard downgrades to a warning and
  // lets enqueue proceed; the spawn then fails on the stubbed gateway, so
  // assert the guard warned AND that it continued to the gateway call
  // (proof the guard did not hard-exit first).
  const enqueuedWarned = runDispatch(
    ['enqueue', '--label', 'vg-guard-probe', '--message', 'probe', '--deliver-to', '123456789'],
    cliEnv(home, { extra: { SCHEDULER_VERSION_GUARD: '1' } }),
  );
  assert.match(enqueuedWarned.stderr, /version mismatch/i);
  assert.match(enqueuedWarned.stderr, /gateway/i, 'enqueue must continue past the guard in warn mode');
});

test('dispatch enqueue stamps the ledger row with the client version', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, packageVersion);
  const schedulerHome = join(home, 'scheduler');
  const env = cliEnv(home, {
    extra: {
      DISPATCH_STATE_DIR: join(schedulerHome, 'dispatch'),
      DISPATCH_LABELS_PATH: join(schedulerHome, 'dispatch', 'labels.json'),
    },
  });
  const result = runDispatch(
    ['enqueue', '--label', 'vg-client-version', '--message', 'probe', '--deliver-to', '123456789'],
    env,
  );
  // The gateway stub refuses the spawn; the claim row (written before the
  // gateway call) must already carry the client version stamp.
  const labelsPath = join(schedulerHome, 'dispatch', 'labels.json');
  assert.ok(existsSync(labelsPath), `labels ledger exists: ${result.stderr}`);
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  assert.equal(labels['vg-client-version']?.clientVersion, packageVersion);
});

test('dispatcher writes daemon-version.json only after lease acquisition and removes it on shutdown', async t => {
  const home = fixtureHome(t);
  const schedulerHome = join(home, 'scheduler');
  const dbPath = join(schedulerHome, 'scheduler.db');
  const versionFile = join(schedulerHome, 'daemon-version.json');
  const env = {
    ...createTestEnvironment(home, { dbPath }),
    OPENCLAW_SCHEDULER_HOME: schedulerHome,
    SCHEDULER_DB: dbPath,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
  };
  delete env.SCHEDULER_VERSION_GUARD_DEV;
  const child = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Register cleanup BEFORE any await so a failed assertion cannot leak the
  // dispatcher and hang the test runner.
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise(resolveExit => {
        const timer = setTimeout(resolveExit, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    rmSync(home, { recursive: true, force: true });
  });

  // Wait for the lease to be acquired first, then for the version record to
  // appear: the write must happen AFTER the lease.
  const leaseDeadline = Date.now() + 15_000;
  while (!stderr.includes('Dispatcher lease acquired') && Date.now() < leaseDeadline) {
    if (child.exitCode != null) throw new Error(`dispatcher exited early: ${stderr}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.match(stderr, /Dispatcher lease acquired/, `dispatcher acquired the lease: ${stderr}`);
  const fileDeadline = Date.now() + 15_000;
  let record = null;
  while (Date.now() < fileDeadline) {
    if (child.exitCode != null) throw new Error(`dispatcher exited early: ${stderr}`);
    if (existsSync(versionFile)) {
      record = JSON.parse(readFileSync(versionFile, 'utf8'));
      if (record.version === packageVersion) break;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(record, `dispatcher did not write ${versionFile}: ${stderr}`);
  assert.equal(record.version, packageVersion);
  assert.ok(record.written_at, 'record has a startup timestamp');
  assert.equal(record.package_path, root, 'record names the daemon install path');
  // The record's own timestamp proves the write happened after the lease was
  // acquired (stderr buffering makes line-order checks unreliable).
  const leaseLine = stderr.split('\n').find(line => line.includes('Dispatcher lease acquired'));
  assert.ok(leaseLine, 'startup log names the lease acquisition');
  const leaseAt = Date.parse(leaseLine.slice(0, 24));
  assert.ok(Number.isFinite(leaseAt), `lease line has a timestamp: ${leaseLine}`);
  assert.ok(Date.parse(record.written_at) >= leaseAt, 'version record is published after lease acquisition');

  // Refresh: delete the file and wait for the next tick to rewrite it.
  rmSync(versionFile);
  const refreshDeadline = Date.now() + 15_000;
  while (Date.now() < refreshDeadline) {
    if (child.exitCode != null) throw new Error(`dispatcher exited during refresh: ${stderr}`);
    if (existsSync(versionFile)) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(existsSync(versionFile), 'dispatcher did not refresh the version file after deletion');
  assert.equal(JSON.parse(readFileSync(versionFile, 'utf8')).version, packageVersion);

  // Shutdown: the record is removed so a stopped daemon reads as unknown.
  child.kill('SIGTERM');
  const exitDeadline = Date.now() + 10_000;
  while (child.exitCode == null && Date.now() < exitDeadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(child.exitCode != null, `dispatcher did not exit on SIGTERM: ${stderr}`);
  assert.ok(!existsSync(versionFile), 'dispatcher removed the version record on shutdown');
});

test('a dispatcher that fails to acquire the lease does not publish a version record', async t => {
  const home = fixtureHome(t);
  const schedulerHome = join(home, 'scheduler');
  const dbPath = join(schedulerHome, 'scheduler.db');
  const versionFile = join(schedulerHome, 'daemon-version.json');
  const env = {
    ...createTestEnvironment(home, { dbPath }),
    OPENCLAW_SCHEDULER_HOME: schedulerHome,
    SCHEDULER_DB: dbPath,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
  };
  delete env.SCHEDULER_VERSION_GUARD_DEV;

  const first = spawn(process.execPath, [dispatcherPath], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let firstStderr = '';
  first.stderr.setEncoding('utf8');
  first.stderr.on('data', chunk => { firstStderr += chunk; });
  let second = null;
  let secondStderr = '';
  // Register cleanup BEFORE any await so a failed assertion cannot leak the
  // dispatchers and hang the test runner. The second dispatcher is spawned
  // later (after the first finishes startup); cleanup handles both.
  t.after(async () => {
    for (const child of [first, second]) {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise(resolveExit => {
          const timer = setTimeout(resolveExit, 5_000);
          child.once('exit', () => { clearTimeout(timer); resolveExit(); });
        });
        if (child.exitCode == null) child.kill('SIGKILL');
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  // Wait for the first dispatcher to hold the lease, then give it a moment
  // to finish startup (the second must not race it into a database lock).
  const firstDeadline = Date.now() + 15_000;
  while (!firstStderr.includes('Dispatcher lease acquired') && Date.now() < firstDeadline) {
    if (first.exitCode != null) throw new Error(`first dispatcher exited early: ${firstStderr}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.match(firstStderr, /Dispatcher lease acquired/);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_500));
  // Give the first dispatcher a moment to publish its record.
  const recordDeadline = Date.now() + 15_000;
  while (!existsSync(versionFile) && Date.now() < recordDeadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(existsSync(versionFile), 'first dispatcher published the version record');

  // The second dispatcher must fail to start and must not touch the record.
  second = spawn(process.execPath, [dispatcherPath], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  second.stderr.setEncoding('utf8');
  second.stderr.on('data', chunk => { secondStderr += chunk; });
  const secondDeadline = Date.now() + 15_000;
  while (second.exitCode == null && Date.now() < secondDeadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.equal(second.exitCode, 1, `second dispatcher should exit 1: ${secondStderr}`);
  assert.match(secondStderr, /Another live dispatcher owns the scheduler lease/);
  const recordAfter = JSON.parse(readFileSync(versionFile, 'utf8'));
  assert.equal(recordAfter.pid, first.pid, 'the lease loser did not overwrite the live daemon record');
  assert.ok(existsSync(versionFile), 'the lease loser did not delete the live daemon record');
});

test('daemon logs loudly for labels enqueued by a legacy (unversioned) CLI', async t => {
  const home = fixtureHome(t);
  const schedulerHome = join(home, 'scheduler');
  const dbPath = join(schedulerHome, 'scheduler.db');
  const env = {
    ...createTestEnvironment(home, { dbPath }),
    OPENCLAW_SCHEDULER_HOME: schedulerHome,
    SCHEDULER_DB: dbPath,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
  };
  delete env.SCHEDULER_VERSION_GUARD_DEV;

  // Seed a label row the way a pre-0.6.11 CLI would have: no clientVersion.
  const stateDir = join(schedulerHome, 'dispatch');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'labels.json'), JSON.stringify({
    'legacy-label': {
      status: 'running',
      sessionKey: 'agent:main:subagent:legacy',
      agent: 'main',
      runId: 'run-legacy',
      updatedAt: new Date().toISOString(),
    },
  }) + '\n');

  const child = spawn(process.execPath, [dispatcherPath], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise(resolveExit => {
        const timer = setTimeout(resolveExit, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    rmSync(home, { recursive: true, force: true });
  });

  const deadline = Date.now() + 15_000;
  while (!stderr.includes('without a client version stamp') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`dispatcher exited early: ${stderr}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.match(stderr, /Version guard: label "legacy-label" was enqueued by a CLI copy without a client version stamp/);
  assert.match(stderr, /daemon runs v\d/);
  // The log is an error-level line (loud), and it is emitted once per label
  // per daemon lifetime (deduplicated).
  assert.match(stderr, /\[error\]/);
  const count = stderr.split('without a client version stamp').length - 1;
  assert.ok(count <= 2, `legacy label logged once (saw ${count} times)`);
});
