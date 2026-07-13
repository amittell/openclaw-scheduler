import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob } from '../jobs.js';
import { createRun } from '../runs.js';
import { claimDispatch, enqueueDispatch } from '../dispatch-queue.js';
import { createApproval } from '../approval.js';
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
      evidence_ref: 'audit:ambiguous-agent-orphan',
      evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
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
      evidence_ref: 'audit:failed-cleanup-orphan',
      evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
    });
    const cleanupDispatch = enqueueDispatch(cleanupJob.id, { kind: 'manual' });
    assert.ok(claimDispatch(cleanupDispatch.id));
    const cleanupRun = createRun(cleanupJob.id, {
      run_timeout_ms: cleanupJob.run_timeout_ms,
      dispatch_queue_id: cleanupDispatch.id,
      context_summary: {
        credential_cleanup: {
          status: 'failed',
          attempts: 3,
          operator_action_required: true,
          error: 'simulated provider cleanup failure',
        },
      },
    });
    getDb().prepare("UPDATE runs SET evidence_execution_snapshot = '{invalid-json' WHERE id = ?")
      .run(cleanupRun.id);
    const crashJob = createJob({
      name: 'confirmed-stopped-orphan',
      schedule_cron: '0 0 1 1 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'printf must-not-replay',
      delivery_mode: 'none',
      delivery_guarantee: 'at-most-once',
      run_timeout_ms: 30_000,
      origin: 'system',
      evidence_ref: 'audit:confirmed-stopped-orphan',
      evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
    });
    const crashRun = createRun(crashJob.id, { run_timeout_ms: crashJob.run_timeout_ms });
    const corruptCrashJob = createJob({
      name: 'corrupt-evidence-orphan',
      schedule_cron: '0 0 1 1 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'must not replay after recovery evidence corruption',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'recovery regression test',
      delivery_guarantee: 'at-least-once',
      run_timeout_ms: 30_000,
      origin: 'system',
      evidence_ref: 'audit:corrupt-evidence-orphan',
      evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
    });
    const corruptCrashDispatch = enqueueDispatch(corruptCrashJob.id, { kind: 'manual' });
    assert.ok(claimDispatch(corruptCrashDispatch.id));
    const corruptCrashRun = createRun(corruptCrashJob.id, {
      run_timeout_ms: corruptCrashJob.run_timeout_ms,
      dispatch_queue_id: corruptCrashDispatch.id,
    });
    getDb().prepare("UPDATE runs SET evidence_execution_snapshot = '{invalid-json' WHERE id = ?")
      .run(corruptCrashRun.id);
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
        const recoveredCrashRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(crashRun.id);
        const blockedEvidence = db.prepare('SELECT payload FROM evidence_records WHERE run_id = ?').get(run.id);
        const cleanupEvidence = db.prepare('SELECT payload FROM evidence_records WHERE run_id = ?').get(cleanupRun.id);
        const cleanupQueue = db.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?')
          .get(cleanupDispatch.id);
        const crashEvidence = db.prepare('SELECT payload FROM evidence_records WHERE run_id = ?').get(crashRun.id);
        const recoveredCorruptCrashRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(corruptCrashRun.id);
        const recoveredCorruptCrashJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(corruptCrashJob.id);
        const corruptCrashReplayCount = db.prepare(
          'SELECT COUNT(*) AS count FROM job_dispatch_queue WHERE replay_of_run_id = ?',
        ).get(corruptCrashRun.id).count;
        const corruptCrashEvidence = db.prepare('SELECT payload FROM evidence_records WHERE run_id = ?')
          .get(corruptCrashRun.id);
        const corruptCrashQueue = db.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?')
          .get(corruptCrashDispatch.id);
        snapshot = {
          recoveredRun,
          recoveredJob,
          replayCount,
          recoveredCleanupRun,
          recoveredCleanupJob,
          cleanupReplayCount,
          recoveredCrashRun,
          blockedEvidence,
          cleanupEvidence,
          cleanupQueue,
          crashEvidence,
          recoveredCorruptCrashRun,
          recoveredCorruptCrashJob,
          corruptCrashReplayCount,
          corruptCrashEvidence,
          corruptCrashQueue,
        };
      } finally {
        db.close();
      }
      if (
        snapshot.recoveredRun?.status === 'recovery_blocked'
        && snapshot.recoveredCleanupRun?.status === 'recovery_blocked'
        && snapshot.recoveredCrashRun?.status === 'crashed'
        && snapshot.recoveredCorruptCrashRun?.status === 'recovery_blocked'
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
    assert.equal(snapshot.cleanupQueue.status, 'failed');
    assert.equal(snapshot.cleanupQueue.claim_expires_at, null);
    assert.match(snapshot.cleanupQueue.last_error, /Credential cleanup failed before recovery/);
    assert.equal(snapshot.recoveredCrashRun.status, 'crashed');
    assert.equal(JSON.parse(snapshot.blockedEvidence.payload).run.status, 'recovery_blocked');
    assert.equal(snapshot.cleanupEvidence, undefined, 'corrupt cleanup evidence must fail closed without a false record');
    assert.equal(JSON.parse(snapshot.crashEvidence.payload).run.status, 'crashed');
    assert.equal(snapshot.recoveredCorruptCrashRun.status, 'recovery_blocked');
    assert.match(snapshot.recoveredCorruptCrashRun.error_message, /evidence execution snapshot is invalid json/i);
    assert.equal(snapshot.recoveredCorruptCrashJob.enabled, 0);
    assert.equal(snapshot.recoveredCorruptCrashJob.last_status, 'recovery_blocked');
    assert.equal(snapshot.corruptCrashReplayCount, 0, 'corrupt recovery evidence must suppress replay');
    assert.equal(snapshot.corruptCrashEvidence, undefined, 'corrupt recovery evidence must not produce a false record');
    assert.equal(snapshot.corruptCrashQueue.status, 'failed');
    assert.equal(snapshot.corruptCrashQueue.claim_expires_at, null);
    assert.match(snapshot.corruptCrashQueue.last_error, /evidence execution snapshot is invalid json/i);
    assert.equal(child.exitCode, null, 'one corrupt orphan must not terminate the dispatcher');
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

test('delete-after-run one-shot parents survive until triggered children execute', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scheduler-one-shot-chain-'));
  const dbPath = join(fixtureRoot, 'scheduler.db');
  let child = null;
  let stderr = '';

  try {
    setDbPath(dbPath);
    await initDb();
    const scheduledAt = new Date(Date.now() - 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    const parent = createJob({
      name: 'one-shot-chain-parent',
      schedule_kind: 'at',
      schedule_at: scheduledAt,
      schedule_cron: '0 0 31 2 *',
      next_run_at: scheduledAt,
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'printf parent-complete',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'workflow lifecycle regression test',
      delete_after_run: 1,
      run_timeout_ms: 30_000,
      origin: 'system',
    });
    const workflowChild = createJob({
      name: 'one-shot-chain-child',
      parent_id: parent.id,
      trigger_on: 'success',
      schedule_cron: '0 0 31 2 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'printf child-complete',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'workflow lifecycle regression test',
      run_timeout_ms: 30_000,
      origin: 'system',
    });
    closeDb();

    child = spawn(process.execPath, [join(root, 'dispatcher.js')], {
      cwd: root,
      env: {
        ...process.env,
        SCHEDULER_DB: dbPath,
        SCHEDULER_TICK_MS: '1000',
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 15_000;
    let snapshot = null;
    while (Date.now() < deadline) {
      const db = new Database(dbPath, { readonly: true });
      try {
        snapshot = {
          parent: db.prepare('SELECT * FROM jobs WHERE id = ?').get(parent.id),
          workflowChild: db.prepare('SELECT * FROM jobs WHERE id = ?').get(workflowChild.id),
          parentRun: db.prepare(
            'SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
          ).get(parent.id),
          childRun: db.prepare(
            'SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
          ).get(workflowChild.id),
          childDispatch: db.prepare(
            'SELECT * FROM job_dispatch_queue WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
          ).get(workflowChild.id),
        };
      } finally {
        db.close();
      }
      if (snapshot.parentRun?.status === 'ok' && snapshot.childRun?.status === 'ok') break;
      if (child.exitCode != null) {
        throw new Error(`dispatcher exited before workflow completed (${child.exitCode}): ${stderr}`);
      }
      await delay(50);
    }

    assert.equal(snapshot?.parentRun?.status, 'ok', stderr);
    assert.equal(snapshot?.childRun?.status, 'ok', stderr);
    assert.ok(snapshot.parent, 'delete-after-run parent must remain while it owns child definitions');
    assert.equal(snapshot.parent.enabled, 0, 'completed one-shot parent must be disabled');
    assert.equal(snapshot.parent.last_status, 'ok');
    assert.ok(snapshot.workflowChild, 'triggered child definition must remain addressable');
    assert.equal(snapshot.childDispatch?.status, 'done');
    assert.equal(snapshot.childRun.triggered_by_run, snapshot.parentRun.id);
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

test('startup repairs legacy approval gates before one-shot self-destruct', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scheduler-legacy-gate-repair-'));
  const dbPath = join(fixtureRoot, 'scheduler.db');
  let child = null;
  let stderr = '';

  try {
    setDbPath(dbPath);
    await initDb();
    const scheduledAt = new Date(Date.now() - 60_000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    const job = createJob({
      name: 'legacy-gate-one-shot',
      schedule_kind: 'at',
      schedule_at: scheduledAt,
      schedule_cron: '0 0 31 2 *',
      next_run_at: scheduledAt,
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'printf repaired-and-complete',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'legacy gate startup regression test',
      delete_after_run: 1,
      run_timeout_ms: 30_000,
      origin: 'system',
      evidence_ref: 'audit:legacy-gate-one-shot',
      evidence: JSON.stringify({ provider: 'sha256', methods: ['sha256'] }),
    });
    const gateRun = createRun(job.id, {
      status: 'approved',
      evidence_required: true,
      run_timeout_ms: job.run_timeout_ms,
    });
    const approval = createApproval(job.id, gateRun.id, null);
    getDb().prepare(`
      UPDATE approvals
      SET status = 'dispatched',
          resolved_at = datetime('now'),
          dispatched_at = datetime('now')
      WHERE id = ?
    `).run(approval.id);
    closeDb();

    child = spawn(process.execPath, [join(root, 'dispatcher.js')], {
      cwd: root,
      env: {
        ...process.env,
        SCHEDULER_DB: dbPath,
        SCHEDULER_TICK_MS: '1000',
        OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 15_000;
    let snapshot = null;
    while (Date.now() < deadline) {
      const db = new Database(dbPath, { readonly: true });
      try {
        snapshot = {
          job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id),
          gateRun: db.prepare('SELECT * FROM runs WHERE id = ?').get(gateRun.id),
          runCount: db.prepare('SELECT COUNT(*) AS count FROM runs WHERE job_id = ?').get(job.id).count,
          approval: db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id),
          retainedEvidence: db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE job_id = ?')
            .get(job.id).count,
        };
      } finally {
        db.close();
      }
      if (!snapshot.job && snapshot.runCount === 0 && snapshot.approval == null) break;
      if (child.exitCode != null) {
        throw new Error(`dispatcher exited before one-shot cleanup (${child.exitCode}): ${stderr}`);
      }
      await delay(50);
    }

    assert.equal(snapshot?.job, undefined, stderr);
    assert.equal(snapshot?.gateRun, undefined, 'repaired gate run must not block job deletion');
    assert.equal(snapshot?.runCount, 0);
    assert.equal(snapshot?.approval, undefined);
    assert.equal(snapshot?.retainedEvidence, 1, 'execution evidence remains retained after self-destruct');
    assert.match(stderr, /Recovered 1 approval dispatch state\(s\) before scheduling/);
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
