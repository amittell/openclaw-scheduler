import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MACOS_CHMOD_PATH,
  MACOS_INSTALL_PATH,
  MACOS_LAUNCHCTL_PATH,
  MACOS_PLUTIL_PATH,
  MACOS_SUDO_PATH,
  assertSafeServiceValue,
  buildLaunchctlBootstrapArgs,
  buildNpmConfigGetArgs,
  buildPm2StartArgs,
  buildSudoChmodPrivateArgs,
  buildSudoInstallArgs,
  buildSudoLaunchctlBootstrapArgs,
  configuredOpenClawCliPath,
  configureExistingLaunchdService,
  createSetupCommandRunner,
  encodeLaunchdPlistValue,
  encodeSystemdEnvironmentAssignment,
  encodeSystemdExecArgument,
  encodeSystemdValue,
  formatPosixCommand,
  renderLaunchdCliEnvironment,
  renderLaunchdServicePlist,
  renderSystemdUserService,
  updateLaunchdCliPath,
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
  assert.match(source, /const plist = renderLaunchdServicePlist\(\{/u);
  assert.match(source, /await configureExistingLaunchdService\(\{/u);
});


test('CLI installation configuration is explicit, absolute, and preserves literal path characters', () => {
  assert.equal(configuredOpenClawCliPath({}), '');
  assert.equal(configuredOpenClawCliPath({ OPENCLAW_CLI_PATH: '' }), '');
  assert.equal(configuredOpenClawCliPath({ OPENCLAW_CLI_PATH: METACHAR_VALUE }), METACHAR_VALUE);
  for (const value of ['openclaw', './openclaw', '~/openclaw', '/public/cli\nother', 42]) {
    assert.throws(() => configuredOpenClawCliPath({ OPENCLAW_CLI_PATH: value }), /absolute|control character|string/);
  }
  assert.equal(renderLaunchdCliEnvironment(''), '');
  let called = false;
  assert.equal(updateLaunchdCliPath({ runCommand: () => { called = true; } }), false);
  assert.throws(() => updateLaunchdCliPath({ cliPath: 'relative', runCommand: () => { called = true; } }), /absolute/);
  assert.equal(called, false);
});

function plistCommand(args, options = {}) {
  return execFileSync(MACOS_PLUTIL_PATH, args, { encoding: 'utf8', ...options });
}

function canonicalPlist(file) {
  return plistCommand(['-convert', 'xml1', '-o', '-', '--', file]);
}

function withoutCliNode(xml) {
  return xml.replace(/\t+<key>OPENCLAW_CLI_PATH<\/key>\n\t+<string>[^<]*<\/string>\n/u, '');
}

test('actual setup LaunchAgent and LaunchDaemon templates persist only the explicitly configured CLI entry', {
  skip: process.platform !== 'darwin',
}, () => {
  // Import the same inert renderer used by setup; never run the setup entrypoint.
  for (const mode of ['agent', 'daemon']) {
    const context = {
      service: { comment: 'fixture', label: 'fixture.scheduler' },
      serviceWorkingDirectory: '/fixture/work', nodePath: '/fixture/node', indexPath: '/fixture/dispatcher.js',
      homeDirectory: '/fixture/home', envPath: '/fixture/bin', gatewayUrl: 'http://fixture.invalid',
      schedulerDbPath: '/fixture/scheduler.db', logPath: '/fixture/log',
      tokenXml: '    <key>OPENCLAW_GATEWAY_TOKEN</key>\n    <string>fixture-secret-sentinel</string>\n',
      userXml: mode === 'daemon' ? '  <key>UserName</key>\n  <string>fixture-user</string>\n' : '',
    };
    const render = cliPath => JSON.parse(plistCommand(['-convert', 'json', '-o', '-', '--', '-'], {
      input: renderLaunchdServicePlist({ ...context, cliXml: renderLaunchdCliEnvironment(cliPath) }),
    }));
    const original = render('');
    const configured = render(METACHAR_VALUE);
    assert.equal(configured.EnvironmentVariables.OPENCLAW_CLI_PATH, METACHAR_VALUE);
    delete configured.EnvironmentVariables.OPENCLAW_CLI_PATH;
    assert.deepEqual(configured, original);
  }
});

test('native CLI plist updates preserve every unrelated XML/binary value, mode, and idempotent bytes', {
  skip: process.platform !== 'darwin',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-cli-'));
  try {
    for (const format of ['xml1', 'binary1']) {
      for (const prior of ['', '/fixture/old-cli']) {
        const file = join(directory, `${format}-${prior ? 'existing' : 'missing'}.plist`);
        writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>fixture.scheduler</string>
<key>ProgramArguments</key><array><string>/fixture/caffeinate</string><string>/fixture/node</string><string>/fixture/dispatcher.js</string></array>
<key>WorkingDirectory</key><string>/fixture/unchanged</string><key>KeepAlive</key><true/>
<key>CustomDate</key><date>2026-01-01T00:00:00Z</date><key>CustomData</key><data>AQID</data>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>/fixture/home</string>
<key>PATH</key><string>/fixture/bin</string><key>OPENCLAW_GATEWAY_TOKEN</key><string>fixture-secret-sentinel</string>
${renderLaunchdCliEnvironment(prior)}</dict></dict></plist>`, { mode: 0o640 });
        plistCommand(['-convert', format, '--', file]);
        const before = canonicalPlist(file);
        const beforeStat = statSync(file);
        const calls = [];
        const runner = createSetupCommandRunner((command, args, options) => {
          calls.push({ command, args });
          assert.equal(command, MACOS_PLUTIL_PATH);
          return execFileSync(command, args, options);
        });
        assert.equal(updateLaunchdCliPath({ plistPath: file, cliPath: METACHAR_VALUE, runCommand: runner }), true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].args[0], prior ? '-replace' : '-insert');
        assert.equal(withoutCliNode(canonicalPlist(file)), withoutCliNode(before));
        const afterStat = statSync(file);
        assert.deepEqual([afterStat.mode, afterStat.uid, afterStat.gid], [beforeStat.mode, beforeStat.uid, beforeStat.gid]);
        assert.equal(plistCommand(['-extract', 'EnvironmentVariables.OPENCLAW_CLI_PATH', 'raw', '-n', '--', file]), METACHAR_VALUE);
        const bytes = readFileSync(file);
        assert.equal(updateLaunchdCliPath({ plistPath: file, cliPath: METACHAR_VALUE, runCommand: runner }), false);
        assert.equal(calls.length, 3);
        assert.deepEqual(readFileSync(file), bytes);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('daemon CLI updates use sudo argv and refuse invalid plist environments without writing', () => {
  const calls = [];
  const runner = createSetupCommandRunner((command, args) => {
    calls.push({ command, args });
    return args.includes('-extract') ? '{"KEEP":"fixture-secret-sentinel"}' : '';
  });
  const plistPath = '/fixture/daemon file.plist';
  assert.equal(updateLaunchdCliPath({ plistPath, cliPath: METACHAR_VALUE, runCommand: runner, asRoot: true }), true);
  assert.deepEqual(calls[1], { command: MACOS_SUDO_PATH, args: [
    '--', MACOS_PLUTIL_PATH, '-insert', 'EnvironmentVariables.OPENCLAW_CLI_PATH', '-string', METACHAR_VALUE, '--', plistPath,
  ] });
  for (const response of ['[]', 'null', '"wrong-type"']) {
    let count = 0;
    assert.throws(() => updateLaunchdCliPath({ plistPath, cliPath: METACHAR_VALUE, runCommand: () => { count += 1; return response; } }), /dictionary/);
    assert.equal(count, 1);
  }
});

test('actual existing-service setup branch updates only after an explicit configured-path confirmation', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-cli-existing-'));
  try {
    for (const [cliPath, approve, expected, failRead = false] of [[METACHAR_VALUE, true, METACHAR_VALUE], [METACHAR_VALUE, false, '/fixture/old-cli'], ['', true, '/fixture/old-cli'], [METACHAR_VALUE, true, '/fixture/old-cli', true]]) {
      const file = join(directory, 'fixture.plist');
      writeFileSync(file, `<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>
<key>OPENCLAW_CLI_PATH</key><string>/fixture/old-cli</string><key>KEEP</key><string>fixture-secret-sentinel</string>
</dict><key>KeepAlive</key><true/></dict></plist>`, { mode: 0o600 });
      const before = canonicalPlist(file);
      const output = [];
      let commands = 0;
      const context = {
        service: { title: 'LaunchAgent', mode: 'agent', plistPath: file, domain: 'gui/501', label: 'fixture.scheduler' },
        openclawCliPath: cliPath, confirm: async () => approve,
        hardenExistingServiceFile: () => {},
        ok: text => output.push(text), skip: text => output.push(text), warn: text => output.push(text), print: text => output.push(text),
        runSetupCommand: createSetupCommandRunner((command, args, options) => {
          assert.equal(command, MACOS_PLUTIL_PATH, 'no service command is allowed in the existing-service branch');
          commands += 1;
          if (failRead) throw new Error('inert plist read failure');
          return execFileSync(command, args, options);
        }),
      };
      await configureExistingLaunchdService(context);
      assert.equal(plistCommand(['-extract', 'EnvironmentVariables.OPENCLAW_CLI_PATH', 'raw', '-n', '--', file]), expected);
      assert.equal(withoutCliNode(canonicalPlist(file)), withoutCliNode(before));
      assert.equal(commands, failRead ? 1 : (cliPath && approve ? 2 : 0));
      assert.ok(output.every(text => !text.includes('fixture-secret-sentinel')));
      if (cliPath && approve && !failRead) {
        assert.ok(output.some(text => text.includes('bootstrap')));
        assert.ok(output.every(text => !text.includes('kickstart')));
        // Confirm the same setting again before any service reload has occurred.
        const matchingBytes = readFileSync(file);
        commands = 0;
        output.length = 0;
        await configureExistingLaunchdService(context);
        assert.equal(commands, 1, 'matching configuration only reads the plist');
        assert.deepEqual(readFileSync(file), matchingBytes);
        assert.ok(output.some(text => text.includes('already matches')));
        assert.ok(output.some(text => text.includes('bootout')));
        assert.ok(output.some(text => text.includes('bootstrap')));
        assert.ok(output.every(text => !text.includes('kickstart')));
      } else {
        assert.ok(output.some(text => text.includes('kickstart')));
        assert.ok(output.every(text => !text.includes('bootstrap')));
        if (failRead) assert.ok(output.some(text => text.includes('inert plist read failure')));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
