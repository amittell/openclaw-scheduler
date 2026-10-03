import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildTerminalCompletionPayload, humanizeCompletionText, resolveCompletionDelivery } from '../dispatch/completion.mjs';

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
const MAX_VERBATIM_CHARS = 3500;
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

test('done path: a legacy summaryHuman payload promotes the full summary too', () => {
  const result = resolveCompletionDelivery({
    completion: { summary: alignFull, summaryHuman: alignMangled, checklist: CHECKLIST },
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, alignFull);
});

test('sm-round8-align-fix: the full report reaches chat on the done and watcher paths', () => {
  const { completion, result } = deliverDone(alignReport.summary);
  assert.ok(completion.summary_human.includes('0. 00s'), 'the producer still truncates and mangles this report');
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, alignReport.summary);

  // The watcher's last reply has section labels but no final-report cue, so
  // the agent's own --summary, delivered in full, stays authoritative.
  const watcher = resolveCompletionDelivery({ lastReply: alignReport.lastReply, completion, fallbackSummary: completion.summary });
  assert.equal(watcher.deliveryText, alignReport.summary);
});

test('done path: a synthetic technical rewrite in summary_human gives way to the full report', () => {
  // sm-round8-fix stored the humanizer's technical rewrite: one fragment plus
  // its stock follow-up sentences, 133 chars standing in for a 1,619-char report.
  assert.ok(payload.completion.summary_human.endsWith('Future runs should be less likely to hit the same problem.'));
  assert.ok(payload.completion.summary.length > 1500);
  const result = resolveCompletionDelivery({
    completion: payload.completion,
    fallbackSummary: payload.completion.summary,
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, payload.completion.summary);
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

test('done path: machine output and over-long summaries are never delivered verbatim', () => {
  const item = (i) => `{"id":${i},"name":"maintenance-task-${i}","state":"ok","note":"fine"}`;
  const cases = {
    'prose lead then a JSON blob': 'Finished the maintenance sweep. Output follows:\n{"results":[' + Array.from({ length: 30 }, (_, i) => item(i + 1)).join(','),
    'JSON in an untagged code fence': '```\n{\n' + Array.from({ length: 40 }, (_, i) => `  "key${i}": "value number ${i}",`).join('\n') + '\n}\n```',
    'raw log lines': Array.from({ length: 30 }, (_, i) => `2026-09-24T10:00:${String(i).padStart(2, '0')}Z INFO worker=${i} processed batch ${i} ok`).join('\n'),
    '40 KB of prose': Array.from({ length: 550 }, (_, i) => `Step ${i + 1} finished and the output was checked against the expected values.`).join(' '),
  };
  for (const [name, summary] of Object.entries(cases)) {
    const { result } = deliverDone(summary);
    assert.notEqual(result.source, 'completion-summary-full', `${name}: promoted verbatim`);
    assert.ok(result.deliveryText.length <= MAX_VERBATIM_CHARS, `${name}: delivered ${result.deliveryText.length} chars`);
  }
});

test('done path: an agent-written "Technically:" split keeps its lead even when summary_human is a prefix', () => {
  const lead = 'Fixed the planner so the next session is recommended after the last completed one.';
  const { completion, result } = deliverDone(`${lead} Technically: mapped imported workout ids back to the program schedule, updated the focused progression tests, and verified on the live database snapshot that the last completed W2D4 now plans W2D5.`);
  assert.equal(completion.summary_human, lead);
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

test('cue-less section labels do not pass dumps, stack traces or JSON through verbatim', () => {
  const dump = ['**Alpha**: x', '**Bravo**: y', '**Charlie**: z', ...Array.from({ length: 2000 }, (_, i) => `line ${i} of a long dump`)].join('\n');
  const { result } = deliverDone(dump);
  assert.ok(result.deliveryText.length <= MAX_VERBATIM_CHARS, `delivered ${result.deliveryText.length} chars`);

  const stackTrace = '**Error**: TypeError: x is undefined\n**Stack**:\n    at foo (/srv/app/a.js:1:2)\n    at bar (/srv/app/b.js:3:4)\n**Context**: watcher';
  const jsonLines = '**out**: {"a":1}\n**err**: {"b":2}\n**raw**: {"c":3}\nx\ny';
  assert.notEqual(humanizeCompletionText(stackTrace), stackTrace);
  assert.notEqual(humanizeCompletionText(jsonLines), jsonLines);
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
