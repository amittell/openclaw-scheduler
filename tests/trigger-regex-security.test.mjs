import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { evalTriggerCondition, validateJobSpec } from '../jobs.js';

function childSpec(triggerCondition) {
  return {
    name: 'Regex security child',
    parent_id: 'parent-job-id',
    trigger_on: 'success',
    payload_message: 'handle matching output',
    run_timeout_ms: 30_000,
    delivery_mode: 'none',
    delivery_opt_out_reason: 'security test',
    trigger_condition: triggerCondition,
  };
}

test('RE2 trigger conditions preserve documented matching behavior', () => {
  const cases = [
    ['regex:ALERT', 'prefix ALERT suffix', true],
    ['regex:CPU|MEM', 'MEM usage high', true],
    ['regex:\\d+%', 'usage: 95%', true],
    ['regex:ERROR.*critical', 'ERROR: disk is critical', true],
    ['regex:^(alpha|beta)-[0-9]+$', 'beta-42', true],
    ['regex:^héllo\\s+世界$', 'héllo 世界', true],
    ['regex:ALERT', 'all clear', false],
  ];

  for (const [condition, input, expected] of cases) {
    assert.doesNotThrow(() => validateJobSpec(childSpec(condition)));
    assert.equal(evalTriggerCondition(condition, input), expected, condition);
  }
});

test('unsupported or malformed RE2 syntax is rejected on write and fails closed at runtime', () => {
  const rejected = [
    'regex:(',
    'regex:(a)\\1',
    'regex:a(?=b)',
    'regex:(?<=a)b',
  ];

  for (const condition of rejected) {
    assert.throws(
      () => validateJobSpec(childSpec(condition)),
      /Invalid trigger_condition regex/,
      condition,
    );
    assert.equal(evalTriggerCondition(condition, 'aab'), false, condition);
  }

  assert.equal(evalTriggerCondition('', 'anything'), false);
  assert.equal(evalTriggerCondition('contains:', 'anything'), false);
  assert.equal(evalTriggerCondition(1, 'anything'), false);
});

test('legacy catastrophic patterns are evaluated by the linear-time engine', () => {
  const jobsUrl = new URL('../jobs.js', import.meta.url).href;
  const script = `
    import { evalTriggerCondition } from ${JSON.stringify(jobsUrl)};
    const input = 'a'.repeat(50000) + '!';
    const patterns = ['regex:(a+)+$', 'regex:(a|aa)+$', 'regex:^([a-zA-Z]+)*$'];
    const results = patterns.map(pattern => evalTriggerCondition(pattern, input));
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, false, false]);
});

test('regex evaluation fails closed when UTF-8 input exceeds its bound', () => {
  assert.equal(evalTriggerCondition('regex:^a+$', 'a'.repeat(65_536)), true);
  assert.equal(evalTriggerCondition('regex:^a+$', 'a'.repeat(65_537)), false);
  assert.equal(evalTriggerCondition('regex:^é+$', 'é'.repeat(32_768)), true);
  assert.equal(evalTriggerCondition('regex:^é+$', 'é'.repeat(32_769)), false);
});

test('trigger condition length remains strictly bounded', () => {
  const maximumPattern = `^${'a'.repeat(1_016)}$`;
  assert.equal(`regex:${maximumPattern}`.length, 1_024);
  assert.doesNotThrow(() => validateJobSpec(childSpec(`regex:${maximumPattern}`)));
  assert.throws(
    () => validateJobSpec(childSpec(`regex:^${'a'.repeat(1_017)}$`)),
    /exceeds max length of 1024/,
  );
});

test('blank trigger conditions cannot silently become unconditional children', () => {
  for (const condition of ['', '   ', '\n']) {
    assert.throws(
      () => validateJobSpec(childSpec(condition)),
      /trigger_condition cannot be empty/,
    );
  }
  assert.equal(validateJobSpec(childSpec(null)).trigger_condition, null);

  const current = validateJobSpec(childSpec('contains:ready'));
  assert.throws(
    () => validateJobSpec({ trigger_condition: '   ' }, current, 'update'),
    /trigger_condition cannot be empty/,
  );
  assert.equal(
    validateJobSpec({ trigger_condition: null }, current, 'update').trigger_condition,
    null,
  );
});
