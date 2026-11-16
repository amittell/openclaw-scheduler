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
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModelAvailability } from '../dispatch/default-model.mjs';

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
    readFile: (p) => 'test-api-key',
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
