const CANONICAL_DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;

function freezeSetting(envName, defaultValue, min, max) {
  return Object.freeze({ envName, defaultValue, min, max });
}

function freezeBooleanSetting(envName, defaultValue) {
  return Object.freeze({ envName, defaultValue });
}

export const DISPATCHER_INTEGER_SETTINGS = Object.freeze({
  tickIntervalMs: freezeSetting('SCHEDULER_TICK_MS', 10_000, 1_000, 3_600_000),
  staleThresholdSeconds: freezeSetting('SCHEDULER_STALE_THRESHOLD_S', 90, 10, 604_800),
  heartbeatCheckMs: freezeSetting('SCHEDULER_HEARTBEAT_CHECK_MS', 30_000, 5_000, 3_600_000),
  messageDeliveryMs: freezeSetting('SCHEDULER_MESSAGE_DELIVERY_MS', 15_000, 5_000, 3_600_000),
  deliveryBatchSize: freezeSetting('SCHEDULER_DELIVERY_BATCH_SIZE', 10, 1, 1_000),
  pruneIntervalMs: freezeSetting('SCHEDULER_PRUNE_MS', 3_600_000, 60_000, 604_800_000),
  backupIntervalMs: freezeSetting('SCHEDULER_BACKUP_MS', 300_000, 60_000, 604_800_000),
  leaseTtlMs: freezeSetting('SCHEDULER_LEASE_TTL_MS', 30_000, 15_000, 3_600_000),
  maxConcurrency: freezeSetting('SCHEDULER_MAX_CONCURRENCY', 4, 1, 64),
  maxPending: freezeSetting('SCHEDULER_MAX_PENDING_WORK', 1_000, 1, 10_000),
});

export const DISPATCHER_BOOLEAN_SETTINGS = Object.freeze({
  backupEnabled: freezeBooleanSetting('SCHEDULER_BACKUP', false),
  debugEnabled: freezeBooleanSetting('SCHEDULER_DEBUG', false),
});

export const DISPATCHER_RUNTIME_OPTION_LIMITS = Object.freeze({
  leaseTtlMs: Object.freeze({ min: 1, max: 3_600_000 }),
  maxConcurrency: Object.freeze({ min: 1, max: 64 }),
  maxPending: Object.freeze({ min: 1, max: 10_000 }),
});

function invalidRuntimeConfig(name, detail) {
  const error = new Error(`Invalid ${name}: ${detail}`);
  error.code = 'ERR_INVALID_RUNTIME_CONFIG';
  error.variable = name;
  return error;
}

function validateBounds(name, min, max) {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new TypeError(`Invalid bounds for ${name}`);
  }
}

export function assertBoundedInteger(name, value, { min, max }) {
  validateBounds(name, min, max);
  if (!Number.isSafeInteger(value)) {
    throw invalidRuntimeConfig(name, 'expected a safe integer');
  }
  if (value < min || value > max) {
    throw invalidRuntimeConfig(name, `expected a value between ${min} and ${max} inclusive`);
  }
  return value;
}

export function assertIntegerAtLeast(name, value, minimumName, minimumValue) {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(minimumValue)) {
    throw new TypeError(`Invalid integer relationship between ${name} and ${minimumName}`);
  }
  if (value < minimumValue) {
    throw invalidRuntimeConfig(
      name,
      `expected a value greater than or equal to ${minimumName} (${minimumValue})`,
    );
  }
  return value;
}

export function parseStrictIntegerSetting(name, rawValue, { defaultValue, min, max }) {
  validateBounds(name, min, max);
  if (rawValue === undefined) {
    return assertBoundedInteger(name, defaultValue, { min, max });
  }
  if (typeof rawValue !== 'string' || !CANONICAL_DECIMAL_INTEGER.test(rawValue)) {
    throw invalidRuntimeConfig(name, 'expected a canonical base-10 integer');
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw invalidRuntimeConfig(name, 'expected a safe integer');
  }
  return assertBoundedInteger(name, value, { min, max });
}

export function parseStrictBooleanSetting(name, rawValue, { defaultValue = false } = {}) {
  if (typeof defaultValue !== 'boolean') {
    throw new TypeError(`Invalid default for ${name}`);
  }
  if (rawValue === undefined) return defaultValue;
  if (rawValue === '1' || rawValue === 'true') return true;
  if (rawValue === '0' || rawValue === 'false') return false;
  throw invalidRuntimeConfig(name, 'expected one of "0", "1", "false", or "true"');
}

export function loadDispatcherRuntimeConfig(env = process.env) {
  if (env === null || typeof env !== 'object') {
    throw new TypeError('Dispatcher environment must be an object');
  }

  const config = {};
  for (const [property, setting] of Object.entries(DISPATCHER_INTEGER_SETTINGS)) {
    config[property] = parseStrictIntegerSetting(setting.envName, env[setting.envName], setting);
  }
  for (const [property, setting] of Object.entries(DISPATCHER_BOOLEAN_SETTINGS)) {
    config[property] = parseStrictBooleanSetting(setting.envName, env[setting.envName], setting);
  }

  assertIntegerAtLeast(
    'SCHEDULER_MAX_PENDING_WORK',
    config.maxPending,
    'SCHEDULER_MAX_CONCURRENCY',
    config.maxConcurrency,
  );

  return Object.freeze(config);
}
