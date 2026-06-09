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
const TECHNICAL_COMMIT_PREFIX_RE = /^(?:fix|feat|feature|chore|refactor|perf|docs|test|tests|build|ci|style|revert|hotfix)(?:\([^)]+\))?!?:\s*/i;
const FILE_CONTEXT_PREFIX_RE = /^(?:(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md|py|sh|sql|ya?ml|toml)):\s*/i;
const CODEISH_MARKER_RE = /(?:`[^`]+`|--[a-z0-9-]+|\b[A-Z_]{3,}\b|\b[a-z0-9_]+\(\)|\b[a-z]+[A-Z][A-Za-z0-9_]+\b|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|\b[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md|py|sh|sql|ya?ml|toml)\b)/;
const HUMAN_CUE_RE = /\b(?:now|so that|so\b|because|this\b|future runs?|expect|easier|readable|reliable|cleaner|people|users?|operators?|chat|helps?|lets?|allows?|prevents?|stops?|keeps?|avoids?)\b/i;
const TECHNICAL_KEYWORDS = [
  'api', 'artifact', 'assert', 'build', 'checklist', 'cli', 'commit', 'completion', 'config', 'context',
  'cron', 'db', 'delivery', 'dispatch', 'gateway', 'guard', 'hook', 'json', 'job', 'label', 'lint',
  'message', 'metadata', 'notify', 'output', 'path', 'payload', 'pipeline', 'post-office', 'queue', 'raw',
  'regex', 'report', 'retry', 'scheduler', 'session', 'sha', 'shell', 'spec', 'sql', 'stderr', 'stdout',
  'structured', 'summary', 'sync', 'test', 'tests', 'tool', 'transcript', 'transport', 'typecheck', 'watcher',
  'webhook', 'workflow'
];
const TECHNICAL_KEYWORD_RE = new RegExp(`\\b(?:${TECHNICAL_KEYWORDS.join('|')})\\b`, 'gi');
const RELIABILITY_SIGNAL_RE = /\b(?:fix|guard|retry|timeout|error|fail|stuck|prevent|avoid|dedupe|deduplicat|preserve|ensure|handle|recover|reliab)\b/i;
const TEST_FRAGMENT_RE = /\b(?:test|tests|spec|coverage|lint|typecheck|tsc|eslint|oxlint|assert(?:ion)?s?)\b/i;
const TEST_APPLICABILITY_RE = /\b(?:test|tests|pytest|jest|vitest|mocha|cypress|playwright|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test|rspec)\b/i;
const TEST_NEGATION_RE = /\b(?:do\s+not|don't|dont|never|skip|without|no)\s+(?:run\s+)?(?:the\s+)?tests?\b/i;
const PUSH_FORBIDDEN_RE = /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not)\s+(?:git\s+push|push)\b|\bno\s+push\b|\bwithout\s+pushing\b/i;
const EXPLICIT_TECHNICAL_MARKER_RE = /\b(?:Technically|Technical details)\s*:\s*/i;
const HUMAN_SUMMARY_SECTION_RE = /(?:^|\n)\s*(?:Human-readable summary|Human summary)\s*:\s*/i;
const TECHNICAL_DETAILS_SECTION_RE = /(?:^|\n)\s*(?:Technical details?|Details(?:_technical)?)\s*:\s*/i;
const HUMAN_SUMMARY_LABEL_RE = /^(?:human-readable summary|human summary)\s*:\s*/i;
const TECHNICAL_DETAILS_LABEL_RE = /^(?:technical details?|details(?:_technical)?)\s*:\s*/i;
const FINAL_REPORT_HEADING_RE = /^(?:#{1,6}\s*)?(?:root cause|files? changed|changes|validation|tests?(?: run| passed)?|sacrificial(?: delivery)?(?: result)?|deployment(?:\/live-runtime)?(?: step)?|live-runtime(?: step)?|result|results|summary|highlights?|notes?|follow[- ]ups?|next steps?|blockers?|implementation|what changed|verification)\s*:?$/i;
const FINAL_REPORT_CUE_RE = /\b(?:root cause|files? changed|tests? run|validation|sacrificial(?: delivery)?(?: result)?|deployment(?:\/live-runtime)?(?: step)?|live-runtime(?: step)?|final report|human-readable report|files changed|tests passed)\b/i;

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

function normalizeReportLineEndings(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;
  return stripAnsi(normalized)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLikelyHumanFinalReport(text) {
  const normalized = normalizeReportLineEndings(text);
  if (!normalized) return false;
  if (isGenericOrTrivial(normalized)) return false;
  if (isInternalTransportNoiseText(normalized)) return false;
  if (looksLikeRawPayloadText(normalized)) return false;
  if (looksLikeGunbrokerReport(normalized)) return false;

  const rawLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^```/.test(line));
  if (rawLines.length < 3) return false;

  const cleanedLines = rawLines.map(line => cleanMarkdown(line).replace(/\s+/g, ' ').trim());
  const headingCount = cleanedLines.filter(line => FINAL_REPORT_HEADING_RE.test(line)).length;
  const itemCount = rawLines.filter(isItemLine).length;
  const hasCue = FINAL_REPORT_CUE_RE.test(normalized);
  const hasSectionLabel = /^#{1,6}\s+\S|^[A-Za-z][A-Za-z0-9 /_-]{2,60}:$/m.test(normalized);

  // This is the key path for real completion reports from agents: multiple
  // human-readable sections plus bullets. Those reports are already the final
  // answer and must not be collapsed into "Files changed: Validation: ...".
  if (hasCue && headingCount >= 2 && (itemCount >= 1 || rawLines.length >= 5)) return true;

  // Allow slightly shorter reports with an explicit root cause / validation shape.
  if (hasCue && headingCount >= 1 && itemCount >= 2 && hasSectionLabel) return true;

  return false;
}

function getPassThroughHumanFinalReport(text) {
  const normalized = normalizeReportLineEndings(text);
  if (!normalized) return null;
  return isLikelyHumanFinalReport(normalized) ? normalized : null;
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

function lowerFirst(text) {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function extractExplicitTechnicalTail(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const match = EXPLICIT_TECHNICAL_MARKER_RE.exec(normalized);
  if (!match || typeof match.index !== 'number' || match.index <= 0) return null;

  const lead = normalizeCompletionText(normalized.slice(0, match.index));
  const technicalTail = normalizeCompletionText(normalized.slice(match.index + match[0].length));
  if (!lead || !technicalTail) return null;

  return { lead, technicalTail };
}

function extractStructuredSummarySections(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const cleaned = cleanMarkdown(normalized).replace(/\r\n?/g, '\n').trim();
  if (!cleaned) return null;

  const humanMatch = HUMAN_SUMMARY_SECTION_RE.exec(cleaned);
  const technicalMatch = TECHNICAL_DETAILS_SECTION_RE.exec(cleaned);
  if (!humanMatch && !technicalMatch) return null;

  let summary = null;
  let technical = null;

  if (humanMatch) {
    const summaryStart = humanMatch.index + humanMatch[0].length;
    const summaryEnd = technicalMatch && technicalMatch.index > humanMatch.index
      ? technicalMatch.index
      : cleaned.length;
    summary = normalizeCompletionText(cleaned.slice(summaryStart, summaryEnd));
  }

  if (technicalMatch) {
    const technicalStart = technicalMatch.index + technicalMatch[0].length;
    technical = normalizeCompletionText(cleaned.slice(technicalStart));
  }

  if (!summary && !technical) return null;
  return { summary, technical };
}

function stripHumanSummaryLabel(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const sections = extractStructuredSummarySections(normalized);
  if (sections?.summary) return normalizeCompletionText(sections.summary);
  return normalizeCompletionText(normalized.replace(HUMAN_SUMMARY_LABEL_RE, ''));
}

function normalizeTechnicalDetailLine(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const sections = extractStructuredSummarySections(normalized);
  const source = normalizeCompletionText(sections?.technical || normalized);
  if (!source) return null;

  const lines = prepareLines(source)
    .map(line => line
      .replace(HUMAN_SUMMARY_LABEL_RE, '')
      .replace(TECHNICAL_DETAILS_LABEL_RE, '')
      .replace(/^[-*•]\s+/, '')
      .trim())
    .filter(Boolean);

  const compact = normalizeCompletionText(lines.join(' '));
  return compact || null;
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

function countTechnicalKeywordHits(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return 0;
  const matches = cleanMarkdown(normalized).match(TECHNICAL_KEYWORD_RE) || [];
  return new Set(matches.map(match => match.toLowerCase())).size;
}

function looksTechnicalCompletionSummary(rawText, summarizedText = null) {
  const raw = normalizeCompletionText(rawText);
  if (!raw) return false;

  const cleaned = cleanMarkdown(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;

  const hasDelimiter = /[;|]/.test(cleaned) || /\n[-*#]/.test(raw);
  const hardTechnical = TECHNICAL_COMMIT_PREFIX_RE.test(cleaned)
    || FILE_CONTEXT_PREFIX_RE.test(cleaned)
    || CODEISH_MARKER_RE.test(cleaned)
    || hasDelimiter;

  let technicalScore = 0;
  if (TECHNICAL_COMMIT_PREFIX_RE.test(cleaned)) technicalScore += 3;
  if (FILE_CONTEXT_PREFIX_RE.test(cleaned)) technicalScore += 3;
  if (CODEISH_MARKER_RE.test(cleaned)) technicalScore += 2;
  if (hasDelimiter) technicalScore += 1;
  technicalScore += Math.min(2, countTechnicalKeywordHits(cleaned));
  if (/\b(?:summary_human|deliveryText|details_technical|sessionKey|idempotencyKey)\b/.test(cleaned)) {
    technicalScore += 2;
  }

  let humanScore = 0;
  if (HUMAN_CUE_RE.test(cleaned)) humanScore += 2;
  if (/\b(?:people|users?|operators?)\b/i.test(cleaned)) humanScore += 1;
  if (/\b(?:now|because|so that|helps?|prevents?|avoids?|keeps?|lets?|allows?)\b/i.test(cleaned)) humanScore += 1;
  if (summarizedText && summarizeProse(summarizedText) && !TECHNICAL_COMMIT_PREFIX_RE.test(cleaned) && !FILE_CONTEXT_PREFIX_RE.test(cleaned)) {
    humanScore += 1;
  }

  if (!hardTechnical) {
    return technicalScore >= 5 && technicalScore > humanScore + 2;
  }

  return technicalScore >= 3 && technicalScore > humanScore + 1;
}

function replaceTechnicalPhrases(text) {
  if (!text) return text;
  return text
    .replace(/\bsummary_human\b/gi, 'human summary')
    .replace(/\bsummaryHuman\b/g, 'human summary')
    .replace(/\bdeliveryText\b/g, 'delivery text')
    .replace(/\bdetails_technical\b/gi, 'technical details')
    .replace(/\bresolveCompletionDelivery\b/g, 'completion delivery logic')
    .replace(/\bbuildTerminalCompletionPayload\b/g, 'completion payload builder')
    .replace(/\bstructured completion summary\b/gi, 'the structured summary')
    .replace(/\bstructured completion\b(?!\s+summary)\b/gi, 'structured completion data')
    .replace(/\bcompletion delivery\b/gi, 'how the final completion message is delivered')
    .replace(/\bdelivery path\b/gi, 'delivery flow')
    .replace(/\bwatcher path\b/gi, 'completion watcher flow')
    .replace(/\bwatcher\b/gi, 'completion watcher')
    .replace(/\bstdout\b/gi, 'command output')
    .replace(/\bstderr\b/gi, 'error output')
    .replace(/\bpayload\b/gi, 'result payload')
    .replace(/\braw transcript\b/gi, 'raw completion text')
    .replace(/\bdouble[- ]delivery\b/gi, 'duplicate completion messages')
    .replace(/\bsingle final user-facing completion\b/gi, 'one final completion message')
    .replace(/\bsummary fallback\b/gi, 'fallback summary');
}

function humanizeCamelToken(token) {
  if (!/[a-z][A-Z]/.test(token) && !token.includes('_')) return token;
  return token
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function cleanTechnicalFragment(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  let cleaned = cleanMarkdown(normalized)
    .replace(TECHNICAL_COMMIT_PREFIX_RE, '')
    .replace(FILE_CONTEXT_PREFIX_RE, '')
    .replace(/\b(?:[A-Za-z0-9_.-]+\/)+([A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md|py|sh|sql|ya?ml|toml))\b/g, '$1')
    .replace(/\b([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, (_, token) => humanizeCamelToken(token))
    .replace(/\(\)/g, '')
    .replace(/^[:\-–—]+\s*/, '')
    .replace(/^and\s+/i, '')
    .replace(/^then\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = replaceTechnicalPhrases(cleaned)
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/[;,:]+$/g, '')
    .trim();

  return cleaned || null;
}

function cleanLeadForHumanSummary(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return null;

  const cleaned = replaceTechnicalPhrases(
    cleanMarkdown(normalized)
      .replace(/\bsaved\s+[a-z0-9_]+(?:\/[a-z0-9_]+)+\b/gi, 'your saved progress')
      .replace(/\b([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, (_, token) => humanizeCamelToken(token))
      .replace(/\b([a-z0-9]+_[a-z0-9_]+)\b/g, token => token.replace(/_/g, ' ')),
  )
    .replace(/\brepeating the completed one\b/gi, 'repeating the one you already finished')
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || null;
}

function formatMixedTechnicalSubject(subject) {
  let cleaned = normalizeCompletionText(subject);
  if (!cleaned) return 'the missing data';

  cleaned = replaceTechnicalPhrases(
    cleanMarkdown(cleaned)
      .replace(/\bhealth auto export\b/gi, 'source export')
      .replace(/\bworkouts?\.json\b/gi, 'the export')
      .replace(/\b([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, (_, token) => humanizeCamelToken(token))
      .replace(/\b([a-z0-9]+_[a-z0-9_]+)\b/g, token => token.replace(/_/g, ' ')),
  )
    .replace(/^the\s+(?!missing\b)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'the missing data';
  if (/^the\s+missing\b/i.test(cleaned)) return cleaned;
  if (/^missing\b/i.test(cleaned)) return `the ${cleaned}`;
  if (/^(?:the|your|this|that)\b/i.test(cleaned)) return cleaned;
  return `the ${cleaned}`;
}

function buildSourceSideHumanSentence(technicalTail) {
  const normalized = cleanMarkdown(normalizeCompletionText(technicalTail) || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const hasSourceSide = /\bsource[- ]side\b/i.test(normalized);
  const hasEmptySource = /\b(?:contains zero|count 0|empty|zero [a-z ]+ objects?|no [a-z ]+ to import)\b/i.test(normalized);
  if (!hasSourceSide && !hasEmptySource) return null;

  const subjectMatch = normalized.match(/\b(?:confirmed|found|verified|checked)\s+(the\s+missing\s+.+?)\s+is\s+source[- ]side\b/i)
    || normalized.match(/\b(the\s+missing\s+.+?)\s+is\s+source[- ]side\b/i)
    || normalized.match(/\b(?:confirmed|found|verified|checked)\s+(.+?)\s+is\s+source[- ]side\b/i)
    || normalized.match(/\b(.+?)\s+is\s+source[- ]side\b/i);
  const subject = formatMixedTechnicalSubject(subjectMatch?.[1] || 'missing data');

  if (hasEmptySource) {
    return `I also checked ${subject}, and the source export is empty right now, so there isn't anything new to import yet.`;
  }

  return `I also checked ${subject}, and this turned out to be a source-data issue rather than a new scheduler bug.`;
}

function buildMixedLeadExpectation(text) {
  const normalized = cleanMarkdown(normalizeCompletionText(text) || '').toLowerCase();
  if (!normalized) return null;
  if (/\b(?:next|should|will)\b/.test(normalized)) return null;

  if (/\b(?:planner|plan|scheduled session|session|progression|workout)\b/.test(normalized)) {
    return 'The next plan should reflect that automatically.';
  }
  if (/\b(?:completion|summary|delivery|message|report)\b/.test(normalized)) {
    return 'The next finished job should show that automatically.';
  }
  if (/\b(?:import|sync)\b/.test(normalized)) {
    return 'The next sync should reflect that automatically.';
  }
  return 'The next run should reflect that automatically.';
}

function buildHumanSummaryFromMixedTechnicalText(rawText) {
  const split = extractExplicitTechnicalTail(rawText);
  if (!split) return null;

  const cleanedLead = cleanLeadForHumanSummary(split.lead);
  const leadSummary = cleanedLead
    ? summarizeCompletionText(cleanedLead, { skipEmbeddedObject: true }) || summarizeProse(cleanedLead) || asSentence(cleanedLead)
    : null;
  if (!leadSummary) return null;

  const sentences = [leadSummary];
  const sourceSideSentence = buildSourceSideHumanSentence(split.technicalTail);
  if (sourceSideSentence) sentences.push(sourceSideSentence);

  const expectation = buildMixedLeadExpectation(sentences.join(' '));
  if (expectation) sentences.push(expectation);

  return truncateText(sentences.join(' '), MAX_DELIVERY_CHARS);
}

function isTestOrValidationFragment(fragment) {
  const cleaned = normalizeCompletionText(fragment);
  if (!cleaned) return false;
  return TEST_FRAGMENT_RE.test(cleaned)
    && !/\b(?:human(?:-|\s)?readable|summary|summaries|message|report|chat|duplicate|user-facing)\b/i.test(cleaned);
}

function toPastTenseFragment(fragment) {
  let text = cleanTechnicalFragment(fragment);
  if (!text) return null;

  const rewrites = [
    [/^clean up\b/i, 'cleaned up'],
    [/^normalize\b/i, 'cleaned up'],
    [/^humani[sz]e\b/i, 'made more readable'],
    [/^rewrite\b/i, 'reworked'],
    [/^refactor\b/i, 'refined'],
    [/^fix\b/i, 'fixed'],
    [/^update\b/i, 'updated'],
    [/^adjust\b/i, 'adjusted'],
    [/^change\b/i, 'updated'],
    [/^improve\b/i, 'improved'],
    [/^add\b/i, 'added'],
    [/^introduce\b/i, 'introduced'],
    [/^enable\b/i, 'enabled'],
    [/^support\b/i, 'supported'],
    [/^preserve\b/i, 'kept'],
    [/^keep\b/i, 'kept'],
    [/^retain\b/i, 'retained'],
    [/^prevent\b/i, 'prevented'],
    [/^avoid\b/i, 'avoided'],
    [/^stop\b/i, 'stopped'],
    [/^pass through\b/i, 'passed through'],
    [/^leave\b/i, 'left'],
    [/^prefer\b/i, 'preferred'],
    [/^wire\b/i, 'wired up'],
    [/^route\b/i, 'routed'],
    [/^surface\b/i, 'surfaced'],
    [/^append\b/i, 'appended'],
    [/^format\b/i, 'formatted'],
    [/^teach\b/i, 'taught'],
    [/^ensure\b/i, 'ensured'],
    [/^dedupe\b/i, 'deduplicated'],
  ];

  for (const [pattern, replacement] of rewrites) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
      break;
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  return text ? upperFirst(text) : null;
}

function extractTechnicalFragments(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return [];

  const fragments = prepareLines(normalized)
    .flatMap(line => line.split(/\s*;\s*|\s+\|\s+|\s+&&\s+|\s+->\s+|\s+=>\s+/))
    .map(fragment => fragment.trim())
    .filter(Boolean);

  return fragments.map(cleanTechnicalFragment).filter(Boolean);
}

function detectTechnicalThemes(rawText, fragments = []) {
  const raw = cleanMarkdown(normalizeCompletionText(rawText) || '').toLowerCase();
  const combined = [raw, fragments.join(' ').toLowerCase()].filter(Boolean).join(' ');
  return {
    completionFlow: /\b(?:completion|deliver(?:y|ed)?|notification|message|report|chat|summary|summaries|human(?:-|\s)?readable|plain english|user-facing)\b/.test(combined),
    detailSeparation: /\b(?:technical details?|details_technical|debug|underneath|below|separate|separated|split|move|moved)\b/.test(combined),
    duplicatePrevention: /\b(?:duplicate|double[- ]delivery|single final|dedupe|deduplicat|one clean)\b/.test(combined),
    contextPreservation: /\b(?:structured|context|preserve|kept|retain|survive)\b/.test(combined),
    reliability: RELIABILITY_SIGNAL_RE.test(combined),
    addedBehavior: /\b(?:add|added|introduce|introduced|support|supported|enable|enabled)\b/.test(combined),
    testOnly: fragments.length > 0 && fragments.every(isTestOrValidationFragment),
  };
}

function isPlainEnglishLeadText(text) {
  const normalized = normalizeCompletionText(text);
  if (!normalized) return false;
  if (FILE_CONTEXT_PREFIX_RE.test(normalized)) return false;
  if (CODEISH_MARKER_RE.test(normalized)) return false;
  if (/\b(?:summary(?:_human|Human)?|deliveryText|details_technical|sessionKey|idempotencyKey|payload-precedence|raw summary|watcher path|completion delivery)\b/i.test(normalized)) {
    return false;
  }
  return !looksTechnicalCompletionSummary(normalized, normalized);
}

function buildCompletionLeadFromThemes(themes) {
  const sentences = [];
  if (themes.duplicatePrevention) {
    sentences.push('Final completion updates now arrive as one clean plain-English summary.');
    sentences.push('That makes the result easier to scan and avoids noisy repeat messages.');
  } else {
    sentences.push('Final completion updates now start with a short plain-English summary.');
    if (themes.contextPreservation) {
      sentences.push('That makes the result easier to read without hiding the useful detail.');
    } else {
      sentences.push('That makes the result easier to scan without hiding the useful detail.');
    }
  }
  sentences.push('Future runs should show the clean summary first, with technical details underneath when needed.');
  return truncateText(sentences.join(' '), MAX_DELIVERY_CHARS);
}

function getCompletionRawSummary(completion) {
  const details = getCompletionTechnicalDetails(completion);
  if (!details || typeof details !== 'object') return null;
  return normalizeCompletionText(details.raw_summary ?? details.rawSummary);
}

function buildHumanizedTechnicalSummary(rawText, fallbackSummary) {
  const cleanedRaw = normalizeCompletionText(rawText);
  const fallback = normalizeCompletionText(fallbackSummary);
  if (!cleanedRaw) return fallback;

  const fragments = extractTechnicalFragments(cleanedRaw);
  const primaryFragments = fragments.filter(fragment => !isTestOrValidationFragment(fragment));
  const sourceFragments = primaryFragments.length > 0 ? primaryFragments : fragments;
  const themes = detectTechnicalThemes(cleanedRaw, fragments);

  if (themes.completionFlow) {
    return buildCompletionLeadFromThemes(themes);
  }

  const chosen = sourceFragments
    .slice(0, 2)
    .map(fragment => toPastTenseFragment(fragment))
    .filter(Boolean)
    .filter(fragment => isPlainEnglishLeadText(fragment));

  let actionSummary;
  if (chosen.length === 1) {
    actionSummary = asSentence(chosen[0]);
  } else if (chosen.length >= 2) {
    actionSummary = `${chosen[0]} and ${lowerFirst(chosen[1])}.`;
  } else if (fallback && isPlainEnglishLeadText(fallback)) {
    actionSummary = asSentence(fallback);
  } else if (themes.testOnly) {
    actionSummary = 'Added focused coverage for the weak spot.';
  } else if (themes.reliability) {
    actionSummary = 'The requested fix is in place.';
  } else if (themes.addedBehavior) {
    actionSummary = 'The requested behavior is now in place.';
  } else {
    actionSummary = 'The update is in place.';
  }

  const extras = [];
  if (themes.testOnly) {
    extras.push('That makes the behavior easier to trust.');
    extras.push('Future regressions should get caught quickly.');
  } else if (themes.reliability) {
    extras.push('That should make the workflow more reliable.');
    extras.push('Future runs should be less likely to hit the same problem.');
  } else if (themes.addedBehavior) {
    extras.push('That makes the new behavior available without extra follow-up.');
    extras.push('Future runs should use it automatically.');
  } else {
    extras.push('That should make the result easier to work with.');
    extras.push('Future runs should reflect the change automatically.');
  }

  return truncateText([actionSummary, ...extras].filter(Boolean).join(' '), MAX_DELIVERY_CHARS);
}

export function humanizeCompletionText(value) {
  const raw = normalizeCompletionText(value);
  if (!raw) return null;

  const passThroughReport = getPassThroughHumanFinalReport(raw);
  if (passThroughReport) return passThroughReport;

  const structuredSections = extractStructuredSummarySections(raw);
  const summarySource = normalizeCompletionText(structuredSections?.summary || raw);
  if (!summarySource) return null;

  const mixedSummary = buildHumanSummaryFromMixedTechnicalText(summarySource);
  if (mixedSummary) return mixedSummary;

  const summarized = summarizeCompletionText(summarySource);
  if (!summarized) return null;
  if (!looksTechnicalCompletionSummary(summarySource, summarized)) return stripHumanSummaryLabel(summarized) || summarized;

  return buildHumanizedTechnicalSummary(summarySource, summarized) || summarized;
}

function summarizeChecklistTechnicalDetails(checklist, sha) {
  const normalizedChecklist = cloneChecklist(checklist);
  if (!normalizedChecklist) return null;

  const parts = [];
  if (normalizedChecklist.tests_passed === true) parts.push('tests passed');
  if (normalizedChecklist.pushed === true) {
    const short = shortSha(sha);
    parts.push(short ? `pushed ${short}` : 'changes pushed');
  } else if (sha) {
    parts.push(`commit ${shortSha(sha)}`);
  }

  const extraTrueFlags = Object.entries(normalizedChecklist)
    .filter(([key, flagValue]) => flagValue === true && !['work_complete', 'tests_passed', 'pushed'].includes(key))
    .map(([key]) => key.replace(/_/g, ' '));

  if (extraTrueFlags.length > 0) {
    parts.push(`checks: ${extraTrueFlags.slice(0, 3).join(', ')}`);
  }

  return parts.length > 0 ? `Checks: ${parts.join('; ')}.` : null;
}

function buildTechnicalDetailsText({ rawText, summaryText, completion, includeRawSummaryDetails = true } = {}) {
  const raw = normalizeCompletionText(rawText);
  const summary = normalizeCompletionText(summaryText);
  const details = getCompletionTechnicalDetails(completion);
  const parts = [];

  const rawSections = extractStructuredSummarySections(raw);
  const splitRaw = extractExplicitTechnicalTail(raw);
  const rawTechnicalSource = normalizeTechnicalDetailLine(rawSections?.technical || splitRaw?.technicalTail || raw);
  const rawHasExplicitTechnical = Boolean(rawSections?.technical || splitRaw?.technicalTail);

  const rawTechnical = Boolean(
    rawTechnicalSource
      && ((rawHasExplicitTechnical && rawTechnicalSource !== summary)
        || (looksTechnicalCompletionSummary(rawTechnicalSource, summary) && rawTechnicalSource !== summary)),
  );
  if (rawTechnical) {
    parts.push(truncateText(rawTechnicalSource, 260));
  }

  let completionDetailsAreTechnical = false;
  if (typeof details === 'string') {
    const detailSections = extractStructuredSummarySections(details);
    const splitDetails = extractExplicitTechnicalTail(details);
    const normalized = normalizeTechnicalDetailLine(detailSections?.technical || splitDetails?.technicalTail || details);
    completionDetailsAreTechnical = Boolean(
      normalized && (detailSections?.technical || splitDetails?.technicalTail || looksTechnicalCompletionSummary(normalized, summary)),
    );
    if (normalized
      && !isInternalTransportNoiseText(normalized)
      && (completionDetailsAreTechnical || rawTechnical)
      && (!rawTechnical || normalized !== rawTechnicalSource)) {
      parts.push(truncateText(normalized, 220));
    }
  } else if (includeRawSummaryDetails && details && typeof details === 'object') {
    const rawSummary = normalizeCompletionText(details.raw_summary);
    const detailSummarySections = extractStructuredSummarySections(rawSummary);
    const splitDetailSummary = extractExplicitTechnicalTail(rawSummary);
    const technicalSummary = normalizeTechnicalDetailLine(detailSummarySections?.technical || splitDetailSummary?.technicalTail || rawSummary);
    completionDetailsAreTechnical = Boolean(
      technicalSummary && (detailSummarySections?.technical || splitDetailSummary?.technicalTail || looksTechnicalCompletionSummary(technicalSummary, summary)),
    );
    if (technicalSummary
      && !isInternalTransportNoiseText(technicalSummary)
      && (completionDetailsAreTechnical || rawTechnical)
      && (!rawTechnical || technicalSummary !== rawTechnicalSource)) {
      parts.push(truncateText(technicalSummary, 220));
    }
  }

  const checklistDetails = summarizeChecklistTechnicalDetails(completion?.checklist, completion?.sha);
  if (checklistDetails && (rawTechnical || completionDetailsAreTechnical)) parts.push(checklistDetails);

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const normalized = normalizeTechnicalDetailLine(part) || normalizeCompletionText(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}

function composeDeliveryText(summaryText, technicalDetailsText = null) {
  const summarySections = extractStructuredSummarySections(summaryText);
  const summary = stripHumanSummaryLabel(summarySections?.summary || summaryText);
  if (!summary) return null;

  const technicalCandidates = [];
  if (summarySections?.technical) technicalCandidates.push(summarySections.technical);
  if (Array.isArray(technicalDetailsText)) technicalCandidates.push(...technicalDetailsText);
  else if (technicalDetailsText != null) technicalCandidates.push(technicalDetailsText);

  const technicalLines = [];
  const seen = new Set();
  for (const candidate of technicalCandidates) {
    const normalized = normalizeTechnicalDetailLine(candidate);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    technicalLines.push(normalized);
  }

  if (technicalLines.length > 0) {
    return `${summary}\n\nTechnical details:\n- ${technicalLines.join('\n- ')}`;
  }
  return summary;
}

export function summarizeCompletionText(value, { skipEmbeddedObject = false } = {}) {
  const raw = normalizeCompletionText(value);
  if (!raw) return null;

  const passThroughReport = getPassThroughHumanFinalReport(raw);
  if (passThroughReport) return passThroughReport;

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
  return normalizeCompletionText(completion?.summary_human ?? completion?.summaryHuman ?? completion?.prose);
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

function hasNegatedCommandContext(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return /\b(?:do\s+not|don't|dont|never)\s+(?:use|run|call|invoke)?\s*$/i.test(before)
    || /\bavoid\s+(?:using\s+)?$/i.test(before)
    || /\bwithout\s+(?:using\s+)?$/i.test(before);
}

export function taskRequiresGitSha(taskPrompt) {
  if (!taskPrompt || typeof taskPrompt !== 'string') return false;

  const commandPattern = /\bgit\s+(push|rebase|cherry-pick)\b|(?:^|\s)--force-with-lease\b|(?:^|\s)--force-push\b/ig;
  let match;
  while ((match = commandPattern.exec(taskPrompt)) !== null) {
    if (!hasNegatedCommandContext(taskPrompt, match.index)) return true;
  }
  return false;
}

export function inferTaskCompletionRequirements(taskPrompt) {
  const text = typeof taskPrompt === 'string' ? taskPrompt : '';
  const pushForbidden = PUSH_FORBIDDEN_RE.test(text);
  const pushRequired = !pushForbidden && taskRequiresGitSha(text);
  const testsApplicable = TEST_APPLICABILITY_RE.test(text) && !TEST_NEGATION_RE.test(text);

  return {
    pushRequired,
    pushForbidden,
    testsApplicable,
  };
}

export function buildCompletionChecklistExample(taskPromptOrRequirements) {
  const requirements = typeof taskPromptOrRequirements === 'string' || taskPromptOrRequirements == null
    ? inferTaskCompletionRequirements(taskPromptOrRequirements)
    : taskPromptOrRequirements;

  const example = { work_complete: true };
  if (requirements?.testsApplicable) example.tests_passed = true;
  if (requirements?.pushRequired) example.pushed = true;
  return JSON.stringify(example);
}

export function buildCompletionSignalInstructions({ label, taskPrompt, doneScriptPath } = {}) {
  const escapedLabel = String(label || '').replace(/'/g, "'\\''");
  const requirements = inferTaskCompletionRequirements(taskPrompt);
  const checklistExample = buildCompletionChecklistExample(requirements);

  const readinessChecks = [
    'All file edits are saved',
    requirements.testsApplicable
      ? 'Any required tests / validation for this task have passed'
      : 'Any required validation for this task is complete',
    'All required API calls / external follow-up actions are done',
  ];

  if (requirements.pushRequired) {
    readinessChecks.push('Any required git push / history-editing step for this task is complete');
  }

  readinessChecks.push('You have verified the work is complete');

  const lines = [];
  lines.push('COMPLETION SIGNAL -- READ CAREFULLY:');
  lines.push('');
  lines.push('Only call this command after ALL of the following are true:');
  readinessChecks.forEach((line, idx) => lines.push(`  ${idx + 1}. ${line}`));
  lines.push('');
  lines.push('Call this as your ABSOLUTE FINAL action -- nothing else runs after this:');
  lines.push('  IMPORTANT: run this command in the dispatch session shell on this host. Do not run it inside ssh, docker, tmux, or any remote shell; remote label stores cannot mark this dispatch complete.');
  lines.push(`  node '${doneScriptPath}' done --label '${escapedLabel}' \\`);
  lines.push('    --summary "<human-readable summary of what you actually did>" \\');
  lines.push(`    --checklist '${checklistExample}' \\`);
  lines.push('    [--sha "<git commit SHA if applicable>"]');
  lines.push('');
  lines.push('Checklist rules:');
  lines.push('  - work_complete MUST be true -- you are asserting you have finished ALL assigned work');
  lines.push('  - Only include tests_passed if validation/testing was actually required for this task');
  lines.push('  - Only include pushed:true if this task required a pushed git change');

  if (requirements.pushForbidden) {
    lines.push('  - This task explicitly says not to push -- do not wait on a push or set pushed:true before calling done');
  }

  lines.push('If this task required a pushed git change, --sha is required and must be the actual pushed commit SHA. The done script will reject invented or placeholder SHAs.');
  lines.push('Do NOT call done while planning, reading files, or mid-task.');

  if (requirements.pushRequired) {
    lines.push('If the required push for this task has not happened yet, you are not done.');
  }

  return lines.join('\n');
}

function extractTextSegments(content) {
  if (typeof content === 'string') return [content];
  if (!content || typeof content !== 'object') return [];

  if (Array.isArray(content)) {
    return content.flatMap(part => {
      if (typeof part === 'string') return [part];
      if (part && typeof part.text === 'string') return [part.text];
      return [];
    });
  }

  if (typeof content.text === 'string') return [content.text];
  return [];
}

function entryHasToolUse(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'tool_use') return true;
  if (!Array.isArray(entry.content)) return false;
  return entry.content.some(part => part?.type === 'tool_use');
}

function entryHasToolResult(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'tool_result') return true;
  if (!Array.isArray(entry.content)) return false;
  return entry.content.some(part => part?.type === 'tool_result');
}

function extractEntryText(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return normalizeCompletionText(extractTextSegments(entry.content).join('').trim());
}

export function extractLastMeaningfulAssistantReplyFromEntries(entries) {
  if (!Array.isArray(entries)) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.role !== 'assistant') continue;
    if (entryHasToolUse(entry)) continue;

    const text = extractEntryText(entry);
    if (isMeaningfulCompletionText(text)) return text;
  }

  return null;
}

export function extractTerminalAssistantReplyFromEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;

    if (entry.role === 'assistant') {
      if (entryHasToolUse(entry)) return null;

      const text = extractEntryText(entry);
      if (!text) continue;
      if (!isMeaningfulCompletionText(text)) return null;

      const stopReason = entry.stop_reason ?? entry.stopReason ?? null;
      return stopReason === 'end_turn' ? text : null;
    }

    if (entry.role === 'user') {
      if (entryHasToolResult(entry)) return null;
      return null;
    }
  }

  return null;
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
  const normalizedSummary = humanizeCompletionText(rawSummary);
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
  const rawCompletionRawSummary = getCompletionRawSummary(completion);
  const rawFallback = normalizeCompletionText(fallbackSummary);

  const reply = humanizeCompletionText(lastReply);
  const completionSummaryHuman = humanizeCompletionText(rawCompletionSummaryHuman);
  const completionSummary = humanizeCompletionText(completion?.summary);
  const completionDelivery = humanizeCompletionText(completion?.deliveryText);
  const completionRawSummary = humanizeCompletionText(rawCompletionRawSummary);
  const fallback = humanizeCompletionText(fallbackSummary);
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
    rawCompletionRawSummary,
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
    const technicalDetailsText = buildTechnicalDetailsText({
      rawText: candidate.rawText,
      summaryText: candidate.text,
      completion,
      includeRawSummaryDetails: false,
    });
    return {
      deliveryText: composeDeliveryText(candidate.text, technicalDetailsText),
      summary: candidate.summary || candidate.text,
      source: candidate.source,
    };
  }

  if (isDeliverableText(rawReply, reply)) {
    const technicalDetailsText = buildTechnicalDetailsText({
      rawText: rawReply,
      summaryText: reply,
      completion,
      includeRawSummaryDetails: false,
    });
    return {
      deliveryText: composeDeliveryText(reply, technicalDetailsText),
      summary: authoritativeStructuredSummary || reply,
      source: 'lastReply',
    };
  }

  if (isDeliverableText(rawCompletionRawSummary, completionRawSummary)) {
    const technicalDetailsText = buildTechnicalDetailsText({
      rawText: rawCompletionRawSummary,
      summaryText: completionRawSummary,
      completion,
    });
    return {
      deliveryText: composeDeliveryText(completionRawSummary, technicalDetailsText),
      summary: completionRawSummary,
      source: 'raw-summary',
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
    const technicalDetailsText = buildTechnicalDetailsText({
      rawText: candidate.rawText,
      summaryText: candidate.text,
      completion,
    });
    return {
      deliveryText: composeDeliveryText(candidate.text, technicalDetailsText),
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
