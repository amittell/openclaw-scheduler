import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

// Regression: on a gateway with multiple agents, a bare sessionKey of "main"
// fails owner resolution and every durable outbox delivery 400s with
// "session key \"main\" has no explicit owner". The scheduler must pin an
// explicit agentId on the /tools/invoke request body so owner resolution
// succeeds for the business agent. This test asserts that invariant at the
// invokeGatewayTool choke point (which covers message, sessions_list, and
// every other tool call via that endpoint).

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

test('invokeGatewayTool pins an explicit agentId for a bare main session key', async () => {
  let capturedBody = null;
  const sink = await listen((request, response) => {
    let data = '';
    request.on('data', chunk => { data += chunk; });
    request.on('end', () => {
      capturedBody = data;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  const savedUrl = process.env.OPENCLAW_GATEWAY_URL;
  try {
    process.env.OPENCLAW_GATEWAY_URL = sink.url;
    // No gateway token is required: the local sink accepts the request and
    // authHeaders() is empty without one.
    // Cache-bust so the module re-reads the env-pointed gateway URL.
    const gateway = await import(`../gateway.js?durable-delivery-agentid-${Date.now()}`);
    const result = await gateway.invokeGatewayTool('message', {
      action: 'send',
      channel: 'telegram',
      to: '12345',
      text: 'hello',
      dryRun: true,
    }, 'main');
    assert.equal(result.ok, true, 'tool invoke should succeed against the sink');
    assert.ok(capturedBody, 'gateway should have received a request body');
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.sessionKey, 'main', 'session key is preserved');
    assert.equal(parsed.agentId, 'main', 'bare main session key must carry an explicit agentId owner');
  } finally {
    if (savedUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = savedUrl;
    await close(sink.server);
  }
});
