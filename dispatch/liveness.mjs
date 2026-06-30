const MINUTE_MS = 60 * 1000;
const HIGH_THINKING_SUBAGENT_GATEWAY_TIMEOUT_FLOOR_SECONDS = 60 * 60;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeThinkingLevel(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'xhigh' || text === 'extra-high' || text === 'extra_high') return 'xhigh';
  if (text === 'high') return 'high';
  if (text === 'low') return 'low';
  if (text === 'off' || text === 'none') return 'off';
  return null;
}

export function getDispatchTimeoutSeconds(entry = {}, fallbackSeconds = 300) {
  return numberOrNull(entry.timeoutSeconds)
    ?? numberOrNull(entry.timeout)
    ?? numberOrNull(fallbackSeconds)
    ?? 300;
}

export function getDispatchGatewayTimeoutSeconds(entry = {}, opts = {}) {
  const baseSeconds = getDispatchTimeoutSeconds(entry, opts.defaultTimeoutSeconds);
  const thinking = normalizeThinkingLevel(entry.thinking ?? opts.thinking);
  const lane =
    typeof entry.lane === 'string'
      ? entry.lane.trim().toLowerCase()
      : typeof opts.lane === 'string'
        ? opts.lane.trim().toLowerCase()
        : '';
  const isHighThinking = thinking === 'high' || thinking === 'xhigh';
  if (lane !== 'subagent' || !isHighThinking) {
    return baseSeconds;
  }
  const floorSeconds =
    numberOrNull(opts.highThinkingSubagentFloorSeconds)
    ?? HIGH_THINKING_SUBAGENT_GATEWAY_TIMEOUT_FLOOR_SECONDS;
  return Math.max(baseSeconds, floorSeconds);
}

export function buildAutoResolvedIncompleteSummary(params = {}) {
  const sessionStatus =
    typeof params.sessionStatus === 'string' ? params.sessionStatus.trim().toLowerCase() : '';
  const reason = typeof params.reason === 'string' && params.reason.trim()
    ? params.reason.trim()
    : 'session stopped without calling done';
  if (sessionStatus === 'timeout') {
    return `Auto-resolved after gateway session timeout without done signal. Work may be incomplete. (${reason})`;
  }
  if (sessionStatus === 'failed') {
    return `Auto-resolved after gateway session failure without done signal. Work may be incomplete. (${reason})`;
  }
  if (sessionStatus === 'killed') {
    return `Auto-resolved after gateway session abort without done signal. Work may be incomplete. (${reason})`;
  }
  return `Auto-resolved: session went idle without calling done. Work may be incomplete. (${reason})`;
}

export function getDispatchLivenessPolicy(entry = {}, opts = {}) {
  const now = numberOrNull(opts.now) ?? Date.now();
  const timeoutSeconds = getDispatchTimeoutSeconds(entry, opts.defaultTimeoutSeconds);
  const timeoutMs = timeoutSeconds * 1000;
  const thinking = normalizeThinkingLevel(entry.thinking);
  const isHighThinking = thinking === 'high' || thinking === 'xhigh';

  const startupGraceMs = numberOrNull(opts.startupGraceMs)
    ?? (isHighThinking ? 10 * MINUTE_MS : 5 * MINUTE_MS);
  const pingStaleMs = numberOrNull(opts.pingStaleMs) ?? 3 * MINUTE_MS;
  const idleProbeFloorMs = isHighThinking ? 10 * MINUTE_MS : 1 * MINUTE_MS;
  const idleProbeMs = Math.max(
    idleProbeFloorMs,
    Math.min(timeoutMs * 0.25, isHighThinking ? 15 * MINUTE_MS : 5 * MINUTE_MS),
  );
  const idleFailureFloorMs = isHighThinking ? 20 * MINUTE_MS : 10 * MINUTE_MS;
  const idleFailureMs = Math.max(timeoutMs, idleFailureFloorMs);
  const hardCeilingMs = Math.max(timeoutMs * 1.5, idleFailureMs * (isHighThinking ? 2 : 1.5));
  const hardTimeoutIdleMs = isHighThinking ? 5 * MINUTE_MS : 2 * MINUTE_MS;
  const spawnedAtMs = entry.spawnedAt ? new Date(entry.spawnedAt).getTime() : 0;
  const ageMs = spawnedAtMs ? now - spawnedAtMs : Infinity;

  return {
    thinking,
    isHighThinking,
    timeoutSeconds,
    timeoutMs,
    startupGraceMs,
    pingStaleMs,
    idleProbeMs,
    idleFailureMs,
    hardCeilingMs,
    hardTimeoutIdleMs,
    spawnedAtMs,
    ageMs,
    pastHardCeiling: ageMs >= hardCeilingMs,
  };
}
