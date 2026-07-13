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
// - Evaluation functions return fail-closed result objects. Evidence declaration
//   and binding failures throw so a terminal run cannot commit invalid evidence.

import { createHash } from 'node:crypto';

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function normalizeEvidenceRetention(value, createdAt) {
  const invalid = message => {
    const error = new Error(message);
    error.code = 'EVIDENCE_RETENTION_INVALID';
    throw error;
  };
  if (value == null || value === '') return { policy: null, until: null };
  if (typeof value !== 'string') invalid('evidence retention must be a duration string');
  const policy = value.trim().toLowerCase();
  if (['forever', 'indefinite'].includes(policy)) return { policy: 'forever', until: null };
  const match = /^(\d+)(m|h|d|w|y)$/.exec(policy);
  if (!match || Number(match[1]) < 1) {
    invalid('evidence retention must be forever or a positive duration such as 30d');
  }
  const multipliers = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
    y: 365 * 86_400_000,
  };
  const durationMs = Number(match[1]) * multipliers[match[2]];
  if (!Number.isSafeInteger(durationMs) || durationMs > 100 * multipliers.y) {
    invalid('evidence retention must not exceed 100 years');
  }
  return { policy, until: new Date(Date.parse(createdAt) + durationMs).toISOString() };
}

const CHECKSUM_EVIDENCE_BINDINGS = new Set([
  'execution_id', 'command', 'contract', 'result', 'postcondition',
  'identity', 'trust', 'authorization', 'authorization_proof',
  'delegation', 'credential_handoff', 'context',
]);
const CHECKSUM_EVIDENCE_COLLECTIONS = new Set([
  'result', 'identity', 'authorization', 'governance', 'stdout', 'stderr', 'exit_code',
]);
const EVIDENCE_TERMINAL_STATUSES = new Set([
  'ok', 'error', 'timeout', 'skipped', 'cancelled', 'crashed', 'recovery_blocked',
]);

/**
 * Return the integer index of a trust level in the canonical ordering,
 * or -1 if the level is not recognized.
 */
function trustIndex(level) {
  if (level == null) return -1;
  return TRUST_LEVELS.indexOf(level);
}

/**
 * Compare two trust levels. Returns:
 *  -1 if a < b (a is lower trust)
 *   0 if a === b
 *   1 if a > b (a is higher trust)
 *
 * Unrecognized levels compare as lower than any known level.
 * Both null/undefined returns 0 (both unknown = equal).
 */
export function compareTrustLevels(a, b) {
  const ai = trustIndex(a);
  const bi = trustIndex(b);
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

/**
 * Extract and normalize identity declaration from a job record.
 * When the identity blob references a provider, that provider must be
 * available in ctx. Provider-backed declarations fail closed when the plugin
 * is missing or errors. Structural resolution is the fallback only for jobs
 * that do not reference a provider.
 *
 * @param {object} job - Job record with v0.2 identity fields.
 * @param {object} [ctx={}] - Optional context with provider accessors.
 * @returns {Promise<
 *   { subject_kind, principal, trust_level, delegation_mode, raw } |
 *   { provider, session, source: 'provider', subject_kind, principal, trust_level, delegation_mode, raw } |
 *   { provider, error, transient, source: 'provider-error' } |
 *   null
 * >}
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
    if (!provider) {
      return {
        provider: providerName,
        error: `identity provider not loaded: ${providerName}`,
        transient: false,
        source: 'provider-error',
      };
    }
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

/**
 * Enforce provider-independent delegation constraints after identity resolution.
 * Provider validation is honored but never replaces the runtime's depth, cycle,
 * allow-list, and per-hop grant checks.
 */
export function validateDelegation(job, resolvedIdentity) {
  if (!job) return null;
  const declaration = safeParse(job.identity) || {};
  const session = resolvedIdentity?.session || declaration?.session || {};
  const chain = Array.isArray(session.delegation_chain)
    ? session.delegation_chain
    : Array.isArray(declaration.delegation_chain)
      ? declaration.delegation_chain
      : [];
  const mode = resolvedIdentity?.delegation_mode
    || declaration?.subject?.delegation_mode
    || declaration?.delegation_mode
    || job.identity_delegation_mode
    || null;
  const policy = declaration?.auth?.delegation_policy || declaration?.delegation_policy || {};
  const providerValidation = session.delegation_validation || resolvedIdentity?.delegation_validation || null;

  if (chain.length === 0 && (!mode || mode === 'none') && providerValidation == null) return null;

  const failures = [];
  const maxDepth = Number.isInteger(policy.max_depth) ? policy.max_depth : 16;
  const allowedDelegators = Array.isArray(policy.allowed_delegators)
    ? new Set(policy.allowed_delegators)
    : null;
  const requireGrant = policy.require_grant_per_hop !== false;
  const seenHops = new Set();
  const explicitEdges = [];

  if (mode && mode !== 'none' && chain.length === 0) {
    failures.push(`delegation mode ${mode} requires a delegation chain`);
  }
  if (chain.length > maxDepth) failures.push(`delegation chain exceeds max_depth ${maxDepth}`);
  for (const [index, hop] of chain.entries()) {
    const principal = typeof hop?.principal === 'string' ? hop.principal : null;
    const grant = typeof hop?.grant === 'string' ? hop.grant : null;
    const transition = `${principal || '(unknown)'}\u0000${grant || '(none)'}`;
    if (seenHops.has(transition)) failures.push(`delegation chain contains a repeated hop at index ${index}`);
    seenHops.add(transition);
    if (!principal) failures.push(`delegation hop ${index} is missing a principal`);
    if (allowedDelegators && (!principal || !allowedDelegators.has(principal))) {
      failures.push(`delegator at index ${index} is not allowed`);
    }
    if (requireGrant && (!grant || (hop?.validated !== true && providerValidation?.valid !== true))) {
      failures.push(`delegation hop ${index} lacks a validated grant`);
    }
    const from = hop?.delegator || hop?.from_principal || hop?.from || null;
    const to = hop?.delegatee || hop?.to_principal || hop?.to || null;
    if (from != null || to != null) {
      if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
        failures.push(`delegation hop ${index} must provide both explicit edge principals`);
      } else {
        explicitEdges.push([from, to]);
      }
    }
  }

  let explicitCycle = false;
  if (explicitEdges.length > 0) {
    const graph = new Map();
    for (const [from, to] of explicitEdges) {
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from).add(to);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = node => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const next of graph.get(node) || []) {
        if (visit(next)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    explicitCycle = [...graph.keys()].some(visit);
    if (explicitCycle) failures.push('delegation chain contains an explicit principal cycle');
  }
  if (providerValidation?.valid === false) {
    const providerErrors = Array.isArray(providerValidation.errors)
      ? providerValidation.errors
      : ['identity provider rejected the delegation chain'];
    failures.push(...providerErrors.map(error => `provider: ${error}`));
  }

  return {
    valid: failures.length === 0,
    mode,
    depth: chain.length,
    max_depth: maxDepth,
    no_duplicate_hops: !failures.some(failure => failure.includes('repeated hop')),
    acyclic: explicitEdges.length > 0 ? !explicitCycle : null,
    cycle_check: explicitEdges.length > 0 ? 'explicit-edges' : 'not-representable',
    all_grants_present: !failures.some(failure => failure.includes('grant')),
    provider_validated: providerValidation?.valid === true,
    errors: failures,
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

  // Normalize enforcement: agentcli uses advisory/strict, runtime uses warn/block.
  const rawEnforcement = job.contract_trust_enforcement || 'none';
  const normalizedEnforcement = rawEnforcement === 'advisory' ? 'warn'
    : rawEnforcement === 'strict' ? 'block'
    : rawEnforcement;

  if (effectiveLevel == null) {
    // No effective level declared -- enforcement determines outcome.
    const enforcement = normalizedEnforcement;
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
    const enforcement = normalizedEnforcement;
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
  const enforcement = normalizedEnforcement;
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

/** Agentcli proof methods. Cryptographic methods require a loaded verifier. */
const KNOWN_PROOF_METHODS = ['none', 'jwt', 'detached-signature', 'certificate'];

/**
 * Validate authorization proof structure.
 * When the proof blob references a provider or verifier, that verifier must be
 * available in ctx. Provider-backed verification fails closed when the plugin
 * is missing or errors. Structural validation is the fallback only for proofs
 * without an explicit verifier.
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
    if (!verifier) {
      return {
        verified: false,
        method,
        ref: blobRef,
        error: `proof verifier not loaded: ${verifierName}`,
        source: 'provider-error',
        provider: verifierName,
      };
    }
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

  if (!method) {
    return { verified: false, method: null, ref: blobRef, error: 'authorization_proof missing required "method" field' };
  }

  if (!KNOWN_PROOF_METHODS.includes(method)) {
    return { verified: false, method, ref: blobRef, error: `unrecognized proof method: ${method}` };
  }

  if (method === 'none' && blob.verify?.required !== true) {
    return {
      verified: true,
      method,
      ref: blobRef,
      source: 'explicit-opt-out',
    };
  }

  return {
    verified: false,
    method,
    ref: blobRef,
    source: 'verifier-required',
    error: `cryptographic proof method ${method} requires a loaded proof verifier`,
  };
}

// ---------------------------------------------------------------------------
// evaluateAuthorization
// ---------------------------------------------------------------------------

/**
 * Evaluate authorization policy.
 * When the authorization blob references a provider, that provider must be
 * available in ctx. Provider-backed authorization fails closed when the
 * plugin is missing or errors. Structural evaluation is the fallback only for
 * policies without an explicit provider.
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

  const parseErr = {};
  let blob;
  let resolvedFromReference = false;
  if (authStr == null || authStr === '') {
    if (typeof ctx.resolveAuthorizationRef !== 'function') {
      return { decision: 'deny', reason: 'authorization_ref requires a configured authorization policy resolver', ref: authRef, source: 'reference-error' };
    }
    try {
      const resolved = await ctx.resolveAuthorizationRef(authRef, {
        job,
        identity: identityResult,
        trust: trustResult,
        env: ctx.env || process.env,
        cwd: ctx.cwd || process.cwd(),
      });
      blob = typeof resolved === 'string' ? safeParse(resolved, parseErr) : (resolved?.policy || resolved);
      resolvedFromReference = true;
      if (!blob) {
        return { decision: 'deny', reason: `authorization_ref could not be resolved: ${authRef}`, ref: authRef, source: 'reference-error' };
      }
    } catch (err) {
      return { decision: 'deny', reason: `authorization_ref resolution failed: ${err.message}`, ref: authRef, source: 'reference-error' };
    }
  } else {
    blob = safeParse(authStr, parseErr);
  }

  if (parseErr.message) {
    return { decision: 'deny', reason: `authorization JSON parse failed: ${parseErr.message}`, ref: authRef };
  }

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    return { decision: 'deny', reason: 'authorization must be a JSON object', ref: authRef };
  }

  const blobRef = blob.ref || authRef;
  const policyDigest = sha256(blob);

  // Try provider-based authorization before structural fallback.
  const providerName = blob.provider || blob.authorization_provider || null;
  if (providerName) {
    const provider = ctx.getAuthorizationProvider?.(providerName);
    if (!provider) {
      return {
        decision: 'deny',
        reason: `authorization provider not loaded: ${providerName}`,
        ref: blobRef,
        source: 'provider-error',
        provider: providerName,
        policy_digest: policyDigest,
      };
    }
    try {
      const result = await provider.authorize(
        { policy: blob, identity: identityResult, trust: trustResult, ref: blobRef, jobId: job.id },
        { env: ctx.env || process.env, cwd: ctx.cwd || process.cwd() },
      );
      const rawDecision = typeof result?.decision === 'string' ? result.decision : null;
      const decision = rawDecision === 'permit' || rawDecision === 'deny' || rawDecision === 'escalate'
        ? rawDecision
        : 'deny';
      const reason = decision === 'deny' && rawDecision !== 'deny' && rawDecision !== null
        ? `authorization provider ${providerName} returned unsupported decision "${rawDecision}"`
        : decision === 'deny' && rawDecision == null
          ? `authorization provider ${providerName} returned no decision`
          : result?.reason || `provider ${providerName} returned ${decision}`;
      let providerContextHash = null;
      if (result?.context_hash != null) {
        if (typeof result.context_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(result.context_hash)) {
          return {
            decision: 'deny',
            reason: `authorization provider ${providerName} returned an invalid context_hash`,
            ref: blobRef,
            source: 'provider-error',
            provider: providerName,
            policy_digest: policyDigest,
          };
        }
        providerContextHash = result.context_hash;
      }
      let decisionContextHash = null;
      if (result?.decision_context != null) {
        if (
          typeof result.decision_context !== 'object'
          || Array.isArray(result.decision_context)
          || result.decision_context === null
        ) {
          return {
            decision: 'deny',
            reason: `authorization provider ${providerName} returned invalid decision_context`,
            ref: blobRef,
            source: 'provider-error',
            provider: providerName,
            policy_digest: policyDigest,
          };
        }
        const serializedContext = JSON.stringify(canonicalize(result.decision_context));
        if (Buffer.byteLength(serializedContext, 'utf8') > 16 * 1024) {
          return {
            decision: 'deny',
            reason: `authorization provider ${providerName} decision_context exceeds 16384 bytes`,
            ref: blobRef,
            source: 'provider-error',
            provider: providerName,
            policy_digest: policyDigest,
          };
        }
        decisionContextHash = sha256(result.decision_context);
      }
      return {
        decision,
        reason,
        ref: blobRef,
        source: 'provider',
        provider: providerName,
        policy_digest: policyDigest,
        provider_context_hash: providerContextHash,
        decision_context_hash: decisionContextHash,
      };
    } catch (err) {
      return {
        decision: 'deny',
        reason: `authorization provider error: ${err.message}`,
        ref: blobRef,
        source: 'provider-error',
        provider: providerName,
        policy_digest: policyDigest,
      };
    }
  }

  // Fallback: structural evaluation (original logic).

  // If the blob contains an explicit decision, honor it.
  if (blob.decision === 'deny') {
    return {
      decision: 'deny',
      reason: blob.reason || 'explicit deny in authorization policy',
      ref: blobRef,
      source: resolvedFromReference ? 'reference' : 'structural',
      policy_digest: policyDigest,
    };
  }
  if (blob.decision === 'escalate') {
    return {
      decision: 'escalate',
      reason: blob.reason || 'explicit escalate in authorization policy',
      ref: blobRef,
      source: resolvedFromReference ? 'reference' : 'structural',
      policy_digest: policyDigest,
    };
  }
  if (blob.decision && typeof blob.decision === 'object') {
    return {
      decision: 'deny',
      reason: 'authorization decision mappings require an authorization provider result',
      ref: blobRef,
      source: resolvedFromReference ? 'reference-error' : 'structural-error',
      policy_digest: policyDigest,
    };
  }

  // If trust evaluation resulted in deny and the authorization depends on trust,
  // propagate the denial.
  const dependsOnTrust = blob.depends_on_trust !== false; // default true
  if (dependsOnTrust && trustResult && trustResult.decision === 'deny') {
    return {
      decision: 'deny',
      reason: `trust evaluation denied: ${trustResult.reason}`,
      ref: blobRef,
      source: resolvedFromReference ? 'reference' : 'structural',
      policy_digest: policyDigest,
    };
  }

  // If no identity was resolved and authorization requires identity, deny.
  if (blob.requires_identity && !identityResult) {
    return {
      decision: 'deny',
      reason: 'authorization requires identity but none was resolved',
      ref: blobRef,
      source: resolvedFromReference ? 'reference' : 'structural',
      policy_digest: policyDigest,
    };
  }

  return {
    decision: 'permit',
    reason: blob.reason || 'authorization policy permits (structural check only)',
    ref: blobRef,
    source: resolvedFromReference ? 'reference' : 'structural',
    policy_digest: policyDigest,
  };
}

// ---------------------------------------------------------------------------
// generateEvidence
// ---------------------------------------------------------------------------

function hashEvidenceText(value) {
  return value == null ? null : sha256(String(value));
}

/** Build the safe execution snapshot persisted when a run is created. */
export function buildEvidenceExecutionSnapshot(job) {
  if (!job || typeof job !== 'object') throw new TypeError('job is required for an evidence execution snapshot');
  const command = canonicalize({
    session_target: job.session_target || null,
    payload_kind: job.payload_kind || null,
    execution_intent: job.execution_intent || null,
    payload_bytes: Buffer.byteLength(String(job.payload_message || ''), 'utf8'),
    payload_sha256: hashEvidenceText(job.payload_message || ''),
    auth_profile: job.auth_profile || null,
  });
  const contract = canonicalize({
    required_trust_level: job.contract_required_trust_level || null,
    trust_enforcement: job.contract_trust_enforcement || null,
    sandbox_sha256: hashEvidenceText(job.contract_sandbox),
    allowed_paths_sha256: hashEvidenceText(job.contract_allowed_paths),
    network_sha256: hashEvidenceText(job.contract_network),
    max_cost_usd: job.contract_max_cost_usd ?? null,
    audit_sha256: hashEvidenceText(job.contract_audit),
    child_credential_policy: job.child_credential_policy || null,
  });
  const jobSnapshot = canonicalize({
    job_id: job.id || null,
    agent_id: job.agent_id || null,
    payload_model: job.payload_model || null,
    payload_model_fallback: job.payload_model_fallback || null,
    payload_thinking: job.payload_thinking || null,
    payload_timeout_seconds: job.payload_timeout_seconds ?? null,
    run_timeout_ms: job.run_timeout_ms ?? null,
    shell_env_policy: job.shell_env_policy || null,
    output_format: job.output_format || null,
    auth_profile: job.auth_profile || null,
    auth_profile_fallback: job.auth_profile_fallback || null,
    job_type: job.job_type || 'standard',
    watchdog_check_sha256: hashEvidenceText(job.watchdog_check_cmd),
    parent_id: job.parent_id || null,
    trigger_on: job.trigger_on || null,
    trigger_condition_sha256: hashEvidenceText(job.trigger_condition),
    schedule_kind: job.schedule_kind || 'cron',
    schedule_cron: job.schedule_cron || null,
    schedule_at: job.schedule_at || null,
    schedule_tz: job.schedule_tz || null,
    overlap_policy: job.overlap_policy || null,
    max_retries: job.max_retries ?? null,
    approval_required: Boolean(job.approval_required),
    approval_risk_level: job.approval_risk_level || null,
    approval_approver_scope: job.approval_approver_scope || null,
    identity_ref: job.identity_ref || null,
    identity_sha256: hashEvidenceText(job.identity),
    authorization_proof_ref: job.authorization_proof_ref || null,
    authorization_proof_sha256: hashEvidenceText(job.authorization_proof),
    authorization_ref: job.authorization_ref || null,
    authorization_sha256: hashEvidenceText(job.authorization),
    evidence_declaration_sha256: hashEvidenceText(job.evidence),
  });
  return canonicalize({
    command,
    contract,
    job_snapshot: jobSnapshot,
    hash: sha256({ command, contract, job_snapshot: jobSnapshot }),
  });
}

/**
 * Create a canonical, content-addressed evidence record. The payload contains
 * only audit-safe outcome summaries; raw credentials are never embedded.
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
    const error = new Error(`evidence JSON parse failed: ${parseErr.message}`);
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (evidenceStr != null && (blob == null || typeof blob !== 'object' || Array.isArray(blob))) {
    const error = new Error('evidence declaration must be a JSON object');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.provider && !['sha256', 'checksum'].includes(blob.provider)) {
    const error = new Error(`unsupported checksum evidence provider: ${blob.provider}`);
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.methods != null && (
    !Array.isArray(blob.methods)
    || blob.methods.length !== 1
    || blob.methods.some(method => method !== 'sha256')
  )) {
    const error = new Error('checksum evidence methods must contain only sha256');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.verify?.required === true) {
    const error = new Error('required signature verification is unavailable for checksum evidence');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.provider_config && Object.keys(blob.provider_config).length > 0) {
    const error = new Error('provider_config is unavailable for checksum evidence');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  const declaredFormat = blob?.payload?.format || blob?.format || 'canonical-json';
  if (!['canonical-json', 'json'].includes(declaredFormat)) {
    const error = new Error(`unsupported checksum evidence format: ${declaredFormat}`);
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (
    blob?.payload?.bind != null
    && (
      !Array.isArray(blob.payload.bind)
      || blob.payload.bind.some(binding => !CHECKSUM_EVIDENCE_BINDINGS.has(binding))
      || new Set(blob.payload.bind).size !== blob.payload.bind.length
    )
  ) {
    const error = new Error('checksum evidence contains unsupported payload bindings');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.collect != null && (
    !Array.isArray(blob.collect)
    || blob.collect.length === 0
    || blob.collect.some(item => !CHECKSUM_EVIDENCE_COLLECTIONS.has(item))
    || new Set(blob.collect).size !== blob.collect.length
  )) {
    const error = new Error('checksum evidence collect must be a non-empty array of unique supported collection names');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.id != null && (typeof blob.id !== 'string' || !blob.id || blob.id.length > 256)) {
    const error = new Error('checksum evidence id must be a non-empty string no longer than 256 characters');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.ref != null && (typeof blob.ref !== 'string' || !blob.ref || blob.ref.length > 256)) {
    const error = new Error('checksum evidence ref must be a non-empty string no longer than 256 characters');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.ref && evidenceRef && blob.ref !== evidenceRef) {
    const error = new Error('checksum evidence ref does not match evidence_ref');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }
  if (blob?.payload?.context != null && (
    typeof blob.payload.context !== 'object'
    || Array.isArray(blob.payload.context)
    || blob.payload.context === null
    || Buffer.byteLength(JSON.stringify(canonicalize(blob.payload.context)), 'utf8') > 16 * 1024
  )) {
    const error = new Error('checksum evidence payload.context must be an object no larger than 16384 bytes');
    error.code = 'EVIDENCE_DECLARATION_INVALID';
    throw error;
  }

  const createdAt = new Date().toISOString();
  const effectiveRef = (blob && blob.ref) || evidenceRef
    || 'urn:openclaw-scheduler:evidence:checksum-v2';
  const payloadSummary = {};

  const retention = normalizeEvidenceRetention(blob?.retention, createdAt);

  const hashText = hashEvidenceText;
  const hashReason = value => typeof value === 'string' && value ? sha256(value) : null;
  const identity = outcomes?.identity_resolved || null;
  const trust = outcomes?.trust_evaluation || null;
  const authorization = outcomes?.authorization_decision || null;
  const proof = outcomes?.authorization_proof_verification || null;
  const delegation = outcomes?.delegation_validation || null;
  const allSafeOutcomes = {
    identity: identity ? {
      provider: identity.provider || null,
      source: identity.source || null,
      subject_kind: identity.subject_kind || identity.session?.subject?.kind || null,
      principal: identity.principal || identity.session?.subject?.principal || null,
      trust_level: identity.trust_level || identity.session?.trust?.effective_level || null,
      delegation_mode: identity.delegation_mode || null,
      error_sha256: hashReason(identity.error),
    } : null,
    trust: trust ? {
      decision: trust.decision || null,
      required: trust.required || trust.required_level || null,
      actual: trust.actual || trust.effective_level || null,
      enforcement: trust.enforcement || job.contract_trust_enforcement || null,
      reason_sha256: hashReason(trust.reason),
    } : null,
    authorization: authorization ? {
      decision: authorization.decision || null,
      provider_decision: authorization.provider_decision || null,
      provider: authorization.provider || null,
      source: authorization.source || null,
      ref: authorization.ref || null,
      human_override: authorization.human_override === true,
      approval_id: authorization.approval_id || null,
      policy_digest: authorization.policy_digest || null,
      provider_context_hash: authorization.provider_context_hash || null,
      decision_context_hash: authorization.decision_context_hash || null,
      reason_sha256: hashReason(authorization.reason),
    } : null,
    authorization_proof: proof ? {
      method: proof.method || null,
      verified: proof.verified === true,
      issuer: proof.issuer || null,
      principal: proof.principal || null,
      provider: proof.provider || null,
      source: proof.source || null,
      manifest_digest: proof.manifest_digest || null,
      error_sha256: hashReason(proof.error),
    } : null,
    credential_handoff: outcomes?.credential_handoff_summary ? {
      mode: outcomes.credential_handoff_summary.mode || null,
      bindings_count: outcomes.credential_handoff_summary.bindings_count ?? null,
      cleanup_required: outcomes.credential_handoff_summary.cleanup_required === true,
      error_sha256: hashReason(outcomes.credential_handoff_summary.error),
    } : null,
    governance: outcomes?.governance_evaluation ? {
      allowed: outcomes.governance_evaluation.allowed === true,
      violations_sha256: Array.isArray(outcomes.governance_evaluation.violations)
        ? outcomes.governance_evaluation.violations.map(hashReason)
        : null,
      warnings_sha256: Array.isArray(outcomes.governance_evaluation.warnings)
        ? outcomes.governance_evaluation.warnings.map(hashReason)
        : null,
    } : null,
    delegation: delegation ? {
      valid: delegation.valid === true,
      depth: delegation.depth ?? null,
      acyclic: delegation.acyclic ?? null,
      no_duplicate_hops: delegation.no_duplicate_hops ?? null,
      errors_sha256: Array.isArray(delegation.errors)
        ? delegation.errors.map(hashReason)
        : null,
    } : null,
  };
  const collect = blob?.collect == null
    ? [...CHECKSUM_EVIDENCE_COLLECTIONS]
    : [...blob.collect];
  const collected = new Set(collect);
  const safeOutcomes = canonicalize({
    identity: collected.has('identity') ? allSafeOutcomes.identity : null,
    trust: collected.has('identity') ? allSafeOutcomes.trust : null,
    authorization: collected.has('authorization') ? allSafeOutcomes.authorization : null,
    authorization_proof: collected.has('authorization') ? allSafeOutcomes.authorization_proof : null,
    credential_handoff: collected.has('identity') ? allSafeOutcomes.credential_handoff : null,
    governance: collected.has('governance') ? allSafeOutcomes.governance : null,
    delegation: collected.has('identity') ? allSafeOutcomes.delegation : null,
  });

  const executionSnapshot = canonicalize(
    runResult?.execution_snapshot || buildEvidenceExecutionSnapshot(job),
  );
  if (
    !executionSnapshot?.command
    || !executionSnapshot?.contract
    || !executionSnapshot?.job_snapshot
    || executionSnapshot.hash !== sha256({
      command: executionSnapshot.command,
      contract: executionSnapshot.contract,
      job_snapshot: executionSnapshot.job_snapshot,
    })
    || executionSnapshot.job_snapshot.job_id !== job.id
  ) {
    const error = new Error('evidence execution snapshot is invalid or does not match the job');
    error.code = 'EVIDENCE_EXECUTION_SNAPSHOT_INVALID';
    throw error;
  }
  const resultDescriptor = canonicalize({
    status: runResult?.status || null,
    summary_sha256: collected.has('result') ? hashText(runResult?.summary) : null,
    stdout_sha256: collected.has('stdout')
      ? runResult?.stdout_sha256 || hashText(runResult?.output)
      : null,
    stderr_sha256: collected.has('stderr')
      ? runResult?.stderr_sha256 || hashText(runResult?.stderr)
      : null,
    stdout_bytes: collected.has('stdout') ? runResult?.stdout_bytes ?? null : null,
    stderr_bytes: collected.has('stderr') ? runResult?.stderr_bytes ?? null : null,
    exit_code: collected.has('exit_code') ? runResult?.exit_code ?? null : null,
    signal: collected.has('exit_code') ? runResult?.signal || null : null,
    timed_out: collected.has('exit_code') && runResult?.timed_out === true,
    structured_output_sha256: collected.has('result') ? hashText(runResult?.structured_output) : null,
  });
  const postcondition = canonicalize({
    terminal_status: runResult?.status || null,
    succeeded: runResult?.status === 'ok',
    structured_output_valid: runResult?.structured_output_valid ?? null,
  });
  const requestedBindings = Array.isArray(blob?.payload?.bind) ? [...blob.payload.bind].sort() : [];
  const contextKeys = blob?.payload?.context && typeof blob.payload.context === 'object'
    && !Array.isArray(blob.payload.context)
    ? Object.keys(blob.payload.context).sort()
    : [];
  const contextHash = contextKeys.length > 0 ? sha256(blob.payload.context) : null;
  const bindingAvailability = {
    execution_id: Boolean(runResult?.id),
    command: Boolean(job.id && job.payload_kind),
    contract: true,
    result: Boolean(runResult?.status),
    postcondition: Boolean(runResult?.status),
    identity: safeOutcomes.identity != null,
    trust: safeOutcomes.trust != null,
    authorization: safeOutcomes.authorization != null,
    authorization_proof: safeOutcomes.authorization_proof != null,
    delegation: safeOutcomes.delegation != null,
    credential_handoff: safeOutcomes.credential_handoff != null,
    context: contextHash != null,
  };
  const unavailableBindings = requestedBindings.filter(binding => bindingAvailability[binding] !== true);
  const requiredAvailability = {
    execution_id: bindingAvailability.execution_id,
    command: bindingAvailability.command,
    contract: bindingAvailability.contract,
    result: bindingAvailability.result,
    postcondition: bindingAvailability.postcondition,
  };
  const unavailableRequiredBindings = Object.entries(requiredAvailability)
    .filter(([, available]) => available !== true)
    .map(([binding]) => binding);
  unavailableBindings.push(...unavailableRequiredBindings);
  if (unavailableBindings.length > 0) {
    const error = new Error(`evidence requested unavailable binding(s): ${[...new Set(unavailableBindings)].join(', ')}`);
    error.code = 'EVIDENCE_BINDING_UNAVAILABLE';
    throw error;
  }

  payloadSummary.collect = collect;
  payloadSummary.retention = retention.policy;
  payloadSummary.format = declaredFormat;
  payloadSummary.run_id = runResult?.id || null;
  payloadSummary.run_status = runResult?.status || null;
  payloadSummary.output_sha256 = resultDescriptor.stdout_sha256;
  payloadSummary.outcome_fields_present = Object.entries(safeOutcomes)
    .filter(([, value]) => value != null)
    .map(([key]) => key)
    .sort();

  const payload = canonicalize({
    version: 2,
    kind: 'openclaw-scheduler-checksum-evidence',
    created_at: createdAt,
    job_id: job.id || null,
    evidence_ref: effectiveRef,
    retention_policy: retention.policy,
    retention_until: retention.until,
    declaration: {
      provider: blob?.provider || 'sha256',
      methods: blob?.methods?.length ? blob.methods : ['sha256'],
      declaration_id: blob?.id || null,
      provider_config_sha256: null,
      collect,
      requested_bindings: requestedBindings,
      enforced_bindings: [...new Set([
        'execution_id', 'command', 'contract', 'result', 'postcondition', ...requestedBindings,
      ])].sort(),
      format: payloadSummary.format,
      context_keys: contextKeys,
      context_sha256: contextHash,
    },
    run: {
      id: runResult?.id || null,
      status: runResult?.status || null,
    },
    execution_contract: executionSnapshot,
    result: resultDescriptor,
    postcondition,
    outcomes: safeOutcomes,
    error: payloadSummary.error || null,
  });
  const hash = sha256(payload);
  return {
    evidence_ref: effectiveRef,
    created_at: createdAt,
    algorithm: 'sha256',
    hash,
    integrity: 'sha256',
    canonicalization: 'json-sort-v1',
    retention_policy: retention.policy,
    retention_until: retention.until,
    payload,
    payload_summary: payloadSummary,
  };
}

export function verifyEvidenceRecord(record) {
  const parsed = typeof record === 'string' ? safeParse(record) : record;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'evidence record must be an object' };
  }
  if (!parsed.payload || parsed.algorithm !== 'sha256' || typeof parsed.hash !== 'string') {
    return { valid: false, error: 'evidence record is missing sha256 payload metadata' };
  }
  const actualHash = sha256(parsed.payload);
  const errors = [];
  const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
  const exactKeys = (value, allowed, label, optional = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${label} must be an object`);
      return false;
    }
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    const missing = allowed.filter(key => !optional.includes(key) && !Object.hasOwn(value, key));
    if (unexpected.length > 0) errors.push(`${label} contains unexpected fields: ${unexpected.join(', ')}`);
    if (missing.length > 0) errors.push(`${label} is missing fields: ${missing.join(', ')}`);
    return unexpected.length === 0 && missing.length === 0;
  };
  const nullableSha256 = (value, label) => {
    if (value != null && !sha256Pattern.test(value)) errors.push(`${label} must be null or a sha256 digest`);
  };
  exactKeys(parsed, [
    'evidence_ref', 'created_at', 'algorithm', 'hash', 'integrity',
    'canonicalization', 'retention_policy', 'retention_until', 'payload',
    'payload_summary',
  ], 'evidence record', ['payload_summary']);
  exactKeys(parsed.payload, [
    'version', 'kind', 'created_at', 'job_id', 'evidence_ref',
    'retention_policy', 'retention_until', 'declaration', 'run',
    'execution_contract', 'result', 'postcondition', 'outcomes', 'error',
  ], 'evidence payload');
  if (parsed.payload_summary != null) {
    const summaryKeysValid = exactKeys(parsed.payload_summary, [
      'collect', 'retention', 'format', 'run_id', 'run_status',
      'output_sha256', 'outcome_fields_present',
    ], 'evidence payload summary');
    if (summaryKeysValid) {
      const expectedOutcomeFields = Object.entries(parsed.payload.outcomes || {})
        .filter(([, value]) => value != null)
        .map(([key]) => key)
        .sort();
      if (JSON.stringify(parsed.payload_summary.collect) !== JSON.stringify(parsed.payload.declaration?.collect)) {
        errors.push('evidence payload summary collect does not match declaration');
      }
      if (parsed.payload_summary.retention !== parsed.payload.retention_policy
        || parsed.payload_summary.format !== parsed.payload.declaration?.format
        || parsed.payload_summary.run_id !== parsed.payload.run?.id
        || parsed.payload_summary.run_status !== parsed.payload.run?.status
        || parsed.payload_summary.output_sha256 !== parsed.payload.result?.stdout_sha256
        || JSON.stringify(parsed.payload_summary.outcome_fields_present) !== JSON.stringify(expectedOutcomeFields)) {
        errors.push('evidence payload summary does not match canonical payload');
      }
    }
  }
  if (actualHash !== parsed.hash) errors.push('evidence payload hash mismatch');
  if (!sha256Pattern.test(parsed.hash)) errors.push('evidence hash must be a sha256 digest');
  if (parsed.payload.version !== 2) errors.push('unsupported evidence payload version');
  if (parsed.payload.kind !== 'openclaw-scheduler-checksum-evidence') {
    errors.push('unsupported evidence payload kind');
  }
  if (parsed.canonicalization !== 'json-sort-v1') errors.push('unsupported evidence canonicalization');
  if (parsed.integrity !== 'sha256') errors.push('evidence integrity marker must be sha256');
  if (typeof parsed.payload.job_id !== 'string' || !parsed.payload.job_id) {
    errors.push('evidence payload is missing job_id');
  }
  if (typeof parsed.payload.run?.id !== 'string' || !parsed.payload.run.id) {
    errors.push('evidence payload is missing run.id');
  }
  if (typeof parsed.payload.run?.status !== 'string' || !parsed.payload.run.status) {
    errors.push('evidence payload is missing run.status');
  } else if (!EVIDENCE_TERMINAL_STATUSES.has(parsed.payload.run.status)) {
    errors.push('evidence payload run.status is not terminal');
  }
  if (parsed.evidence_ref !== parsed.payload.evidence_ref) {
    errors.push('evidence_ref does not match the canonical payload');
  }
  if (parsed.created_at !== parsed.payload.created_at) {
    errors.push('created_at does not match the canonical payload');
  }
  const createdAtMs = Date.parse(parsed.created_at);
  if (!Number.isFinite(createdAtMs)) errors.push('created_at is not a valid timestamp');
  if ((parsed.retention_policy ?? null) !== (parsed.payload.retention_policy ?? null)) {
    errors.push('retention_policy does not match the canonical payload');
  }
  if ((parsed.retention_until ?? null) !== (parsed.payload.retention_until ?? null)) {
    errors.push('retention_until does not match the canonical payload');
  }
  if (Number.isFinite(createdAtMs)) {
    try {
      const normalizedRetention = normalizeEvidenceRetention(parsed.retention_policy, parsed.created_at);
      if ((parsed.retention_until ?? null) !== normalizedRetention.until) {
        errors.push('retention_until does not match retention_policy and created_at');
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  const declaration = parsed.payload.declaration;
  if (exactKeys(declaration, [
    'provider', 'methods', 'declaration_id', 'provider_config_sha256',
    'collect', 'requested_bindings', 'enforced_bindings', 'format',
    'context_keys', 'context_sha256',
  ], 'evidence declaration')) {
    if (!['sha256', 'checksum'].includes(declaration.provider)) {
      errors.push('evidence declaration provider is unsupported');
    }
    if (!Array.isArray(declaration.methods)
      || declaration.methods.length !== 1
      || declaration.methods[0] !== 'sha256') {
      errors.push('evidence declaration methods must contain only sha256');
    }
    if (declaration.provider_config_sha256 !== null) {
      errors.push('evidence declaration provider_config_sha256 must be null');
    }
    if (!Array.isArray(declaration.collect)
      || declaration.collect.length === 0
      || declaration.collect.some(item => !CHECKSUM_EVIDENCE_COLLECTIONS.has(item))
      || new Set(declaration.collect).size !== declaration.collect.length) {
      errors.push('evidence declaration collect is invalid');
    }
    if (!['canonical-json', 'json'].includes(declaration.format)) {
      errors.push('evidence declaration format is unsupported');
    }
    if (!Array.isArray(declaration.context_keys)
      || declaration.context_keys.some(key => typeof key !== 'string' || !key)
      || new Set(declaration.context_keys).size !== declaration.context_keys.length
      || [...declaration.context_keys].sort().join('\0') !== declaration.context_keys.join('\0')) {
      errors.push('evidence declaration context_keys must be unique sorted non-empty strings');
    }
    if (declaration.context_keys.length === 0 && declaration.context_sha256 !== null) {
      errors.push('evidence declaration context_sha256 must be null without context keys');
    } else if (declaration.context_keys.length > 0) {
      nullableSha256(declaration.context_sha256, 'evidence declaration context_sha256');
      if (declaration.context_sha256 === null) errors.push('evidence declaration context_sha256 is required');
    }
  }
  exactKeys(parsed.payload.run, ['id', 'status'], 'evidence run');
  if (!parsed.payload.execution_contract?.command
    || !parsed.payload.execution_contract?.contract
    || !parsed.payload.execution_contract?.job_snapshot) {
    errors.push('evidence payload is missing the execution contract');
  } else {
    exactKeys(parsed.payload.execution_contract, ['command', 'contract', 'job_snapshot', 'hash'], 'execution contract');
    exactKeys(parsed.payload.execution_contract.command, [
      'session_target', 'payload_kind', 'execution_intent', 'payload_bytes',
      'payload_sha256', 'auth_profile',
    ], 'execution command');
    exactKeys(parsed.payload.execution_contract.contract, [
      'required_trust_level', 'trust_enforcement', 'sandbox_sha256',
      'allowed_paths_sha256', 'network_sha256', 'max_cost_usd',
      'audit_sha256', 'child_credential_policy',
    ], 'execution contract declaration');
    exactKeys(parsed.payload.execution_contract.job_snapshot, [
      'job_id', 'agent_id', 'payload_model', 'payload_model_fallback',
      'payload_thinking', 'payload_timeout_seconds', 'run_timeout_ms',
      'shell_env_policy', 'output_format', 'auth_profile',
      'auth_profile_fallback', 'job_type', 'watchdog_check_sha256',
      'parent_id', 'trigger_on', 'trigger_condition_sha256', 'schedule_kind',
      'schedule_cron', 'schedule_at', 'schedule_tz', 'overlap_policy',
      'max_retries', 'approval_required', 'approval_risk_level',
      'approval_approver_scope', 'identity_ref', 'identity_sha256',
      'authorization_proof_ref', 'authorization_proof_sha256',
      'authorization_ref', 'authorization_sha256',
      'evidence_declaration_sha256',
    ], 'execution job snapshot');
    if (!Number.isSafeInteger(parsed.payload.execution_contract.command.payload_bytes)
      || parsed.payload.execution_contract.command.payload_bytes < 0) {
      errors.push('execution command payload_bytes must be a non-negative integer');
    }
    nullableSha256(parsed.payload.execution_contract.command.payload_sha256, 'execution command payload_sha256');
    for (const field of ['sandbox_sha256', 'allowed_paths_sha256', 'network_sha256', 'audit_sha256']) {
      nullableSha256(parsed.payload.execution_contract.contract[field], `execution contract ${field}`);
    }
    for (const field of [
      'watchdog_check_sha256', 'trigger_condition_sha256', 'identity_sha256',
      'authorization_proof_sha256', 'authorization_sha256',
      'evidence_declaration_sha256',
    ]) {
      nullableSha256(parsed.payload.execution_contract.job_snapshot[field], `execution job snapshot ${field}`);
    }
    if (parsed.payload.execution_contract.job_snapshot.job_id !== parsed.payload.job_id) {
      errors.push('execution job snapshot job_id does not match evidence job_id');
    }
    if (sha256({
      command: parsed.payload.execution_contract.command,
      contract: parsed.payload.execution_contract.contract,
      job_snapshot: parsed.payload.execution_contract.job_snapshot,
    }) !== parsed.payload.execution_contract.hash) {
      errors.push('execution contract hash mismatch');
    }
  }
  const requiredBindings = ['execution_id', 'command', 'contract', 'result', 'postcondition'];
  const enforcedBindings = parsed.payload.declaration?.enforced_bindings;
  const requestedBindings = parsed.payload.declaration?.requested_bindings;
  if (!Array.isArray(requestedBindings)
    || requestedBindings.some(binding => !CHECKSUM_EVIDENCE_BINDINGS.has(binding))
    || new Set(requestedBindings).size !== requestedBindings.length) {
    errors.push('evidence payload requested bindings are invalid');
  }
  if (!Array.isArray(enforcedBindings)
    || enforcedBindings.some(binding => !CHECKSUM_EVIDENCE_BINDINGS.has(binding))
    || new Set(enforcedBindings).size !== enforcedBindings.length
    || requiredBindings.some(binding => !enforcedBindings.includes(binding))
    || (Array.isArray(requestedBindings)
      && requestedBindings.some(binding => !enforcedBindings.includes(binding)))) {
    errors.push('evidence payload is missing required enforced bindings');
  }
  if (!parsed.payload.result || !parsed.payload.postcondition) {
    errors.push('evidence payload is missing result or postcondition');
  } else {
    exactKeys(parsed.payload.result, [
      'status', 'summary_sha256', 'stdout_sha256', 'stderr_sha256',
      'stdout_bytes', 'stderr_bytes', 'exit_code', 'signal', 'timed_out',
      'structured_output_sha256',
    ], 'evidence result');
    exactKeys(parsed.payload.postcondition, [
      'terminal_status', 'succeeded', 'structured_output_valid',
    ], 'evidence postcondition');
    for (const field of ['summary_sha256', 'stdout_sha256', 'stderr_sha256', 'structured_output_sha256']) {
      nullableSha256(parsed.payload.result[field], `evidence result ${field}`);
    }
    for (const field of ['stdout_bytes', 'stderr_bytes']) {
      const value = parsed.payload.result[field];
      if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
        errors.push(`evidence result ${field} must be null or a non-negative integer`);
      }
    }
    if (typeof parsed.payload.result.timed_out !== 'boolean') {
      errors.push('evidence result timed_out must be boolean');
    }
    if (parsed.payload.result.status !== parsed.payload.run.status
      || parsed.payload.postcondition.terminal_status !== parsed.payload.run.status) {
      errors.push('evidence result and postcondition status must match run status');
    }
    if (parsed.payload.postcondition.succeeded !== (parsed.payload.run.status === 'ok')) {
      errors.push('evidence postcondition succeeded flag is inconsistent with run status');
    }
  }
  if (exactKeys(parsed.payload.outcomes, [
    'identity', 'trust', 'authorization', 'authorization_proof',
    'credential_handoff', 'governance', 'delegation',
  ], 'evidence outcomes')) {
    const outcomeKeys = {
      identity: ['provider', 'source', 'subject_kind', 'principal', 'trust_level', 'delegation_mode', 'error_sha256'],
      trust: ['decision', 'required', 'actual', 'enforcement', 'reason_sha256'],
      authorization: ['decision', 'provider_decision', 'provider', 'source', 'ref', 'human_override', 'approval_id', 'policy_digest', 'provider_context_hash', 'decision_context_hash', 'reason_sha256'],
      authorization_proof: ['method', 'verified', 'issuer', 'principal', 'provider', 'source', 'manifest_digest', 'error_sha256'],
      credential_handoff: ['mode', 'bindings_count', 'cleanup_required', 'error_sha256'],
      governance: ['allowed', 'violations_sha256', 'warnings_sha256'],
      delegation: ['valid', 'depth', 'acyclic', 'no_duplicate_hops', 'errors_sha256'],
    };
    for (const [key, allowed] of Object.entries(outcomeKeys)) {
      if (parsed.payload.outcomes[key] != null) exactKeys(parsed.payload.outcomes[key], allowed, `evidence outcome ${key}`);
    }
  }
  if (Array.isArray(requestedBindings)) {
    const outcomes = parsed.payload.outcomes || {};
    const bindingPresence = {
      identity: outcomes.identity != null,
      trust: outcomes.trust != null,
      authorization: outcomes.authorization != null,
      authorization_proof: outcomes.authorization_proof != null,
      delegation: outcomes.delegation != null,
      credential_handoff: outcomes.credential_handoff != null,
      context: Array.isArray(parsed.payload.declaration?.context_keys)
        && parsed.payload.declaration.context_keys.length > 0
        && typeof parsed.payload.declaration.context_sha256 === 'string',
    };
    for (const binding of requestedBindings) {
      if (Object.hasOwn(bindingPresence, binding) && bindingPresence[binding] !== true) {
        errors.push(`evidence payload is missing requested ${binding} binding data`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    algorithm: 'sha256',
    expected_hash: parsed.hash,
    actual_hash: actualHash,
    ...(errors.length === 0 ? {} : { error: errors.join('; '), errors }),
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
