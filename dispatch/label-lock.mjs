/**
 * Cross-process lock for the dispatch labels ledger.
 *
 * Several independent processes mutate labels.json concurrently: the enqueue
 * CLI (initial label writes + canary polling), per-minute watcher processes,
 * the status/result/sync CLIs, and recovery tooling. Every mutation is a
 * read-modify-write; without serialization a stale reader can overwrite fields
 * another process just wrote (observed 2026-09-02: a label lost sessionKey/
 * delivery fields mid-enqueue, which then cascaded into a false
 * "terminal failure (unknown)" alarm from the next watcher tick).
 *
 * The lock is advisory but mandatory for this codebase: every mutateLabels()
 * in index.mjs / watcher.mjs routes through withLabelsLock().
 *
 * Mechanics:
 * - Lock file: <labelsDir>/<basename(labelsPath).lock>, created atomically
 *   (O_EXCL) with {pid, ts}.
 * - Stale detection: older than STALE_MS AND the holder pid no longer exists
 *   => break the lock. (Alive holder past STALE_MS => keep waiting; a live
 *   process stuck mid-mutation must not be clobbered.)
 * - Retry: backoff up to TIMEOUT_MS, then throw.
 * - release(): only removes the lock if we still own it (compare pid+ts).
 * - fn() runs inside the lock and MUST re-read the ledger (any cached copy
 *   predates acquisition).
 */

import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const LABELS_LOCK_STALE_MS = 15_000;
export const LABELS_LOCK_TIMEOUT_MS = 30_000;
const LABELS_LOCK_RETRY_MS = 25;

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return error.code === 'EPERM';
  }
}

function tryAcquire(lockPath) {
  if (existsSync(lockPath)) {
    let stale = false;
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'));
      const age = Date.now() - (Number(info.ts) || 0);
      stale = age > LABELS_LOCK_STALE_MS && !ownerAlive(info.pid);
    } catch {
      stale = true; // unparseable lock => treat as stale
    }
    if (stale) {
      try { unlinkSync(lockPath); } catch {}
    }
  }
  let fd = null;
  try {
    fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (error) {
    if (error && error.code !== 'EEXIST') throw error;
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}

function releaseLock(lockPath) {
  try {
    const info = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (info.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // Lock already gone or unreadable; nothing to release.
  }
}

/**
 * Run fn() while holding the labels-ledger lock (synchronous).
 *
 * Synchronous by design: every labels write in index.mjs / watcher.mjs goes
 * through the same mutateLabels()/saveLabels() choke points, and those are
 * called from both async and sync contexts. A sync lock is the only primitive
 * that fits both without restructuring callers.
 *
 * @param {string} labelsPath - Absolute path of labels.json (lock sits beside it).
 * @param {() => T} fn - Mutation to run under the lock. Must re-read the ledger.
 * @param {object} [options] - { timeoutMs }
 * @returns {T} fn()'s return value.
 */
export function withLabelsLockSync(labelsPath, fn, options = {}) {
  const lockPath = join(dirname(labelsPath), `${basename(labelsPath)}.lock`);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : LABELS_LOCK_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    if (tryAcquire(lockPath)) {
      try {
        return fn();
      } finally {
        releaseLock(lockPath);
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `labels lock timeout after ${timeoutMs}ms (a holder is stuck or mutations are too slow): ${labelsPath}`,
      );
    }
    const waitUntil = Date.now() + LABELS_LOCK_RETRY_MS;
    while (Date.now() < waitUntil) {
      // Busy-wait is intentional and bounded (~25ms): label mutations are
      // sub-millisecond JSON writes; sleeping the event loop briefly is far
      // cheaper than making every caller async.
    }
  }
}

/**
 * Acquire + release exactly once; re-entrant for the owning pid (used when a
 * locked section may trigger another locked write).
 */
let heldLockPath = null;
export function withLabelsLock(labelsPath, fn, options = {}) {
  if (heldLockPath === labelsPath) return fn();
  return withLabelsLockSync(labelsPath, () => {
    heldLockPath = labelsPath;
    try {
      return fn();
    } finally {
      heldLockPath = null;
    }
  }, options);
}
