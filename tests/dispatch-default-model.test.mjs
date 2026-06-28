import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveDefaultDispatchModel,
  resolveOpenClawDispatchDefaultModel,
  STATIC_DISPATCH_DEFAULT_MODEL,
} from '../dispatch/default-model.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const INDEX_PATH = join(REPO_DIR, 'dispatch', 'index.mjs');

function buildFixture(openClawConfig) {
  const tmpBase = mkdtempSync(join(tmpdir(), 'dispatch-default-model-'));
  const configDir = join(tmpBase, 'dispatch-config');
  const binDir = join(tmpBase, 'bin');
  const callsPath = join(tmpBase, 'openclaw-calls.jsonl');
  const openclawPath = join(binDir, 'openclaw');
  const openclawConfigDir = join(tmpBase, '.openclaw');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(openclawConfigDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ name: 'dispatch-test' }, null, 2));
  writeFileSync(join(tmpBase, 'labels.json'), '{}\n');
  writeFileSync(join(openclawConfigDir, 'openclaw.json'), JSON.stringify(openClawConfig, null, 2));

  const stubSource = [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const path = require('path');",
    'const args = process.argv.slice(2);',
    "const paramsIdx = args.indexOf('--params');",
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    "const params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : null;",
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, params }) + '\\n');`,
    "if (method === 'sessions.patch' && params && params.key) {",
    "  const sessionsDir = path.join(process.env.HOME, '.openclaw', 'agents', 'main', 'sessions');",
    "  const sessionsPath = path.join(sessionsDir, 'sessions.json');",
    "  fs.mkdirSync(sessionsDir, { recursive: true });",
    "  let store = {};",
    "  try { store = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')); } catch {}",
    "  store[params.key] = { ...(store[params.key] || {}), sessionId: 'session-test', updatedAt: Date.now(), startedAt: Date.now() };",
    "  fs.writeFileSync(sessionsPath, JSON.stringify(store));",
    "}",
    "process.stdout.write(method === 'agent' ? JSON.stringify({ ok: true, runId: 'run-test' }) : '{}');",
    '',
  ].join('\n');
  writeFileSync(openclawPath, stubSource);
  chmodSync(openclawPath, 0o755);

  return { tmpBase, configDir, binDir, callsPath, labelsPath: join(tmpBase, 'labels.json') };
}

function readCalls(callsPath) {
  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runDispatchWithConfig(openClawConfig) {
  const fixture = buildFixture(openClawConfig);
  try {
    const run = spawnSync(
      process.execPath,
      [
        INDEX_PATH,
        'enqueue',
        '--label',
        'model-default',
        '--message',
        'Run a tiny smoke task.',
        '--origin',
        'system',
        '--timeout',
        '300',
        '--delivery-mode',
        'none',
        '--no-monitor',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fixture.tmpBase,
          DISPATCH_CONFIG_DIR: fixture.configDir,
          DISPATCH_LABELS_PATH: fixture.labelsPath,
          PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
          OPENCLAW_GATEWAY_TOKEN: '',
          OPENCLAW_CONFIG_PATH: join(fixture.tmpBase, '.openclaw', 'openclaw.json'),
          DISPATCH_DEFAULT_MODEL: '',
        },
        timeout: 45_000,
      },
    );
    return { ...run, calls: readCalls(fixture.callsPath) };
  } finally {
    rmSync(fixture.tmpBase, { recursive: true, force: true });
  }
}

test('resolveDefaultDispatchModel preserves wrapper and env precedence', () => {
  const openClawConfig = {
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-5.5' },
        dispatch: { model: 'kebab-rtx6000/qwen3.6-27b' },
      },
    },
  };

  assert.equal(
    resolveDefaultDispatchModel({
      dispatchConfig: { defaultModel: 'wrapper/model' },
      env: { DISPATCH_DEFAULT_MODEL: 'env/model' },
      openClawConfig,
    }),
    'wrapper/model',
  );
  assert.equal(
    resolveDefaultDispatchModel({
      dispatchConfig: {},
      env: { DISPATCH_DEFAULT_MODEL: 'env/model' },
      openClawConfig,
    }),
    'env/model',
  );
  assert.equal(
    resolveDefaultDispatchModel({
      dispatchConfig: { dispatch: { model: { primary: 'wrapper-dispatch/model' } } },
      env: { DISPATCH_DEFAULT_MODEL: 'env/model' },
      openClawConfig,
    }),
    'wrapper-dispatch/model',
  );
});

test('resolveOpenClawDispatchDefaultModel uses dispatch model before legacy model', () => {
  assert.equal(
    resolveOpenClawDispatchDefaultModel({
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-5.5' },
          dispatch: { model: { primary: 'kebab-rtx6000/qwen3.6-27b' } },
        },
      },
    }),
    'kebab-rtx6000/qwen3.6-27b',
  );
  assert.equal(
    resolveOpenClawDispatchDefaultModel({
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-5.5' },
        },
      },
    }),
    'openai/gpt-5.5',
  );
  assert.equal(
    resolveDefaultDispatchModel({ dispatchConfig: {}, env: {}, openClawConfig: {} }),
    STATIC_DISPATCH_DEFAULT_MODEL,
  );
});

test('dispatch enqueue patches configured dispatch default model when --model is omitted', () => {
  const result = runDispatchWithConfig({
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-5.5' },
        dispatch: { model: { primary: 'kebab-rtx6000/qwen3.6-27b' } },
      },
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const modelPatch = result.calls.find((call) => call.method === 'sessions.patch' && call.params?.model);
  assert.equal(modelPatch?.params?.model, 'kebab-rtx6000/qwen3.6-27b');
});

test('dispatch enqueue falls back to legacy agents.defaults.model when dispatch model is unset', () => {
  const result = runDispatchWithConfig({
    agents: {
      defaults: {
        model: { primary: 'kebab-rtx6000/qwen3.6-27b' },
      },
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const modelPatch = result.calls.find((call) => call.method === 'sessions.patch' && call.params?.model);
  assert.equal(modelPatch?.params?.model, 'kebab-rtx6000/qwen3.6-27b');
});
