const TRANSIENT_ERROR_PATTERNS = [
  /\btemporarily overloaded\b/i,
  /\bservice\s+(?:is\s+)?unavailable\b/i,
  /\brate\s*limit(?:ed|s?)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\b5[0-9]{2}\b\s+(?:internal\s+)?server\s+error\b/i,
  /\bgateway\s+timeout\b/i,
  /\bbad\s+gateway\b/i,
  /\bmodel\s+(?:is\s+)?(?:overloaded|unavailable)\b/i,
  /\bAPI\s+(?:error|unavailable|timeout)\b/i,
  /\bcapacity\s+(?:exceeded|limit)\b/i,
  /\bretry\s+(?:after|later|in\s+\d)\b/i,
  /\bcontext\s+(?:length|window)\s+exceeded\b/i,
  /\btoken\s+limit\s+exceeded\b/i,
  /gateway\s+is\s+draining/i,
  /new\s+tasks\s+are\s+not\s+accepted/i,
  /gateway.*draining.*restart/i,
];

const DRAIN_PATTERNS = [
  /gateway\s+is\s+draining/i,
  /new\s+tasks\s+are\s+not\s+accepted/i,
];

export function isDrainError(errorMessage) {
  const trimmed = String(errorMessage ?? '').trim();
  if (!trimmed) return false;
  return DRAIN_PATTERNS.some(p => p.test(trimmed));
}

export function sqliteNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export function adaptiveDeferralMs(backlogDepth, baseMs = 10000) {
  const safeDepth = Number.isFinite(backlogDepth) ? backlogDepth : 0;
  const multiplier = Math.max(1, Math.min(12, safeDepth + 1));
  return Math.min(300000, baseMs * multiplier);
}

export function buildExecutionIntentNote(job) {
  if (job.execution_intent !== 'plan' && !job.execution_read_only) return '';
  const lines = [
    '[SYSTEM NOTE — execution boundary]',
    job.execution_intent === 'plan'
      ? 'This run is planning-only. Analyze, reason, and propose actions, but do not execute external side effects.'
      : 'This run is read-only. Inspect and summarize state, but do not execute external side effects.',
  ];
  if (job.execution_read_only) {
    lines.push('Treat every write, send, post, mutation, or shelling out for side effects as forbidden.');
  }
  lines.push('If a concrete change is needed, describe it as a recommendation instead of performing it.');
  lines.push('[END SYSTEM NOTE]');
  return lines.join('\n');
}

/**
 * Check if content matches a sentinel token at the start of the string.
 * Matches "TOKEN" exactly, or "TOKEN" followed by whitespace/colon.
 */
export function matchesSentinel(content, token) {
  if (!content) return false;
  const re = new RegExp(`^${token}(?:$|[\\s:])`);
  return re.test(content.trim());
}

export function detectTransientError(content) {
  if (!content || !content.trim()) return false;
  const trimmed = content.trim();
  const testStr = trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(testStr));
}

export function getBackoffMs(n) {
  const backoff = [30_000, 60_000, 300_000, 900_000, 3_600_000];
  return backoff[Math.min(Math.max(n, 1) - 1, backoff.length - 1)];
}
