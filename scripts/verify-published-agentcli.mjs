#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schedulerCli = join(root, 'cli.js');
const dispatcher = join(root, 'dispatcher.js');
const agentcliBin = process.env.AGENTCLI_BIN
  ? realpathSync(process.env.AGENTCLI_BIN)
  : null;

if (!agentcliBin) {
  throw new Error('AGENTCLI_BIN must point to the installed @amittell/agentcli binary');
}

const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-published-agentcli-'));
const schedulerDb = join(tempRoot, 'scheduler.db');
const schedulerHome = join(tempRoot, 'scheduler-home');
const agentcliHome = join(tempRoot, 'agentcli-home');
const manifestPath = join(tempRoot, 'manifest.json');
const compiledJobPath = join(tempRoot, 'compiled-job.json');
const taskWorkspace = join(tempRoot, "task workspace's");
const primaryMarkerName = 'primary-complete';
const primaryEnvironmentName = 'primary-path';
const primaryMarker = join(taskWorkspace, primaryMarkerName);
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const baseEnv = {
  ...process.env,
  AGENTCLI_HOME: agentcliHome,
  AGENTCLI_SCHEDULER_BIN: schedulerCli,
  AGENTCLI_SCHEDULER_DB: schedulerDb,
  OPENCLAW_SCHEDULER_HOME: schedulerHome,
  SCHEDULER_DB: schedulerDb,
};
mkdirSync(taskWorkspace);

const manifest = {
  version: '0.2',
  workflows: [{
    id: 'published-agentcli-contract',
    name: 'Published agentcli contract',
    tasks: [{
      id: 'verified-output',
      name: 'Published package verified output',
      shell: {
        program: 'sh',
        args: [
          '-c',
          `printf '%s' "$PATH" > ${primaryEnvironmentName} && touch ${primaryMarkerName} && printf '%s\\n' '{"ok":true}'`,
        ],
        cwd: taskWorkspace,
      },
      target: { session_target: 'shell' },
      schedule: { cron: '0 1 * * *' },
      approval: { policy: 'manual', risk_level: 'high', timeout_s: 300 },
      output: { format: 'json' },
      verify: {
        shell: `test "$(cat ${primaryEnvironmentName})" = "$PATH" && test -f ${primaryMarkerName}`,
        timeout_seconds: 5,
        on_failure: 'error',
      },
      delivery: { mode: 'none' },
    }],
  }],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

function parseJsonOutput(result, label) {
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || result.stdout}`);
  const output = String(result.stdout || '').trim();
  assert(output, `${label} returned empty stdout`);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}\n${output}`, { cause: error });
  }
}

function runJson(binary, args, label, env = baseEnv) {
  return parseJsonOutput(spawnSync(process.execPath, [binary, ...args, '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  }), label);
}

function runAgentcli(args, label) {
  return runJson(agentcliBin, args, label);
}

function runScheduler(args, label) {
  return runJson(schedulerCli, args, label);
}

function findApprovalId(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['approval_id', 'id']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findApprovalId(nested);
    if (found) return found;
  }
  return null;
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function poll(label, read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    const accepted = accept(latest);
    if (accepted) return accepted;
    await delay(100);
  }
  throw new Error(`${label} did not reach the expected state: ${JSON.stringify(latest)}`);
}

async function stopDispatcher(child) {
  const exited = () => child.exitCode != null || child.signalCode != null;
  const waitForExit = timeoutMs => new Promise(resolveExit => {
    if (exited()) {
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
  if (!child || exited()) return;
  child.kill('SIGTERM');
  if (await waitForExit(5_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(5_000), true, 'dispatcher did not exit after SIGKILL');
}

function startDispatcher() {
  const child = spawn(process.execPath, [dispatcher], {
    cwd: root,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.assertHealthy = () => {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`dispatcher exited code=${child.exitCode} signal=${child.signalCode}: ${stderr}`);
    }
  };
  return child;
}

let dispatcherChild = null;
try {
  const version = runAgentcli(['version'], 'agentcli version');
  assert.equal(version.package_version, '0.4.1');

  const compiled = runAgentcli(
    ['compile', manifestPath, '--target', 'openclaw-scheduler'],
    'agentcli compile',
  );
  const compiledOutput = compiled.output;
  const compiledJob = compiledOutput?.jobs?.[0];
  assert(compiledJob, 'published agentcli compile returned no scheduler job');
  assert.equal(compiledOutput.handoff?.field_version, '3');
  assert.equal(
    compiledJob.verify_shell,
    `cd ${shellQuote(taskWorkspace)} && 'sh' '-c' ${shellQuote(
      `test "$(cat ${primaryEnvironmentName})" = "$PATH" && test -f ${primaryMarkerName}`,
    )}`,
  );
  assert.equal(compiledJob.verify_timeout_s, 5);
  assert.equal(compiledJob.verify_on_failure, 'error');
  assert.equal(compiledJob.output_format, 'json');

  const grant = runAgentcli([
    'approve', manifestPath, 'verified-output',
    '--workflow', 'published-agentcli-contract',
    '--by', 'published-package-test',
    '--reason', 'black-box conformance',
    '--signer', 'none',
  ], 'agentcli approve');
  const localApprovalId = findApprovalId(grant);
  assert(localApprovalId, 'agentcli approve returned no approval id');
  const executed = runAgentcli([
    'exec', manifestPath, 'verified-output',
    '--workflow', 'published-agentcli-contract',
    '--approval-id', localApprovalId,
    '--signer', 'none',
  ], 'agentcli execute');
  assert.equal(executed.ok, true);
  assert.equal(existsSync(primaryMarker), true, 'agentcli verification did not run after its primary command');
  rmSync(primaryMarker, { force: true });

  const capabilityCheck = runAgentcli([
    'apply', manifestPath,
    '--db', schedulerDb,
    '--scheduler-bin', schedulerCli,
    '--check-capabilities',
  ], 'agentcli capability check');
  assert.equal(capabilityCheck.compatibility?.ok, true);
  const adoptableJob = { ...compiledJob };
  delete adoptableJob.id;
  writeFileSync(compiledJobPath, `${JSON.stringify(adoptableJob, null, 2)}\n`, 'utf8');
  const preexisting = runScheduler(
    ['jobs', 'add', '--file', compiledJobPath],
    'scheduler pre-adoption job',
  );
  const preexistingJobId = preexisting.job?.id;
  assert(preexistingJobId, 'scheduler pre-adoption job returned no id');

  const applied = runAgentcli([
    'apply', manifestPath,
    '--db', schedulerDb,
    '--scheduler-bin', schedulerCli,
    '--adopt-by', 'name',
  ], 'agentcli apply');
  assert.equal(applied.ok, true);
  assert.equal(applied.handoff?.field_version, '3');
  const jobId = applied.actions?.[0]?.job_id;
  assert(jobId, 'agentcli apply returned no job id');
  assert.notEqual(jobId, preexistingJobId, 'agentcli adoption did not replace the preexisting scheduler id');
  const schedulerJobs = runScheduler(['jobs', 'list'], 'scheduler jobs after adoption');
  assert.equal(schedulerJobs.some(job => job.id === preexistingJobId), false);

  const inspectedJobs = runAgentcli([
    'inspect', 'jobs', '--db', schedulerDb,
  ], 'agentcli inspect jobs');
  assert(JSON.stringify(inspectedJobs).includes(jobId));
  assert(JSON.stringify(inspectedJobs).includes('verify_shell'));

  runScheduler(['jobs', 'run', jobId], 'scheduler manual dispatch');
  dispatcherChild = startDispatcher();
  const pendingApproval = await poll(
    'scheduler approval gate',
    () => {
      dispatcherChild.assertHealthy();
      return runScheduler(['approvals', 'list'], 'scheduler approvals list');
    },
    value => {
      const rows = Array.isArray(value) ? value : value.approvals || [];
      return rows.find(row => row.job_id === jobId && row.status === 'pending') || null;
    },
  );

  await stopDispatcher(dispatcherChild);
  dispatcherChild = startDispatcher();
  runScheduler([
    'approvals', 'approve', pendingApproval.id,
    '--reason', 'published package integration approved',
  ], 'scheduler approval decision');

  const completed = await poll(
    'scheduler verified execution',
    () => {
      dispatcherChild.assertHealthy();
      return runScheduler(['runs', 'list', jobId], 'scheduler runs list');
    },
    rows => rows.find(row => row.status === 'ok') || null,
    30_000,
  );
  assert.equal(completed.structured_output_valid, 1);
  assert.deepEqual(JSON.parse(completed.structured_output), { ok: true });
  const verification = JSON.parse(completed.verification_result);
  assert.equal(verification.status, 'passed');
  assert.equal(verification.passed, true);
  assert.equal(existsSync(primaryMarker), true, 'scheduler primary command did not create its marker');
  const approvalUsed = JSON.parse(completed.approval_used);
  assert.equal(approvalUsed.approval_id, pendingApproval.id);
  assert.equal(approvalUsed.decision_status, 'approved');
  assert.equal(approvalUsed.reason, 'published package integration approved');
  assert.equal(approvalUsed.risk_level, 'high');
  assert.equal(approvalUsed.approver_scope, null);
  assert.match(approvalUsed.approver, /^local-user:/);
  assert.match(approvalUsed.binding_hash, /^sha256:[a-f0-9]{64}$/);
  for (const field of ['requested_at', 'expires_at', 'resolved_at', 'approved_at']) {
    assert.match(approvalUsed[field], /^\d{4}-\d{2}-\d{2}/, `approval_used.${field} is missing`);
  }

  const inspectedRuns = runAgentcli([
    'inspect', 'runs', '--db', schedulerDb,
  ], 'agentcli inspect runs');
  assert(JSON.stringify(inspectedRuns).includes(completed.id));
  assert(JSON.stringify(inspectedRuns).includes('verification_result'));

  const doctor = runScheduler(['doctor', '--deep'], 'scheduler doctor');
  assert.equal(doctor.ok, true);
  process.stdout.write('Published @amittell/agentcli 0.4.1 black-box conformance passed.\n');
} finally {
  await stopDispatcher(dispatcherChild);
  rmSync(tempRoot, { recursive: true, force: true });
}
