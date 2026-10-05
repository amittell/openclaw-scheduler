import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { getDb } from './db.js';
import {
  assertValidHandoffArtifact,
  canonicalStringify,
  getHandoffArtifact,
  sha256,
} from './handoff-artifact.js';
import {
  getEvidenceProvider as getRuntimeEvidenceProvider,
  getProviderLoadProblem,
} from './provider-registry.js';
import { appendRuntimeEvent } from './runtime-events.js';

let agentcliPromise = null;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

function evidenceRecord(run, artifact, timestamp, opts = {}) {
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
    declared_identity: artifact.identity ?? null,
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
    result: resultEvidence(run, opts),
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

function outputDigest(run, kind, opts = {}) {
  const digestField = `shell_${kind}_sha256`;
  const pathField = `shell_${kind}_path`;
  const textField = `shell_${kind}`;
  const bytesField = `shell_${kind}_bytes`;
  const supplied = opts.evidenceOutput?.[`${kind}_sha256`] ?? run[digestField] ?? null;
  const path = run[pathField];
  if (path) {
    let content;
    try {
      content = readFileSync(path);
    } catch (error) {
      throw evidenceError(
        'EVIDENCE_OUTPUT_UNAVAILABLE',
        `Cannot read full ${kind} artifact ${path}: ${error.message}`,
      );
    }
    const actual = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (supplied && supplied !== actual) {
      throw evidenceError(
        'EVIDENCE_OUTPUT_DIGEST_MISMATCH',
        `Full ${kind} artifact does not match its persisted digest`,
      );
    }
    if (run[bytesField] != null && Number(run[bytesField]) !== content.length) {
      throw evidenceError(
        'EVIDENCE_OUTPUT_SIZE_MISMATCH',
        `Full ${kind} artifact does not match its persisted byte count`,
      );
    }
    return actual;
  }
  if (supplied) return supplied;
  return run[textField] == null ? null : sha256(run[textField]);
}

function resultEvidence(run, opts = {}) {
  const output = {
    status: run.status,
    summary: run.summary,
    stdout_sha256: outputDigest(run, 'stdout', opts),
    stderr_sha256: outputDigest(run, 'stderr', opts),
    structured_output_sha256: run.structured_output_sha256,
  };
  return {
    status: run.status,
    exit_code: run.shell_exit_code ?? (run.status === 'ok' ? 0 : 1),
    signal: run.shell_signal ?? null,
    timed_out: run.status === 'timeout' || Boolean(run.shell_timed_out),
    duration_ms: durationMs(run),
    stdout_bytes: run.shell_stdout_bytes ?? 0,
    stderr_bytes: run.shell_stderr_bytes ?? 0,
    structured_hash: run.structured_output_sha256 ?? null,
    output_hash: sha256(canonicalStringify(output)),
  };
}

async function resolveProvider(profile, agentcli, ctx) {
  const runtimeProvider = getRuntimeEvidenceProvider(profile.provider);
  if (runtimeProvider) return { provider: runtimeProvider, source: 'scheduler-plugin' };
  try {
    const provider = agentcli.resolveEvidenceProvider({
      evidenceProvider: profile.provider,
      env: ctx.env,
    });
    return { provider, source: 'agentcli' };
  } catch (error) {
    // agentcli reports an unregistered provider name as invalid_argument.
    if (error?.code !== 'invalid_argument') throw error;
    const loadProblem = getProviderLoadProblem();
    throw evidenceError(
      'EVIDENCE_PROVIDER_NOT_LOADED',
      `Evidence provider ${profile.provider} is not loaded: it is not an agentcli built-in, `
        + 'and no plugin from SCHEDULER_PROVIDER_PATH registered it in this process'
        + (loadProblem ? `; SCHEDULER_PROVIDER_PATH was not loaded: ${loadProblem}` : '')
        + ` (${error.message})`,
    );
  }
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

// A relative entry would trust a different file in every working directory.
// The warning names the entry's position, not its value: environment values
// are not echoed to logs.
const warnedRelativeTrustEntries = new Set();

function trustedListEntries(env) {
  return (env.SCHEDULER_TRUSTED_ALLOWED_SIGNERS || '').split(delimiter).filter((entry, index) => {
    if (!entry || isAbsolute(entry)) return Boolean(entry);
    if (!warnedRelativeTrustEntries.has(entry)) {
      warnedRelativeTrustEntries.add(entry);
      console.error(
        `[evidence] Ignoring entry ${index + 1} of SCHEDULER_TRUSTED_ALLOWED_SIGNERS: `
          + 'not an absolute path',
      );
    }
    return false;
  }).map(entry => resolve(entry));
}

// agentcli's ssh verify accepts any key listed in the allowed-signers file it is
// given, so choosing that file is the trust decision. The path an evidence row
// or a run's declaration names is a database value: it is used only when the
// operator lists it in SCHEDULER_TRUSTED_ALLOWED_SIGNERS. Otherwise the
// operator's AGENTCLI_ALLOWED_SIGNERS is used if it is absolute (a relative one
// would let the working directory choose the trust file), and with neither,
// verification fails closed. agentcli picks its verifier from the envelope's method, not the
// row's provider name, so this covers everything agentcli verifies. Plugins pin
// trust in their own verify() (docs/gateway-contract.md) and keep receiving the
// recorded path.
function evidenceTrust(source, recordedPath, opts) {
  const env = opts.env || process.env;
  const absolute = path => (path ? resolve(opts.cwd || process.cwd(), path) : null);
  const recorded = absolute(recordedPath);
  const configured = opts.allowedSignersPath || env.AGENTCLI_ALLOWED_SIGNERS;
  if (source !== 'agentcli') return { source: 'provider', path: recorded || absolute(configured) };
  const operator = configured && isAbsolute(configured) ? resolve(configured) : null;
  if (trustedListEntries(env).includes(recorded)) {
    return { source: 'operator-listed-recorded-path', path: recorded };
  }
  if (operator) {
    return { source: 'operator', path: operator, ignored: recorded !== operator ? recorded : null };
  }
  let listing = '';
  if (recorded?.includes(delimiter)) {
    listing = ` The scheduler database names ${recorded}, which contains "${delimiter}" and `
      + 'cannot be listed in SCHEDULER_TRUSTED_ALLOWED_SIGNERS.';
  } else if (recorded) {
    listing = ` The scheduler database names ${recorded}. List it in `
      + `SCHEDULER_TRUSTED_ALLOWED_SIGNERS (absolute paths separated by "${delimiter}") only if `
      + 'it is an allowed-signers file you created and you still trust every key in it; a path '
      + 'you do not recognize, such as the scheduler database itself, is a sign of a forged row.';
  }
  throw evidenceError(
    'EVIDENCE_TRUST_NOT_CONFIGURED',
    (configured
      ? 'The allowed-signers path configured for ssh evidence (AGENTCLI_ALLOWED_SIGNERS, or the '
        + 'allowedSignersPath option) is not absolute, so it is not used: set '
        + 'AGENTCLI_ALLOWED_SIGNERS to the absolute path of the allowed-signers file this host trusts.'
      : 'No allowed-signers file is configured for ssh evidence: set AGENTCLI_ALLOWED_SIGNERS to '
        + 'the allowed-signers file this host trusts.')
      + listing,
  );
}

function verificationFailure(verification, trust, fallback) {
  return evidenceError(
    'EVIDENCE_VERIFICATION_FAILED',
    (verification?.reason || fallback)
      + (trust.ignored
        ? `; checked against ${trust.path}, not ${trust.ignored}, which the scheduler database `
          + 'names and SCHEDULER_TRUSTED_ALLOWED_SIGNERS does not list'
        : ''),
  );
}

function providerVerifyOptions(profile, record, opts, principal, providerConfig, source) {
  const config = profile.provider_config || {};
  const trust = evidenceTrust(source, config.allowed_signers_path || config.allowed_signers, opts);
  return {
    trust,
    options: {
      ...(record ? { record } : {}),
      principal,
      allowedSignersPath: trust.path,
      providerConfig,
    },
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
  const profile = parseJson(run.evidence_declaration_snapshot) || parseJson(job.evidence);
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
    declaredIdentity: artifact.identity ?? null,
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
    result: resultEvidence(run, opts),
    verify: parseJson(run.verification_result),
    complianceContext: profile.payload?.context || {},
  });
  const serialized = agentcli.serializePayload(payload, 'canonical-json');
  const { provider, source } = await resolveProvider(profile, agentcli, {
    env: opts.env || process.env,
  });
  const principal = evidencePrincipal(profile, opts);
  const declaredConfig = profile.provider_config || {};
  const signingConfig = await provider.resolve(declaredConfig, {
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    principal,
  });
  if (!signingConfig) {
    throw evidenceError(
      'EVIDENCE_PROVIDER_RESOLUTION_FAILED',
      'Evidence provider ' + profile.provider + ' did not resolve signing credentials',
    );
  }
  const attestation = await provider.attest(serialized, signingConfig, {
    runId: run.id,
    artifactDigest: run.handoff_artifact_digest,
  });
  if (attestation?.attested !== true || !attestation.envelope) {
    throw evidenceError(
      'EVIDENCE_ATTESTATION_FAILED',
      attestation?.reason || 'Evidence provider did not produce an envelope',
    );
  }

  const record = evidenceRecord(run, artifact, timestamp, opts);
  const { trust, options: verifyOptions } = providerVerifyOptions(
    profile,
    record,
    opts,
    principal,
    declaredConfig,
    source,
  );
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
    throw verificationFailure(verification, trust, 'Evidence provider verification failed');
  }
  const verifiedPayload = assertVerifiedEvidencePayload(
    agentcli,
    attestation.envelope,
    verification,
    record,
  );
  const verifiedPayloadText = agentcli.serializePayload(verifiedPayload, 'canonical-json');
  if (verifiedPayloadText !== serialized) {
    throw evidenceError(
      'EVIDENCE_PAYLOAD_MISMATCH',
      'Verified evidence payload does not match the prepared execution payload',
    );
  }

  const envelopeText = canonicalStringify(attestation.envelope);
  const payloadDigest = attestation.envelope.payload_digest;
  if (payloadDigest != null && !/^sha256:[0-9a-f]{64}$/.test(payloadDigest)) {
    throw evidenceError(
      'EVIDENCE_DIGEST_INVALID',
      'Evidence envelope payload digest must be a lowercase SHA-256 digest',
    );
  }
  if (payloadDigest != null && payloadDigest !== sha256(serialized)) {
    throw evidenceError(
      'EVIDENCE_DIGEST_MISMATCH',
      'Evidence envelope payload digest does not match its verified payload',
    );
  }
  if (payloadDigest == null && attestation.envelope.signed_payload !== serialized) {
    throw evidenceError(
      'EVIDENCE_PAYLOAD_MISMATCH',
      'Digestless evidence envelope signed payload does not match the prepared execution payload',
    );
  }
  const envelopeHash = payloadDigest ?? sha256(envelopeText);
  const retentionPolicy = profile.retention || artifact.evidence.retention || null;
  return Object.freeze({
    runId: run.id,
    jobId: job.id,
    evidenceRef: profile.ref || job.evidence_ref || null,
    provider: profile.provider,
    principal,
    allowedSignersPath: verifyOptions.allowedSignersPath ?? null,
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
      + 'evidence_envelope, evidence_provider, evidence_principal, '
      + 'evidence_allowed_signers_path, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
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
      prepared.provider,
      prepared.principal,
      prepared.allowedSignersPath,
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

export function validatePersistedArtifactBoundEvidenceRecord(row, opts = {}) {
  if (!row) throw evidenceError('EVIDENCE_RECORD_REQUIRED', 'Persisted evidence row is required');
  const db = opts.db || getDb();
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(row.run_id);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.job_id);
  if (!row.handoff_artifact_digest) {
    throw evidenceError('HANDOFF_V4_REQUIRED', 'Cryptographic evidence verification requires handoff v4');
  }
  const artifactRecord = getHandoffArtifact(row.handoff_artifact_digest, { db });
  if (!artifactRecord) {
    throw evidenceError(
      'HANDOFF_ARTIFACT_REQUIRED',
      `Historical handoff artifact ${row.handoff_artifact_digest} is not retrievable`,
    );
  }
  const artifactValidation = assertValidHandoffArtifact(artifactRecord.payload, {
    expectedDigest: row.handoff_artifact_digest,
  });
  artifactRecord.payload = artifactValidation.payload;

  let payload;
  let envelope;
  try {
    payload = JSON.parse(row.payload);
    envelope = JSON.parse(row.evidence_envelope);
  } catch (error) {
    throw evidenceError(
      'EVIDENCE_JSON_INVALID',
      `Persisted evidence payload or envelope is invalid JSON: ${error.message}`,
    );
  }
  if (canonicalStringify(payload) !== row.payload) {
    throw evidenceError('EVIDENCE_PAYLOAD_NONCANONICAL', 'Persisted evidence payload is not canonical JSON');
  }
  if (row.evidence_verified !== 1) {
    throw evidenceError('EVIDENCE_NOT_VERIFIED', 'Persisted evidence is not marked verified');
  }
  if (row.evidence_method !== envelope.method) {
    throw evidenceError('EVIDENCE_METHOD_MISMATCH', 'Persisted evidence method does not match its envelope');
  }
  const hasPayloadDigest = envelope.payload_digest != null;
  if (hasPayloadDigest && !SHA256.test(envelope.payload_digest)) {
    throw evidenceError(
      'EVIDENCE_DIGEST_INVALID',
      'Persisted evidence payload digest must be a lowercase SHA-256 digest',
    );
  }
  const expectedHash = hasPayloadDigest
    ? envelope.payload_digest
    : sha256(canonicalStringify(envelope));
  if (row.hash !== expectedHash
    || (hasPayloadDigest && envelope.payload_digest !== sha256(row.payload))) {
    throw evidenceError('EVIDENCE_DIGEST_MISMATCH', 'Persisted evidence digest does not match its envelope');
  }
  if (!hasPayloadDigest && (
    typeof envelope.signed_payload !== 'string'
    || envelope.signed_payload !== row.payload
  )) {
    throw evidenceError(
      'EVIDENCE_SIGNED_PAYLOAD_MISMATCH',
      'Persisted digestless evidence payload does not match its signed envelope payload',
    );
  }
  if (
    payload.execution_id !== row.run_id
    || payload.bindings?.handoff_artifact_digest !== row.handoff_artifact_digest
    || (payload.bindings?.source_run_id ?? null) !== (row.source_run_id ?? null)
    || (payload.bindings?.source_run_handoff_artifact_digest ?? null)
      !== (row.source_run_handoff_artifact_digest ?? null)
    || payload.bindings?.manifest_digest !== artifactRecord.payload.manifest.digest
    || payload.bindings?.effective_task_hash
      !== artifactRecord.payload.compiled.effective_task_hash
    || payload.source?.workflow_id !== artifactRecord.payload.manifest.workflow_id
    || payload.source?.task_id !== artifactRecord.payload.manifest.task_id
    || artifactRecord.payload.compiled.job_id !== row.job_id
  ) {
    throw evidenceError(
      'EVIDENCE_BINDING_MISMATCH',
      'Persisted evidence row, signed payload, and historical artifact do not match',
    );
  }
  if (run && (
    row.job_id !== run.job_id
    || row.handoff_artifact_digest !== run.handoff_artifact_digest
    || (row.source_run_id ?? null) !== (run.source_run_id ?? null)
    || (row.source_run_handoff_artifact_digest ?? null)
      !== (run.source_run_handoff_artifact_digest ?? null)
  )) {
    throw evidenceError('EVIDENCE_BINDING_MISMATCH', 'Persisted evidence row does not match the run');
  }
  return { row, run, job, artifactRecord, payload, envelope };
}

export async function verifyPersistedArtifactBoundEvidence(runId, opts = {}) {
  const db = opts.db || getDb();
  const row = db.prepare('SELECT * FROM evidence_records WHERE run_id = ?').get(runId);
  if (!row) return null;
  let payload = null;
  let envelope = null;
  try {
    const validated = validatePersistedArtifactBoundEvidenceRecord(row, { db });
    const { run, job, artifactRecord } = validated;
    ({ payload, envelope } = validated);
    if (!run && (
      !row.evidence_provider
      || !row.evidence_principal
      || (row.evidence_provider === 'ssh' && !row.evidence_allowed_signers_path)
    )) {
      throw evidenceError(
        'EVIDENCE_RETAINED_METADATA_REQUIRED',
        'Retained evidence verification metadata is incomplete',
      );
    }

    const retainedProfile = row.evidence_provider
      ? {
        provider: row.evidence_provider,
        provider_config: {
          principal: row.evidence_principal,
          allowed_signers_path: row.evidence_allowed_signers_path,
        },
      }
      : null;
    const declaredProfile = run
      ? (parseJson(run.evidence_declaration_snapshot) || parseJson(job?.evidence))
      : retainedProfile;
    if (!declaredProfile?.provider) {
      throw evidenceError('EVIDENCE_PROVIDER_REQUIRED', 'Persisted evidence provider configuration is missing');
    }
    if (row.evidence_provider && declaredProfile.provider !== row.evidence_provider) {
      throw evidenceError(
        'EVIDENCE_PROVIDER_MISMATCH',
        'Persisted evidence provider does not match its declaration snapshot',
      );
    }
    const parsedProviderConfig = parseJson(declaredProfile.provider_config);
    const declaredProviderConfig = parsedProviderConfig
      && typeof parsedProviderConfig === 'object'
      && !Array.isArray(parsedProviderConfig)
      ? parsedProviderConfig
      : {};
    const profile = {
      ...declaredProfile,
      provider: row.evidence_provider || declaredProfile.provider,
      provider_config: {
        ...declaredProviderConfig,
        ...(row.evidence_principal ? { principal: row.evidence_principal } : {}),
        ...(row.evidence_allowed_signers_path
          ? { allowed_signers_path: row.evidence_allowed_signers_path }
          : {}),
      },
    };
    const agentcli = await loadAgentcli(opts);
    const record = run
      ? evidenceRecord(run, artifactRecord.payload, payload.timestamp, opts)
      : null;
    const { provider, source } = await resolveProvider(profile, agentcli, {
      env: opts.env || process.env,
    });
    const { trust, options: verifyOptions } = providerVerifyOptions(
      profile,
      record,
      opts,
      evidencePrincipal(profile, opts),
      // The declared config lives in the run's declaration snapshot, which is
      // gone once the run is pruned.
      run ? declaredProviderConfig : {},
      source,
    );
    const verification = source === 'agentcli'
      ? await agentcli.verifyEvidenceEnvelope(envelope, verifyOptions, {
          runId,
          artifactDigest: row.handoff_artifact_digest,
        })
      : await provider.verify(envelope, verifyOptions, {
          runId,
          artifactDigest: row.handoff_artifact_digest,
        });
    if (verification?.verified !== true) {
      throw verificationFailure(
        verification,
        trust,
        'Persisted evidence cryptographic verification failed',
      );
    }
    if (run) {
      assertVerifiedEvidencePayload(agentcli, envelope, verification, record);
    } else {
      const verifiedPayload = verification?.payload || parseJson(envelope?.signed_payload);
      const payloadValidation = agentcli.validateCompleteEvidencePayload(verifiedPayload);
      if (!payloadValidation.valid) {
        throw evidenceError(
          'EVIDENCE_PAYLOAD_INVALID',
          `Verified evidence payload is invalid: ${payloadValidation.errors.join('; ')}`,
        );
      }
      if (canonicalStringify(verifiedPayload) !== row.payload) {
        throw evidenceError(
          'EVIDENCE_BINDING_MISMATCH',
          'Cryptographically verified evidence payload does not match the retained record',
        );
      }
    }
    return {
      ...row,
      payload,
      envelope,
      integrity: {
        valid: true,
        cryptographically_verified: true,
        provider: profile.provider,
        method: envelope.method,
        // Only what verify() vouched for; envelope fields outside the
        // signature could name anyone.
        principal: verification.principal || null,
        key_fingerprint: verification.key_fingerprint || null,
        trust_source: trust.source,
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
