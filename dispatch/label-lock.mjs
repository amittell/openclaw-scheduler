/**
 * Process-safe mutex for the local dispatch labels ledger.
 *
 * SQLite's BEGIN IMMEDIATE holds the OS-backed single-writer lock until the
 * connection closes. A crashed process releases ownership through the OS;
 * contenders never inspect a pid/age or unlink another owner's lock file.
 * This uses the existing better-sqlite3 dependency and a dedicated sibling
 * database, not the scheduler application database. The mutex database holds
 * no labels or transcript data and must remain in place between acquisitions.
 *
 * All writers must use this protocol. Stop old CLI/watcher processes before
 * upgrading from the former JSON .lock protocol; mixed versions do not share
 * a mutex. Keep the ledger and mutex on the same host's local filesystem.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const LABELS_LOCK_TIMEOUT_MS = 30_000;
const heldLocks = new Set();

/**
 * Run a synchronous mutation while holding the labels mutex. Reentrant calls
 * for the same normalized ledger path share ownership; distinct ledgers keep
 * independent connections. The callback must re-read labels after acquisition.
 * Callback failure releases the mutex but does not undo a JSON file write.
 */
export function withLabelsLockSync(labelsPath, fn, options = {}) {
  const lockPath = `${resolve(labelsPath)}.lock.sqlite3`;
  if (heldLocks.has(lockPath)) return fn();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(LABELS_LOCK_TIMEOUT_MS, Math.ceil(options.timeoutMs))
    : LABELS_LOCK_TIMEOUT_MS;
  mkdirSync(dirname(lockPath), { recursive: true });
  let db;
  let acquired = false;
  try {
    db = new Database(lockPath, { timeout: timeoutMs });
    db.exec('BEGIN IMMEDIATE');
    acquired = true;
    heldLocks.add(lockPath);
    return fn();
  } catch (error) {
    if (!acquired && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error?.code)) {
      throw new Error(`labels lock timeout after ${timeoutMs}ms: ${labelsPath}`, { cause: error });
    }
    throw error;
  } finally {
    if (acquired) heldLocks.delete(lockPath);
    // SQLite closes with rollback, releasing ownership even when fn throws.
    // Never unlink this persistent file: doing so could split active owners
    // across different inodes and defeat mutual exclusion.
    db?.close();
  }
}

export const withLabelsLock = withLabelsLockSync;
