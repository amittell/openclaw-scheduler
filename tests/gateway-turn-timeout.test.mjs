import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const sessionKey = 'agent:main:subagent:timeout-fixture';
const completion = {
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  created: 1,
  model: 'openclaw:main',
  choices: [{ index: 0, message: { role: 'assistant', content: 'complete response' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};
let sequence = 0;

async function withGateway(handler, run) {
  const pendingTimers = new Set();
  const requests = [];
  const received = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const later = callback => {
    const timer = setTimeout(() => { pendingTimers.delete(timer); callback(); }, 1_500);
    pendingTimers.add(timer);
  };
  const server = createServer((req, res) => {
    let bytes = '';
    req.on('data', chunk => { bytes += chunk; });
    req.on('end', () => {
      const body = bytes ? JSON.parse(bytes) : null;
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.url === '/tools/invoke') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { sessions: [] } }));
        return;
      }
      res.on('close', () => closed.resolve());
      received.resolve();
      handler(req, res, later);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const previousUrl = process.env.OPENCLAW_GATEWAY_URL;
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousDispatcher = getGlobalDispatcher();
  // The same real Undici timers fail quickly instead of waiting five minutes.
  // No fake fetch implementation or simulated transport error is used.
  const dispatcher = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
  setGlobalDispatcher(dispatcher);
  process.env.OPENCLAW_GATEWAY_URL = url;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'fixture-token';
  try {
    const gateway = await import(`../gateway.js?turn-timeout-${++sequence}`);
    await run({ gateway, url, requests, received: received.promise, closed: closed.promise });
  } finally {
    for (const timer of pendingTimers) clearTimeout(timer);
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previousUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
  }
}

const callers = [
  ['fixed deadline', (gateway, options = {}) => gateway.runAgentTurn({
    message: 'fixture', sessionKey, timeoutMs: 5_000, cancelOnAbort: false, ...options,
  })],
  ['activity deadline', (gateway, options = {}) => gateway.runAgentTurnWithActivityTimeout({
    message: 'fixture', sessionKey, absoluteTimeoutMs: 5_000, idleTimeoutMs: 5_000,
    pollIntervalMs: 5_000, cancelOnAbort: false, ...options,
  })],
];

for (const [name, call] of callers) {
  for (const phase of ['headers', 'body']) {
    test(`${name}: job deadline owns a long wait for ${phase}`, async () => {
      await withGateway((_req, res, later) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('x-openclaw-session-key', sessionKey);
        const payload = JSON.stringify(completion);
        if (phase === 'body') res.write(payload.slice(0, 10));
        later(() => res.end(phase === 'body' ? payload.slice(10) : payload));
      }, async ({ gateway, url, requests }) => {
        const control = assert.rejects(
          fetch(`${url}/control`).then(response => response.json()),
          error => error.cause?.code === (phase === 'body' ? 'UND_ERR_BODY_TIMEOUT' : 'UND_ERR_HEADERS_TIMEOUT'),
          'the real short transport timer must fail the control request',
        );
        const result = await call(gateway);
        await control;
        assert.equal(result.ok, true);
        assert.equal(result.content, 'complete response');
        assert.equal(result.sessionKey, sessionKey);
        assert.deepEqual(result.usage, completion.usage);
        assert.deepEqual(result.raw, completion, 'all JSON completion metadata survives');
        const request = requests.find(item => item.url === '/v1/chat/completions');
        assert.equal(request.body.stream, false);
        assert.equal(request.headers['x-openclaw-scopes'], 'operator.write');
        assert.equal(request.headers['x-openclaw-session-key'], sessionKey);
      });
    });
  }

  test(`${name}: caller cancellation closes a pending response body`, async () => {
    await withGateway((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    }, async ({ gateway, received, closed }) => {
      const controller = new AbortController();
      const turn = call(gateway, { signal: controller.signal });
      const rejection = assert.rejects(turn, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
      await received;
      controller.abort();
      await rejection;
      await closed;
    });
  });

  test(`${name}: configured hard deadline still aborts a pending request`, async () => {
    await withGateway(() => {}, async ({ gateway, closed }) => {
      await assert.rejects(call(gateway, { timeoutMs: 100, absoluteTimeoutMs: 100 }),
        name === 'fixed deadline' ? /Agent turn timed out/ : /Exceeded absolute timeout/);
      await closed;
    });
  });
}

test('activity monitor still aborts a quiet session before its absolute deadline', async () => {
  await withGateway(() => {}, async ({ gateway, closed, requests }) => {
    await assert.rejects(gateway.runAgentTurnWithActivityTimeout({
      message: 'fixture', sessionKey, absoluteTimeoutMs: 5_000,
      idleTimeoutMs: 30, pollIntervalMs: 20, cancelOnAbort: false,
    }), /activity-based timeout/);
    await closed;
    assert.ok(requests.some(request => request.url === '/tools/invoke'));
  });
});
