import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { humanizeCompletionText, resolveCompletionDelivery, summarizeCompletionText, MAX_PROSE_DELIVERY_CHARS } from '../dispatch/completion.mjs';

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

test('non-report chatter beyond the channel budget is still truncated, not passed through', () => {
  const chatter = Array.from({ length: 40 }, (_, i) =>
    `Sentence ${i + 1} describes some routine maintenance that was performed on the pipeline today with no structural headings or bold labels.`).join(' ');
  assert.ok(chatter.length > MAX_PROSE_DELIVERY_CHARS, 'chatter must exceed the channel pass-through budget');
  const humanized = humanizeCompletionText(chatter);
  assert.ok(humanized, 'chatter must still produce a delivery text');
  assert.ok(humanized.length < chatter.length, 'oversized non-report prose must be truncated, not passed through');
  assert.ok(humanized.length <= MAX_PROSE_DELIVERY_CHARS, 'truncated prose must respect the channel budget');
});

test('prose within the channel budget passes through intact (full summary, not a teaser)', () => {
  const summary = Array.from({ length: 12 }, (_, i) =>
    `Sentence ${i + 1} describes some routine maintenance that was performed on the pipeline today with no structural headings or bold labels.`).join(' ');
  assert.ok(summary.length < MAX_PROSE_DELIVERY_CHARS, 'summary must fit the channel budget');
  const humanized = humanizeCompletionText(summary);
  assert.equal(humanized, summary, 'in-budget prose must be delivered intact, not summarized');
});

test('completion summary keeps decimals/formulas intact and delivers the full text (regression)', () => {
  const fixture = readFileSync(join(__dirname, 'fixtures', 'nhl-ml-full-summary.txt'), 'utf8').trim();
  assert.ok(fixture.length > 700, 'fixture must exceed the old teaser budget');
  const summarized = summarizeCompletionText(fixture);
  assert.ok(summarized, 'must produce a delivery text');
  // Decimals and formulas must survive un-mangled (no space-inserted "2. 5").
  assert.ok(summarized.includes('conf = 2.5'), 'decimal conf = 2.5 must be intact');
  assert.ok(summarized.includes('conf = 1.0 + edge*(4/0.15)'), 'formula must be intact');
  assert.ok(!/2\. 5|5\. 0|12\. 5pp/.test(summarized), 'no space-inserted decimals');
  // The full summary is delivered (not a 155-char teaser) because it fits the channel budget.
  assert.equal(summarized, fixture, 'in-budget summary must pass through intact');
  assert.ok(summarized.length > 400, 'must not be truncated to the old teaser length');
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
