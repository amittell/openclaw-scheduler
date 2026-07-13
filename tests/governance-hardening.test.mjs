import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGovernance,
  assertGovernance,
  buildShellEnvironment,
  clearMaterializedEnvironment,
} from '../governance.js';
import { createDispatcherRuntime } from '../dispatcher-runtime.js';
import {
  completeRunFenced,
  commitCompletionBookkeeping,
  shouldRunPostCompletionEffects,
} from '../run-completion.js';
import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { createJob, getJob, updateJob } from '../jobs.js';
import { createRun, finishRun, getRun, getTimedOutRuns } from '../runs.js';
import {
  cleanupDispatchMaterialization,
  finalizeDispatch,
  redactOutcomesForPersistence,
} from '../dispatcher-strategies.js';

function shellJob(overrides = {}) {
  return {
    id: 'job-1',
    session_target: 'shell',
    shell_env_policy: 'minimal',
    ...overrides,
  };
}

test('governance permits enforceable defaults and records the environment policy', () => {
  const result = evaluateGovernance(shellJob());
  assert.equal(result.allowed, true);
  assert.equal(result.policy.shell_env_policy, 'minimal');
  assert.deepEqual(result.violations, []);
});

test('governance rejects declared isolation instead of silently treating it as advisory', () => {
  const result = evaluateGovernance(shellJob({
    contract_sandbox: 'strict',
    contract_network: 'restricted',
    contract_allowed_paths: JSON.stringify(['/tmp']),
  }));
  assert.equal(result.allowed, false);
  assert.match(result.violations.join('\n'), /sandbox/i);
  assert.match(result.violations.join('\n'), /network/i);
  assert.match(result.violations.join('\n'), /filesystem path/i);
  assert.throws(() => assertGovernance(shellJob({ contract_sandbox: 'strict' })), {
    code: 'SCHEDULER_GOVERNANCE_DENIED',
  });
});

test('governance fails closed for unknown restrictive object shapes', () => {
  const result = evaluateGovernance(shellJob({
    contract_sandbox: JSON.stringify({ filesystem: 'read-only' }),
    contract_network: JSON.stringify({ allowlist: ['example.com'] }),
  }));
  assert.equal(result.allowed, false);
  assert.match(result.violations.join('\n'), /sandbox/i);
  assert.match(result.violations.join('\n'), /network/i);

  const open = evaluateGovernance(shellJob({
    contract_sandbox: JSON.stringify({ isolation: 'host' }),
    contract_network: JSON.stringify({ egress: 'unrestricted' }),
  }));
  assert.equal(open.allowed, true);
});

test('agent cost contracts fail closed when the gateway cannot meter dollars', () => {
  const result = evaluateGovernance({
    id: 'agent-job',
    session_target: 'isolated',
    shell_env_policy: 'minimal',
    contract_max_cost_usd: 1,
  });
  assert.equal(result.allowed, false);
  assert.match(result.violations.join('\n'), /cost metering/i);
  const shellResult = evaluateGovernance(shellJob({ contract_max_cost_usd: 0 }));
  assert.equal(shellResult.allowed, false);
  assert.match(shellResult.violations.join('\n'), /cost metering/i);
  assert.equal(evaluateGovernance(
    shellJob({ contract_max_cost_usd: 0 }),
    { costMetered: true },
  ).allowed, true);
});

test('minimal shell environments exclude dispatcher secrets and add materialized credentials explicitly', () => {
  const baseEnv = {
    HOME: '/Users/test',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    DATABASE_PASSWORD: 'must-not-leak',
    OPENAI_API_KEY: 'must-not-leak',
  };
  const env = buildShellEnvironment(shellJob(), { SCOPED_TOKEN: 'ephemeral' }, baseEnv);
  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.SCOPED_TOKEN, 'ephemeral');
  assert.equal(env.DATABASE_PASSWORD, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('legacy inherit policy is explicit and cleanup clears mutable credential state', () => {
  const materialized = { SCOPED_TOKEN: 'ephemeral' };
  const env = buildShellEnvironment(
    shellJob({ shell_env_policy: 'inherit' }),
    materialized,
    { PATH: '/bin', LEGACY_TOKEN: 'preserved-for-migrated-job' },
  );
  assert.equal(env.LEGACY_TOKEN, 'preserved-for-migrated-job');
  clearMaterializedEnvironment(materialized);
  clearMaterializedEnvironment(env);
  assert.deepEqual(materialized, {});
  assert.deepEqual(env, {});
});

test('dispatcher runtime bounds concurrency, deduplicates keys, and fences lease renewal', async () => {
  let token = 7;
  let leaseValid = true;
  let active = 0;
  let peak = 0;
  const resolvers = [];
  const errors = [];
  const runtime = createDispatcherRuntime({
    ownerId: 'test-owner',
    maxConcurrency: 2,
    acquireLease: (_name, ownerId) => ({ owner_id: ownerId, fencing_token: token }),
    renewLease: (_name, ownerId, fencingToken) => leaseValid && fencingToken === token
      ? { owner_id: ownerId, fencing_token: token }
      : null,
    releaseLease: () => true,
    assertLease: (_name, _ownerId, fencingToken) => leaseValid && fencingToken === token,
    onTaskError: error => errors.push(error),
  });
  assert.equal(runtime.start().fencing_token, 7);

  const task = () => new Promise(resolve => {
    active += 1;
    peak = Math.max(peak, active);
    resolvers.push(() => {
      active -= 1;
      resolve();
    });
  });
  assert.equal(runtime.submit('a', task), true);
  assert.equal(runtime.submit('a', task), false);
  assert.equal(runtime.submit('b', task), true);
  assert.equal(runtime.submit('c', task), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 2);
  resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 2);
  while (resolvers.length > 0) resolvers.shift()();
  await runtime.waitForIdle();
  assert.equal(peak, 2);
  assert.deepEqual(errors, []);

  leaseValid = false;
  assert.equal(runtime.renew(), null);
  assert.equal(runtime.submit('after-loss', task), false);
  await runtime.stop();
});

test('fenced completion makes cancellation win and suppresses post-run effects', () => {
  const transitionRunTerminal = (runId, status, fields, fencing) => ({
    changed: true,
    fenced: false,
    run: {
      id: runId,
      ...fields,
      status: 'cancelled',
      cancel_requested_at: '2026-07-10 23:00:00',
      dispatcher_owner: fencing.ownerId,
    },
  });
  const completion = completeRunFenced({
    runId: 'run-1',
    status: 'ok',
    fields: { summary: 'late success' },
    ownerId: 'owner-1',
    fencingToken: 9,
    transitionRunTerminal,
  });
  assert.equal(completion.cancelled, true);
  assert.equal(completion.status, 'cancelled');
  assert.equal(shouldRunPostCompletionEffects(completion), false);
});

test('provider session descriptions cannot reintroduce raw credentials', () => {
  const outcomes = {
    identity_resolved: {
      provider: 'hostile-description-provider',
      session: { credentials: { token: 'raw-secret' }, subject: { principal: 'svc:test' } },
    },
  };
  const redacted = redactOutcomesForPersistence(outcomes, {
    getIdentityProvider: () => ({
      describeSession(session) {
        return session;
      },
    }),
  });
  assert.equal(Object.hasOwn(redacted.identity_resolved.session, 'credentials'), false);
  assert.deepEqual(outcomes.identity_resolved.session.credentials, { token: 'raw-secret' });
});

test('completion bookkeeping executes through the database transaction boundary', () => {
  let transactionCalls = 0;
  const db = {
    transaction(callback) {
      return () => {
        transactionCalls += 1;
        return callback();
      };
    },
  };
  const value = commitCompletionBookkeeping(db, () => 42);
  assert.equal(value, 42);
  assert.equal(transactionCalls, 1);
});

test('sub-second run timeouts use millisecond dispatch timestamps', async () => {
  setDbPath(':memory:');
  await initDb();
  try {
    const job = createJob({
      name: 'sub-second-timeout',
      schedule_cron: '0 0 1 1 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'sleep 1',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 100,
      origin: 'system',
    });
    const run = createRun(job.id, {
      run_timeout_ms: 100,
      ownerId: 'precision-owner',
      fencingToken: 1,
    });
    assert.equal(getTimedOutRuns().some(candidate => candidate.id === run.id), false);
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(getTimedOutRuns().some(candidate => candidate.id === run.id), true);
  } finally {
    closeDb();
  }
});

test('credential cleanup exhaustion is durable and converts success into a non-retried error', async () => {
  setDbPath(':memory:');
  await initDb();
  try {
    const job = createJob({
      name: 'cleanup-failure-propagation',
      schedule_cron: '0 0 1 1 *',
      session_target: 'shell',
      payload_kind: 'shellCommand',
      payload_message: 'true',
      delivery_mode: 'none',
      delivery_opt_out_reason: 'test',
      run_timeout_ms: 1_000,
      origin: 'system',
    });
    const run = createRun(job.id);
    let cleanupCalls = 0;
    let retryChecks = 0;
    const statuses = [];
    const ctx = {
      run,
      idemKey: null,
      dispatchRecord: null,
      materializedEnv: { SCOPED_TOKEN: 'secret' },
      executionEnv: { SCOPED_TOKEN: 'secret' },
      materializationCleanup: {
        provider: {
          async cleanup() {
            cleanupCalls += 1;
            throw new Error('simulated revocation outage');
          },
        },
        cleanupState: { reference: 'opaque-cleanup-reference' },
      },
    };
    const deps = {
      finishRun,
      updateIdempotencyResultHash: () => {},
      releaseIdempotencyKey: () => {},
      setAgentStatus: () => {},
      handleDelivery: () => null,
      shouldRetry: () => {
        retryChecks += 1;
        return true;
      },
      scheduleRetry: () => {
        throw new Error('cleanup failure must not re-execute user work');
      },
      getDb,
      updateJobAfterRun: (_job, status) => statuses.push(status),
      updateJob,
      setDispatchStatus: () => null,
      handleTriggeredChildren: () => {},
      dequeueJob: () => false,
      log: () => {},
      clearMaterializedEnvironment,
      materializationCleanupRetryDelaysMs: [0, 0],
    };

    await finalizeDispatch(job, ctx, {
      status: 'ok',
      summary: 'user work completed',
      content: 'user work completed',
      errorMessage: null,
      runFinishFields: {},
      deliveryOverride: null,
      skipDelivery: true,
      skipJobUpdate: false,
      skipChildren: false,
      skipDequeue: true,
      skipAgentCleanup: true,
      idemAction: 'noop',
      retryFiresChildren: false,
      earlyReturn: false,
    }, deps);

    assert.equal(cleanupCalls, 2);
    assert.equal(await cleanupDispatchMaterialization(job, ctx, deps), false);
    assert.equal(cleanupCalls, 2, 'exhausted cleanup result must not be misreported or retried implicitly');
    assert.equal(retryChecks, 0, 'cleanup failure must not repeat side-effectful user work');
    assert.deepEqual(statuses, ['error']);
    assert.equal(getRun(run.id).status, 'error');
    assert.equal(getJob(job.id).enabled, 0);
    assert.match(getRun(run.id).error_message, /Credential cleanup failed after 2 attempts/);
    assert.deepEqual(ctx.materializedEnv, {});
    assert.deepEqual(ctx.executionEnv, {});
  } finally {
    closeDb();
  }
});
