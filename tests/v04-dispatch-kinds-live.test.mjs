import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { getDispatch } from '../dispatch-queue.js';
import { createJob, fireTriggeredChildren, runJobNow, scheduleRetry } from '../jobs.js';
import { createRun, finishRun } from '../runs.js';

const root = resolve(import.meta.dirname, '..');
const cliPath = join(root, 'cli.js');
const dispatcherPath = join(root, 'dispatcher.js');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function waitFor(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    const accepted = accept(latest);
    if (accepted) return accepted;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not reach its expected state: ${JSON.stringify(latest)}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const waitForExit = timeoutMs => new Promise(resolveExit => {
    if (child.exitCode != null || child.signalCode != null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
  child.kill('SIGTERM');
  if (await waitForExit(5_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(5_000), true, 'dispatcher did not exit after SIGKILL');
}

test('all five durable dispatch kinds gate, consume, and execute exactly once', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'scheduler-v04-dispatch-kinds-'));
  const dbPath = join(fixture, 'scheduler.db');
  const env = {
    ...process.env,
    SCHEDULER_DB: dbPath,
    OPENCLAW_SCHEDULER_HOME: fixture,
    SCHEDULER_TICK_MS: '1000',
    SCHEDULER_MESSAGE_DELIVERY_MS: '600000',
    SCHEDULER_PRUNE_MS: '600000',
    SCHEDULER_BACKUP_MS: '600000',
    SCHEDULER_HEARTBEAT_CHECK_MS: '600000',
  };
  let dispatcher;
  let probe;
  t.after(async () => {
    await stopChild(dispatcher);
    probe?.close();
    closeDb();
    rmSync(fixture, { recursive: true, force: true });
  });

  setDbPath(dbPath);
  await initDb();
  const parent = createJob({
    name: 'dispatch-kind-parent',
    schedule_cron: '0 0 * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'true',
    run_timeout_ms: 5_000,
    delivery_mode: 'none',
    origin: 'system',
  });
  const parentRun = createRun(parent.id);
  finishRun(parentRun.id, 'ok', { summary: 'chain parent completed' });

  const fixtures = [];
  for (const kind of ['schedule', 'at', 'manual', 'chain', 'retry']) {
    const marker = join(fixture, `${kind}.marker`);
    const job = createJob({
      name: `dispatch-kind-${kind}`,
      ...(kind === 'chain'
        ? { parent_id: parent.id, trigger_on: 'success' }
        : kind === 'at'
          ? { schedule_kind: 'at', schedule_at: '2030-01-01 00:00:00' }
          : { schedule_cron: '0 0 * * *' }),
      ...(kind === 'schedule' ? { run_now: true } : {}),
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: `printf 'complete\\n' >> ${shellQuote(marker)} && printf '%s\\n' '{"kind":"${kind}"}'`,
      run_timeout_ms: 5_000,
      max_retries: kind === 'retry' ? 1 : 0,
      delivery_mode: 'none',
      origin: kind === 'chain' ? undefined : 'system',
      approval_required: true,
      approval_risk_level: 'high',
      approval_timeout_s: 300,
      approval_auto: 'reject',
      output_format: 'json',
      verify_shell: `test -f ${shellQuote(marker)}`,
      verify_timeout_s: 5,
      verify_on_failure: 'error',
    });
    const state = {
      kind,
      marker,
      job,
      dispatch: null,
      retryOfRunId: null,
      approval: null,
    };
    if (kind === 'at') {
      getDb().prepare("UPDATE jobs SET schedule_at = datetime('now', '-1 second') WHERE id = ?")
        .run(job.id);
    }
    if (kind === 'manual') {
      const manual = runJobNow(job.id);
      state.dispatch = getDispatch(manual.dispatch_id);
    }
    if (kind === 'chain') {
      const [triggered] = fireTriggeredChildren(parent.id, 'ok', 'parent completed', parentRun.id);
      assert(triggered, 'chain producer did not trigger its child');
      state.dispatch = getDispatch(triggered.dispatch_id);
    }
    if (kind === 'retry') {
      const failed = createRun(job.id);
      finishRun(failed.id, 'error', { summary: 'retry predecessor' });
      const retry = scheduleRetry(job, failed.id);
      assert(retry.dispatch, 'retry producer did not enqueue a dispatch');
      getDb().prepare(`
        UPDATE job_dispatch_queue
        SET scheduled_for = datetime('now', '-1 second'),
            binding_scheduled_for = datetime('now', '-1 second')
        WHERE id = ?
      `).run(retry.dispatch.id);
      state.dispatch = getDispatch(retry.dispatch.id);
      state.retryOfRunId = failed.id;
    }
    fixtures.push(state);
  }
  closeDb();

  dispatcher = spawn(process.execPath, [dispatcherPath], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let dispatcherStderr = '';
  dispatcher.stderr.on('data', chunk => { dispatcherStderr += chunk; });
  const assertDispatcherHealthy = () => {
    if (dispatcher.exitCode != null || dispatcher.signalCode != null) {
      throw new Error(
        `dispatcher exited code=${dispatcher.exitCode} signal=${dispatcher.signalCode}: ${dispatcherStderr}`,
      );
    }
  };
  probe = new Database(dbPath);
  probe.pragma('journal_mode = WAL');

  const pending = await waitFor(
    () => {
      assertDispatcherHealthy();
      return probe.prepare("SELECT * FROM approvals WHERE status = 'pending'").all();
    },
    rows => rows.length === fixtures.length ? rows : null,
    'five pending approval gates',
  );
  assert.deepEqual(
    new Set(pending.map(approval => approval.job_id)),
    new Set(fixtures.map(state => state.job.id)),
    'approval gates did not cover exactly the five produced dispatches',
  );
  for (const approval of pending) {
    const state = fixtures.find(candidate => candidate.job.id === approval.job_id);
    assert(state, `unexpected approval for job ${approval.job_id}`);
    const queue = probe.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?')
      .get(approval.dispatch_queue_id);
    assert(queue, `missing queue row for ${state.kind}`);
    assert.equal(queue.dispatch_kind, state.kind);
    assert.equal(queue.status, 'awaiting_approval');
    if (state.dispatch) assert.equal(queue.id, state.dispatch.id);
    state.dispatch = queue;
    state.approval = approval;
    const gateRun = probe.prepare('SELECT * FROM runs WHERE id = ?').get(approval.run_id);
    assert.equal(gateRun.status, 'awaiting_approval');
    assert.equal(existsSync(state.marker), false, `${state.kind} ran user code before approval`);
  }
  for (const approval of pending) {
    const resolved = runCli([
      'approvals', 'approve', approval.id,
      '--reason', `approved ${approval.dispatch_queue_id}`,
    ], env);
    assert.equal((resolved.approval || resolved).status, 'approved');
  }

  await waitFor(
    () => {
      assertDispatcherHealthy();
      return fixtures.map(fixture => ({
        ...fixture,
        runs: probe.prepare(`
          SELECT * FROM runs
          WHERE job_id = ? AND approval_used IS NOT NULL
          ORDER BY started_at
        `).all(fixture.job.id),
      }));
    },
    states => states.every(state => state.runs.length === 1 && state.runs[0].status === 'ok')
      ? states
      : null,
    'approved executions for all dispatch kinds',
  );

  await new Promise(resolveDelay => setTimeout(resolveDelay, 250));

  for (const fixture of fixtures) {
    const runs = probe.prepare(`
      SELECT * FROM runs
      WHERE job_id = ? AND approval_used IS NOT NULL
    `).all(fixture.job.id);
    assert.equal(runs.length, 1, `${fixture.kind} did not execute exactly once`);
    assert.equal(runs[0].status, 'ok');
    assert.equal(JSON.parse(runs[0].structured_output).kind, fixture.kind);
    assert.equal(JSON.parse(runs[0].verification_result).status, 'passed');
    const approvalUsed = JSON.parse(runs[0].approval_used);
    assert.equal(approvalUsed.approval_id, fixture.approval.id);
    assert.equal(approvalUsed.status, 'dispatching');
    assert.equal(approvalUsed.decision_status, 'approved');
    assert.equal(approvalUsed.dispatch_queue_id, fixture.dispatch.id);
    assert.match(approvalUsed.approver, /^local-user:/);
    assert.equal(approvalUsed.resolved_by, approvalUsed.approver);
    assert.equal(approvalUsed.reason, `approved ${fixture.dispatch.id}`);
    assert.equal(approvalUsed.risk_level, 'high');
    assert.equal(approvalUsed.approver_scope, null);
    for (const field of ['requested_at', 'expires_at', 'resolved_at', 'approved_at']) {
      assert.match(approvalUsed[field], /^\d{4}-\d{2}-\d{2}/, `${fixture.kind} approval_used.${field}`);
    }
    assert.match(approvalUsed.binding_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(existsSync(fixture.marker), true);
    assert.equal(
      readFileSync(fixture.marker, 'utf8'),
      'complete\n',
      `${fixture.kind} executed user code more than once`,
    );

    const approval = probe.prepare('SELECT * FROM approvals WHERE id = ?').get(fixture.approval.id);
    assert.equal(approval.status, 'dispatched');
    assert.match(approval.dispatched_at, /^\d{4}-\d{2}-\d{2}/);
    const gateRun = probe.prepare('SELECT * FROM runs WHERE id = ?').get(fixture.approval.run_id);
    assert.equal(gateRun.status, 'skipped');
    assert.equal(gateRun.verification_result, null);
    assert.match(gateRun.finished_at, /^\d{4}-\d{2}-\d{2}/);
    assert.match(gateRun.terminal_transition_at, /^\d{4}-\d{2}-\d{2}/);
    const queue = probe.prepare('SELECT * FROM job_dispatch_queue WHERE id = ?').get(fixture.dispatch.id);
    assert.equal(queue.status, 'done');
    assert.match(queue.processed_at, /^\d{4}-\d{2}-\d{2}/);

    if (fixture.kind === 'chain') {
      assert.equal(runs[0].triggered_by_run, parentRun.id);
    }
    if (fixture.kind === 'retry') {
      assert.equal(runs[0].retry_of, fixture.retryOfRunId);
      assert.equal(runs[0].triggered_by_run, fixture.retryOfRunId);
      assert.equal(fixture.dispatch.source_run_id, fixture.retryOfRunId);
      assert.equal(fixture.dispatch.retry_of_run_id, fixture.retryOfRunId);
    }
  }
});
