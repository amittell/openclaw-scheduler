import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

// Regression: the gateway's /v1/chat/completions endpoint rejects concrete
// provider/model refs in the request body (only routing ids: openclaw,
// openclaw/default, openclaw/<agentId>, agent:<agentId> — see the gateway's
// isOpenClawAgentModelId, src/gateway/http-utils.ts). Before this fix the
// isolated-dispatch path sent `model: model || openclaw:<agentId>` in the
// body and never forwarded payload_model, so a job payload_model of e.g.
// "example/gpt-4o" only took effect via the legacy sessions.json store.
//
// splitModelOverride routes non-routing refs into the x-openclaw-model header
// (the gateway's model-override channel, resolved via parseModelRef with the
// visibility-policy check) and keeps a valid routing id in the body.

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

async function captureChatCompletions(call) {
  let captured = null;
  const sink = await listen((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      let data = '';
      request.on('data', chunk => { data += chunk; });
      request.on('end', () => {
        captured = {
          body: JSON.parse(data),
          modelHeader: request.headers['x-openclaw-model'] || null,
          agentIdHeader: request.headers['x-openclaw-agent-id'] || null,
          sessionKeyHeader: request.headers['x-openclaw-session-key'] || null,
          authProfileHeader: request.headers['x-openclaw-auth-profile'] || null,
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { total_tokens: 1 },
        }));
      });
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `unexpected ${request.url}` } }));
  });
  const savedUrl = process.env.OPENCLAW_GATEWAY_URL;
  try {
    process.env.OPENCLAW_GATEWAY_URL = sink.url;
    const gateway = await import(`../gateway.js?model-forwarding-test-${Date.now()}`);
    const result = await call(gateway);
    return { result, captured };
  } finally {
    if (savedUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = savedUrl;
    await close(sink.server);
  }
}

test('provider/model ref is forwarded via x-openclaw-model, body keeps a routing id', async () => {
  const { result, captured } = await captureChatCompletions(async (gateway) => gateway.runAgentTurn({
    message: 'use the configured model',
    agentId: 'main',
    sessionKey: 'agent:main:subagent:11111111-2222-3333-4444-555555555555',
    model: 'example/gpt-4o',
    timeoutMs: 3_000,
  }));
  assert.equal(result.ok, true, 'turn should succeed against the sink');
  assert.equal(captured.modelHeader, 'example/gpt-4o', 'model ref must travel in the x-openclaw-model header');
  assert.equal(captured.body.model, 'openclaw:main', 'body must carry a valid routing id, not the provider ref');
  assert.equal(captured.agentIdHeader, 'main', 'agent id header is preserved');
  assert.equal(captured.authProfileHeader, null, 'unsupported profile header is absent');
});

test('routing model id stays in the body without an override header', async () => {
  const { result, captured } = await captureChatCompletions(async (gateway) => gateway.runAgentTurn({
    message: 'explicit routing id',
    agentId: 'main',
    sessionKey: 'agent:main:subagent:22222222-3333-4444-5555-666666666666',
    model: 'openclaw:main',
    timeoutMs: 3_000,
  }));
  assert.equal(result.ok, true, 'turn should succeed against the sink');
  assert.equal(captured.modelHeader, null, 'no override header for routing ids');
  assert.equal(captured.body.model, 'openclaw:main', 'routing id stays in the body');
});

test('no model: body defaults to the per-agent routing id, no override header', async () => {
  const { result, captured } = await captureChatCompletions(async (gateway) => gateway.runAgentTurn({
    message: 'default model',
    agentId: 'main',
    timeoutMs: 3_000,
  }));
  assert.equal(result.ok, true, 'turn should succeed against the sink');
  assert.equal(captured.modelHeader, null, 'no override header when no model is requested');
  assert.equal(captured.body.model, 'openclaw:main', 'body defaults to openclaw:<agentId>');
});

test('Gateway-incompatible routing IDs are rejected locally, not forwarded as model overrides', async () => {
  for (const route of ['openclaw:ops.team', 'agent:user@example', `openclaw:${'a'.repeat(65)}`]) {
    const { captured } = await captureChatCompletions(async gateway => {
      await assert.rejects(gateway.runAgentTurn({ message: 'invalid route', agentId: 'main', model: route }), /routing/i);
    });
    assert.equal(captured, null);
  }
});

test('direct explicit profile options are rejected by both HTTP runners before a request', async () => {
  const { captured } = await captureChatCompletions(async gateway => {
    for (const run of [gateway.runAgentTurn, gateway.runAgentTurnWithActivityTimeout]) {
      await assert.rejects(run({ message: 'unprepared profile', agentId: 'main', authProfile: 'vendor:work' }), /prepareAgentSelection/);
    }
  });
  assert.equal(captured, null);
});

test('activity-aware runner retains concrete model forwarding without profile header', async () => {
  const { result, captured } = await captureChatCompletions(async gateway => gateway.runAgentTurnWithActivityTimeout({
    message: 'model selection', agentId: 'main', sessionKey: 'agent:main:scheduler:fixture',
    model: 'vendor/model', absoluteTimeoutMs: 3000, pollIntervalMs: 60000,
  }));
  assert.equal(result.ok, true);
  assert.equal(captured.body.model, 'openclaw:main');
  assert.equal(captured.modelHeader, 'vendor/model');
  assert.equal(captured.authProfileHeader, null);
});
