import { execFile, execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** A preparation failure is retryable via another selection only when no mutation is uncertain. */
export class GatewayPreparationError extends Error {
  constructor(message, { code = 'GATEWAY_PREPARATION_REJECTED', uncertain = false, cause } = {}) {
    super(message, { cause });
    this.name = 'GatewayPreparationError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

/**
 * Separate, cancellable preparation transport. Never used by the HTTP turn primitive.
 * Bind the reviewed CLI and the same Gateway explicitly; never select a CLI via PATH.
 * The current CLI requests operator.write for {key, agentId, model} sessions.patch.
 */
export async function callGatewayPreparation(params, opts = {}) {
  const { openclawCommand, gatewayUrl, gatewayToken, signal } = opts;
  const timeout = opts.timeout ?? 10_000;
  if (signal?.aborted) {
    throw new GatewayPreparationError('Gateway preparation cancelled', { code: 'ABORT_ERR' });
  }
  if (!openclawCommand || !isAbsolute(openclawCommand) || !gatewayToken
      || !Number.isFinite(timeout) || timeout <= 0) {
    throw new GatewayPreparationError('Profile preparation requires an absolute OPENCLAW_CLI_PATH, Gateway authentication and a positive deadline');
  }
  if (!params || Object.keys(params).sort().join(',') !== 'agentId,key,model'
      || !['agentId', 'key', 'model'].every(key => typeof params[key] === 'string' && params[key].trim())) {
    throw new GatewayPreparationError('Preparation accepts only the write-scoped key, agentId and model fields');
  }
  let url;
  try {
    url = new URL(gatewayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid URL');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  } catch {
    throw new GatewayPreparationError('Profile preparation requires a valid bound Gateway HTTP URL');
  }
  const args = ['gateway', 'call', 'sessions.patch', '--json', '--params', JSON.stringify(params),
    '--timeout', String(Math.ceil(timeout))];
  const childEnv = { ...(opts.env || process.env),
    OPENCLAW_GATEWAY_URL: url.href, OPENCLAW_GATEWAY_TOKEN: gatewayToken };
  // The CLI pairs env URL/auth; --url requires argv credentials. Ignore ambient password.
  delete childEnv.OPENCLAW_GATEWAY_PASSWORD;
  const execute = opts.execFile || execFile;
  return await new Promise((resolve, reject) => {
    execute(openclawCommand, args, {
      encoding: 'utf8', timeout: Math.ceil(timeout), killSignal: 'SIGKILL', signal,
      maxBuffer: 1024 * 1024,
      env: childEnv,
    }, (error, stdout) => {
      let response;
      try { response = parseGatewayCliJson(stdout); } catch { /* No authoritative receipt. */ }
      // Current CLI formats a GatewayClientRequestError as typed JSON then exits 1.
      // Only this completed process/typed pre-mutation refusal is safe to retry.
      const completed = !error || (error.code === 1 && error.signal === null && error.killed === false);
      const definite = completed && !signal?.aborted && response?.ok === false
        && response.error?.type === 'gateway_request_error'
        && ['INVALID_REQUEST', 'FORBIDDEN'].includes(response.error?.code);
      if (definite) {
        reject(new GatewayPreparationError('Gateway rejected session profile preparation'));
        return;
      }
      // Nonzero success-looking output, interrupted processes and other errors are uncertain.
      // Never copy raw CLI diagnostics into run logs.
      if (error || signal?.aborted || !response || response.ok === false) {
        reject(new GatewayPreparationError('Gateway preparation did not return a definite outcome', {
          code: signal?.aborted ? 'ABORT_ERR' : 'GATEWAY_PREPARATION_UNKNOWN', uncertain: true,
        }));
        return;
      }
      resolve(response);
    });
  });
}

export class GatewayRpcError extends Error {
  constructor(method, error, options = {}) {
    const detail = typeof error === 'string'
      ? error
      : error?.message || error?.error || JSON.stringify(error);
    super(`gateway call ${method} failed: ${detail || 'unknown gateway error'}`, options);
    this.name = 'GatewayRpcError';
    this.code = typeof error === 'object' && error ? error.code || null : null;
    this.retryable = typeof error === 'object' && error ? error.retryable === true : false;
    this.gatewayError = error;
  }
}

/** Parse the JSON payload printed by the OpenClaw CLI after optional plugin log lines. */
export function parseGatewayCliJson(output) {
  const trimmed = String(output ?? '').trim();
  if (!trimmed) throw new Error('gateway CLI returned empty output');
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Plugin diagnostics commonly use bracketed prefixes such as `[plugin]`.
  // Only consider JSON-looking starts at line boundaries, plus an inline first
  // object/array start for older CLIs that print `notice: { ... }`.
  const starts = new Set();
  let lineStart = 0;
  while (lineStart < trimmed.length) {
    while (/\s/.test(trimmed[lineStart] || '')) lineStart += 1;
    if (trimmed[lineStart] === '{' || trimmed[lineStart] === '[') starts.add(lineStart);
    const nextLine = trimmed.indexOf('\n', lineStart);
    if (nextLine < 0) break;
    lineStart = nextLine + 1;
  }
  for (const opener of ['{', '[']) {
    const index = trimmed.indexOf(opener);
    if (index >= 0) starts.add(index);
  }

  for (const start of [...starts].sort((left, right) => left - right)) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {}
  }
  throw new Error('gateway CLI returned no parseable JSON payload');
}

export function assertGatewayRpcSuccess(method, response) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (response.ok === false) {
      throw new GatewayRpcError(method, response.error || response);
    }
    if (response.error && response.ok !== true) {
      throw new GatewayRpcError(method, response.error);
    }
  }
  return response;
}

/**
 * Invoke `openclaw gateway call` and reject RPC error envelopes even when the
 * CLI process exits zero (the current OpenClaw CLI contract).
 */
export function callGatewayRpc(method, params = {}, opts = {}) {
  const timeout = opts.timeout || 15000;
  const args = ['gateway', 'call', method, '--json'];
  args.push('--params', JSON.stringify(params));
  args.push('--timeout', String(timeout));
  if (opts.expectFinal) args.push('--expect-final');

  const childEnv = opts.gatewayToken
    ? { ...(opts.env || process.env), OPENCLAW_GATEWAY_TOKEN: opts.gatewayToken }
    : (opts.env || process.env);
  const execute = opts.execFileSync || execFileSync;

  try {
    const stdout = execute(opts.openclawCommand || 'openclaw', args, {
      encoding: 'utf8',
      timeout: timeout + 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    return assertGatewayRpcSuccess(method, parseGatewayCliJson(stdout));
  } catch (error) {
    if (error instanceof GatewayRpcError) throw error;

    const stdout = error?.stdout ? String(error.stdout) : '';
    const stderr = error?.stderr ? String(error.stderr) : '';
    for (const candidate of [stdout, stderr]) {
      if (!candidate.trim()) continue;
      try {
        return assertGatewayRpcSuccess(method, parseGatewayCliJson(candidate));
      } catch (parsedError) {
        if (parsedError instanceof GatewayRpcError) throw parsedError;
      }
    }

    throw new Error(
      `gateway call ${method} failed: ${stderr.trim() || stdout.trim() || error?.message || 'unknown error'}`,
      { cause: error },
    );
  }
}
