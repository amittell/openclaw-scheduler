/**
 * Regression coverage for the 2026-11-15 dead-model dispatch burn:
 *
 * A dispatch pinned to gpufarm/qwen3.8-27b (renamed out of the gpufarm
 * catalog; /v1/models returned an empty list) was spawned, ran ~28 min,
 * was killed by the gateway (abortedLastRun), and the watcher classified
 * it "interrupted" (artifact evidence in JSONL) and auto-redispatched
 * onto the SAME dead model, burning the interrupt retry budget.
 *
 * probeModelAvailability (dispatch/default-model.mjs) must:
 *   (A) return 'not_served' when the provider is reachable and its
 *       /v1/models list omits the model (or is empty), with the exact
 *       reason string `model_not_found: <model> not served by <provider>`;
 *   (B) return 'served' when the list includes the model;
 *   (C) return 'unknown' (tolerant fall-through) on a network error, so a
 *       flaky network never fails a dispatch.
 */
import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModelAvailability, selectProbeModel } from '../dispatch/default-model.mjs';

const MODEL = 'gpufarm/qwen3.8-27b';
const OPENCLAW_CONFIG = {
  models: {
    providers: {
      gpufarm: { baseUrl: 'http://gpufarm.lan/v1' },
    },
  },
};

function probeOpts(fetchImpl) {
  return {
    fetchImpl,
    openClawConfig: OPENCLAW_CONFIG,
    env: { HOME: '/nonexistent-home' },
    homeDir: '/nonexistent-home',
    exists: (p) => p.endsWith('gpufarm-api-key.txt'),
    readFile: (_p) => 'test-api-key',
    timeoutMs: 5000,
  };
}

function jsonResponse(list) {
  return {
    ok: true,
    json: async () => ({ object: 'list', data: list }),
  };
}

test('probe: model omitted from /v1/models list -> not_served with exact reason', async () => {
  const fetchImpl = async () => jsonResponse([{ id: 'some-other-model' }]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
  assert.equal(result.reason, 'model_not_found: gpufarm/qwen3.8-27b not served by gpufarm');
});

test('probe: empty /v1/models list -> not_served with exact reason', async () => {
  const fetchImpl = async () => jsonResponse([]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
  assert.equal(result.reason, 'model_not_found: gpufarm/qwen3.8-27b not served by gpufarm');
});

test('probe: model present in /v1/models list -> served', async () => {
  const fetchImpl = async () => jsonResponse([
    { id: 'some-other-model' },
    { id: 'qwen3.8-27b' },
  ]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'served');
});

test('probe: network error -> unknown (tolerant, falls through)', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  };
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: non-OK HTTP status -> unknown (tolerant)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 502);
});

test('probe: no API key available -> unknown (tolerant)', async () => {
  const opts = probeOpts(async () => jsonResponse([]));
  opts.exists = () => false;
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'unknown');
});

test('probe: unresolvable provider base url -> unknown (tolerant)', async () => {
  const opts = probeOpts(async () => jsonResponse([]));
  opts.openClawConfig = {};
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'unknown');
});

test('probe: non-empty list with no usable id fields -> unknown (malformed, not definitive absence)', async () => {
  const fetchImpl = async () => jsonResponse([{ name: 'qwen3.8-27b' }]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: non-empty list of null entries -> unknown (malformed, not definitive absence)', async () => {
  const fetchImpl = async () => jsonResponse([null]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: mixed list with at least one usable id -> real catalog, membership decides', async () => {
  const fetchImpl = async () => jsonResponse([{ id: 'some-other-model' }, { name: 'odd' }]);
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
});

test('probe: unsafe provider segment in model id -> unknown (no path traversal)', async () => {
  // providerBase passed directly so base resolves; the unsafe provider
  // segment (space) must trip the safety check before the key path is built.
  const result = await probeModelAvailability('gp ufarm/x', 'http://gpufarm.lan/v1', probeOpts(async () => jsonResponse([])));
  assert.equal(result.status, 'unknown');
});

test('probe: non-http(s) base url scheme -> unknown (SSRF guard)', async () => {
  const opts = probeOpts(async () => jsonResponse([]));
  opts.openClawConfig = { models: { providers: { gpufarm: { baseUrl: 'file:///etc/passwd' } } } };
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'unknown');
});

test('selectProbeModel: fresh probes the resolved default/explicit model', () => {
  assert.equal(selectProbeModel({ isFresh: true, defaultModel: 'prov/a', explicitModel: null, labelModel: 'prov/b' }), 'prov/a');
  assert.equal(selectProbeModel({ isFresh: true, defaultModel: null, explicitModel: 'prov/c', labelModel: 'prov/b' }), null);
});

test('selectProbeModel: reuse without --model probes the existing session model, not the default', () => {
  assert.equal(selectProbeModel({ isFresh: false, defaultModel: 'prov/retired', explicitModel: null, labelModel: 'prov/healthy' }), 'prov/healthy');
});

test('selectProbeModel: reuse with --model probes the explicit override', () => {
  assert.equal(selectProbeModel({ isFresh: false, defaultModel: 'prov/retired', explicitModel: 'prov/override', labelModel: 'prov/healthy' }), 'prov/override');
});

test('selectProbeModel: reuse with no model anywhere skips the probe', () => {
  assert.equal(selectProbeModel({ isFresh: false, defaultModel: null, explicitModel: null, labelModel: null }), null);
});

// ---------------------------------------------------------------------------
// Wave-2 finding: a paginating provider yields a false `not_served`
// (the probe must be tolerant -- in doubt -> unknown).
// ---------------------------------------------------------------------------
test('probe: paginated list (body.next non-null) -> unknown (catalog not provably complete)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], next: 'cursor-abc' }) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: paginated list (has_more true) -> unknown', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], has_more: true }) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: paginated list (meta.next non-null) -> unknown', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], meta: { next: 'page-2' } }) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: last page (body.next null) is still definitive -> served', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b' }], next: null }) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'served');
});

test('probe: last page (body.next null) omitting the model -> not_served (definitive)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], next: null }) });
  const result = await probeModelAvailability(MODEL, null, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
});

// ---------------------------------------------------------------------------
// Wave-2 finding: the probe reads a hardcoded secrets filename rather than
// resolving the config's apiKey reference.
// ---------------------------------------------------------------------------
test('probe: apiKey file ref resolved via secrets.providers path (not the conventional filename)', async () => {
  const cfg = {
    models: { providers: { gpufarm: { baseUrl: 'http://gpufarm.lan/v1', apiKey: { source: 'file', provider: 'gpufarm_bots', id: 'value' } } } },
    secrets: { providers: { gpufarm_bots: { source: 'file', path: '~/custom/elsewhere.txt', mode: 'singleValue' } } },
  };
  const fetchImpl = async () => jsonResponse([{ id: 'qwen3.8-27b' }]);
  const opts = probeOpts(fetchImpl);
  opts.openClawConfig = cfg;
  opts.exists = (p) => p.endsWith('elsewhere.txt'); // only the ref path exists
  opts.readFile = (_p) => 'ref-key-value';
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'served');
});

test('probe: apiKey env ref resolved from env', async () => {
  const cfg = {
    models: { providers: { gpufarm: { baseUrl: 'http://gpufarm.lan/v1', apiKey: { source: 'env', id: 'GPUFARM_KEY' } } } },
  };
  const fetchImpl = async () => jsonResponse([{ id: 'qwen3.8-27b' }]);
  const opts = probeOpts(fetchImpl);
  opts.openClawConfig = cfg;
  opts.env = { HOME: '/nonexistent-home', GPUFARM_KEY: 'env-key-value' };
  opts.exists = () => false; // no conventional file
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'served');
});

test('probe: apiKey file ref with no secrets.providers entry falls back to the conventional path', async () => {
  const cfg = {
    models: { providers: { gpufarm: { baseUrl: 'http://gpufarm.lan/v1', apiKey: { source: 'file', provider: 'missing_alias', id: 'value' } } } },
  };
  const fetchImpl = async () => jsonResponse([{ id: 'qwen3.8-27b' }]);
  const opts = probeOpts(fetchImpl); // exists() matches the conventional filename
  opts.openClawConfig = cfg;
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'served');
});

test('probe: apiKey file ref to a missing file -> unknown (tolerant, no key)', async () => {
  const cfg = {
    models: { providers: { gpufarm: { baseUrl: 'http://gpufarm.lan/v1', apiKey: { source: 'file', provider: 'gpufarm_bots', id: 'value' } } } },
    secrets: { providers: { gpufarm_bots: { source: 'file', path: '~/custom/elsewhere.txt', mode: 'singleValue' } } },
  };
  const fetchImpl = async () => jsonResponse([{ id: 'qwen3.8-27b' }]);
  const opts = probeOpts(fetchImpl);
  opts.openClawConfig = cfg;
  opts.exists = () => false; // neither the ref path nor the conventional path exists
  const result = await probeModelAvailability(MODEL, null, opts);
  assert.equal(result.status, 'unknown');
});
