import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentSelection, GatewayPreparationError } from '../gateway.js';
import { callGatewayPreparation } from '../dispatch/gateway-rpc.mjs';

const key = 'agent:main:scheduler:fixture';
const selection = { modelRef: 'vendor/model', authProfile: 'vendor:work' };
const receipt = (patch = {}) => ({ ok: true, key,
  entry: { providerOverride: 'vendor', modelOverride: 'model', authProfileOverride: 'vendor:work', authProfileOverrideSource: 'user' },
  resolved: { modelProvider: 'vendor', model: 'model' }, ...patch });
function fixture(response = receipt(), processError = null) {
  const calls = [];
  return { calls, options: { openclawCommand: '/owned/fixture/openclaw', gatewayToken: 'fixture-token',
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(processError, typeof response === 'string' ? response : JSON.stringify(response));
    } } };
}

test('model-only/default preparation performs no RPC; explicit route remains a route', async () => {
  const f = fixture();
  assert.deepEqual(await prepareAgentSelection(key, {}, 'main', f.options), { ok: true, applied: false, model: undefined });
  assert.deepEqual(await prepareAgentSelection(key, { modelRef: 'vendor/model' }, 'main', f.options), { ok: true, applied: false, model: 'vendor/model' });
  assert.equal((await prepareAgentSelection(key, { modelRef: 'openclaw:main' }, 'main', f.options)).applied, false);
  assert.equal(f.calls.length, 0);
});

test('real preparation binds canonical key, owner, model/profile, endpoint, CLI and secret environment', async () => {
  const f = fixture();
  assert.deepEqual(await prepareAgentSelection('scheduler:fixture', selection, 'main', f.options), {
    ok: true, applied: true, model: 'vendor/model', authProfile: 'vendor:work',
  });
  const call = f.calls[0];
  assert.equal(call.command, '/owned/fixture/openclaw');
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--params') + 1]), { key, agentId: 'main', model: 'vendor/model@vendor:work' });
  const expectedUrl = new URL(process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789');
  expectedUrl.protocol = expectedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  assert(!call.args.includes('--url'));
  assert.equal(call.options.env.OPENCLAW_GATEWAY_URL, expectedUrl.href);
  assert(!call.args.join(' ').includes('fixture-token'));
  assert.equal(call.options.env.OPENCLAW_GATEWAY_TOKEN, 'fixture-token');
});

test('suffix grammar preserves versions and quantizations; email profile IDs round trip', async () => {
  for (const model of ['model@20260101', 'model@q8_0', 'model@iq3_xxs']) {
    const f = fixture(receipt({ entry: { ...receipt().entry, modelOverride: model, authProfileOverride: 'vendor:user@example' } }));
    const result = await prepareAgentSelection(key, { modelRef: `vendor/${model}@vendor:user@example` }, 'main', f.options);
    assert.equal(result.model, `vendor/${model}`);
    assert.equal(result.authProfile, 'vendor:user@example');
  }
});

test('invalid, ambiguous, unowned and unresolved selections fail before any RPC', async () => {
  const f = fixture();
  for (const value of [
    { authProfile: 'vendor:work' }, { modelRef: 'model', authProfile: 'vendor:work' },
    { modelRef: 'openclaw:main', authProfile: 'vendor:work' },
    { modelRef: 'vendor/model', authProfile: 'inherit' },
    { modelRef: 'vendor/model@one', authProfile: 'two' },
    { modelRef: 'vendor/model', authProfile: 'profile/escape' },
    { modelRef: 'openclaw:ops.team' }, { modelRef: 'agent:user@example' },
    { modelRef: 'openclaw:other' },
  ]) await assert.rejects(prepareAgentSelection(key, value, 'main', f.options));
  await assert.rejects(prepareAgentSelection('agent:other:scheduler:fixture', selection, 'main', f.options));
  await assert.rejects(prepareAgentSelection(key, selection, '../escape', f.options));
  assert.equal(f.calls.length, 0);
});

test('definite RPC rejection differs from malformed, wrong-target, wrong-pin and wrong-model receipts', async () => {
  await assert.rejects(prepareAgentSelection(key, selection, 'main', fixture({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'fixture rejection' } }, { code: 1, signal: null, killed: false }).options),
    error => error instanceof GatewayPreparationError && !error.uncertain);
  for (const response of ['not json', {}, { ok: false, error: 'unclassified error' },
    { ok: false, error: { code: 'INVALID_REQUEST' } },
    { ok: false, error: { code: 'UNAVAILABLE' } }, receipt({ key: 'agent:other:scheduler:fixture' }),
    receipt({ entry: { ...receipt().entry, authProfileOverride: 'vendor:other' } }),
    receipt({ entry: { ...receipt().entry, modelOverride: 'other' } }),
  ]) await assert.rejects(prepareAgentSelection(key, selection, 'main', fixture(response).options), error => error.uncertain === true);
  await assert.rejects(prepareAgentSelection(key, selection, 'main', fixture(receipt(), new Error('process failed')).options), error => error.uncertain === true);
});

test('transport refuses PATH lookup, different scope fields, bad URL and pre-cancellation', async () => {
  const f = fixture();
  const params = { key, agentId: 'main', model: 'vendor/model@vendor:work' };
  const options = { ...f.options, gatewayUrl: 'https://gateway.example/prefix/' };
  for (const patch of [{ openclawCommand: 'openclaw' }, { gatewayUrl: 'https://user:pass@gateway.example' }, { timeout: 0 }, { gatewayToken: '' }]) {
    await assert.rejects(callGatewayPreparation(params, { ...options, ...patch }), error => !error.uncertain);
  }
  await assert.rejects(callGatewayPreparation({ ...params, permissionMode: 'full' }, options), error => !error.uncertain);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(callGatewayPreparation(params, { ...options, signal: controller.signal }), error => error.code === 'ABORT_ERR');
  assert.equal(f.calls.length, 0);
  await callGatewayPreparation(params, options);
  assert.equal(f.calls[0].options.env.OPENCLAW_GATEWAY_URL, 'wss://gateway.example/prefix/');
});

test('actual owned subprocess timeout, cancellation and nonzero success-looking output are uncertain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-preparation-control-'));
  const executable = join(dir, 'fixture-cli');
  const params = { key, agentId: 'main', model: 'vendor/model@vendor:work' };
  const options = { gatewayUrl: 'http://127.0.0.1:1', gatewayToken: 'literal-fixture-token', openclawCommand: executable };
  const program = body => { writeFileSync(executable, `#!${process.execPath}\n${body}\n`); chmodSync(executable, 0o700); };
  try {
    program(`console.log(${JSON.stringify(JSON.stringify(receipt()))}); process.exitCode = 1;`);
    await assert.rejects(callGatewayPreparation(params, { ...options, timeout: 2000 }), error => error.uncertain === true);
    program('setTimeout(() => {}, 30000);');
    await assert.rejects(callGatewayPreparation(params, { ...options, timeout: 50 }), error => error.uncertain === true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(callGatewayPreparation(params, { ...options, timeout: 2000, signal: controller.signal }), error => error.code === 'ABORT_ERR' && error.uncertain === true);
    } finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('typed rejections require a completed exit zero or exact exit one process', async () => {
  for (const code of ['INVALID_REQUEST', 'FORBIDDEN']) {
    const rejection = { ok: false, error: { type: 'gateway_request_error', code, message: 'fixture' } };
    for (const processError of [null, { code: 1, killed: false, signal: null }]) {
      await assert.rejects(prepareAgentSelection(key, selection, 'main', fixture(rejection, processError).options),
        error => error.code === 'GATEWAY_PREPARATION_REJECTED' && !error.uncertain);
    }
    for (const processError of [
      { code: 2, killed: false, signal: null }, { code: 1, killed: true, signal: null },
      { code: 1, killed: false, signal: 'SIGTERM' }, { code: 'ABORT_ERR' },
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, { code: 'ETIMEDOUT' }, { code: 1 },
    ]) await assert.rejects(prepareAgentSelection(key, selection, 'main', fixture(rejection, processError).options),
      error => error.uncertain === true);
  }
});

test('paired child URL/token replace ambient values and exclude ambient password', async () => {
  const f = fixture();
  const env = { OPENCLAW_GATEWAY_URL: 'ws://other.invalid', OPENCLAW_GATEWAY_TOKEN: 'ambient-token',
    OPENCLAW_GATEWAY_PASSWORD: 'ambient-password', PATH: '/owned/path' };
  await callGatewayPreparation({ key, agentId: 'main', model: 'vendor/model@vendor:work' }, {
    ...f.options, gatewayUrl: 'https://gateway.example/prefix/', env,
  });
  assert.equal(f.calls[0].options.env.OPENCLAW_GATEWAY_URL, 'wss://gateway.example/prefix/');
  assert.equal(f.calls[0].options.env.OPENCLAW_GATEWAY_TOKEN, 'fixture-token');
  assert.equal(f.calls[0].options.env.OPENCLAW_GATEWAY_PASSWORD, undefined);
  assert.equal(f.calls[0].options.env.PATH, '/owned/path');
  assert.equal(env.OPENCLAW_GATEWAY_PASSWORD, 'ambient-password');
  assert(!f.calls[0].args.includes('--url'));
});
