import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

// Regression: on a gateway with multiple agents, a bare sessionKey of "main"
// fails owner resolution and every durable outbox delivery 400s with
// "session key \"main\" has no explicit owner". The scheduler must pin an
// explicit agentId on the /tools/invoke request body so owner resolution
// succeeds. These tests assert that invariant at the invokeGatewayTool choke
// point (which covers message, sessions_list, and every other tool call via
// that endpoint), plus the two prompt/fetch sites that build the payload
// inline.
//
// NOTE: invokeGatewayTool reads OPENCLAW_GATEWAY_URL at module-import time,
// so all invoke scenarios share one sink + one module instance and run
// sequentially — concurrent tests would race on the env variable.

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('invokeGatewayTool pins the session key owner as an explicit agentId', async () => {
  const bodies = [];
  const sink = await listen((request, response) => {
    let data = '';
    request.on('data', chunk => { data += chunk; });
    request.on('end', () => {
      bodies.push(data);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  const savedUrl = process.env.OPENCLAW_GATEWAY_URL;
  try {
    process.env.OPENCLAW_GATEWAY_URL = sink.url;
    // No gateway token is required: the local sink accepts the request and
    // authHeaders() is empty without one.
    const gateway = await import(`../gateway.js?durable-delivery-agentid-test`);

    // Bare key: falls back to 'main' owner (the documented failure mode).
    let result = await gateway.invokeGatewayTool('message', {
      action: 'send',
      channel: 'telegram',
      to: '12345',
      text: 'hello',
    }, 'main');
    assert.equal(result.ok, true, 'invoke should succeed against the sink');
    let parsed = JSON.parse(bodies.at(-1));
    assert.equal(parsed.sessionKey, 'main', 'session key is preserved');
    assert.equal(parsed.agentId, 'main', 'bare main session key must carry an explicit agentId owner');

    // Non-bare key: owner derived from the key, so the body never disagrees
    // with the session key (gateways enforce owner consistency).
    const scopedKey = 'agent:ops:subagent:11111111-2222-3333-4444-555555555555';
    result = await gateway.invokeGatewayTool('message', {
      action: 'send',
      channel: 'telegram',
      to: '12345',
      text: 'hello',
    }, scopedKey);
    assert.equal(result.ok, true, 'invoke should succeed against the sink');
    parsed = JSON.parse(bodies.at(-1));
    assert.equal(parsed.sessionKey, scopedKey, 'session key is preserved');
    assert.equal(parsed.agentId, 'ops', 'scoped key must carry its own agent owner, not a hardcoded main');
  } finally {
    if (savedUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = savedUrl;
    await close(sink.server);
  }
});

test('CHECK_IN template and starting-notification payload pin agentId', () => {
  // The two sites that build /tools/invoke payloads inline (dispatch/index.mjs)
  // are string templates, not exported functions; assert on the source so a
  // refactor that silently drops the pin re-opens the 400.
  const src = readFileSync(join(here, '..', 'dispatch', 'index.mjs'), 'utf8');
  assert.ok(
    src.includes('"sessionKey":"main","agentId":"main"'),
    'CHECK_IN curl template must pin agentId next to the bare main session key',
  );
  assert.ok(
    /sessionKey: 'main',\s*\n\s*agentId: 'main',/.test(src),
    'starting-notification fetch body must pin agentId next to the bare main session key',
  );
});
