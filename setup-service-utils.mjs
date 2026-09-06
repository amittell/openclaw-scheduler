import { isAbsolute } from 'node:path';

const NPM_CONFIG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SYSTEMD_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const MACOS_INSTALL_PATH = '/usr/bin/install';
export const MACOS_LAUNCHCTL_PATH = '/bin/launchctl';
export const MACOS_SUDO_PATH = '/usr/bin/sudo';
export const MACOS_CHMOD_PATH = '/bin/chmod';
export const MACOS_PLUTIL_PATH = '/usr/bin/plutil';

function describeCodePoint(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function assertString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  assertString(value, label);
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function assertArgvString(value, label) {
  assertString(value, label);
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`);
  return value;
}

/** Reject values that cannot be represented safely in launchd or systemd service files. */
export function assertSafeServiceValue(value, label = 'service value') {
  assertString(value, label);
  const controlCharacter = Array.from(value).find((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (controlCharacter) {
    throw new Error(`${label} contains unsupported control character ${describeCodePoint(controlCharacter)}`);
  }
  return value;
}

/** Encode one XML text node after rejecting characters forbidden in service values. */
export function encodeLaunchdPlistValue(value, label = 'launchd value') {
  return assertSafeServiceValue(value, label)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Use only the public CLI entry explicitly supplied by installation configuration. */
export function configuredOpenClawCliPath(env = process.env) {
  const value = env.OPENCLAW_CLI_PATH ?? '';
  assertSafeServiceValue(value, 'OPENCLAW_CLI_PATH');
  if (value && !isAbsolute(value)) throw new Error('OPENCLAW_CLI_PATH must be an absolute public CLI path');
  return value;
}

export function renderLaunchdCliEnvironment(cliPath = '') {
  const value = configuredOpenClawCliPath({ OPENCLAW_CLI_PATH: cliPath });
  return value
    ? `    <key>OPENCLAW_CLI_PATH</key>\n    <string>${encodeLaunchdPlistValue(value, 'OPENCLAW_CLI_PATH')}</string>\n`
    : '';
}

/** Update only the configured CLI key; plutil preserves all other plist values. */
export function updateLaunchdCliPath({ plistPath, cliPath = '', runCommand, asRoot = false }) {
  const value = configuredOpenClawCliPath({ OPENCLAW_CLI_PATH: cliPath });
  if (!value) return false;
  assertSafeServiceValue(plistPath, 'launchd plist path');
  if (!isAbsolute(plistPath)) throw new Error('launchd plist path must be absolute');
  const plutil = args => runCommand(
    asRoot ? MACOS_SUDO_PATH : MACOS_PLUTIL_PATH,
    asRoot ? ['--', MACOS_PLUTIL_PATH, ...args] : args,
    { encoding: 'utf8' },
  );
  // Read only this dictionary, so unrelated plist date/data values need no JSON conversion.
  const environment = JSON.parse(plutil([
    '-extract', 'EnvironmentVariables', 'json', '-expect', 'dictionary', '-o', '-', '--', plistPath,
  ]));
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('launchd EnvironmentVariables must be a dictionary');
  }
  if (environment.OPENCLAW_CLI_PATH === value) return false;
  plutil([
    Object.hasOwn(environment, 'OPENCLAW_CLI_PATH') ? '-replace' : '-insert',
    'EnvironmentVariables.OPENCLAW_CLI_PATH', '-string', value, '--', plistPath,
  ]);
  return true;
}

function encodeSystemdQuotedItem(value, label, { escapeDollar = false } = {}) {
  let encoded = assertSafeServiceValue(value, label);
  // systemd.syntax requires every literal backslash to be doubled. Escape
  // quotes only after that transformation so an input backslash followed by a
  // quote round-trips as two distinct characters.
  encoded = encoded.replaceAll('\\', '\\\\');
  encoded = encoded.replaceAll('"', '\\"');
  // Most service directives perform specifier expansion, where %% is the
  // documented representation of one literal percent sign.
  encoded = encoded.replaceAll('%', '%%');
  // ExecStart additionally expands $ variables. $$ preserves a literal dollar.
  if (escapeDollar) encoded = encoded.replaceAll('$', () => '$$');
  return `"${encoded}"`;
}

/** Encode one quoted systemd directive value while preserving its runtime value. */
export function encodeSystemdValue(value, label = 'systemd value') {
  return encodeSystemdQuotedItem(value, label);
}

/** Encode one ExecStart argv item, including literal dollar preservation. */
export function encodeSystemdExecArgument(value, label = 'systemd ExecStart argument') {
  return encodeSystemdQuotedItem(value, label, { escapeDollar: true });
}

/** Encode a complete Environment= assignment as one quoted systemd item. */
export function encodeSystemdEnvironmentAssignment(key, value) {
  if (!SYSTEMD_ENVIRONMENT_KEY_PATTERN.test(assertString(key, 'systemd environment key'))) {
    throw new Error(`Invalid systemd environment key: ${key}`);
  }
  return encodeSystemdValue(`${key}=${assertSafeServiceValue(value, `systemd environment ${key}`)}`);
}

/** Render the complete user service without exposing operator values to unit-file syntax. */
export function renderSystemdUserService({
  workingDirectory,
  nodePath,
  indexPath,
  gatewayUrl,
  gatewayToken = '',
  schedulerDbPath,
  logPath,
}) {
  const requiredValues = {
    workingDirectory,
    nodePath,
    indexPath,
    gatewayUrl,
    schedulerDbPath,
    logPath,
  };
  for (const [name, value] of Object.entries(requiredValues)) {
    assertNonEmptyString(value, name);
    assertSafeServiceValue(value, name);
  }
  assertSafeServiceValue(gatewayToken, 'gatewayToken');

  const environmentLines = [
    `Environment=${encodeSystemdEnvironmentAssignment('OPENCLAW_GATEWAY_URL', gatewayUrl)}`,
    ...(gatewayToken
      ? [`Environment=${encodeSystemdEnvironmentAssignment('OPENCLAW_GATEWAY_TOKEN', gatewayToken)}`]
      : []),
    `Environment=${encodeSystemdEnvironmentAssignment('SCHEDULER_DB', schedulerDbPath)}`,
  ];
  const execStart = [nodePath, '--no-warnings', indexPath]
    .map((value, index) => encodeSystemdExecArgument(value, `ExecStart argument ${index}`))
    .join(' ');

  return `[Unit]
Description=OpenClaw Scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory=${encodeSystemdValue(workingDirectory, 'WorkingDirectory')}
ExecStart=${execStart}
${environmentLines.join('\n')}
Restart=always
RestartSec=5
StandardOutput=${encodeSystemdValue(`append:${logPath}`, 'StandardOutput')}
StandardError=${encodeSystemdValue(`append:${logPath}`, 'StandardError')}

[Install]
WantedBy=default.target
`;
}

/** Build a runner around execFileSync and force shell-free argv execution. */
export function createSetupCommandRunner(execFileSyncImpl) {
  if (typeof execFileSyncImpl !== 'function') {
    throw new TypeError('execFileSync implementation must be a function');
  }
  return (command, args = [], options = {}) => {
    assertNonEmptyString(command, 'command');
    assertArgvString(command, 'command');
    if (!Array.isArray(args)) throw new TypeError('command args must be an array');
    const safeArgs = args.map((arg, index) => assertArgvString(arg, `command arg ${index}`));
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('command options must be an object');
    }
    return execFileSyncImpl(command, safeArgs, { ...options, shell: false });
  };
}

export function buildNpmConfigGetArgs(key) {
  if (!NPM_CONFIG_KEY_PATTERN.test(assertString(key, 'npm config key'))) {
    throw new Error(`Invalid npm config key: ${key}`);
  }
  return ['config', 'get', key];
}

export function buildLaunchctlBootstrapArgs(domain, plistPath) {
  return [
    'bootstrap',
    assertNonEmptyString(domain, 'launchd domain'),
    assertNonEmptyString(plistPath, 'launchd plist path'),
  ];
}

export function buildSudoInstallArgs(sourcePath, destinationPath) {
  const source = assertNonEmptyString(sourcePath, 'install source path');
  const destination = assertNonEmptyString(destinationPath, 'install destination path');
  if (!isAbsolute(source) || !isAbsolute(destination)) {
    throw new Error('install source and destination paths must be absolute');
  }
  return [
    '--',
    MACOS_INSTALL_PATH,
    '-o', 'root',
    '-g', 'wheel',
    '-m', '0600',
    source,
    destination,
  ];
}

export function buildSudoChmodPrivateArgs(targetPath) {
  const target = assertNonEmptyString(targetPath, 'chmod target path');
  if (!isAbsolute(target)) throw new Error('chmod target path must be absolute');
  return ['--', MACOS_CHMOD_PATH, '0600', target];
}

export function buildSudoLaunchctlBootstrapArgs(domain, plistPath) {
  return [
    '--',
    MACOS_LAUNCHCTL_PATH,
    ...buildLaunchctlBootstrapArgs(domain, plistPath),
  ];
}

export function buildPm2StartArgs({ indexPath, processName, workingDirectory, logPath }) {
  return [
    'start', assertNonEmptyString(indexPath, 'PM2 index path'),
    '--name', assertNonEmptyString(processName, 'PM2 process name'),
    '--cwd', assertNonEmptyString(workingDirectory, 'PM2 working directory'),
    '--log', assertNonEmptyString(logPath, 'PM2 log path'),
  ];
}

/** Format an explicitly intended POSIX shell command with every argv item isolated. */
export function formatPosixCommand(command, args = []) {
  assertNonEmptyString(command, 'command');
  if (!Array.isArray(args)) throw new TypeError('command args must be an array');
  const quote = (value, label) => `'${assertArgvString(value, label).replaceAll("'", `'"'"'`)}'`;
  return [quote(command, 'command'), ...args.map((arg, index) => quote(arg, `command arg ${index}`))].join(' ');
}
