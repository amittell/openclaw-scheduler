import { existsSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';

// No static model fallback: OpenClaw's configured agent default is the only
// safe fallback because the gateway's allowlist can change independently.
export const STATIC_DISPATCH_DEFAULT_MODEL = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveModelPrimary(value) {
  const direct = normalizeString(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return normalizeString(value.primary);
}

function resolveHomeRelativePath(input, homeDir) {
  const trimmed = normalizeString(input);
  if (!trimmed) return null;
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
  return pathResolve(trimmed);
}

function resolveOpenClawStateDir({ env, homeDir }) {
  return resolveHomeRelativePath(env.OPENCLAW_STATE_DIR, homeDir) || join(homeDir, '.openclaw');
}

export function resolveOpenClawConfigPath({ env = process.env, homeDir } = {}) {
  const effectiveHome = homeDir || env.HOME || process.env.HOME;
  if (!effectiveHome) return null;
  return (
    resolveHomeRelativePath(env.OPENCLAW_CONFIG_PATH, effectiveHome) ||
    join(resolveOpenClawStateDir({ env, homeDir: effectiveHome }), 'openclaw.json')
  );
}

export function readOpenClawConfig({
  env = process.env,
  homeDir,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const configPath = resolveOpenClawConfigPath({ env, homeDir });
  if (!configPath || !exists(configPath)) return {};
  try {
    return JSON.parse(readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveOpenClawDispatchDefaultModel(config) {
  const defaults = isRecord(config?.agents?.defaults) ? config.agents.defaults : {};
  return (
    resolveModelPrimary(defaults.dispatch?.model) ||
    resolveModelPrimary(defaults.model) ||
    null
  );
}

export function resolveDefaultDispatchModel({
  dispatchConfig = {},
  openClawConfig,
  env = process.env,
  homeDir,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  return (
    normalizeString(dispatchConfig.defaultModel) ||
    resolveModelPrimary(dispatchConfig.dispatch?.model) ||
    normalizeString(env.DISPATCH_DEFAULT_MODEL) ||
    resolveOpenClawDispatchDefaultModel(
      openClawConfig ?? readOpenClawConfig({ env, homeDir, exists, readFile }),
    ) ||
    STATIC_DISPATCH_DEFAULT_MODEL
  );
}

/**
 * Probe whether a model is actually served by its provider.
 *
 * Background: a dispatch pinned to a model the provider no longer serves
 * (e.g. a renamed gpufarm catalog entry whose /v1/models list is empty)
 * would spawn, run for minutes, and die with an aborted run the watcher
 * classifies "interrupted" -- then auto-redispatch onto the same dead
 * model, burning the retry budget. This probe lets the spawn path and the
 * interrupted-redispatch path fail fast on a DEFINITIVE model-absent.
 *
 * Tolerant by design: network errors, missing config, missing API key,
 * unknown provider, non-OK HTTP status, and unexpected response shapes all
 * return { status: 'unknown' } so the caller falls through to normal
 * behavior. Only a reachable endpoint answering with a parseable model
 * list that omits the model (or an empty list) is 'not_served'.
 *
 * @param {string} model - provider-qualified model ID
 * @param {object} [opts]
 * @returns {Promise<{status: 'served'|'not_served'|'unknown', reason?: string, httpStatus?: number, data?: unknown}>}
 */
export async function probeModelAvailability(model, {
  fetchImpl = fetch, env = process.env, timeoutMs = 5000,
} = {}) {
  const modelId = normalizeString(model);
  const provider = normalizeString(env.DISPATCH_MODEL_PROBE_PROVIDER);
  const base = normalizeString(env.DISPATCH_MODEL_PROBE_BASE_URL);
  const apiKey = normalizeString(env.DISPATCH_MODEL_PROBE_API_KEY);
  if (!provider || !base || !apiKey) {
    return { status: 'unknown', reason: 'model catalog probe is not configured' };
  }
  const separator = modelId?.indexOf('/') ?? -1;
  if (separator < 1 || modelId.slice(0, separator) !== provider || separator === modelId.length - 1) {
    return { status: 'unknown', reason: 'model is outside the configured probe provider' };
  }
  const bareId = modelId.slice(separator + 1);

  // Only the operator's process environment selects the destination and credential.
  // The model is compared to the catalog after fetching it.
  let url;
  try {
    url = new URL(base);
  } catch {
    return { status: 'unknown', reason: 'unparseable provider base url' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username || url.password || url.search || url.hash) {
    return { status: 'unknown', reason: 'unsupported provider base url' };
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'unknown', reason: 'model catalog request failed' };
  }
  if (!res.ok) {
    return { status: 'unknown', reason: `probe http ${res.status}`, httpStatus: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'unknown', reason: 'unparseable models list' };
  }
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data) return { status: 'unknown', reason: 'unexpected models list shape', data: body };
  // A paginating provider may return only page 1; a truncated catalog is not
  // proof of absence, so fall through tolerantly instead of a false not_served.
  // Only an explicit "more pages" signal (non-null next/cursor/pagination,
  // has_more/hasMore true, or a meta.next/meta.cursor) marks the list as
  // incomplete -- a null next (last page) keeps the catalog definitive.
  const meta = isRecord(body?.meta) ? body.meta : null;
  const looksIncomplete =
    body.next != null ||
    body.cursor != null ||
    body.pagination != null ||
    body.has_more === true ||
    body.hasMore === true ||
    (meta && (meta.next != null || meta.cursor != null));
  if (looksIncomplete) {
    return { status: 'unknown', reason: 'paginated models list (catalog not provably complete)', data: body };
  }
  // A non-empty list whose entries all lack a usable `id` is a malformed
  // catalog, not proof of absence -- fall through tolerantly instead of
  // treating an empty id set as a definitive model-absent.
  const ids = [];
  for (const entry of data) {
    if (isRecord(entry)) {
      const id = normalizeString(entry.id);
      if (id) ids.push(id);
    }
  }
  if (data.length > 0 && ids.length === 0) {
    return { status: 'unknown', reason: 'malformed models list (no usable id fields)', data: body };
  }
  const idSet = new Set(ids);
  if (idSet.has(modelId) || idSet.has(bareId)) return { status: 'served', data: body };
  return {
    status: 'not_served',
    reason: `model_not_found: ${modelId} not served by ${provider}`,
    data: body,
  };
}

/**
 * Choose which model the liveness pre-check should probe for an enqueue.
 *
 * Fresh: the resolved default/explicit model is applied to the new session,
 * so probe it. Reuse: the continuation keeps the existing session's model
 * unless an explicit --model overrides it, so probe THAT instead of the
 * fresh-spawn default -- which would wrongly reject a healthy continuation
 * when the configured default has been retired but the session runs a
 * healthy explicit model.
 *
 * @param {object} p
 * @param {boolean} p.isFresh
 * @param {string|null} p.defaultModel - resolved default/explicit model
 * @param {string|null} p.explicitModel - the --model flag value (or null)
 * @param {string|null} p.labelModel - the label row's stored model (or null)
 * @returns {string|null} the model to probe, or null to skip the probe
 */
export function selectProbeModel({ isFresh, defaultModel, explicitModel, labelModel } = {}) {
  if (isFresh) return defaultModel || null;
  return explicitModel || labelModel || null;
}
