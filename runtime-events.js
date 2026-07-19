import { getDb } from './db.js';
import { canonicalStringify, sha256 } from './handoff-artifact.js';

const SENSITIVE_KEY = /(secret|token|password|private[_-]?key|credential|raw[_-]?value|proof_value)/i;

function sanitizeValue(value, key = '') {
  if (SENSITIVE_KEY.test(key)) {
    return value == null ? null : { redacted: true, sha256: sha256(canonicalStringify(value)) };
  }
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey);
  }
  return sanitized;
}

function deserializeRuntimeEvent(row) {
  const expected = sha256(row.payload);
  if (row.payload_sha256 !== expected) {
    throw Object.assign(new Error(`Runtime event ${row.id} payload hash mismatch`), {
      code: 'RUNTIME_EVENT_TAMPERED',
    });
  }
  try {
    const payload = JSON.parse(row.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('payload must be a JSON object');
    }
    return { ...row, payload };
  } catch (error) {
    throw Object.assign(new Error(`Runtime event ${row.id} payload is invalid JSON`, {
      cause: error,
    }), {
      code: 'RUNTIME_EVENT_INVALID',
    });
  }
}

export function appendRuntimeEvent(eventType, fields = {}, opts = {}) {
  if (typeof eventType !== 'string' || eventType.trim() === '') {
    throw new TypeError('runtime event type must be a non-empty string');
  }
  const db = opts.db || getDb();
  const payload = sanitizeValue(fields.payload ?? {});
  const payloadText = canonicalStringify(payload);
  const result = db.prepare(`
    INSERT INTO runtime_events (
      event_type, event_version, job_id, dispatch_queue_id, run_id,
      approval_id, handoff_artifact_digest, source_run_id,
      source_run_handoff_artifact_digest, payload, payload_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    fields.eventVersion ?? 1,
    fields.jobId ?? null,
    fields.dispatchQueueId ?? null,
    fields.runId ?? null,
    fields.approvalId ?? null,
    fields.handoffArtifactDigest ?? null,
    fields.sourceRunId ?? null,
    fields.sourceRunHandoffArtifactDigest ?? null,
    payloadText,
    sha256(payloadText),
  );
  return getRuntimeEvent(Number(result.lastInsertRowid), { db });
}

export function getRuntimeEvent(id, opts = {}) {
  const db = opts.db || getDb();
  const row = db.prepare('SELECT * FROM runtime_events WHERE id = ?').get(id);
  if (!row) return null;
  return deserializeRuntimeEvent(row);
}

export function listRuntimeEvents(filter = {}, opts = {}) {
  const db = opts.db || getDb();
  const clauses = [];
  const params = [];
  for (const [column, value] of [
    ['run_id', filter.runId],
    ['job_id', filter.jobId],
    ['handoff_artifact_digest', filter.handoffArtifactDigest],
    ['event_type', filter.eventType],
  ]) {
    if (value != null) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 1000);
  const rows = db.prepare(`
    SELECT * FROM runtime_events
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(deserializeRuntimeEvent);
}
