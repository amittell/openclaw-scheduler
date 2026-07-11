import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createDispatcherOwnerId() {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/**
 * Owns the singleton dispatcher lease and a bounded in-process worker queue.
 * Database fencing is still required inside each state transition; the pool
 * only bounds work and prevents duplicate scheduling inside one process.
 */
export function createDispatcherRuntime({
  leaseName = 'scheduler-dispatcher',
  ownerId = createDispatcherOwnerId(),
  leaseTtlMs = 30_000,
  maxConcurrency = 4,
  maxPending = 1000,
  acquireLease,
  renewLease,
  releaseLease,
  assertLease,
  onTaskError = () => {},
  onLeaseLost = () => {},
} = {}) {
  if (typeof acquireLease !== 'function') throw new Error('acquireLease is required');
  if (typeof renewLease !== 'function') throw new Error('renewLease is required');
  if (typeof releaseLease !== 'function') throw new Error('releaseLease is required');
  if (typeof assertLease !== 'function') throw new Error('assertLease is required');

  const ttlMs = positiveInteger(leaseTtlMs, 30_000);
  const concurrency = positiveInteger(maxConcurrency, 4);
  const pendingLimit = positiveInteger(maxPending, 1000);
  const pending = [];
  const active = new Map();
  const keys = new Set();
  const idleWaiters = new Set();
  let lease = null;
  let accepting = false;
  let leaseLost = false;
  let renewalTimer = null;

  const stopRenewalTimer = () => {
    if (!renewalTimer) return;
    clearInterval(renewalTimer);
    renewalTimer = null;
  };

  const loseLease = (error = null) => {
    if (leaseLost) return;
    accepting = false;
    leaseLost = true;
    stopRenewalTimer();
    pending.splice(0).forEach(item => keys.delete(item.key));
    onLeaseLost({
      leaseName,
      ownerId,
      fencingToken: lease?.fencing_token ?? null,
      error: error?.message || null,
    });
    notifyIdle();
  };

  const renewCurrentLease = () => {
    if (!lease || leaseLost) return null;
    try {
      const renewed = renewLease(leaseName, ownerId, lease.fencing_token, ttlMs);
      if (!renewed) {
        loseLease();
        return null;
      }
      lease = renewed;
      return lease;
    } catch (error) {
      loseLease(error);
      return null;
    }
  };

  const startRenewalTimer = () => {
    if (renewalTimer || !lease || leaseLost) return;
    const renewalIntervalMs = Math.max(1, Math.floor(ttlMs / 3));
    renewalTimer = setInterval(renewCurrentLease, renewalIntervalMs);
    renewalTimer.unref?.();
  };

  const notifyIdle = () => {
    if (pending.length > 0 || active.size > 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const runNext = () => {
    if (!accepting || leaseLost) return;
    while (active.size < concurrency && pending.length > 0) {
      const item = pending.shift();
      const taskPromise = Promise.resolve()
        .then(() => item.task({
          ownerId,
          fencingToken: lease.fencing_token,
          leaseName,
        }))
        .catch(error => {
          onTaskError(error, { key: item.key, ownerId, fencingToken: lease?.fencing_token ?? null });
        })
        .finally(() => {
          active.delete(item.key);
          keys.delete(item.key);
          runNext();
          notifyIdle();
        });
      active.set(item.key, taskPromise);
    }
    notifyIdle();
  };

  return {
    get ownerId() {
      return ownerId;
    },
    get fencingToken() {
      return lease?.fencing_token ?? null;
    },
    get maxConcurrency() {
      return concurrency;
    },
    get activeCount() {
      return active.size;
    },
    get pendingCount() {
      return pending.length;
    },
    get maxPending() {
      return pendingLimit;
    },
    get isLeader() {
      return Boolean(lease) && !leaseLost;
    },

    start() {
      if (lease) return lease;
      lease = acquireLease(leaseName, ownerId, ttlMs);
      if (!lease) return null;
      accepting = true;
      leaseLost = false;
      startRenewalTimer();
      return lease;
    },

    renew() {
      return renewCurrentLease();
    },

    assertLeadership() {
      if (!lease || leaseLost) return false;
      try {
        const ownsLease = Boolean(assertLease(leaseName, ownerId, lease.fencing_token));
        if (!ownsLease) loseLease();
        return ownsLease;
      } catch (error) {
        loseLease(error);
        return false;
      }
    },

    submit(key, task) {
      if (!accepting || leaseLost) return false;
      if (typeof task !== 'function') throw new Error('task must be a function');
      const stableKey = String(key);
      if (keys.has(stableKey)) return false;
      if (pending.length + active.size >= pendingLimit) return false;
      keys.add(stableKey);
      pending.push({ key: stableKey, task });
      runNext();
      return true;
    },

    waitForIdle() {
      if (pending.length === 0 && active.size === 0) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },

    async stop({ drain = true } = {}) {
      accepting = false;
      if (!drain) {
        pending.splice(0).forEach(item => keys.delete(item.key));
      }
      if (drain) await this.waitForIdle();
      stopRenewalTimer();
      if (lease) {
        releaseLease(leaseName, ownerId, lease.fencing_token);
      }
      lease = null;
      notifyIdle();
    },
  };
}
