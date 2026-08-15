import test from 'node:test';
import assert from 'node:assert/strict';

import { executeShell } from '../dispatcher-strategies.js';
import { normalizeShellResult } from '../shell-result.js';

const noop = () => {};

async function executeEmptyShell(deliveryMode) {
  return executeShell({
    id: `empty-${deliveryMode}`,
    name: `empty-${deliveryMode}`,
    payload_message: 'true',
    run_timeout_ms: 30_000,
    shell_env_policy: 'minimal',
    delivery_mode: deliveryMode,
  }, {
    run: { id: `run-empty-${deliveryMode}` },
  }, {
    runShellCommand: async () => ({
      stdout: '',
      stderr: '',
      error: null,
      exitCode: 0,
    }),
    normalizeShellResult,
    log: noop,
  });
}

test('delivery_mode=none never announces a successful empty shell result', async () => {
  const result = await executeEmptyShell('none');

  assert.equal(result.status, 'ok');
  assert.equal(result.summary, '(no output)');
  assert.equal(result.content, '');
  assert.equal(result.deliveryOverride, null);
  assert.equal(result.skipDelivery, true);
});

test('successful empty shell output stays quiet even under accidental announce-always', async () => {
  const result = await executeEmptyShell('announce-always');

  assert.equal(result.status, 'ok');
  assert.equal(result.summary, '(no output)');
  assert.equal(result.content, '');
  assert.equal(result.deliveryOverride, null);
  assert.equal(result.skipDelivery, true);
});
