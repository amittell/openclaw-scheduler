import './isolate-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyBundledSchema, closeDb, getDb, setDbPath } from '../db.js';
import { splitDeliveryBody } from '../delivery-outbox.js';
import { buildTerminalCompletionPayload, resolveCompletionDelivery } from '../dispatch/completion.mjs';
import { enqueueCompletionNotification } from '../dispatch/hooks.mjs';

const MAX_BYTES = 3400;
const RUN_ID = 'run-output-boundary-65';
const CHECKLIST = { work_complete: true };
const WATCHER = fileURLToPath(new URL('../dispatch/watcher.mjs', import.meta.url));

function humanReport(tail = '') {
  return [
    'Root cause:', 'The export window closed before the feed finished.', '',
    'Files changed:', '- jobs/export.yaml extends the import window.', '',
    'Validation:', '- Both import runs finished with no skipped rows.', '',
    'Notes:', tail || 'The next scheduled run uses the same settings.',
  ].join('\n').trimEnd();
}

function cueDump(cues = true) {
  return [cues ? 'Root cause:' : '**Observations**',
    ...Array.from({ length: 1500 }, (_, i) => `2026-10-01T12:34:56 INFO worker row=${i} repeated diagnostic record`),
    cues ? 'Validation:' : '**Measurements**', '- Raw machine output follows above.',
  ].join('\n');
}

function resolveBoth(summary) {
  const completion = buildTerminalCompletionPayload({ summary, checklist: CHECKLIST });
  assert.equal(completion.summary, summary, 'the stored source report is not truncated');
  return [
    resolveCompletionDelivery({ completion, fallbackSummary: summary, runId: RUN_ID }),
    resolveCompletionDelivery({ lastReply: summary, completion, fallbackSummary: summary, runId: RUN_ID }),
  ];
}

function assertBounded(text) {
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_BYTES, `body has ${Buffer.byteLength(text)} bytes`);
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, 'UTF-8 round trip');
  assert.equal(splitDeliveryBody(`✅ [boundary-test] done\n\n${text}`, { channel: 'telegram' }).length, 1);
}

test('cue-word log dumps cannot bypass the done or watcher delivery boundary', () => {
  for (const cues of [true, false]) {
    const raw = cueDump(cues);
    assert.ok(raw.length > 90_000);
    for (const result of resolveBoth(raw)) {
      assertBounded(result.deliveryText);
      assert.ok(result.deliveryText.length < 2000, 'machine output is summarized, not prefix-truncated as a report');
      assert.ok(!result.deliveryText.includes('row=1499'));
    }
  }
});

test('cue words do not promote small JSON, stack, TAP, env or escape dumps to human reports', () => {
  const cases = [
    '{"sample": "value"}',
    '    at run (/tmp/synthetic.js:12:3)',
    'ok 1 case a\nok 2 case b\nok 3 case c',
    'SYNTHETIC_A=1\nSYNTHETIC_B=2\nSYNTHETIC_C=3',
    `${String.fromCharCode(27)}[2Jterminal output`,
  ];
  for (const machine of cases) {
    const raw = `Root cause:\n${machine}\n\nValidation:\n- Raw observations above.\n- Nothing else recorded.`;
    for (const result of resolveBoth(raw)) {
      assertBounded(result.deliveryText);
      assert.notEqual(result.deliveryText, raw, 'machine markers precede both cue-report fast paths');
    }
  }
});

test('long human reports retain substantive sections, checks and a bounded run reference', () => {
  for (const tail of ['The counts matched after each import. '.repeat(250), '导入已完成🙂 '.repeat(700)]) {
    const raw = humanReport(tail);
    for (const result of resolveBoth(raw)) {
      assertBounded(result.deliveryText);
      for (const section of ['Root cause:', 'Files changed:', 'Validation:', 'Notes:']) {
        assert.ok(result.deliveryText.includes(section), section);
      }
      assert.ok(result.deliveryText.endsWith(`Full text remains in run ${RUN_ID}.`));
      assert.ok(result.deliveryText.includes('Both import runs finished with no skipped rows.'));
    }
  }
});

test('long domain reports without cue words receive the same section-preserving bound', () => {
  const raw = `**Item 1**\nThe sound aligns with the picture.\n**Re-verify**\nThe speaker starts on time.\n**Staged**\n${'The edited segment is ready for the next viewing. '.repeat(250)}`.trimEnd();
  for (const result of resolveBoth(raw)) {
    assertBounded(result.deliveryText);
    assert.ok(result.deliveryText.startsWith('**Item 1**\nThe sound aligns with the picture.'));
    assert.ok(result.deliveryText.includes('**Staged**'));
    assert.ok(result.deliveryText.endsWith(`Full text remains in run ${RUN_ID}.`));
  }
});

test('a large Results section cannot hide later Validation and Blockers sections', () => {
  const raw = `Summary:\nThe import finished.\n\nResults:\n${'Every accepted row matched its source. '.repeat(500)}\n\nValidation:\nTwo dry runs matched.\n\nBlockers:\nThe production run still needs operator approval.`;
  for (const result of resolveBoth(raw)) {
    assertBounded(result.deliveryText);
    assert.ok(result.deliveryText.includes('Validation:\nTwo dry runs matched.'));
    assert.ok(result.deliveryText.includes('Blockers:\nThe production run still needs operator approval.'));
    const normalized = raw.split('\n').map(line => line.trimEnd()).join('\n');
    assert.ok(result.fullDeliveryText.includes(normalized), 'the full selected report remains available for spill artifacts');
  }
});

test('short and exactly-at-limit human reports remain intact without a continuation notice', () => {
  const short = humanReport();
  const exact = humanReport('x'.repeat(MAX_BYTES - Buffer.byteLength(humanReport('x')) + 1));
  assert.equal(Buffer.byteLength(exact), MAX_BYTES);
  for (const raw of [short, exact]) {
    for (const result of resolveBoth(raw)) assert.equal(result.deliveryText, raw);
  }
});

test('legacy overlong reports are bounded and unselected long reports cannot mark an explicit short lead', () => {
  const raw = humanReport('The export now keeps every row. '.repeat(300));
  const legacy = resolveCompletionDelivery({ completion: { summary_human: raw }, runId: RUN_ID });
  assertBounded(legacy.deliveryText);
  assert.ok(legacy.deliveryText.endsWith(`Full text remains in run ${RUN_ID}.`));
  const completion = buildTerminalCompletionPayload({ summary: raw, checklist: CHECKLIST });
  completion.summary_human = 'The import now keeps every row.';
  const explicit = resolveCompletionDelivery({ completion, runId: RUN_ID });
  assert.equal(explicit.deliveryText, completion.summary_human);
});

test('composed checks and untrusted run references cannot exceed the final byte budget', () => {
  const raw = humanReport('Checked the counts. '.repeat(250));
  for (const runId of [RUN_ID, 'x'.repeat(128), 'x'.repeat(129), 'bad\nreference']) {
    const result = resolveCompletionDelivery({ lastReply: raw, runId,
      completion: { checklist: { work_complete: true, tests_passed: true, pushed: true }, sha: 'deadbeef123' } });
    assertBounded(result.deliveryText);
    assert.ok(result.deliveryText.includes('Checks: tests passed; pushed deadbee.'));
    assert.ok(result.deliveryText.endsWith(!runId.includes('\n') && runId.length <= 128
      ? `Full text remains in run ${runId}.` : 'Full text remains in the run record.'));
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'completion-output-boundary-'));
  const dbPath = join(root, 'scheduler.db');
  setDbPath(dbPath);
  applyBundledSchema('output-boundary fixture');
  closeDb();
  return { root, dbPath, labelsPath: join(root, 'labels.json') };
}

for (const longPath of [false, true]) {
  test(`watcher spill retains later sections, checks and run reference (${longPath ? 'long artifact path' : 'default limit'})`, () => {
    const fix = fixture();
    const label = 'boundary-spill';
    const raw = `Summary:\nThe export finished.\n\nResults:\n${'Every accepted row matched its source. '.repeat(2000).trimEnd()}\n\nValidation:\nTwo independent dry runs matched.\n\nBlockers:\nThe production run still needs operator approval.`;
    const completion = buildTerminalCompletionPayload({ summary: raw,
      checklist: { work_complete: true, tests_passed: true, pushed: true }, sha: 'deadbeef123' });
    const artifacts = longPath ? join(fix.root, ...Array(10).fill('段'.repeat(50))) : join(fix.root, 'artifacts');
    try {
      const stub = join(fix.root, 'synthetic-session.mjs');
      writeFileSync(stub, `process.stdout.write(JSON.stringify(${JSON.stringify({ ok: true, label, status: 'done', summary: raw, lastReply: raw, completion })}) + '\\n');\n`);
      writeFileSync(fix.labelsPath, JSON.stringify({ [label]: {
        runId: RUN_ID, status: 'running', agent: 'main', spawnedAt: new Date().toISOString(), timeoutSeconds: 600,
      } }));
      const result = spawnSync(process.execPath, [WATCHER, '--label', label, '--timeout', '600', '--once'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env,
          SCHEDULER_DB: fix.dbPath, DISPATCH_STATE_DIR: fix.root, DISPATCH_LABELS_PATH: fix.labelsPath,
          SCHEDULER_ARTIFACTS_DIR: artifacts,
          ...(longPath ? { DISPATCH_COMPLETION_INLINE_LIMIT_BYTES: '1200' } : {}),
          DISPATCH_INDEX_PATH: stub, OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1' },
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const body = result.stdout.split('\n\n').slice(1).join('\n\n').trimEnd();
      assertBounded(body);
      assert.ok(Buffer.byteLength(body) <= (longPath ? 1200 : MAX_BYTES));
      assert.ok(body.includes('Validation:\nTwo independent dry runs matched.'));
      assert.ok(body.includes('Blockers:\nThe production run still needs operator approval.'));
      assert.ok(body.includes('Checks: tests passed; pushed deadbee.'));
      assert.ok(body.includes(`Full text remains in run ${RUN_ID}.`));
      assert.match(body, /Full completion report saved/);
      const files = readdirSync(join(artifacts, 'dispatch-completions'));
      assert.equal(files.length, 1);
      const artifactPath = join(artifacts, 'dispatch-completions', files[0]);
      const full = readFileSync(artifactPath, 'utf8');
      assert.ok(full.includes(raw), 'every section and its full contents remain on disk');
      assert.ok(full.includes('Checks: tests passed; pushed deadbee.'));
      if (longPath) assert.match(body, /Full completion report saved locally/);
      else assert.ok(body.includes(`Full completion report saved to ${artifactPath}`));
    } finally { closeDb(); rmSync(fix.root, { recursive: true, force: true }); }
  });
}

for (const [kind, raw] of [['human', humanReport('The export completed with every row present. '.repeat(250))], ['machine', cueDump()]]) {
  test(`done enqueue stores one bounded outbox part (${kind}) and preserves the original completion summary`, () => {
    const fix = fixture();
    try {
      const completion = buildTerminalCompletionPayload({ summary: raw, checklist: CHECKLIST });
      const result = enqueueCompletionNotification({ label: 'boundary-done', completion,
        summary: raw, runId: RUN_ID, deliverTo: 'synthetic-boundary-recipient', deliveryChannel: 'telegram' });
      assert.equal(result.ok, true);
      assert.equal(result.delivered, false, 'enqueue does not prove delivery');
      assert.equal(result.partCount, 1);
      assertBounded(result.bodyText);
      if (kind === 'human') assert.ok(result.bodyText.endsWith(`Full text remains in run ${RUN_ID}.`));
      else assert.ok(result.bodyText.length < 2000, 'machine output is summarized before enqueue');
      assert.equal(completion.summary, raw);
      const rows = getDb().prepare('SELECT body FROM delivery_outbox').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].body, `✅ [boundary-done] done\n\n${result.bodyText}`);
    } finally { closeDb(); rmSync(fix.root, { recursive: true, force: true }); }
  });

  test(`real watcher completion enqueues one bounded part (${kind}) with the label run reference`, () => {
    const fix = fixture();
    const label = 'boundary-watcher';
    try {
      // Stub only the upstream session/status source. Selection, enqueue, claim,
      // outbox splitting and the watcher itself are production code.
      const stub = join(fix.root, 'synthetic-session.mjs');
      writeFileSync(stub, `const result = ${JSON.stringify({ ok: true, label, status: 'done', summary: raw, lastReply: raw })};\nprocess.stdout.write(JSON.stringify(result) + '\\n');\n`);
      writeFileSync(fix.labelsPath, JSON.stringify({ [label]: {
        sessionKey: 'agent:main:subagent:boundary-test', runId: RUN_ID,
        status: 'running', agent: 'main', mode: 'fresh', spawnedAt: new Date().toISOString(),
        timeoutSeconds: 600, deliverTo: 'synthetic-boundary-recipient',
        deliverChannel: 'telegram', deliveryMode: 'announce',
      } }));
      const result = spawnSync(process.execPath, [WATCHER, '--label', label, '--timeout', '600', '--once'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env,
          SCHEDULER_DB: fix.dbPath, DISPATCH_STATE_DIR: fix.root, DISPATCH_LABELS_PATH: fix.labelsPath,
          DISPATCH_INDEX_PATH: stub, OPENCLAW_SCHEDULER_NOTIFY_DISABLED: '1' },
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      const db = new Database(fix.dbPath, { readonly: true });
      let rows;
      try { rows = db.prepare('SELECT body FROM delivery_outbox').all(); } finally { db.close(); }
      assert.equal(rows.length, 1, 'watcher enqueues one part');
      const bodyText = rows[0].body.split('\n\n').slice(1).join('\n\n');
      assertBounded(bodyText);
      if (kind === 'human') {
        assert.ok(bodyText.endsWith(`Full text remains in run ${RUN_ID}.`));
        assert.equal(JSON.parse(readFileSync(fix.labelsPath, 'utf8'))[label].summary, raw);
      } else {
        assert.ok(bodyText.length < 2000, 'machine output is summarized before watcher enqueue');
      }
    } finally { closeDb(); rmSync(fix.root, { recursive: true, force: true }); }
  });
}
