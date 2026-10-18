import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { createTestEnvironment } from '../scripts/test-environment.mjs';
import {
  compareVersions,
  guardVersionMismatch,
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

function cliEnv(home, { extra = {} } = {}) {
  const schedulerHome = join(home, 'scheduler');
  return {
    ...createTestEnvironment(home, { dbPath: join(schedulerHome, 'scheduler.db') }),
    SCHEDULER_HOME: schedulerHome,
    OPENCLAW_SCHEDULER_HOME: schedulerHome,
    SCHEDULER_VERSION_GUARD_FORCE: '1',
    ...extra,
  };
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

function writeDaemonVersion(home, version) {
  const schedulerHome = join(home, 'scheduler');
  if (!existsSync(schedulerHome)) mkdirSync(schedulerHome, { recursive: true });
  writeDaemonVersionFile({
    version,
    env: { HOME: home, SCHEDULER_HOME: schedulerHome },
    now: () => new Date('2026-10-18T12:00:00Z'),
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
  assert.match(mismatch.message, /cliPathArg|\/opt\/homebrew\/lib\/node_modules\/openclaw-scheduler/);
  assert.match(mismatch.message, /daemon-version\.json/);
  assert.match(mismatch.message, /kickstart/);

  const unknown = compareVersions({
    cliVersion: '0.6.10',
    daemonVersion: null,
    cliPath: cliPathArg,
    daemonPath: daemonPathArg,
  });
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.message, /no daemon version record/i);
});

test('writeDaemonVersionFile and readDaemonVersionFile round-trip under both home env vars', t => {
  const home = fixtureHome(t);
  const env = { HOME: home, SCHEDULER_HOME: join(home, 'scheduler') };
  const written = writeDaemonVersionFile({ version: packageVersion, env, now: () => new Date('2026-10-18T12:00:00Z') });
  assert.equal(written, join(home, 'scheduler', 'daemon-version.json'));
  const record = readDaemonVersionFile(env);
  assert.equal(record.version, packageVersion);
  assert.equal(record.written_at, '2026-10-18T12:00:00.000Z');
  assert.equal(record.path, written);

  // OPENCLAW_SCHEDULER_HOME (the dispatch-side var) resolves to the same file.
  const dispatchEnv = { HOME: home, OPENCLAW_SCHEDULER_HOME: join(home, 'scheduler') };
  assert.equal(resolveDaemonVersionPath(dispatchEnv), written);
  assert.equal(readDaemonVersionFile(dispatchEnv).version, packageVersion);
});

test('guardVersionMismatch is silent for source checkouts and in-memory DBs, forceable via env', () => {
  const env = { HOME: tmpdir(), SCHEDULER_DB: join(tmpdir(), 'x', 'scheduler.db') };
  assert.equal(guardVersionMismatch({ env }), null, 'source checkout must not trip the guard');
  assert.equal(guardVersionMismatch({ env: { ...env, SCHEDULER_DB: ':memory:' } }), null, 'in-memory DB must not trip the guard');
  const forced = guardVersionMismatch({ env: { ...env, SCHEDULER_VERSION_GUARD_FORCE: '1' } });
  assert.equal(forced.status, 'unknown', 'forced guard from a checkout reports the daemon record state');
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

test('cli doctor reports version mismatch, exits 1, and names both versions and paths', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
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
});

test('cli doctor --no-version-guard reports the mismatch without exiting 1', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
  const result = runCli(['doctor', '--no-version-guard', '--json'], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.version_guard.status, 'mismatch');
  assert.equal(payload.version_guard.skipped, true);
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

test('dispatch enqueue fails loudly on mismatch; list stays available', t => {
  const home = fixtureHome(t);
  writeDaemonVersion(home, '0.5.0');
  const env = cliEnv(home);

  const enqueued = runDispatch(['enqueue', '--label', 'vg-guard-probe', '--message', 'probe', '--deliver-to', '123456789'], env);
  assert.equal(enqueued.status, 1, enqueued.stderr);
  assert.match(enqueued.stderr, /version mismatch/i);
  assert.match(enqueued.stderr, /0\.5\.0/);
  assert.match(enqueued.stderr, /daemon-version\.json/);
  assert.match(enqueued.stderr, /kickstart/);

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

test('dispatcher writes daemon-version.json on startup and refreshes it if deleted', async t => {
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
  const child = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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
  let record = null;
  while (Date.now() < deadline) {
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
});
