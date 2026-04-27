import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');

function buildFixture() {
  const tmpBase = mkdtempSync(join(tmpdir(), 'dispatch-msgsafe-'));
  const labelsPath = join(tmpBase, 'labels.json');
  const configDir = join(tmpBase, 'config');
  const binDir = join(tmpBase, 'bin');
  const callsPath = join(tmpBase, 'openclaw-calls.jsonl');
  const openclawPath = join(binDir, 'openclaw');
  const sessionsDir = join(tmpBase, '.openclaw', 'agents', 'main', 'sessions');
  const sessionKey = 'agent:main:subagent:literal-safe-test';

  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'dispatch-test' }, null, 2));
  writeFileSync(labelsPath, JSON.stringify({}) + '\n');
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
    [sessionKey]: {
      sessionId: 'session-literal-safe-test',
      updatedAt: Date.now(),
      totalTokens: 1,
    },
  }) + '\n');

  const stubSource = [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const paramsIdx = args.indexOf('--params');",
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    "const params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : null;",
    `const callsPath = ${JSON.stringify(callsPath)};`,
    "fs.appendFileSync(callsPath, JSON.stringify({ args, method, params }) + '\\n');",
    "if (method === 'agent') {",
    "  process.stdout.write(JSON.stringify({ ok: true, runId: 'run-test' }));",
    '} else {',
    "  process.stdout.write('{}');",
    '}',
    '',
  ].join('\n');
  writeFileSync(openclawPath, stubSource);
  chmodSync(openclawPath, 0o755);

  return { tmpBase, labelsPath, configDir, binDir, callsPath, sessionKey };
}

function readCalls(callsPath) {
  try {
    return readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function runDispatchWithStub({ subcommand, args = [], env = {}, input } = {}) {
  const fixture = buildFixture();
  try {
    const effectiveArgs = subcommand === 'enqueue' && !args.includes('--session-key')
      ? [...args, '--session-key', fixture.sessionKey]
      : args;

    const run = spawnSync(
      process.execPath,
      [INDEX_PATH, subcommand, ...effectiveArgs],
      {
        encoding: 'utf8',
        ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : {}),
        input,
        env: {
          ...process.env,
          HOME: fixture.tmpBase,
          DISPATCH_CONFIG_DIR: fixture.configDir,
          DISPATCH_LABELS_PATH: fixture.labelsPath,
          PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
          OPENCLAW_GATEWAY_TOKEN: '',
          ...env,
        },
        timeout: 30_000,
      },
    );

    const labels = JSON.parse(readFileSync(fixture.labelsPath, 'utf8'));
    const calls = readCalls(fixture.callsPath);
    const agentCall = calls.find(call => call.method === 'agent')?.params || null;
    return { ...run, labels, calls, agentCall };
  } finally {
    rmSync(fixture.tmpBase, { recursive: true, force: true });
  }
}

function runShellDispatchWithStub({ shellScript }) {
  const fixture = buildFixture();
  try {
    const run = spawnSync('zsh', ['-fc', shellScript], {
      cwd: REPO_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fixture.tmpBase,
        DISPATCH_CONFIG_DIR: fixture.configDir,
        DISPATCH_LABELS_PATH: fixture.labelsPath,
        PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
        OPENCLAW_GATEWAY_TOKEN: '',
      },
      timeout: 30_000,
    });

    const labels = JSON.parse(readFileSync(fixture.labelsPath, 'utf8'));
    const calls = readCalls(fixture.callsPath);
    const agentCall = calls.find(call => call.method === 'agent')?.params || null;
    return { ...run, labels, calls, agentCall };
  } finally {
    rmSync(fixture.tmpBase, { recursive: true, force: true });
  }
}

test('dispatch enqueue/send accept literal-safe prompt sources without executing shell text', () => {
  const sideEffectDir = mkdtempSync(join(tmpdir(), 'dispatch-msgsafe-sideeffects-'));
  try {
    const markerBacktick = join(sideEffectDir, 'backtick-ran');
    const markerDollar = join(sideEffectDir, 'dollar-ran');
    const hazardPayload = [
      `Literal backticks: \`touch ${markerBacktick}\``,
      `Single quote: ' and double quote: " and parens: (keep me literal)`,
      `Command substitution: $(touch ${markerDollar})`,
      'Technical details: keep this marker literal, not treated as a footer.',
      'Inline code: `npm test && git push` should stay literal.',
    ].join('\n');

    {
      const result = runDispatchWithStub({
        subcommand: 'enqueue',
        args: [
          '--label', 'literal-env',
          '--message-env', 'PROMPT_PAYLOAD',
          '--origin', 'system',
          '--timeout', '300',
          '--delivery-mode', 'none',
          '--no-monitor',
        ],
        env: { PROMPT_PAYLOAD: hazardPayload },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /"label":\s*"literal-env"/);
      assert.equal(result.stderr, '', 'env prompt path stays quiet');
      assert.ok(result.agentCall?.message?.includes(hazardPayload), 'env payload embedded literally in gateway task');
      assert.equal(result.labels['literal-env']?.taskPrompt, hazardPayload, 'env payload stored literally');
    }

    {
      const promptFile = join(sideEffectDir, 'literal-prompt.md');
      const filePayload = `${hazardPayload}\n`;
      writeFileSync(promptFile, filePayload);
      const result = runDispatchWithStub({
        subcommand: 'enqueue',
        args: [
          '--label', 'literal-file',
          '--message-file', promptFile,
          '--origin', 'system',
          '--timeout', '300',
          '--delivery-mode', 'none',
          '--no-monitor',
        ],
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '', 'file prompt path stays quiet');
      assert.ok(result.agentCall?.message?.includes(filePayload), 'file payload preserves trailing newline in gateway task');
      assert.equal(result.labels['literal-file']?.taskPrompt, filePayload, 'file payload stored without trimming');
    }

    {
      const result = runDispatchWithStub({
        subcommand: 'enqueue',
        args: [
          '--label', 'literal-stdin',
          '--message-stdin',
          '--origin', 'system',
          '--timeout', '300',
          '--delivery-mode', 'none',
          '--no-monitor',
        ],
        input: hazardPayload,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '', 'explicit stdin prompt path stays quiet');
      assert.ok(result.agentCall?.message?.includes(hazardPayload), 'stdin payload preserved literally in gateway task');
    }

    {
      const result = runDispatchWithStub({
        subcommand: 'enqueue',
        args: [
          '--label', 'literal-auto-stdin',
          '--origin', 'system',
          '--timeout', '300',
          '--delivery-mode', 'none',
          '--no-monitor',
        ],
        input: hazardPayload,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '', 'auto-stdin prompt path stays quiet');
      assert.ok(result.agentCall?.message?.includes(hazardPayload), 'auto-read stdin preserves payload literally');
    }

    {
      const result = runDispatchWithStub({
        subcommand: 'send',
        args: [
          '--session-key', 'agent:main:subagent:test',
          '--message-env', 'PROMPT_PAYLOAD',
        ],
        env: { PROMPT_PAYLOAD: hazardPayload },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '', 'send env prompt path stays quiet');
      assert.equal(result.agentCall?.message, hazardPayload, 'send preserves literal env payload');
    }

    {
      const result = runDispatchWithStub({
        subcommand: 'enqueue',
        args: [
          '--label', 'literal-conflict',
          '--message', 'inline',
          '--message-env', 'PROMPT_PAYLOAD',
          '--origin', 'system',
          '--timeout', '300',
          '--delivery-mode', 'none',
          '--no-monitor',
        ],
        env: { PROMPT_PAYLOAD: hazardPayload },
      });
      assert.equal(result.status, 2, 'conflicting prompt sources are rejected');
      assert.match(result.stderr, /choose only one of --message, --message-env/, 'conflict error names both prompt sources');
    }

    assert.equal(existsSync(markerBacktick), false, 'backticks remain literal');
    assert.equal(existsSync(markerDollar), false, 'command substitution remains literal');
  } finally {
    rmSync(sideEffectDir, { recursive: true, force: true });
  }
});

test('dispatch recommended stdin path stays quiet under zsh while enqueue still succeeds', () => {
  const sideEffectDir = mkdtempSync(join(tmpdir(), 'dispatch-msgsafe-shell-sideeffects-'));
  try {
    const markerBacktick = join(sideEffectDir, 'backtick-ran');
    const markerDollar = join(sideEffectDir, 'dollar-ran');
    const hazardPayload = [
      `Literal backticks: \`touch ${markerBacktick}\``,
      `Single quote: ' and double quote: " and parens: (keep me literal)`,
      `Command substitution: $(touch ${markerDollar})`,
      'Technical details: keep this marker literal, not treated as a footer.',
    ].join('\n');

    const shellScript = `cat <<'PROMPT' | "${process.execPath}" "${INDEX_PATH}" enqueue --label literal-shell --message-stdin --origin system --timeout 300 --delivery-mode none --no-monitor --session-key agent:main:subagent:literal-safe-test\n${hazardPayload}\nPROMPT`;
    const result = runShellDispatchWithStub({ shellScript });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '', 'safe stdin shell invocation emits no shell warnings');
    assert.match(result.stdout, /"label":\s*"literal-shell"/);
    assert.ok(result.agentCall?.message?.includes(hazardPayload), 'safe stdin shell invocation still enqueues the literal payload');
    assert.equal(existsSync(markerBacktick), false, 'shell path keeps backticks literal');
    assert.equal(existsSync(markerDollar), false, 'shell path keeps command substitution literal');
  } finally {
    rmSync(sideEffectDir, { recursive: true, force: true });
  }
});
