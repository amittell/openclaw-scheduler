import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, initDb, setDbPath } from '../db.js';

test('name-filtered daily reliability tests leave the fallback database untouched', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sched-daily-db-isolation-'));
  t.after(() => {
    closeDb();
    rmSync(scratch, { recursive: true, force: true });
  });
  // An initialized fallback reproduces an installed scheduler: a skipped setup
  // can otherwise create enabled fixture jobs without any missing-table error.
  const fallbackDb = join(scratch, 'fallback.db');
  setDbPath(fallbackDb);
  await initDb();
  closeDb();
  const digest = () => createHash('sha256').update(readFileSync(fallbackDb)).digest('hex');
  const before = digest();
  const denyNetwork = join(scratch, 'deny-network.mjs');
  writeFileSync(denyNetwork, `
    import net from 'node:net';
    import dgram from 'node:dgram';
    const denied = () => { throw new Error('Network access forbidden in DB isolation test'); };
    net.Socket.prototype.connect = denied;
    dgram.createSocket = denied;
    globalThis.fetch = denied;
  `);
  const childEnv = {
    ...process.env,
    SCHEDULER_DB: fallbackDb,
    SCHEDULER_HOME: join(scratch, 'scheduler'),
    TMPDIR: scratch,
    OPENCLAW_GATEWAY_TOKEN: 'synthetic-isolation-test-token',
    OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:1',
  };
  // This is a fresh runner, not a worker in the parent's test protocol.
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [
    '--import', denyNetwork,
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern', '^(transient 5xx failure|second consecutive transient failure)',
    fileURLToPath(new URL('./daily-job-reliability.test.mjs', import.meta.url)),
  ], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /# pass 2\b/, 'both fixture-creating tests actually ran');
  assert.equal(digest(), before, 'filtered tests must not write jobs or runs to the fallback DB');
});
