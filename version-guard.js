// Version guard: detect when the CLI copy and the daemon/service copy of
// openclaw-scheduler run different versions.
//
// Background (2026-10-18 incident): a deploy updated only the launchd service
// copy; the global CLI copy stayed two versions behind. `enqueue` builds the
// completion template from the CLI copy, so every dispatch rendered with the
// old template and nobody noticed for 8 days. The daemon now writes its own
// version to $SCHEDULER_HOME/daemon-version.json at startup (only after it
// has acquired the dispatcher lease); the CLI compares it against its own
// version and fails loudly on mismatch.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { assertContainedPath } from './identifiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DAEMON_VERSION_FILE_NAME = 'daemon-version.json';

// The daemon refreshes the record at most once per minute. A record older
// than the refresh interval plus this tolerance belongs to a daemon that is
// no longer writing: treat it as unknown (stopped), never as a match.
export const DAEMON_RECORD_STALE_MS = 2 * 60 * 1000;

function firstNonEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

export function isNodeModulesInstall(moduleDir) {
  return /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?openclaw-scheduler(?:[\\/]|$)/.test(moduleDir);
}

export function readPackageVersion(moduleDir = __dirname) {
  const pkg = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8'));
  return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
}

// The daemon (dispatcher.js) and the CLI (paths.js) resolve the scheduler home
// from different env vars; accept both so a guard check and the daemon writer
// always agree on the file location.
//
// The value comes from the environment, so it is validated before use: it
// must be an absolute path, and the final version-file path must stay inside
// it (rejects `../` traversal and relative values). An invalid value makes
// the guard a no-op rather than touching an unexpected file.
export function resolveVersionGuardHome(env = process.env) {
  const explicit = firstNonEmpty(env.SCHEDULER_HOME) || firstNonEmpty(env.OPENCLAW_SCHEDULER_HOME);
  if (explicit) {
    if (!isAbsolute(explicit)) return '';
    const root = resolve(explicit);
    if (root === '/') return '';
    return root;
  }
  const home = firstNonEmpty(env.HOME) || firstNonEmpty(env.USERPROFILE) || '';
  if (!home || !isAbsolute(home)) return '';
  const root = resolve(home);
  if (root === '/') return '';
  return resolve(join(root, '.openclaw', 'scheduler'));
}

// The version file must stay inside the home directory. assertContainedPath
// (the repo's CodeQL-recognized sanitizer, also used by dispatch/paths.mjs)
// proves containment lexically and after symlink canonicalization, throwing
// on escape; a throw makes the guard a no-op rather than touching a path
// outside the scheduler home.
export function resolveDaemonVersionPath(env = process.env) {
  const home = resolveVersionGuardHome(env);
  if (!home) return null;
  const path = join(home, DAEMON_VERSION_FILE_NAME);
  try {
    return assertContainedPath(home, path, 'daemon version file');
  } catch {
    return null;
  }
}

// Atomic write: a temp file in the same directory, then rename over the
// record. A concurrent reader sees either the complete old or the complete
// new JSON, never a truncated/partial file.
export function writeDaemonVersionFile({
  version,
  env = process.env,
  now = () => new Date(),
  packagePath = __dirname,
} = {}) {
  const path = resolveDaemonVersionPath(env);
  if (!path) return null;
  const record = {
    version: String(version),
    written_at: now().toISOString(),
    pid: process.pid,
    package_path: packagePath,
  };
  const dir = dirname(path);
  // codeql[disable] js/path-injection
  // path is env-derived (SCHEDULER_HOME/HOME) but validated by
  // resolveDaemonVersionPath -> assertContainedPath (resolve + containment
  // after symlink canonicalization); the env and the local filesystem are the
  // same trust domain for this single-user CLI/daemon. Same class as the
  // accepted open js/path-injection baseline (jobs.js, session-store.mjs).
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${DAEMON_VERSION_FILE_NAME}.${process.pid}.tmp`);
  try {
    // codeql[disable] js/path-injection
    writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`);
    // codeql[disable] js/path-injection
    renameSync(tmpPath, path);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best effort */ }
    throw err;
  }
  return path;
}

// POSIX liveness probe: kill(pid, 0) throws ESRCH when the process is gone.
// EPERM means the process exists but belongs to another user. On Windows the
// probe is unsupported and reports unknown instead of a false negative.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

// A record is stale when it is older than the refresh interval plus
// tolerance, or when the recorded daemon PID is provably dead. Stale records
// are treated as "daemon stopped / unknown", never as a version match.
export function isDaemonRecordStale(record, { now = () => new Date() } = {}) {
  if (!record || typeof record !== 'object') return true;
  const writtenAt = Date.parse(record.written_at);
  if (!Number.isFinite(writtenAt)) return true;
  if (now().getTime() - writtenAt > DAEMON_RECORD_STALE_MS) return true;
  if (typeof record.pid === 'number') {
    const alive = isPidAlive(record.pid);
    if (alive === false) return true;
  }
  return false;
}

export function readDaemonVersionFile(env = process.env) {
  const path = resolveDaemonVersionPath(env);
  if (!path || !existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!record || typeof record !== 'object' || typeof record.version !== 'string') return null;
    return { ...record, path };
  } catch {
    return null;
  }
}

// Platform-appropriate restart remediation. The README documents launchd on
// macOS and `systemctl --user restart openclaw-scheduler` on Linux/WSL2;
// anything else gets neutral wording.
export function daemonRestartInstruction(platform = process.platform) {
  if (platform === 'darwin') {
    return 'launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler';
  }
  if (platform === 'linux') {
    return 'systemctl --user restart openclaw-scheduler';
  }
  return 'your platform service manager (launchd on macOS, systemd on Linux)';
}

export function compareVersions({
  cliVersion,
  daemonVersion,
  cliPath,
  daemonPath,
  daemonRecord = null,
  command = 'this command',
  platform = process.platform,
  now = () => new Date(),
}) {
  if (daemonVersion === null) {
    return {
      status: 'unknown',
      cliVersion,
      daemonVersion: null,
      cliPath,
      daemonPath,
      message: `scheduler version guard: no daemon version record at ${daemonPath}. `
        + 'The dispatcher daemon may be stopped, or it is an older version that does not write '
        + DAEMON_VERSION_FILE_NAME + '. Run `openclaw-scheduler doctor` to inspect; restart the '
        + `service (${daemonRestartInstruction(platform)}) if it is running.`,
    };
  }
  if (daemonRecord && isDaemonRecordStale(daemonRecord, { now })) {
    return {
      status: 'unknown',
      cliVersion,
      daemonVersion: null,
      cliPath,
      daemonPath,
      message: `scheduler version guard: the daemon version record at ${daemonPath} is stale `
        + `(written ${daemonRecord.written_at ?? 'at an unparseable time'} by pid ${daemonRecord.pid ?? 'unknown'}); `
        + 'the dispatcher daemon is not refreshing it, so it is treated as stopped. Run `openclaw-scheduler doctor` '
        + `to inspect; restart the service (${daemonRestartInstruction(platform)}) if it should be running.`,
    };
  }
  if (daemonVersion === cliVersion) {
    return {
      status: 'match',
      cliVersion,
      daemonVersion,
      cliPath,
      daemonPath,
      message: null,
    };
  }
  const recordedDaemonPath = typeof daemonRecord?.package_path === 'string' && daemonRecord.package_path.length > 0
    ? `; daemon install ${daemonRecord.package_path}`
    : '';
  return {
    status: 'mismatch',
    cliVersion,
    daemonVersion,
    cliPath,
    daemonPath,
    message: `scheduler version mismatch: CLI ${cliVersion} (${cliPath}) vs daemon ${daemonVersion} `
      + `(recorded at ${daemonPath}${recordedDaemonPath}). Refusing to run ${command}: the two copies must be the same version, `
      + 'because dispatch completion templates and behavior are built from the CLI copy. '
      + `Upgrade the copy that is behind (npm install openclaw-scheduler@<matching-version> `
      + 'into the other install), then restart the service with '
      + `\`${daemonRestartInstruction(platform)}\` and re-run \`openclaw-scheduler doctor\`. `
      + 'Set SCHEDULER_VERSION_GUARD=1 to downgrade this failure to a warning while remediating.',
  };
}

// Returns null when the guard must not run (in-memory test DB, explicit
// dev/test opt-out, no home resolvable). Otherwise returns the
// compareVersions() result.
//
// Production installs keep the guard ENABLED by default, including the
// documented git-clone layouts (~/.openclaw/scheduler, npm global, pnpm).
// Development and test checkouts opt out explicitly with
// SCHEDULER_VERSION_GUARD_DEV (any value): developers work against the
// deployed daemon, not a sibling copy. SCHEDULER_VERSION_GUARD_FORCE is kept
// as a no-op alias of the default (enabled) behavior for existing docs.
export function guardVersionMismatch({
  moduleDir = __dirname,
  env = process.env,
  command = 'this command',
  platform = process.platform,
  now = () => new Date(),
} = {}) {
  if (env.SCHEDULER_DB === ':memory:') return null;
  if (firstNonEmpty(env.SCHEDULER_VERSION_GUARD_DEV)) return null;
  const cliVersion = readPackageVersion(moduleDir);
  const cliPath = join(moduleDir, 'package.json');
  const daemonVersionFile = readDaemonVersionFile(env);
  return compareVersions({
    cliVersion,
    daemonVersion: daemonVersionFile ? daemonVersionFile.version : null,
    cliPath,
    daemonPath: daemonVersionFile ? daemonVersionFile.path : resolveDaemonVersionPath(env),
    daemonRecord: daemonVersionFile,
    command,
    platform,
    now,
  });
}

export function guardWarningLine(guard) {
  return guard.status === 'mismatch'
    ? `ERROR: ${guard.message}`
    : `Warning: ${guard.message}`;
}
