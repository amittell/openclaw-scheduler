import { getDb } from './db.js';
import { getIdentityProvider } from './provider-registry.js';
import {
  adoptProviderSession,
  resolveProviderSession,
  resumeProviderSession,
} from './provider-session-store.js';
import { appendRuntimeEvent } from './runtime-events.js';

const TRUST_ORDER = ['untrusted', 'restricted', 'supervised', 'autonomous'];

function identityError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function trustLevel(session, profile, row) {
  return session?.trust?.level
    || session?.trust_level
    || profile?.trust?.level
    || (row?.session_summary && parseJson(row.session_summary)?.trust_level)
    || null;
}

function assertNotElevated(child, parent) {
  const childIndex = TRUST_ORDER.indexOf(child);
  const parentIndex = TRUST_ORDER.indexOf(parent);
  if (parentIndex < 0) {
    throw identityError(
      'CHILD_CREDENTIAL_TRUST_UNAVAILABLE',
      'Exact source-run trust level is missing or unrecognized',
    );
  }
  if (childIndex < 0) {
    throw identityError(
      'CHILD_CREDENTIAL_TRUST_UNAVAILABLE',
      'Child trust level is missing or unrecognized',
    );
  }
  if (childIndex > parentIndex) {
    throw identityError(
      'CHILD_CREDENTIAL_TRUST_ELEVATION',
      'Child trust level ' + child + ' exceeds exact source-run trust level ' + parent,
    );
  }
}

function sourceIdentity(db, run) {
  if (!run.source_run_id) return null;
  const source = db.prepare(
    'SELECT r.id, r.job_id, r.status, r.handoff_artifact_digest, r.identity_resolved, '
      + 'j.identity AS job_identity FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.id = ?',
  ).get(run.source_run_id);
  if (!source) {
    throw identityError('DELEGATION_SOURCE_RUN_MISSING', 'Exact source run is missing');
  }
  const identity = parseJson(source.identity_resolved);
  return { run: source, identity, profile: parseJson(source.job_identity) };
}

function requestFor(profile, artifact, run, extra = {}) {
  return {
    subject: profile.subject || null,
    principal: profile.subject?.principal || profile.principal || null,
    scope: profile.scope || profile.auth?.scopes || null,
    audience: profile.auth?.audience || null,
    resource: profile.auth?.resource || null,
    provider_config_hash: artifact.identity.auth_hash,
    inputs_hash: artifact.identity.auth_hash,
    runtime_instance_id: run.runtime_instance_id,
    ...extra,
  };
}

function outcome(provider, handle, profile, source, extra = {}) {
  const session = handle.session;
  return {
    provider: provider.name,
    provider_session_id: handle.row.id,
    provider_session_status: handle.row.status,
    source,
    subject_kind: session?.subject?.kind || profile.subject?.kind || 'unknown',
    principal: session?.subject?.principal
      || session?.principal
      || profile.subject?.principal
      || null,
    trust_level: trustLevel(session, profile, handle.row),
    delegation_mode: profile.subject?.delegation_mode || profile.delegation_mode || null,
    session,
    session_summary: parseJson(handle.row.session_summary, {}),
    profile_hash: handle.row.cache_key_hash,
    ...extra,
  };
}

export async function resolveArtifactBoundIdentity(job, artifactRecord, run, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  const db = opts.db || getDb();
  const artifact = artifactRecord?.payload ? artifactRecord.payload : artifactRecord;
  const profile = parseJson(job.identity);
  const policy = job.child_credential_policy || 'none';
  const source = sourceIdentity(db, run);

  if (!profile) {
    if (artifact.identity?.provider) {
      throw identityError('IDENTITY_DECLARATION_REQUIRED', 'Artifact identity provider has no job declaration');
    }
    return null;
  }
  const providerName = profile.provider || profile.auth?.provider;
  if (!providerName) {
    if (artifact.identity?.presentation?.handoff !== 'none') {
      throw identityError('IDENTITY_PROVIDER_REQUIRED', 'Credential presentation requires an identity provider');
    }
    return {
      source: 'declaration',
      subject_kind: profile.subject?.kind || 'unknown',
      principal: profile.subject?.principal || null,
      trust_level: profile.trust?.level || null,
      delegation_mode: profile.subject?.delegation_mode || null,
      profile_hash: artifact.identity?.subject_hash || null,
    };
  }
  const provider = opts.getIdentityProvider?.(providerName) || getIdentityProvider(providerName);
  if (!provider) {
    throw identityError('IDENTITY_PROVIDER_NOT_LOADED', 'Identity provider not loaded: ' + providerName);
  }
  const ctx = {
    jobId: job.id,
    runId: run.id,
    artifactDigest: job.handoff_artifact_digest,
    sourceRunId: run.source_run_id,
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
  };

  let handle;
  let sourceLabel = 'provider-v4';
  if (source && policy === 'none') {
    return null;
  }
  if (source && ['inherit', 'downscope'].includes(policy)) {
    const parentIdentity = source.identity;
    if (!parentIdentity?.provider_session_id || parentIdentity.provider !== providerName) {
      throw identityError(
        'CHILD_CREDENTIAL_SOURCE_UNAVAILABLE',
        'Exact source run does not expose a compatible provider session',
      );
    }
    const parentHandle = await resumeProviderSession(
      provider,
      parentIdentity.provider_session_id,
      {
        ...ctx,
        artifactDigest: source.run.handoff_artifact_digest,
        childArtifactDigest: ctx.artifactDigest,
      },
      { db },
    );
    if (policy === 'inherit') {
      handle = parentHandle;
      sourceLabel = 'exact-source-run-inherit';
    } else {
      if (typeof provider.prepareHandoff !== 'function') {
        throw identityError(
          'CHILD_CREDENTIAL_DOWNSCOPE_UNSUPPORTED',
          'Provider ' + providerName + ' does not implement prepareHandoff()',
        );
      }
      const prepared = await provider.prepareHandoff(
        parentHandle.session,
        {
          target_scope: profile.scope || profile.auth?.scopes || null,
          parent_profile: source.profile || null,
          source_run_id: source.run.id,
          source_artifact_digest: source.run.handoff_artifact_digest,
        },
        ctx,
      );
      if (prepared?.prepared !== true || !prepared.session) {
        throw identityError(
          'CHILD_CREDENTIAL_DOWNSCOPE_FAILED',
          prepared?.reason || 'Provider did not produce a downscoped session',
        );
      }
      handle = adoptProviderSession(
        provider,
        requestFor(profile, artifact, run, {
          source_run_id: source.run.id,
          downscope: true,
        }),
        {
          session: prepared.session,
          expires_at: prepared.expires_at,
          refresh_after: prepared.refresh_after,
          rotation_id: prepared.rotation_id,
        },
        ctx,
        { db },
      );
      assertNotElevated(
        trustLevel(handle.session, profile, handle.row),
        parentIdentity.trust_level,
      );
      sourceLabel = 'exact-source-run-downscope';
    }
  } else {
    handle = await resolveProviderSession(
      provider,
      requestFor(profile, artifact, run),
      ctx,
      { db },
    );
    if (source && policy === 'independent') {
      assertNotElevated(
        trustLevel(handle.session, profile, handle.row),
        source.identity?.trust_level,
      );
      sourceLabel = 'independent-capped-to-source-run';
    }
  }

  const resolved = outcome(provider, handle, profile, sourceLabel, {
    source_run_id: source?.run.id || null,
    source_run_handoff_artifact_digest: source?.run.handoff_artifact_digest || null,
  });
  appendRuntimeEvent('identity.resolved', {
    jobId: job.id,
    runId: run.id,
    handoffArtifactDigest: job.handoff_artifact_digest,
    sourceRunId: source?.run.id,
    sourceRunHandoffArtifactDigest: source?.run.handoff_artifact_digest,
    payload: {
      provider: provider.name,
      provider_session_id: handle.row.id,
      source: sourceLabel,
      principal: resolved.principal,
      trust_level: resolved.trust_level,
    },
  }, { db });
  return resolved;
}
