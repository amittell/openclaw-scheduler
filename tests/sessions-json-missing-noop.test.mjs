import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Regression: when the gateway's legacy sessions.json store does not exist
// (the gateway keeps sessions in per-agent SQLite; sessions.json is only a
// legacy fallback), applySessionOverridesToSessionStore must treat the
// missing file as a no-op and return { ok: true } — not a failure. A failure
// return caused the dispatcher to log a warning on every isolated dispatch.
//
// gateway.js resolves HOME_DIR at module-load time, so point HOME at an
// empty temp dir and cache-bust the import.

test('applySessionOverridesToSessionStore is a no-op when sessions.json is missing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scheduler-sessions-missing-'));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const gateway = await import(`../gateway.js?sessions-json-missing-${Date.now()}`);
    const result = gateway.applySessionOverridesToSessionStore(
      'scheduler:test-job-1234',
      { authProfile: 'test-profile', modelRef: null },
      'main',
    );
    assert.equal(result.ok, true, 'missing sessions.json must be a no-op success');
    assert.equal(result.error, undefined, 'no error message expected for a no-op');
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
