import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getDb } from './db.js';
import { getProofVerifier } from './provider-registry.js';
import { appendRuntimeEvent } from './runtime-events.js';

const MAX_PROOF_BYTES = 1024 * 1024;
let agentcliPromise = null;

function proofError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function parseProfile(job) {
  if (!job.authorization_proof) {
    throw proofError('AUTHORIZATION_PROOF_REQUIRED', 'Handoff v4 proof declaration is missing');
  }
  try {
    const profile = typeof job.authorization_proof === 'string'
      ? JSON.parse(job.authorization_proof)
      : job.authorization_proof;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new TypeError('expected an object');
    }
    return profile;
  } catch (error) {
    throw proofError(
      'AUTHORIZATION_PROOF_INVALID',
      'Authorization proof is invalid: ' + error.message,
    );
  }
}

function resolveProofValue(profile, opts = {}) {
  const valueFrom = profile.proof?.value_from;
  if (!valueFrom || typeof valueFrom !== 'object' || Array.isArray(valueFrom)) {
    throw proofError(
      'AUTHORIZATION_PROOF_SOURCE_REQUIRED',
      'Handoff v4 proof requires proof.value_from.env or proof.value_from.file',
    );
  }
  const keys = Object.keys(valueFrom).filter(key => valueFrom[key] != null);
  if (keys.length !== 1 || !['env', 'file'].includes(keys[0])) {
    throw proofError(
      'AUTHORIZATION_PROOF_SOURCE_UNSAFE',
      'Handoff v4 proof sources are limited to exactly one env or file reference',
    );
  }
  if (keys[0] === 'env') {
    const name = valueFrom.env;
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw proofError('AUTHORIZATION_PROOF_SOURCE_INVALID', 'Proof environment variable name is invalid');
    }
    const value = (opts.env || process.env)[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw proofError(
        'AUTHORIZATION_PROOF_SOURCE_MISSING',
        'Proof environment variable ' + name + ' is empty',
      );
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_PROOF_BYTES) {
      throw proofError('AUTHORIZATION_PROOF_TOO_LARGE', 'Authorization proof exceeds 1 MiB');
    }
    return value;
  }

  const configured = valueFrom.file;
  if (typeof configured !== 'string' || configured.length === 0 || configured.includes('\0')) {
    throw proofError('AUTHORIZATION_PROOF_SOURCE_INVALID', 'Proof file path is invalid');
  }
  const path = isAbsolute(configured) ? configured : resolve(opts.cwd || process.cwd(), configured);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw proofError('AUTHORIZATION_PROOF_SOURCE_UNSAFE', 'Proof file must be a regular non-symlink file');
  }
  if (stat.size > MAX_PROOF_BYTES) {
    throw proofError('AUTHORIZATION_PROOF_TOO_LARGE', 'Authorization proof exceeds 1 MiB');
  }
  const canonicalPath = realpathSync(path);
  if (!lstatSync(canonicalPath).isFile()) {
    throw proofError('AUTHORIZATION_PROOF_SOURCE_UNSAFE', 'Proof path does not resolve to a regular file');
  }
  return readFileSync(canonicalPath, 'utf8');
}

async function loadAgentcli(opts = {}) {
  if (opts.agentcli) return opts.agentcli;
  if (!agentcliPromise) {
    agentcliPromise = Promise.all([
      import('@amittell/agentcli/authorization-proof'),
      import('@amittell/agentcli/authorization-proof/jwt'),
      import('@amittell/agentcli/authorization-proof/detached-signature'),
      import('@amittell/agentcli/authorization-proof/certificate'),
    ]).then(([api]) => api).catch(error => {
      agentcliPromise = null;
      throw proofError(
        'AGENTCLI_RUNTIME_UNAVAILABLE',
        'Handoff v4 proof verification requires @amittell/agentcli: ' + error.message,
      );
    });
  }
  return agentcliPromise;
}

function sqliteTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw proofError('AUTHORIZATION_PROOF_INVALID', 'Proof replay expiration is invalid');
  }
  return new Date(parsed).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function replayKey(input) {
  return createHash('sha256').update(JSON.stringify([
    input.method,
    input.issuer ?? null,
    input.subject ?? null,
    input.proofId,
  ])).digest('hex');
}

export function claimProofReplay(db, input) {
  if (!input?.proofId || !input?.artifactDigest || !input?.runId || !input?.expiresAt) {
    return { claimed: false, reason: 'proof replay claim is missing required bindings' };
  }
  const key = replayKey(input);
  const expiresAt = sqliteTimestamp(input.expiresAt);
  const claim = db.transaction(() => {
    db.prepare("DELETE FROM proof_replay_ledger WHERE expires_at <= datetime('now')").run();
    const result = db.prepare(
      'INSERT INTO proof_replay_ledger '
      + '(replay_key, method, issuer, subject, proof_id, '
      + 'handoff_artifact_digest, run_id, expires_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(replay_key) DO NOTHING',
    ).run(
      key,
      input.method,
      input.issuer ?? null,
      input.subject ?? null,
      input.proofId,
      input.artifactDigest,
      input.runId,
      expiresAt,
    );
    return result.changes === 1;
  }).immediate();
  if (claim) return { claimed: true };
  const existing = db.prepare(
    'SELECT handoff_artifact_digest, run_id FROM proof_replay_ledger WHERE replay_key = ?',
  ).get(key);
  return {
    claimed: false,
    reason: existing?.handoff_artifact_digest !== input.artifactDigest
      ? 'authorization proof replay identifier is already bound to a different artifact'
      : 'authorization proof replay identifier was already used',
    existingArtifactDigest: existing?.handoff_artifact_digest ?? null,
    existingRunId: existing?.run_id ?? null,
  };
}

function checkLocalRevocation(db, input) {
  const row = db.prepare(
    'SELECT reason FROM proof_revocations '
      + 'WHERE method = ? AND (issuer IS NULL OR issuer = ?) '
      + 'AND ((proof_id IS NOT NULL AND proof_id = ?) '
      + 'OR (key_id IS NOT NULL AND key_id = ?)) '
      + 'ORDER BY revoked_at DESC LIMIT 1',
  ).get(
    input.method,
    input.issuer ?? null,
    input.proofId ?? null,
    input.keyId ?? null,
  );
  return row
    ? { revoked: true, reason: row.reason || 'proof or verification key is revoked' }
    : { revoked: false };
}

function revocationChecker(db, profile, opts) {
  const providerName = profile.verifier || profile.provider || null;
  const provider = providerName ? getProofVerifier(providerName) : null;
  return input => {
    const local = checkLocalRevocation(db, input);
    if (local.revoked) return local;
    if (provider && typeof provider.checkRevocation === 'function') {
      const result = provider.checkRevocation(input);
      if (result && typeof result.then === 'function') {
        return { revoked: true, reason: 'proof revocation provider must complete synchronously' };
      }
      return result ?? { revoked: false };
    }
    if (typeof opts.checkProofRevocation === 'function') {
      return opts.checkProofRevocation(input);
    }
    return { revoked: false, source: 'local-revocation-ledger' };
  };
}

function temporalError(message) {
  return proofError('AUTHORIZATION_PROOF_VALIDITY_INVALID', message);
}

function validDateMs(value, label) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw temporalError(`Authorization proof ${label} is invalid`);
  try {
    new Date(parsed).toISOString();
  } catch {
    throw temporalError(`Authorization proof ${label} is outside the supported date range`);
  }
  return parsed;
}

function normalizedClockSkewSeconds(value) {
  const input = value ?? 60;
  const skew = (
    (typeof input === 'number' || typeof input === 'string')
    && !(typeof input === 'string' && input.trim() === '')
  ) ? Number(input) : Number.NaN;
  if (!Number.isFinite(skew) || skew < 0 || !Number.isFinite(skew * 1000)) {
    throw temporalError('Authorization proof clock skew must be a finite non-negative number');
  }
  return skew;
}

function normalizedNowMs(value) {
  const now = value === undefined
    ? Date.now()
    : value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Number.NaN;
  return validDateMs(now, 'verification time');
}

function parseProofEnvelope(proof, method) {
  try {
    if (method === 'jwt') {
      const parts = String(proof).trim().split('.');
      if (parts.length !== 3) throw new TypeError('JWT must have three parts');
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    }
    const parsed = typeof proof === 'string' ? JSON.parse(proof) : proof;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('proof envelope must be an object');
    }
    return parsed;
  } catch (error) {
    throw temporalError(`Verified ${method} proof validity envelope is invalid: ${error.message}`);
  }
}

function verifiedProofTemporalWindow(method, proof, result, clockSkewSeconds) {
  const parsed = parseProofEnvelope(proof, method);
  let validFrom;
  let validUntil;
  if (method === 'jwt') {
    if (typeof parsed.iat !== 'number' || typeof parsed.exp !== 'number') {
      throw temporalError('Verified JWT is missing numeric iat or exp validity claims');
    }
    const validFromSeconds = parsed.nbf == null
      ? parsed.iat
      : Math.max(parsed.iat, parsed.nbf);
    validFrom = validDateMs(validFromSeconds * 1000, 'valid-from claim');
    validUntil = validDateMs(parsed.exp * 1000, 'expiration claim');
  } else if (method === 'detached-signature' || method === 'certificate') {
    validFrom = validDateMs(parsed.issued_at, 'issued_at');
    validUntil = validDateMs(parsed.expires_at, 'expires_at');
    if (method === 'certificate') {
      validFrom = Math.max(validFrom, validDateMs(result.not_before, 'certificate not_before'));
      validUntil = Math.min(validUntil, validDateMs(result.not_after, 'certificate not_after'));
    }
  } else {
    throw temporalError(`Unsupported reusable authorization proof method: ${method}`);
  }
  if (validUntil <= validFrom) {
    throw temporalError('Authorization proof validity window is empty or reversed');
  }
  return {
    proof_valid_from: new Date(validFrom).toISOString(),
    proof_valid_until: new Date(validUntil).toISOString(),
    proof_clock_skew_seconds: normalizedClockSkewSeconds(clockSkewSeconds),
  };
}

function assertReusableProofTemporalWindow(result, opts = {}) {
  const validFrom = validDateMs(result?.proof_valid_from, 'stored valid-from claim');
  const validUntil = validDateMs(result?.proof_valid_until, 'stored expiration claim');
  if (validUntil <= validFrom) {
    throw temporalError('Stored authorization proof validity window is empty or reversed');
  }
  if (!Object.hasOwn(result, 'proof_clock_skew_seconds')) {
    throw temporalError('Stored authorization proof clock skew is missing');
  }
  const skewMs = normalizedClockSkewSeconds(result.proof_clock_skew_seconds) * 1000;
  const now = normalizedNowMs(opts.now);
  if (now + skewMs < validFrom) {
    throw proofError('AUTHORIZATION_PROOF_NOT_YET_VALID', 'Authorization proof is not yet valid after approval');
  }
  if (now >= validUntil + skewMs) {
    throw proofError('AUTHORIZATION_PROOF_EXPIRED', 'Authorization proof expired while awaiting approval');
  }
}

function auditResult(result, temporalWindow = null) {
  const allowed = {};
  for (const key of [
    'verified', 'method', 'reason', 'claims_validated', 'signature_verified',
    'manifest_bound', 'artifact_bound', 'replay_protected', 'revocation_checked',
    'issuer', 'subject', 'key_id', 'proof_id', 'verified_at',
    'proof_valid_from', 'proof_valid_until', 'proof_clock_skew_seconds',
  ]) {
    if (result?.[key] != null) allowed[key] = result[key];
  }
  if (temporalWindow) Object.assign(allowed, temporalWindow);
  return allowed;
}

async function reuseVerifiedProof(job, declaration, profile, run, opts, db, eventBinding) {
  const result = opts.reuseVerification;
  const priorRun = opts.priorRun;
  appendRuntimeEvent('proof.revalidating', {
    ...eventBinding,
    payload: {
      method: declaration.method,
      prior_run_id: priorRun?.id ?? null,
      approval_id: opts.approvalId ?? null,
    },
  }, { db });

  if (!priorRun
    || priorRun.job_id !== job.id
    || priorRun.handoff_artifact_digest !== job.handoff_artifact_digest) {
    throw proofError(
      'AUTHORIZATION_PROOF_REUSE_MISMATCH',
      'Approved proof verification is not bound to this job and handoff artifact',
    );
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw proofError(
      'AUTHORIZATION_PROOF_REUSE_INVALID',
      'Approved run does not contain a reusable proof verification result',
    );
  }
  if (result.method !== declaration.method
    || result.method !== profile.method
    || result.verified !== true
    || result.artifact_bound !== true
    || result.replay_protected !== true
    || result.revocation_checked !== true
    || result.signature_verified !== true) {
    throw proofError(
      'AUTHORIZATION_PROOF_REUSE_INVALID',
      'Approved proof verification did not satisfy every v4 runtime guard',
      { result: auditResult(result) },
    );
  }
  if (!result.proof_id && !result.key_id) {
    throw proofError(
      'AUTHORIZATION_PROOF_REUSE_INVALID',
      'Approved proof verification has no replay or verification-key identifier',
    );
  }
  assertReusableProofTemporalWindow(result, opts);

  const revocation = await revocationChecker(db, profile, opts)({
    method: result.method,
    issuer: result.issuer ?? null,
    subject: result.subject ?? null,
    proofId: result.proof_id ?? null,
    keyId: result.key_id ?? null,
    artifactDigest: job.handoff_artifact_digest,
    runId: run.id,
    priorRunId: priorRun.id,
  });
  if (revocation === true || revocation?.revoked === true) {
    throw proofError(
      'AUTHORIZATION_PROOF_REVOKED',
      revocation?.reason || 'Authorization proof or verification key was revoked while awaiting approval',
    );
  }
  if (revocation !== false && revocation?.revoked !== false) {
    throw proofError(
      'AUTHORIZATION_PROOF_REVOCATION_INDETERMINATE',
      'Authorization proof revocation could not be rechecked after approval',
    );
  }

  const audited = auditResult(result);
  appendRuntimeEvent('proof.reused', {
    ...eventBinding,
    payload: {
      ...audited,
      prior_run_id: priorRun.id,
      approval_id: opts.approvalId ?? null,
    },
  }, { db });
  return audited;
}

export async function verifyArtifactBoundProof(job, artifactRecord, run, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  const artifact = artifactRecord?.payload ? artifactRecord.payload : artifactRecord;
  const declaration = artifact?.authorization_proof ?? {};
  if (!declaration.method || declaration.method === 'none') {
    if (declaration.artifact_binding_required) {
      throw proofError('AUTHORIZATION_PROOF_REQUIRED', 'Artifact requires a cryptographic proof');
    }
    return null;
  }
  const profile = parseProfile(job);
  if (profile.method !== declaration.method) {
    throw proofError('AUTHORIZATION_PROOF_MISMATCH', 'Proof method does not match the handoff artifact');
  }
  const db = opts.db || getDb();
  const eventBinding = {
    jobId: job.id,
    runId: run.id,
    handoffArtifactDigest: job.handoff_artifact_digest,
    sourceRunId: run.source_run_id,
    sourceRunHandoffArtifactDigest: run.source_run_handoff_artifact_digest,
  };
  if (opts.reuseVerification != null || opts.priorRun != null) {
    try {
      return await reuseVerifiedProof(job, declaration, profile, run, opts, db, eventBinding);
    } catch (error) {
      appendRuntimeEvent('proof.failed', {
        ...eventBinding,
        payload: {
          method: declaration.method,
          code: error.code || 'AUTHORIZATION_PROOF_VERIFICATION_FAILED',
          reason: String(error.message || 'proof verification failed').slice(0, 500),
        },
      }, { db });
      throw error;
    }
  }
  const proof = resolveProofValue(profile, opts);
  const agentcli = await loadAgentcli(opts);
  appendRuntimeEvent('proof.verifying', {
    ...eventBinding,
    payload: { method: declaration.method },
  }, { db });
  try {
    const result = await agentcli.verifyAuthorizationProof(proof, profile, {
      handoffVersion: 4,
      artifactDigest: job.handoff_artifact_digest,
      handoffArtifactDigest: job.handoff_artifact_digest,
      artifactPayload: artifact,
      manifestDigest: artifact.manifest.digest,
      manifest: artifact,
      runId: run.id,
      requireSignature: true,
      requireManifestBinding: true,
      clockSkewSeconds: opts.clockSkewSeconds ?? 60,
      now: opts.now,
      claimProofReplay: input => claimProofReplay(db, input),
      checkProofRevocation: revocationChecker(db, profile, opts),
      cwd: opts.cwd || process.cwd(),
    });
    let audited = auditResult(result);
    if (result?.verified !== true
      || result.artifact_bound !== true
      || result.replay_protected !== true
      || result.revocation_checked !== true
      || result.signature_verified !== true) {
      throw proofError(
        'AUTHORIZATION_PROOF_VERIFICATION_FAILED',
        result?.reason || 'Authorization proof verification did not satisfy every v4 runtime guard',
        { result: audited },
      );
    }
    audited = auditResult(
      result,
      verifiedProofTemporalWindow(
        declaration.method,
        proof,
        result,
        opts.clockSkewSeconds ?? 60,
      ),
    );
    appendRuntimeEvent('proof.verified', {
      ...eventBinding,
      payload: audited,
    }, { db });
    return audited;
  } catch (error) {
    appendRuntimeEvent('proof.failed', {
      ...eventBinding,
      payload: {
        method: declaration.method,
        code: error.code || 'AUTHORIZATION_PROOF_VERIFICATION_FAILED',
        reason: String(error.message || 'proof verification failed').slice(0, 500),
      },
    }, { db });
    throw error;
  }
}

export function revokeProof(input, opts = {}) {
  if (!input || typeof input !== 'object' || !input.method) {
    throw new TypeError('proof revocation requires method');
  }
  if (!input.proofId && !input.keyId) {
    throw new TypeError('proof revocation requires proofId or keyId');
  }
  const db = opts.db || getDb();
  const result = db.prepare(
    'INSERT INTO proof_revocations '
    + '(method, issuer, proof_id, key_id, reason, revoked_by) '
    + 'VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    input.method,
    input.issuer ?? null,
    input.proofId ?? null,
    input.keyId ?? null,
    input.reason ?? null,
    input.revokedBy ?? null,
  );
  return db.prepare('SELECT * FROM proof_revocations WHERE id = ?').get(result.lastInsertRowid);
}
