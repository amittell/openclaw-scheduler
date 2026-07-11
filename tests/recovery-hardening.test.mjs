import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { closeDb, initDb, setDbPath } from '../db.js';
import { createJob } from '../jobs.js';
import { createRun } from '../runs.js';
import { isAgentCancellationConfirmed } from '../gateway.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return;
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    delay(timeoutMs).then(() => {
      throw new Error(`dispatcher did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

test('agent cancellation confirmation requires explicit abort evidence', () => {
  assert.equal(isAgentCancellationConfirmed({
    ok: true,
    aborted: false,
    runIds: [],
    runIdsReported: false,
  }), false);
  assert.equal(isAgentCancellationConfirmed({
    ok: true,
    aborted: false,
    runIds: [],
    runIdsReported: true,
  }), true);
  assert.equal(isAgentCancellationConfirmed({ ok: true, aborted: true }), true);
});

test('ambiguous aborts and unresolved credential cleanup block orphan replay', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scheduler-orphan-recovery-'));
  const dbPath = join(fixtureRoot, 'scheduler.db');
  const binDir = join(fixtureRoot, 'bin');
  const fakeOpenClaw = join(binDir, 'openclaw');
  let child = null;
  let stderr = '';

  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(binDir, { recursive: true }));
    writeFileSync(fakeOpenClaw, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true}\'\n', 'utf8');
    chmodSync(fakeOpenClaw, 0o755);

    setDbPath(dbPath);
    await initDb();
    const job = createJob({
      name: 'ambiguous-agent-orphan',
      schedule_cron: '0 0 1 1 *',
      session_target: 'isolated',
      payload_kind: 'agentTurn',
      payload_message: 'must not replay without abort evidence',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'recovery regression test',
      delivery_guarantee: 'at-least-once',
      run_timeout_ms: 30_000,
      origin: 'system',
    });
    const run = createRun(job.id, {
      session_key: `agent:main:scheduler:${job.id}`,
      run_timeout_ms: job.run_timeout_ms,
    });
    const cleanupJob = createJob({
      name: 'failed-cleanup-orphan',
      schedule_cron: '0 0 1 1 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'must not execute after unresolved cleanup',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'recovery regression test',
      delivery_guarantee: 'at-least-once',
      run_timeout_ms: 30_000,
      origin: 'system',
    });
    const cleanupRun = createRun(cleanupJob.id, {
      run_timeout_ms: cleanupJob.run_timeout_ms,
      context_summary: {
        credential_cleanup: {
          status: 'failed',
          attempts: 3,
          operator_action_required: true,
          error: 'simulated provider cleanup failure',
        },
      },
    });
    closeDb();

    child = spawn(process.execPath, [join(root, 'dispatcher.js')], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        SCHEDULER_DB: dbPath,
        SCHEDULER_TICK_MS: '1000',
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 10_000;
    let snapshot = null;
    while (Date.now() < deadline) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const recoveredRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
        const recoveredJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
        const replayCount = db.prepare(
          'SELECT COUNT(*) AS count FROM job_dispatch_queue WHERE replay_of_run_id = ?',
        ).get(run.id).count;
        const recoveredCleanupRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(cleanupRun.id);
        const recoveredCleanupJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(cleanupJob.id);
        const cleanupReplayCount = db.prepare(
          'SELECT COUNT(*) AS count FROM job_dispatch_queue WHERE replay_of_run_id = ?',
        ).get(cleanupRun.id).count;
        snapshot = {
          recoveredRun,
          recoveredJob,
          replayCount,
          recoveredCleanupRun,
          recoveredCleanupJob,
          cleanupReplayCount,
        };
      } finally {
        db.close();
      }
      if (
        snapshot.recoveredRun?.status === 'recovery_blocked'
        && snapshot.recoveredCleanupRun?.status === 'recovery_blocked'
      ) break;
      if (child.exitCode != null) {
        throw new Error(`dispatcher exited before recovery completed (${child.exitCode}): ${stderr}`);
      }
      await delay(50);
    }

    assert.equal(snapshot?.recoveredRun?.status, 'recovery_blocked', stderr);
    assert.match(snapshot.recoveredRun.error_message, /gateway did not confirm abort/i);
    assert.equal(snapshot.recoveredJob.enabled, 0);
    assert.equal(snapshot.recoveredJob.last_status, 'recovery_blocked');
    assert.equal(snapshot.replayCount, 0, 'ambiguous abort evidence must never enqueue a replay');
    assert.equal(snapshot.recoveredCleanupRun.status, 'recovery_blocked');
    assert.match(snapshot.recoveredCleanupRun.error_message, /Credential cleanup failed before recovery/);
    assert.equal(snapshot.recoveredCleanupJob.enabled, 0);
    assert.equal(snapshot.recoveredCleanupJob.last_status, 'recovery_blocked');
    assert.equal(snapshot.cleanupReplayCount, 0, 'failed cleanup must never enqueue a replay');
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      try {
        await waitForExit(child, 5_000);
      } catch {
        child.kill('SIGKILL');
        await waitForExit(child, 5_000);
      }
    }
    closeDb();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
