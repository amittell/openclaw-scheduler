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
 * - release(): only removes the lock if we still own it (compare pid AND the
 *   acquisition timestamp captured at acquire). If a stale-break raced us and
 *   the file now holds another process's lock, we never unlink it.
 * - fn() runs inside the lock and MUST re-read the ledger (any cached copy
 *   predates acquisition).
 */

import { existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
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

let lockedAs = null;

function tryAcquire(lockPath) {
  if (existsSync(lockPath)) {
    let age;
    let inoAtStaleCheck = null;
    try {
      const st = statSync(lockPath);
      age = Date.now() - st.mtimeMs;
      inoAtStaleCheck = st.ino;
    } catch {
      age = Infinity; // file vanished between existsSync and stat — O_EXCL re-checks
    }
    let stale;
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8'));
      stale = age > LABELS_LOCK_STALE_MS && !ownerAlive(info.pid);
    } catch {
      // Empty (mid-write) or corrupt lock file. A fresh empty file is a live
      // holder between openSync('wx') and writeFileSync — breaking it would
      // admit a second holder and lose updates (observed in the concurrent
      // regression test on CI). Only break once old enough to be a crash
      // orphan.
      stale = age > LABELS_LOCK_STALE_MS;
    }
    if (stale) {
      // Stale recovery must not unlink a replacement that another breaker
      // acquired after our earlier stat/read. Re-check the same inode and,
      // for readable locks, the owner pid before unlinking; if the file is
      // gone (EACCES), moved, or now held by a live process, leave it alone.
      let stillStale = false;
      try {
        const fresh = statSync(lockPath);
        if (fresh.ino === inoAtStaleCheck) {
          stillStale = true;
          try {
            const info = JSON.parse(readFileSync(lockPath, 'utf8'));
            stillStale = !ownerAlive(info.pid);
          } catch {
            // empty/corrupt and old enough: still a crash orphan
          }
        }
      } catch {
        stillStale = false; // vanished; let the O_EXCL create path own it
      }
      if (stillStale) {
        try { unlinkSync(lockPath); } catch {}
      }
    }
  }
  let fd = null;
  const acquiredTs = Date.now();
  try {
    fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: acquiredTs }));
    lockedAs = acquiredTs;
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
    // Verify pid AND the acquisition timestamp: if the file was replaced
    // after we read it (stale-break race), it belongs to another process —
    // never unlink it.
    if (info.pid === process.pid && info.ts === lockedAs) unlinkSync(lockPath);
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
