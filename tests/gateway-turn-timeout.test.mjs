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
      await withGateway((req, res, later) => {
        // The /control probe keeps the original JSON shape so the short 50ms
        // transport timers still fire exactly as before. The chat completions
        // request streams SSE (stream: true contract): the same delayed
        // delivery, but as data: frames instead of one buffered JSON body.
        const isChat = req.url === '/v1/chat/completions';
        res.setHeader('Content-Type', isChat ? 'text/event-stream' : 'application/json');
        if (isChat) res.setHeader('x-openclaw-session-key', sessionKey);
        const payload = isChat
          ? 'data: ' + JSON.stringify({
              choices: [{ index: 0, delta: { content: 'complete ' } }],
            }) + '\n\n' +
            'data: ' + JSON.stringify({
              choices: [{ index: 0, delta: { content: 'response' }, finish_reason: 'stop' }],
              usage: completion.usage,
            }) + '\n\n' +
            'data: [DONE]\n\n'
          : JSON.stringify(completion);
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
        assert.equal(result.raw.object, 'chat.completion');
        assert.equal(result.raw.choices[0].message.content, 'complete response');
        assert.equal(result.raw.choices[0].finish_reason, 'stop');
        assert.deepEqual(result.raw.usage, completion.usage, 'SSE usage frame survives');
        const request = requests.find(item => item.url === '/v1/chat/completions');
        assert.equal(request.body.stream, true);
        assert.deepEqual(request.body.stream_options, { include_usage: true });
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

// The streaming contract means production completions are SSE, so the
// 50ms-timer tests above can no longer reproduce the ORIGINAL failure
// (buffered body held past the transport timer). These two tests keep
// direct coverage of #43's mechanism: per-request headersTimeout:0 /
// bodyTimeout:0 overrides forwarded through the ambient dispatcher,
// for BOTH the SSE path and the legacy buffered-JSON fallback path.
test('chat completion requests carry the per-request transport overrides (both callers)', async () => {
  await withGateway((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { sessions: [] } }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('x-openclaw-session-key', sessionKey);
    res.end('data: ' + JSON.stringify({
      choices: [{ index: 0, delta: { content: 'complete response' }, finish_reason: 'stop' }],
      usage: completion.usage,
    }) + '\n\ndata: [DONE]\n\n');
  }, async ({ gateway }) => {
    const { Agent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const previous = getGlobalDispatcher();
    const seen = [];
    const spy = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
    const realDispatch = spy.dispatch.bind(spy);
    spy.dispatch = (options, handler) => {
      if (options.path === '/v1/chat/completions') seen.push(options);
      return realDispatch(options, handler);
    };
    setGlobalDispatcher(spy);
    try {
      for (const [, invoke] of callers) {
        const result = await invoke(gateway);
        assert.equal(result.ok, true);
        assert.equal(result.content, 'complete response');
      }
    } finally {
      setGlobalDispatcher(previous);
      await spy.destroy();
    }
    assert.equal(seen.length, 2, 'both caller turns must pass through the ambient dispatcher');
    for (const options of seen) {
      assert.equal(options.path, '/v1/chat/completions');
      // 0 disables the timer (undici semantics); any finite value would
      // reintroduce the five-minute kill on slow turns.
      assert.equal(options.headersTimeout, 0, 'headersTimeout override must be 0');
      assert.equal(options.bodyTimeout, 0, 'bodyTimeout override must be 0');
    }
  });
});

test('legacy buffered-JSON completion survives the transport override (fallback path)', async () => {
  await withGateway((req, res, later) => {
    // Both the chat completion and the plain-fetch control are held 1.5s, far
    // past the 50ms ambient timers. The chat path survives ONLY via #43's
    // per-request headersTimeout:0 / bodyTimeout:0 override; the control dies
    // at the timer, proving the timers are real (the original failure mode).
    if (req.url !== '/v1/chat/completions') {
      later(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    // A gateway that answers the stream request with one buffered JSON body
    // (legacy behavior): the reader must take parseJsonChatCompletion.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-openclaw-session-key', sessionKey);
    later(() => res.end(JSON.stringify(completion)));
  }, async ({ gateway, url, requests }) => {
    const control = assert.rejects(
      fetch(`${url}/control`).then(r => r.json()),
      error => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT',
      'plain fetch must hit the real 50ms headersTimeout',
    );
    const result = await gateway.runAgentTurn({
      message: 'fixture', sessionKey, timeoutMs: 5_000, cancelOnAbort: false,
    });
    await control;
    assert.equal(result.ok, true);
    assert.equal(result.content, 'complete response');
    assert.deepEqual(result.usage, completion.usage);
    // The fallback preserves the original completion object in raw.
    assert.equal(result.raw.id, 'chatcmpl-fixture');
    assert.equal(result.raw.model, 'openclaw:main');
    const request = requests.find(item => item.url === '/v1/chat/completions');
    assert.equal(request.body.stream, true, 'request still asks for SSE');
    assert.equal(request.headers['x-openclaw-session-key'], sessionKey);
  });
});
