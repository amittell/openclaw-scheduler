// v0.2 Runtime -- pure evaluation functions for OpenClaw identity, trust,
// authorization, evidence, and credential handoff.
//
// Design constraints:
// - No side effects, no DB writes, no imports from other scheduler modules.
// - The caller is responsible for persisting outcomes.
// - Every function accepts a plain job object (as stored in SQLite, with
//   JSON blob fields as strings), parses JSON internally, and returns a
//   plain object suitable for JSON.stringify.
// - Functions return null when the relevant feature is not declared.
// - Functions never throw; parse errors surface as { error: ... } in the result.

/** Canonical trust level ordering (lowest to highest). */
export const TRUST_LEVELS = ['untrusted', 'restricted', 'supervised', 'autonomous'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON string. Returns the parsed value on success, or
 * undefined on failure. Sets `err.message` on the provided error holder
 * when parsing fails.
 */
function safeParse(str, errorHolder) {
  if (str == null || str === '') return undefined;
  try {
    return JSON.parse(str);
  } catch (e) {
    if (errorHolder) errorHolder.message = e.message;
    return undefined;
  }
}

/**
 * Return the integer index of a trust level in the canonical ordering,
 * or -1 if the level is not recognized.
 */
function trustIndex(level) {
  if (level == null) return -1;
  return TRUST_LEVELS.indexOf(level);
}

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

/**
 * Extract and normalize identity declaration from a job record.
 * When ctx.getIdentityProvider is available and the identity blob references
 * a provider, the provider is called first. Structural resolution is the
 * fallback for jobs that do not reference a provider or when no ctx is given.
 *
 * @param {object} job - Job record with v0.2 identity fields.
 * @param {object} [ctx={}] - Optional context with provider accessors.
 * @returns {Promise<{ subject_kind, principal, trust_level, delegation_mode, raw } | null>}
 */
export async function resolveIdentity(job, ctx = {}) {
  if (!job) return null;

  // Attempt to parse the JSON blob first; scalar fields serve as fallback.
  const parseErr = {};
  const blob = safeParse(job.identity, parseErr);

  // Try provider-based resolution before structural fallback.
  const providerName = (blob && typeof blob === 'object' && !Array.isArray(blob))
    ? (blob.provider || blob.auth?.provider || null)
    : null;

  if (providerName) {
    const provider = ctx.getIdentityProvider?.(providerName);
    if (provider) {
      try {
        const scope = blob?.scope || blob?.auth?.scopes?.[0] || null;
        const result = await provider.resolveSession(
          { profile: blob, instanceId: job.id, scope },
          { env: ctx.env || process.env, cwd: ctx.cwd || process.cwd() },
        );
        if (!result.ok) {
          return {
            provider: providerName,
            error: result.error,
            transient: result.transient ?? true,
            source: 'provider-error',
          };
        }
        return {
          provider: providerName,
          session: result.session,
          source: 'provider',
          // Include structural fields for backward compat
          subject_kind: result.session?.subject?.kind || 'unknown',
          principal: result.session?.subject?.principal || null,
          trust_level: result.session?.trust?.effective_level || blob?.trust?.level || null,
          delegation_mode: blob?.subject?.delegation_mode || null,
          raw: blob,
        };
      } catch (err) {
        return {
          provider: providerName,
          error: err.message,
          transient: true,
          source: 'provider-error',
        };
      }
    }
  }

  // Fallback: structural resolution (original logic).

  if (parseErr.message && job.identity != null && job.identity !== '') {
    // The blob was present but malformed -- report the error while still
    // falling back to scalar fields so callers get partial data.
    const result = buildIdentityFromScalars(job);
    if (result) {
      result.raw = { error: `identity JSON parse failed: ${parseErr.message}` };
      return result;
    }
    return {
      subject_kind: 'unknown',
      principal: null,
      trust_level: null,
      delegation_mode: null,
      raw: { error: `identity JSON parse failed: ${parseErr.message}` },
    };
  }

  if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
    return {
      subject_kind: blob.subject_kind || blob.identity_subject_kind || job.identity_subject_kind || 'unknown',
      principal: blob.principal || blob.identity_principal || job.identity_principal || null,
      trust_level: blob.trust_level || blob.identity_trust_level || job.identity_trust_level || null,
      delegation_mode: blob.delegation_mode || blob.identity_delegation_mode || job.identity_delegation_mode || null,
      raw: blob,
    };
  }

  // No blob (or blob was a primitive) -- use scalar fields.
  return buildIdentityFromScalars(job);
}

function buildIdentityFromScalars(job) {
  const hasAny = job.identity_principal != null
    || job.identity_run_as != null
    || job.identity_attestation != null
    || job.identity_ref != null
    || job.identity_subject_kind != null
    || job.identity_subject_principal != null
    || job.identity_trust_level != null
    || job.identity_delegation_mode != null;

  if (!hasAny) return null;

  return {
    subject_kind: job.identity_subject_kind || 'unknown',
    principal: job.identity_principal || job.identity_subject_principal || null,
    trust_level: job.identity_trust_level || null,
    delegation_mode: job.identity_delegation_mode || null,
    raw: null,
  };
}

// ---------------------------------------------------------------------------
// evaluateTrust
// ---------------------------------------------------------------------------

/**
 * Compare effective trust level against the contract's required trust level.
 *
 * @param {object} job - Job record with v0.2 contract fields.
 * @param {object|null} resolvedIdentity - Output of resolveIdentity().
 * @returns {{ effective_level, required_level, decision: 'permit'|'deny'|'warn', reason }}
 */
export function evaluateTrust(job, resolvedIdentity) {
  if (!job) {
    return { effective_level: null, required_level: null, decision: 'permit', reason: 'no job provided' };
  }

  const requiredLevel = job.contract_required_trust_level || null;
  if (!requiredLevel) {
    return { effective_level: resolvedIdentity?.trust_level || null, required_level: null, decision: 'permit', reason: 'no trust requirement declared' };
  }

  const effectiveLevel = resolvedIdentity?.trust_level || job.identity_trust_level || null;
  const effectiveIdx = trustIndex(effectiveLevel);
  const requiredIdx = trustIndex(requiredLevel);

  if (requiredIdx < 0) {
    return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'permit', reason: `unrecognized required trust level: ${requiredLevel}` };
  }

  if (effectiveLevel == null) {
    // No effective level declared -- enforcement determines outcome.
    const enforcement = job.contract_trust_enforcement || 'none';
    if (enforcement === 'block') {
      return { effective_level: null, required_level: requiredLevel, decision: 'deny', reason: 'no trust level declared; enforcement is block' };
    }
    if (enforcement === 'warn') {
      return { effective_level: null, required_level: requiredLevel, decision: 'warn', reason: 'no trust level declared; enforcement is warn' };
    }
    return { effective_level: null, required_level: requiredLevel, decision: 'permit', reason: 'no trust level declared; enforcement is none' };
  }

  if (effectiveIdx < 0) {
    // Effective level not in canonical list.
    const enforcement = job.contract_trust_enforcement || 'none';
    if (enforcement === 'block') {
      return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'deny', reason: `unrecognized effective trust level: ${effectiveLevel}` };
    }
    if (enforcement === 'warn') {
      return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'warn', reason: `unrecognized effective trust level: ${effectiveLevel}` };
    }
    return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'permit', reason: `unrecognized effective trust level: ${effectiveLevel}` };
  }

  if (effectiveIdx >= requiredIdx) {
    return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'permit', reason: 'trust level meets or exceeds requirement' };
  }

  // Effective is below required -- check enforcement.
  const enforcement = job.contract_trust_enforcement || 'none';
  if (enforcement === 'block') {
    return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'deny', reason: `trust level ${effectiveLevel} is below required ${requiredLevel}` };
  }
  if (enforcement === 'warn') {
    return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'warn', reason: `trust level ${effectiveLevel} is below required ${requiredLevel}` };
  }
  return { effective_level: effectiveLevel, required_level: requiredLevel, decision: 'permit', reason: `trust level ${effectiveLevel} is below required ${requiredLevel}; enforcement is none` };
}

// ---------------------------------------------------------------------------
// verifyAuthorizationProof
// ---------------------------------------------------------------------------

/** Recognized proof method values for structural validation. */
const KNOWN_PROOF_METHODS = ['signed-jwt', 'hmac', 'api-key', 'bearer', 'mtls', 'oidc', 'saml', 'custom'];

/**
 * Validate authorization proof structure.
 * When ctx.getProofVerifier is available and the proof blob references a
 * provider, the verifier is called first. Structural validation is the
 * fallback.
 *
 * @param {object} job - Job record with v0.2 authorization_proof fields.
 * @param {object} [ctx={}] - Optional context with provider accessors.
 * @returns {Promise<{ verified: boolean, method, ref, error? } | null>}
 */
export async function verifyAuthorizationProof(job, ctx = {}) {
  if (!job) return null;

  const proofStr = job.authorization_proof;
  const proofRef = job.authorization_proof_ref || null;

  if (proofStr == null && proofRef == null) return null;

  if (proofStr == null || proofStr === '') {
    // Only a ref, no inline proof.
    return { verified: false, method: null, ref: proofRef, error: 'authorization_proof is empty; only ref provided' };
  }

  const parseErr = {};
  const blob = safeParse(proofStr, parseErr);

  if (parseErr.message) {
    return { verified: false, method: null, ref: proofRef, error: `authorization_proof JSON parse failed: ${parseErr.message}` };
  }

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { verified: false, method: null, ref: proofRef, error: 'authorization_proof must be a JSON object' };
  }

  const method = blob.method || null;
  const blobRef = blob.ref || proofRef;

  // Try provider-based verification before structural fallback.
  const verifierName = blob.verifier || blob.provider || null;
  if (verifierName) {
    const verifier = ctx.getProofVerifier?.(verifierName);
    if (verifier) {
      try {
        const result = await verifier.verifyProof(
          { proof: blob, ref: blobRef, jobId: job.id },
          { env: ctx.env || process.env, cwd: ctx.cwd || process.cwd() },
        );
        return {
          verified: !!result.verified,
          method,
          ref: blobRef,
          source: 'provider',
          provider: verifierName,
          ...(result.error ? { error: result.error } : {}),
        };
      } catch (err) {
        return {
          verified: false,
          method,
          ref: blobRef,
          error: err.message,
          source: 'provider-error',
          provider: verifierName,
        };
      }
    }
  }

  // Fallback: structural validation (original logic).

  if (!method) {
    return { verified: false, method: null, ref: blobRef, error: 'authorization_proof missing required "method" field' };
  }

  if (!KNOWN_PROOF_METHODS.includes(method)) {
    return { verified: false, method, ref: blobRef, error: `unrecognized proof method: ${method}` };
  }

  // Structural validation passed.
  return { verified: true, method, ref: blobRef };
}

// ---------------------------------------------------------------------------
// evaluateAuthorization
// ---------------------------------------------------------------------------

/**
 * Evaluate authorization policy.
 * When ctx.getAuthorizationProvider is available and the authorization blob
 * references a provider, the provider is called first. Structural evaluation
 * is the fallback.
 *
 * @param {object} job - Job record with v0.2 authorization fields.
 * @param {object|null} identityResult - Output of resolveIdentity().
 * @param {object|null} trustResult - Output of evaluateTrust().
 * @param {object} [ctx={}] - Optional context with provider accessors.
 * @returns {Promise<{ decision: 'permit'|'deny'|'escalate', reason, ref } | null>}
 */
export async function evaluateAuthorization(job, identityResult, trustResult, ctx = {}) {
  if (!job) return null;

  const authStr = job.authorization;
  const authRef = job.authorization_ref || null;

  if (authStr == null && authRef == null) return null;

  if (authStr == null || authStr === '') {
    // Only a ref, no inline authorization policy.
    return { decision: 'permit', reason: 'authorization ref only; no inline policy to evaluate', ref: authRef };
  }

  const parseErr = {};
  const blob = safeParse(authStr, parseErr);

  if (parseErr.message) {
    return { decision: 'deny', reason: `authorization JSON parse failed: ${parseErr.message}`, ref: authRef };
  }

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { decision: 'deny', reason: 'authorization must be a JSON object', ref: authRef };
  }

  const blobRef = blob.ref || authRef;

  // Try provider-based authorization before structural fallback.
  const providerName = blob.provider || blob.authorization_provider || null;
  if (providerName) {
    const provider = ctx.getAuthorizationProvider?.(providerName);
    if (provider) {
      try {
        const result = await provider.authorize(
          { policy: blob, identity: identityResult, trust: trustResult, ref: blobRef, jobId: job.id },
          { env: ctx.env || process.env, cwd: ctx.cwd || process.cwd() },
        );
        return {
          decision: result.decision || 'deny',
          reason: result.reason || `provider ${providerName} returned ${result.decision}`,
          ref: blobRef,
          source: 'provider',
          provider: providerName,
        };
      } catch (err) {
        return {
          decision: 'deny',
          reason: `authorization provider error: ${err.message}`,
          ref: blobRef,
          source: 'provider-error',
          provider: providerName,
        };
      }
    }
  }

  // Fallback: structural evaluation (original logic).

  // If the blob contains an explicit decision, honor it.
  if (blob.decision === 'deny') {
    return { decision: 'deny', reason: blob.reason || 'explicit deny in authorization policy', ref: blobRef };
  }
  if (blob.decision === 'escalate') {
    return { decision: 'escalate', reason: blob.reason || 'explicit escalate in authorization policy', ref: blobRef };
  }

  // If trust evaluation resulted in deny and the authorization depends on trust,
  // propagate the denial.
  const dependsOnTrust = blob.depends_on_trust !== false; // default true
  if (dependsOnTrust && trustResult && trustResult.decision === 'deny') {
    return { decision: 'deny', reason: `trust evaluation denied: ${trustResult.reason}`, ref: blobRef };
  }

  // If no identity was resolved and authorization requires identity, deny.
  if (blob.requires_identity && !identityResult) {
    return { decision: 'deny', reason: 'authorization requires identity but none was resolved', ref: blobRef };
  }

  // Default: permit. Actual OPA/provider calls are future work.
  return { decision: blob.decision === 'permit' ? 'permit' : 'permit', reason: blob.reason || 'authorization policy permits (structural check only)', ref: blobRef };
}

// ---------------------------------------------------------------------------
// generateEvidence
// ---------------------------------------------------------------------------

/**
 * Create evidence record metadata.
 * MVP: builds a metadata envelope. Actual evidence storage and hashing are
 * future work.
 *
 * @param {object} job - Job record with v0.2 evidence fields.
 * @param {object|null} runResult - Run result metadata (e.g. { id, status }).
 * @param {object|null} outcomes - Aggregated outcomes from other v0.2 functions.
 * @returns {{ evidence_ref, created_at, hash, payload_summary }} or null if
 *          no evidence declaration.
 */
export function generateEvidence(job, runResult, outcomes) {
  if (!job) return null;

  const evidenceStr = job.evidence;
  const evidenceRef = job.evidence_ref || null;

  if (evidenceStr == null && evidenceRef == null) return null;

  const parseErr = {};
  const blob = (evidenceStr != null && evidenceStr !== '') ? safeParse(evidenceStr, parseErr) : null;

  if (parseErr.message) {
    return {
      evidence_ref: evidenceRef,
      created_at: new Date().toISOString(),
      hash: null,
      payload_summary: { error: `evidence JSON parse failed: ${parseErr.message}` },
    };
  }

  const effectiveRef = (blob && blob.ref) || evidenceRef;

  // Build a summary of what was recorded.
  const payloadSummary = {};

  if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
    if (blob.collect) payloadSummary.collect = blob.collect;
    if (blob.retention) payloadSummary.retention = blob.retention;
    if (blob.format) payloadSummary.format = blob.format;
  }

  if (runResult && typeof runResult === 'object') {
    payloadSummary.run_id = runResult.id || null;
    payloadSummary.run_status = runResult.status || null;
  }

  if (outcomes && typeof outcomes === 'object') {
    const outcomeKeys = Object.keys(outcomes).filter(k => outcomes[k] != null);
    payloadSummary.outcome_fields_present = outcomeKeys;
  }

  return {
    evidence_ref: effectiveRef,
    created_at: new Date().toISOString(),
    hash: null, // actual content-addressable hashing is future work
    payload_summary: payloadSummary,
  };
}

// ---------------------------------------------------------------------------
// summarizeCredentialHandoff
// ---------------------------------------------------------------------------

/**
 * Summarize the credential handoff plan from the identity declaration.
 *
 * @param {object} job - Job record with v0.2 identity fields.
 * @returns {{ mode, bindings_count, cleanup_required }} or null if no
 *          identity or no presentation bindings are declared.
 */
export function summarizeCredentialHandoff(job) {
  if (!job) return null;

  const parseErr = {};
  const blob = safeParse(job.identity, parseErr);

  if (parseErr.message && job.identity != null && job.identity !== '') {
    return {
      mode: null,
      bindings_count: 0,
      cleanup_required: false,
      error: `identity JSON parse failed: ${parseErr.message}`,
    };
  }

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    // No blob available -- cannot determine credential handoff.
    return null;
  }

  // Look for presentation / credential handoff configuration.
  const presentation = blob.presentation || blob.credential_handoff || null;
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
    return null;
  }

  const mode = presentation.mode || null;
  const bindings = Array.isArray(presentation.bindings) ? presentation.bindings : [];
  const cleanupRequired = presentation.cleanup === true
    || presentation.cleanup_required === true
    || bindings.some(b => b && b.cleanup === true);

  if (!mode && bindings.length === 0) return null;

  return {
    mode,
    bindings_count: bindings.length,
    cleanup_required: cleanupRequired,
  };
}
