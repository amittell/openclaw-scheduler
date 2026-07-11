import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { getDb } from './db.js';

const SQLITE_NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function normalizeTtlMs(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('ttlMs must be a positive integer');
  }
  return ttlMs;
}

function ttlModifier(ttlMs) {
  return `+${normalizeTtlMs(ttlMs) / 1000} seconds`;
}

export function createDispatcherOwnerId(prefix = 'dispatcher') {
  assertNonEmptyString('prefix', prefix);
  return `${prefix}:${hostname()}:${process.pid}:${randomUUID()}`;
}

export function getDispatcherLease(name) {
  assertNonEmptyString('name', name);
  return getDb().prepare(`
    SELECT *,
      CASE WHEN julianday(expires_at) > julianday('now') THEN 1 ELSE 0 END AS active
    FROM dispatcher_leases
    WHERE name = ?
  `).get(name) || null;
}

/**
 * Atomically acquire a named singleton lease.
 *
 * A live lease held by another owner is never replaced. Expired leases are
 * taken over with a monotonically increasing fencing token, including when
 * the same owner re-acquires after expiry. Re-acquiring an unexpired lease as
 * the same owner is an idempotent renewal and preserves its token.
 */
export function acquireDispatcherLease(name, ownerId, ttlMs = 30_000) {
  assertNonEmptyString('name', name);
  assertNonEmptyString('ownerId', ownerId);
  const modifier = ttlModifier(ttlMs);

  return getDb().prepare(`
    INSERT INTO dispatcher_leases (
      name, owner_id, fencing_token, acquired_at, renewed_at, expires_at
    ) VALUES (
      ?, ?, 1, ${SQLITE_NOW}, ${SQLITE_NOW},
      strftime('%Y-%m-%d %H:%M:%f', 'now', ?)
    )
    ON CONFLICT(name) DO UPDATE SET
      owner_id = excluded.owner_id,
      fencing_token = CASE
        WHEN julianday(dispatcher_leases.expires_at) <= julianday('now')
          THEN dispatcher_leases.fencing_token + 1
        ELSE dispatcher_leases.fencing_token
      END,
      acquired_at = CASE
        WHEN julianday(dispatcher_leases.expires_at) <= julianday('now')
          THEN excluded.acquired_at
        ELSE dispatcher_leases.acquired_at
      END,
      renewed_at = excluded.renewed_at,
      expires_at = excluded.expires_at
    WHERE dispatcher_leases.owner_id = excluded.owner_id
       OR julianday(dispatcher_leases.expires_at) <= julianday('now')
    RETURNING *
  `).get(name, ownerId, modifier) || null;
}

export function renewDispatcherLease(name, ownerId, fencingToken, ttlMs = 30_000) {
  assertNonEmptyString('name', name);
  assertNonEmptyString('ownerId', ownerId);
  if (!Number.isInteger(fencingToken) || fencingToken <= 0) {
    throw new Error('fencingToken must be a positive integer');
  }
  const modifier = ttlModifier(ttlMs);

  return getDb().prepare(`
    UPDATE dispatcher_leases
    SET renewed_at = ${SQLITE_NOW},
        expires_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?)
    WHERE name = ?
      AND owner_id = ?
      AND fencing_token = ?
      AND julianday(expires_at) > julianday('now')
    RETURNING *
  `).get(modifier, name, ownerId, fencingToken) || null;
}

export function assertDispatcherLease(name, ownerId, fencingToken) {
  assertNonEmptyString('name', name);
  assertNonEmptyString('ownerId', ownerId);
  if (!Number.isInteger(fencingToken) || fencingToken <= 0) return false;

  return Boolean(getDb().prepare(`
    SELECT 1
    FROM dispatcher_leases
    WHERE name = ?
      AND owner_id = ?
      AND fencing_token = ?
      AND julianday(expires_at) > julianday('now')
  `).get(name, ownerId, fencingToken));
}

export function releaseDispatcherLease(name, ownerId, fencingToken) {
  assertNonEmptyString('name', name);
  assertNonEmptyString('ownerId', ownerId);
  if (!Number.isInteger(fencingToken) || fencingToken <= 0) return false;

  // Preserve the row and token history. Deleting would let a later acquire
  // reuse token 1, defeating fencing against delayed work from the old owner.
  const result = getDb().prepare(`
    UPDATE dispatcher_leases
    SET renewed_at = ${SQLITE_NOW},
        expires_at = ${SQLITE_NOW}
    WHERE name = ?
      AND owner_id = ?
      AND fencing_token = ?
      AND julianday(expires_at) > julianday('now')
  `).run(name, ownerId, fencingToken);
  return result.changes > 0;
}
