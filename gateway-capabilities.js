import { assertCredentialEnvironmentKeyAllowed } from './governance.js';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 64 * 1024;
const MAX_CAPABILITY_COUNT = 256;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;

export const GATEWAY_ENV_INJECT_HEADER = 'x-openclaw-env-inject';
export const GATEWAY_ENV_INJECT_CAPABILITY = 'chat-completions-env-inject-v1';
export const GATEWAY_CAPABILITY_BINDING_CAPABILITY = 'capability-binding-v1';
export const GATEWAY_ARTIFACT_BINDING_HEADER = 'x-openclaw-handoff-artifact';
export const GATEWAY_RUN_BINDING_HEADER = 'x-openclaw-runtime-instance';
export const GATEWAY_CAPABILITY_NONCE_HEADER = 'x-openclaw-capability-nonce';
export const MAX_GATEWAY_ENV_ENTRIES = 64;
export const MAX_GATEWAY_ENV_KEY_BYTES = 128;
export const MAX_GATEWAY_ENV_VALUE_BYTES = 4_096;
export const MAX_GATEWAY_ENV_INJECT_HEADER_BYTES = 7_168;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const capabilityCache = new Map();

export class GatewayCompatibilityError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'GatewayCompatibilityError';
    this.code = code;
    this.retryable = options.retryable === true;
    Object.assign(this, details);
  }
}

function compatibilityError(code, message, details = {}, options = {}) {
  return new GatewayCompatibilityError(code, message, details, options);
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeGatewayUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (cause) {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_INVALID_URL',
      `Gateway capability discovery requires a valid HTTP(S) URL: ${String(rawUrl)}`,
      {},
      { cause },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_INVALID_URL',
      `Gateway capability discovery does not support URL protocol ${parsed.protocol}`,
    );
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function buildEndpointUrl(gatewayUrl, endpoint) {
  return `${gatewayUrl}${endpoint}`;
}

function envValidationError(message, details = {}) {
  return compatibilityError(
    'GATEWAY_ENV_INJECT_INVALID',
    `Invalid materialized environment: ${message}`,
    details,
  );
}

/**
 * Validate and serialize a task-scoped environment map for the Gateway.
 * Empty and absent maps intentionally produce no header. Any non-empty input
 * that cannot be represented safely throws instead of being silently dropped.
 */
export function buildGatewayEnvInjectHeader(materializedEnv) {
  if (materializedEnv === null || materializedEnv === undefined) return {};
  if (
    typeof materializedEnv !== 'object'
    || Array.isArray(materializedEnv)
    || Object.getPrototypeOf(materializedEnv) !== Object.prototype
  ) {
    throw envValidationError('expected a plain object with string keys and values');
  }

  const descriptors = Object.getOwnPropertyDescriptors(materializedEnv);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length === 0) return {};
  if (keys.some(key => typeof key !== 'string')) {
    throw envValidationError('symbol keys are not supported');
  }
  if (keys.length > MAX_GATEWAY_ENV_ENTRIES) {
    throw envValidationError(
      `entry count ${keys.length} exceeds the limit of ${MAX_GATEWAY_ENV_ENTRIES}`,
      { entryCount: keys.length, maxEntryCount: MAX_GATEWAY_ENV_ENTRIES },
    );
  }

  const sanitized = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw envValidationError(`key ${JSON.stringify(key)} must be an enumerable data property`);
    }
    if (!ENV_KEY_PATTERN.test(key) || PROTOTYPE_POLLUTION_KEYS.has(key)) {
      throw envValidationError(`key ${JSON.stringify(key)} is not a safe environment variable name`);
    }
    try {
      assertCredentialEnvironmentKeyAllowed(key);
    } catch (cause) {
      throw envValidationError(cause.message, { key });
    }
    const keyBytes = byteLength(key);
    if (keyBytes > MAX_GATEWAY_ENV_KEY_BYTES) {
      throw envValidationError(
        `key ${JSON.stringify(key)} is ${keyBytes} bytes; maximum is ${MAX_GATEWAY_ENV_KEY_BYTES}`,
        { keyBytes, maxKeyBytes: MAX_GATEWAY_ENV_KEY_BYTES },
      );
    }
    const value = descriptor.value;
    if (typeof value !== 'string') {
      throw envValidationError(`value for ${JSON.stringify(key)} must be a string`);
    }
    if (value.includes('\0')) {
      throw envValidationError(`value for ${JSON.stringify(key)} must not contain NUL bytes`);
    }
    const valueBytes = byteLength(value);
    if (valueBytes > MAX_GATEWAY_ENV_VALUE_BYTES) {
      throw envValidationError(
        `value for ${JSON.stringify(key)} is ${valueBytes} bytes; maximum is ${MAX_GATEWAY_ENV_VALUE_BYTES}`,
        { key, valueBytes, maxValueBytes: MAX_GATEWAY_ENV_VALUE_BYTES },
      );
    }
    sanitized[key] = value;
  }

  const serialized = JSON.stringify(sanitized);
  const headerBytes = byteLength(serialized);
  if (headerBytes > MAX_GATEWAY_ENV_INJECT_HEADER_BYTES) {
    throw compatibilityError(
      'GATEWAY_ENV_INJECT_TOO_LARGE',
      `Materialized environment requires a ${headerBytes}-byte ${GATEWAY_ENV_INJECT_HEADER} header; `
        + `maximum is ${MAX_GATEWAY_ENV_INJECT_HEADER_BYTES} bytes`,
      { headerBytes, maxHeaderBytes: MAX_GATEWAY_ENV_INJECT_HEADER_BYTES },
    );
  }

  return { [GATEWAY_ENV_INJECT_HEADER]: serialized };
}

export function buildGatewayCapabilityBindingHeaders(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_BINDING_INVALID',
      'Gateway capability binding requires an object',
    );
  }
  const artifactDigest = binding.artifactDigest;
  const runtimeInstanceId = binding.runtimeInstanceId;
  const nonce = binding.nonce;
  if (typeof artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifactDigest)) {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_BINDING_INVALID',
      'Gateway capability binding requires a lowercase SHA-256 artifact digest',
    );
  }
  for (const [name, value] of [['runtimeInstanceId', runtimeInstanceId], ['nonce', nonce]]) {
    if (
      typeof value !== 'string'
      || value.length === 0
      || value.length > 128
      || !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw compatibilityError(
        'GATEWAY_CAPABILITY_BINDING_INVALID',
        `Gateway capability binding ${name} is invalid`,
      );
    }
  }
  return {
    [GATEWAY_ARTIFACT_BINDING_HEADER]: artifactDigest,
    [GATEWAY_RUN_BINDING_HEADER]: runtimeInstanceId,
    [GATEWAY_CAPABILITY_NONCE_HEADER]: nonce,
  };
}

function invalidDiscovery(source, message, cause) {
  return compatibilityError(
    'GATEWAY_CAPABILITY_DISCOVERY_INVALID',
    `Gateway capability response from ${source} is invalid: ${message}`,
    { source },
    cause ? { cause } : {},
  );
}

function normalizeCapabilities(value, source) {
  if (!Array.isArray(value)) {
    throw invalidDiscovery(source, 'capabilities must be an array of non-empty strings');
  }
  if (value.length > MAX_CAPABILITY_COUNT) {
    throw invalidDiscovery(source, `capabilities exceeds ${MAX_CAPABILITY_COUNT} entries`);
  }
  const normalized = [];
  const seen = new Set();
  for (const capability of value) {
    if (
      typeof capability !== 'string'
      || capability.length === 0
      || byteLength(capability) > MAX_CAPABILITY_LENGTH
    ) {
      throw invalidDiscovery(
        source,
        `each capability must be a non-empty string no longer than ${MAX_CAPABILITY_LENGTH} bytes`,
      );
    }
    if (!seen.has(capability)) {
      seen.add(capability);
      normalized.push(capability);
    }
  }
  return normalized;
}

function normalizeVersion(value, source) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > MAX_VERSION_LENGTH) {
    throw invalidDiscovery(source, `version must be a non-empty string no longer than ${MAX_VERSION_LENGTH} bytes`);
  }
  return value;
}

function normalizeProtocol(value, source) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidDiscovery(source, 'protocol must be a positive integer');
  }
  return value;
}

function extractAdvertisedMetadata(payload, source, { requireCapabilities }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    if (requireCapabilities) throw invalidDiscovery(source, 'expected a JSON object');
    return null;
  }

  const capabilities = payload.capabilities ?? payload.features?.capabilities;
  if (capabilities === undefined) {
    if (requireCapabilities) throw invalidDiscovery(source, 'capabilities are missing');
    return null;
  }

  return Object.freeze({
    version: normalizeVersion(payload.version ?? payload.server?.version, source),
    protocol: normalizeProtocol(payload.protocol, source),
    capabilities: Object.freeze(normalizeCapabilities(capabilities, source)),
    source,
    legacy: false,
  });
}

async function readBoundedText(response, source) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_RESPONSE_BYTES) {
    throw invalidDiscovery(
      source,
      `response declares ${declaredLength} bytes; maximum is ${MAX_DISCOVERY_RESPONSE_BYTES}`,
    );
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const responseBytes = byteLength(text);
    if (responseBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
      throw invalidDiscovery(
        source,
        `response is ${responseBytes} bytes; maximum is ${MAX_DISCOVERY_RESPONSE_BYTES}`,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let responseBytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidDiscovery(
          source,
          `response exceeds ${MAX_DISCOVERY_RESPONSE_BYTES} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (cause) {
    if (cause instanceof GatewayCompatibilityError) throw cause;
    throw invalidDiscovery(source, 'response is not valid UTF-8 text', cause);
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw invalidDiscovery(source, 'response is not valid JSON', cause);
  }
}

function responseDeclaresJson(response) {
  const contentType = response.headers?.get?.('content-type');
  return typeof contentType === 'string' && /(?:^|[/+])json(?:$|\s*;)/i.test(contentType);
}

async function fetchCapabilityMetadata(gatewayUrl, opts) {
  const {
    fetchImpl,
    requestHeaders,
    timeoutMs,
  } = opts;
  const requestOptions = {
    method: 'GET',
    redirect: 'error',
    headers: {
      'Accept': 'application/json',
      ...requestHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
  };

  const infoSource = '/v1/info';
  let infoResponse;
  try {
    infoResponse = await fetchImpl(buildEndpointUrl(gatewayUrl, infoSource), requestOptions);
  } catch (cause) {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_FAILED',
      `Gateway capability discovery request to ${infoSource} failed: ${cause.message || String(cause)}`,
      { source: infoSource },
      { cause, retryable: true },
    );
  }

  if (infoResponse.ok && responseDeclaresJson(infoResponse)) {
    const text = await readBoundedText(infoResponse, infoSource);
    return extractAdvertisedMetadata(parseJson(text, infoSource), infoSource, {
      requireCapabilities: true,
    });
  }
  if (!infoResponse.ok && ![404, 405, 501].includes(infoResponse.status)) {
    const detail = (await readBoundedText(infoResponse, infoSource)).slice(0, 500);
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_FAILED',
      `Gateway capability discovery at ${infoSource} failed with HTTP ${infoResponse.status}`
        + (detail ? `: ${detail}` : ''),
      { source: infoSource, status: infoResponse.status },
      { retryable: infoResponse.status >= 500 },
    );
  }
  // Current Gateways may serve the Control UI HTML fallback at unknown /v1/*
  // routes with HTTP 200. A non-JSON response is not capability metadata, so
  // treat it like an absent info endpoint and continue to the legacy probe.
  try { await infoResponse.body?.cancel(); } catch {}

  const healthSource = '/health';
  let healthResponse;
  try {
    healthResponse = await fetchImpl(buildEndpointUrl(gatewayUrl, healthSource), requestOptions);
  } catch (cause) {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_FAILED',
      `Legacy Gateway health request failed: ${cause.message || String(cause)}`,
      { source: healthSource },
      { cause, retryable: true },
    );
  }
  if (!healthResponse.ok) {
    const detail = (await readBoundedText(healthResponse, healthSource)).slice(0, 500);
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_FAILED',
      `Legacy Gateway health request failed with HTTP ${healthResponse.status}`
        + (detail ? `: ${detail}` : ''),
      { source: healthSource, status: healthResponse.status },
      { retryable: healthResponse.status >= 500 },
    );
  }

  const healthText = await readBoundedText(healthResponse, healthSource);
  let healthPayload = null;
  if (healthText.trim()) {
    try {
      healthPayload = JSON.parse(healthText);
    } catch {
      // Historical Gateways returned plain text from /health. That is positive
      // liveness evidence but not authoritative capability evidence.
    }
  }
  const advertised = extractAdvertisedMetadata(healthPayload, healthSource, {
    requireCapabilities: false,
  });
  if (advertised) return advertised;

  return Object.freeze({
    version: normalizeVersion(
      healthPayload && typeof healthPayload === 'object' ? healthPayload.version : null,
      healthSource,
    ),
    protocol: null,
    capabilities: Object.freeze([]),
    source: healthSource,
    legacy: true,
  });
}

/** Discover explicit Gateway capability metadata and cache it per base URL. */
export async function discoverGatewayCapabilities(opts = {}) {
  const gatewayUrl = normalizeGatewayUrl(opts.gatewayUrl || 'http://127.0.0.1:18789');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw compatibilityError(
      'GATEWAY_CAPABILITY_DISCOVERY_FAILED',
      'Gateway capability discovery requires a fetch implementation',
    );
  }
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  const cacheTtlMs = Number.isInteger(opts.cacheTtlMs) && opts.cacheTtlMs >= 0
    ? opts.cacheTtlMs
    : DEFAULT_CACHE_TTL_MS;
  const cacheKey = gatewayUrl;
  const now = Date.now();
  const cached = capabilityCache.get(cacheKey);
  if (!opts.forceRefresh && cached && cached.expiresAt > now) {
    return cached.value;
  }

  const pending = fetchCapabilityMetadata(gatewayUrl, {
    fetchImpl,
    requestHeaders: opts.requestHeaders || {},
    timeoutMs,
  });
  capabilityCache.set(cacheKey, {
    value: pending,
    expiresAt: now + cacheTtlMs,
  });
  try {
    return await pending;
  } catch (err) {
    if (capabilityCache.get(cacheKey)?.value === pending) capabilityCache.delete(cacheKey);
    throw err;
  }
}

export function clearGatewayCapabilityCache(gatewayUrl) {
  if (gatewayUrl === undefined) {
    capabilityCache.clear();
    return;
  }
  capabilityCache.delete(normalizeGatewayUrl(gatewayUrl));
}

/**
 * Negotiate the env-injection receiver before any credential-bearing request.
 * A non-empty materialized map is an enforcement requirement, never a hint.
 */
export async function negotiateGatewayEnvironmentInjection(materializedEnv, opts = {}) {
  const envHeaders = buildGatewayEnvInjectHeader(materializedEnv);
  const bindingHeaders = opts.binding
    ? buildGatewayCapabilityBindingHeaders(opts.binding)
    : {};
  const requiresEnvInjection = opts.requireEnvInjection === true
    || Object.hasOwn(envHeaders, GATEWAY_ENV_INJECT_HEADER);
  const requiresBinding = Object.hasOwn(bindingHeaders, GATEWAY_ARTIFACT_BINDING_HEADER);
  if (!requiresEnvInjection && !requiresBinding) {
    return Object.freeze({ headers: Object.freeze({}), gateway: null });
  }

  // Revalidate immediately before every credential-bearing or artifact-bound
  // request. A cached positive result must not survive a Gateway restart or
  // capability downgrade.
  const gateway = await discoverGatewayCapabilities({ ...opts, forceRefresh: true });
  const requiredCapabilities = [
    ...(requiresEnvInjection ? [GATEWAY_ENV_INJECT_CAPABILITY] : []),
    ...(requiresBinding ? [GATEWAY_CAPABILITY_BINDING_CAPABILITY] : []),
  ];
  const missing = requiredCapabilities.filter(capability => !gateway.capabilities.includes(capability));
  if (missing.length > 0) {
    const gatewayLabel = gateway.version ? `Gateway ${gateway.version}` : 'The connected Gateway';
    const envOnlyFailure = missing.length === 1 && missing[0] === GATEWAY_ENV_INJECT_CAPABILITY;
    throw compatibilityError(
      envOnlyFailure ? 'GATEWAY_ENV_INJECT_UNSUPPORTED' : 'GATEWAY_CAPABILITY_BINDING_UNSUPPORTED',
      `${gatewayLabel} does not advertise ${missing.join(', ')}, which is required to enforce this `
        + 'credential-bearing artifact-bound agent turn. Dispatch was refused so credentials or the '
        + 'artifact binding cannot be silently dropped.',
      {
        gatewayVersion: gateway.version,
        gatewayProtocol: gateway.protocol,
        gatewayCapabilities: [...gateway.capabilities],
        discoverySource: gateway.source,
        legacyGateway: gateway.legacy,
          requiredCapability: missing[0],
          requiredCapabilities,
          missingCapabilities: missing,
      },
    );
  }

  return Object.freeze({
    headers: Object.freeze({ ...envHeaders, ...bindingHeaders }),
    gateway,
  });
}
