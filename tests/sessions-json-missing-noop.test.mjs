import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('missing legacy session store is not evidence of an applied profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scheduler-sessions-missing-'));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const gatewayUrl = new URL('../gateway.js', import.meta.url);
    gatewayUrl.searchParams.set('missing-store-home', home);
    const { prepareAgentSelection, applySessionOverridesToSessionStore } = await import(gatewayUrl.href);
    const missing = join(home, '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    assert.equal(applySessionOverridesToSessionStore('scheduler:fixture', { authProfile: 'vendor:work' }).ok, false);
    await assert.rejects(prepareAgentSelection('scheduler:fixture', { authProfile: 'vendor:work' }), /concrete provider\/model/);
    assert.equal((await prepareAgentSelection('scheduler:fixture', { modelRef: 'vendor/model' })).applied, false);
    assert.equal(existsSync(missing), false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
