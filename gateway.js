// Gateway API client -- independent dispatch via chat completions + system events
import { execFile, execFileSync } from 'child_process';
import {
  readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, realpathSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { getDb } from './db.js';
import { negotiateGatewayEnvironmentInjection } from './gateway-capabilities.js';

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

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const HOME_DIR = process.env.HOME || homedir();
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
    credentialRoot,
    resolve('/run/secrets'),
    resolve('/var/run/secrets'),
    ...(process.env.NODE_ENV === 'test' ? [resolve(tmpdir())] : []),
  ].map(root => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
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
    // codeql[js/path-injection]
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
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    return Promise.resolve({ ok: false, aborted: false, error: 'sessionKey is required' });
  }
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5_000;
  const params = {
    sessionKey,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
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
 * @param {string|null} [opts.authProfile] - Auth profile header value.
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
    timeoutMs = 300000,
    signal,
    cancelOnAbort = true,
  } = opts;

  const envInjection = await negotiateGatewayEnvironmentInjection(materializedEnv, {
    gatewayUrl: GATEWAY_URL,
    requestHeaders: authHeaders(),
  });

  const controller = new AbortController();
  let abortReason = null;
  const unlinkExternalAbort = linkExternalAbort(controller, signal, () => { abortReason = 'external'; });
  const timer = setTimeout(() => {
    abortReason = 'timeout';
    controller.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        ...(agentId ? { 'x-openclaw-agent-id': agentId } : {}),
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
        ...(authProfile ? { 'x-openclaw-auth-profile': authProfile } : {}),
        ...envInjection.headers,
      },
      body: JSON.stringify({
        model: model || `openclaw:${agentId}`,
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
      sessionKey: resp.headers.get('x-openclaw-session-key') || sessionKey,
      raw: data,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      if (cancelOnAbort && sessionKey) {
        await cancelAgentSession(sessionKey, { agentId, timeoutMs: Math.min(timeoutMs, 5_000) });
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
 * @param {string} opts.authProfile       - Auth profile override (null, 'inherit', or 'provider:label')
 * @param {Record<string, string>|null} [opts.materializedEnv] - Required task-scoped environment to inject
 * @param {string[]} [opts.sessionKinds]  - Optional session kinds to track for activity polling
 */
export async function runAgentTurnWithActivityTimeout(opts) {
  const {
    message,
    agentId = 'main',
    sessionKey,
    model,
    authProfile,
    materializedEnv,
    idleTimeoutMs = 120000,       // per-check idle threshold (from payload_timeout_seconds)
    pollIntervalMs = 60000,       // check activity every 60s
    absoluteTimeoutMs = 300000,   // hard ceiling (run_timeout_ms)
    sessionKinds,
    signal,
    cancelOnAbort = true,
  } = opts;

  const envInjection = await negotiateGatewayEnvironmentInjection(materializedEnv, {
    gatewayUrl: GATEWAY_URL,
    requestHeaders: authHeaders(),
  });

  const controller = new AbortController();
  let abortReason = null;
  const unlinkExternalAbort = linkExternalAbort(controller, signal, () => { abortReason = 'external'; });
  const normalizedAgentId = (agentId || 'main').toLowerCase();
  const normalizedSessionKey = String(sessionKey || '').toLowerCase();

  const inferSessionKinds = () => {
    if (Array.isArray(sessionKinds) && sessionKinds.length > 0) {
      return [...new Set(sessionKinds.map(k => String(k).toLowerCase()).filter(Boolean))];
    }

    // Explicitly isolated/subagent sessions should not be pinned to main session
    // so they can report idleness based on their own active session records.
    if (
      normalizedSessionKey === 'isolated' ||
      normalizedSessionKey.startsWith('isolated:') ||
      normalizedSessionKey.endsWith(':isolated') ||
      normalizedSessionKey.includes(':isolated:') ||
      normalizedAgentId === 'subagent'
    ) {
      return ['subagent', 'isolated'];
    }

    // Default to including main unless we can clearly infer this is an isolated run.
    if (
      normalizedAgentId === 'main' ||
      normalizedSessionKey === 'main' ||
      normalizedSessionKey.startsWith('main:') ||
      normalizedSessionKey.includes(':main:') ||
      normalizedSessionKey.endsWith(':main')
    ) {
      return ['main', 'subagent', 'isolated'];
    }

    return ['main', 'subagent', 'isolated'];
  };

  const resolvedSessionKinds = inferSessionKinds();

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
      const result = await listSessions({ kinds: resolvedSessionKinds, activeMinutes: 60 });
      // Normalise: gateway wraps result in several layers
      const sessions =
        result?.result?.details?.sessions ||
        result?.result?.sessions ||
        result?.sessions ||
        result || [];
      if (!Array.isArray(sessions)) return;

      const matched = sessions.find(
        s => (s.key || s.sessionKey) === sessionKey
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

  try {
    const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('operator.write'),
        ...(agentId ? { 'x-openclaw-agent-id': agentId } : {}),
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey } : {}),
        ...(authProfile ? { 'x-openclaw-auth-profile': authProfile } : {}),
        ...envInjection.headers,
      },
      body: JSON.stringify({
        model: model || `openclaw:${agentId}`,
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
      sessionKey: resp.headers.get('x-openclaw-session-key') || sessionKey,
      raw: data,
    };
  } catch (err) {
    // Translate AbortError into descriptive messages
    if (controller.signal.aborted) {
      if (cancelOnAbort && sessionKey) {
        await cancelAgentSession(sessionKey, {
          agentId,
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

/**
 * Invoke a tool via the Gateway's /tools/invoke endpoint.
 */
export async function invokeGatewayTool(tool, args, sessionKey = 'main') {
  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ tool, args, sessionKey }),
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
    const resp = await fetch(`${GATEWAY_URL}/health`, {
      headers: authHeaders(),
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
      const resp = await fetch(`${GATEWAY_URL}/health`, {
        headers: authHeaders(),
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

/**
 * Write authProfileOverride directly to the gateway's sessions.json store.
 *
 * The gateway reads sessions.json on each agent turn (with mtime-based cache
 * invalidation), so writing here before dispatch ensures the embedded runner
 * picks up the correct auth profile.
 *
 * The x-openclaw-auth-profile HTTP header sent by runAgentTurnWithActivityTimeout
 * is NOT read by the gateway (dead header). This direct store write is the
 * effective mechanism for auth profile propagation to isolated sessions.
 *
 * @param {string} sessionKey - Session key as used in the HTTP request (e.g. 'scheduler:<jobId>')
 * @param {string} authProfile - Auth profile ID (e.g. 'anthropic:gmail')
 * @param {string} [agentId='main'] - Agent ID for store path resolution
 * @returns {{ ok: boolean, error?: string }}
 */
function resolveSessionKeyAliases(sessionKey, agentId = 'main') {
  const canonicalMatch = sessionKey.match(/^agent:[^:]+:(.+)$/);
  const canonicalKey = sessionKey.startsWith('agent:')
    ? sessionKey
    : `agent:${agentId}:${sessionKey}`;
  const flatSessionKey = canonicalMatch?.[1] || sessionKey;
  return Array.from(new Set([canonicalKey, flatSessionKey]));
}

function parseSessionModelRef(modelRef) {
  const trimmed = typeof modelRef === 'string' ? modelRef.trim() : '';
  if (!trimmed) {
    return { providerOverride: undefined, modelOverride: undefined };
  }
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return { providerOverride: undefined, modelOverride: trimmed };
  }
  const providerOverride = trimmed.slice(0, slashIndex).trim();
  const modelOverride = trimmed.slice(slashIndex + 1).trim();
  return {
    providerOverride: providerOverride || undefined,
    modelOverride: modelOverride || undefined,
  };
}

/**
 * Write scheduler-managed session overrides directly to the gateway's sessions.json store.
 *
 * The gateway reads sessions.json on each agent turn (with mtime-based cache
 * invalidation), so writing here before dispatch ensures the embedded runner
 * picks up the correct auth profile and model selection.
 *
 * @param {string} sessionKey - Session key as used in the HTTP request (e.g. 'scheduler:<jobId>')
 * @param {{ authProfile?: string | null, modelRef?: string | null }} overrides - Desired session overrides
 * @param {string} [agentId='main'] - Agent ID for store path resolution
 * @returns {{ ok: boolean, error?: string }}
 */
export function applySessionOverridesToSessionStore(sessionKey, overrides = {}, agentId = 'main') {
  if (!sessionKey) {
    return { ok: false, error: 'sessionKey is required' };
  }

  const authProfile = typeof overrides.authProfile === 'string' ? overrides.authProfile.trim() : '';
  const shouldSetAuthProfile = Boolean(authProfile) && authProfile !== 'inherit';
  const { providerOverride, modelOverride } = parseSessionModelRef(overrides.modelRef);
  const shouldSetModelOverride = Boolean(modelOverride);

  const keyAliases = resolveSessionKeyAliases(sessionKey, agentId);
  const sessionsPath = join(HOME_DIR, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');

  try {
    if (!existsSync(sessionsPath)) {
      return { ok: false, error: `sessions.json not found at ${sessionsPath}` };
    }

    const raw = readFileSync(sessionsPath, 'utf-8');
    const store = JSON.parse(raw);

    const now = Date.now();
    let changed = false;

    for (const key of keyAliases) {
      const existingEntry = store[key];
      if (!existingEntry && !shouldSetAuthProfile && !shouldSetModelOverride) {
        continue;
      }

      const entry = existingEntry || { updatedAt: now };
      let entryChanged = false;

      if (shouldSetAuthProfile) {
        if (entry.authProfileOverride !== authProfile || entry.authProfileOverrideSource !== 'user') {
          entry.authProfileOverride = authProfile;
          entry.authProfileOverrideSource = 'user';
          delete entry.authProfileOverrideCompactionCount;
          entryChanged = true;
        }
      } else if (
        entry.authProfileOverride !== undefined ||
        entry.authProfileOverrideSource !== undefined ||
        entry.authProfileOverrideCompactionCount !== undefined
      ) {
        delete entry.authProfileOverride;
        delete entry.authProfileOverrideSource;
        delete entry.authProfileOverrideCompactionCount;
        entryChanged = true;
      }

      if (shouldSetModelOverride) {
        if (entry.modelOverride !== modelOverride) {
          entry.modelOverride = modelOverride;
          entryChanged = true;
        }
        if (providerOverride) {
          if (entry.providerOverride !== providerOverride) {
            entry.providerOverride = providerOverride;
            entryChanged = true;
          }
        } else if (entry.providerOverride !== undefined) {
          delete entry.providerOverride;
          entryChanged = true;
        }
      } else if (entry.modelOverride !== undefined || entry.providerOverride !== undefined) {
        delete entry.modelOverride;
        delete entry.providerOverride;
        entryChanged = true;
      }

      if (!entryChanged) {
        continue;
      }

      entry.updatedAt = now;
      store[key] = entry;
      changed = true;
    }

    if (!changed) {
      return { ok: true };
    }

    writeFileSync(sessionsPath, JSON.stringify(store), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to update sessions.json: ${err.message}` };
  }
}

export function applyAuthProfileToSessionStore(sessionKey, authProfile, agentId = 'main') {
  if (!sessionKey || !authProfile) {
    return { ok: false, error: 'sessionKey and authProfile are required' };
  }
  return applySessionOverridesToSessionStore(sessionKey, { authProfile }, agentId);
}

/**
 * Sync the live auth-profiles.json from the main agent store to the target
 * agent store at ~/.openclaw/agents/<agentId>/agent/auth-profiles.json.
 *
 * This ensures scheduler sessions always use fresh credentials (tokens, order,
 * default profile) even when no explicit auth_profile is set on the job.
 * Without this, sessions created from a stable session key inherit a stale
 * copy of the auth store that was snapshotted when the session was first created.
 *
 * This is a fast file-copy operation (~1ms) and is safe to call before every
 * agent turn.
 *
 * @param {string} [agentId='main'] - Agent ID for store path resolution
 * @returns {{ ok: boolean, error?: string }}
 */
export function syncAuthStoreToSession(agentId = 'main') {
  const livePath = join(HOME_DIR, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  const agentStorePath = join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');

  try {
    if (!existsSync(livePath)) {
      return { ok: false, error: `Live auth store not found at ${livePath}` };
    }

    // Ensure the agent directory exists
    const agentDir = join(HOME_DIR, '.openclaw', 'agents', agentId, 'agent');
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    copyFileSync(livePath, agentStorePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to sync auth store: ${err.message}` };
  }
}
