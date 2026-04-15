const GENERIC_COMPLETION_TEXT_RE = /^(?:completed(?:\s*\([^\n)]*\))?|done|ok|okay|success|successful|complete|all set|none|n\/?a)$/i;
const TRIVIAL_CHATTER_RE = /^(?:hi|hello|hey|yo|sup|thanks|thank you|cool|nice|sure|yep|yeah|k|kk|roger|copy that)[.!?]*$/i;
const INTERNAL_TRANSPORT_PREFIX_RE = /^auto-resolved(?:\s+as\s+[a-z-]+)?\s*:/i;
const INTERNAL_TRANSPORT_PATTERNS = [
  /^session not found in gateway store[.!?]*$/i,
  /^session not found in sessions store[.!?]*$/i,
  /^session never found(?:\s+--\s+spawn likely failed)?[.!?]*$/i,
  /^session went idle without calling done(?:\.\s*work may be incomplete\.)?(?:\s*\([^)]*\))?[.!?]*$/i,
];

export function normalizeCompletionText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isInternalTransportNoiseText(value) {
  const text = normalizeCompletionText(value);
  if (!text) return false;

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (INTERNAL_TRANSPORT_PREFIX_RE.test(normalized)) return true;

  return INTERNAL_TRANSPORT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isMeaningfulCompletionText(value) {
  const text = normalizeCompletionText(value);
  if (!text) return false;

  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (GENERIC_COMPLETION_TEXT_RE.test(normalized)) return false;
  if (TRIVIAL_CHATTER_RE.test(normalized)) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) return false;

  return true;
}

function buildInternalNoiseFallback(noisyTexts) {
  const joined = noisyTexts.join(' ').toLowerCase();
  if (joined.includes('session went idle without calling done')) {
    return 'The session ended without a final completion signal, so no reliable final report is available.';
  }
  if (joined.includes('session not found') || joined.includes('session never found')) {
    return 'The session ended before a final report could be retrieved, so there is no user-facing completion message to deliver.';
  }
  return 'The session completed with internal transport status only and no user-facing completion report.';
}

function shortSha(sha) {
  const text = normalizeCompletionText(sha);
  if (!text) return null;
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7) : text;
}

function cloneChecklist(checklist) {
  if (!checklist || typeof checklist !== 'object' || Array.isArray(checklist)) return null;
  try {
    return JSON.parse(JSON.stringify(checklist));
  } catch {
    return { ...checklist };
  }
}

export function synthesizeCompletionReply({ checklist, sha } = {}) {
  const normalizedChecklist = cloneChecklist(checklist);
  const short = shortSha(sha);
  const sentences = [];

  if (normalizedChecklist?.tests_passed === true) {
    sentences.push('Tests passed.');
  }

  if (normalizedChecklist?.pushed === true && short) {
    sentences.push(`Pushed ${short}.`);
  } else if (normalizedChecklist?.pushed === true) {
    sentences.push('Changes pushed.');
  } else if (short) {
    sentences.push(`Commit ${short}.`);
  }

  const extraTrueFlags = normalizedChecklist
    ? Object.entries(normalizedChecklist)
      .filter(([key, value]) => value === true && !['work_complete', 'tests_passed', 'pushed'].includes(key))
      .map(([key]) => key.replace(/_/g, ' '))
    : [];

  if (extraTrueFlags.length > 0) {
    sentences.push(`Checks: ${extraTrueFlags.slice(0, 3).join(', ')}.`);
  }

  if (sentences.length === 0) return null;
  return `Work complete. ${sentences.join(' ')}`.trim();
}

export function buildTerminalCompletionPayload({ summary, checklist, sha } = {}) {
  const rawSummary = normalizeCompletionText(summary);
  const normalizedChecklist = cloneChecklist(checklist);
  const normalizedSha = normalizeCompletionText(sha);
  const prose = isMeaningfulCompletionText(rawSummary) ? rawSummary : null;
  const synthesizedReply = prose
    ? null
    : synthesizeCompletionReply({ checklist: normalizedChecklist, sha: normalizedSha });
  const effectiveSummary = prose || synthesizedReply || rawSummary || null;
  const deliveryText = prose || synthesizedReply || null;

  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    summary: effectiveSummary,
    deliveryText,
    prose,
    checklist: normalizedChecklist,
    sha: normalizedSha,
    debug: {
      rawSummary,
      synthesizedReply,
      deliverySource: prose ? 'summary' : synthesizedReply ? 'synthesized' : 'none',
    },
  };
}

export function resolveCompletionDelivery({ lastReply, completion, fallbackSummary } = {}) {
  const reply = normalizeCompletionText(lastReply);
  const completionSummary = normalizeCompletionText(completion?.summary);
  const completionDelivery = normalizeCompletionText(completion?.deliveryText);
  const fallback = normalizeCompletionText(fallbackSummary);
  const preferredSummary = completionSummary || fallback;
  const noisyTexts = [reply, completionDelivery, completionSummary, fallback].filter(isInternalTransportNoiseText);
  const isDeliverableText = (text) => isMeaningfulCompletionText(text) && !isInternalTransportNoiseText(text);
  const meaningfulSummary = [completionSummary, fallback].find(isDeliverableText) || null;

  if (isDeliverableText(reply)) {
    return {
      deliveryText: reply,
      summary: preferredSummary || reply.slice(0, 500),
      source: 'lastReply',
    };
  }

  if (isDeliverableText(completionDelivery)) {
    return {
      deliveryText: completionDelivery,
      summary: completionSummary || completionDelivery,
      source: completion?.debug?.deliverySource || 'completion',
    };
  }

  if (meaningfulSummary) {
    return {
      deliveryText: meaningfulSummary,
      summary: meaningfulSummary,
      source: completionSummary && meaningfulSummary === completionSummary ? 'completion-summary' : 'summary',
    };
  }

  if (noisyTexts.length > 0) {
    const fallbackDelivery = buildInternalNoiseFallback(noisyTexts);
    return {
      deliveryText: fallbackDelivery,
      summary: fallbackDelivery,
      source: 'internal-noise',
    };
  }

  return {
    deliveryText: null,
    summary: preferredSummary || null,
    source: 'none',
  };
}
