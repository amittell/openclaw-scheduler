import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { initDb, closeDb, getDb, setDbPath } from '../db.js';
import { createJob } from '../jobs.js';
import { enqueueDelivery, getDelivery } from '../delivery-outbox.js';
import { drainDeliveryOutbox } from '../scripts/inbox-consumer.mjs';
import { deliverMessage, resolveDeliveryAccountId } from '../gateway.js';
import { executeAgent } from '../dispatcher-strategies.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-delivery-account-'));
const dbPath = join(tempRoot, 'scheduler.db');
const configPath = join(tempRoot, 'openclaw.json');
const config = {
  bindings: [
    { agentId: 'main', match: { channel: 'telegram', accountId: 'default' } },
    { agentId: 'ailybot', match: { channel: 'telegram', accountId: 'ailybot' } },
    { agentId: 'main', match: { channel: 'telegram', accountId: '*' } },
    { agentId: 'wildcard-only', match: { channel: 'telegram', accountId: '*' } },
  ],
};
const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;

function shellJob(name, agentId) {
  return createJob({
    name,
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf test',
    run_timeout_ms: 60_000,
    delivery_mode: 'none',
    origin: 'system',
    agent_id: agentId,
  });
}

before(async () => {
  writeFileSync(configPath, JSON.stringify(config));
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  setDbPath(dbPath);
  await initDb();
});

beforeEach(() => {
  getDb().exec('DELETE FROM delivery_outbox; DELETE FROM jobs;');
});

after(() => {
  closeDb();
  if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
  rmSync(tempRoot, { recursive: true, force: true });
});

test('an agent delivers through the account its binding names', () => {
  assert.equal(resolveDeliveryAccountId('ailybot', 'telegram', { config }), 'ailybot');
  assert.equal(resolveDeliveryAccountId('ailybot', 'Telegram', { config }), 'ailybot');
  // Read from the OpenClaw config file when no config is passed.
  assert.equal(resolveDeliveryAccountId('ailybot', 'telegram'), 'ailybot');
  // main keeps the gateway default; wildcards, other channels and unknown agents name nothing.
  assert.equal(resolveDeliveryAccountId('main', 'telegram', { config }), undefined);
  assert.equal(resolveDeliveryAccountId('wildcard-only', 'telegram', { config }), undefined);
  assert.equal(resolveDeliveryAccountId('ailybot', 'slack', { config }), undefined);
  assert.equal(resolveDeliveryAccountId('unknown', 'telegram', { config }), undefined);
  assert.equal(resolveDeliveryAccountId(undefined, 'telegram', { config }), undefined);
  assert.equal(resolveDeliveryAccountId('ailybot', 'telegram', { config: {} }), undefined);
});

test('deliverMessage sends as the owning agent\'s account and leaves main unchanged', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: { ok: true } }; },
      async text() { return ''; },
    };
  };
  try {
    await deliverMessage('telegram', '-1004461251264', 'from ailybot', { agentId: 'ailybot' });
    await deliverMessage('telegram', '484946046', 'from main', { agentId: 'main' });
    await deliverMessage('telegram', '484946046', 'no owner');
    await deliverMessage('telegram', '-100123', 'explicit', { accountId: 'ratbot', agentId: 'ailybot' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0].tool, 'message');
  assert.equal(bodies[0].args.accountId, 'ailybot');
  assert.equal(bodies[0].args.target, '-1004461251264');
  assert.equal('accountId' in bodies[1].args, false);
  assert.equal('accountId' in bodies[2].args, false);
  assert.equal(bodies[3].args.accountId, 'ratbot');
});

test('the outbox consumer delivers each job\'s rows as that job\'s agent', async () => {
  const aily = shellJob('aily-promo-main-watch', 'ailybot');
  const main = shellJob('main-job', 'main');
  const ailyDelivery = enqueueDelivery({ jobId: aily.id, channel: 'telegram', target: '-1004461251264', body: 'aily body' });
  const mainDelivery = enqueueDelivery({ jobId: main.id, channel: 'telegram', target: '484946046', body: 'main body' });
  const looseDelivery = enqueueDelivery({ channel: 'telegram', target: '484946046', body: 'no job' });

  const calls = [];
  const outcome = await drainDeliveryOutbox(getDb(), {
    limit: 10,
    brand: 'Scheduler',
    interDeliveryDelayMs: 0,
    async deliverText(channel, target, text, opts) { calls.push({ target, text, opts }); },
  });

  assert.equal(outcome.delivered, 3);
  const byTarget = Object.fromEntries(calls.map(call => [call.text.includes('aily body') ? 'aily'
    : call.text.includes('main body') ? 'main' : 'loose', call]));
  assert.equal(byTarget.aily.opts.agentId, 'ailybot');
  assert.equal(byTarget.main.opts.agentId, 'main');
  assert.equal(byTarget.loose.opts.agentId, undefined);
  for (const delivery of [ailyDelivery, mainDelivery, looseDelivery]) {
    assert.equal(getDelivery(delivery.id).status, 'delivered');
  }
});

test('outbox attachments go out through the job agent\'s account too', async () => {
  const aily = shellJob('aily-attachment', 'ailybot');
  const sourcePath = join(tempRoot, 'report.txt');
  writeFileSync(sourcePath, 'report');
  enqueueDelivery({ jobId: aily.id, channel: 'telegram', target: '-1004461251264', body: '', attachments: [sourcePath] });

  const mediaCalls = [];
  const outcome = await drainDeliveryOutbox(getDb(), {
    limit: 10,
    brand: 'Scheduler',
    interDeliveryDelayMs: 0,
    async deliverText() {},
    async invokeTool(tool, args) {
      mediaCalls.push({ tool, args });
      return { ok: true, result: { isError: false } };
    },
  });
  assert.equal(outcome.delivered, 1);
  assert.equal(mediaCalls.length, 1);
  assert.equal(mediaCalls[0].args.accountId, 'ailybot');
});

function agentDeps(turn, beats) {
  return {
    waitForGateway: async () => true,
    updateRunSession: () => {},
    setAgentStatus: () => {},
    buildJobPrompt: () => ({ prompt: 'long turn', contextMeta: {} }),
    updateContextSummary: () => {},
    matchesSentinel: () => false,
    detectTransientError: () => false,
    sqliteNow: () => 'next-dispatch',
    log: () => {},
    prepareAgentSelection: async (_key, overrides) => ({ ok: true, applied: false, model: overrides.modelRef || undefined }),
    runIsolatedAgentTurn: turn,
    updateHeartbeat: runId => beats.push({ runId, at: Date.now() }),
    runHeartbeatIntervalMs: 20,
  };
}

const agentJob = {
  id: 'heartbeat-agent-job',
  name: 'Heartbeat Agent Job',
  agent_id: 'ailybot',
  payload_timeout_seconds: 120,
  run_timeout_ms: 10_000,
  delivery_mode: 'none',
};

test('an agent turn keeps its run heartbeat current until the turn ends', async () => {
  const beats = [];
  const result = await executeAgent(agentJob, { run: { id: 'heartbeat-run' }, v02Outcomes: {} },
    agentDeps(async () => {
      await new Promise(resolveTurn => setTimeout(resolveTurn, 150));
      return { content: 'long answer', usage: { total_tokens: 1 } };
    }, beats));
  assert.equal(result.status, 'ok');
  // One beat at start, then one every 20 ms while the 150 ms turn ran.
  assert.ok(beats.length >= 4, `expected at least 4 heartbeats, got ${beats.length}`);
  assert.ok(beats.every(beat => beat.runId === 'heartbeat-run'));
  const settled = beats.length;
  await new Promise(resolveWait => setTimeout(resolveWait, 80));
  assert.equal(beats.length, settled, 'heartbeats must stop when the turn ends');
});

test('a failed agent turn also stops its heartbeat', async () => {
  const beats = [];
  await assert.rejects(
    executeAgent(agentJob, { run: { id: 'failed-heartbeat-run' }, v02Outcomes: {} },
      agentDeps(async () => {
        await new Promise(resolveTurn => setTimeout(resolveTurn, 60));
        throw new Error('model unavailable');
      }, beats)),
    /model unavailable/,
  );
  assert.ok(beats.length >= 2);
  const settled = beats.length;
  await new Promise(resolveWait => setTimeout(resolveWait, 80));
  assert.equal(beats.length, settled);
});
