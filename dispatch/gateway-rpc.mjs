import { execFileSync } from 'node:child_process';

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
