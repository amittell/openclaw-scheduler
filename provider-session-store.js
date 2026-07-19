import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { canonicalStringify, sha256 } from './handoff-artifact.js';
import { appendRuntimeEvent } from './runtime-events.js';

const memorySessions = new Map();
let pendingColdSessionResolutions = new WeakMap();
const TERMINAL_STATUSES = new Set(['revoked', 'failed']);
const DEFAULT_MAX_TRANSIENT_ERRORS = 3;
const DEFAULT_REFRESH_CLAIM_TIMEOUT_MS = 30_000;

function providerError(code, message, { transient = false, cause = null } = {}) {
  return Object.assign(new Error(message), { code, transient, ...(cause ? { cause } : {}) });
}

function sqliteTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('provider session timestamp is invalid');
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function isPast(value, now = Date.now()) {
  if (!value) return false;
  const parsed = Date.parse(value.endsWith?.('Z') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) && parsed <= now;
}

function contextNowMs(value) {
  const parsed = value === undefined
    ? Date.now()
    : value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isFinite(parsed)) throw new TypeError('provider session current time is invalid');
  return parsed;
}

function completionNowMs(explicitNow, startNow) {
  return explicitNow ? startNow : Date.now();
}

function safeSummary(session) {
  if (!session || typeof session !== 'object') return null;
  const summary = {
    subject_kind: session.subject?.kind ?? null,
    subject_principal: session.subject?.principal ?? session.principal ?? null,
    scope: session.scope ?? null,
    audience: session.audience ?? null,
    resource: session.resource ?? null,
    issuer: session.issuer ?? null,
    trust_level: session.trust?.level ?? session.trust_level ?? null,
    expires_at: session.expires_at ?? null,
    refresh_after: session.refresh_after ?? null,
    rotation_id_hash: session.rotation_id == null ? null : sha256(String(session.rotation_id)),
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value != null));
}

function parseStoredSessionSummary(current) {
  if (!current?.session_summary) return {};
  try {
    const parsed = JSON.parse(current.session_summary);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('expected an object');
    }
    return parsed;
  } catch (error) {
    throw providerError(
      'PROVIDER_SESSION_CORRUPT',
      `Provider session ${current.id} summary is invalid`,
      { cause: error },
    );
  }
}

function sessionMatchesPersistedRow(session, row) {
  if (!session || !row) return false;
  return canonicalStringify(safeSummary(session) ?? {})
    === canonicalStringify(parseStoredSessionSummary(row));
}

function pendingResolutionsFor(db) {
  let pending = pendingColdSessionResolutions.get(db);
  if (!pending) {
    pending = new Map();
    pendingColdSessionResolutions.set(db, pending);
  }
  return pending;
}

function cacheKey(provider, request, artifactDigest) {
  if (typeof artifactDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(artifactDigest)) {
    throw providerError(
      'PROVIDER_SESSION_ARTIFACT_REQUIRED',
      'Provider sessions require an exact handoff artifact digest',
    );
  }
  return sha256(canonicalStringify({
    handoff_artifact_digest: artifactDigest,
    provider_type: provider.type,
    provider_name: provider.name,
    subject: request.subject ?? null,
    principal: request.principal ?? null,
    scope: request.scope ?? null,
    audience: request.audience ?? null,
    resource: request.resource ?? null,
    provider_config_hash: request.provider_config_hash ?? null,
    inputs_hash: request.inputs_hash ?? null,
  }));
}

function sessionRow(db, provider, key) {
  return db.prepare(`
    SELECT * FROM provider_sessions
    WHERE provider_type = ? AND provider_name = ? AND cache_key_hash = ?
  `).get(provider.type, provider.name, key);
}

function persistResolvedSession(
  db,
  provider,
  key,
  resolved,
  artifactDigest,
  current = null,
  opts = {},
) {
  const session = resolved.session ?? resolved;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw providerError('PROVIDER_SESSION_INVALID', `Provider ${provider.name} returned no session`);
  }
  const id = current?.id ?? randomUUID();
  const summary = safeSummary(session);
  const expiresAt = sqliteTimestamp(resolved.expires_at ?? session.expires_at ?? null);
  if (expiresAt && isPast(expiresAt, contextNowMs(opts.now))) {
    throw providerError(
      'PROVIDER_SESSION_EXPIRED',
      `Provider ${provider.name} returned an already-expired session`,
    );
  }
  const refreshAfter = sqliteTimestamp(resolved.refresh_after ?? session.refresh_after ?? null);
  const nextRotationHash = resolved.rotation_id == null
    ? summary?.rotation_id_hash ?? null
    : sha256(String(resolved.rotation_id));
  const currentSummary = parseStoredSessionSummary(current);
  const rotationChanged = current && nextRotationHash != null
    && nextRotationHash !== currentSummary.rotation_id_hash;
  const rotationCounter = (current?.rotation_counter ?? 0) + (rotationChanged ? 1 : 0);

  const conflictAction = opts.insertOnly
    ? 'DO NOTHING'
    : `DO UPDATE SET
      status = 'active',
      handoff_artifact_digest = excluded.handoff_artifact_digest,
      subject_principal = excluded.subject_principal,
      scope = excluded.scope,
      session_summary = excluded.session_summary,
      expires_at = excluded.expires_at,
      refresh_after = excluded.refresh_after,
      rotation_counter = excluded.rotation_counter,
      transient_error_count = 0,
      last_error = NULL,
      updated_at = datetime('now')`;
  const write = db.prepare(`
    INSERT INTO provider_sessions (
      id, provider_type, provider_name, cache_key_hash, status,
      handoff_artifact_digest, subject_principal, scope, session_summary,
      expires_at, refresh_after, rotation_counter, revocation_checked_at,
      transient_error_count, last_error, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, datetime('now'))
    ON CONFLICT(provider_type, provider_name, cache_key_hash) ${conflictAction}
  `).run(
    id,
    provider.type,
    provider.name,
    key,
    artifactDigest ?? null,
    session.subject?.principal ?? session.principal ?? null,
    Array.isArray(session.scope) ? JSON.stringify(session.scope) : (session.scope ?? null),
    JSON.stringify(summary),
    expiresAt,
    refreshAfter,
    rotationCounter,
  );
  const persisted = sessionRow(db, provider, key);
  if (!persisted) {
    throw providerError(
      'PROVIDER_SESSION_PERSIST_FAILED',
      `Provider session ${provider.name} was not retrievable after persistence`,
    );
  }
  if (opts.insertOnly && write.changes !== 1) {
    const winnerSession = memorySessions.get(persisted.id);
    if (winnerSession && sessionMatchesPersistedRow(winnerSession, persisted)) return persisted;
    const error = providerError(
      'PROVIDER_SESSION_CONFLICT',
      `Provider session ${provider.name} was resolved concurrently`,
      { transient: true },
    );
    error.persistedRow = persisted;
    throw error;
  }
  if (persisted.id !== id) memorySessions.delete(id);
  memorySessions.set(persisted.id, session);
  return persisted;
}

async function callProvider(method, provider, ...args) {
  try {
    const result = await provider[method](...args);
    if (result?.ok === false) {
      throw providerError(
        result.code || 'PROVIDER_SESSION_FAILED',
        result.error || result.reason || `Provider ${provider.name} ${method} failed`,
        { transient: result.transient === true },
      );
    }
    return result;
  } catch (error) {
    if (error?.code && typeof error.transient === 'boolean') throw error;
    throw providerError(
      'PROVIDER_SESSION_FAILED',
      `Provider ${provider.name} ${method} failed: ${error.message}`,
      { transient: error.transient === true, cause: error },
    );
  }
}

async function resolveColdProviderSession(
  db,
  provider,
  request,
  ctx,
  key,
  startNow,
  explicitNow,
) {
  const resolved = await callProvider('resolveSession', provider, request, ctx);
  try {
    const row = persistResolvedSession(
      db,
      provider,
      key,
      resolved,
      ctx.artifactDigest,
      null,
      { now: completionNowMs(explicitNow, startNow), insertOnly: true },
    );
    return { row, session: memorySessions.get(row.id) };
  } catch (error) {
    if (error?.code !== 'PROVIDER_SESSION_CONFLICT') throw error;
    const row = error.persistedRow || sessionRow(db, provider, key);
    if (!row) {
      throw providerError(
        'PROVIDER_SESSION_PERSIST_FAILED',
        `Concurrent provider session ${provider.name} was not retrievable`,
        { cause: error },
      );
    }
    let session = memorySessions.get(row.id);
    if (!session && typeof provider.resumeSession === 'function') {
      const resumed = await callProvider('resumeSession', provider, row, { ...ctx, request });
      session = resumed?.session ?? resumed ?? null;
    }
    if (!session || !sessionMatchesPersistedRow(session, row)) {
      memorySessions.delete(row.id);
      throw providerError(
        'PROVIDER_SESSION_CONFLICT',
        `Provider ${provider.name} cannot resume the persisted concurrent session winner`,
        { transient: true, cause: error },
      );
    }
    memorySessions.set(row.id, session);
    return { row, session };
  }
}

export async function resolveProviderSession(provider, request = {}, ctx = {}, opts = {}) {
  if (!provider || typeof provider.name !== 'string' || typeof provider.type !== 'string') {
    throw new TypeError('provider with name and type is required');
  }
  if (typeof provider.resolveSession !== 'function') {
    throw providerError(
      'PROVIDER_SESSION_UNSUPPORTED',
      `Provider ${provider.name} does not implement resolveSession()`,
    );
  }
  const db = opts.db || getDb();
  const key = cacheKey(provider, request, ctx.artifactDigest);
  let row = sessionRow(db, provider, key);
  const explicitNow = ctx.now !== undefined;
  const now = contextNowMs(ctx.now);
  const maxTransientErrors = Number.isInteger(opts.maxTransientErrors) && opts.maxTransientErrors > 0
    ? opts.maxTransientErrors
    : DEFAULT_MAX_TRANSIENT_ERRORS;
  const refreshClaimTimeoutMs = Number.isInteger(opts.refreshClaimTimeoutMs) && opts.refreshClaimTimeoutMs > 0
    ? opts.refreshClaimTimeoutMs
    : DEFAULT_REFRESH_CLAIM_TIMEOUT_MS;

  if (row?.status === 'refreshing') {
    const updatedAt = Date.parse(`${row.updated_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(updatedAt) && now - updatedAt >= refreshClaimTimeoutMs) {
      db.prepare(`
        UPDATE provider_sessions SET status = 'expired', last_error = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'refreshing'
      `).run('Recovered stale provider refresh claim', row.id);
      row = sessionRow(db, provider, key);
    } else {
      throw providerError('PROVIDER_SESSION_BUSY', 'Provider session refresh is already owned', {
        transient: true,
      });
    }
  }

  if (row && TERMINAL_STATUSES.has(row.status)) {
    throw providerError(
      row.status === 'revoked' ? 'PROVIDER_SESSION_REVOKED' : 'PROVIDER_SESSION_FAILED',
      row.last_error || `Provider session is ${row.status}`,
    );
  }

  let rawSession = row ? memorySessions.get(row.id) : null;
  const mustRefresh = row && (row.status === 'expired' || isPast(row.expires_at, now) || isPast(row.refresh_after, now));
  if (row
    && !rawSession
    && typeof provider.resumeSession === 'function'
    && (!mustRefresh || typeof provider.refreshSession === 'function')) {
    const resumed = await callProvider('resumeSession', provider, row, { ...ctx, request });
    rawSession = resumed?.session ?? resumed ?? null;
    if (rawSession) memorySessions.set(row.id, rawSession);
  }

  if (row && mustRefresh) {
    const canRefresh = typeof provider.refreshSession === 'function';
    const claimed = db.prepare(`
      UPDATE provider_sessions
      SET status = 'refreshing', updated_at = datetime('now')
      WHERE id = ? AND status IN ('active','expired')
    `).run(row.id);
    if (claimed.changes !== 1) {
      throw providerError('PROVIDER_SESSION_BUSY', 'Provider session refresh is already owned', {
        transient: true,
      });
    }
    try {
      const refreshed = canRefresh
        ? await callProvider(
            'refreshSession',
            provider,
            rawSession ?? row,
            { ...ctx, request },
          )
        : await callProvider('resolveSession', provider, request, ctx);
      row = persistResolvedSession(
        db,
        provider,
        key,
        refreshed,
        ctx.artifactDigest,
        row,
        { now: completionNowMs(explicitNow, now) },
      );
      rawSession = memorySessions.get(row.id);
      appendRuntimeEvent(canRefresh ? 'provider.session.refreshed' : 'provider.session.reresolved', {
        jobId: ctx.jobId,
        runId: ctx.runId,
        handoffArtifactDigest: ctx.artifactDigest,
        payload: { provider: provider.name, session_id: row.id, rotation_counter: row.rotation_counter },
      }, { db });
    } catch (error) {
      const nextTransientErrors = (row.transient_error_count ?? 0) + (error.transient ? 1 : 0);
      const exhausted = error.transient && nextTransientErrors >= maxTransientErrors;
      db.prepare(`
        UPDATE provider_sessions
        SET status = ?, transient_error_count = ?,
            last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(error.transient && !exhausted ? 'expired' : 'failed', nextTransientErrors, error.message, row.id);
      if (exhausted) {
        throw providerError(
          'PROVIDER_SESSION_RETRY_EXHAUSTED',
          `Provider session ${canRefresh ? 'refresh' : 're-resolution'} exhausted ${maxTransientErrors} transient attempt(s)`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (!row || !rawSession) {
    if (!row) {
      const pending = pendingResolutionsFor(db);
      let resolution = pending.get(key);
      const ownsResolution = !resolution;
      if (!resolution) {
        resolution = resolveColdProviderSession(
          db,
          provider,
          request,
          ctx,
          key,
          now,
          explicitNow,
        );
        pending.set(key, resolution);
      }
      try {
        ({ row, session: rawSession } = await resolution);
      } finally {
        if (ownsResolution && pending.get(key) === resolution) pending.delete(key);
      }
    } else {
      const resolved = await callProvider('resolveSession', provider, request, ctx);
      row = persistResolvedSession(
        db,
        provider,
        key,
        resolved,
        ctx.artifactDigest,
        row,
        { now: completionNowMs(explicitNow, now) },
      );
      rawSession = memorySessions.get(row.id);
    }
    appendRuntimeEvent('provider.session.resolved', {
      jobId: ctx.jobId,
      runId: ctx.runId,
      handoffArtifactDigest: ctx.artifactDigest,
      payload: { provider: provider.name, session_id: row.id },
    }, { db });
  }

  if (typeof provider.checkRevocation !== 'function') {
    throw providerError(
      'PROVIDER_REVOCATION_UNSUPPORTED',
      `Provider ${provider.name} does not implement checkRevocation()`,
    );
  }
  const revocation = await callProvider('checkRevocation', provider, rawSession, ctx);
  if (revocation === true || revocation?.revoked === true) {
    const reason = revocation?.reason || 'Provider session was revoked';
    db.prepare(`
      UPDATE provider_sessions
      SET status = 'revoked', last_error = ?, revocation_checked_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, row.id);
    memorySessions.delete(row.id);
    throw providerError('PROVIDER_SESSION_REVOKED', reason);
  }
  if (revocation !== false && revocation?.revoked !== false) {
    throw providerError(
      'PROVIDER_SESSION_REVOCATION_INDETERMINATE',
      `Provider ${provider.name} did not explicitly confirm that the session is not revoked`,
      { transient: true },
    );
  }
  db.prepare(`
    UPDATE provider_sessions
    SET revocation_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(row.id);

  return {
    row: db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(row.id),
    session: rawSession,
    cache_key_hash: key,
  };
}

export function getProviderSession(id, opts = {}) {
  const db = opts.db || getDb();
  return db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(id) || null;
}

export async function resumeProviderSession(provider, id, ctx = {}, opts = {}) {
  const db = opts.db || getDb();
  let row = getProviderSession(id, { db });
  if (!row) throw providerError('PROVIDER_SESSION_NOT_FOUND', `Provider session ${id} not found`);
  if (!provider || provider.name !== row.provider_name || provider.type !== row.provider_type) {
    throw providerError(
      'PROVIDER_SESSION_MISMATCH',
      `Provider session ${id} does not belong to ${provider?.type || '(unknown)'}/${provider?.name || '(unknown)'}`,
    );
  }
  if (ctx.artifactDigest != null && ctx.artifactDigest !== row.handoff_artifact_digest) {
    throw providerError(
      'PROVIDER_SESSION_ARTIFACT_MISMATCH',
      `Provider session ${id} does not belong to the requested handoff artifact`,
    );
  }
  const explicitNow = ctx.now !== undefined;
  const now = contextNowMs(ctx.now);
  const maxTransientErrors = Number.isInteger(opts.maxTransientErrors) && opts.maxTransientErrors > 0
    ? opts.maxTransientErrors
    : DEFAULT_MAX_TRANSIENT_ERRORS;
  const refreshClaimTimeoutMs = Number.isInteger(opts.refreshClaimTimeoutMs) && opts.refreshClaimTimeoutMs > 0
    ? opts.refreshClaimTimeoutMs
    : DEFAULT_REFRESH_CLAIM_TIMEOUT_MS;

  if (row.status === 'refreshing') {
    const updatedAt = Date.parse(`${row.updated_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(updatedAt) && now - updatedAt >= refreshClaimTimeoutMs) {
      db.prepare(`
        UPDATE provider_sessions SET status = 'expired', last_error = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'refreshing'
      `).run('Recovered stale provider refresh claim', row.id);
      row = getProviderSession(id, { db });
    } else {
      throw providerError('PROVIDER_SESSION_BUSY', 'Provider session refresh is already owned', {
        transient: true,
      });
    }
  }
  if (TERMINAL_STATUSES.has(row.status)) {
    throw providerError(
      row.status === 'revoked' ? 'PROVIDER_SESSION_REVOKED' : 'PROVIDER_SESSION_FAILED',
      row.last_error || `Provider session ${id} is ${row.status}`,
    );
  }
  let session = memorySessions.get(id);
  if (!session && typeof provider.resumeSession === 'function') {
    const resumed = await callProvider('resumeSession', provider, row, ctx);
    session = resumed?.session ?? resumed;
    if (session) memorySessions.set(id, session);
  }

  const mustRefresh = row.status === 'expired'
    || isPast(row.expires_at, now)
    || isPast(row.refresh_after, now);
  if (mustRefresh) {
    if (typeof provider.refreshSession !== 'function') {
      const reason = 'Session expired or reached refresh_after and provider does not implement refreshSession()';
      db.prepare(`
        UPDATE provider_sessions
        SET status = 'expired', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(reason, id);
      memorySessions.delete(id);
      throw providerError(
        'PROVIDER_SESSION_EXPIRED',
        `Provider session ${id} expired and cannot be refreshed`,
      );
    }
    const claimed = db.prepare(`
      UPDATE provider_sessions
      SET status = 'refreshing', updated_at = datetime('now')
      WHERE id = ? AND status IN ('active','expired')
    `).run(id);
    if (claimed.changes !== 1) {
      throw providerError('PROVIDER_SESSION_BUSY', 'Provider session refresh is already owned', {
        transient: true,
      });
    }
    try {
      const refreshed = await callProvider('refreshSession', provider, session ?? row, ctx);
      row = persistResolvedSession(
        db,
        provider,
        row.cache_key_hash,
        refreshed,
        row.handoff_artifact_digest,
        row,
        { now: completionNowMs(explicitNow, now) },
      );
      session = memorySessions.get(id);
      appendRuntimeEvent('provider.session.refreshed', {
        jobId: ctx.jobId,
        runId: ctx.runId,
        handoffArtifactDigest: row.handoff_artifact_digest,
        payload: { provider: provider.name, session_id: id, rotation_counter: row.rotation_counter },
      }, { db });
    } catch (error) {
      const nextTransientErrors = (row.transient_error_count ?? 0) + (error.transient ? 1 : 0);
      const exhausted = error.transient && nextTransientErrors >= maxTransientErrors;
      db.prepare(`
        UPDATE provider_sessions
        SET status = ?, transient_error_count = ?, last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(error.transient && !exhausted ? 'expired' : 'failed', nextTransientErrors, error.message, id);
      memorySessions.delete(id);
      if (exhausted) {
        throw providerError(
          'PROVIDER_SESSION_RETRY_EXHAUSTED',
          `Provider session refresh exhausted ${maxTransientErrors} transient attempt(s)`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (!session) {
    throw providerError(
      'PROVIDER_SESSION_RESUME_UNSUPPORTED',
      `Provider ${provider.name} cannot resume session ${id}`,
    );
  }
  if (typeof provider.checkRevocation !== 'function') {
    throw providerError(
      'PROVIDER_REVOCATION_UNSUPPORTED',
      `Provider ${provider.name} does not implement checkRevocation()`,
    );
  }
  const revocation = await callProvider('checkRevocation', provider, session, ctx);
  if (revocation === true || revocation?.revoked === true) {
    const reason = revocation?.reason || 'Provider session was revoked';
    db.prepare(`
      UPDATE provider_sessions
      SET status = 'revoked', last_error = ?, revocation_checked_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason, id);
    memorySessions.delete(id);
    throw providerError('PROVIDER_SESSION_REVOKED', reason);
  }
  if (revocation !== false && revocation?.revoked !== false) {
    throw providerError(
      'PROVIDER_SESSION_REVOCATION_INDETERMINATE',
      `Provider ${provider.name} did not explicitly confirm that the session is not revoked`,
      { transient: true },
    );
  }
  db.prepare(`
    UPDATE provider_sessions
    SET revocation_checked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return { row: getProviderSession(id, { db }), session };
}

export function adoptProviderSession(provider, request, resolved, ctx = {}, opts = {}) {
  const db = opts.db || getDb();
  const key = cacheKey(provider, request, ctx.artifactDigest);
  const current = sessionRow(db, provider, key);
  const row = persistResolvedSession(
    db,
    provider,
    key,
    resolved,
    ctx.artifactDigest,
    current,
    { now: contextNowMs(ctx.now) },
  );
  appendRuntimeEvent('provider.session.adopted', {
    jobId: ctx.jobId,
    runId: ctx.runId,
    handoffArtifactDigest: ctx.artifactDigest,
    payload: { provider: provider.name, session_id: row.id },
  }, { db });
  return { row, session: memorySessions.get(row.id), cache_key_hash: key };
}

export function listProviderSessions(filter = {}, opts = {}) {
  const db = opts.db || getDb();
  if (filter.status) {
    return db.prepare(`
      SELECT * FROM provider_sessions WHERE status = ? ORDER BY updated_at DESC
    `).all(filter.status);
  }
  return db.prepare('SELECT * FROM provider_sessions ORDER BY updated_at DESC').all();
}

export async function cleanupProviderSession(provider, id, ctx = {}, opts = {}) {
  const db = opts.db || getDb();
  const row = getProviderSession(id, { db });
  if (!row) return { ok: true, missing: true };
  const session = memorySessions.get(id) ?? row;
  if (typeof provider?.cleanupSession === 'function') {
    await callProvider('cleanupSession', provider, session, ctx);
  }
  memorySessions.delete(id);
  return { ok: true };
}

export function _resetProviderSessionMemoryForTesting() {
  memorySessions.clear();
  pendingColdSessionResolutions = new WeakMap();
}
