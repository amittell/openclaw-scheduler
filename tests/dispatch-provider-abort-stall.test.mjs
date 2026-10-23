import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const WATCHER_PATH = join(REPO_DIR, 'dispatch', 'watcher.mjs');
const SCHEMA_SQL = readFileSync(join(REPO_DIR, 'schema.sql'), 'utf8');

const MIN = 60 * 1000;

/**
 * Regression coverage for the 2026-06-27 provider-abort incident:
 *
 * The kebab-rtx6000/qwen3.6-27b provider aborted in-flight model requests
 * fleet-wide. Surviving worker transcripts end with a successful tool write
 * (song_manifest.json, isError=false), then an assistant entry with
 * content=[] / stopReason="aborted" / errorMessage="Request was aborted",
 * plus an openclaw:prompt-error custom entry "This operation was aborted".
 * All real artifacts existed and were valid.
 *
 * Two defects in dispatch/watcher.mjs:
 *   (a) entryHasTurnAborted did not recognize the provider-abort signature
 *       (assistant stopReason="aborted" / openclaw:prompt-error), so such
 *       sessions were NOT classified as a turn abort and fell through to the
 *       stall path.
 *   (b) Both stall branches called emitInterruptedOutcome when
 *       artifactEvidence.found, then ran markLabelError unconditionally.
 *       emitInterruptedOutcome always exits, so the markLabelError was dead
 *       but misleading code; the branches are restructured into an explicit
 *       if/else so artifact-backed stalls get the interrupted (redispatchable)
 *       outcome and only no-artifact stalls mark error.
 *
 * (1) provider-abort signature + artifacts -> interrupted (turn-abort), not stalled
 * (2) stall branch with artifactEvidence.found=true -> interrupted, not error
 * (3) stall WITHOUT artifacts still marks error
 * (4) non-aborted completed session unchanged (delivered as done)
 */

function makeFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `dispatch-provider-abort-${name}-`));
  // OPENCLAW_STATE_DIR defaults to <HOME>/.openclaw; we set HOME=root in the
  // watcher env, so the session store lives under root/.openclaw.
  const stateDir = join(root, '.openclaw');
  const sessionsDir = join(stateDir, 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const labelsPath = join(root, 'labels.json');
  writeFileSync(labelsPath, '{}\n');
  return { root, stateDir, sessionsDir, labelsPath };
}

function writeTranscript(fix, sessionId, entries) {
  const jsonlPath = join(fix.sessionsDir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return jsonlPath;
}

function writeSessionStore(fix, sessionKey, sessionId, updatedAt) {
  writeFileSync(
    join(fix.sessionsDir, 'sessions.json'),
    JSON.stringify({ [sessionKey]: { sessionId, updatedAt: updatedAt.toISOString(), model: 'test' } }) + '\n',
  );
}

function writeStub(fix, { label, sessionKey, ageMs }) {
  const stubPath = join(fix.root, 'index-stub.mjs');
  writeFileSync(stubPath, `
const sub = process.argv[2];
if (sub === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true, label: ${JSON.stringify(label)}, status: 'running',
    sessionKey: ${JSON.stringify(sessionKey)}, agent: 'main',
    liveness: { ageMs: ${ageMs} }
  }) + '\\n');
} else if (sub === 'result') {
  process.stdout.write(JSON.stringify({ ok: true, label: ${JSON.stringify(label)}, status: 'running' }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
}
`);
  return stubPath;
}

function runWatcher(fix, label, { stubPath, env = {} }) {
  return spawnSync(process.execPath, [
    WATCHER_PATH, '--label', label, '--timeout', '600', '--poll-interval', '20', '--once',
  ], {
    env: {
      ...process.env,
      HOME: fix.root,
      DISPATCH_INDEX_PATH: stubPath,
      DISPATCH_STATE_DIR: dirname(fix.labelsPath),
      DISPATCH_LABELS_PATH: fix.labelsPath,
      OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1',
      ...env,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function readLabels(fix) {
  return JSON.parse(readFileSync(fix.labelsPath, 'utf8'));
}

test('(1) provider-abort signature + artifacts -> interrupted (turn-abort), not stalled', () => {
  const fix = makeFixture('abort');
  try {
    const label = 'abort-x';
    const sessionKey = 'agent:main:subagent:abort-x';
    const sessionId = 'abort-x-session';
    const now = Date.now();
    // Recent activity (within the idle-failure window) so this is NOT a stall;
    // the only terminal signal is the provider-abort signature in the tail.
    writeSessionStore(fix, sessionKey, sessionId, new Date(now - 5 * MIN));
    const jsonlPath = writeTranscript(fix, sessionId, [
      { role: 'toolResult', isError: false, content: 'Wrote song_manifest.json (3058 bytes)' },
      { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' },
      { type: 'custom', customType: 'openclaw:prompt-error', data: { error: 'This operation was aborted' } },
    ]);
    utimesSync(jsonlPath, new Date(now - 5 * MIN), new Date(now - 5 * MIN));
    const stubPath = writeStub(fix, { label, sessionKey, ageMs: 15 * MIN });
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey, status: 'interrupted', agent: 'main', thinking: 'high',
        timeoutSeconds: 600, spawnedAt: new Date(now - 90 * MIN).toISOString(),
        lastPing: new Date().toISOString(),
      },
    }) + '\n');

    const run = runWatcher(fix, label, { stubPath });
    const labels = readLabels(fix);

    assert.equal(run.status, 0, `watcher must stay pending; stderr=${run.stderr} stdout=${run.stdout}`);
    assert.equal((run.stdout || '').trim(), '', 'stdout must stay empty on a pending tick');
    assert.match(run.stderr || '', /turn_aborted observed/,
      'provider-abort signature must be classified as a turn abort');
    assert.match(run.stderr || '', /interrupted redispatch scheduled/,
      'must schedule a redispatch (interrupted, not error)');
    assert.equal(labels[label].status, 'running', 'label reset to running while redispatch pending');
    assert.equal(labels[label].interruptRetryCount, 1, 'redispatch counter incremented');
    assert.equal(labels[label].error, undefined, 'no error marked');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(2) stall branch with artifactEvidence.found=true -> interrupted, not error', () => {
  const fix = makeFixture('stall-artifacts');
  try {
    const label = 'stall-art';
    const sessionKey = 'agent:main:subagent:stall-art';
    const sessionId = 'stall-art-session';
    const now = Date.now();
    const stale = new Date(now - 130 * MIN);
    // Stale activity -> genuine stall, but with a real artifact in the tail.
    writeSessionStore(fix, sessionKey, sessionId, stale);
    const jsonlPath = writeTranscript(fix, sessionId, [
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-artifact', output: 'Wrote /tmp/rendered-video.mp4 (9.3 MB)' } },
    ]);
    utimesSync(jsonlPath, stale, stale);
    const stubPath = writeStub(fix, { label, sessionKey, ageMs: 130 * MIN });
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey, status: 'interrupted', agent: 'main', thinking: 'high',
        timeoutSeconds: 600, spawnedAt: new Date(now - 90 * MIN).toISOString(),
        lastPing: new Date().toISOString(),
      },
    }) + '\n');

    const run = runWatcher(fix, label, { stubPath });
    const labels = readLabels(fix);

    assert.equal(run.status, 0, `watcher must stay pending; stderr=${run.stderr} stdout=${run.stdout}`);
    assert.equal((run.stdout || '').trim(), '', 'stdout must stay empty on a pending tick');
    assert.match(run.stderr || '', /interrupted redispatch scheduled/,
      'artifact-backed stall must schedule a redispatch (interrupted outcome)');
    assert.match(run.stderr || '', /interrupted after producing artifacts/,
      'artifact evidence must be surfaced');
    assert.equal(labels[label].status, 'running', 'label reset to running while redispatch pending');
    assert.equal(labels[label].interruptRetryCount, 1, 'redispatch counter incremented');
    assert.equal(labels[label].error, undefined, 'no error marked for an artifact-backed stall');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(3) stall WITHOUT artifacts still marks error', () => {
  const fix = makeFixture('stall-noartifacts');
  try {
    const label = 'stall-noart';
    const sessionKey = 'agent:main:subagent:stall-noart';
    const sessionId = 'stall-noart-session';
    const now = Date.now();
    const stale = new Date(now - 130 * MIN);
    // Stale activity, NO artifact, NO abort signature.
    writeSessionStore(fix, sessionKey, sessionId, stale);
    const jsonlPath = writeTranscript(fix, sessionId, [
      { role: 'user', content: 'do the thing' },
    ]);
    utimesSync(jsonlPath, stale, stale);
    const stubPath = writeStub(fix, { label, sessionKey, ageMs: 130 * MIN });
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey, status: 'running', agent: 'main', thinking: 'high',
        timeoutSeconds: 600, spawnedAt: new Date(now - 90 * MIN).toISOString(),
        lastPing: new Date().toISOString(),
      },
    }) + '\n');

    const run = runWatcher(fix, label, { stubPath });
    const labels = readLabels(fix);

    assert.equal(run.status, 0, `watcher must exit cleanly; stderr=${run.stderr} stdout=${run.stdout}`);
    assert.match(run.stderr || '', /agent session stalled/, 'stall reason must be logged');
    assert.match(run.stdout || '', /❌ \*dispatch\* \[stall-noart\] failed/, 'must report failure on stdout');
    assert.equal(labels[label].status, 'error', 'no-artifact stall must mark error');
    assert.match(labels[label].error || '', /agent session stalled/, 'error summary must be the stall reason');
    assert.equal(labels[label].interruptRetryCount, undefined, 'no redispatch scheduled for a no-artifact stall');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});

test('(4) non-aborted completed session unchanged (delivered as done)', () => {
  const fix = makeFixture('completed');
  try {
    const label = 'done-x';
    const sessionKey = 'agent:main:subagent:done-x';
    const sessionId = 'done-x-session';
    const now = Date.now();
    // Clean end_turn completion (meaningful reply), recent activity, NO abort.
    writeSessionStore(fix, sessionKey, sessionId, new Date(now - 5 * MIN));
    const jsonlPath = writeTranscript(fix, sessionId, [
      { role: 'user', content: 'do the thing' },
      // Real OpenClaw legacy JSONL uses stop_reason (snake_case) on assistant rows.
      { role: 'assistant', content: [{ type: 'text', text: 'All done. The file was written and verified.' }], stop_reason: 'end_turn' },
    ]);
    utimesSync(jsonlPath, new Date(now - 5 * MIN), new Date(now - 5 * MIN));
    const stubPath = writeStub(fix, { label, sessionKey, ageMs: 15 * MIN });
    // Initialize the scheduler DB for the completion delivery path.
    const dbPath = join(fix.root, 'scheduler.db');
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    db.close();
    writeFileSync(fix.labelsPath, JSON.stringify({
      [label]: {
        sessionKey, status: 'running', agent: 'main', thinking: 'high',
        timeoutSeconds: 600, spawnedAt: new Date(now - 90 * MIN).toISOString(),
        lastPing: new Date().toISOString(),
        deliverTo: '484946046', deliveryMode: 'announce', deliverChannel: 'telegram',
      },
    }) + '\n');

    const run = runWatcher(fix, label, { stubPath, env: { SCHEDULER_DB: dbPath } });
    const labels = readLabels(fix);

    assert.equal(run.status, 0, `watcher must exit cleanly; stderr=${run.stderr} stdout=${run.stdout}`);
    assert.equal(labels[label].status, 'done', 'clean completion must be delivered as done');
    assert.doesNotMatch(run.stderr || '', /turn_aborted observed/,
      'a non-aborted session must NOT be misclassified as a turn abort');
    assert.equal(labels[label].interruptRetryCount, undefined, 'no redispatch scheduled for a clean completion');
  } finally {
    rmSync(fix.root, { recursive: true, force: true });
  }
});
