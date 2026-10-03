import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { humanizeCompletionText, resolveCompletionDelivery, summarizeCompletionText, summarizeProse, resolveProseBudget, MAX_PROSE_DELIVERY_CHARS, TELEGRAM_PROSE_BUDGET, DISCORD_PROSE_BUDGET, DEFAULT_PROSE_BUDGET } from '../dispatch/completion.mjs';

// Same boundary logic as splitSentences() in dispatch/completion.mjs: split at
// sentence-ending punctuation followed by whitespace, optionally after closing
// quote/bracket characters. Decimals/formulas ("2.5", "1.0 + edge*(4/0.15)")
// never split because nothing whitespace follows the dot.
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])["'”’)\]}]*(?=\s)/;

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

test('oversized prose is truncated at a sentence boundary without mangling decimals/formulas', () => {
  const fixture = readFileSync(join(__dirname, 'fixtures', 'nhl-ml-full-summary.txt'), 'utf8').trim();
  // Repeat the fixture until the input exceeds the channel budget, so the
  // in-budget pass-through branch is skipped and splitSentences() actually runs.
  const input = Array.from({ length: 4 }, () => fixture).join(' ');
  assert.ok(input.length > MAX_PROSE_DELIVERY_CHARS, `input must exceed the budget, got ${input.length} chars`);

  const summarized = summarizeCompletionText(input);
  assert.ok(summarized, 'must produce a delivery text');

  // (a) Truncated to the channel budget.
  assert.ok(summarized.length < input.length, 'oversized prose must be truncated');
  assert.ok(summarized.length <= MAX_PROSE_DELIVERY_CHARS, 'truncated prose must respect the channel budget');

  // (b) Decimals/formulas survive intact, with no space-inserted fragments.
  assert.ok(summarized.includes('conf = 2.5'), 'decimal conf = 2.5 must be intact after truncation');
  assert.ok(summarized.includes('conf = 1.0 + edge*(4/0.15)'), 'formula must be intact after truncation');
  assert.ok(!/2\. 5|1\. 0|5\. 0/.test(summarized), 'no space-mangled fragments anywhere in the output');

  // (c) Truncation landed at a sentence boundary: the output must be exactly
  // the first k whole sentences of the input (joined with single spaces),
  // for some k — never a mid-sentence cut.
  const inputSentences = input.split(SENTENCE_BOUNDARY_RE).map(part => part.trim()).filter(Boolean);
  assert.ok(inputSentences.length > 1, 'input must contain multiple sentences');
  const match = inputSentences.findIndex((_, k) => k > 0 && inputSentences.slice(0, k).join(' ') === summarized);
  assert.ok(match > 0, 'output must be a join of whole input sentences (clean boundary)');
  assert.ok(summarized.endsWith('.') || summarized.endsWith('!') || summarized.endsWith('?'), 'output must end at a sentence terminator');
});

test('quoted sentence boundary: a period followed by a closing quote still splits', () => {
  // Direct unit-style assertion for the splitSentences() boundary: the period
  // in 'Done."' is followed by a closing quote, then whitespace — it must split
  // (the quote is consumed as part of the separator, so the kept fragment is
  // 'Done.').
  const quoted = 'Done." Next sentence.';
  const quotedParts = quoted.split(SENTENCE_BOUNDARY_RE).map(part => part.trim()).filter(Boolean);
  assert.deepEqual(quotedParts, ['Done.', 'Next sentence.'], 'period + closing quote must be a sentence boundary');

  // Behavioral check through summarizeCompletionText: force the oversized path
  // so splitSentences() actually runs. The output must be a join of whole
  // sentences — which only happens if the period followed by a closing quote
  // is treated as a boundary (before the fix, the whole input was one
  // "sentence" and truncation cut it mid-token).
  const quotedInput = Array.from({ length: 200 }, () => quoted).join(' ');
  assert.ok(quotedInput.length > MAX_PROSE_DELIVERY_CHARS, 'quoted input must exceed the budget');
  const summarized = summarizeCompletionText(quotedInput);
  assert.ok(summarized, 'must produce a delivery text');
  assert.ok(summarized.length < quotedInput.length, 'quoted prose must be truncated');
  const inputSentences = quotedInput.split(SENTENCE_BOUNDARY_RE).map(part => part.trim()).filter(Boolean);
  assert.ok(inputSentences.length > 1, 'quoted boundary must produce multiple sentences');
  assert.ok(summarized.startsWith('Done.'), 'first kept sentence is the quoted one');
  const wholeSentenceJoin = inputSentences.findIndex((_, k) => k > 0 && inputSentences.slice(0, k).join(' ') === summarized);
  assert.ok(wholeSentenceJoin > 0, 'output must be a join of whole input sentences (quoted boundary respected)');
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

// --- Item A: per-channel prose pass-through budget -------------------------
//
// The prose pass-through budget is gated inside summarizeProse() (the
// summarizeCompletionText entry point routes plain prose there, but also
// routes multi-line / structured text to a 700-char structured summary that is
// channel-independent). So the channel-driven limit is asserted at the
// summarizeProse boundary -- the exact spot where an over-limit Discord payload
// would otherwise be passed through untruncated.

test('resolveProseBudget maps channels to the correct limits', () => {
  assert.equal(resolveProseBudget('telegram'), TELEGRAM_PROSE_BUDGET, 'telegram -> 4096');
  assert.equal(resolveProseBudget('Telegram'), TELEGRAM_PROSE_BUDGET, 'case-insensitive');
  assert.equal(resolveProseBudget('discord'), DISCORD_PROSE_BUDGET, 'discord -> 2000');
  assert.equal(resolveProseBudget('slack'), DEFAULT_PROSE_BUDGET, 'unknown channel -> conservative default');
  assert.equal(resolveProseBudget(null), DEFAULT_PROSE_BUDGET, 'no channel -> conservative default');
  assert.equal(resolveProseBudget(undefined), DEFAULT_PROSE_BUDGET, 'undefined -> conservative default');
  assert.equal(DEFAULT_PROSE_BUDGET, 2000, 'default must be conservative 2000, not 4096');
  assert.equal(TELEGRAM_PROSE_BUDGET, 4096, 'telegram budget is the 4096 cap');
  assert.equal(DISCORD_PROSE_BUDGET, 2000, 'discord budget is the 2000 cap');
  // Object forms (watcher passes effectiveDeliveryTarget / entry).
  assert.equal(resolveProseBudget({ channel: 'discord' }), DISCORD_PROSE_BUDGET);
  assert.equal(resolveProseBudget({ channel: 'telegram' }), TELEGRAM_PROSE_BUDGET);
  assert.equal(resolveProseBudget({ deliverChannel: 'discord' }), DISCORD_PROSE_BUDGET);
  assert.equal(resolveProseBudget({ target: 'x', channel: 'telegram' }), TELEGRAM_PROSE_BUDGET);
});

// Plain single-line prose sized between the discord (2000) and telegram (4096)
// budgets. 24 sentences x ~148 chars ~= 3550 chars: > discord 2000, <= telegram
// 4096. For plain prose the raw text and the prepareLines-stripped text are
// identical, so the in-budget pass-through is exact and the only thing that
// differs between channels is the budget.
const MID_RANGE_PROSE = Array.from({ length: 24 }, (_, i) =>
  `Statement number ${i + 1} records a routine maintenance action performed on the delivery pipeline today with no structural headings, bold labels, or code.`).join(' ');

test('discord-channel prose in the 2001-4096 range is truncated to <=2000, not passed through', () => {
  assert.ok(MID_RANGE_PROSE.length > DISCORD_PROSE_BUDGET, `fixture must exceed the discord budget, got ${MID_RANGE_PROSE.length}`);
  assert.ok(MID_RANGE_PROSE.length <= TELEGRAM_PROSE_BUDGET, `fixture must fit the telegram budget, got ${MID_RANGE_PROSE.length}`);

  const discord = summarizeProse(MID_RANGE_PROSE, resolveProseBudget('discord'));
  assert.ok(discord, 'discord path must produce a delivery text');
  assert.ok(discord.length < MID_RANGE_PROSE.length, 'discord: over-limit prose must be truncated, not passed through');
  assert.ok(discord.length <= DISCORD_PROSE_BUDGET, `discord: truncated prose must respect the 2000 budget, got ${discord.length}`);

  // Channel neutrality: an unknown channel gets the same conservative 2000 cap.
  const unknown = summarizeProse(MID_RANGE_PROSE, resolveProseBudget('slack'));
  assert.equal(unknown, discord, 'unknown channel must use the same conservative 2000 budget as discord');
});

test('telegram-channel prose in the same 2001-4096 range is passed through intact to <=4096', () => {
  const telegram = summarizeProse(MID_RANGE_PROSE, resolveProseBudget('telegram'));
  assert.equal(telegram, MID_RANGE_PROSE, 'telegram: in-budget prose must pass through intact (full text, not a teaser)');
  assert.ok(telegram.length <= TELEGRAM_PROSE_BUDGET, 'telegram: pass-through must respect the 4096 budget');
});

test('the delivery channel actually drives the prose limit (discord vs telegram diverge)', () => {
  const discord = summarizeProse(MID_RANGE_PROSE, resolveProseBudget('discord'));
  const telegram = summarizeProse(MID_RANGE_PROSE, resolveProseBudget('telegram'));
  assert.notEqual(discord, telegram, 'same input must produce different output per channel');
  assert.ok(discord.length <= DISCORD_PROSE_BUDGET, 'discord output bounded by 2000');
  assert.equal(telegram.length, MID_RANGE_PROSE.length, 'telegram output is the full input');
  assert.ok(telegram.length > discord.length, 'telegram pass-through must be longer than discord truncation');
});

test('resolveCompletionDelivery threads the channel budget into the prose pass-through', () => {
  // lastReply is plain prose (not a human final report), so the prose budget
  // gate applies. Same lastReply: discord truncates, telegram passes through.
  const discord = resolveCompletionDelivery({
    lastReply: MID_RANGE_PROSE,
    completion: null,
    fallbackSummary: null,
    proseBudget: resolveProseBudget('discord'),
  });
  assert.ok(discord.deliveryText, 'discord: must deliver a text');
  assert.ok(discord.deliveryText.length <= DISCORD_PROSE_BUDGET, `discord: delivery must respect 2000, got ${discord.deliveryText.length}`);
  assert.ok(discord.deliveryText.length < MID_RANGE_PROSE.length, 'discord: delivery must be truncated');

  const telegram = resolveCompletionDelivery({
    lastReply: MID_RANGE_PROSE,
    completion: null,
    fallbackSummary: null,
    proseBudget: resolveProseBudget('telegram'),
  });
  assert.equal(telegram.deliveryText, MID_RANGE_PROSE, 'telegram: delivery must be the full report');
});

// --- Item B: in-budget pass-through returns RAW text, not prepareLines-stripped ---

test('in-budget prose with a formula and code span returns the raw text intact (no markdown stripping)', () => {
  // Single-line prose so it stays on the summarizeProse pass-through path (the
  // structured path is line-count based and legitimately strips markdown). The
  // input carries an inline code span AND a fenced code block with the formula
  // `score = x ** 2 + y ** 3`, which prepareLines would corrupt to `x 2 + y 3`.
  const input = 'Fixed the NHL ML confidence pinning. The curve is `score = x ** 2 + y ** 3` and it stays monotonic over the sensible band. ```js const score = x ** 2 + y ** 3; ``` Verified end-to-end on the live slate with no regressions.';
  assert.ok(input.length < DEFAULT_PROSE_BUDGET, `fixture must fit the default budget, got ${input.length}`);

  const summarized = summarizeCompletionText(input);
  assert.equal(summarized, input, 'in-budget prose must be returned verbatim (raw), not stripped');
  assert.ok(summarized.includes('** 2'), 'formula must keep its ** markers intact (still containing "** 2")');
  assert.ok(summarized.includes('x ** 2 + y ** 3'), 'full formula must survive');
  assert.ok(!summarized.includes('x 2 + y 3'), 'formula must NOT be corrupted to "x 2 + y 3"');
  assert.ok(summarized.includes('```js'), 'fenced code block must survive verbatim');
  assert.ok(summarized.includes('const score = x ** 2 + y ** 3;'), 'code line must survive verbatim');
  assert.ok(summarized.includes('`score = x ** 2 + y ** 3`'), 'inline code span must survive verbatim');
});

test('in-budget raw pass-through works through humanizeCompletionText too', () => {
  const input = 'Fixed the model. The curve is `score = x ** 2 + y ** 3` and it stays monotonic. Verified on the live slate with no regressions.';
  assert.ok(input.length < DEFAULT_PROSE_BUDGET, `fixture must fit the default budget, got ${input.length}`);
  const humanized = humanizeCompletionText(input);
  assert.equal(humanized, input, 'in-budget prose must pass through humanizeCompletionText verbatim');
  assert.ok(humanized.includes('** 2'), 'formula markers must survive');
});

test('oversized prose still truncates at a clean sentence boundary without space-mangled decimals (regression guard)', () => {
  // Plain-text sentences with a decimal (conf = 2.5) so the oversized output
  // (prepareLines-stripped) is byte-identical to the raw input sentences and a
  // clean-boundary join can be asserted exactly. This guards the existing
  // sentence-boundary truncation behavior against space-mangled decimals.
  const base = 'Fixed the model and the curve stays monotonic. conf = 2.5 remains intact over the 0-15pp band.';
  const input = Array.from({ length: 40 }, () => base).join(' ');
  assert.ok(input.length > DEFAULT_PROSE_BUDGET, `fixture must exceed the default budget, got ${input.length}`);

  const summarized = summarizeCompletionText(input);
  assert.ok(summarized, 'must produce a delivery text');
  assert.ok(summarized.length < input.length, 'oversized prose must be truncated');
  assert.ok(summarized.length <= DEFAULT_PROSE_BUDGET, `truncated prose must respect the budget, got ${summarized.length}`);
  // Decimals/formulas survive intact with no space-mangled fragments.
  assert.ok(summarized.includes('conf = 2.5'), 'decimal conf = 2.5 must be intact after truncation');
  assert.ok(!/2\. 5|1\. 0|5\. 0/.test(summarized), 'no space-mangled decimals anywhere in the output');
  // Truncation landed at a sentence boundary: output is a join of whole sentences.
  const inputSentences = input.split(SENTENCE_BOUNDARY_RE).map(part => part.trim()).filter(Boolean);
  assert.ok(inputSentences.length > 1, 'input must contain multiple sentences');
  const match = inputSentences.findIndex((_, k) => k > 0 && inputSentences.slice(0, k).join(' ') === summarized);
  assert.ok(match > 0, 'output must be a join of whole input sentences (clean boundary)');
  assert.ok(summarized.endsWith('.') || summarized.endsWith('!') || summarized.endsWith('?'), 'output must end at a sentence terminator');
});
