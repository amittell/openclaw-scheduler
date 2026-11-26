// delivery_from: deliver a job's output from a per-job marker line.
//
// The OpenClaw gateway answers an agent turn with every reply payload of the
// run joined by a blank line, so the step narration a model writes between
// tool calls ("Fetching git + GitHub state.") reaches the channel ahead of the
// report itself. The scheduler cannot tell a payload boundary from a paragraph
// break. A job that knows how its report begins names that line prefix in
// delivery_from, and only the text from the last line that starts with it is
// delivered. The run record keeps the full text; only the delivered body
// changes. A missing marker never drops or truncates a delivery: the full text
// is delivered and one warning is logged.

export const DELIVERY_FROM_MAX_LENGTH = 200;

/**
 * Select the text to deliver for a delivery_from marker.
 *
 * A line matches when it starts with `marker` after optional leading
 * whitespace; a marker later in a line does not count. The selected text runs
 * from the start of the marker on the LAST matching line to the end of the
 * input, unchanged.
 *
 * @param {string} text - The full delivery text.
 * @param {string|null|undefined} marker - The job's delivery_from value.
 * @returns {{ found: boolean, matches: number, text: string }} `text` is the
 *   input unchanged when the marker is unset or no line matches.
 */
export function selectDeliveryFrom(text, marker) {
  const body = String(text ?? '');
  if (typeof marker !== 'string' || marker.trim() === '') {
    return { found: false, matches: 0, text: body };
  }
  let start = -1;
  let matches = 0;
  let lineStart = 0;
  for (;;) {
    const newline = body.indexOf('\n', lineStart);
    const line = body.slice(lineStart, newline === -1 ? body.length : newline);
    const indent = line.length - line.replace(/^\s+/, '').length;
    for (let offset = 0; offset <= indent; offset += 1) {
      if (line.startsWith(marker, offset)) {
        start = lineStart + offset;
        matches += 1;
        break;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return start === -1
    ? { found: false, matches: 0, text: body }
    : { found: true, matches, text: body.slice(start) };
}

/**
 * Apply a job's delivery_from marker to the body about to be delivered.
 *
 * Returns `body` itself when the job sets no marker, when the job is a
 * handoff v4 job (the field is outside the v4 artifact binding contract), when
 * the body is blank, or when no line starts with the marker. The last case
 * logs one warning; the full text is still delivered.
 *
 * @param {object} job - The job record (reads delivery_from, handoff_version, name, id).
 * @param {string|null|undefined} body - The text that would be delivered.
 * @param {object} [opts]
 * @param {Function} [opts.log] - Scheduler logger `(level, msg, meta)`.
 * @param {string} [opts.runId]
 * @returns {string|null|undefined}
 */
export function applyDeliveryFrom(job, body, { log, runId = null } = {}) {
  const marker = job?.delivery_from;
  if (typeof marker !== 'string' || marker.trim() === '') return body;
  if (Number(job.handoff_version) === 4) return body;
  const text = String(body ?? '');
  if (!text.trim()) return body;
  const selected = selectDeliveryFrom(text, marker);
  if (!selected.found) {
    log?.('warn', `delivery_from marker not found for ${job.name}; delivering the full text`, {
      runId,
      jobId: job.id ?? null,
      marker,
      chars: text.length,
    });
    return body;
  }
  log?.('info', `Delivering ${job.name} from its delivery_from marker`, {
    runId,
    jobId: job.id ?? null,
    matches: selected.matches,
    droppedChars: text.length - selected.text.length,
    deliveredChars: selected.text.length,
  });
  return selected.text;
}
