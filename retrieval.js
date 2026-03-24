// Hybrid retrieval for injecting prior-run context into job prompts
import { getDb } from './db.js';

// ---- TF-IDF helpers ----

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'and',
  'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'they', 'them', 'their', 'what', 'which', 'who', 'whom',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function computeTF(tokens) {
  const freq = {};
  for (const t of tokens) {
    freq[t] = (freq[t] || 0) + 1;
  }
  const len = tokens.length || 1;
  const tf = {};
  for (const [term, count] of Object.entries(freq)) {
    tf[term] = count / len;
  }
  return tf;
}

function computeIDF(docs) {
  // docs: array of TF maps
  const N = docs.length || 1;
  const df = {}; // document frequency per term
  for (const tf of docs) {
    for (const term of Object.keys(tf)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  const idf = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = Math.log(N / count) + 1; // smoothed IDF
  }
  return idf;
}

function tfidfScore(queryTokens, docTF, idf) {
  let score = 0;
  for (const qt of queryTokens) {
    if (docTF[qt]) {
      score += docTF[qt] * (idf[qt] || 1);
    }
  }
  return score;
}

/**
 * Extract readable text from a context_summary field.
 * The field may be a JSON string (object with string values) or plain text.
 */
function extractSummaryText(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed)
        .filter(v => typeof v === 'string')
        .join(' ');
    }
    return String(parsed);
  } catch {
    return raw;
  }
}

// ---- Exports ----

/**
 * Get the last N run summaries (non-null context_summary) for a job.
 */
export function getRecentRunSummaries(jobId, limit = 5) {
  return getDb().prepare(`
    SELECT id, job_id, started_at, finished_at, status, context_summary, summary
    FROM runs
    WHERE job_id = ? AND context_summary IS NOT NULL
    ORDER BY started_at DESC
    LIMIT ?
  `).all(jobId, limit);
}

/**
 * Search run summaries using hybrid substring + TF-IDF scoring.
 * Returns top N matches from the last 50 runs with summaries.
 */
export function searchRunSummaries(jobId, query, limit = 5) {
  // Fetch candidate pool
  const candidates = getDb().prepare(`
    SELECT id, job_id, started_at, finished_at, status, context_summary, summary
    FROM runs
    WHERE job_id = ? AND context_summary IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 50
  `).all(jobId);

  if (!candidates.length || !query) return candidates.slice(0, limit);

  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();

  // Build TF for each doc
  const docTFs = candidates.map(c => {
    const text = [extractSummaryText(c.context_summary), c.summary || ''].join(' ');
    return computeTF(tokenize(text));
  });

  const idf = computeIDF(docTFs);

  // Score each candidate
  const scored = candidates.map((c, i) => {
    const text = [extractSummaryText(c.context_summary), c.summary || ''].join(' ').toLowerCase();
    // Substring bonus
    const substringBonus = text.includes(queryLower) ? 1.0 : 0;
    // TF-IDF score
    const tfidf = tfidfScore(queryTokens, docTFs[i], idf);
    return { ...c, _score: tfidf + substringBonus };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit).filter(s => s._score > 0);
}

/**
 * Build retrieval context string to inject into a job prompt.
 * Returns empty string if retrieval is disabled or no results found.
 */
export function buildRetrievalContext(job) {
  if (!job.context_retrieval || job.context_retrieval === 'none') return '';

  const limit = job.context_retrieval_limit || 5;
  let runs;

  if (job.context_retrieval === 'recent') {
    runs = getRecentRunSummaries(job.id, limit);
  } else if (job.context_retrieval === 'hybrid') {
    // Use the job's payload_message as the search query
    runs = searchRunSummaries(job.id, job.payload_message, limit);
    // Fallback to recent if search returns nothing
    if (!runs.length) {
      runs = getRecentRunSummaries(job.id, limit);
    }
  } else {
    return '';
  }

  if (!runs.length) return '';

  const lines = ['--- Prior Run Context ---'];
  for (const run of runs) {
    const date = run.started_at || 'unknown';
    const summaryText = extractSummaryText(run.context_summary) || run.summary || '';
    lines.push(`[${date}] ${summaryText}`);
  }
  lines.push('--- End Prior Run Context ---');

  return lines.join('\n');
}
