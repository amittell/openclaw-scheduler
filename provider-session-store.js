import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { canonicalStringify, sha256 } from './handoff-artifact.js';
import { appendRuntimeEvent } from './runtime-events.js';

const memorySessions = new Map();
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

function persistResolvedSession(db, provider, key, resolved, artifactDigest, current = null) {
  const session = resolved.session ?? resolved;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw providerError('PROVIDER_SESSION_INVALID', `Provider ${provider.name} returned no session`);
  }
  const id = current?.id ?? randomUUID();
  const summary = safeSummary(session);
  const expiresAt = sqliteTimestamp(resolved.expires_at ?? session.expires_at ?? null);
  const refreshAfter = sqliteTimestamp(resolved.refresh_after ?? session.refresh_after ?? null);
  const nextRotationHash = resolved.rotation_id == null
    ? summary?.rotation_id_hash ?? null
    : sha256(String(resolved.rotation_id));
  const rotationChanged = current && nextRotationHash != null
    && nextRotationHash !== JSON.parse(current.session_summary || '{}').rotation_id_hash;
  const rotationCounter = (current?.rotation_counter ?? 0) + (rotationChanged ? 1 : 0);

  db.prepare(`
    INSERT INTO provider_sessions (
      id, provider_type, provider_name, cache_key_hash, status,
      handoff_artifact_digest, subject_principal, scope, session_summary,
      expires_at, refresh_after, rotation_counter, revocation_checked_at,
      transient_error_count, last_error, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, datetime('now'))
    ON CONFLICT(provider_type, provider_name, cache_key_hash) DO UPDATE SET
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
      updated_at = datetime('now')
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
  memorySessions.set(id, session);
  return db.prepare('SELECT * FROM provider_sessions WHERE id = ?').get(id);
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
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
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
  if (row && !rawSession && typeof provider.resumeSession === 'function') {
    const resumed = await callProvider('resumeSession', provider, row, { ...ctx, request });
    rawSession = resumed?.session ?? resumed ?? null;
    if (rawSession) memorySessions.set(row.id, rawSession);
  }

  if (row && mustRefresh) {
    if (typeof provider.refreshSession !== 'function') {
      db.prepare(`
        UPDATE provider_sessions
        SET status = 'expired', last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run('Session expired and provider does not implement refreshSession()', row.id);
      throw providerError(
        'PROVIDER_SESSION_EXPIRED',
        `Provider session ${row.id} expired and cannot be refreshed`,
      );
    }

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
      const refreshed = await callProvider(
        'refreshSession',
        provider,
        rawSession ?? row,
        { ...ctx, request },
      );
      row = persistResolvedSession(
        db,
        provider,
        key,
        refreshed,
        ctx.artifactDigest,
        row,
      );
      rawSession = memorySessions.get(row.id);
      appendRuntimeEvent('provider.session.refreshed', {
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
          `Provider session refresh exhausted ${maxTransientErrors} transient attempt(s)`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (!row || !rawSession) {
    const resolved = await callProvider('resolveSession', provider, request, ctx);
    row = persistResolvedSession(db, provider, key, resolved, ctx.artifactDigest, row);
    rawSession = memorySessions.get(row.id);
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
  const row = getProviderSession(id, { db });
  if (!row) throw providerError('PROVIDER_SESSION_NOT_FOUND', `Provider session ${id} not found`);
  if (TERMINAL_STATUSES.has(row.status) || row.status === 'expired') {
    throw providerError(
      row.status === 'revoked' ? 'PROVIDER_SESSION_REVOKED' : 'PROVIDER_SESSION_EXPIRED',
      row.last_error || `Provider session ${id} is ${row.status}`,
    );
  }
  let session = memorySessions.get(id);
  if (!session) {
    if (typeof provider?.resumeSession !== 'function') {
      throw providerError(
        'PROVIDER_SESSION_RESUME_UNSUPPORTED',
        `Provider ${provider?.name || '(unknown)'} cannot resume session ${id}`,
      );
    }
    const resumed = await callProvider('resumeSession', provider, row, ctx);
    session = resumed?.session ?? resumed;
    if (!session) throw providerError('PROVIDER_SESSION_INVALID', 'Provider resumed no session');
    memorySessions.set(id, session);
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
}
