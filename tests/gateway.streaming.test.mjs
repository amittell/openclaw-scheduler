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

// ---------------------------------------------------------------------------
// Robustness regressions (adversarial review of #44):
//
// * trailing `data:` frame with no terminating newline must not be dropped
// * multi-byte UTF-8 split across chunk boundaries must decode intact
// * keep-alive comments and empty data: frames must be ignored
// * a body whose content type is not text/event-stream falls back to the
//   legacy JSON parsing (raw preserves the original completion object)
// * an in-band JSON error object on a non-SSE body surfaces the upstream msg
// * an SSE buffer that never drains (huge non-SSE body) must be refused,
//   not buffered without bound
// ---------------------------------------------------------------------------

function replaceFetch(handlers) {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'fixture-streaming-token';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    for (const [match, handle] of Object.entries(handlers)) {
      if (u.includes(match)) return handle(u, init);
    }
    if (u.includes('/tools/invoke')) {
      return Response.json({ result: { sessions: [] } });
    }
    throw new Error(`mock fetch saw an unexpected URL: ${u}`);
  };
  return () => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
  };
}

test('trailing data frame without a final newline is not dropped', async () => {
  // The final frame carries content AND finish_reason and ends with no
  // terminating newline at stream end.
  const frames = [
    deltaFrame('final '),
    sseFrame({ choices: [{ index: 0, delta: { content: 'line' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }).replace(/\n+$/, ''),
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture no trailing newline',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'final line');
  assert.equal(result.raw.choices[0].finish_reason, 'stop');
  assert.equal(result.raw.usage.total_tokens, 3);
});

test('multi-byte UTF-8 split across chunk boundaries decodes intact', async () => {
  const text = 'héllo → 世界 🌍';
  const bytes = new TextEncoder().encode(deltaFrame(text));
  // Deterministic split mid-codepoint: 世 is E4 B8 96; cut between B8 and 96.
  // (The original 50/50 cut landed on an ASCII boundary and would not have
  // exercised the stream-decode path at all.)
  const cut = bytes.indexOf(0x96);
  // Guard: a fatal decode of the first chunk only throws when the cut lands
  // inside a multi-byte codepoint. If this guard ever fails, the cut is on a
  // codepoint boundary and the test no longer proves the stream-decode fix.
  assert.throws(
    () => new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, cut)),
    'cut must land inside a multi-byte codepoint',
  );
  const restore = replaceFetch({
    '/v1/chat/completions': () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  try {
    const result = await gateway.runAgentTurn({
      message: 'fixture utf8 split',
      agentId: 'main',
      sessionKey: SESSION_KEY,
      timeoutMs: 5_000,
      cancelOnAbort: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.content, text);
    assert.equal(result.raw.choices[0].message.content, text);
  } finally {
    restore();
  }
});

test('keep-alive comments and empty data frames are ignored', async () => {
  const frames = [
    ': keep-alive\n\n',
    'data:\n\n',
    deltaFrame('alive '),
    ': ping\n',
    '\n',
    deltaFrame('comment ignored'),
    'data: [DONE]\n\n',
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture keepalive',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'alive comment ignored');
});

test('non-object and null data frames do not poison the turn', async () => {
  // A proxy or upstream can emit valid JSON that is not an object (data: null,
  // data: 1, data: "x"). The parser must skip such frames instead of throwing
  // a TypeError (obj.error on null) that would abort the whole turn.
  const frames = [
    deltaFrame('before '),
    'data: null\n\n',
    'data: 42\n\n',
    'data: "stray"\n\n',
    deltaFrame('after'),
    'data: [DONE]\n\n',
  ];
  const { result } = await withSseStream(frames, () => gateway.runAgentTurn({
    message: 'fixture non-object frames',
    agentId: 'main',
    sessionKey: SESSION_KEY,
    timeoutMs: 5_000,
    cancelOnAbort: false,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'before after');
});

test('non-SSE content type falls back to legacy JSON parsing and preserves raw', async () => {
  const completion = {
    id: 'chatcmpl-json-fallback',
    object: 'chat.completion',
    created: 1725740000,
    model: 'openclaw:main',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'buffered reply' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
  const captured = [];
  const restore = replaceFetch({
    '/v1/chat/completions': (_u, init) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-openclaw-session-key': SESSION_KEY,
        },
      });
    },
  });
  try {
    const result = await gateway.runAgentTurn({
      message: 'fixture json fallback',
      agentId: 'main',
      sessionKey: SESSION_KEY,
      timeoutMs: 5_000,
      cancelOnAbort: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.content, 'buffered reply');
    assert.deepEqual(result.usage, completion.usage);
    // Legacy path: raw is the ORIGINAL object (id/created/model survive).
    assert.deepEqual(result.raw, completion);
    assert.equal(result.raw.id, 'chatcmpl-json-fallback');
    assert.equal(result.raw.model, 'openclaw:main');
    assert.equal(result.sessionKey, SESSION_KEY);
    assert.equal(captured[0].stream, true, 'request still asks for streaming');
    assert.deepEqual(captured[0].stream_options, { include_usage: true });
  } finally {
    restore();
  }
});

test('in-band JSON error object on a non-SSE body throws with the upstream message', async () => {
  const restore = replaceFetch({
    '/v1/chat/completions': () => new Response(JSON.stringify({
      error: { message: 'rate limited upstream', type: 'api_error' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  try {
    await assert.rejects(
      gateway.runAgentTurn({
        message: 'fixture json error',
        agentId: 'main',
        sessionKey: SESSION_KEY,
        timeoutMs: 5_000,
        cancelOnAbort: false,
      }),
      err => err instanceof Error && err.message.includes('rate limited upstream'),
    );
  } finally {
    restore();
  }
});

test('an undrained non-SSE body in an SSE stream is refused, not buffered without bound', async () => {
  // A single line far above the buffer cap with no newline: the gateway must
  // have sent something that is not an event stream. Reject with a clear error
  // instead of accumulating memory until the stream ends.
  const restore = replaceFetch({
    '/v1/chat/completions': () => {
      const huge = 'data: ' + 'x'.repeat(16 * 1024 * 1024); // no trailing newline
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(huge));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    await assert.rejects(
      gateway.runAgentTurn({
        message: 'fixture undrained',
        agentId: 'main',
        sessionKey: SESSION_KEY,
        timeoutMs: 5_000,
        cancelOnAbort: false,
      }),
      err => err instanceof Error && /exceeded an undrained single line/i.test(err.message),
    );
  } finally {
    restore();
  }
});
