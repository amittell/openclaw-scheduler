import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildTerminalCompletionPayload, humanizeCompletionText, resolveCompletionDelivery, summarizeCompletionText } from '../dispatch/completion.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sm-round8-fix-payload.json'), 'utf8'));

test('sm-round8-fix: lastReply wins over summary_human (regression)', () => {
  const result = resolveCompletionDelivery({
    lastReply: payload.lastReply,
    completion: payload.completion,
    fallbackSummary: payload.completion?.summary,
  });

  assert.equal(result.source, 'lastReply');
  assert.ok(result.deliveryText.includes('Root cause of the aac/wav mismatch'), 'delivery must carry the real report body');
  assert.ok(!result.deliveryText.includes('That should make the workflow more reliable'), 'no boilerplate filler in delivery');
  assert.ok(result.deliveryText.length > 1000, `delivery is the full report, got ${result.deliveryText.length} chars`);
  assert.ok(!result.deliveryText.includes('Technical details:'), 'pass-through report must not be duplicated under a Technical details section');
});

test('sm-round8-fix: humanizeCompletionText pass-through on lastReply', () => {
  const humanized = humanizeCompletionText(payload.lastReply);
  assert.ok(humanized.length > 1000, `pass-through expected, got ${humanized.length} chars`);
  assert.ok(humanized.includes('gate_03s'));
  assert.equal(humanized, payload.lastReply.trim());
});

test('sm-round8-fix: summary field keeps the authoritative structured summary', () => {
  const result = resolveCompletionDelivery({
    lastReply: payload.lastReply,
    completion: payload.completion,
    fallbackSummary: payload.completion?.summary,
  });
  const expected = humanizeCompletionText(payload.completion?.summary_human) || payload.completion?.summary;
  assert.ok(expected, 'fixture must carry a structured summary to assert against');
  assert.equal(result.summary, expected, 'summary keeps the authoritative structured summary, not the report body');
  assert.ok(result.summary, 'summary must not be empty');
});

test('bold-label sections (no markdown headings) pass isLikelyHumanFinalReport via humanize pass-through', () => {
  const report = [
    'The work is complete.',
    '',
    '**Root cause:** The guard skipped re-encode over the stale file.',
    '',
    '**Files changed:**',
    '- publish-episode.sh',
    '- episode_mix_loud.wav',
    '',
    '**Validation:** tests run and passed.',
  ].join('\n');

  const humanized = humanizeCompletionText(report);
  assert.equal(humanized, report, 'bold-label report must pass through unmodified');
});

test('markdown-heading reports still pass (existing path regression guard)', () => {
  const report = [
    'The work is complete.',
    '',
    '## Root cause',
    'The guard skipped re-encode over the stale file.',
    '',
    '## Files changed',
    '- publish-episode.sh',
    '',
    '## Validation',
    'tests run and passed.',
  ].join('\n');

  const humanized = humanizeCompletionText(report);
  assert.equal(humanized, report, 'heading-based report must pass through unmodified');
});

test('non-report chatter is still summarized, not passed through', () => {
  const chatter = Array.from({ length: 12 }, (_, i) =>
    `Sentence ${i + 1} describes some routine maintenance that was performed on the pipeline today with no structural headings or bold labels.`).join(' ');
  assert.ok(chatter.length > 700, 'chatter must exceed the pass-through budget');
  const humanized = humanizeCompletionText(chatter);
  assert.ok(humanized, 'chatter must still produce a delivery text');
  assert.ok(humanized.length < chatter.length, 'long non-report prose must be summarized, not passed through');
});

test('lastReply is used when summary_human is noise and lastReply is a real report', () => {
  const result = resolveCompletionDelivery({
    lastReply: payload.lastReply,
    completion: { summary_human: 'done', summary: 'done', checklist: { work_complete: true } },
    fallbackSummary: 'done',
  });
  assert.equal(result.source, 'lastReply');
  assert.ok(result.deliveryText.includes('Root cause of the aac/wav mismatch'));
});

// DONE-path regression (sm-round8-align-fix, 2026-09-24): the done path does
// not recover lastReply, so resolveCompletionDelivery was falling back to
// completion.summary_human -- a lossy derivative that mangled numbers
// ("0.00s" -> "0. 00s") and collapsed a 1909-char report to 198 chars. The
// full completion.summary must win when summary_human is a truncation of it
// (clean or mangled prefix) or a synthetic technical rewrite, and must NOT win
// when the agent wrote its own lead (the fitness "Technically:" shape) or when
// summary is not a chat-sized report.
const CHECKLIST = { work_complete: true };
const PUSHED_CHECKLIST = { work_complete: true, tests_passed: true, pushed: true };
const SHA = 'deadbeef'.repeat(5);
const MAX_VERBATIM_BYTES = 3400;
const alignFull = 'Round-8 alignment fix complete (all 3 items, re-verified, staged). ITEM 1 (7 SRT-offset lines): 3 were real EN sub offsets, fixed to 0.00s drift - i=37 Bunny. #32 344.25 to 347.50, i=83 Um show me. #75 738.11 to 739.00. ITEM 2 (32 missing-cue lines): 16 real EN lines got new 1:1 cues, 16 are jp_fallback. SRT 224 to 241 cues, sequential, chronological, 0 new overlaps. ITEM 3 (1251.9 gap): CONFIRMED real dropped JP line, regenerated No! via IndexTTS2 best-of-6, surgical mix and re-encode to dub_eng_v10.aac. RE-VERIFY: gate_03s.py OK, P1 max drift 4.54s to 0.36s. STAGED: srt md5 772f57d1 (241 cues), aac md5 04f634ff, lines_index md5 9f1cc522 (266 entries).';
const alignMangled = alignFull.slice(0, 160).replace('0.00s', '0. 00s').replace('344.25', '344. 25');
// lastReply is the worker's real final reply (1,599 chars). The stored
// --summary was not kept; summary is the same report as one paragraph, the
// shape the producer truncates.
const alignReport = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sm-round8-align-fix-report.json'), 'utf8'));

function deliverDone(summary) {
  const completion = buildTerminalCompletionPayload({ summary, checklist: CHECKLIST });
  return { completion, result: resolveCompletionDelivery({ completion, fallbackSummary: completion.summary }) };
}

test('done path: mangled-prefix summary_human promotes full completion.summary', () => {
  const result = resolveCompletionDelivery({
    completion: { summary: alignFull, summary_human: alignMangled, checklist: CHECKLIST },
    fallbackSummary: alignFull,
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, alignFull);
  assert.ok(result.deliveryText.includes('0.00s') && result.deliveryText.includes('344.25'), 'numbers must be intact in the promoted summary');
});

test('a report past the verbatim bound is still humanized with its decimals intact', () => {
  // Past the bound the report falls back to summary_human, which used to
  // split "0.00s" into "0. 00s" and "344.25" into "344. 25".
  const appendix = ' Appendix: per-line drift table re-checked line by line for every one of the 241 cues, all inside 0.40s, with the same staging layout as round 7 and the same publish recipe. ';
  const { result } = deliverDone(alignReport.summary + appendix.repeat(10));
  assert.equal(result.source, 'summary_human');
  assert.ok(result.deliveryText.includes('fixed to 0.00s drift') && result.deliveryText.includes('344.25 to 347.50'), result.deliveryText);
  assert.ok(!result.deliveryText.includes('0. 00s'));
});

test('done path: a legacy summaryHuman payload promotes the full summary too', () => {
  const result = resolveCompletionDelivery({
    completion: { summary: alignFull, summaryHuman: alignMangled, checklist: CHECKLIST },
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, alignFull);
});

test('sm-round8-align-fix: the full report reaches chat on the done and watcher paths', () => {
  const { completion, result } = deliverDone(alignReport.summary);
  assert.ok(completion.summary_human.length < alignReport.summary.length / 2, 'the producer still truncates this report');
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, alignReport.summary);

  // The watcher's last reply has section labels but no final-report cue, so
  // the agent's own --summary, delivered in full, stays authoritative.
  const watcher = resolveCompletionDelivery({ lastReply: alignReport.lastReply, completion, fallbackSummary: completion.summary });
  assert.equal(watcher.deliveryText, alignReport.summary);
});

test('done path: a technical rewrite stored by 0.6.7 gives way to the full report', () => {
  // The fixture is sm-round8-fix as 0.6.7 stores it: a 29-char lead built
  // from one clause of a 1,619-char report, with no follow-up sentence and no
  // rewrite record. The humanizer rebuilds that exact lead from the report.
  assert.equal(payload.completion.summary_human, 'Md5 032cde47 (stale round-7).');
  assert.equal(payload.completion.debug.leadSource, undefined);
  assert.ok(payload.completion.summary.length > 1500);
  const result = resolveCompletionDelivery({
    completion: payload.completion,
    fallbackSummary: payload.completion.summary,
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, payload.completion.summary);
});

// A clause of the sm-round8-fix report. With a verb in front of it the
// humanizer leads with that clause rewritten ("Updated md5 ..."), which is
// neither a prefix nor a substring of the report.
const MD5_CLAUSE = 'md5 032cde47 (stale round-7) -> 29e5e2d6';
const REWRITTEN_REPORTS = {
  'incident, "update md5"': payload.completion.summary.replace(MD5_CLAUSE, `update ${MD5_CLAUSE}`),
  'incident, "fix md5"': payload.completion.summary.replace(MD5_CLAUSE, `fix ${MD5_CLAUSE}`),
  'fix -> Fixed': 'Diagnosed the importer stall in src/sync/importer.js after the overnight run. The queue drained but the HAE_EXPORT flag stayed set for six hours; fix the stale flag reset before the next run starts; verified against the live fitness.db snapshot that the W2D4 session plans W2D5. Re-ran the full import twice and both runs finished in under four minutes. No other files changed and nothing was pushed beyond the branch.',
  'two clauses joined': 'Cleared the stale planner cache that the morning brief read; reused the last good plan when the export was empty; the cron entry in jobs/brief.yaml fired on time but HAE_EXPORT was unset for six hours. Checked three days of logs and every skip lines up with an empty export. Re-ran the brief by hand and the planner block rendered. Re-ran the sync job and the queue drained. Nothing else changed.',
  'add -> Added': 'Root-caused the duplicate receipt emails to billing/retry_worker.py re-sending invoices whose ack arrived after the window -> add an idempotency key per invoice -> backfilled with scripts/backfill_receipts.py over the last two days. Confirmed on staging that each order produces one receipt. Ran pytest (212 passed) and the lint job. Re-ran the queue twice. Nothing customer-facing changed beyond the duplicate emails ending.',
};
const stripPunctuation = (text) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();

test('done and watcher paths: a fresh technical rewrite of a prose report gives way to the report', () => {
  // 0.6.7 delivered the rewritten lead and a cut of the report instead: 280
  // chars for the 1,626-char "update md5" report, which 0.6.6 sent whole.
  assert.ok(payload.completion.summary.includes(MD5_CLAUSE));
  for (const [name, report] of Object.entries(REWRITTEN_REPORTS)) {
    const completion = buildTerminalCompletionPayload({ summary: report, checklist: PUSHED_CHECKLIST, sha: SHA });
    assert.ok(!stripPunctuation(report).includes(stripPunctuation(completion.summary_human)), `${name}: ${completion.summary_human}`);
    for (const [path, lastReply] of [['done', undefined], ['watcher', report]]) {
      const result = resolveCompletionDelivery({ lastReply, completion, fallbackSummary: completion.summary });
      assert.equal(result.source, 'completion-summary-full', `${name} (${path})`);
      assert.equal(result.deliveryText, `${report}\n\nChecks: tests passed; pushed deadbee.`, `${name} (${path})`);
    }
    assert.equal(completion.debug.leadSource, 'technical-rewrite', name);
  }
});

test('done path: a rewritten lead stored by 0.6.7, which has no record, gives way to the report after the upgrade', () => {
  // 0.6.7 built the same lead from these reports but stored no leadSource.
  for (const [name, report] of Object.entries(REWRITTEN_REPORTS)) {
    const debug = { ...buildTerminalCompletionPayload({ summary: report, checklist: CHECKLIST }).debug };
    delete debug.leadSource;
    const stored = { version: 2, summary_human: debug.normalizedSummary, summary: report, checklist: CHECKLIST, debug };
    const result = resolveCompletionDelivery({ completion: stored, fallbackSummary: report });
    assert.equal(result.source, 'completion-summary-full', name);
    assert.equal(result.deliveryText, report, name);
  }
});

test('done path: a technical lead made of the report\'s first sentences gives way to the report, however long', () => {
  // No plain clause leads this report, so the humanizer leads with its first
  // five sentences: 448 of 608 chars. The details block then repeats the
  // head and drops the rest, 731 chars without the last two sentences.
  // 0.6.6 led with a stock sentence and sent the report.
  const report = [
    'Rebuilt the nightly export after the overnight run stalled at the invoice step.',
    'The export had stopped at row 4,812 when the upstream feed closed early.',
    'Config: EXPORT_WINDOW_START moved from 02:10 to 02:50 in jobs/export.yaml, and retry_limit raised to 3 for the invoice step.',
    'Re-ran the import against the morning snapshot and every table matched the source counts.',
    'Checked the three previous nights and found the same early close on two of them.',
    'Moved the export window forty minutes later, after the feed closes.',
    'Ran the job twice by hand and both runs finished in under six minutes with no skipped rows.',
  ].join(' ');
  const completion = buildTerminalCompletionPayload({ summary: report, checklist: PUSHED_CHECKLIST, sha: SHA });
  assert.ok(report.startsWith(completion.summary_human) && completion.summary_human.length > report.length * 0.6, completion.summary_human);
  const result = resolveCompletionDelivery({ completion, fallbackSummary: report });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, `${report}\n\nChecks: tests passed; pushed deadbee.`);

  // The same lead stored by 0.6.7, without the record.
  const debug = { ...completion.debug };
  delete debug.leadSource;
  const stored = resolveCompletionDelivery({ completion: { ...completion, debug }, fallbackSummary: report });
  assert.equal(stored.source, 'completion-summary-full');
});

test('the rewrite record marks only the humanizer\'s own lead, never the agent\'s final report', () => {
  // A final report passed as --summary leads as written. Recording it as a
  // rewrite would send it as a promoted report instead.
  const completion = buildTerminalCompletionPayload({ summary: payload.lastReply, checklist: PUSHED_CHECKLIST, sha: SHA });
  assert.equal(completion.summary_human, payload.lastReply.trim());
  assert.equal(completion.debug.leadSource, undefined);
  const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
  assert.equal(result.source, 'summary_human');
  assert.ok(result.deliveryText.startsWith(`${payload.lastReply.trim()}\n\nTechnical details:\n`), result.deliveryText.slice(-80));
});

test('done path: the producer record outlives a change to the humanizer', () => {
  // A payload stored by a build whose humanizer wrote a different lead: the
  // record, not a rebuild of the lead, says it is a rewrite.
  const report = REWRITTEN_REPORTS['fix -> Fixed'];
  const produced = buildTerminalCompletionPayload({ summary: report, checklist: CHECKLIST });
  const otherLead = 'Fixed the stale import flag reset.';
  assert.notEqual(produced.summary_human, otherLead);
  const stored = { ...produced, summary_human: otherLead, debug: { ...produced.debug, normalizedSummary: otherLead } };
  const result = resolveCompletionDelivery({ completion: stored, fallbackSummary: report });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, report);
});

test('done path: every follow-up sentence v0.6.6 appended marks a stored rewrite', () => {
  const followUps = [
    'That makes the behavior easier to trust. Future regressions should get caught quickly.',
    'That should make the workflow more reliable. Future runs should be less likely to hit the same problem.',
    'That makes the new behavior available without extra follow-up. Future runs should use it automatically.',
    'That should make the result easier to work with. Future runs should reflect the change automatically.',
    'Future runs should show the clean summary first, with technical details underneath when needed.',
  ];
  for (const followUp of followUps) {
    const completion = { ...payload.completion, summary_human: `Re-encoded the dub track. ${followUp}` };
    const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
    assert.equal(result.source, 'completion-summary-full', followUp);
    assert.equal(result.deliveryText, payload.completion.summary, followUp);
  }

  // Without the sentence, a lead the humanizer would not write is the agent's.
  const explicit = { ...payload.completion, summary_human: 'Re-encoded the dub track.' };
  const result = resolveCompletionDelivery({ completion: explicit, fallbackSummary: explicit.summary });
  assert.equal(result.source, 'summary_human');
  assert.ok(result.deliveryText.startsWith('Re-encoded the dub track.'));
});

test('done path: commit-style summaries keep their lead and the pushed sha at any length', () => {
  // 12cb8d5 promoted these raw from about 309 chars up, and the
  // "Checks: tests passed; pushed deadbee." line went with the lead.
  const clauses = [
    'fix(sync): retry the Health Auto Export import on 429 with backoff and jitter capped at 30s',
    'guard the workouts.json parse against empty arrays and null dates',
    'keep the last good fitness.db snapshot when an import fails mid-way',
    'add focused tests for the retry, the empty-array guard and the snapshot fallback',
  ];
  const cases = {
    'commit prefix, four clauses': clauses.join('; '),
    'commit prefix, written as sentences': 'fix(sync): Retry the Health Auto Export import on 429 with backoff and jitter capped at 30s. Guard the workouts.json parse against empty arrays and null dates. Keep the last good fitness.db snapshot when an import fails mid-way. Add focused tests for the retry, the empty-array guard and the snapshot fallback. Verified on the live fitness.db snapshot.',
    'file prefix, written as sentences': 'dispatch/completion.mjs: Made summary_human win over deliveryText for every completion. Moved details_technical into a separate block below the lead. Added focused tests for the payload-precedence regressions. Passed lastReply into resolveCompletionDelivery on the watcher path. Reused resolvedDelivery in hooks.mjs instead of resolving twice. Kept the claimCompletionDelivery dedupe between the two paths.',
    'clause list without a prefix': 'make summary_human win over deliveryText for every completion; move details_technical into a separate block below the lead; add focused tests for the payload-precedence regressions; pass lastReply into resolveCompletionDelivery on the watcher path; reuse resolvedDelivery in hooks.mjs instead of resolving twice; keep the claimCompletionDelivery dedupe between the two paths; update the focused tests for the watcher and done paths',
  };
  assert.equal(cases['commit prefix, four clauses'].length, 309);
  for (const [name, summary] of Object.entries(cases)) {
    const completion = buildTerminalCompletionPayload({ summary, checklist: PUSHED_CHECKLIST, sha: SHA });
    const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
    assert.notEqual(result.source, 'completion-summary-full', `${name}: promoted raw`);
    assert.ok(result.deliveryText.startsWith(completion.summary_human), `${name}: lost the lead`);
    assert.ok(result.deliveryText.includes('Checks: tests passed; pushed deadbee.'), `${name}: lost the sha`);
  }
});

test('done path: a promoted report keeps the checks line', () => {
  const completion = { ...payload.completion, checklist: PUSHED_CHECKLIST, sha: SHA };
  const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, `${payload.completion.summary}\n\nChecks: tests passed; pushed deadbee.`);
});

test('done path: thin completion.summary does not trigger the full-summary path', () => {
  const result = resolveCompletionDelivery({
    completion: { summary_human: 'Work complete. Files changed.', summary: 'done', checklist: CHECKLIST },
    fallbackSummary: 'done',
  });
  assert.notEqual(result.source, 'completion-summary-full');
  assert.ok(result.deliveryText, 'still delivers something');
});

test('done path: promotion starts above 200 chars', () => {
  // Fifteen short sentences and a count; the producer keeps the first five.
  const items = Array.from({ length: 15 }, (_, i) => `Item ${i + 1} ok.`).join(' ');
  const ofLength = (n) => `${items} Counted ${'9'.repeat(n - items.length - ' Counted  rows.'.length)} rows.`;
  const atFloor = deliverDone(ofLength(200));
  assert.equal(atFloor.result.source, 'summary_human');
  assert.equal(atFloor.result.deliveryText, atFloor.completion.summary_human);
  const overFloor = deliverDone(ofLength(201));
  assert.equal(overFloor.result.source, 'completion-summary-full');
  assert.equal(overFloor.result.deliveryText, ofLength(201));
});

test('done path: a humanized lead that keeps most of the report is delivered as it is', () => {
  const phases = (n) => Array.from({ length: n }, (_, i) => `Phase ${i + 1} of the migration finished and its row counts matched production.`).join(' ');
  // Six sentences: the producer keeps five, 83% of the report.
  const most = deliverDone(phases(6));
  assert.ok(most.completion.summary_human.length > phases(6).length * 0.6);
  assert.equal(most.result.source, 'summary_human');
  assert.equal(most.result.deliveryText, most.completion.summary_human);
  // Ten sentences: the same five are half the report, so the report goes out.
  const half = deliverDone(phases(10));
  assert.ok(half.completion.summary_human.length < phases(10).length * 0.6);
  assert.equal(half.result.source, 'completion-summary-full');
  assert.equal(half.result.deliveryText, phases(10));
});

test('done path: machine output and over-long summaries are never delivered verbatim', () => {
  const item = (i) => `{"id":${i},"name":"maintenance-task-${i}","state":"ok","note":"fine"}`;
  const cases = {
    'prose lead then a JSON blob': 'Finished the maintenance sweep. Output follows:\n{"results":[' + Array.from({ length: 30 }, (_, i) => item(i + 1)).join(','),
    'JSON in an untagged code fence': '```\n{\n' + Array.from({ length: 40 }, (_, i) => `  "key${i}": "value number ${i}",`).join('\n') + '\n}\n```',
    'raw log lines': Array.from({ length: 30 }, (_, i) => `2026-09-24T10:00:${String(i).padStart(2, '0')}Z INFO worker=${i} processed batch ${i} ok`).join('\n'),
    'syslog lines': Array.from({ length: 30 }, (_, i) => `Oct  2 10:00:${String(i).padStart(2, '0')} kebab worker[4${i}]: processed batch ${i} ok in ${i * 3}ms`).join('\n'),
    'time-only log lines': Array.from({ length: 30 }, (_, i) => `[10:00:${String(i).padStart(2, '0')}] INFO worker=${i} processed batch ${i} ok`).join('\n'),
    'test-runner output': Array.from({ length: 40 }, (_, i) => `  ✔ completion delivery case ${i} handles the input shape (${(i * 1.7).toFixed(1)}ms)`).join('\n'),
    'TAP output': Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - completion delivery case ${i} handles the input shape and the fallback`).join('\n'),
    'Python dict reprs': 'Sweep finished. Rows:\n' + Array.from({ length: 25 }, (_, i) => `{'id': ${i}, 'name': 'task-${i}', 'state': 'ok', 'note': 'fine'}`).join('\n'),
    'KEY=value env dump': 'Deployed the worker with this environment:\n' + Array.from({ length: 20 }, (_, i) => `SERVICE_${i}_TOKEN=sk-live-${'A'.repeat(20)}${i}`).join('\n'),
    'YAML': 'Applied the config:\n' + Array.from({ length: 30 }, (_, i) => `  job_${i}:\n    schedule: "*/5 * * * *"\n    enabled: true`).join('\n'),
    'Python traceback': 'The nightly import failed and I could not recover it.\nTraceback (most recent call last):\n' + Array.from({ length: 12 }, (_, i) => `  File "/srv/app/importer/stage_${i}.py", line ${10 + i}, in run_stage_${i}\n    result = stage_${i + 1}(payload, retries=3)`).join('\n') + '\nKeyError: missing column order_id',
    'Go panic': 'panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\n' + Array.from({ length: 15 }, (_, i) => `main.stage${i}(0xc000012345, 0x3)\n\t/srv/app/main.go:${40 + i} +0x1d`).join('\n'),
    '40 KB of prose': Array.from({ length: 550 }, (_, i) => `Step ${i + 1} finished and the output was checked against the expected values.`).join(' '),
  };
  for (const [name, summary] of Object.entries(cases)) {
    const { result } = deliverDone(summary);
    assert.notEqual(result.source, 'completion-summary-full', `${name}: promoted verbatim`);
    assert.ok(Buffer.byteLength(result.deliveryText) <= MAX_VERBATIM_BYTES, `${name}: delivered ${result.deliveryText.length} chars`);
  }
});

test('the verbatim bound counts bytes, so a non-ASCII report cannot outgrow one Telegram part', () => {
  // 2,906 chars of Japanese are 8,670 UTF-8 bytes: three parts of 3,600 bytes.
  const report = ['作業が完了しました。', '**項目1:** ' + '字幕のずれを修正しました。'.repeat(85), '**項目2:** ' + '欠落していた行を追加しました。'.repeat(75), '**再検証:** ' + '問題はありません。'.repeat(70), '以上です。'].join('\n');
  assert.ok(report.length < MAX_VERBATIM_BYTES && Buffer.byteLength(report) > MAX_VERBATIM_BYTES);
  const { result } = deliverDone(report);
  assert.ok(Buffer.byteLength(result.deliveryText) <= MAX_VERBATIM_BYTES, `delivered ${Buffer.byteLength(result.deliveryText)} bytes`);
});

test('done path: a promoted report goes out without color codes or carriage returns', () => {
  const prose = Array.from({ length: 14 }, (_, i) => `Step ${i + 1} finished and the output was checked against the expected values.`).join(' ');
  const colored = deliverDone(`${prose} Final check: \u001b[32mPASS\u001b[0m on all 14 steps.`).result;
  assert.equal(colored.source, 'completion-summary-full');
  assert.equal(colored.deliveryText, `${prose} Final check: PASS on all 14 steps.`);

  const crlf = deliverDone(prose.replace(/\. /g, '.\r\n')).result;
  assert.equal(crlf.source, 'completion-summary-full');
  assert.equal(crlf.deliveryText, prose.replace(/\. /g, '.\n'));

  // Escapes other than color codes are terminal output, not a report.
  const cursor = deliverDone(`${prose} \u001b[2KProgress: all steps done.`).result;
  assert.notEqual(cursor.source, 'completion-summary-full');
});

test('done path: an agent-written "Technically:" split keeps its lead even when summary_human is a prefix', () => {
  const lead = 'Fixed the planner so the next session is recommended after the last completed one.';
  const { completion, result } = deliverDone(`${lead} Technically: mapped imported workout ids back to the program schedule, updated the focused progression tests, and verified on the live database snapshot that the last completed W2D4 now plans W2D5.`);
  assert.equal(completion.summary_human, lead);
  assert.equal(completion.debug.leadSource, undefined, 'the agent\'s own lead is not a rewrite');
  assert.notEqual(result.source, 'completion-summary-full');
  assert.ok(result.deliveryText.startsWith(`${lead}\n\nTechnical details:`));
  assert.ok(!result.deliveryText.includes('Technically:'), 'the raw marker must not reach chat');
});

test('done path: transport noise is never promoted verbatim', () => {
  const noise = 'Auto-resolved as done: ' + Array.from({ length: 8 }, (_, i) => `Step ${i + 1} finished and the output was checked.`).join(' ');
  const result = resolveCompletionDelivery({
    completion: { summary: noise, summary_human: noise.slice(0, 120), checklist: CHECKLIST },
  });
  assert.notEqual(result.source, 'completion-summary-full');
  assert.ok(!result.deliveryText.startsWith('Auto-resolved'));
});

test('raw JSON-ish summary without marker keys is not promoted (integration)', () => {
  // P2 from the adversarial review: looksLikeRawPayloadText is a marker-key
  // heuristic, so a truncated single-line JSON without marker keys slipped
  // through and got promoted verbatim. Run it through the REAL producer
  // (buildTerminalCompletionPayload) to pin the end-to-end shape.
  const item = (i) => `{"id":${i},"name":"maintenance-task-${i}","state":"done","note":"ok"}`;
  const truncatedJson = '{"results":[' + Array.from({ length: 30 }, (_, i) => item(i + 1)).join(',') + ']';
  const payload = buildTerminalCompletionPayload({ summary: truncatedJson, checklist: { work_complete: true } });
  const result = resolveCompletionDelivery({ completion: payload, fallbackSummary: truncatedJson });
  // The P2 fix: a JSON-shaped summary (no marker keys) must NOT be promoted
  // verbatim via the completion-summary-full path. (The summary_human fallback
  // may still carry a JSON fragment - that is pre-existing behavior outside
  // this PR's scope, guarded separately by looksLikeRawPayloadText.)
  assert.notEqual(result.source, 'completion-summary-full', 'JSON-shaped summary must never be promoted verbatim');
});

test('no-cue multi-section report passes isLikelyHumanFinalReport (regression)', () => {
  // Copilot comment on PR #53: the existing bold-label fixture contains cue
  // words (Root cause / Files changed / Validation) so it is accepted by the
  // earlier hasCue branch. This fixture uses 3+ neutral bold labels with no
  // cue word and must pass through the new no-cue branch unchanged.
  const report = [
    'The work is complete.',
    '',
    '**Item 1 (7 SRT-offset lines):** 3 real offsets fixed to 0.00s drift.',
    '',
    '**Item 2 (32 missing-cue lines):** 16 got new 1:1 cues.',
    '',
    '**Re-verify:** gate_03s.py OK, P1 max drift 0.36s.',
    '',
    '**Staged** in the workdir: srt 241 cues, aac v10.',
  ].join('\n');
  const humanized = humanizeCompletionText(report);
  assert.equal(humanized, report, 'no-cue report with 3+ bold-label sections must pass through unmodified');
});

test('cue-less section labels need five lines to pass through as written', () => {
  const fourLines = [
    'Round-9 subtitle pass is finished.',
    '**Item 1:** 4 offsets fixed to 0.00s drift.',
    '**Item 2:** 9 missing cues added 1:1.',
    '**Re-verify:** gate_03s.py OK, max drift 0.31s.',
  ].join('\n');
  const fiveLines = `${fourLines}\nStaged in the covfix workdir.`;
  assert.notEqual(deliverDone(fourLines).result.deliveryText, fourLines);
  assert.equal(deliverDone(fiveLines).result.deliveryText, fiveLines);
});

test('cue-less section labels do not pass dumps, stack traces or JSON through verbatim', () => {
  const dump = ['**Alpha**: x', '**Bravo**: y', '**Charlie**: z', ...Array.from({ length: 2000 }, (_, i) => `line ${i} of a long dump`)].join('\n');
  const { result } = deliverDone(dump);
  assert.ok(Buffer.byteLength(result.deliveryText) <= MAX_VERBATIM_BYTES, `delivered ${result.deliveryText.length} chars`);

  const stackTrace = '**Error**: TypeError: x is undefined\n**Stack**:\n    at foo (/srv/app/a.js:1:2)\n    at bar (/srv/app/b.js:3:4)\n**Context**: watcher';
  const jsonLines = '**out**: {"a":1}\n**err**: {"b":2}\n**raw**: {"c":3}\nx\ny';
  const logLines = ['**stdout**:', ...Array.from({ length: 20 }, (_, i) => `Oct  2 10:00:${String(i).padStart(2, '0')} kebab worker[4${i}]: batch ${i} ok`), '**stderr**:', 'warn: slow disk', '**exit**: 0'].join('\n');
  assert.notEqual(humanizeCompletionText(stackTrace), stackTrace);
  assert.notEqual(humanizeCompletionText(jsonLines), jsonLines);
  assert.notEqual(humanizeCompletionText(logLines), logLines);
});

test('watcher path: a cue-less status reply does not replace the agent\'s own --summary', () => {
  const statusReply = '**Status:** still running\n**Next:** will check logs\n**ETA:** 10 min\nWorking on it.\nMore soon.';
  const summary = 'Migrated the billing tables and verified row counts match production.';
  const completion = buildTerminalCompletionPayload({ summary, checklist: CHECKLIST });
  const result = resolveCompletionDelivery({ lastReply: statusReply, completion });
  assert.equal(result.source, 'summary_human');
  assert.equal(result.deliveryText, summary);

  // Without a structured completion the reply is all there is, delivered as written.
  const replyOnly = resolveCompletionDelivery({ lastReply: statusReply, completion: null });
  assert.equal(replyOnly.source, 'lastReply');
  assert.equal(replyOnly.deliveryText, statusReply);
});

test('humanizeCompletionText never emits the removed boilerplate family', () => {
  // The generic themed filler ("The requested fix is in place.", "That should
  // make the workflow more reliable.", "Final completion updates now start
  // with a short plain-English summary.", ...) must not reach chat. The
  // humanized lead for a technical summary is the real condensed content.
  const boilerplate = [
    'The requested fix is in place.',
    'The requested behavior is now in place.',
    'The update is in place.',
    'Added focused coverage for the weak spot.',
    'That makes the behavior easier to trust.',
    'Future regressions should get caught quickly.',
    'That should make the workflow more reliable.',
    'Future runs should be less likely to hit the same problem.',
    'That makes the new behavior available without extra follow-up.',
    'Future runs should use it automatically.',
    'That should make the result easier to work with.',
    'Future runs should reflect the change automatically.',
    'Final completion updates now arrive as one clean plain-English summary.',
    'Final completion updates now start with a short plain-English summary.',
    'That makes the result easier to scan and avoids noisy repeat messages.',
    'That makes the result easier to read without hiding the useful detail.',
    'That makes the result easier to scan without hiding the useful detail.',
    'Future runs should show the clean summary first, with technical details underneath when needed.',
  ];
  const technicalSummaries = [
    'fix(dispatch): normalize completion delivery; add watcher tests; preserve structured completion summary',
    'dispatch/completion.mjs: make summary_human win over deliveryText; move details_technical into a separate block; add focused tests for payload-precedence regressions',
    payload.completion.summary,
    'Add focused tests for the retry, the empty-array guard and the snapshot fallback',
  ];
  for (const summary of technicalSummaries) {
    const humanized = humanizeCompletionText(summary);
    assert.ok(humanized, `must stay non-empty for ${summary.slice(0, 40)}`);
    for (const sentence of boilerplate) {
      assert.ok(!humanized.includes(sentence), `boilerplate leaked: ${sentence}`);
    }
  }
});

test('done path: an explicit human summary embedded in the report keeps precedence over the full report', () => {
  // Copilot finding: the embedded-substring rule must NOT promote the full
  // report when summary_human is an explicit human-written summary that merely
  // happens to appear in the longer report. It is a machine derivative only
  // when the humanizer reproduces it verbatim from the report.
  const explicitHuman = 'Resolved the duplicate billing notifications.';
  const report = 'Investigated the billing pipeline. ' + explicitHuman
    + ' The fix rewrites the dedup key and adds a regression test. Verified against the last 30 days of transactions and the outbox now sends one message per event.';
  const result = resolveCompletionDelivery({
    lastReply: null,
    completion: {
      version: 2,
      summary_human: explicitHuman,
      summary: report,
      details_technical: { raw_summary: report, checklist: { work_complete: true, tests_passed: true } },
      checklist: { work_complete: true, tests_passed: true },
      debug: { summaryStyle: 'humanized', deliverySource: 'summary_human' },
    },
    fallbackSummary: 'completed (agent signal)',
  });
  assert.equal(result.source, 'summary_human', 'explicit human summary wins, not completion-summary-full');
  assert.ok(result.deliveryText.startsWith(explicitHuman), 'the explicit concise summary is delivered first');
});

test('done path: a machine-derivative lead embedded in the report still gives way to the full report', () => {
  // The sm-round8-fix class: summary_human is exactly what the humanizer
  // produces from the report (a fragment lead), so the full report wins.
  const report = payload.completion.summary;
  const machineLead = humanizeCompletionText(report);
  assert.ok(machineLead && machineLead.length < report.length / 2, 'fixture lead is a short machine derivative');
  const result = resolveCompletionDelivery({
    lastReply: null,
    completion: {
      version: 2,
      summary_human: machineLead,
      summary: report,
      details_technical: { raw_summary: report, checklist: { work_complete: true, tests_passed: true } },
      checklist: { work_complete: true, tests_passed: true },
      debug: { summaryStyle: 'humanized', deliverySource: 'summary_human' },
    },
    fallbackSummary: 'completed (agent signal)',
  });
  assert.equal(result.source, 'completion-summary-full', 'machine derivative promotes the full report');
  assert.ok(result.deliveryText.startsWith(report), 'the full report is delivered');
});

test('humanizeCompletionText caps a long single-clause technical lead at the delivery length', () => {
  // Codex finding: a long single-clause summary (file prefix + thousands of
  // chars, no delimiter) used to bypass the 700-char cap once the fragment
  // lead returned directly. The outbox must not split it into many messages.
  const longClause = 'src/foo.js: ' + 'plain english explanation of what changed and why it matters for the operator '.repeat(40);
  const humanized = humanizeCompletionText(longClause);
  assert.ok(humanized, 'must stay non-empty');
  assert.ok(humanized.length <= 700, `fragment lead must respect the 700-char cap, got ${humanized.length}`);
});

test('known limitation: the fragment lead uses only the first two fragments', () => {
  // The humanizer picks the first two plain-English fragments (selection must
  // stay stable so the machine-derivative gate can reproduce the stored lead
  // verbatim). A meaningful clause past the second fragment is dropped from
  // the lead. Pins the current behavior.
  const report = 'fix(db): corrected pool sizing in shard 0; updated backoff constants in the retry loop; the nightly load no longer starves the read replica during peak';
  const lead = humanizeCompletionText(report);
  assert.equal(lead, 'Corrected pool sizing in shard 0 and updated backoff constants in the retry loop.');
  assert.ok(!lead.includes('starves the read replica'), 'the third-fragment clause is not in the lead');
});

test('known limitation: the gate is exact-reproduction, so a drifted machine lead is not promoted', () => {
  // isLossyHumanizedLead only promotes a machine-derivative lead when the
  // humanizer reproduces the stored summary_human verbatim from the report.
  // A lead that differs by one character (e.g. stored by an older humanizer
  // revision) is not a prefix, not embedded, and not a legacy synthetic
  // rewrite, so the lossy-lead rules do not fire and the stored lead is
  // delivered as-is. Pins the current behavior.
  const report = payload.completion.summary;
  const realLead = humanizeCompletionText(report);
  assert.ok(realLead, 'the fixture report produces a machine lead');
  const drifted = `${realLead.slice(0, -1)}x.`;
  assert.notEqual(drifted, realLead);
  const result = resolveCompletionDelivery({
    lastReply: null,
    completion: {
      version: 2,
      summary_human: drifted,
      summary: report,
      details_technical: { raw_summary: report, checklist: { work_complete: true } },
      checklist: { work_complete: true },
      debug: { summaryStyle: 'humanized', deliverySource: 'summary_human' },
    },
    fallbackSummary: 'completed (agent signal)',
  });
  assert.equal(result.source, 'summary_human', 'a drifted machine lead keeps summary_human precedence');
  assert.ok(result.deliveryText.startsWith(drifted), 'the drifted lead is delivered as stored');
});

test('legacy payloads: a pre-removal boilerplate summary_human still promotes the full report', () => {
  // Payloads written before the boilerplate family was removed store a lead
  // like "Md5 032cde47 (stale round-7). That should make the workflow more
  // reliable. ...". The recognition list (SYNTHETIC_FOLLOW_UPS) must keep
  // promoting the full report for those stored payloads.
  const report = payload.completion.summary;
  const legacyLead = 'Md5 032cde47 (stale round-7). That should make the workflow more reliable. Future runs should be less likely to hit the same problem.';
  const result = resolveCompletionDelivery({
    lastReply: null,
    completion: {
      version: 2,
      summary_human: legacyLead,
      summary: report,
      details_technical: { raw_summary: report, checklist: { work_complete: true } },
      checklist: { work_complete: true },
      debug: { summaryStyle: 'humanized', deliverySource: 'summary_human' },
    },
    fallbackSummary: 'completed (agent signal)',
  });
  assert.equal(result.source, 'completion-summary-full', 'legacy boilerplate lead gives way to the full report');
  assert.ok(result.deliveryText.startsWith(report), 'the full report is delivered');
});

test('an explicit summary_human keeps its precedence over the report that contains it', () => {
  const billing = 'Investigated the billing queue after the overnight alert. The retry worker was re-sending invoices whose ack arrived late. Resolved the duplicate billing notifications. Added an idempotency key per invoice and backfilled the last 48 hours. No customer was charged twice; only the emails were duplicated.';
  const explicitLead = 'Resolved the duplicate billing notifications.';
  for (const summaryStyle of [undefined, 'verbatim', 'humanized']) {
    const completion = {
      version: 2,
      summary_human: explicitLead,
      summary: billing,
      checklist: CHECKLIST,
      debug: { deliverySource: 'summary_human', ...(summaryStyle ? { summaryStyle } : {}) },
    };
    const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
    assert.equal(result.source, 'summary_human', `summaryStyle=${summaryStyle}`);
    assert.equal(result.deliveryText, explicitLead, `summaryStyle=${summaryStyle}`);
  }

  // The rewrite record belongs to the text the producer wrote: a summary_human
  // replaced afterwards is explicit again, and so is a lead under any other
  // record.
  const report = REWRITTEN_REPORTS['fix -> Fixed'];
  const produced = buildTerminalCompletionPayload({ summary: report, checklist: CHECKLIST });
  const replaced = resolveCompletionDelivery({ completion: { ...produced, summary_human: 'Cleared the stale import flag.' } });
  assert.equal(replaced.source, 'summary_human');
  assert.ok(replaced.deliveryText.startsWith('Cleared the stale import flag.'), replaced.deliveryText);
  const otherRecord = resolveCompletionDelivery({ completion: { ...produced, debug: { ...produced.debug, leadSource: 'agent' } } });
  assert.equal(otherRecord.source, 'summary_human');
  assert.ok(otherRecord.deliveryText.startsWith(produced.summary_human), otherRecord.deliveryText);
});

test('an agent-written "Human summary:" section leads the delivery, never the labelled report', () => {
  // 0.6.7 rebuilt the section from the report, took it for a rewrite, and sent
  // the report with its "Human summary:" and "Details:" labels.
  const details = 'Details: The retry worker re-sent invoices whose acknowledgement arrived after the thirty second window. I added an idempotency key per invoice and backfilled the last two days of orders. The queue drained cleanly afterwards. Nothing else changed in the billing flow.';
  const sections = {
    'plain section': 'Human summary: Fixed the duplicate receipt emails so each customer now gets exactly one receipt per order.',
    'technical section': 'Human summary: fix(billing): add an idempotency key per invoice; backfill receipts for the last two days',
  };
  for (const [name, section] of Object.entries(sections)) {
    const summary = `${section}\n${details}`;
    const completion = buildTerminalCompletionPayload({ summary, checklist: PUSHED_CHECKLIST, sha: SHA });
    assert.equal(completion.debug.leadSource, undefined, name);
    const result = resolveCompletionDelivery({ completion, fallbackSummary: completion.summary });
    assert.equal(result.source, 'summary_human', name);
    assert.ok(result.deliveryText.startsWith(`${completion.summary_human}\n\nTechnical details:\n`), `${name}: ${result.deliveryText}`);
    assert.doesNotMatch(result.deliveryText, /Human summary:|^Details:/m, name);
  }
});

test('the humanized lead splits only at sentence ends, so dotted tokens and closing quotes survive', () => {
  // Each case runs past five sentences, so the producer cuts it to the first
  // five. A split inside a token rejoins as "dub_eng_v9. aac"; a split before
  // a closing quote or bracket moves it onto the next sentence.
  const more = Array.from({ length: 6 }, (_, i) => `Check ${i + 1} passed on the staging host.`);
  const cases = {
    decimals: ['Drift fixed to 0.00s and cue 344.25 moved to 347.50.'],
    version: ['Released v0.6.6 to the mirror.'],
    formula: ['Confidence is now conf = 1.0 + edge*(4/0.15) over the band.'],
    range: ['Utah moved 4.4 -> 3.6 after the change.'],
    'file name': ['Re-encoded dub_eng_v9.aac from the new mix.'],
    url: ['Docs are at https://example.com/guide/v2.html for review.'],
    'ellipsis without a space': ['Waited...then retried the push.'],
    'closing quote': ['The reviewer wrote "Done."', 'Next we merged it.'],
    'closing bracket': ['(See the log above.)', 'Then retry the job.'],
    'curly double quote': ['The reviewer wrote “Done.”', 'Next we merged it.'],
    'curly single quote': ['The note said ‘ship it.’', 'Then we shipped.'],
    'square bracket': ['[See the log above.]', 'Then retry the job.'],
    'curly brace': ['{Checked the config.}', 'Then reloaded it.'],
  };
  for (const [name, lead] of Object.entries(cases)) {
    const sentences = [...lead, ...more];
    assert.equal(summarizeCompletionText(sentences.join(' ')), sentences.slice(0, 5).join(' '), name);
  }

  // An abbreviation still ends a sentence, but the cut is the text as written.
  const abbreviated = ['Transient errors, e.g. timeouts, now retry.', ...more].join(' ');
  const lead = summarizeCompletionText(abbreviated);
  assert.ok(abbreviated.startsWith(lead) && lead.includes('e.g. timeouts'), lead);
});

test('a long run of closing quotes or brackets splits in linear time', () => {
  // The lookbehind once rescanned the run at every position: 100,000 quotes
  // took over 10 s here. A linear split takes a few milliseconds.
  for (const closer of ['"', ')']) {
    const text = `Fixed it. ${closer.repeat(100_000)}`;
    const started = performance.now();
    assert.equal(summarizeCompletionText(text), 'Fixed it.');
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${closer}: ${elapsed.toFixed(0)} ms`);
  }
});

// nhl-ml (#66): a 1,216-char report with formulas, ranges and file names. The
// producer keeps its first sentences as summary_human.
const nhlReport = readFileSync(join(__dirname, 'fixtures', 'nhl-ml-full-summary.txt'), 'utf8');

test('nhl-ml: the done path delivers the full report, and the stored lead is the report as written', () => {
  const { completion, result } = deliverDone(nhlReport);
  assert.ok(completion.summary_human.length < nhlReport.length * 0.6, 'the producer still cuts this report');
  assert.ok(nhlReport.startsWith(completion.summary_human), completion.summary_human);
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, nhlReport);
});

test('nhl-ml past the verbatim bound: the stored lead and the delivered rewrite keep formulas and file names intact', () => {
  const report = [nhlReport, nhlReport, nhlReport].join(' ');
  assert.ok(Buffer.byteLength(report) > MAX_VERBATIM_BYTES);
  const { completion, result } = deliverDone(report);
  assert.equal(result.source, 'summary_human');
  assert.ok(report.startsWith(completion.summary_human), completion.summary_human);
  for (const token of ['conf = 2.5 + edge*20', 'conf = 1.0 + edge*(4/0.15)', 'nhl-power-model.py', 'edge-scanner.py']) {
    assert.ok(completion.summary_human.includes(token), token);
  }
  assert.ok(result.deliveryText.includes('conf = 1.0 + edge*(4/0.15)'), result.deliveryText);
  assert.doesNotMatch(result.deliveryText, /\d\. \d|\w\. (?:py|aac)\b/);
});
