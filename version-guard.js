// Version guard: detect when the CLI copy and the daemon/service copy of
// openclaw-scheduler run different versions.
//
// Background (2026-10-18 incident): a deploy updated only the launchd service
// copy; the global CLI copy stayed two versions behind. `enqueue` builds the
// completion template from the CLI copy, so every dispatch rendered with the
// old template and nobody noticed for 8 days. The daemon now writes its own
// version to $SCHEDULER_HOME/daemon-version.json at startup; the CLI compares
// it against its own version and fails loudly on mismatch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DAEMON_VERSION_FILE_NAME = 'daemon-version.json';

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
export function resolveVersionGuardHome(env = process.env) {
  const explicit = firstNonEmpty(env.SCHEDULER_HOME) || firstNonEmpty(env.OPENCLAW_SCHEDULER_HOME);
  if (explicit) return explicit;
  const home = firstNonEmpty(env.HOME) || process.env.USERPROFILE || '';
  if (home) return join(home, '.openclaw', 'scheduler');
  return '';
}

export function resolveDaemonVersionPath(env = process.env) {
  const home = resolveVersionGuardHome(env);
  return home ? join(home, DAEMON_VERSION_FILE_NAME) : null;
}

export function writeDaemonVersionFile({
  version,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const path = resolveDaemonVersionPath(env);
  if (!path) return null;
  const record = {
    version: String(version),
    written_at: now().toISOString(),
    pid: process.pid,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
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

export function compareVersions({
  cliVersion,
  daemonVersion,
  cliPath,
  daemonPath,
  command = 'this command',
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
        + 'service (launchctl kickstart -k ai.openclaw.scheduler) if it is running.',
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
  return {
    status: 'mismatch',
    cliVersion,
    daemonVersion,
    cliPath,
    daemonPath,
    message: `scheduler version mismatch: CLI ${cliVersion} (${cliPath}) vs daemon ${daemonVersion} `
      + `(recorded at ${daemonPath}). Refusing to run ${command}: the two copies must be the same version, `
      + 'because dispatch completion templates and behavior are built from the CLI copy. '
      + `Upgrade the copy that is behind (npm install openclaw-scheduler@<matching-version> `
      + 'into the other install), then restart the service with '
      + '`launchctl kickstart -k ai.openclaw.scheduler` and re-run `openclaw-scheduler doctor`. '
      + 'Set SCHEDULER_VERSION_GUARD=1 to downgrade this failure to a warning while remediating.',
  };
}

// Returns null when the guard must not run (dev checkout / in-memory test DB /
// no home resolvable). Otherwise returns the compareVersions() result.
export function guardVersionMismatch({
  moduleDir = __dirname,
  env = process.env,
  command = 'this command',
} = {}) {
  if (env.SCHEDULER_DB === ':memory:') return null;
  // Source checkouts do not trip the guard by default (developers work against
  // the deployed daemon, not a sibling copy). SCHEDULER_VERSION_GUARD_FORCE
  // (any value) forces the check on -- used by tests and by operators who want
  // to verify the guard from a checkout.
  if (!isNodeModulesInstall(moduleDir) && !firstNonEmpty(env.SCHEDULER_VERSION_GUARD_FORCE)) return null;
  const cliVersion = readPackageVersion(moduleDir);
  const cliPath = join(moduleDir, 'package.json');
  const daemonVersionFile = readDaemonVersionFile(env);
  return compareVersions({
    cliVersion,
    daemonVersion: daemonVersionFile ? daemonVersionFile.version : null,
    cliPath,
    daemonPath: daemonVersionFile ? daemonVersionFile.path : resolveDaemonVersionPath(env),
    command,
  });
}

export function guardWarningLine(guard) {
  return guard.status === 'mismatch'
    ? `ERROR: ${guard.message}`
    : `Warning: ${guard.message}`;
}
