import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { closeDb, getDb, initDb, setDbPath } from '../db.js';
import { checkTaskTrackers } from '../dispatcher-maintenance.js';
import {
  agentCompleted,
  checkDeadAgents,
  checkGroupCompletion,
  createTaskGroup,
  getTaskGroup,
  getTaskGroupStatus,
  listActiveTaskGroups,
  registerAgentSession,
  touchAgentHeartbeat,
} from '../task-tracker.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-tracker-poll-'));
const sessionKey = 'agent:main:subagent:tracker-poll-fixture';
const staleHeartbeat = '2000-01-01 00:00:00';
const requests = [];
let listedSessions = [];
let server;
let gateway;
let previousUrl;
let previousToken;

before(async () => {
  setDbPath(join(tempRoot, 'scheduler.db'));
  await initDb();
  server = createServer((req, res) => {
    let bytes = '';
    req.on('data', chunk => { bytes += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: bytes ? JSON.parse(bytes) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { sessions: listedSessions } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  previousUrl = process.env.OPENCLAW_GATEWAY_URL;
  previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'fixture-token';
  // gateway.js reads the Gateway URL at import time; the query gives this file
  // its own instance bound to the stub. It still shares db.js with the test.
  gateway = await import('../gateway.js?task-tracker-session-poll');
});

beforeEach(() => {
  getDb().exec('DELETE FROM task_tracker');
  listedSessions = [];
});

after(async () => {
  closeDb();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (previousUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
  else process.env.OPENCLAW_GATEWAY_URL = previousUrl;
  if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
  rmSync(tempRoot, { recursive: true, force: true });
});

// One task-tracker pass, wired exactly as the dispatcher's maintenance tick
// wires it. Returns every request the stub Gateway received during the pass.
async function maintenancePass() {
  const first = requests.length;
  const logs = [];
  await checkTaskTrackers({
    log: (level, message) => logs.push(`${level}: ${message}`),
    getDb,
    getAllSubAgentSessions: gateway.getAllSubAgentSessions,
    touchAgentHeartbeat,
    checkDeadAgents,
    listActiveTaskGroups,
    checkGroupCompletion,
    getTaskGroupStatus,
    resolveDeliveryAlias: () => null,
    deliverMessage: async () => { throw new Error('fixture trackers have no delivery target'); },
  });
  assert.deepEqual(logs.filter(line => /skipped|error/i.test(line)), []);
  return requests.slice(first);
}

function heartbeatOf(trackerId, label) {
  return getDb().prepare(
    'SELECT last_heartbeat FROM task_tracker_agents WHERE tracker_id = ? AND agent_label = ?',
  ).get(trackerId, label).last_heartbeat;
}

test('no Gateway session poll while no active tracker agent has a session key', async () => {
  assert.deepEqual(await maintenancePass(), [], 'no trackers at all');

  const group = createTaskGroup({ name: 'unregistered', expectedAgents: ['worker'], timeoutS: 3600, createdBy: 'test' });
  assert.deepEqual(await maintenancePass(), [], 'active tracker whose agent has no session key');

  // The public API stores an empty key as given; no listed session can match it.
  registerAgentSession(group.id, 'worker', '');
  assert.deepEqual(await maintenancePass(), [], 'running agent with an empty session key');
});

test('polling resumes for a registered active agent and stops once it completes', async () => {
  const group = createTaskGroup({ name: 'registered', expectedAgents: ['worker'], timeoutS: 3600, createdBy: 'test' });
  registerAgentSession(group.id, 'worker', sessionKey);
  getDb().prepare('UPDATE task_tracker_agents SET last_heartbeat = ? WHERE tracker_id = ?')
    .run(staleHeartbeat, group.id);
  listedSessions = [{ key: sessionKey }];

  const polled = await maintenancePass();
  assert.equal(polled.length, 1);
  assert.equal(polled[0].url, '/tools/invoke');
  assert.equal(polled[0].body.tool, 'sessions_list');
  assert.equal(polled[0].body.sessionKey, 'main');
  assert.deepEqual(polled[0].body.args, { activeMinutes: 10, limit: 200, kinds: ['subagent'], messageLimit: 0 });
  assert.notEqual(heartbeatOf(group.id, 'worker'), staleHeartbeat, 'the listed session refreshed the heartbeat');

  agentCompleted(group.id, 'worker', 'done');
  assert.deepEqual(await maintenancePass(), [], 'completed agent');
  assert.equal(getTaskGroup(group.id).status, 'completed');
  assert.deepEqual(await maintenancePass(), [], 'completed tracker');
});
