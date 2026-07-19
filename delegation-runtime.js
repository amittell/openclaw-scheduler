import { getDb } from './db.js';
import { getHandoffArtifact } from './handoff-artifact.js';
import { appendRuntimeEvent } from './runtime-events.js';

const MAX_ABSOLUTE_DELEGATION_DEPTH = 128;

function delegationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sourceRunForDispatch(db, dispatchRecord) {
  if (!dispatchRecord?.source_run_id) return null;
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(dispatchRecord.source_run_id) || null;
}

function validateSourceSemantics(job, dispatchRecord, sourceRun, policy) {
  const kind = dispatchRecord?.dispatch_kind;
  if (!sourceRun) {
    throw delegationError(
      'DELEGATION_SOURCE_RUN_REQUIRED',
      'Artifact-bound chain, retry, replay, or delegated execution requires an exact source run',
    );
  }
  if (kind === 'chain') {
    if (!job.parent_id || sourceRun.job_id !== job.parent_id || sourceRun.status !== 'ok') {
      throw delegationError(
        'DELEGATION_SOURCE_RUN_INVALID',
        'Chain dispatch source must be a successful run of the declared parent job',
      );
    }
  } else if (dispatchRecord?.replay_of_run_id) {
    if (
      dispatchRecord.replay_of_run_id !== sourceRun.id
      || sourceRun.job_id !== job.id
      || !['ok', 'error', 'cancelled', 'crashed'].includes(sourceRun.status)
    ) {
      throw delegationError(
        'DELEGATION_SOURCE_RUN_INVALID',
        'Replay dispatch source must be the exact terminal run being replayed',
      );
    }
  } else if (kind === 'retry') {
    if (sourceRun.job_id !== job.id || !['error', 'timeout'].includes(sourceRun.status)) {
      throw delegationError(
        'DELEGATION_SOURCE_RUN_INVALID',
        'Retry dispatch source must be an errored or timed-out run of the same job',
      );
    }
  } else if (policy.mode && policy.mode !== 'none' && sourceRun.status !== 'ok') {
    throw delegationError(
      'DELEGATION_SOURCE_RUN_INVALID',
      'Delegated authority requires a successful exact source run',
    );
  }
}

function identityPrincipal(run) {
  const identity = parseJson(run.identity_resolved, {});
  return identity?.principal
    ?? identity?.subject_principal
    ?? identity?.session?.principal
    ?? identity?.session?.subject?.principal
    ?? null;
}

function normalizeScopes(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === 'string') return new Set([value]);
  throw delegationError('DELEGATION_SCOPE_INVALID', 'Delegation scope must be a string, array, or null');
}

function assertScopeNotEscalated(parentScope, childScope) {
  const parent = normalizeScopes(parentScope);
  const child = normalizeScopes(childScope);
  if (!parent) return;
  if (!child || [...child].some(scope => !parent.has(scope))) {
    throw delegationError(
      'DELEGATION_SCOPE_ESCALATION',
      'Delegated scope exceeds the exact source artifact scope',
    );
  }
}

function traceSourceRuns(db, initialRunId, maxDepth) {
  const visited = new Set();
  const hops = [];
  let runId = initialRunId;
  while (runId) {
    if (visited.has(runId)) {
      throw delegationError('DELEGATION_CYCLE', `Delegation source cycle detected at run ${runId}`);
    }
    if (hops.length >= maxDepth || hops.length >= MAX_ABSOLUTE_DELEGATION_DEPTH) {
      throw delegationError(
        'DELEGATION_DEPTH_EXCEEDED',
        `Delegation depth exceeds the configured maximum of ${Math.min(maxDepth, MAX_ABSOLUTE_DELEGATION_DEPTH)}`,
      );
    }
    visited.add(runId);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) {
      throw delegationError('DELEGATION_SOURCE_RUN_MISSING', `Delegation source run ${runId} no longer exists`);
    }
    hops.push(run);
    runId = run.source_run_id || run.triggered_by_run || null;
  }
  return hops;
}

function validateGrantChain(sourceRun, policy) {
  if (!policy.require_grant_per_hop) return;
  const identity = parseJson(sourceRun.identity_resolved, {});
  const chain = identity?.delegation_chain
    ?? identity?.session?.delegation_chain
    ?? identity?.raw?.delegation_chain
    ?? [];
  if (!Array.isArray(chain) || chain.length === 0) {
    throw delegationError(
      'DELEGATION_GRANT_REQUIRED',
      `Source run ${sourceRun.id} does not contain a delegation grant chain`,
    );
  }
  for (const [index, hop] of chain.entries()) {
    if (!hop || typeof hop !== 'object' || hop.validated !== true || !hop.grant) {
      throw delegationError(
        'DELEGATION_GRANT_INVALID',
        `Delegation grant hop ${index + 1} on source run ${sourceRun.id} is not validated`,
      );
    }
  }
}

/**
 * Validate v4 delegation against the exact source run persisted on the durable
 * dispatch. This intentionally never searches for a latest successful run.
 */
export function validateArtifactBoundDelegation(job, artifactRecord, dispatchRecord, ctx = {}, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  const db = opts.db || getDb();
  const artifact = artifactRecord?.payload
    ? artifactRecord
    : getHandoffArtifact(job.handoff_artifact_digest, { db });
  if (!artifact) {
    throw delegationError('HANDOFF_ARTIFACT_REQUIRED', 'Handoff artifact is required for delegation');
  }
  const policy = artifact.payload.delegation ?? {};
  const requiresSource = Boolean(
    job.parent_id
    || ['chain', 'retry'].includes(dispatchRecord?.dispatch_kind)
    || dispatchRecord?.replay_of_run_id
    || (policy.mode && policy.mode !== 'none'),
  );
  if (!requiresSource) {
    return Object.freeze({
      valid: true,
      source_run_id: null,
      source_artifact_digest: null,
      depth: 0,
      grants_verified: 0,
    });
  }

  const sourceRun = sourceRunForDispatch(db, dispatchRecord);
  validateSourceSemantics(job, dispatchRecord, sourceRun, policy);
  if (!sourceRun.handoff_artifact_digest) {
    throw delegationError(
      'DELEGATION_SOURCE_ARTIFACT_REQUIRED',
      `Source run ${sourceRun.id} has no handoff artifact binding`,
    );
  }
  const declaredSourceArtifact = dispatchRecord.source_run_handoff_artifact_digest;
  if (
    declaredSourceArtifact !== sourceRun.handoff_artifact_digest
    || (ctx.sourceArtifactDigest && ctx.sourceArtifactDigest !== sourceRun.handoff_artifact_digest)
  ) {
    throw delegationError(
      'DELEGATION_SOURCE_ARTIFACT_MISMATCH',
      'Dispatch source artifact does not match the exact source run artifact',
    );
  }
  const sourceArtifact = getHandoffArtifact(sourceRun.handoff_artifact_digest, { db });
  if (!sourceArtifact) {
    throw delegationError(
      'DELEGATION_SOURCE_ARTIFACT_REQUIRED',
      `Source run ${sourceRun.id} artifact is not retrievable`,
    );
  }
  const sourceJob = db.prepare('SELECT handoff_artifact_digest FROM jobs WHERE id = ?').get(sourceRun.job_id);
  if (!sourceJob || sourceJob.handoff_artifact_digest !== sourceRun.handoff_artifact_digest) {
    throw delegationError(
      'DELEGATION_STALE_PARENT',
      'Exact source run is bound to a stale parent artifact',
    );
  }
  assertScopeNotEscalated(sourceArtifact.payload.identity?.scope, artifact.payload.identity?.scope);
  const allowedDelegators = policy.allowed_delegators ?? [];
  if (policy.mode && policy.mode !== 'none') {
    const principal = identityPrincipal(sourceRun);
    if (!principal || !allowedDelegators.includes(principal)) {
      throw delegationError(
        'DELEGATION_DELEGATOR_NOT_ALLOWED',
        'Exact source-run principal is not an allowed delegator',
      );
    }
  }

  const maxDepth = Number.isInteger(policy.max_depth) && policy.max_depth > 0
    ? policy.max_depth
    : 16;
  const hops = traceSourceRuns(db, sourceRun.id, maxDepth);
  for (const hop of hops) validateGrantChain(hop, policy);

  const outcome = Object.freeze({
    valid: true,
    source_run_id: sourceRun.id,
    source_artifact_digest: sourceRun.handoff_artifact_digest,
    depth: hops.length,
    grants_verified: policy.require_grant_per_hop ? hops.length : 0,
    delegator: identityPrincipal(sourceRun),
    scope_non_escalating: true,
    stale_parent_rejected: false,
    chain_run_ids: Object.freeze(hops.map(hop => hop.id)),
  });
  appendRuntimeEvent('delegation.validated', {
    jobId: job.id,
    runId: ctx.runId,
    handoffArtifactDigest: job.handoff_artifact_digest,
    sourceRunId: sourceRun.id,
    sourceRunHandoffArtifactDigest: sourceRun.handoff_artifact_digest,
    dispatchQueueId: dispatchRecord?.id,
    payload: outcome,
  }, { db });
  return outcome;
}
