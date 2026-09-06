import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_INJECT_CAPABILITY = 'chat-completions-env-inject-v1';

let mode = 'capable';
let server;
let gatewayUrl;
let gateway;
let executeAgent;
let originalGatewayUrl;
let originalGatewayToken;
let originalGatewayTokenPath;
let originalNodeEnv;
let calls = [];

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function handleInfo(_request, response) {
  if (mode === 'legacy') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>OpenClaw</title>');
    return;
  }
  if (mode === 'health-capable') {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
    return;
  }
  if (mode === 'malformed') {
    sendJson(response, 200, { version: 42, capabilities: 'not-an-array' });
    return;
  }
  if (mode === 'unsupported') {
    sendJson(response, 200, {
      version: '2026.7.10',
      protocol: 4,
      capabilities: ['chat-send-routing-contract'],
    });
    return;
  }
  sendJson(response, 200, {
    version: '2026.7.11',
    protocol: 4,
    capabilities: [ENV_INJECT_CAPABILITY, 'chat-send-routing-contract'],
  });
}

function handleHealth(_request, response) {
  if (mode === 'health-capable') {
    sendJson(response, 200, {
      server: { version: '2026.7.11-health' },
      protocol: 4,
      features: { capabilities: [ENV_INJECT_CAPABILITY] },
    });
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('OK');
}

before(async () => {
  originalGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  originalGatewayTokenPath = process.env.OPENCLAW_GATEWAY_TOKEN_PATH;
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    calls.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body,
    });

    if (request.method === 'GET' && request.url === '/v1/info') {
      handleInfo(request, response);
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      handleHealth(request, response);
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      sendJson(
        response,
        200,
        {
          choices: [{ message: { content: 'stub gateway response' } }],
          usage: { total_tokens: 2 },
        },
        { 'x-openclaw-session-key': 'agent:main:stub-session' },
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  gatewayUrl = `http://127.0.0.1:${address.port}`;
  process.env.OPENCLAW_GATEWAY_URL = gatewayUrl;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'stub-gateway-token';
  gateway = await import(`../gateway.js?v04-gateway=${Date.now()}`);
  ({ executeAgent } = await import('../dispatcher-strategies.js'));
});

after(async () => {
  gateway?.clearGatewayCapabilityCache();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  if (originalGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
  else process.env.OPENCLAW_GATEWAY_URL = originalGatewayUrl;
  if (originalGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
  if (originalGatewayTokenPath === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN_PATH;
  else process.env.OPENCLAW_GATEWAY_TOKEN_PATH = originalGatewayTokenPath;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test('Gateway token-file rotation is observed without restarting the dispatcher', async () => {
  const tokenDir = mkdtempSync(join(tmpdir(), 'scheduler-gateway-token-'));
  const tokenPath = join(tokenDir, 'gateway-token');
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousTokenPath = process.env.OPENCLAW_GATEWAY_TOKEN_PATH;
  try {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN_PATH = tokenPath;
    writeFileSync(tokenPath, 'rotating-token-one\n');
    calls = [];
    await gateway.checkGatewayHealth();
    writeFileSync(tokenPath, 'rotating-token-two\n');
    await gateway.checkGatewayHealth();
    const healthCalls = calls.filter(call => call.path === '/health');
    assert.equal(healthCalls[0].headers.authorization, 'Bearer rotating-token-one');
    assert.equal(healthCalls[1].headers.authorization, 'Bearer rotating-token-two');
  } finally {
    if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    if (previousTokenPath === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN_PATH;
    else process.env.OPENCLAW_GATEWAY_TOKEN_PATH = previousTokenPath;
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

test('Gateway token paths reject files and symlink targets outside credential roots', () => {
  const tokenDir = mkdtempSync(join(tmpdir(), 'scheduler-gateway-token-path-'));
  const allowedPath = join(tokenDir, 'gateway-token');
  const escapedPath = join(tokenDir, 'escaped-token');
  try {
    writeFileSync(allowedPath, 'allowed-token\n');
    symlinkSync('/etc/passwd', escapedPath);
    assert.equal(gateway.resolveGatewayTokenPath(allowedPath), realpathSync(allowedPath));
    assert.equal(gateway.resolveGatewayTokenPath('/etc/passwd'), null);
    assert.equal(gateway.resolveGatewayTokenPath(escapedPath), null);
  } finally {
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

test('Gateway token paths reject a symlinked user credential root', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'scheduler-gateway-home-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'scheduler-gateway-outside-'));
  const tokenPath = join(outsideRoot, 'gateway-token');
  const previousHome = process.env.HOME;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    mkdirSync(join(fakeHome, '.openclaw'));
    symlinkSync(outsideRoot, join(fakeHome, '.openclaw', 'credentials'));
    writeFileSync(tokenPath, 'outside-token\n');
    process.env.HOME = fakeHome;
    process.env.NODE_ENV = 'production';
    assert.equal(gateway.resolveGatewayTokenPath(tokenPath), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

function reset(nextMode) {
  mode = nextMode;
  calls = [];
  gateway.clearGatewayCapabilityCache(gatewayUrl);
}

function callsFor(path) {
  return calls.filter(call => call.path === path);
}

function makeAgentStrategyDeps(runIsolatedAgentTurn) {
  return {
    waitForGateway: async () => true,
    updateRunSession: () => {},
    setAgentStatus: () => {},
    buildJobPrompt: () => ({ prompt: 'perform governed work', contextMeta: {} }),
    updateContextSummary: () => {},
    matchesSentinel: () => false,
    detectTransientError: () => false,
    sqliteNow: () => 'next-dispatch',
    log: () => {},
    syncAuthStoreToSession: () => {
      throw new Error('agent strategy must not copy Gateway credential stores');
    },
    prepareAgentSelection: async (_key, overrides) => ({ ok: true, applied: Boolean(overrides.authProfile), model: overrides.modelRef || undefined }),
    runIsolatedAgentTurn,
  };
}

test('Gateway owns auth synchronization without scheduler credential-file copies', () => {
  assert.deepEqual(gateway.syncAuthStoreToSession('main'), {
    ok: true,
    skipped: true,
    reason: 'gateway-managed-auth',
  });
  assert.deepEqual(gateway.syncAuthStoreToSession('secondary'), {
    ok: true,
    skipped: true,
    reason: 'gateway-managed-auth',
  });
  assert.deepEqual(gateway.syncAuthStoreToSession(''), {
    ok: false,
    error: 'agentId must be a non-empty string',
  });
});

async function assertRejectsWithCode(promise, code) {
  let rejected;
  await assert.rejects(promise, err => {
    rejected = err;
    return err instanceof gateway.GatewayCompatibilityError && err.code === code;
  });
  return rejected;
}

test('capable Gateway receives validated credentials and revalidates before each credential-bearing request', async () => {
  reset('capable');
  assert.equal(gateway.GATEWAY_ENV_INJECT_CAPABILITY, ENV_INJECT_CAPABILITY);

  const first = await gateway.runAgentTurn({
    message: 'use the scoped credential',
    agentId: 'main',
    sessionKey: 'agent:main:stub-one',
    materializedEnv: { STRIPE_API_KEY: 'secret-one' },
    timeoutMs: 2_000,
  });
  assert.equal(first.content, 'stub gateway response');
  const discovered = await gateway.discoverGatewayCapabilities({ gatewayUrl });
  assert.deepEqual(discovered, {
    version: '2026.7.11',
    protocol: 4,
    capabilities: [ENV_INJECT_CAPABILITY, 'chat-send-routing-contract'],
    source: '/v1/info',
    legacy: false,
  });

  await gateway.runAgentTurnWithActivityTimeout({
    message: 'reuse discovery cache',
    agentId: 'main',
    sessionKey: 'agent:main:stub-two',
    materializedEnv: { STRIPE_API_KEY: 'secret-two' },
    pollIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    absoluteTimeoutMs: 2_000,
  });

  assert.equal(callsFor('/v1/info').length, 2);
  assert.equal(callsFor('/health').length, 0);
  assert.equal(callsFor('/v1/chat/completions').length, 2);
  const chatCalls = callsFor('/v1/chat/completions');
  for (const [index, call] of chatCalls.entries()) {
    assert.equal(call.headers.authorization, 'Bearer stub-gateway-token');
    assert.equal(call.headers['x-openclaw-auth-profile'], undefined);
    assert.deepEqual(JSON.parse(call.headers['x-openclaw-env-inject']), {
      STRIPE_API_KEY: index === 0 ? 'secret-one' : 'secret-two',
    });
  }
});

test('structured health metadata is accepted as an authoritative compatibility fallback', async () => {
  reset('health-capable');
  await gateway.runAgentTurn({
    message: 'health capability fallback',
    materializedEnv: { SCOPED_TOKEN: 'health-secret' },
    timeoutMs: 2_000,
  });
  assert.equal(callsFor('/v1/info').length, 1);
  assert.equal(callsFor('/health').length, 1);
  assert.equal(callsFor('/v1/chat/completions').length, 1);
});

test('legacy Gateway does not treat unauthenticated WebSocket metadata as a capability contract', async () => {
  reset('legacy');
  const discovered = await gateway.discoverGatewayCapabilities({
    gatewayUrl,
    forceRefresh: true,
    requestHeaders: { Authorization: 'Bearer stub-gateway-token' },
    webSocketFactory: class FabricatedCapabilitySocket {
      constructor() {
        throw new Error('must not be used');
      }
    },
  });

  assert.deepEqual(discovered, {
    version: null,
    protocol: null,
    capabilities: [],
    source: '/health',
    legacy: true,
  });
});

test('a Gateway restart or downgrade invalidates a previously positive capability result', async () => {
  reset('capable');
  await gateway.runAgentTurn({
    message: 'first credential-bearing request',
    materializedEnv: { PRIVATE_TOKEN: 'first' },
    timeoutMs: 2_000,
  });
  assert.equal(callsFor('/v1/chat/completions').length, 1);

  mode = 'unsupported';
  const error = await assertRejectsWithCode(
    gateway.runAgentTurn({
      message: 'must revalidate after receiver downgrade',
      materializedEnv: { PRIVATE_TOKEN: 'second' },
      timeoutMs: 2_000,
    }),
    'GATEWAY_ENV_INJECT_UNSUPPORTED',
  );
  assert.equal(error.gatewayVersion, '2026.7.10');
  assert.equal(callsFor('/v1/info').length, 2);
  assert.equal(callsFor('/v1/chat/completions').length, 1);
});

test('direct profiles are rejected even without environment injection', async () => {
  reset('legacy');
  await assert.rejects(gateway.runAgentTurn({ message: 'unprepared profile', authProfile: 'provider:legacy-compatible' }), /prepareAgentSelection/);
  assert.equal(callsFor('/v1/chat/completions').length, 0);
});

test('legacy Gateway fails closed when materialized credentials require injection', async () => {
  reset('legacy');
  const error = await assertRejectsWithCode(
    gateway.runAgentTurn({
      message: 'must not run without credentials',
      materializedEnv: { PRIVATE_TOKEN: 'must-not-leak' },
      timeoutMs: 2_000,
    }),
    'GATEWAY_ENV_INJECT_UNSUPPORTED',
  );

  assert.equal(error.legacyGateway, true);
  assert.equal(error.requiredCapability, ENV_INJECT_CAPABILITY);
  assert.doesNotMatch(error.message, /must-not-leak/);
  assert.equal(callsFor('/v1/info').length, 1);
  assert.equal(callsFor('/health').length, 1);
  assert.equal(callsFor('/v1/chat/completions').length, 0);
});

test('explicitly unsupported Gateway fails closed with version diagnostics', async () => {
  reset('unsupported');
  const error = await assertRejectsWithCode(
    gateway.runIsolatedAgentTurn({
      message: 'requires receiver support',
      materializedEnv: { PRIVATE_TOKEN: 'scoped' },
      pollIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
      absoluteTimeoutMs: 2_000,
    }),
    'GATEWAY_ENV_INJECT_UNSUPPORTED',
  );

  assert.equal(error.gatewayVersion, '2026.7.10');
  assert.deepEqual(error.gatewayCapabilities, ['chat-send-routing-contract']);
  assert.equal(callsFor('/health').length, 0);
  assert.equal(callsFor('/v1/chat/completions').length, 0);
});

test('malformed capability metadata is rejected before credential-bearing dispatch', async () => {
  reset('malformed');
  const error = await assertRejectsWithCode(
    gateway.runAgentTurn({
      message: 'reject malformed metadata',
      materializedEnv: { PRIVATE_TOKEN: 'scoped' },
      timeoutMs: 2_000,
    }),
    'GATEWAY_CAPABILITY_DISCOVERY_INVALID',
  );

  assert.equal(error.source, '/v1/info');
  assert.equal(callsFor('/v1/chat/completions').length, 0);
});

test('invalid env maps throw instead of silently dropping requested credentials', async () => {
  reset('capable');
  const invalidInputs = [
    ['array', ['secret']],
    ['non-string value', { TOKEN: 123 }],
    ['unsafe key', { 'TOKEN-NAME': 'secret' }],
    ['NUL value', { TOKEN: 'before\0after' }],
    ['Node preload', { NODE_OPTIONS: '--require=/tmp/inject.js' }],
    ['Gateway control secret', { OPENCLAW_GATEWAY_TOKEN: 'replace-master-token' }],
    ['runtime path override', { PATH: '/tmp/attacker-bin' }],
  ];

  for (const [label, materializedEnv] of invalidInputs) {
    const error = await assertRejectsWithCode(
      gateway.runAgentTurn({ message: label, materializedEnv, timeoutMs: 2_000 }),
      'GATEWAY_ENV_INJECT_INVALID',
    );
    assert.match(error.message, /Invalid materialized environment/);
  }
  assert.equal(calls.length, 0);
});

test('oversized env headers are rejected locally before discovery or dispatch', async () => {
  reset('capable');
  const error = await assertRejectsWithCode(
    gateway.runAgentTurn({
      message: 'reject oversized env',
      materializedEnv: {
        TOKEN_ONE: 'a'.repeat(4_000),
        TOKEN_TWO: 'b'.repeat(4_000),
      },
      timeoutMs: 2_000,
    }),
    'GATEWAY_ENV_INJECT_TOO_LARGE',
  );

  assert.ok(error.headerBytes > gateway.MAX_GATEWAY_ENV_INJECT_HEADER_BYTES);
  assert.equal(calls.length, 0);
});

test('agent strategy forwards materialized env and does not selection-retry compatibility failures', async () => {
  const materializedEnv = { SCOPED_TOKEN: 'strategy-secret' };
  const forwarded = [];
  const job = {
    id: 'gateway-v04-strategy',
    payload_model: 'provider/model',
    name: 'Gateway v0.4 Strategy',
    agent_id: 'main',
    auth_profile: 'provider:primary',
    auth_profile_fallback: 'provider:fallback',
    payload_timeout_seconds: 120,
    run_timeout_ms: 2_000,
    delivery_mode: 'none',
  };
  const ctx = {
    run: { id: 'gateway-v04-run' },
    materializedEnv,
    v02Outcomes: {},
  };

  const result = await executeAgent(job, { ...ctx }, makeAgentStrategyDeps(async opts => {
    forwarded.push(opts);
    return { content: 'credential-aware result', usage: { total_tokens: 1 } };
  }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(forwarded[0].materializedEnv, materializedEnv);

  let attempts = 0;
  const compatibilityError = new gateway.GatewayCompatibilityError(
    'GATEWAY_ENV_INJECT_UNSUPPORTED',
    'stub Gateway cannot enforce credential injection',
  );
  await assert.rejects(
    executeAgent(job, { ...ctx }, makeAgentStrategyDeps(async () => {
      attempts++;
      throw compatibilityError;
    })),
    error => error === compatibilityError,
  );
  assert.equal(attempts, 1);
});

function selectionStrategyFixture({ job = {}, rejectPrimary = false, uncertainPrimary = false, failHttp = false, sessions = [], signal } = {}) {
  const preparations = [];
  const turns = [];
  const deps = makeAgentStrategyDeps(async opts => {
    turns.push(opts);
    if (failHttp && turns.length === 1) throw new Error('fixture primary turn failed');
    return { content: 'fixture completed', usage: { total_tokens: 1 } };
  });
  deps.listSessions = async () => ({ sessions });
  deps.prepareAgentSelection = (key, overrides, agentId, options) => gateway.prepareAgentSelection(key, overrides, agentId, {
    ...options, openclawCommand: '/owned/fixture/openclaw', gatewayToken: 'literal-fixture-token',
    execFile(_command, args, _options, callback) {
      const params = JSON.parse(args[args.indexOf('--params') + 1]);
      preparations.push(params);
      if (uncertainPrimary && preparations.length === 1) return callback(new Error('fixture timeout'), '{}');
      if (rejectPrimary && preparations.length === 1) return callback({ code: 1, signal: null, killed: false }, JSON.stringify({ ok: false, error: { type: 'gateway_request_error', code: 'INVALID_REQUEST', message: 'fixture rejection' } }));
      const delimiter = params.model.indexOf('@');
      const model = params.model.slice(0, delimiter);
      const slash = model.indexOf('/');
      callback(null, JSON.stringify({ ok: true, key: params.key, entry: {
        providerOverride: model.slice(0, slash), modelOverride: model.slice(slash + 1),
        authProfileOverride: params.model.slice(delimiter + 1), authProfileOverrideSource: 'user',
      } }));
    },
  });
  const input = { id: 'selection-fixture', name: 'selection fixture', agent_id: 'main',
    payload_model: 'vendor/primary', auth_profile: 'vendor:primary',
    payload_model_fallback: 'vendor/fallback', auth_profile_fallback: 'vendor:fallback',
    payload_timeout_seconds: 120, run_timeout_ms: 2000, delivery_mode: 'none', ...job };
  const run = () => executeAgent(input, { run: { id: 'selection-fixture-run' }, v02Outcomes: {}, abortSignal: signal }, deps);
  return { run, preparations, turns, deps };
}

test('definite preparation rejection permits one separately prepared fallback and no primary HTTP', async () => {
  const f = selectionStrategyFixture({ rejectPrimary: true });
  assert.equal((await f.run()).status, 'ok');
  assert.equal(f.preparations.length, 2);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].model, 'vendor/fallback');
  assert.equal(f.turns[0].authProfile, undefined);
});

test('uncertain preparation stops primary HTTP and configured fallback', async () => {
  const f = selectionStrategyFixture({ uncertainPrimary: true });
  await assert.rejects(f.run(), error => error.uncertain === true);
  assert.equal(f.preparations.length, 1);
  assert.equal(f.turns.length, 0);
});

test('accepted pin can be replaced explicitly, but omitted fallback auth cannot clear it', async () => {
  const replaced = selectionStrategyFixture({ failHttp: true });
  assert.equal((await replaced.run()).status, 'ok');
  assert.equal(replaced.preparations.length, 2);
  assert.equal(replaced.turns.length, 2);
  const clear = selectionStrategyFixture({ failHttp: true, job: { auth_profile_fallback: '' } });
  await assert.rejects(clear.run(), /cannot clear/);
  assert.equal(clear.preparations.length, 1);
  assert.equal(clear.turns.length, 1);
});

test('model-only attempts retain configured fallback without preparation RPC', async () => {
  const f = selectionStrategyFixture({ failHttp: true, job: { auth_profile: null, auth_profile_fallback: null } });
  assert.equal((await f.run()).status, 'ok');
  assert.equal(f.preparations.length, 0);
  assert.deepEqual(f.turns.map(turn => turn.model), ['vendor/primary', 'vendor/fallback']);
});

test('inherit chooses only the exact same-agent main key and resolution failure can use a valid fallback', async () => {
  const f = selectionStrategyFixture({ job: { auth_profile: 'inherit' }, sessions: [
    { key: 'agent:other:main', authProfileOverride: 'vendor:wrong' },
    { key: 'agent:main:main', authProfileOverride: 'vendor:right' },
  ] });
  await f.run();
  assert.equal(f.preparations[0].model, 'vendor/primary@vendor:right');
  const missing = selectionStrategyFixture({ job: { auth_profile: 'inherit' }, sessions: [{ key: 'agent:other:main', authProfileOverride: 'vendor:wrong' }] });
  await missing.run();
  assert.equal(missing.preparations.length, 1);
  assert.equal(missing.preparations[0].model, 'vendor/fallback@vendor:fallback');
});

test('cancellation, expired deadlines and identical fallback never produce an extra attempt', async () => {
  const controller = new AbortController(); controller.abort();
  const cancelled = selectionStrategyFixture({ signal: controller.signal });
  await assert.rejects(cancelled.run(), /cancelled/);
  assert.equal(cancelled.preparations.length, 0);
  assert.equal(cancelled.turns.length, 0);
  const expired = selectionStrategyFixture({ job: { run_timeout_ms: -1 } });
  await assert.rejects(expired.run(), /deadline/);
  assert.equal(expired.preparations.length, 0);
  const identical = selectionStrategyFixture({ rejectPrimary: true, job: { payload_model_fallback: 'vendor/primary', auth_profile_fallback: 'vendor:primary' } });
  await assert.rejects(identical.run(), /rejected/);
  assert.equal(identical.preparations.length, 1);
});


test('effective suffix and inherited equivalents cannot repeat preparation or HTTP', async () => {
  for (const primary of [
    { payload_model: 'vendor/model@work', auth_profile: null },
    { payload_model: 'vendor/model', auth_profile: 'inherit' },
  ]) {
    for (const rejection of [false, true]) {
      const f = selectionStrategyFixture({ failHttp: !rejection, rejectPrimary: rejection,
        job: { ...primary, payload_model_fallback: 'vendor/model', auth_profile_fallback: 'work' },
        sessions: [{ key: 'agent:other:main', authProfileOverride: 'wrong' },
          { key: 'agent:main:main', authProfileOverride: 'work' }] });
      await assert.rejects(f.run(), /already attempted/);
      assert.equal(f.preparations.length, 1);
      assert.equal(f.turns.length, rejection ? 0 : 1);
    }
  }
});

test('normalized routing aliases do not duplicate a model-only turn', async () => {
  const f = selectionStrategyFixture({ failHttp: true, job: { payload_model: 'openclaw:main',
    payload_model_fallback: 'agent:main', auth_profile: null, auth_profile_fallback: null } });
  await assert.rejects(f.run(), /already attempted/);
  assert.equal(f.preparations.length, 0);
  assert.equal(f.turns.length, 1);
});

test('same model with a different resolved profile remains a valid fallback', async () => {
  const f = selectionStrategyFixture({ failHttp: true, job: { payload_model: 'vendor/model@work',
    auth_profile: null, payload_model_fallback: 'vendor/model', auth_profile_fallback: 'backup' } });
  assert.equal((await f.run()).status, 'ok');
  assert.deepEqual(f.preparations.map(row => row.model), ['vendor/model@work', 'vendor/model@backup']);
  assert.equal(f.turns.length, 2);
});
