const MINUTE_MS = 60 * 1000;

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
