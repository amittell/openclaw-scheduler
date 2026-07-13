import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcherRuntime } from '../dispatcher-runtime.js';
import {
  DISPATCHER_BOOLEAN_SETTINGS,
  DISPATCHER_INTEGER_SETTINGS,
  DISPATCHER_RUNTIME_OPTION_LIMITS,
  loadDispatcherRuntimeConfig,
} from '../runtime-config.js';

function expectInvalidRuntimeConfig(fn, variable, messagePattern = null) {
  assert.throws(fn, error => {
    assert.equal(error?.code, 'ERR_INVALID_RUNTIME_CONFIG');
    assert.equal(error?.variable, variable);
    assert.match(error.message, new RegExp(variable));
    if (messagePattern) assert.match(error.message, messagePattern);
    return true;
  });
}

function runtimeCallbacks(overrides = {}) {
  return {
    acquireLease: (_name, ownerId) => ({ owner_id: ownerId, fencing_token: 1 }),
    renewLease: (_name, ownerId, fencingToken) => ({
      owner_id: ownerId,
      fencing_token: fencingToken,
    }),
    releaseLease: () => true,
    assertLease: () => true,
    ...overrides,
  };
}

test('dispatcher runtime configuration uses the documented valid defaults', () => {
  const config = loadDispatcherRuntimeConfig({});
  assert.deepEqual(config, {
    tickIntervalMs: 10_000,
    staleThresholdSeconds: 90,
    heartbeatCheckMs: 30_000,
    messageDeliveryMs: 15_000,
    deliveryBatchSize: 10,
    pruneIntervalMs: 3_600_000,
    backupIntervalMs: 300_000,
    leaseTtlMs: 30_000,
    maxConcurrency: 4,
    maxPending: 1_000,
    backupEnabled: false,
    debugEnabled: false,
  });
  assert.equal(Object.isFrozen(config), true);
});

test('every dispatcher integer setting accepts its inclusive minimum and maximum', () => {
  for (const [property, setting] of Object.entries(DISPATCHER_INTEGER_SETTINGS)) {
    const minimumEnv = { [setting.envName]: String(setting.min) };
    if (property === 'maxPending') minimumEnv.SCHEDULER_MAX_CONCURRENCY = '1';
    assert.equal(
      loadDispatcherRuntimeConfig(minimumEnv)[property],
      setting.min,
      `${setting.envName} should accept ${setting.min}`,
    );

    const maximumEnv = { [setting.envName]: String(setting.max) };
    assert.equal(
      loadDispatcherRuntimeConfig(maximumEnv)[property],
      setting.max,
      `${setting.envName} should accept ${setting.max}`,
    );
  }
});

test('dispatcher integer settings reject malformed, partial, negative, zero, and NaN values', () => {
  const setting = DISPATCHER_INTEGER_SETTINGS.tickIntervalMs;
  const invalidValues = [
    '',
    ' ',
    '50 ',
    ' 50',
    '+50',
    '-50',
    '1.5',
    '5e1',
    '0x32',
    '050',
    '50ms',
    'NaN',
    'Infinity',
  ];

  for (const value of invalidValues) {
    expectInvalidRuntimeConfig(
      () => loadDispatcherRuntimeConfig({ [setting.envName]: value }),
      setting.envName,
      /canonical base-10 integer/,
    );
  }

  expectInvalidRuntimeConfig(
    () => loadDispatcherRuntimeConfig({ [setting.envName]: '0' }),
    setting.envName,
    /between 1000 and 3600000 inclusive/,
  );
});

test('dispatcher integer settings reject overflow and unsafe integers before use', () => {
  const variable = DISPATCHER_INTEGER_SETTINGS.tickIntervalMs.envName;
  expectInvalidRuntimeConfig(
    () => loadDispatcherRuntimeConfig({ [variable]: '9'.repeat(400) }),
    variable,
    /safe integer/,
  );
  expectInvalidRuntimeConfig(
    () => loadDispatcherRuntimeConfig({ [variable]: '9007199254740992' }),
    variable,
    /safe integer/,
  );
});

test('every dispatcher integer setting enforces its explicit domain and names the variable', () => {
  for (const [property, setting] of Object.entries(DISPATCHER_INTEGER_SETTINGS)) {
    const below = setting.min - 1;
    const belowEnv = { [setting.envName]: String(below) };
    if (property === 'maxPending') belowEnv.SCHEDULER_MAX_CONCURRENCY = '1';
    expectInvalidRuntimeConfig(
      () => loadDispatcherRuntimeConfig(belowEnv),
      setting.envName,
      new RegExp(`between ${setting.min} and ${setting.max} inclusive`),
    );
    expectInvalidRuntimeConfig(
      () => loadDispatcherRuntimeConfig({ [setting.envName]: String(setting.max + 1) }),
      setting.envName,
      new RegExp(`between ${setting.min} and ${setting.max} inclusive`),
    );
    expectInvalidRuntimeConfig(
      () => loadDispatcherRuntimeConfig({ [setting.envName]: `${setting.defaultValue}units` }),
      setting.envName,
      /canonical base-10 integer/,
    );
  }
});

test('dispatcher boolean settings accept only exact boolean spellings', () => {
  const accepted = new Map([
    ['0', false],
    ['1', true],
    ['false', false],
    ['true', true],
  ]);

  for (const [property, setting] of Object.entries(DISPATCHER_BOOLEAN_SETTINGS)) {
    for (const [value, expected] of accepted) {
      assert.equal(loadDispatcherRuntimeConfig({ [setting.envName]: value })[property], expected);
    }
    for (const value of ['', 'TRUE', 'False', 'yes', 'on', ' true', 'true ', '2', 1, null]) {
      expectInvalidRuntimeConfig(
        () => loadDispatcherRuntimeConfig({ [setting.envName]: value }),
        setting.envName,
        /expected one of/,
      );
    }
  }
});

test('dispatcher configuration requires max pending work to cover max concurrency', () => {
  expectInvalidRuntimeConfig(
    () => loadDispatcherRuntimeConfig({
      SCHEDULER_MAX_CONCURRENCY: '8',
      SCHEDULER_MAX_PENDING_WORK: '7',
    }),
    'SCHEDULER_MAX_PENDING_WORK',
    /SCHEDULER_MAX_CONCURRENCY \(8\)/,
  );
  assert.equal(loadDispatcherRuntimeConfig({
    SCHEDULER_MAX_CONCURRENCY: '8',
    SCHEDULER_MAX_PENDING_WORK: '8',
  }).maxPending, 8);
});

test('dispatcher runtime constructor accepts low test TTLs and option boundaries', async () => {
  let observedTtl = null;
  const lowTtlRuntime = createDispatcherRuntime({
    leaseTtlMs: 60,
    maxConcurrency: 1,
    maxPending: 1,
    ...runtimeCallbacks({
      acquireLease: (_name, ownerId, ttlMs) => {
        observedTtl = ttlMs;
        return { owner_id: ownerId, fencing_token: 1 };
      },
    }),
  });
  assert.ok(lowTtlRuntime.start());
  assert.equal(observedTtl, 60);
  await lowTtlRuntime.stop();

  assert.doesNotThrow(() => createDispatcherRuntime({
    leaseTtlMs: DISPATCHER_RUNTIME_OPTION_LIMITS.leaseTtlMs.min,
    maxConcurrency: DISPATCHER_RUNTIME_OPTION_LIMITS.maxConcurrency.min,
    maxPending: DISPATCHER_RUNTIME_OPTION_LIMITS.maxPending.min,
    ...runtimeCallbacks(),
  }));
  assert.doesNotThrow(() => createDispatcherRuntime({
    leaseTtlMs: DISPATCHER_RUNTIME_OPTION_LIMITS.leaseTtlMs.max,
    maxConcurrency: DISPATCHER_RUNTIME_OPTION_LIMITS.maxConcurrency.max,
    maxPending: DISPATCHER_RUNTIME_OPTION_LIMITS.maxPending.max,
    ...runtimeCallbacks(),
  }));
});

test('dispatcher runtime constructor rejects invalid values instead of coercing or defaulting', () => {
  const invalidByOption = {
    leaseTtlMs: [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '60', '60ms', null],
    maxConcurrency: [0, -1, 1.5, NaN, Infinity, 65, '2', '2workers', null],
    maxPending: [0, -1, 1.5, NaN, Infinity, 10_001, '1000', '1000items', null],
  };

  for (const [option, values] of Object.entries(invalidByOption)) {
    for (const value of values) {
      expectInvalidRuntimeConfig(
        () => createDispatcherRuntime({ [option]: value, ...runtimeCallbacks() }),
        option,
      );
    }
  }
});

test('dispatcher runtime constructor enforces maxPending greater than or equal to maxConcurrency', () => {
  expectInvalidRuntimeConfig(
    () => createDispatcherRuntime({
      maxConcurrency: 8,
      maxPending: 7,
      ...runtimeCallbacks(),
    }),
    'maxPending',
    /maxConcurrency \(8\)/,
  );
  assert.doesNotThrow(() => createDispatcherRuntime({
    maxConcurrency: 8,
    maxPending: 8,
    ...runtimeCallbacks(),
  }));
});
