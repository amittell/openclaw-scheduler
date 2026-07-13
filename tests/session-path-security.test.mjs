import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeAgent } from '../dispatcher-strategies.js';
import {
  agentIdFromSessionKey,
  assertValidAgentId,
  assertValidSessionId,
  assertValidSessionKey,
  assertValidSessionStore,
  assertSessionKeyForAgent,
  buildGatewayEndpointUrl,
  buildGatewaySessionUrl,
  parseGatewayBaseUrl,
  resolveAgentSessionsStorePath,
  resolveSessionTranscriptPath,
  toNullPrototypeRecord,
} from '../identifiers.js';
import {
  clearGatewayCapabilityCache,
  discoverGatewayCapabilities,
} from '../gateway-capabilities.js';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function withRestoredEnv(names, callback) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    });
}

test('agent IDs retain compatible filename-safe forms and reject path syntax', () => {
  assert.equal(assertValidAgentId('main'), 'main');
  assert.equal(assertValidAgentId('Ops.Agent@prod-1'), 'Ops.Agent@prod-1');
  assert.equal(assertValidAgentId(`a${'b'.repeat(127)}`).length, 128);

  for (const value of [
    '',
    '.hidden',
    '../victim',
    'parent/child',
    'parent\\child',
    'agent name',
    'agent\nname',
    `a${'b'.repeat(128)}`,
  ]) {
    assert.throws(() => assertValidAgentId(value), /agent_id/);
  }
});

test('session keys preserve documented colon forms and reject URL or path confusion', () => {
  const validKeys = [
    'main',
    'global',
    'unknown',
    'scheduler:2f76fe6c-6041-47d0-bd4f-1de13f470807',
    'agent:main:subagent:2f76fe6c-6041-47d0-bd4f-1de13f470807',
    'agent:Ops.Agent@prod-1:telegram:direct:+15551234567',
  ];
  for (const key of validKeys) assert.equal(assertValidSessionKey(key), key);
  assert.equal(agentIdFromSessionKey(validKeys[4]), 'main');
  assert.equal(assertSessionKeyForAgent(validKeys[5], 'Ops.Agent@prod-1'), validKeys[5]);

  for (const value of [
    '../victim',
    'agent:../victim:subagent:one',
    'agent:main:subagent\\victim',
    'agent:main:subagent?admin=true',
    'agent:main:subagent#fragment',
    'agent:main:',
    'agent::subagent:one',
    'agent:main:..',
    'agent:main:two words',
    'agent:main:line\nbreak',
    `agent:main:${'x'.repeat(502)}`,
  ]) {
    assert.throws(() => assertValidSessionKey(value), /session_key/);
  }
  assert.throws(
    () => assertSessionKeyForAgent('agent:main:subagent:one', 'Main'),
    /does not match agent_id/,
  );
});

test('session IDs are one safe filename segment', () => {
  assert.equal(assertValidSessionId('2f76fe6c-6041-47d0-bd4f-1de13f470807'), '2f76fe6c-6041-47d0-bd4f-1de13f470807');
  for (const value of ['.', '..', '../sentinel', 'folder/file', 'folder\\file', 'id?query', 'id#fragment']) {
    assert.throws(() => assertValidSessionId(value), /session_id/);
  }
});

test('prototype-like keys remain ordinary own properties in trusted records', () => {
  const record = toNullPrototypeRecord(JSON.parse(
    '{"__proto__":{"status":"running"},"constructor":{"status":"done"}}',
  ));
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(Object.hasOwn(record, '__proto__'), true);
  assert.equal(Object.hasOwn(record, 'constructor'), true);
  assert.equal(record.__proto__.status, 'running');
  assert.equal(record.constructor.status, 'done');

  const emptyStore = assertValidSessionStore({});
  assert.equal(Object.getPrototypeOf(emptyStore), null);
  assert.equal(emptyStore.__proto__, undefined);
  assert.equal(emptyStore.constructor, undefined);
});

test('session paths remain lexically and canonically under the agent sessions root', () => {
  const home = makeTempDir('scheduler-session-path-home-');
  const outside = makeTempDir('scheduler-session-path-outside-');
  const sessionsDir = join(home, '.openclaw', 'agents', 'main', 'sessions');
  const sentinel = join(outside, 'sentinel.jsonl');
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sentinel, 'sentinel-safe\n');

    assert.equal(
      resolveAgentSessionsStorePath(home, 'main'),
      join(sessionsDir, 'sessions.json'),
    );
    assert.equal(
      resolveSessionTranscriptPath(home, 'main', 'legitimate-session'),
      join(sessionsDir, 'legitimate-session.jsonl'),
    );
    assert.throws(
      () => resolveSessionTranscriptPath(home, 'main', '../sentinel'),
      /session_id/,
    );

    symlinkSync(sentinel, join(sessionsDir, 'linked-session.jsonl'));
    assert.throws(
      () => resolveSessionTranscriptPath(home, 'main', 'linked-session'),
      /symbolic link/,
    );

    symlinkSync(outside, join(home, '.openclaw', 'agents', 'escaped-agent'));
    assert.throws(
      () => resolveAgentSessionsStorePath(home, 'escaped-agent'),
      /symbolic link/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel-safe\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Gateway URL parsing preserves base paths and rejects ambiguous authority', () => {
  const base = parseGatewayBaseUrl('http://127.0.0.1:18789/openclaw/api');
  assert.equal(base.href, 'http://127.0.0.1:18789/openclaw/api/');
  assert.equal(
    buildGatewayEndpointUrl(base, 'tools/invoke'),
    'http://127.0.0.1:18789/openclaw/api/tools/invoke',
  );
  assert.equal(
    buildGatewaySessionUrl(base, 'agent:main:subagent:one'),
    'http://127.0.0.1:18789/openclaw/api/sessions/agent%3Amain%3Asubagent%3Aone',
  );

  for (const value of [
    'not-a-url',
    '/relative',
    'file:///tmp/gateway.sock',
    'http://operator:secret@127.0.0.1:18789',
    'http://127.0.0.1:18789/base?admin=true',
    'http://127.0.0.1:18789/base#fragment',
    'http://127.0.0.1:18789\\redirect.example',
  ]) {
    assert.throws(() => parseGatewayBaseUrl(value), /Gateway|OPENCLAW_GATEWAY_URL|http|username|query|whitespace/i);
  }
});

test('capability discovery refuses redirects on credential-bearing probes', async () => {
  let observedUrl;
  let observedOptions;
  const gatewayUrl = 'http://127.0.0.1:18789/operator-base';
  try {
    const discovered = await discoverGatewayCapabilities({
      gatewayUrl,
      requestHeaders: { Authorization: 'Bearer capability-secret' },
      forceRefresh: true,
      fetchImpl: async (url, options) => {
        observedUrl = url;
        observedOptions = options;
        return new Response(JSON.stringify({
          version: '2026.7.13',
          protocol: 4,
          capabilities: ['chat-completions-env-inject-v1'],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    assert.equal(discovered.version, '2026.7.13');
    assert.equal(observedUrl, `${gatewayUrl}/v1/info`);
    assert.equal(observedOptions.redirect, 'error');
    assert.equal(observedOptions.headers.Authorization, 'Bearer capability-secret');
  } finally {
    clearGatewayCapabilityCache(gatewayUrl);
  }
});

test('Gateway credential headers are not forwarded through redirects', async () => {
  let sinkRequests = 0;
  let redirectAuthorization = null;
  const sink = await listen((request, response) => {
    sinkRequests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  const redirect = await listen((request, response) => {
    redirectAuthorization = request.headers.authorization || null;
    response.writeHead(302, { Location: `${sink.url}/captured` });
    response.end();
  });

  try {
    await withRestoredEnv(['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN'], async () => {
      process.env.OPENCLAW_GATEWAY_URL = `${redirect.url}/operator-base`;
      process.env.OPENCLAW_GATEWAY_TOKEN = 'redirect-secret';
      const gateway = await import(`../gateway.js?redirect-security=${Date.now()}`);
      await assert.rejects(
        gateway.invokeGatewayTool('sessions_list', {}, 'main'),
        /fetch|redirect/i,
      );
    });
    assert.equal(redirectAuthorization, 'Bearer redirect-secret');
    assert.equal(sinkRequests, 0);
  } finally {
    await close(redirect.server);
    await close(sink.server);
  }
});

test('Gateway response session keys require exact agent binding', async () => {
  let responseSessionKey = 'agent:other:subagent:response';
  const gatewayServer = await listen((request, response) => {
    if (request.url !== '/operator-base/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'x-openclaw-session-key': responseSessionKey,
    });
    response.end(JSON.stringify({ choices: [{ message: { content: 'complete' } }] }));
  });

  try {
    await withRestoredEnv(['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN'], async () => {
      process.env.OPENCLAW_GATEWAY_URL = `${gatewayServer.url}/operator-base`;
      process.env.OPENCLAW_GATEWAY_TOKEN = 'response-secret';
      const gateway = await import(`../gateway.js?response-session-security=${Date.now()}`);
      await assert.rejects(
        gateway.runAgentTurn({
          message: 'test response session validation',
          agentId: 'main',
          sessionKey: 'agent:main:subagent:request',
          timeoutMs: 5_000,
        }),
        /does not match agent_id/,
      );

      responseSessionKey = 'agent:main:subagent:response';
      const result = await gateway.runAgentTurn({
        message: 'test valid response session',
        agentId: 'main',
        sessionKey: 'agent:main:subagent:request',
        timeoutMs: 5_000,
      });
      assert.equal(result.sessionKey, responseSessionKey);
    });
  } finally {
    await close(gatewayServer.server);
  }
});

test('Gateway session-store writes reject symlink escapes without touching a sentinel', async () => {
  const home = makeTempDir('scheduler-store-write-home-');
  const outside = makeTempDir('scheduler-store-write-outside-');
  const outsideSessions = join(outside, 'sessions');
  const sentinel = join(outsideSessions, 'sessions.json');
  try {
    mkdirSync(join(home, '.openclaw', 'agents'), { recursive: true });
    mkdirSync(outsideSessions, { recursive: true });
    writeFileSync(sentinel, '{}');
    symlinkSync(outside, join(home, '.openclaw', 'agents', 'main'));

    await withRestoredEnv(['HOME', 'OPENCLAW_GATEWAY_URL'], async () => {
      process.env.HOME = home;
      process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';
      const gateway = await import(`../gateway.js?store-path-security=${Date.now()}`);
      const result = gateway.applySessionOverridesToSessionStore(
        'agent:main:scheduler:test',
        { modelRef: 'openai/gpt-5.4' },
        'main',
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /symbolic link/);
    });
    assert.equal(readFileSync(sentinel, 'utf8'), '{}');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('dispatcher rejects poisoned legacy job identity before Gateway activity', async () => {
  let gatewayChecked = false;
  const deps = {
    waitForGateway: async () => {
      gatewayChecked = true;
      return true;
    },
  };
  const ctx = { run: { id: 'run-security-test' } };

  await assert.rejects(
    executeAgent({ id: 'job-one', name: 'unsafe agent', agent_id: '../../victim' }, ctx, deps),
    /job agent_id/,
  );
  await assert.rejects(
    executeAgent({
      id: 'job-two',
      name: 'unsafe session',
      agent_id: 'main',
      preferred_session_key: 'agent:main:scheduler:test?admin=true',
    }, ctx, deps),
    /job preferred_session_key/,
  );
  assert.equal(gatewayChecked, false);
});

test('dispatch quarantines poisoned legacy labels and never follows their paths', () => {
  const home = makeTempDir('scheduler-dispatch-label-home-');
  const state = makeTempDir('scheduler-dispatch-label-state-');
  const sentinel = join(home, 'sentinel.jsonl');
  const labelsPath = join(state, 'labels.json');
  try {
    writeFileSync(sentinel, 'sentinel-safe\n');
    writeFileSync(labelsPath, JSON.stringify({
      poisoned: {
        agent: '../../victim',
        sessionKey: 'agent:../../victim:subagent:one',
        sessionId: '../../sentinel',
        status: 'running',
        spawnedAt: new Date().toISOString(),
      },
    }));

    const result = spawnSync(process.execPath, ['dispatch/index.mjs', 'status', '--label', 'poisoned'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Rejected unsafe legacy session metadata/);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'error');
    assert.match(output.error, /Rejected unsafe legacy session metadata/);

    const persisted = JSON.parse(readFileSync(labelsPath, 'utf8')).poisoned;
    assert.equal(persisted.status, 'error');
    assert.equal(Object.hasOwn(persisted, 'agent'), false);
    assert.equal(Object.hasOwn(persisted, 'sessionKey'), false);
    assert.equal(Object.hasOwn(persisted, 'sessionId'), false);
    assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel-safe\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('dispatch fails closed on a non-object labels ledger root', () => {
  const home = makeTempDir('scheduler-dispatch-root-home-');
  const state = makeTempDir('scheduler-dispatch-root-state-');
  const sentinel = join(home, 'sentinel.jsonl');
  const labelsPath = join(state, 'labels.json');
  const poisonedLedger = [{
    agent: '../../victim',
    sessionKey: 'agent:../../victim:subagent:one',
    sessionId: '../../sentinel',
  }];
  try {
    writeFileSync(sentinel, 'sentinel-safe\n');
    writeFileSync(labelsPath, JSON.stringify(poisonedLedger));
    const result = spawnSync(process.execPath, ['dispatch/index.mjs', 'list'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Refusing invalid labels ledger/);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, count: 0, labels: [] });
    const originalBytes = readFileSync(labelsPath);
    const mutation = spawnSync(process.execPath, [
      'dispatch/index.mjs',
      'done',
      '--label', 'ledger-recovery-probe',
      '--summary', 'Ledger recovery probe completed.',
      '--checklist', '{"work_complete":true}',
    ], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DISPATCH_LABELS_PATH: labelsPath,
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789',
      },
    });
    assert.notEqual(mutation.status, 0, mutation.stdout);
    assert.match(mutation.stderr, /Refusing to mutate invalid labels ledger/);
    assert.deepEqual(readFileSync(labelsPath), originalBytes);
    assert.deepEqual(JSON.parse(readFileSync(labelsPath, 'utf8')), poisonedLedger);
    assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel-safe\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('dispatch does not resolve inherited object properties as label entries', () => {
  const home = makeTempDir('scheduler-dispatch-prototype-home-');
  const state = makeTempDir('scheduler-dispatch-prototype-state-');
  const labelsPath = join(state, 'labels.json');
  try {
    writeFileSync(labelsPath, '{}');
    for (const label of ['__proto__', 'constructor', 'toString']) {
      const result = spawnSync(process.execPath, ['dispatch/index.mjs', 'status', '--label', label], {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          DISPATCH_LABELS_PATH: labelsPath,
          OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        label,
        found: false,
        message: 'No session found for this label',
      });
    }

    const watcherSource = readFileSync(new URL('../dispatch/watcher.mjs', import.meta.url), 'utf8');
    assert.match(watcherSource, /toNullPrototypeRecord\(/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
