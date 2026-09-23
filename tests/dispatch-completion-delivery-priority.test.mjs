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
  assert.equal(result.summary, humanizeCompletionText(payload.completion?.summary_human) || payload.completion?.summary_human || result.summary);
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
