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

function getCompletionSummaryHuman(completion) {
  return normalizeCompletionText(completion?.summary_human ?? completion?.summaryHuman);
}

function getCompletionTechnicalDetails(completion) {
  const details = completion?.details_technical ?? completion?.technicalDetails ?? null;
  if (!details) return null;
  if (typeof details === 'string') return normalizeCompletionText(details);
  if (typeof details !== 'object' || Array.isArray(details)) return null;
  return Object.keys(details).length > 0 ? details : null;
}

export function hasCompletionSignal(completion) {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
  if (getCompletionSummaryHuman(completion)) return true;
  if (normalizeCompletionText(completion?.summary)) return true;
  if (normalizeCompletionText(completion?.deliveryText)) return true;
  if (normalizeCompletionText(completion?.sha)) return true;
  if (getCompletionTechnicalDetails(completion)) return true;
  return !!cloneChecklist(completion?.checklist);
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

function buildTechnicalDetails({ checklist, sha, rawSummary, summaryHuman } = {}) {
  const details = {};
  const normalizedChecklist = cloneChecklist(checklist);
  const normalizedSha = normalizeCompletionText(sha);
  const normalizedRawSummary = normalizeCompletionText(rawSummary);
  const normalizedSummaryHuman = normalizeCompletionText(summaryHuman);

  if (normalizedChecklist) details.checklist = normalizedChecklist;
  if (normalizedSha) {
    details.sha = normalizedSha;
    details.sha_short = shortSha(normalizedSha);
  }
  if (normalizedRawSummary && normalizedRawSummary !== normalizedSummaryHuman) {
    details.raw_summary = normalizedRawSummary;
  }

  return Object.keys(details).length > 0 ? details : null;
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
  const summaryHuman = prose || synthesizedReply || null;
  const effectiveSummary = summaryHuman || rawSummary || null;
  const deliveryText = summaryHuman || null;
  const detailsTechnical = buildTechnicalDetails({
    checklist: normalizedChecklist,
    sha: normalizedSha,
    rawSummary,
    summaryHuman,
  });

  return {
    version: 2,
    recordedAt: new Date().toISOString(),
    summary_human: summaryHuman,
    summary: effectiveSummary,
    details_technical: detailsTechnical,
    deliveryText,
    prose,
    checklist: normalizedChecklist,
    sha: normalizedSha,
    debug: {
      rawSummary,
      synthesizedReply,
      deliverySource: prose ? 'summary_human' : synthesizedReply ? 'technical-synthesis' : 'none',
    },
  };
}

export function resolveCompletionDelivery({ lastReply, completion, fallbackSummary } = {}) {
  const reply = normalizeCompletionText(lastReply);
  const completionSummaryHuman = getCompletionSummaryHuman(completion);
  const completionSummary = normalizeCompletionText(completion?.summary);
  const completionDelivery = normalizeCompletionText(completion?.deliveryText);
  const fallback = normalizeCompletionText(fallbackSummary);
  const synthesizedFromTechnical = synthesizeCompletionReply({
    checklist: completion?.checklist,
    sha: completion?.sha,
  });
  const preferredSummary = completionSummaryHuman || completionSummary || fallback;
  const noisyTexts = [
    reply,
    completionSummaryHuman,
    completionDelivery,
    completionSummary,
    fallback,
  ].filter(isInternalTransportNoiseText);
  const isDeliverableText = (text) => isMeaningfulCompletionText(text) && !isInternalTransportNoiseText(text);
  const structuredCandidates = [
    {
      text: completionSummaryHuman,
      summary: completionSummaryHuman,
      source: 'summary_human',
    },
    {
      text: completionSummary,
      summary: completionSummary,
      source: 'completion-summary',
    },
    {
      text: completionDelivery,
      summary: completionSummaryHuman || completionSummary || completionDelivery,
      source: completion?.debug?.deliverySource || 'completion-legacy',
    },
    {
      text: synthesizedFromTechnical,
      summary: synthesizedFromTechnical,
      source: 'technical-synthesis',
    },
  ];

  for (const candidate of structuredCandidates) {
    if (!isDeliverableText(candidate.text)) continue;
    return {
      deliveryText: candidate.text,
      summary: candidate.summary || candidate.text,
      source: candidate.source,
    };
  }

  if (isDeliverableText(reply)) {
    return {
      deliveryText: reply,
      summary: preferredSummary || reply.slice(0, 500),
      source: 'lastReply',
    };
  }

  if (isDeliverableText(fallback)) {
    return {
      deliveryText: fallback,
      summary: fallback,
      source: 'summary',
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
    summary: preferredSummary || completionDelivery || reply || synthesizedFromTechnical || null,
    source: 'none',
  };
}
