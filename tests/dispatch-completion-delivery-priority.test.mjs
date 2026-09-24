import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { humanizeCompletionText, resolveCompletionDelivery } from '../dispatch/completion.mjs';

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
// (clean or mangled prefix), and must NOT win when summary_human is a clean
// rewrite (the fitness / Apple-Health / sports-backtest shapes).
test('done path: mangled-prefix summary_human promotes full completion.summary', () => {
  const full = 'Round-8 alignment fix complete (all 3 items, re-verified, staged). ITEM 1 (7 SRT-offset lines): 3 were real EN sub offsets, fixed to 0.00s drift - i=37 Bunny. #32 344.25 to 347.50, i=83 Um show me. #75 738.11 to 739.00. ITEM 2 (32 missing-cue lines): 16 real EN lines got new 1:1 cues, 16 are jp_fallback. SRT 224 to 241 cues, sequential, chronological, 0 new overlaps. ITEM 3 (1251.9 gap): CONFIRMED real dropped JP line, regenerated No! via IndexTTS2 best-of-6, surgical mix and re-encode to dub_eng_v10.aac. RE-VERIFY: gate_03s.py OK, P1 max drift 4.54s to 0.36s. STAGED: srt md5 772f57d1 (241 cues), aac md5 04f634ff, lines_index md5 9f1cc522 (266 entries).';
  const mangled = full.slice(0, 160).replace('0.00s', '0. 00s').replace('344.25', '344. 25');
  const result = resolveCompletionDelivery({
    completion: { summary: full, summary_human: mangled, checklist: { work_complete: true } },
    fallbackSummary: full,
  });
  assert.equal(result.source, 'completion-summary-full');
  assert.equal(result.deliveryText, full);
  assert.ok(result.deliveryText.includes('0.00s') && result.deliveryText.includes('344.25'), 'numbers must be intact in the promoted summary');
});

test('done path: clean-rewrite summary_human is not overridden by raw summary', () => {
  const result = resolveCompletionDelivery({
    completion: payload.completion,
    fallbackSummary: payload.completion.summary,
  });
  assert.notEqual(result.source, 'completion-summary-full',
    'fixture summary_human is a clean rewrite, not a truncation - must not be promoted away');
  assert.equal(result.source, 'summary_human');
});

test('done path: thin completion.summary does not trigger the full-summary path', () => {
  const result = resolveCompletionDelivery({
    completion: { summary_human: 'Work complete. Files changed.', summary: 'done', checklist: { work_complete: true } },
    fallbackSummary: 'done',
  });
  assert.notEqual(result.source, 'completion-summary-full');
  assert.ok(result.deliveryText, 'still delivers something');
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
