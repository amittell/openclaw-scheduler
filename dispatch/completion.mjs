const MAX_DELIVERY_SENTENCES = 5;
const MAX_DELIVERY_CHARS = 700;
const MAX_LIST_ITEMS = 3;

const GENERIC_COMPLETION_TEXT_RE = /^(?:completed(?:\s*\([^\n)]*\))?|done|ok|okay|success|successful|complete|all set|none|n\/?a)[.!?]*$/i;
const TRIVIAL_CHATTER_RE = /^(?:hi|hello|hey|yo|sup|thanks|thank you|cool|nice|sure|yep|yeah|k|kk|roger|copy that)[.!?]*$/i;
const INTERNAL_DONE_PAYLOAD_RE = /"message"\s*:\s*"Label marked done via agent signal\."|"status"\s*:\s*"done"/i;
const INTERNAL_DONE_MESSAGE_RE = /^label marked done via agent signal\.[!?]*$/i;
const INTERNAL_TRANSPORT_PREFIX_RE = /^auto-resolved(?:\s+as\s+[a-z-]+)?\s*:/i;
const INTERNAL_TRANSPORT_PATTERNS = [
  /^session not found in gateway store[.!?]*$/i,
  /^session not found in sessions store[.!?]*$/i,
  /^session never found(?:\s+--\s+spawn likely failed)?[.!?]*$/i,
  /^the delivery watcher stopped before the task reached a terminal state[.!?]*$/i,
  /^session went idle without calling done(?:\.\s*work may be incomplete\.)?(?:\s*\([^)]*\))?[.!?]*$/i,
];
const RAW_PAYLOAD_MARKERS_RE = /"(?:ok|status|label|sessionKey|idempotencyKey|deliveryText|summary|message|checklist|stdout|stderr|tool|args|result|content)"\s*:/i;
const STACK_TRACE_LINE_RE = /^\s*at\s+\S+/;

export function normalizeCompletionText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, '');
}

export function isInternalTransportNoiseText(value) {
  const text = normalizeCompletionText(value);
  if (!text) return false;

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (INTERNAL_TRANSPORT_PREFIX_RE.test(normalized)) return true;
  if (INTERNAL_DONE_PAYLOAD_RE.test(normalized)) return true;
  if (INTERNAL_DONE_MESSAGE_RE.test(normalized)) return true;

  return INTERNAL_TRANSPORT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function cleanMarkdown(text) {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '');
}

function isGenericOrTrivial(text) {
  const normalized = normalizeCompletionText(text)?.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  if (GENERIC_COMPLETION_TEXT_RE.test(normalized)) return true;
  if (TRIVIAL_CHATTER_RE.test(normalized)) return true;
  return false;
}

function parseJsonCandidate(value) {
  const trimmed = normalizeCompletionText(value);
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractEmbeddedCompletionObject(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const candidates = [normalized];
  const newlineJsonIdx = normalized.lastIndexOf('\n{');
  if (newlineJsonIdx >= 0) candidates.push(normalized.slice(newlineJsonIdx + 1));
  const firstBraceIdx = normalized.indexOf('{');
  if (firstBraceIdx > 0) candidates.push(normalized.slice(firstBraceIdx));

  const seen = new Set();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const parsed = parseJsonCandidate(trimmed);
    if (parsed !== null) return parsed;
  }
  return null;
}

function gatherObjectTextCandidates(value, depth = 0, out = [], seen = new Set()) {
  if (depth > 4 || value == null) return out;

  if (typeof value === 'string') {
    const text = normalizeCompletionText(value);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 6)) {
      gatherObjectTextCandidates(item, depth + 1, out, seen);
    }
    return out;
  }

  if (typeof value !== 'object') return out;

  const preferredKeys = ['deliveryText', 'summary', 'body', 'text', 'content', 'message', 'stdout', 'stderr'];
  const nestedKeys = ['completion', 'result', 'response', 'data', 'payload'];

  for (const key of preferredKeys) {
    if (Object.hasOwn(value, key)) {
      gatherObjectTextCandidates(value[key], depth + 1, out, seen);
    }
  }

  for (const key of nestedKeys) {
    if (Object.hasOwn(value, key)) {
      gatherObjectTextCandidates(value[key], depth + 1, out, seen);
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (preferredKeys.includes(key) || nestedKeys.includes(key)) continue;
    gatherObjectTextCandidates(nestedValue, depth + 1, out, seen);
  }

  return out;
}

function prepareLines(text) {
  return cleanMarkdown(text)
    .split('\n')
    .map(line => line.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => !/^```/.test(line))
    .filter(line => !/^[`~=_-]{3,}$/.test(line))
    .filter(line => ![...line].every(char => '{}[],'.includes(char)))
    .filter(line => !STACK_TRACE_LINE_RE.test(line));
}

function truncateText(text, maxChars = MAX_DELIVERY_CHARS) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function splitSentences(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return [];
  return normalized.match(/[^.!?]+(?:[.!?]+|$)/g)?.map(part => part.trim()).filter(Boolean) || [];
}

function asSentence(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function shortenFragment(text, maxChars = 110) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;
  const cleaned = cleanMarkdown(normalized)
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return truncateText(cleaned, maxChars);
}

function looksLikeRawPayloadText(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return false;
  if (INTERNAL_DONE_PAYLOAD_RE.test(normalized)) return true;
  if (isInternalTransportNoiseText(normalized)) return true;
  return (/^[[{]/.test(normalized) && RAW_PAYLOAD_MARKERS_RE.test(normalized));
}

function looksLikeGunbrokerReport(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return false;
  return /deal scanner/i.test(normalized) || (/^Baseline:/mi.test(normalized) && /^#\d+/m.test(normalized));
}

function parseGunbrokerItem(line) {
  const normalized = normalizeCompletionText(line);
  if (!normalized) return null;
  const match = normalized.match(/^#(\d+)(?:\s+\S+)?\s*\|\s*([+-]\d+%)\s*[—-]\s*\$?([\d,]+)\s*\(([^)]*)\)/);
  if (!match) return shortenFragment(normalized, 100);
  const [, rank, edge, price, context] = match;
  return `#${rank} ${edge} at $${price} (${context.trim()})`;
}

function summarizeGunbrokerReport(text) {
  const lines = prepareLines(text);
  if (!lines.length) return null;

  const titleLine = lines.find(line => /deal scanner/i.test(line)) || null;
  const baselineLine = lines.find(line => /^Baseline:/i.test(line)) || null;
  const noDealsLine = lines.find(line => /no deals/i.test(line)) || null;
  const items = lines
    .filter(line => /^#\d+/.test(line))
    .map(parseGunbrokerItem)
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

  const parts = [];
  if (titleLine) parts.push(asSentence(titleLine.replace(/^[^\p{L}\p{N}#]+/gu, '')));
  if (baselineLine) parts.push(asSentence(baselineLine));
  if (noDealsLine && items.length === 0) parts.push(asSentence(noDealsLine));
  if (items.length) parts.push(`Top deals: ${items.join('; ')}.`);

  return truncateText(parts.filter(Boolean).join(' '), MAX_DELIVERY_CHARS);
}

function isItemLine(line) {
  return /^(?:[-*•]\s+|\d+[.)]\s+|#\d+\b)/.test(line);
}

function summarizeStructuredText(text) {
  if (looksLikeGunbrokerReport(text)) {
    return summarizeGunbrokerReport(text);
  }

  const lines = prepareLines(text);
  if (!lines.length) return null;

  const itemLines = lines.filter(isItemLine);
  const nonItemLines = lines.filter(line => !isItemLine(line));

  if (itemLines.length > 0) {
    const heading = nonItemLines[0] || null;
    const context = nonItemLines.slice(1, 3).join(' ');
    const highlights = itemLines
      .slice(0, MAX_LIST_ITEMS)
      .map(line => shortenFragment(line.replace(/^[-*•]\s+/, ''), 110))
      .filter(Boolean);

    const parts = [];
    if (heading) parts.push(asSentence(heading));
    if (context) parts.push(asSentence(truncateText(context, 180)));
    if (highlights.length) parts.push(`Highlights: ${highlights.join('; ')}.`);
    return truncateText(parts.filter(Boolean).join(' '), MAX_DELIVERY_CHARS);
  }

  const compact = truncateText(lines.slice(0, 4).join(' '), 260);
  return compact ? asSentence(compact) : null;
}

function summarizeProse(text) {
  const normalized = prepareLines(text).join(' ').replace(/\s+/g, ' ').trim();
  if (!normalized || isGenericOrTrivial(normalized)) return null;

  const sentences = splitSentences(normalized);
  if (!sentences.length) return truncateText(normalized, MAX_DELIVERY_CHARS);
  if (normalized.length <= MAX_DELIVERY_CHARS && sentences.length <= MAX_DELIVERY_SENTENCES) {
    return normalized;
  }

  const kept = [];
  let chars = 0;
  for (const sentence of sentences) {
    const next = kept.length ? chars + 1 + sentence.length : chars + sentence.length;
    if (kept.length >= MAX_DELIVERY_SENTENCES || next > MAX_DELIVERY_CHARS) break;
    kept.push(sentence);
    chars = next;
  }

  if (!kept.length) return truncateText(normalized, MAX_DELIVERY_CHARS);
  return kept.join(' ');
}

export function summarizeCompletionText(value, { skipEmbeddedObject = false } = {}) {
  const raw = normalizeCompletionText(value);
  if (!raw) return null;

  if (!skipEmbeddedObject) {
    const parsed = extractEmbeddedCompletionObject(raw);
    if (parsed !== null) {
      const candidates = gatherObjectTextCandidates(parsed);
      for (const candidate of candidates) {
        const summarized = summarizeCompletionText(candidate, { skipEmbeddedObject: true });
        if (summarized) return summarized;
      }
      if (looksLikeRawPayloadText(raw)) return null;
    }
  }

  if (looksLikeRawPayloadText(raw)) return null;
  if (looksLikeGunbrokerReport(raw)) return summarizeGunbrokerReport(raw);

  const prepared = prepareLines(raw);
  const structured = prepared.length >= 4 || prepared.some(line => line.includes('|')) || prepared.filter(isItemLine).length >= 2;
  if (structured) {
    const summary = summarizeStructuredText(raw);
    if (summary && !isGenericOrTrivial(summary)) return summary;
  }

  return summarizeProse(raw);
}

export function isMeaningfulCompletionText(value) {
  return Boolean(summarizeCompletionText(value));
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
      .filter(([key, flagValue]) => flagValue === true && !['work_complete', 'tests_passed', 'pushed'].includes(key))
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
  const normalizedSummary = summarizeCompletionText(rawSummary);
  const synthesizedReply = normalizedSummary
    ? null
    : synthesizeCompletionReply({ checklist: normalizedChecklist, sha: normalizedSha });
  const summaryHuman = normalizedSummary || synthesizedReply || null;
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
    prose: normalizedSummary,
    checklist: normalizedChecklist,
    sha: normalizedSha,
    debug: {
      rawSummary,
      normalizedSummary,
      synthesizedReply,
      deliverySource: normalizedSummary ? 'summary_human' : synthesizedReply ? 'technical-synthesis' : 'none',
    },
  };
}

export function resolveCompletionDelivery({ lastReply, completion, fallbackSummary } = {}) {
  const rawReply = normalizeCompletionText(lastReply);
  const rawCompletionSummaryHuman = getCompletionSummaryHuman(completion);
  const rawCompletionSummary = normalizeCompletionText(completion?.summary);
  const rawCompletionDelivery = normalizeCompletionText(completion?.deliveryText);
  const rawFallback = normalizeCompletionText(fallbackSummary);

  const reply = summarizeCompletionText(lastReply);
  const completionSummaryHuman = summarizeCompletionText(rawCompletionSummaryHuman);
  const completionSummary = summarizeCompletionText(completion?.summary);
  const completionDelivery = summarizeCompletionText(completion?.deliveryText);
  const fallback = summarizeCompletionText(fallbackSummary);
  const synthesizedFromTechnical = synthesizeCompletionReply({
    checklist: completion?.checklist,
    sha: completion?.sha,
  });
  const completionDeliverySource = normalizeCompletionText(completion?.debug?.deliverySource);
  const preferredSummary = completionSummaryHuman || completionSummary || fallback || synthesizedFromTechnical || null;
  const authoritativeStructuredSummary = completionDeliverySource && completionDeliverySource !== 'technical-synthesis'
    ? preferredSummary
    : null;
  const noisyTexts = [
    rawReply,
    rawCompletionSummaryHuman,
    rawCompletionDelivery,
    rawCompletionSummary,
    rawFallback,
  ].filter(isInternalTransportNoiseText);
  const isDeliverableText = (rawText, summarizedText) => Boolean(summarizedText)
    && !isInternalTransportNoiseText(summarizedText)
    && (!rawText || !isInternalTransportNoiseText(rawText) || looksLikeRawPayloadText(rawText));
  const structuredCandidates = [
    {
      rawText: rawCompletionSummaryHuman,
      text: completionSummaryHuman,
      summary: completionSummaryHuman,
      source: completionDeliverySource === 'technical-synthesis' ? 'technical-synthesis' : 'summary_human',
    },
    {
      rawText: rawCompletionSummary,
      text: completionSummary,
      summary: completionSummary,
      source: completionDeliverySource === 'technical-synthesis' && completionSummary === synthesizedFromTechnical
        ? 'technical-synthesis'
        : 'completion-summary',
    },
    {
      rawText: rawCompletionDelivery,
      text: completionDelivery,
      summary: completionSummaryHuman || completionSummary || completionDelivery,
      source: completionDeliverySource || 'completion-legacy',
    },
  ];

  for (const candidate of structuredCandidates.filter(candidate => candidate.source !== 'technical-synthesis')) {
    if (!isDeliverableText(candidate.rawText, candidate.text)) continue;
    return {
      deliveryText: candidate.text,
      summary: candidate.summary || candidate.text,
      source: candidate.source,
    };
  }

  if (isDeliverableText(rawReply, reply)) {
    return {
      deliveryText: reply,
      summary: authoritativeStructuredSummary || reply,
      source: 'lastReply',
    };
  }

  if (isDeliverableText(synthesizedFromTechnical, synthesizedFromTechnical)) {
    return {
      deliveryText: synthesizedFromTechnical,
      summary: synthesizedFromTechnical,
      source: 'technical-synthesis',
    };
  }

  for (const candidate of structuredCandidates.filter(candidate => candidate.source === 'technical-synthesis')) {
    if (!isDeliverableText(candidate.rawText, candidate.text)) continue;
    return {
      deliveryText: candidate.text,
      summary: candidate.summary || candidate.text,
      source: candidate.source,
    };
  }

  if (isDeliverableText(rawFallback, fallback)) {
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
    summary: authoritativeStructuredSummary || preferredSummary || completionDelivery || reply || null,
    source: 'none',
  };
}
