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
const PROBE_SETTINGS = {
  provider: 'gpufarm',
  baseUrl: 'https://catalog.example.test/gateway/v1/',
  apiKey: 'catalog-fixture',
};

function probeOpts(fetchImpl, settings = {}) {
  return { fetchImpl, settings: { ...PROBE_SETTINGS, ...settings } };
}

function jsonResponse(list) {
  return {
    ok: true,
    json: async () => ({ object: 'list', data: list }),
  };
}

test('probe: model omitted from /v1/models list -> not_served with exact reason', async () => {
  const fetchImpl = async () => jsonResponse([{ id: 'some-other-model' }]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
  assert.equal(result.reason, 'model_not_found: gpufarm/qwen3.8-27b not served by gpufarm');
});

test('probe: empty /v1/models list -> not_served with exact reason', async () => {
  const fetchImpl = async () => jsonResponse([]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
  assert.equal(result.reason, 'model_not_found: gpufarm/qwen3.8-27b not served by gpufarm');
});

test('probe: model present in /v1/models list -> served', async () => {
  const fetchImpl = async () => jsonResponse([
    { id: 'some-other-model' },
    { id: 'qwen3.8-27b' },
  ]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'served');
});

test('probe: network error -> unknown (tolerant, falls through)', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch failed: ECONNREFUSED');
  };
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: non-OK HTTP status -> unknown (tolerant)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
  assert.equal(result.httpStatus, 502);
});

for (const name of Object.keys(PROBE_SETTINGS)) {
  test(`probe: missing ${name} leaves normal dispatch available`, async () => {
    let called = false;
    const opts = probeOpts(async () => {
      called = true;
      return jsonResponse([]);
    }, { [name]: undefined });
    assert.equal((await probeModelAvailability(MODEL, opts)).status, 'unknown');
    assert.equal(called, false);
  });
}

test('probe: non-empty list with no usable id fields -> unknown (malformed, not definitive absence)', async () => {
  const fetchImpl = async () => jsonResponse([{ name: 'qwen3.8-27b' }]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: non-empty list of null entries -> unknown (malformed, not definitive absence)', async () => {
  const fetchImpl = async () => jsonResponse([null]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: mixed list with at least one usable id -> real catalog, membership decides', async () => {
  const fetchImpl = async () => jsonResponse([{ id: 'some-other-model' }, { name: 'odd' }]);
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
});

for (const model of ['different/model', 'model', 'gpufarm/']) {
  test(`probe: ${model} is outside the configured provider catalog`, async () => {
    let called = false;
    const opts = probeOpts(async () => {
      called = true;
      return jsonResponse([]);
    });
    assert.equal((await probeModelAvailability(model, opts)).status, 'unknown');
    assert.equal(called, false);
  });
}

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
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: paginated list (has_more true) -> unknown', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], has_more: true }) });
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: paginated list (meta.next non-null) -> unknown', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], meta: { next: 'page-2' } }) });
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'unknown');
});

test('probe: last page (body.next null) is still definitive -> served', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b' }], next: null }) });
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'served');
});

test('probe: last page (body.next null) omitting the model -> not_served (definitive)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'some-other-model' }], next: null }) });
  const result = await probeModelAvailability(MODEL, probeOpts(fetchImpl));
  assert.equal(result.status, 'not_served');
});

test('probe: uses only the configured catalog endpoint and its credential', async () => {
  const requests = [];
  const opts = probeOpts(async (url, request) => {
    requests.push({ url: url.href, authorization: request.headers.Authorization, redirect: request.redirect });
    return jsonResponse([{ id: MODEL }]);
  });
  assert.equal((await probeModelAvailability(MODEL, opts)).status, 'served');
  assert.deepEqual(requests, [{
    url: 'https://catalog.example.test/gateway/v1/models',
    authorization: 'Bearer catalog-fixture',
    redirect: 'error',
  }]);
});

for (const base of [
  'not-a-url',
  'ftp://catalog.example.test',
  'https://catalog.example.test/v1?tenant=example',
  'https://catalog.example.test/v1#models',
  'https://fixture@catalog.example.test/v1',
]) {
  test(`probe: rejects unsupported configured catalog URL (${base})`, async () => {
    let called = false;
    const opts = probeOpts(async () => {
      called = true;
      return jsonResponse([]);
    }, { baseUrl: base });
    assert.equal((await probeModelAvailability(MODEL, opts)).status, 'unknown');
    assert.equal(called, false);
  });
}

test('probe: a redirect response is not evidence that the model is absent', async () => {
  const result = await probeModelAvailability(MODEL, probeOpts(async () => ({
    ok: false, status: 302,
  })));
  assert.equal(result.status, 'unknown');
});
