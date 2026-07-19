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

function auditResult(result) {
  const allowed = {};
  for (const key of [
    'verified', 'method', 'reason', 'claims_validated', 'signature_verified',
    'manifest_bound', 'artifact_bound', 'replay_protected', 'revocation_checked',
    'issuer', 'subject', 'key_id', 'proof_id', 'verified_at',
  ]) {
    if (result?.[key] != null) allowed[key] = result[key];
  }
  return allowed;
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
  const proof = resolveProofValue(profile, opts);
  const db = opts.db || getDb();
  const agentcli = await loadAgentcli(opts);
  const eventBinding = {
    jobId: job.id,
    runId: run.id,
    handoffArtifactDigest: job.handoff_artifact_digest,
    sourceRunId: run.source_run_id,
    sourceRunHandoffArtifactDigest: run.source_run_handoff_artifact_digest,
  };
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
    const audited = auditResult(result);
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
