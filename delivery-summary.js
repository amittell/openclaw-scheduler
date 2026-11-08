// delivery-summary.js -- LLM summarization of long delivery bodies.
// v32: ON by default for non-handoff-v4 jobs (an unset delivery_summary means
// summarize); an explicit delivery_summary: 'none' is the opt-out.
//
// When a job summarizes, the announce delivery path asks the Gateway's
// OpenAI-compatible chat-completions endpoint to produce a short
// human-readable summary of the run output before it is posted to the channel.
// This keeps chat notifications concise while the full raw output stays
// available in the run record.
//
// Fail-open contract: if the LLM call fails, times out, or returns empty
// content, the original delivery body is used unchanged. A delivery is never
// dropped because summarization failed.
import { readFileSync } from 'node:fs';
import { splitModelOverride } from './agent-selection.js';
import { resolveGatewayTokenPath } from './gateway.js';

/**
 * Resolve the Gateway token the same way the rest of the scheduler does
 * (env override first, then the canonical credential path). Returns null when
 * no token is available; the summary call then relies on the gateway's
 * local-trust auth and fails open if rejected.
 *
 * The token path is resolved through resolveGatewayTokenPath() from gateway.js
 * so OPENCLAW_GATEWAY_TOKEN_PATH is honored AND the file is constrained to the
 * credential-root allowlist with a no-symlink check on the canonical root.
 * Without this, a symlink could point the Authorization header at an
 * arbitrary file's contents.
 */
function resolveGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const tokenPath = resolveGatewayTokenPath();
    if (!tokenPath) return null;
    return readFileSync(tokenPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

// The Gateway chat-completions endpoint only accepts routing model ids in the
// request body. Concrete provider/model refs belong in the x-openclaw-model
// header. splitModelOverride routes a requested model into those two channels.
// For summaries we always use the agent's default routing model (no concrete
// provider ref), so the body model is the routing id and there is no header.
function routingBodyModel(agentId) {
  const route = splitModelOverride(undefined, agentId);
  return route.bodyModel;
}

// The Gateway is always loopback for this scheduler. Refuse to send the
// summarization request to any non-loopback host (SSRF guard): if the resolved
// gateway URL points elsewhere, the caller fails open (returns null) and
// delivers the raw content instead.
//
// The URL handed to fetch is constructed ONLY from validated primitives -- a
// literal protocol string, an allowlisted hostname constant, and a numeric
// port -- never from the raw configured string. This breaks the taint path an
// external (attacker-controlled) host would otherwise flow down into fetch.
/**
 * Build the gateway chat-completions endpoint from validated loopback parts.
 * Returns null when the configured URL is malformed, uses a non-http(s)
 * protocol, embeds credentials, or targets a non-loopback host.
 *
 * Every character of the returned endpoint derives from either a literal
 * constant (the protocol and the allowlisted loopback host) or a validated
 * numeric port -- never from the raw configured string. Mapping the parsed
 * values onto literals breaks the taint path that an attacker-controlled
 * OPENCLAW_GATEWAY_URL would otherwise flow down into fetch.
 *
 * @param {string} gatewayUrl - The configured gateway base URL.
 * @returns {string|null} The endpoint, or null to fail open.
 */
function buildLoopbackEndpoint(gatewayUrl) {
  let url;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return null;
  }
  // Protocol must be http(s); map onto a literal so no taint flows through.
  let proto;
  if (url.protocol === 'http:') proto = 'http:';
  else if (url.protocol === 'https:') proto = 'https:';
  else return null;
  // Credentials (user:pass@) are never acceptable on a loopback gateway URL.
  if (url.username !== '' || url.password !== '') return null;
  // Host must be a loopback constant; map onto a literal (bracketed IPv6) so
  // the fetch target's host is a constant independent of the configured
  // string. The WHATWG parser reports the IPv6 host as '[::1]'; accept the
  // bare '::1' form too so the allowlist is parser-agnostic.
  let host;
  if (url.hostname === '127.0.0.1') host = '127.0.0.1';
  else if (url.hostname === 'localhost') host = 'localhost';
  else if (url.hostname === '::1' || url.hostname === '[::1]') host = '[::1]';
  else return null;
  // Port is a validated integer (or empty for the protocol default).
  const port = url.port ? Number(url.port) : '';
  if (port !== '' && !Number.isInteger(port)) return null;
  return proto + '//' + host + (port !== '' ? ':' + port : '') + '/v1/chat/completions';
}

// Bound the summary call so a slow model cannot stall the delivery path.
const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;
// Only summarize bodies meaningfully longer than a short message.
const DEFAULT_SUMMARY_THRESHOLD_CHARS = 400;
// Cap how much of the raw body we hand to the model to keep the prompt small.
const MAX_INPUT_CHARS = 12_000;

/**
 * Build the summarization prompt. The model is asked for 2-4 plain-English
 * sentences: what happened, what was verified, anything the user must act on.
 * No file paths, commit SHAs, or jargon dump.
 */
export function buildSummaryPrompt(rawContent, { jobName, status } = {}) {
  const label = jobName ? `Job "${jobName}"` : 'A scheduled job';
  const state = status ? ` It finished with status: ${status}.` : '';
  return [
    `Summarize the following output from ${label} for a human reader in a chat notification.`,
    '',
    `Write 2-4 plain-English sentences covering: what happened, what was verified or produced, and anything the user must act on.${state}`,
    'Rules: no file paths, no commit hashes, no raw log dumps, no jargon. If the output is a failure, lead with what went wrong and the likely cause. If nothing needs the user\'s attention, say the run completed normally. Reply with only the summary text.',
    '',
    '--- Output ---',
    rawContent,
  ].join('\n');
}

/**
 * Call the Gateway chat-completions endpoint to summarize raw delivery
 * content. Returns a cleaned summary string, or null on any failure so the
 * caller can fall back to the raw content (fail-open).
 *
 * The raw content is truncated to MAX_INPUT_CHARS (12,000) characters before
 * it is sent, so the prompt stays bounded regardless of output size. The
 * gateway URL must resolve to a loopback host (127.0.0.1 / localhost / ::1);
 * any other target fails open (returns null) as an SSRF guard.
 *
 * @param {object} opts
 * @param {string} opts.rawContent - The full delivery body to summarize.
 * @param {string} [opts.jobName] - Job name for prompt context.
 * @param {string} [opts.status] - Run status for prompt context.
 * @param {string} [opts.agentId='main'] - Gateway agent id for routing.
 * @param {number} [opts.timeoutMs=30000] - Hard bound on the call.
 * @param {string} [opts.gatewayUrl] - Override the gateway base URL (tests).
 * @param {string} [opts.token] - Override the gateway token (tests).
 * @param {typeof fetch} [opts.fetchImpl] - Override fetch (tests).
 * @returns {Promise<string|null>} Summary text, or null on failure.
 */
export async function summarizeDeliveryContent(opts = {}) {
  const rawContent = String(opts.rawContent ?? '');
  if (!rawContent.trim()) return null;

  const agentId = opts.agentId || 'main';
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_SUMMARY_TIMEOUT_MS;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const gatewayUrl = opts.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
  // SSRF guard: only ever talk to a loopback gateway. The endpoint is built
  // from validated loopback primitives (see buildLoopbackEndpoint); a
  // non-loopback or malformed URL fails open (null) so the raw content is
  // delivered.
  const endpoint = buildLoopbackEndpoint(gatewayUrl);
  if (!endpoint) return null;

  // Truncate the input so the prompt stays bounded regardless of output size.
  const input = rawContent.length > MAX_INPUT_CHARS
    ? `${rawContent.slice(0, MAX_INPUT_CHARS)}\n[... truncated ${rawContent.length - MAX_INPUT_CHARS} chars ...]`
    : rawContent;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'Content-Type': 'application/json' };
  const token = opts.token != null ? opts.token : resolveGatewayToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  headers['x-openclaw-agent-id'] = agentId;

  try {
    const resp = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({
        model: routingBodyModel(agentId),
        messages: [
          { role: 'system', content: 'You summarize scheduled-job output into short, plain-English chat notifications. You reply with only the summary text and nothing else.' },
          { role: 'user', content: buildSummaryPrompt(input, { jobName: opts.jobName, status: opts.status }) },
        ],
        stream: false,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Summary chat completion failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    if (data && data.error) {
      const emsg = typeof data.error === 'string' ? data.error : data.error.message || 'gateway error';
      throw new Error(`Summary chat completion error: ${String(emsg).slice(0, 300)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    return cleanSummary(content);
  } catch (_err) {
    // Fail-open: any transport, timeout, parse, or model error yields null so
    // the caller delivers the original content.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize model output into a clean summary body. Strips wrapper prose,
 * leading/trailing whitespace, and quotes. Returns null when the result is
 * empty or not usable, so the caller falls back to the raw content.
 */
export function cleanSummary(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (!text) return null;
  // Drop a leading "Here is ...:" / "Summary:" style wrapper, but only when it
  // is followed by lowercase prose or a comma. A capitalized word or a digit
  // (e.g. "Summary: Q3 revenue up") is real content, not a wrapper, so it is
  // preserved verbatim.
  const wrapper = text.match(/^(?:here is|here are|the summary|summary)[:\s]+/i);
  if (wrapper) {
    const rest = text.slice(wrapper[0].length).trim();
    // Strip only lowercase prose, a comma, or nothing at all (the wrapper
    // itself, which becomes an empty -> null result).
    if (rest === '' || /^[a-z,]/.test(rest)) text = rest;
  }
  // Strip surrounding quotes the model sometimes adds.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return null;
  // Reject outputs that are clearly not a plain summary (e.g. the model
  // echoed the raw content back verbatim or returned a code fence).
  if (text.length > 2000) return null;
  if (/^```/m.test(text)) return null;
  return text;
}

/**
 * Decide whether a delivery body should be summarized.
 *
 * v32: the default is 'llm' — a job record without a delivery_summary value
 * (undefined) summarizes long bodies; only an explicit 'none' opts out. This
 * mirrors the write-time default in jobs.js, where createJob stores 'llm' for
 * non-v4 jobs that never set the field (v4 jobs always store 'none').
 *
 * @param {object} job - The job record (reads delivery_summary, delivery_mode).
 * @param {string} content - The delivery body.
 * @param {object} [opts]
 * @param {number} [opts.thresholdChars=400] - Summarize only when longer.
 * @returns {boolean}
 */
export function shouldSummarizeDelivery(job, content, opts = {}) {
  if (!job) return false;
  if ((job.delivery_summary ?? 'llm') !== 'llm') return false;
  if (!['announce', 'announce-always'].includes(job.delivery_mode)) return false;
  const threshold = Number.isFinite(opts.thresholdChars) ? opts.thresholdChars : DEFAULT_SUMMARY_THRESHOLD_CHARS;
  const text = String(content ?? '');
  return text.length > threshold;
}

export { DEFAULT_SUMMARY_TIMEOUT_MS, DEFAULT_SUMMARY_THRESHOLD_CHARS, MAX_INPUT_CHARS };
