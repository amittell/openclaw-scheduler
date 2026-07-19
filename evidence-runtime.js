import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import {
  assertArtifactMatchesJob,
  canonicalStringify,
  sha256,
} from './handoff-artifact.js';
import { getEvidenceProvider as getRuntimeEvidenceProvider } from './provider-registry.js';
import { appendRuntimeEvent } from './runtime-events.js';

let agentcliPromise = null;

function evidenceError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function durationMs(run) {
  if (Number.isInteger(run.duration_ms) && run.duration_ms >= 0) return run.duration_ms;
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.finished_at || run.terminal_transition_at || '');
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function retentionUntil(policy, now = Date.now()) {
  if (!policy || /^(forever|indefinite)$/i.test(policy)) return null;
  const match = /^(\d+)([mhdwy])$/i.exec(policy);
  if (!match) return null;
  const unitMs = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };
  return new Date(now + Number(match[1]) * unitMs[match[2].toLowerCase()]).toISOString();
}

function evidenceRecord(run, job, artifact, timestamp) {
  return {
    execution_id: run.id,
    timestamp,
    source: {
      workflow_id: artifact.manifest.workflow_id,
      task_id: artifact.manifest.task_id,
    },
    manifest_digest: artifact.manifest.digest,
    effective_task_hash: artifact.compiled.effective_task_hash,
    handoff_artifact_digest: run.handoff_artifact_digest,
    source_run_id: run.source_run_id,
    source_run_handoff_artifact_digest: run.source_run_handoff_artifact_digest,
    declared_identity: parseJson(job.identity),
    resolved_identity: parseJson(run.identity_resolved),
    authorization_proof: parseJson(run.authorization_proof_verification),
    authorization: parseJson(run.authorization_decision),
    actor_context: {
      runtime_instance_id: run.runtime_instance_id,
      dispatcher_owner: run.dispatcher_owner,
      dispatcher_token: run.dispatcher_token,
    },
    contract: artifact.contract,
    command: commandEvidence(artifact),
    result: resultEvidence(run),
    verify: parseJson(run.verification_result),
  };
}

async function loadAgentcli(opts = {}) {
  if (opts.agentcli) return opts.agentcli;
  if (!agentcliPromise) {
    agentcliPromise = Promise.all([
      import('@amittell/agentcli/evidence'),
      import('@amittell/agentcli/evidence/payload'),
      import('@amittell/agentcli/evidence/ssh'),
    ]).then(([evidence, payload]) => ({ ...evidence, ...payload })).catch(error => {
      agentcliPromise = null;
      throw evidenceError(
        'AGENTCLI_RUNTIME_UNAVAILABLE',
        'Handoff v4 evidence requires @amittell/agentcli: ' + error.message,
      );
    });
  }
  return agentcliPromise;
}

function commandEvidence(artifact) {
  const command = artifact.command;
  return {
    program: command.program || (
      command.kind === 'prompt' ? 'openclaw-agent-turn' : 'openclaw-system-event'
    ),
    cwd: command.cwd,
    args_count: command.args_count ?? 0,
    args_hashes: command.args_sha256 ?? [],
    env_keys: command.env?.effective_env_keys ?? [],
    env_hashes: command.env?.effective_env_value_sha256 ?? {},
    env_hash: command.env?.declared_env_sha256
      || sha256(canonicalStringify(command.env?.effective_env_value_sha256 ?? {})),
    stdin_present: command.stdin_sha256 != null,
    stdin_hash: command.stdin_sha256,
  };
}

function resultEvidence(run) {
  const output = {
    status: run.status,
    summary: run.summary,
    stdout_sha256: run.shell_stdout == null ? null : sha256(run.shell_stdout),
    stderr_sha256: run.shell_stderr == null ? null : sha256(run.shell_stderr),
    structured_output_sha256: run.structured_output_sha256,
  };
  return {
    exit_code: run.shell_exit_code ?? (run.status === 'ok' ? 0 : 1),
    signal: run.shell_signal ?? null,
    timed_out: run.status === 'timeout' || Boolean(run.shell_timed_out),
    duration_ms: durationMs(run),
    stdout_bytes: run.shell_stdout_bytes ?? 0,
    stderr_bytes: run.shell_stderr_bytes ?? 0,
    output_hash: sha256(canonicalStringify(output)),
  };
}

async function resolveProvider(profile, agentcli, ctx) {
  const runtimeProvider = getRuntimeEvidenceProvider(profile.provider);
  if (runtimeProvider) return { provider: runtimeProvider, source: 'scheduler-plugin' };
  const provider = agentcli.resolveEvidenceProvider({
    evidenceProvider: profile.provider,
    env: ctx.env,
  });
  return { provider, source: 'agentcli' };
}

function evidencePrincipal(profile, opts = {}) {
  const config = profile.provider_config || {};
  const env = opts.env || process.env;
  return config.principal
    || opts.principal
    || env.AGENTCLI_EVIDENCE_PRINCIPAL
    || env.USER
    || 'agentcli';
}

function providerVerifyOptions(profile, record, opts, principal) {
  const config = profile.provider_config || {};
  return {
    record,
    principal,
    allowedSignersPath: config.allowed_signers_path
      || config.allowed_signers
      || opts.allowedSignersPath
      || (opts.env || process.env).AGENTCLI_ALLOWED_SIGNERS,
  };
}

function assertVerifiedEvidencePayload(agentcli, envelope, verification, record) {
  const payload = verification?.payload || parseJson(envelope?.signed_payload);
  const payloadValidation = agentcli.validateCompleteEvidencePayload(payload);
  if (!payloadValidation.valid) {
    throw evidenceError(
      'EVIDENCE_PAYLOAD_INVALID',
      `Verified evidence payload is invalid: ${payloadValidation.errors.join('; ')}`,
    );
  }
  const binding = agentcli.validateEvidenceRecordBinding(payload, record);
  if (!binding.valid) {
    throw evidenceError(
      'EVIDENCE_BINDING_MISMATCH',
      `Verified evidence does not match the execution record: ${binding.errors.join('; ')}`,
    );
  }
  return payload;
}

export async function prepareArtifactBoundEvidence(job, artifactRecord, run, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  if (!run?.id) throw evidenceError('RUN_NOT_FOUND', 'Evidence preparation requires a run');
  const artifact = artifactRecord?.payload ? artifactRecord.payload : artifactRecord;
  const profile = parseJson(job.evidence);
  if (!profile) {
    if (artifact.evidence?.signed_or_provider_verified_required) {
      throw evidenceError('EVIDENCE_PROVIDER_REQUIRED', 'Artifact requires signed or provider-verified evidence');
    }
    return null;
  }
  if (!profile.provider) {
    throw evidenceError('EVIDENCE_PROVIDER_REQUIRED', 'Handoff v4 evidence provider is missing');
  }
  const agentcli = await loadAgentcli(opts);
  const timestamp = opts.timestamp
    || run.finished_at
    || run.terminal_transition_at
    || new Date().toISOString();
  const payload = agentcli.buildCompleteEvidencePayload({
    executionId: run.id,
    timestamp,
    source: {
      workflow_id: artifact.manifest.workflow_id,
      task_id: artifact.manifest.task_id,
    },
    manifestDigest: artifact.manifest.digest,
    effectiveTaskHash: artifact.compiled.effective_task_hash,
    handoffArtifactDigest: run.handoff_artifact_digest,
    sourceRunId: run.source_run_id,
    sourceRunHandoffArtifactDigest: run.source_run_handoff_artifact_digest,
    declaredIdentity: parseJson(job.identity),
    resolvedIdentity: parseJson(run.identity_resolved),
    authorizationProof: parseJson(run.authorization_proof_verification),
    authorization: parseJson(run.authorization_decision),
    actorContext: {
      runtime_instance_id: run.runtime_instance_id,
      dispatcher_owner: run.dispatcher_owner,
      dispatcher_token: run.dispatcher_token,
    },
    contract: artifact.contract,
    command: commandEvidence(artifact),
    result: resultEvidence(run),
    verify: parseJson(run.verification_result),
    complianceContext: profile.payload?.context || {},
  });
  const serialized = agentcli.serializePayload(payload, 'canonical-json');
  const { provider, source } = await resolveProvider(profile, agentcli, {
    env: opts.env || process.env,
  });
  const principal = evidencePrincipal(profile, opts);
  const providerConfig = await provider.resolve(profile.provider_config || {}, {
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    principal,
  });
  if (!providerConfig) {
    throw evidenceError(
      'EVIDENCE_PROVIDER_RESOLUTION_FAILED',
      'Evidence provider ' + profile.provider + ' did not resolve signing credentials',
    );
  }
  const attestation = await provider.attest(serialized, providerConfig, {
    runId: run.id,
    artifactDigest: run.handoff_artifact_digest,
  });
  if (attestation?.attested !== true || !attestation.envelope) {
    throw evidenceError(
      'EVIDENCE_ATTESTATION_FAILED',
      attestation?.reason || 'Evidence provider did not produce an envelope',
    );
  }

  const record = evidenceRecord(run, job, artifact, timestamp);
  const verifyOptions = providerVerifyOptions(profile, record, opts, principal);
  const verification = source === 'agentcli'
    ? await agentcli.verifyEvidenceEnvelope(attestation.envelope, verifyOptions, {
        runId: run.id,
        artifactDigest: run.handoff_artifact_digest,
      })
    : await provider.verify(attestation.envelope, verifyOptions, {
        runId: run.id,
        artifactDigest: run.handoff_artifact_digest,
      });
  if (verification?.verified !== true) {
    throw evidenceError(
      'EVIDENCE_VERIFICATION_FAILED',
      verification?.reason || 'Evidence provider verification failed',
    );
  }
  assertVerifiedEvidencePayload(agentcli, attestation.envelope, verification, record);

  const envelopeText = canonicalStringify(attestation.envelope);
  const envelopeHash = attestation.envelope.payload_digest || sha256(envelopeText);
  const retentionPolicy = profile.retention || artifact.evidence.retention || null;
  return Object.freeze({
    runId: run.id,
    jobId: job.id,
    evidenceRef: profile.ref || job.evidence_ref || null,
    provider: profile.provider,
    method: attestation.envelope.method,
    envelopeText,
    envelopeHash,
    serialized,
    retentionPolicy,
    retentionUntil: retentionUntil(retentionPolicy),
    timestamp,
    status: run.status,
    handoffArtifactDigest: run.handoff_artifact_digest,
    sourceRunId: run.source_run_id ?? null,
    sourceRunHandoffArtifactDigest: run.source_run_handoff_artifact_digest ?? null,
  });
}

export function persistPreparedArtifactBoundEvidence(prepared, opts = {}) {
  if (!prepared) return null;
  const db = opts.db || getDb();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(prepared.runId);
  if (!run) throw evidenceError('RUN_NOT_FOUND', 'Evidence run not found: ' + prepared.runId);
  if (!run.finished_at && !run.terminal_transition_at) {
    throw evidenceError('EVIDENCE_RUN_NOT_TERMINAL', 'Artifact-bound evidence requires a terminal run');
  }
  if (
    run.job_id !== prepared.jobId
    || run.status !== prepared.status
    || run.handoff_artifact_digest !== prepared.handoffArtifactDigest
    || (run.source_run_id ?? null) !== prepared.sourceRunId
    || (run.source_run_handoff_artifact_digest ?? null)
      !== prepared.sourceRunHandoffArtifactDigest
  ) {
    throw evidenceError('EVIDENCE_BINDING_MISMATCH', 'Prepared evidence does not match the terminal run');
  }
  const existing = db.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(run.id);
  if (existing) {
    if (
      existing.hash !== prepared.envelopeHash
      || existing.handoff_artifact_digest !== run.handoff_artifact_digest
      || (existing.source_run_id ?? null) !== (run.source_run_id ?? null)
      || (existing.source_run_handoff_artifact_digest ?? null)
        !== (run.source_run_handoff_artifact_digest ?? null)
      || existing.evidence_verified !== 1
    ) {
      throw evidenceError('EVIDENCE_RECORD_IMMUTABLE', 'Existing evidence does not match the run binding');
    }
    return existing;
  }

  const rowId = randomUUID();
  const write = () => {
    db.prepare(
      'INSERT INTO evidence_records '
      + '(id, run_id, job_id, evidence_ref, algorithm, hash, payload, '
      + 'retention_policy, retention_until, handoff_artifact_digest, source_run_id, '
      + 'source_run_handoff_artifact_digest, evidence_method, evidence_verified, '
      + 'evidence_envelope, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      rowId,
      run.id,
      prepared.jobId,
      prepared.evidenceRef,
      'sha256',
      prepared.envelopeHash,
      prepared.serialized,
      prepared.retentionPolicy,
      prepared.retentionUntil,
      prepared.handoffArtifactDigest,
      prepared.sourceRunId,
      prepared.sourceRunHandoffArtifactDigest,
      prepared.method,
      prepared.envelopeText,
      prepared.timestamp,
    );
    db.prepare('UPDATE runs SET evidence_record = ? WHERE id = ?').run(
      JSON.stringify({
        id: rowId,
        method: prepared.method,
        verified: true,
        hash: prepared.envelopeHash,
        handoff_artifact_digest: prepared.handoffArtifactDigest,
        source_run_id: prepared.sourceRunId,
        source_run_handoff_artifact_digest: prepared.sourceRunHandoffArtifactDigest,
      }),
      run.id,
    );
    appendRuntimeEvent('evidence.verified', {
      jobId: prepared.jobId,
      runId: run.id,
      handoffArtifactDigest: prepared.handoffArtifactDigest,
      sourceRunId: prepared.sourceRunId,
      sourceRunHandoffArtifactDigest: prepared.sourceRunHandoffArtifactDigest,
      payload: {
        evidence_record_id: rowId,
        provider: prepared.provider,
        method: prepared.method,
        hash: prepared.envelopeHash,
        verified: true,
      },
    }, { db });
  };
  if (db.inTransaction) write();
  else db.transaction(write).immediate();
  return db.prepare('SELECT * FROM evidence_records WHERE id = ?').get(rowId);
}

export async function persistArtifactBoundEvidence(job, artifactRecord, runId, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  const db = opts.db || getDb();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw evidenceError('RUN_NOT_FOUND', 'Evidence run not found: ' + runId);
  const existing = db.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(runId);
  if (existing) return persistPreparedArtifactBoundEvidence({
    runId,
    jobId: job.id,
    status: run.status,
    handoffArtifactDigest: run.handoff_artifact_digest,
    sourceRunId: run.source_run_id ?? null,
    sourceRunHandoffArtifactDigest: run.source_run_handoff_artifact_digest ?? null,
    envelopeHash: existing.hash,
  }, { db });
  const prepared = await prepareArtifactBoundEvidence(job, artifactRecord, run, opts);
  return persistPreparedArtifactBoundEvidence(prepared, { db });
}

export async function verifyPersistedArtifactBoundEvidence(runId, opts = {}) {
  const db = opts.db || getDb();
  const row = db.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(runId);
  if (!row) return null;
  let payload = null;
  let envelope = null;
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) throw evidenceError('RUN_NOT_FOUND', `Evidence run not found: ${runId}`);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(run.job_id);
    if (!job) throw evidenceError('JOB_NOT_FOUND', `Evidence job not found: ${run.job_id}`);
    if (Number(job.handoff_version) !== 4) {
      throw evidenceError('HANDOFF_V4_REQUIRED', 'Cryptographic evidence verification requires handoff v4');
    }
    const artifactRecord = assertArtifactMatchesJob(job, { db });
    payload = JSON.parse(row.payload);
    envelope = JSON.parse(row.evidence_envelope);
    if (canonicalStringify(payload) !== row.payload) {
      throw evidenceError('EVIDENCE_PAYLOAD_NONCANONICAL', 'Persisted evidence payload is not canonical JSON');
    }
    if (
      row.job_id !== job.id
      || row.handoff_artifact_digest !== run.handoff_artifact_digest
      || (row.source_run_id ?? null) !== (run.source_run_id ?? null)
      || (row.source_run_handoff_artifact_digest ?? null)
        !== (run.source_run_handoff_artifact_digest ?? null)
    ) {
      throw evidenceError('EVIDENCE_BINDING_MISMATCH', 'Persisted evidence row does not match the run');
    }
    if (row.evidence_verified !== 1) {
      throw evidenceError('EVIDENCE_NOT_VERIFIED', 'Persisted evidence is not marked verified');
    }
    if (row.evidence_method !== envelope.method) {
      throw evidenceError('EVIDENCE_METHOD_MISMATCH', 'Persisted evidence method does not match its envelope');
    }
    const expectedHash = envelope.payload_digest || sha256(canonicalStringify(envelope));
    if (row.hash !== expectedHash || envelope.payload_digest !== sha256(row.payload)) {
      throw evidenceError('EVIDENCE_DIGEST_MISMATCH', 'Persisted evidence digest does not match its envelope');
    }

    const profile = parseJson(job.evidence);
    if (!profile?.provider) {
      throw evidenceError('EVIDENCE_PROVIDER_REQUIRED', 'Persisted evidence provider configuration is missing');
    }
    const agentcli = await loadAgentcli(opts);
    const record = evidenceRecord(run, job, artifactRecord.payload, payload.timestamp);
    const { provider, source } = await resolveProvider(profile, agentcli, {
      env: opts.env || process.env,
    });
    const verifyOptions = providerVerifyOptions(
      profile,
      record,
      opts,
      evidencePrincipal(profile, opts),
    );
    const verification = source === 'agentcli'
      ? await agentcli.verifyEvidenceEnvelope(envelope, verifyOptions, {
          runId,
          artifactDigest: run.handoff_artifact_digest,
        })
      : await provider.verify(envelope, verifyOptions, {
          runId,
          artifactDigest: run.handoff_artifact_digest,
        });
    if (verification?.verified !== true) {
      throw evidenceError(
        'EVIDENCE_VERIFICATION_FAILED',
        verification?.reason || 'Persisted evidence cryptographic verification failed',
      );
    }
    assertVerifiedEvidencePayload(agentcli, envelope, verification, record);
    return {
      ...row,
      payload,
      envelope,
      integrity: {
        valid: true,
        cryptographically_verified: true,
        provider: profile.provider,
        method: envelope.method,
        principal: verification.principal || envelope.principal || null,
        key_fingerprint: verification.key_fingerprint || envelope.key_fingerprint || null,
      },
    };
  } catch (error) {
    return {
      ...row,
      payload,
      envelope,
      integrity: {
        valid: false,
        cryptographically_verified: false,
        code: error.code || 'EVIDENCE_VERIFICATION_FAILED',
        error: error.message,
      },
    };
  }
}
