import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callGatewayRpc,
  GatewayRpcError,
  parseGatewayCliJson,
} from '../dispatch/gateway-rpc.mjs';

test('gateway RPC parser tolerates non-JSON prefix output', () => {
  assert.deepEqual(
    parseGatewayCliJson('plugin initialized\n{"ok":true,"runId":"run-1"}\n'),
    { ok: true, runId: 'run-1' },
  );
});

test('gateway RPC parser ignores bracketed plugin log prefixes', () => {
  assert.deepEqual(
    parseGatewayCliJson('[plugins] initialized\n[\n  {"key":"session-1"}\n]\n'),
    [{ key: 'session-1' }],
  );
});

test('gateway RPC rejects an error envelope even when the CLI exits zero', () => {
  assert.throws(
    () => callGatewayRpc('sessions.patch', { key: 'agent:main:subagent:test' }, {
      execFileSync: () => JSON.stringify({
        ok: false,
        error: {
          type: 'gateway_request_error',
          code: 'INVALID_REQUEST',
          message: "invalid sessions.patch params: unexpected property 'spawnDepth'",
          retryable: false,
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof GatewayRpcError);
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.message, /unexpected property 'spawnDepth'/);
      return true;
    },
  );
});

test('gateway RPC returns successful envelopes unchanged', () => {
  assert.deepEqual(
    callGatewayRpc('agent', {}, {
      execFileSync: () => JSON.stringify({ ok: true, runId: 'run-2' }),
    }),
    { ok: true, runId: 'run-2' },
  );
});
