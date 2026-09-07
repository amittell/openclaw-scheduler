import assert from 'node:assert/strict';
import test from 'node:test';

import * as gateway from '../gateway.js';

// Regression: isolated agent turns previously POSTed to /v1/chat/completions
// with `stream: false`. The gateway buffered the entire multi-step turn and
// only sent HTTP headers when the full response was ready. Node's built-in
// fetch (undici) has a default headersTimeout of 300s, so any turn taking
// longer than that was killed with a bare "fetch failed" (observed: a
// 302.9s merged morning brief run, 12+ model calls all returning 200).
//
// The fix switches both fetch sites in gateway.js to `stream: true` +
// `stream_options: { include_usage: true }` and accumulates SSE delta.content
// events, preserving the `{ ok, content, usage, sessionKey, raw }` result
// shape. These tests drive the real runAgentTurn /
// runAgentTurnWithActivityTimeout code paths against a mock fetch whose
// responses are SSE streams (no real gateway involved).

const SESSION_KEY = 'agent:main:subagent:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function deltaFrame(content, extra = {}) {
  return sseFrame({ choices: [{ index: 0, delta: { content }, ...extra }] });
}

function toolCallFrame() {
  return sseFrame({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0, id: 'call_123', type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        }],
      },
    }],
  });
}

// Build a fetch Response whose body is an SSE ReadableStream enqueuing the
// given raw frames (each may split a `data:` line across chunks, CRLF or LF).
function sseResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function installMockFetch(completionFrames) {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'fixture-streaming-token';
  const completions = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) {
      completions.push(JSON.parse(init.body));
      return sseResponse(completionFrames);
    }
    if (u.includes('/tools/invoke')) {
      // listSessions activity polling must find no activity; the turn ends
      // before the first poll anyway.
      return Response.json({ result: { sessions: [] } });
    }
    throw new Error(`mock fetch saw an unexpected URL: ${u}`);
  };
  return {
    completions,
    restore() {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    },
  };
}

async function withSseStream(frames, run) {
  const mock = installMockFetch(frames);
  try {
    const result = await run(mock);
    return { result, completions: mock.completions };
  } finally {
    mock.restore();
  }
}

test('happy path: multi-chunk SSE deltas assemble into the same result shape', async () => {
  // One `data:` line is deliberately split across two network chunks to prove
  // the reader buffers partial lines before parsing.
  const frames = [
    deltaFrame('Hello'),
    'data: {"choices":[{"index":0,"delta":{"cont',
    'ent":" world"}}]}\n\n',
    sseFrame({
      choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 22, total_tokens: 42 },
    }),
  ];
  const { result, completions } = await withSseStream(frames, async mock => {
    assert.equal(mock.completions.length, 0, 'no completion request yet mid-flight');
    return gateway.runAgentTurn({
      message: 'fixture turn',
      agentId: 'main',
      sessionKey: SESSION_KEY,
      timeoutMs: 5_000,
      cancelOnAbort: false,
    });
  });
  assert.equal(completions.length, 1, 'exactly one chat completions request');
  assert.equal(completions[0].stream, true, 'request must use stream: true');
  assert.deepEqual(completions[0].stream_options, { include_usage: true });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Hello world!');
  assert.equal(result.usage.total_tokens, 42);
  assert.equal(result.sessionKey, SESSION_KEY);
  assert.equal(result.raw.object, 'chat.completion');
  assert.equal(result.raw.choices[0].message.content, 'Hello world!');
  assert.equal(result.raw.choices[0].finish_reason, 'stop');
  assert.equal(result.raw.usage.total_tokens, 42);
});

test('mid-stream error payload rejects with the upstream message', async () => {
  const frames = [
    deltaFrame('partial'),
    sseFrame({ error: { message: 'upstream provider 500' } }),
  ];
  const mock = installMockFetch(frames);
  try {
    await assert.rejects(
      gateway.runAgentTurn({
        message: 'fixture failing turn',
        agentId: 'main',
        sessionKey: SESSION_KEY,
        timeoutMs: 5_000,
        cancelOnAbort: false,
      }),
      err => err instanceof Error
        && /stream error/i.test(err.message)
        && err.message.includes('upstream provider 500'),
    );
  } finally {
    mock.restore();
  }
});

test('data: [DONE] sentinel is ignored and content stays intact', async () => {
  const frames = [
    deltaFrame('brief '),
    deltaFrame('content'),
    'data: [DONE]\n\n',
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture done sentinel',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'brief content');
});

test('CRLF line endings are parsed the same as LF', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'streamed' } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ' via crlf' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } })}\r\n\r\n`,
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture crlf',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.content, 'streamed via crlf');
  assert.equal(result.usage.total_tokens, 9);
});

test('tool-call deltas without content leave content empty', async () => {
  const frames = [
    deltaFrame('working...'),
    toolCallFrame(),
    toolCallFrame(),
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture tool calls',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.ok, true);
  // The tool_call JSON must not leak into the accumulated content.
  assert.equal(result.content, 'working...');
  assert.ok(!result.content.includes('call_123'));
  assert.equal(result.raw.choices[0].finish_reason, 'tool_calls');
});

test('usage appearing only in the final chunk is still captured', async () => {
  const frames = [
    deltaFrame('a'),
    deltaFrame('b'),
    deltaFrame('c'),
    sseFrame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }),
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture late usage',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.content, 'abc');
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  assert.equal(result.raw.usage.total_tokens, 12);
});

test('activity-timeout runner also requests stream: true and assembles SSE content', async () => {
  const frames = [
    deltaFrame('activity '),
    deltaFrame('runner'),
    'data: [DONE]\n\n',
    sseFrame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { total_tokens: 3 },
    }),
  ];
  const { result, completions } = await withSseStream(frames, () => gateway.runAgentTurnWithActivityTimeout({
    message: 'fixture activity timeout',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    pollIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    absoluteTimeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stream, true, 'activity runner must use stream: true');
  assert.deepEqual(completions[0].stream_options, { include_usage: true });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'activity runner');
  assert.equal(result.usage.total_tokens, 3);
  assert.equal(result.raw.object, 'chat.completion');
});
