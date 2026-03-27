// Idempotency key generation and ledger operations
import { createHash } from 'crypto';
import { getDb } from './db.js';

/**
 * Generate an idempotency key for a scheduled job execution.
 * Deterministic: same job + same scheduled time = same key.
 */
export function generateIdempotencyKey(jobId, scheduledTime) {
  if (!scheduledTime) throw new Error('scheduledTime is required for deterministic idempotency key');
  const raw = `${jobId}:${scheduledTime}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Generate an idempotency key for a chain-triggered child job.
 * Based on the parent run ID + child job ID.
 */
export function generateChainIdempotencyKey(parentRunId, childJobId) {
  const raw = `chain:${parentRunId}:${childJobId}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Generate an idempotency key for a manual run-now trigger.
 * Unique per call (timestamp-based).
 */
export function generateRunNowIdempotencyKey(jobId) {
  const raw = `run_now:${jobId}:${Date.now()}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Check if an idempotency key is currently claimed in the ledger.
 * Returns the ledger entry if claimed, null otherwise.
 */
export function checkIdempotencyKey(key) {
  return getDb().prepare("SELECT * FROM idempotency_ledger WHERE key = ? AND status = 'claimed'").get(key) || null;
}

/**
 * Get a ledger entry by key (any status).
 */
export function getIdempotencyEntry(key) {
  return getDb().prepare('SELECT * FROM idempotency_ledger WHERE key = ?').get(key) || null;
}

/**
 * Claim an idempotency key in the ledger.
 * Returns true if successfully claimed, false if already claimed (race condition).
 */
export function claimIdempotencyKey(key, jobId, runId, expiresAt) {
  if (!key) return true;
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT status FROM idempotency_ledger WHERE key = ?').get(key);
    if (!existing) {
      db.prepare(
        "INSERT INTO idempotency_ledger (key, job_id, run_id, claimed_at, expires_at) VALUES (?, ?, ?, datetime('now'), ?)"
      ).run(key, jobId, runId, expiresAt);
      return true;
    }

    if (existing.status === 'released') {
      db.prepare(`
        UPDATE idempotency_ledger
        SET status = 'claimed',
            job_id = ?,
            run_id = ?,
            claimed_at = datetime('now'),
            released_at = NULL,
            result_hash = NULL,
            expires_at = ?
        WHERE key = ?
      `).run(jobId, runId, expiresAt, key);
      return true;
    }

    return false;
  });

  return tx();
}

/**
 * Release an idempotency key (on failure) so retries/replays can reclaim it.
 */
export function releaseIdempotencyKey(key) {
  if (!key) return;
  getDb().prepare(
    "UPDATE idempotency_ledger SET status = 'released', released_at = datetime('now') WHERE key = ? AND status = 'claimed'"
  ).run(key);
}

/**
 * Store a result hash on the ledger entry (for debugging/verification).
 */
export function updateIdempotencyResultHash(key, content) {
  if (!key || !content) return;
  const resultHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  getDb().prepare('UPDATE idempotency_ledger SET result_hash = ? WHERE key = ?').run(resultHash, key);
}

/**
 * List recent idempotency entries for a job.
 */
export function listIdempotencyForJob(jobId, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM idempotency_ledger WHERE job_id = ? ORDER BY claimed_at DESC LIMIT ?'
  ).all(jobId, limit);
}

/**
 * Force prune all expired entries. Returns deletion count.
 */
export function forcePruneIdempotency() {
  const result = getDb().prepare("DELETE FROM idempotency_ledger WHERE expires_at < datetime('now')").run();
  return result.changes;
}
