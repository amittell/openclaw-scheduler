import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MACOS_CHMOD_PATH,
  MACOS_INSTALL_PATH,
  MACOS_LAUNCHCTL_PATH,
  MACOS_SUDO_PATH,
  assertSafeServiceValue,
  buildLaunchctlBootstrapArgs,
  buildNpmConfigGetArgs,
  buildPm2StartArgs,
  buildSudoChmodPrivateArgs,
  buildSudoInstallArgs,
  buildSudoLaunchctlBootstrapArgs,
  createSetupCommandRunner,
  encodeLaunchdPlistValue,
  encodeSystemdEnvironmentAssignment,
  encodeSystemdExecArgument,
  encodeSystemdValue,
  formatPosixCommand,
  renderSystemdUserService,
} from '../setup-service-utils.mjs';

const METACHAR_VALUE = String.raw`/tmp/Open Claw;$(printf injected)&"'\\release/%n/$HOME/[x]`;

function decodeSystemdQuotedItem(encoded, { execArgument = false } = {}) {
  assert.equal(encoded[0], '"');
  assert.equal(encoded.at(-1), '"');
  const body = encoded.slice(1, -1);
  let decoded = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = body[index + 1];
    assert.ok(escaped === '\\' || escaped === '"', `unexpected escape: \\${escaped}`);
    decoded += escaped;
    index += 1;
  }
  decoded = decoded.replaceAll('%%', () => '%');
  if (execArgument) decoded = decoded.replaceAll('$$', () => '$');
  return decoded;
}

function directiveValue(unit, name) {
  const prefix = `${name}=`;
  const line = unit.split('\n').find(candidate => candidate.startsWith(prefix));
  assert.ok(line, `missing ${name} directive`);
  return line.slice(prefix.length);
}

test('setup command runner preserves metacharacter-heavy argv and always disables a shell', () => {
  const calls = [];
  const runner = createSetupCommandRunner((command, args, options) => {
    calls.push({ command, args, options });
    return 'captured';
  });
  const args = ['start', METACHAR_VALUE, '--name', 'scheduler;still-one-arg'];
  const env = { TEST_VALUE: METACHAR_VALUE };

  assert.equal(runner('pm2', args, { encoding: 'utf8', env, shell: true }), 'captured');
  assert.deepEqual(calls, [{
    command: 'pm2',
    args,
    options: { encoding: 'utf8', env, shell: false },
  }]);
  assert.notEqual(calls[0].args, args);
  assert.throws(() => runner('pm2', ['ok', 'bad\0arg']), /NUL/);
  assert.throws(() => runner('bad\0command'), /NUL/);
  assert.throws(() => runner('pm2', 'not-an-array'), /must be an array/);
  assert.throws(() => createSetupCommandRunner(null), /must be a function/);
});

test('command builders keep operator values in discrete argv entries', () => {
  assert.deepEqual(buildNpmConfigGetArgs('ignore-scripts'), ['config', 'get', 'ignore-scripts']);
  assert.throws(() => buildNpmConfigGetArgs('ignore-scripts;touch'), /Invalid npm config key/);
  assert.throws(() => buildNpmConfigGetArgs('--global'), /Invalid npm config key/);

  const plistPath = `${METACHAR_VALUE}.plist`;
  assert.deepEqual(
    buildLaunchctlBootstrapArgs('gui/501', plistPath),
    ['bootstrap', 'gui/501', plistPath],
  );
  assert.deepEqual(
    buildSudoInstallArgs('/tmp/--source;$(printf injected)', plistPath),
    [
      '--', MACOS_INSTALL_PATH,
      '-o', 'root', '-g', 'wheel', '-m', '0600',
      '/tmp/--source;$(printf injected)', plistPath,
    ],
  );
  assert.throws(
    () => buildSudoInstallArgs('--source', plistPath),
    /must be absolute/,
  );
  assert.deepEqual(
    buildSudoChmodPrivateArgs(plistPath),
    ['--', MACOS_CHMOD_PATH, '0600', plistPath],
  );
  assert.throws(() => buildSudoChmodPrivateArgs('--target'), /must be absolute/);
  assert.deepEqual(
    buildSudoLaunchctlBootstrapArgs('system', plistPath),
    ['--', MACOS_LAUNCHCTL_PATH, 'bootstrap', 'system', plistPath],
  );
  assert.deepEqual(
    buildPm2StartArgs({
      indexPath: `${METACHAR_VALUE}/dispatcher.js`,
      processName: 'openclaw-scheduler',
      workingDirectory: METACHAR_VALUE,
      logPath: `${METACHAR_VALUE}.log`,
    }),
    [
      'start', `${METACHAR_VALUE}/dispatcher.js`,
      '--name', 'openclaw-scheduler',
      '--cwd', METACHAR_VALUE,
      '--log', `${METACHAR_VALUE}.log`,
    ],
  );
  assert.equal(MACOS_SUDO_PATH, '/usr/bin/sudo');
});

test('POSIX command formatting round-trips argv without interpreting metacharacters', {
  skip: process.platform === 'win32',
}, () => {
  const expected = [METACHAR_VALUE, "single'quote", '', '--option-looking-value'];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const command = formatPosixCommand(process.execPath, ['-e', script, '--', ...expected]);
  const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), expected);
});

test('systemd encoders preserve backslashes, quotes, percent specifiers, and dollars', () => {
  const value = String.raw`C:\Open Claw\path\"quoted"\literal\n%h/$HOME;$(printf injected)`;
  const encodedValue = encodeSystemdValue(value);
  const encodedExecArgument = encodeSystemdExecArgument(value);

  assert.equal(decodeSystemdQuotedItem(encodedValue), value);
  assert.equal(decodeSystemdQuotedItem(encodedExecArgument, { execArgument: true }), value);
  assert.ok(encodedValue.includes('\\\\'));
  assert.ok(encodedValue.includes('\\"'));
  assert.ok(encodedValue.includes('%%h'));
  assert.ok(encodedValue.includes('$HOME'));
  assert.ok(encodedExecArgument.includes('$$HOME'));

  const url = String.raw`https://gateway.example/a%2Fb?q="quoted"&path=C:\Open Claw\$HOME`;
  const assignment = encodeSystemdEnvironmentAssignment('OPENCLAW_GATEWAY_URL', url);
  assert.equal(decodeSystemdQuotedItem(assignment), `OPENCLAW_GATEWAY_URL=${url}`);
  assert.throws(
    () => encodeSystemdEnvironmentAssignment('INVALID-KEY', url),
    /Invalid systemd environment key/,
  );
});

test('service encoders reject line breaks, NUL, and non-printable control characters', () => {
  const controls = ['\0', '\r', '\n', '\t', '\u0001', '\u001f', '\u007f', '\u0085', '\u009f'];
  for (const control of controls) {
    const value = `safe${control}injected`;
    assert.throws(() => assertSafeServiceValue(value, 'test value'), /control character U\+/);
    assert.throws(() => encodeSystemdValue(value), /control character U\+/);
    assert.throws(() => encodeLaunchdPlistValue(value), /control character U\+/);
  }
  assert.equal(assertSafeServiceValue(String.raw`literal\nsequence`), String.raw`literal\nsequence`);
});

test('launchd XML encoding rejects controls and escapes markup without changing other characters', () => {
  const value = String.raw`A&B<C>D"E'F\G;%n$HOME`;
  assert.equal(
    encodeLaunchdPlistValue(value),
    String.raw`A&amp;B&lt;C&gt;D&quot;E&apos;F\G;%n$HOME`,
  );
});

test('systemd service rendering round-trips every operator-controlled field', () => {
  const values = {
    workingDirectory: `${METACHAR_VALUE}/work%20dir`,
    nodePath: `${METACHAR_VALUE}/bin/node$runtime`,
    indexPath: `${METACHAR_VALUE}/dispatcher.js`,
    gatewayUrl: String.raw`https://gateway.example/a%2Fb?q="quoted"&path=C:\Open Claw\$HOME`,
    gatewayToken: String.raw`token\"value%h$literal`,
    schedulerDbPath: `${METACHAR_VALUE}/scheduler.db`,
    logPath: `${METACHAR_VALUE}/scheduler.log`,
  };
  const unit = renderSystemdUserService(values);

  assert.equal(decodeSystemdQuotedItem(directiveValue(unit, 'WorkingDirectory')), values.workingDirectory);
  assert.equal(
    decodeSystemdQuotedItem(directiveValue(unit, 'StandardOutput')),
    `append:${values.logPath}`,
  );
  assert.equal(
    decodeSystemdQuotedItem(directiveValue(unit, 'StandardError')),
    `append:${values.logPath}`,
  );

  const execItems = directiveValue(unit, 'ExecStart').match(/"(?:\\.|[^"\\])*"/gu);
  assert.ok(execItems);
  assert.deepEqual(
    execItems.map(item => decodeSystemdQuotedItem(item, { execArgument: true })),
    [values.nodePath, '--no-warnings', values.indexPath],
  );

  const environment = unit.split('\n')
    .filter(line => line.startsWith('Environment='))
    .map(line => decodeSystemdQuotedItem(line.slice('Environment='.length)));
  assert.deepEqual(environment, [
    `OPENCLAW_GATEWAY_URL=${values.gatewayUrl}`,
    `OPENCLAW_GATEWAY_TOKEN=${values.gatewayToken}`,
    `SCHEDULER_DB=${values.schedulerDbPath}`,
  ]);
  assert.ok(unit.includes('%%20'));
  assert.ok(directiveValue(unit, 'ExecStart').includes('$$runtime'));

  const withoutToken = renderSystemdUserService({ ...values, gatewayToken: '' });
  assert.ok(!withoutToken.includes('OPENCLAW_GATEWAY_TOKEN'));
});

test('systemd service rendering fails closed for controls in every dynamic field', () => {
  const base = {
    workingDirectory: '/srv/openclaw scheduler',
    nodePath: '/usr/bin/node',
    indexPath: '/srv/openclaw scheduler/dispatcher.js',
    gatewayUrl: 'http://127.0.0.1:18789',
    gatewayToken: 'token',
    schedulerDbPath: '/srv/openclaw scheduler/scheduler.db',
    logPath: '/tmp/openclaw scheduler.log',
  };
  for (const field of Object.keys(base)) {
    assert.throws(
      () => renderSystemdUserService({ ...base, [field]: `${base[field]}\nInjected=owned` }),
      new RegExp(field),
    );
  }
});

test('setup source contains no shell-based child process execution', () => {
  const source = readFileSync(new URL('../setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bexecSync\b/u);
  assert.match(source, /createSetupCommandRunner\(execFileSync\)/u);
  assert.doesNotMatch(source, /`pm2 start /u);
  assert.doesNotMatch(source, /execFileSync\s*\(\s*`/u);
  assert.match(source, /parseGatewayBaseUrl\(candidate, 'Gateway URL'\)/u);
  assert.match(
    source,
    /writeFileSync\(service\.plistPath, plist, \{ mode: 0o600 \}\)/u,
  );
  assert.match(source, /chmodSync\(service\.plistPath, 0o600\)/u);
  assert.match(source, /buildSudoChmodPrivateArgs\(service\.plistPath\)/u);
});
