// Gateway API client -- independent dispatch via chat completions + system events
import { execFile, execFileSync } from 'child_process';
import {
  readFileSync, realpathSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { getDb } from './db.js';
import { callGatewayPreparation, GatewayPreparationError } from './dispatch/gateway-rpc.mjs';
export { GatewayPreparationError } from './dispatch/gateway-rpc.mjs';
import { negotiateGatewayEnvironmentInjection } from './gateway-capabilities.js';
import {
  agentIdFromSessionKey,
  assertValidAgentId,
  assertValidSessionKey,
  assertSessionKeyForAgent,
  buildGatewayEndpointUrl,
  parseGatewayBaseUrl,
} from './identifiers.js';

export {
  GATEWAY_ENV_INJECT_CAPABILITY,
  GATEWAY_ENV_INJECT_HEADER,
  GatewayCompatibilityError,
  MAX_GATEWAY_ENV_ENTRIES,
  MAX_GATEWAY_ENV_INJECT_HEADER_BYTES,
  MAX_GATEWAY_ENV_KEY_BYTES,
  MAX_GATEWAY_ENV_VALUE_BYTES,
  buildGatewayEnvInjectHeader,
  clearGatewayCapabilityCache,
  discoverGatewayCapabilities,
  negotiateGatewayEnvironmentInjection,
} from './gateway-capabilities.js';

const GATEWAY_BASE_URL = parseGatewayBaseUrl(
  process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789',
);
const GATEWAY_URL = GATEWAY_BASE_URL.href;
const gatewayEndpointUrl = endpoint => buildGatewayEndpointUrl(GATEWAY_BASE_URL, endpoint);
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// -- Isolated dispatch primitive contract --------------------
//
// Cron jobs with session_target=isolated must reach the gateway via the
// public HTTP API only. Forking a sibling `openclaw` process to spawn the
// session is rejected: in production that primitive has SIGTERM'd the
// launchd-tracked gateway parent (the child inherits the parent's listening
// socket on port 18789 and the parent dies), leaving an orphan node process
// holding the port. See rh-bot.lan zombie-cascade incident report.
//
// runIsolatedAgentTurn is the only sanctioned dispatch primitive for
// session_target=isolated cron jobs. It MUST NOT spawn, fork, or exec any
// child process. Any future change that needs subprocess execution belongs
// behind a different, explicitly-named helper so reviewers can keep this
// contract intact.
export const ISOLATED_DISPATCH_PRIMITIVE = 'http-chat-completions';

function isWithinPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

/**
 * Resolve the Gateway token file through an explicit credential-root allowlist.
 * The canonical path check also prevents a symlink inside an allowed directory
 * from escaping to an arbitrary file.
 */
export function resolveGatewayTokenPath(configuredPath = process.env.OPENCLAW_GATEWAY_TOKEN_PATH) {
  const credentialRoot = resolve(homedir(), '.openclaw', 'credentials');
  const allowedRoots = [
    { path: credentialRoot, rejectSymlink: true },
    { path: resolve('/run/secrets'), rejectSymlink: false },
    { path: resolve('/var/run/secrets'), rejectSymlink: false },
    ...(process.env.NODE_ENV === 'test'
      ? [{ path: resolve(tmpdir()), rejectSymlink: false }]
      : []),
  ].map(({ path, rejectSymlink }) => {
    try {
      const canonicalRoot = realpathSync(path);
      return rejectSymlink && canonicalRoot !== path ? null : canonicalRoot;
    } catch {
      return null;
    }
  }).filter(Boolean);
  const requestedPath = configuredPath || join(credentialRoot, '.gateway-token');
  let canonicalPath;
  try {
    canonicalPath = realpathSync(resolve(requestedPath));
  } catch {
    return null;
  }
  return allowedRoots.some(root => isWithinPath(root, canonicalPath))
    ? canonicalPath
    : null;
}

function getGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const tokenPath = resolveGatewayTokenPath();
    if (!tokenPath) return null;
    // The canonical token path is constrained to credential roots above.
    return readFileSync(tokenPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function authHeaders(scopes = null) {
  const token = getGatewayToken();
  return token
    ? {
      'Authorization': `Bearer ${token}`,
      ...(scopes ? { 'x-openclaw-scopes': scopes } : {}),
    }
    : {};
}

function linkExternalAbort(controller, signal, onAbort) {
  if (!signal) return () => {};
  if (typeof signal.addEventListener !== 'function') {
    throw new Error('signal must be an AbortSignal');
  }
  const handler = () => {
    onAbort?.();
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (signal.aborted) handler();
  else signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

function parseGatewayCliJson(stdout) {
  const text = String(stdout || '');
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  if (starts.length === 0) return null;
  return JSON.parse(text.slice(Math.min(...starts)));
}

function resolveGatewayResponseSessionKey(response, requestedSessionKey, agentId) {
  const responseSessionKey = response.headers?.get?.('x-openclaw-session-key');
  if (responseSessionKey === null || responseSessionKey === undefined) return requestedSessionKey;
  return assertSessionKeyForAgent(responseSessionKey, agentId, 'Gateway response session key');
}

/**
 * Return true only when chat.abort supplied positive evidence that the target
 * agent run stopped. A generic successful RPC response is not enough to make
 * replay safe because older or incompatible gateways may omit abort details.
 */
export function isAgentCancellationConfirmed(outcome) {
  return Boolean(
    outcome?.ok === true
      && (
        outcome.aborted === true
        || (
          outcome.runIdsReported === true
          && Array.isArray(outcome.runIds)
          && outcome.runIds.length === 0
        )
      )
  );
}

/** Best-effort active-session cancellation through the Gateway RPC API. */
export function cancelAgentSession(sessionKey, opts = {}) {
  let validatedSessionKey;
  let validatedAgentId;
  try {
    validatedSessionKey = assertValidSessionKey(sessionKey, 'sessionKey');
    validatedAgentId = opts.agentId === undefined
      ? undefined
      : assertValidAgentId(opts.agentId, 'agentId');
    if (validatedAgentId) {
      assertSessionKeyForAgent(validatedSessionKey, validatedAgentId, 'sessionKey');
    }
  } catch (error) {
    return Promise.resolve({ ok: false, aborted: false, error: error.message });
  }
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5_000;
  const params = {
    sessionKey: validatedSessionKey,
    ...(validatedAgentId ? { agentId: validatedAgentId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  };

  return new Promise(resolve => {
    execFile(
      'openclaw',
      [
        'gateway', 'call', 'chat.abort',
        '--params', JSON.stringify(params),
        '--json',
        '--timeout', String(timeoutMs),
      ],
      { encoding: 'utf8', timeout: timeoutMs + 1_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, aborted: false, error: error.message });
          return;
        }
        try {
          const result = parseGatewayCliJson(stdout);
          const runIdsReported = Array.isArray(result?.runIds);
          resolve({
            ok: result?.ok !== false,
            aborted: Boolean(result?.aborted),
            runIds: runIdsReported ? result.runIds : [],
            runIdsReported,
            result,
          });
        } catch (err) {
          resolve({ ok: false, aborted: false, error: `Invalid gateway response: ${err.message}` });
        }
      },
    );
  });
}

// -- Chat Completions (independent dispatch) -----------------

/**
 * Run an agent turn via the OpenAI-compatible chat completions endpoint.
 * Returns the full response including the assistant message.
 *
 * This is the primary dispatch mechanism for isolated jobs.
 * Each call gets its own session (or use sessionKey for continuity).
 *
 * @param {object} opts
 * @param {string} opts.message - The user message to send.
 * @param {string} [opts.agentId='main'] - Agent ID.
 * @param {string} [opts.sessionKey] - Session key for continuity.
 * @param {string} [opts.model] - Model override.
 * @param {string|null} [opts.authProfile] - Explicit profiles require separate prepareAgentSelection.
 * @param {Record<string, string>|null} [opts.materializedEnv] - Required task-scoped environment to inject.
 * @param {number} [opts.timeoutMs=300000] - Request timeout in milliseconds.
 */
export async function runAgentTurn(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    authProfile,
    materializedEnv,
    capabilityBinding,
    timeoutMs = 300000,
    signal,
    cancelOnAbort = true,
  } = opts;
  const validatedAgentId = assertValidAgentId(agentId, 'agentId');
  const validatedSessionKey = sessionKey === undefined || sessionKey === null
    ? sessionKey
    : assertSessionKeyForAgent(sessionKey, validatedAgentId, 'sessionKey');

  if (authProfile) throw new GatewayPreparationError('Explicit authProfile requires separate prepareAgentSelection before HTTP dispatch');
  splitModelOverride(model, validatedAgentId);

  const envInjection = await negotiateGatewayEnvironmentInjection(materializedEnv, {
    gatewayUrl: GATEWAY_URL,
    requestHeaders: authHeaders(),
    binding: capabilityBinding,
  });

  const controller = new AbortController();
  let abortReason = null;
  const unlinkExternalAbort = linkExternalAbort(controller, signal, () => { abortReason = 'external'; });
  const timer = setTimeout(() => {
    abortReason = 'timeout';
    controller.abort();
  }, timeoutMs);

  const modelRoute = splitModelOverride(model, validatedAgentId);

  try {
    const resp = await fetch(gatewayEndpointUrl('v1/chat/completions'), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        'x-openclaw-agent-id': validatedAgentId,
        ...(validatedSessionKey ? { 'x-openclaw-session-key': validatedSessionKey } : {}),
        ...(modelRoute.overrideHeader ? { 'x-openclaw-model': modelRoute.overrideHeader } : {}),
        ...envInjection.headers,
      },
      body: JSON.stringify({
        model: modelRoute.bodyModel,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Chat completions failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      sessionKey: resolveGatewayResponseSessionKey(resp, validatedSessionKey, validatedAgentId),
      raw: data,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      if (cancelOnAbort && validatedSessionKey) {
        await cancelAgentSession(validatedSessionKey, {
          agentId: validatedAgentId,
          timeoutMs: Math.min(timeoutMs, 5_000),
        });
      }
      if (abortReason === 'external') {
        const aborted = new Error('Agent turn aborted by caller', { cause: err });
        aborted.name = 'AbortError';
        aborted.code = 'ABORT_ERR';
        throw aborted;
      }
      throw new Error(`Agent turn timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    unlinkExternalAbort();
  }
}

/**
 * Activity-aware wrapper around runAgentTurn.
 *
 * Instead of a hard wall-clock abort, this polls the session's `updatedAt`
 * timestamp and only aborts when the session has been idle for 2x the idle
 * threshold (default: 2 x 120s = 240s of no activity).
 *
 * The absolute ceiling (`absoluteTimeoutMs`, default 5 min) is always enforced
 * as a safety net regardless of activity.
 *
 * @param {Object} opts
 * @param {string} opts.message           - Prompt to send
 * @param {string} opts.agentId           - Agent ID (default: 'main')
 * @param {string} opts.sessionKey        - Session key for matching activity
 * @param {string} opts.model             - Model override
 * @param {number} opts.idleTimeoutMs     - Per-check idle threshold; session aborts after 2x this value of continuous idle time
 * @param {number} opts.pollIntervalMs    - How often to poll session activity (default: 60000)
 * @param {number} opts.absoluteTimeoutMs - Hard ceiling regardless of activity (default: 300000)
 * @param {string} opts.authProfile       - Explicit profiles require separate prepareAgentSelection.
 * @param {Record<string, string>|null} [opts.materializedEnv] - Required task-scoped environment to inject
 * @param {string[]} [opts.sessionKinds]  - Ignored; activity is matched by exact session key across all kinds
 */
export async function runAgentTurnWithActivityTimeout(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    authProfile,
    materializedEnv,
    capabilityBinding,
    idleTimeoutMs = 120000,       // per-check idle threshold (from payload_timeout_seconds)
    pollIntervalMs = 60000,       // check activity every 60s
    absoluteTimeoutMs = 300000,   // hard ceiling (run_timeout_ms)
    signal,
    cancelOnAbort = true,
  } = opts;
  const validatedAgentId = assertValidAgentId(agentId, 'agentId');
  const validatedSessionKey = sessionKey === undefined || sessionKey === null
    ? sessionKey
    : assertSessionKeyForAgent(sessionKey, validatedAgentId, 'sessionKey');

  if (authProfile) throw new GatewayPreparationError('Explicit authProfile requires separate prepareAgentSelection before HTTP dispatch');
  splitModelOverride(model, validatedAgentId);

  const envInjection = await negotiateGatewayEnvironmentInjection(materializedEnv, {
    gatewayUrl: GATEWAY_URL,
    requestHeaders: authHeaders(),
    binding: capabilityBinding,
  });

  const controller = new AbortController();
  let abortReason = null;
  const unlinkExternalAbort = linkExternalAbort(controller, signal, () => { abortReason = 'external'; });

  // Hard absolute ceiling -- always fires regardless of activity
  const absoluteTimer = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortReason = 'absolute_timeout';
    controller.abort();
  }, absoluteTimeoutMs);

  // Track last known activity time (initialised to now -- grace period for startup)
  let lastSeenActivity = Date.now();

  const checkActivity = async () => {
    try {
      // Scheduler sessions can be classified as "other". Filtering by
      // main/subagent/isolated returns a successful list that omits the active
      // session, leaving lastSeenActivity unchanged and causing a false idle
      // timeout. Poll all kinds and match only the exact session key below.
      const result = await listSessions({ activeMinutes: 60 });
      // Normalise: gateway wraps result in several layers
      const sessions =
        result?.result?.details?.sessions ||
        result?.result?.sessions ||
        result?.sessions ||
        result || [];
      if (!Array.isArray(sessions)) return;

      const matched = sessions.find(
        s => (s.key || s.sessionKey) === validatedSessionKey
      );

      if (matched && matched.updatedAt) {
        const ts = typeof matched.updatedAt === 'number'
          ? matched.updatedAt
          : new Date(matched.updatedAt).getTime();
        if (ts > lastSeenActivity) {
          lastSeenActivity = ts;           // activity advanced -> reset
        }
      }

      // Check total continuous idle time
      const idleDuration = Date.now() - lastSeenActivity;
      if (idleDuration >= idleTimeoutMs * 2) {
        // Two full idle windows elapsed -- session is truly idle
        if (controller.signal.aborted) return;
        abortReason = 'idle_timeout';
        controller.abort();
      }
    } catch {
      // Monitoring failure -- don't abort on transient errors
    }
  };

  // Start polling after the first interval (gives session time to initialise)
  const pollTimer = setInterval(checkActivity, pollIntervalMs);

  const modelRoute = splitModelOverride(model, validatedAgentId);

  try {
    const resp = await fetch(gatewayEndpointUrl('v1/chat/completions'), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        'x-openclaw-agent-id': validatedAgentId,
        ...(validatedSessionKey ? { 'x-openclaw-session-key': validatedSessionKey } : {}),
        ...(modelRoute.overrideHeader ? { 'x-openclaw-model': modelRoute.overrideHeader } : {}),
        ...envInjection.headers,
      },
      body: JSON.stringify({
        model: modelRoute.bodyModel,
        messages: [{ role: 'user', content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Chat completions failed (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage,
      sessionKey: resolveGatewayResponseSessionKey(resp, validatedSessionKey, validatedAgentId),
      raw: data,
    };
  } catch (err) {
    // Translate AbortError into descriptive messages
    if (controller.signal.aborted) {
      if (cancelOnAbort && validatedSessionKey) {
        await cancelAgentSession(validatedSessionKey, {
          agentId: validatedAgentId,
          timeoutMs: Math.min(absoluteTimeoutMs, 5_000),
        });
      }
      if (abortReason === 'external') {
        const aborted = new Error('Agent turn aborted by caller', { cause: err });
        aborted.name = 'AbortError';
        aborted.code = 'ABORT_ERR';
        throw aborted;
      }
      if (abortReason === 'idle_timeout') {
        throw new Error(
          `Session idle for ${Math.round((idleTimeoutMs * 2) / 1000)}s -- aborted (activity-based timeout)`,
          { cause: err }
        );
      }
      if (abortReason === 'absolute_timeout') {
        throw new Error(
          `Exceeded absolute timeout of ${Math.round(absoluteTimeoutMs / 1000)}s`,
          { cause: err }
        );
      }
    }
    throw err;
  } finally {
    clearTimeout(absoluteTimer);
    clearInterval(pollTimer);
    unlinkExternalAbort();
  }
}

// -- Isolated dispatch primitive -----------------------------

/**
 * Sanctioned dispatch primitive for session_target=isolated cron jobs.
 *
 * This is a thin wrapper around runAgentTurnWithActivityTimeout that names
 * the contract: HTTP-only request to the gateway, no child process spawn.
 * The scheduler routes every session_target=isolated job through this
 * helper so the no-fork invariant is reviewable at one call site and
 * testable in isolation (see the no-subprocess regression test in test.js).
 *
 * Why a named wrapper instead of calling runAgentTurnWithActivityTimeout
 * directly: the dispatch primitive is the load-bearing surface that the
 * rh-bot.lan zombie-on-port outage cascaded through. A named entry point
 * gives operators and reviewers a single grep target ("runIsolatedAgentTurn")
 * to audit the no-spawn invariant.
 *
 * Accepts the same options as runAgentTurnWithActivityTimeout.
 */
export async function runIsolatedAgentTurn(opts) {
  return await runAgentTurnWithActivityTimeout(opts);
}

// -- System Events (main session) ----------------------------

/**
 * Send a system event to the main session.
 */
const VALID_MODES = new Set(['now', 'queue']);

export async function sendSystemEvent(text, mode = 'now') {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode '${mode}': must be one of ${[...VALID_MODES].join(', ')}`);
  }
  try {
    const result = execFileSync(
      'openclaw', ['system', 'event', '--text', text, '--mode', mode, '--json'],
      { encoding: 'utf8', timeout: 30000 }
    );
    // Strip any non-JSON prefix (e.g. openclaw doctor output) before parsing
    const jsonStart = result.indexOf('{');
    const clean = jsonStart >= 0 ? result.slice(jsonStart) : result;
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`system event failed: ${err.message}`, { cause: err });
  }
}

// -- Tools Invoke (for session listing, messages) ------------

// -- Chat-completions model routing ----------------------------------------
//
// The gateway's /v1/chat/completions endpoint only accepts routing model ids
// in the request body ("openclaw", "openclaw/default", "openclaw/<agentId>",
// "agent:<agentId>" -- see the gateway's isOpenClawAgentModelId). Concrete
// provider/model refs (e.g. "example/gpt-4o") are rejected there and
// belong in the x-openclaw-model header, which the gateway resolves via
// parseModelRef with a visibility-policy check. splitModelOverride routes a
// requested model into those two channels without ever mixing them.
// Installed Gateway routing syntax; keep general scheduler identity validation separate.
const ROUTING_AGENT_ID = '[a-z0-9][a-z0-9_-]{0,63}';
const ROUTING_MODEL_ID_PATTERN = new RegExp(
  `^(?:openclaw|openclaw\\/default|openclaw[:/]${ROUTING_AGENT_ID}|agent:${ROUTING_AGENT_ID})$`, 'i',
);

function splitModelOverride(model, agentId) {
  const bodyModel = `openclaw:${agentId}`;
  if (!ROUTING_MODEL_ID_PATTERN.test(bodyModel)) {
    throw new GatewayPreparationError('Agent ID is incompatible with the Gateway routing model syntax');
  }
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return { bodyModel, overrideHeader: undefined };
  if (ROUTING_MODEL_ID_PATTERN.test(trimmed)) {
    const routeAgent = /^(?:openclaw[:/]|agent:)(.+)$/i.exec(trimmed)?.[1];
    if (routeAgent && trimmed.toLowerCase() !== 'openclaw/default' && routeAgent.toLowerCase() !== agentId.toLowerCase()) {
      throw new GatewayPreparationError('Routing model owner does not match the requested agent');
    }
    return { bodyModel: trimmed, overrideHeader: undefined };
  }
  if (/^(?:openclaw[:/]|agent:)/i.test(trimmed)) {
    throw new GatewayPreparationError('Routing model is incompatible with the Gateway routing syntax');
  }
  if (splitProfileSuffix(trimmed).profile) {
    throw new GatewayPreparationError('Inline profile requires separate prepareAgentSelection before HTTP dispatch');
  }
  return { bodyModel, overrideHeader: trimmed };
}

/**
 * Invoke a tool via the Gateway's /tools/invoke endpoint.
 *
 * The request body always carries an explicit `agentId` owner, derived from
 * the session key via agentIdFromSessionKey (bare keys such as "main" fall
 * back to "main"). Multi-agent gateways reject bare keys without an explicit
 * owner ("session key \"main\" has no explicit owner"), so pinning it here is
 * a hard requirement of /tools/invoke, not an optimization. Callers passing
 * a non-bare `agent:<id>:...` key are routed to that key's owner by
 * construction — the body never disagrees with the session key.
 */
export async function invokeGatewayTool(tool, args, sessionKey = 'main') {
  const validatedSessionKey = assertValidSessionKey(sessionKey, 'sessionKey');
  const resp = await fetch(gatewayEndpointUrl('tools/invoke'), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ tool, args, sessionKey: validatedSessionKey, agentId: agentIdFromSessionKey(validatedSessionKey) }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${tool} failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  return resp.json();
}

/**
 * List active sessions (for task tracker auto-correlation).
 * opts.kinds: filter by session kind, e.g. ['subagent']
 * opts.activeMinutes: only sessions active within N minutes
 * opts.limit: max results
 */
export async function listSessions(opts = {}) {
  return invokeGatewayTool('sessions_list', {
    ...(opts.activeMinutes ? { activeMinutes: opts.activeMinutes } : {}),
    ...(opts.limit       ? { limit: opts.limit }       : {}),
    ...(opts.kinds       ? { kinds: opts.kinds }       : {}),
    messageLimit: 0,   // don't fetch message history -- we only need session metadata
  });
}

/**
 * Fetch ALL active sub-agent sessions across every requester.
 * Uses the gateway token's admin view -- not scoped to a single session.
 * Returns an array of session objects (keys like "agent:*:subagent:*").
 */
export async function getAllSubAgentSessions(activeMinutes = 10) {
  try {
    const result = await listSessions({ kinds: ['subagent'], activeMinutes, limit: 200 });
    // Gateway returns { sessions: [...] } or similar -- normalise to array
    const raw = result?.sessions || result?.result?.sessions || result || [];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a delivery alias. Returns { channel, target } or null.
 * Accepts '@name' or bare 'name'. Falls through to null if not found.
 */
export function resolveDeliveryAlias(rawTarget) {
  if (!rawTarget) return null;
  try {
    const db = getDb();
    const name = rawTarget.startsWith('@') ? rawTarget.slice(1) : rawTarget;
    const row = db.prepare('SELECT channel, target FROM delivery_aliases WHERE alias = ?').get(name);
    return row || null;
  } catch {
    return null;
  }
}

function chunkPlainText(message, maxBytes) {
  const text = String(message ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const chunks = [];
  let rest = text;
  const hardLimit = Math.max(256, maxBytes - 12);

  while (rest.length > 0) {
    if (Buffer.byteLength(rest, 'utf8') <= hardLimit) {
      chunks.push(rest);
      break;
    }

    // Walk forward tracking byte count to find the character index at the byte limit
    let byteCount = 0;
    let charLimit = 0;
    for (let i = 0; i < rest.length; i++) {
      const code = rest.codePointAt(i);
      const charBytes = code > 0xFFFF ? 4 : code > 0x7FF ? 3 : code > 0x7F ? 2 : 1;
      if (byteCount + charBytes > hardLimit) break;
      byteCount += charBytes;
      charLimit = i + 1;
      // Skip surrogate pair trailing unit
      if (code > 0xFFFF) i++;
    }

    let splitAt = rest.lastIndexOf('\n', charLimit);
    if (splitAt < charLimit * 0.5) splitAt = rest.lastIndexOf(' ', charLimit);
    if (splitAt < charLimit * 0.5) splitAt = charLimit;

    const part = rest.slice(0, splitAt).trimEnd();
    chunks.push(part);
    rest = rest.slice(splitAt).trimStart();
  }

  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

export function splitMessageForChannel(channel, message) {
  if (channel === 'telegram') {
    return chunkPlainText(message, TELEGRAM_MAX_MESSAGE_LENGTH);
  }
  return [String(message ?? '')];
}

export function normalizeDeliveryTarget(channel, target) {
  let resolvedChannel = channel || null;
  let resolvedTarget = target;

  const normalizedTarget = typeof resolvedTarget === 'string' ? resolvedTarget.trim() : resolvedTarget;
  if (!normalizedTarget) {
    return { channel: resolvedChannel, target: normalizedTarget || null };
  }

  const prefixedMatch = normalizedTarget.match(/^([a-z0-9_-]+)([:/])(.*)$/i);
  if (prefixedMatch) {
    const [, prefix,, rest] = prefixedMatch;
    if (!resolvedChannel || resolvedChannel === prefix) {
      resolvedChannel = prefix;
      resolvedTarget = rest;
    }
  }

  if (resolvedTarget && resolvedChannel && resolvedTarget.startsWith(resolvedChannel + '/')) {
    resolvedTarget = resolvedTarget.slice(resolvedChannel.length + 1);
  }
  if (resolvedTarget && resolvedChannel && resolvedTarget.startsWith(resolvedChannel + ':')) {
    resolvedTarget = resolvedTarget.slice(resolvedChannel.length + 1);
  }

  return {
    channel: resolvedChannel,
    target: typeof resolvedTarget === 'string' ? resolvedTarget.trim() : resolvedTarget,
  };
}

/**
 * Send a message to a Telegram/channel target via message tool.
 * Automatically resolves delivery aliases (e.g. '@team_room', 'owner_dm').
 */
export async function deliverMessage(channel, target, message) {
  let { channel: resolvedChannel, target: resolvedTarget } = normalizeDeliveryTarget(channel, target);

  // Resolve alias: try '@name' strip and bare name lookup
  if (resolvedTarget) {
    const alias = resolveDeliveryAlias(resolvedTarget);
    if (alias) {
      resolvedChannel = alias.channel;
      resolvedTarget = alias.target;
    }
  }

  const parts = splitMessageForChannel(resolvedChannel, message);
  let lastResponse = null;
  const responses = [];
  for (const [index, part] of parts.entries()) {
    try {
      lastResponse = await invokeGatewayTool('message', {
        action: 'send',
        message: part,
        ...(resolvedChannel ? { channel: resolvedChannel } : {}),
        ...(resolvedTarget ? { target: resolvedTarget } : {}),
      });
      // The gateway returns HTTP 200 with an in-band {result:{isError:true}} (or
      // {ok:false}) when the message tool fails to deliver -- only transport-level
      // failures surface as non-2xx in invokeGatewayTool. Without this check a
      // failed Telegram send would be recorded as delivered by the inbox consumer.
      assertGatewayToolSuccess(lastResponse, 'message');
      responses.push(lastResponse);
    } catch (err) {
      // Normalize before decorating: a thrown non-Error primitive/nullish value
      // would make property assignment throw and bury the original failure. Only
      // set `cause` when wrapping, so an already-Error throw is not made
      // self-referential (and keeps any cause it already carried).
      const error = err instanceof Error ? err : new Error(String(err), { cause: err });
      error.partIndex = index;
      error.responses = responses;
      error.lastResponse = lastResponse;
      // A later part failing after earlier parts were sent throws here; the inbox
      // consumer retries the whole message, so multi-part sends can resend an
      // already-delivered leading part. Accepted retry semantics (pre-existing for
      // transport failures); completion announces are effectively single-part.
      throw error;
    }
  }
  return {
    ok: true,
    channel: resolvedChannel,
    target: resolvedTarget,
    parts: parts.length,
    lastResponse,
    responses,
  };
}

// Detect an in-band gateway tool failure (HTTP 200 body that still reports an
// error). Mirrors how openclaw's own probes treat result.isError === true.
function assertGatewayToolSuccess(response, tool) {
  const failure = gatewayToolFailure(response);
  if (failure) {
    throw new Error(`Gateway ${tool} failed: ${failure}`);
  }
}

function gatewayToolFailure(response) {
  // Contract-precise: the gateway's authoritative failure signals are the
  // envelope `ok: false` and the MCP tool result `isError: true`. A bare
  // `error` field is only the detail source once a failure is known, never a
  // trigger on its own -- otherwise a successful result carrying an
  // informational `error`/`error: null`-adjacent field would false-positive.
  if (response == null || typeof response !== 'object') return 'empty response';
  if (response.ok === false) return stringifyGatewayError(response.error || response);

  const result = response.result;
  if (result && typeof result === 'object') {
    if (result.ok === false) return stringifyGatewayError(result.error || result);
    if (result.isError === true) return stringifyGatewayError(result.error || result.content || result);
  }

  return null;
}

function stringifyGatewayError(value) {
  if (value == null) return 'unknown error';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); }
}

/**
 * Check gateway health.
 */
export async function checkGatewayHealth() {
  try {
    const resp = await fetch(gatewayEndpointUrl('health'), {
      headers: authHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the gateway to become reachable, polling at intervals.
 * Returns true if the gateway responded within the timeout, false otherwise.
 * Any HTTP response (even non-200) counts as "up" -- we just need TCP connectivity.
 *
 * @param {number} timeoutMs  - Maximum time to wait (default 30s)
 * @param {number} intervalMs - Polling interval (default 2s)
 * @returns {Promise<boolean>}
 */
export async function waitForGateway(timeoutMs = 30000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(gatewayEndpointUrl('health'), {
        headers: authHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(intervalMs, 5000)),
      });
      try { await resp.body?.cancel(); } catch {}
      return true; // Any response means gateway is up
    } catch {
      // Not up yet -- wait and retry
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(intervalMs, remaining)));
    }
  }
  return false;
}

/** Split the current Gateway's profile suffix grammar, preserving date/quant model versions. */
function splitProfileSuffix(raw) {
  const trimmed = raw.trim();
  let delimiter = trimmed.indexOf('@', trimmed.lastIndexOf('/') + 1);
  if (delimiter <= 0) return { model: trimmed };
  if (/^\d{8}(?:@|$)/.test(trimmed.slice(delimiter + 1))) {
    delimiter = trimmed.indexOf('@', delimiter + 9);
    if (delimiter < 0) return { model: trimmed };
  }
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(trimmed.slice(delimiter + 1))) {
    delimiter = trimmed.indexOf('@', delimiter + 1);
    if (delimiter < 0) return { model: trimmed };
  }
  const model = trimmed.slice(0, delimiter).trim();
  const profile = trimmed.slice(delimiter + 1).trim();
  return model && profile ? { model, profile } : { model: trimmed };
}

/** Normalize the effective model/profile once for preparation and fallback identity. */
export function normalizeAgentSelection(overrides = {}, agentId = 'main') {
  const owner = assertValidAgentId(agentId, 'agentId');
  if (['modelRef', 'authProfile'].some(name => overrides[name] != null && typeof overrides[name] !== 'string')) {
    throw new GatewayPreparationError('Model and profile selections must be strings or null');
  }
  const rawModel = typeof overrides.modelRef === 'string' ? overrides.modelRef.trim() : '';
  const separateProfile = typeof overrides.authProfile === 'string' ? overrides.authProfile.trim() : '';
  const split = splitProfileSuffix(rawModel);
  if (separateProfile && split.profile && separateProfile !== split.profile) {
    throw new GatewayPreparationError('Conflicting model suffix and authProfile selections');
  }
  const profile = separateProfile || split.profile;
  const route = splitModelOverride(split.model, owner);
  const normalized = { model: split.model || undefined, authProfile: profile || undefined,
    identity: JSON.stringify([route.overrideHeader || `openclaw:${owner.toLowerCase()}`, profile || null]) };
  if (!profile) return normalized;
  if (profile === 'inherit' || /[\s/]/.test(profile)) {
    throw new GatewayPreparationError('Profile must be a resolved explicit ID without whitespace or slash');
  }
  const slash = split.model.indexOf('/');
  if (!route.overrideHeader || slash <= 0 || slash === split.model.length - 1) {
    throw new GatewayPreparationError('Explicit profile preparation requires a concrete provider/model reference');
  }
  // Reject suffixes that would be parsed into a different pair after concatenation.
  const modelWithProfile = `${split.model}@${profile}`;
  const verified = splitProfileSuffix(modelWithProfile);
  if (verified.model !== split.model || verified.profile !== profile) {
    throw new GatewayPreparationError('Ambiguous model/profile suffix combination');
  }
  return normalized;
}

/**
 * Apply Gateway session-pin metadata before a turn; never read/write a session file.
 * This is not a credential-use guarantee: Gateway auth resolution can clear invalid pins.
 * Model-only selections remain HTTP-only. The optional executor is for offline controls.
 */
export async function prepareAgentSelection(sessionKey, overrides = {}, agentId = 'main', opts = {}) {
  const owner = assertValidAgentId(agentId, 'agentId');
  const validatedKey = assertSessionKeyForAgent(sessionKey, owner, 'sessionKey');
  const key = validatedKey.startsWith('agent:') ? validatedKey : `agent:${owner}:${validatedKey}`;
  if (opts.signal?.aborted) throw new GatewayPreparationError('Gateway preparation cancelled', { code: 'ABORT_ERR' });
  const { model: selectedModel, authProfile: profile } = normalizeAgentSelection(overrides, owner);
  if (!profile) return { ok: true, applied: false, model: selectedModel };
  const slash = selectedModel.indexOf('/');
  const modelWithProfile = `${selectedModel}@${profile}`;
  const response = await callGatewayPreparation({ key, agentId: owner, model: modelWithProfile }, {
    ...opts,
    gatewayUrl: GATEWAY_URL,
    gatewayToken: opts.gatewayToken ?? getGatewayToken(),
    openclawCommand: opts.openclawCommand ?? process.env.OPENCLAW_CLI_PATH,
  });
  const entry = response?.entry;
  const provider = entry?.providerOverride ?? response?.resolved?.modelProvider;
  const model = entry?.modelOverride ?? response?.resolved?.model;
  if (response?.ok !== true || response.key !== key || !entry || Array.isArray(entry)
      || entry.authProfileOverride !== profile || entry.authProfileOverrideSource !== 'user'
      || provider !== selectedModel.slice(0, slash) || model !== selectedModel.slice(slash + 1)) {
    throw new GatewayPreparationError('Gateway preparation receipt does not match the requested session/model/profile', {
      code: 'GATEWAY_PREPARATION_UNKNOWN', uncertain: true,
    });
  }
  return { ok: true, applied: true, model: selectedModel, authProfile: profile };
}

/** Retired compatibility API: never silently mutate or report an applied local override. */
export function applySessionOverridesToSessionStore() {
  return { ok: false, error: 'Local session overrides are retired; use prepareAgentSelection' };
}

/** Retired compatibility API. */
export function applyAuthProfileToSessionStore() {
  return applySessionOverridesToSessionStore();
}

/**
 * Backward-compatible auth synchronization hook.
 *
 * Gateway-backed dispatch resolves credentials inside the running OpenClaw
 * Gateway. The scheduler must not copy auth profile files between agents:
 * current Gateways may use a non-file auth store, secondary agents support
 * read-through inheritance, and OAuth refresh credentials are not safely
 * cloneable. The exported hook remains for consumers that feature-detect it,
 * but reports that synchronization is intentionally owned by the Gateway.
 *
 * @deprecated Gateway-backed dispatch does not require credential-file sync.
 * @param {string} [agentId='main'] - Agent ID retained for API compatibility
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, error?: string }}
 */
export function syncAuthStoreToSession(agentId = 'main') {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    return { ok: false, error: 'agentId must be a non-empty string' };
  }
  try {
    assertValidAgentId(agentId, 'agentId');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, skipped: true, reason: 'gateway-managed-auth' };
}
