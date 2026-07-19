import { createHash } from 'node:crypto';
import { getDb } from './db.js';

export const HANDOFF_V4_SCHEMA = 'openclaw.scheduler.handoff-artifact';
export const HANDOFF_V4_ARTIFACT_SCHEMA_VERSION = 1;
export const HANDOFF_V4_CANONICALIZATION = 'json-sort-v1';
export const HANDOFF_V4_CANONICALIZATION_VERSION = 1;
export const HANDOFF_V4_VERSION = 4;
export const HANDOFF_V4_SCHEMA_MIN = 29;
export const HANDOFF_V4_EXECUTION_BINDING_VERSION = 2;
export const HANDOFF_V4_SCHEDULER_JOB_BINDING_VERSION = 1;
export const HANDOFF_V4_RUNTIME_CONTRACT = Object.freeze({
  artifact_schema: HANDOFF_V4_SCHEMA,
  artifact_schema_version: HANDOFF_V4_ARTIFACT_SCHEMA_VERSION,
  canonicalization: HANDOFF_V4_CANONICALIZATION,
  canonicalization_version: HANDOFF_V4_CANONICALIZATION_VERSION,
  digest: 'sha256',
  undefined: 'null',
  execution_binding_version: HANDOFF_V4_EXECUTION_BINDING_VERSION,
  scheduler_job_binding_version: HANDOFF_V4_SCHEDULER_JOB_BINDING_VERSION,
});
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PRESENTATION_MEDIA = new Set(['none', 'env', 'temp-file', 'stdin', 'gateway-env-header']);
const RAW_SECRET_KEYS = new Set([
  'value', 'credential', 'credentials', 'secret', 'token', 'password',
  'private_key', 'private-key', 'proof_value', 'raw_value',
]);

function normalizePrimitive(value) {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical values must contain only finite numbers');
  }
  return value;
}

export function sortKeysDeep(value) {
  if (value === null || typeof value !== 'object') return normalizePrimitive(value);
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}

export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256(value) {
  const hash = createHash('sha256');
  if (value instanceof Uint8Array) hash.update(value);
  else hash.update(String(value), 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

export function artifactDigest(payload) {
  return sha256(canonicalStringify(payload));
}

function normalizeJsonValue(value) {
  if (value == null || typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function schedulerJobExecutionProjection(job) {
  return {
    invocation: {
      name: job.name ?? null,
      schedule_kind: job.schedule_kind ?? 'cron',
      schedule_at: job.schedule_at ?? null,
      schedule_cron: job.schedule_cron ?? null,
      schedule_tz: job.schedule_tz ?? 'UTC',
      parent_id: job.parent_id ?? null,
      trigger_on: job.trigger_on ?? null,
      trigger_delay_s: job.trigger_delay_s ?? 0,
      trigger_condition: job.trigger_condition ?? null,
      origin: job.origin ?? null,
    },
    reliability: {
      overlap_policy: job.overlap_policy ?? 'skip',
      resource_pool: job.resource_pool ?? null,
      job_class: job.job_class ?? 'standard',
      max_retries: job.max_retries ?? 0,
      max_queued_dispatches: job.max_queued_dispatches ?? 25,
      max_pending_approvals: job.max_pending_approvals ?? 10,
      max_trigger_fanout: job.max_trigger_fanout ?? 25,
      delivery_guarantee: job.delivery_guarantee ?? 'at-most-once',
    },
    delivery: {
      mode: job.delivery_mode ?? 'announce',
      channel: job.delivery_channel ?? null,
      to: job.delivery_to ?? null,
      opt_out_reason: job.delivery_opt_out_reason ?? null,
    },
    context: {
      retrieval: job.context_retrieval ?? 'none',
      retrieval_limit: job.context_retrieval_limit ?? 5,
    },
    lifecycle: {
      enabled: Boolean(job.enabled),
      delete_after_run: Boolean(job.delete_after_run),
    },
    target: {
      session_target: job.session_target ?? null,
      agent_id: job.agent_id ?? 'main',
      payload_kind: job.payload_kind ?? null,
      payload_scope: job.payload_scope ?? 'own',
    },
    command: {
      payload_message_sha256: sha256(job.payload_message ?? ''),
    },
    runtime: {
      run_timeout_ms: job.run_timeout_ms ?? 300000,
      payload_timeout_seconds: job.payload_timeout_seconds ?? 120,
      payload_model: job.payload_model ?? null,
      payload_model_fallback: job.payload_model_fallback ?? null,
      payload_thinking: job.payload_thinking ?? null,
      preferred_session_key: job.preferred_session_key ?? null,
      auth_profile: job.auth_profile ?? null,
      auth_profile_fallback: job.auth_profile_fallback ?? null,
      shell_env_policy: job.shell_env_policy ?? 'minimal',
    },
    approval: {
      required: Boolean(job.approval_required),
      timeout_s: job.approval_timeout_s ?? 3600,
      auto: job.approval_auto ?? 'reject',
      risk_level: job.approval_risk_level ?? null,
      approver_scope: job.approval_approver_scope ?? null,
    },
    output: {
      format: job.output_format ?? null,
      store_limit_bytes: job.output_store_limit_bytes ?? 65536,
      excerpt_limit_bytes: job.output_excerpt_limit_bytes ?? 65536,
      summary_limit_bytes: job.output_summary_limit_bytes ?? 65536,
      offload_threshold_bytes: job.output_offload_threshold_bytes ?? 65536,
    },
    identity: {
      principal: job.identity_principal ?? null,
      run_as: job.identity_run_as ?? null,
      attestation: job.identity_attestation ?? null,
      ref: job.identity_ref ?? null,
      subject_kind: job.identity_subject_kind ?? null,
      subject_principal: job.identity_subject_principal ?? null,
      trust_level: job.identity_trust_level ?? null,
      delegation_mode: job.identity_delegation_mode ?? null,
      declaration: normalizeJsonValue(job.identity),
    },
    authorization_proof: {
      ref: job.authorization_proof_ref ?? null,
      declaration: normalizeJsonValue(job.authorization_proof),
    },
    authorization: {
      ref: job.authorization_ref ?? null,
      declaration: normalizeJsonValue(job.authorization),
    },
    evidence: {
      ref: job.evidence_ref ?? null,
      declaration: normalizeJsonValue(job.evidence),
    },
    contract: {
      required_trust_level: job.contract_required_trust_level ?? null,
      trust_enforcement: job.contract_trust_enforcement ?? null,
      sandbox: job.contract_sandbox ?? null,
      allowed_paths: normalizeJsonValue(job.contract_allowed_paths),
      network: job.contract_network ?? null,
      max_cost_usd: job.contract_max_cost_usd ?? null,
      audit: job.contract_audit ?? null,
    },
    verification: {
      shell_sha256: job.verify_shell == null ? null : sha256(job.verify_shell),
      timeout_s: job.verify_timeout_s ?? null,
      on_failure: job.verify_on_failure ?? null,
    },
    watchdog: {
      job_type: job.job_type ?? 'standard',
      target_label: job.watchdog_target_label ?? null,
      check_cmd_sha256: job.watchdog_check_cmd == null ? null : sha256(job.watchdog_check_cmd),
      timeout_min: job.watchdog_timeout_min ?? null,
      alert_channel: job.watchdog_alert_channel ?? null,
      alert_target: job.watchdog_alert_target ?? null,
      self_destruct: job.watchdog_self_destruct == null
        ? true
        : Boolean(job.watchdog_self_destruct),
      started_at: job.watchdog_started_at ?? null,
    },
    child_credential_policy: job.child_credential_policy ?? null,
    intent: {
      mode: job.execution_intent ?? 'execute',
      read_only: Boolean(job.execution_read_only),
    },
  };
}

function parsePayload(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw handoffError('HANDOFF_ARTIFACT_INVALID', `Invalid handoff artifact JSON: ${error.message}`);
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw handoffError('HANDOFF_ARTIFACT_INVALID', 'Handoff artifact payload must be an object');
  }
  return input;
}

function handoffError(code, message, details = null) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function requireDigest(value, path, errors, nullable = true) {
  if (value == null && nullable) return;
  if (typeof value !== 'string' || !SHA256.test(value)) {
    errors.push(`${path} must be a lowercase sha256 digest`);
  }
}

function requireBoolean(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
}

function findRawSecretPaths(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRawSecretPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RAW_SECRET_KEYS.has(key.toLowerCase()) && child != null) found.push(childPath);
    else findRawSecretPaths(child, childPath, found);
  }
  return found;
}

export function validateHandoffArtifact(input, { expectedDigest = null, job = null } = {}) {
  let payload;
  try {
    payload = parsePayload(input);
  } catch (error) {
    return { ok: false, payload: null, digest: null, errors: [error.message] };
  }
  const errors = [];

  if (payload.schema !== HANDOFF_V4_SCHEMA) errors.push('schema is unsupported');
  if (payload.artifact_schema_version !== HANDOFF_V4_ARTIFACT_SCHEMA_VERSION) {
    errors.push('artifact_schema_version must be 1');
  }
  if (payload.handoff_version !== HANDOFF_V4_VERSION) errors.push('handoff_version must be 4');
  if (!Number.isInteger(payload.scheduler_schema_min)
    || payload.scheduler_schema_min !== HANDOFF_V4_SCHEMA_MIN) {
    errors.push('scheduler_schema_min must be exactly 29');
  }
  if (payload.canonicalization?.name !== HANDOFF_V4_CANONICALIZATION
    || payload.canonicalization?.version !== HANDOFF_V4_CANONICALIZATION_VERSION
    || payload.canonicalization?.digest !== 'sha256'
    || payload.canonicalization?.undefined !== 'null') {
    errors.push('canonicalization contract is unsupported');
  }
  if (payload.execution_binding_version !== HANDOFF_V4_EXECUTION_BINDING_VERSION) {
    errors.push('execution_binding_version must be 2');
  }
  if (payload.scheduler_job_binding?.version !== HANDOFF_V4_SCHEDULER_JOB_BINDING_VERSION) {
    errors.push('scheduler_job_binding.version must be 1');
  }
  for (const [path, value, nullable] of [
    ['scheduler_job_binding.digest', payload.scheduler_job_binding?.digest, false],
    ['manifest.digest', payload.manifest?.digest, false],
    ['compiled.effective_task_hash', payload.compiled?.effective_task_hash, false],
    ['command.payload_message_sha256', payload.command?.payload_message_sha256, false],
    ['command.argv_sha256', payload.command?.argv_sha256, true],
    ['command.stdin_sha256', payload.command?.stdin_sha256, true],
    ['command.prompt_sha256', payload.command?.prompt_sha256, true],
    ['command.input_sha256', payload.command?.input_sha256, true],
    ['command.env.declared_env_sha256', payload.command?.env?.declared_env_sha256, true],
    ['identity.subject_hash', payload.identity?.subject_hash, true],
    ['identity.auth_hash', payload.identity?.auth_hash, true],
    ['authorization_proof.claims_hash', payload.authorization_proof?.claims_hash, true],
    ['authorization_proof.proof_source_hash', payload.authorization_proof?.proof_source_hash, true],
    ['authorization_proof.verification_context_hash', payload.authorization_proof?.verification_context_hash, true],
    ['authorization.policy_digest', payload.authorization?.policy_digest, true],
    ['authorization.request_hash', payload.authorization?.request_hash, true],
    ['authorization.decision_hash', payload.authorization?.decision_hash, true],
    ['evidence.payload_hash', payload.evidence?.payload_hash, true],
    ['evidence.provider_config_hash', payload.evidence?.provider_config_hash, true],
    ['contract.allowed_paths_sha256', payload.contract?.allowed_paths_sha256, true],
    ['contract.postcondition.verify_shell_sha256', payload.contract?.postcondition?.verify_shell_sha256, true],
    ['verification.shell_sha256', payload.verification?.shell_sha256, true],
    ['delegation.allowed_delegators_hash', payload.delegation?.allowed_delegators_hash, true],
  ]) requireDigest(value, path, errors, nullable);

  for (const [index, value] of (payload.command?.args_sha256 ?? []).entries()) {
    requireDigest(value, `command.args_sha256[${index}]`, errors, false);
  }
  for (const [key, value] of Object.entries(
    payload.command?.env?.effective_env_value_sha256 ?? {},
  )) requireDigest(value, `command.env.effective_env_value_sha256.${key}`, errors, false);

  requireBoolean(payload.lifecycle?.enabled, 'lifecycle.enabled', errors);
  requireBoolean(payload.lifecycle?.delete_after_run, 'lifecycle.delete_after_run', errors);
  requireBoolean(payload.approval?.required, 'approval.required', errors);
  requireBoolean(
    payload.authorization_proof?.artifact_binding_required,
    'authorization_proof.artifact_binding_required',
    errors,
  );
  requireBoolean(
    payload.authorization_proof?.replay_protection_required,
    'authorization_proof.replay_protection_required',
    errors,
  );
  requireBoolean(
    payload.authorization_proof?.revocation_check_required,
    'authorization_proof.revocation_check_required',
    errors,
  );
  requireBoolean(
    payload.evidence?.signed_or_provider_verified_required,
    'evidence.signed_or_provider_verified_required',
    errors,
  );
  requireBoolean(payload.intent?.read_only, 'intent.read_only', errors);
  requireBoolean(payload.delegation?.require_grant_per_hop, 'delegation.require_grant_per_hop', errors);

  if (!PRESENTATION_MEDIA.has(payload.identity?.presentation?.handoff)) {
    errors.push('identity.presentation.handoff is unsupported');
  }
  for (const secretPath of findRawSecretPaths(payload)) {
    errors.push(`${secretPath} contains raw credential material`);
  }
  for (const [index, binding] of (payload.identity?.presentation?.bindings ?? []).entries()) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      errors.push(`identity.presentation.bindings[${index}] must be an object`);
    } else if (
      Object.hasOwn(binding, 'value')
      || Object.hasOwn(binding, 'credential')
      || Object.hasOwn(binding, 'secret')
      || Object.hasOwn(binding, 'token')
    ) {
      errors.push(`identity.presentation.bindings[${index}] contains raw credential material`);
    } else {
      if (!PRESENTATION_MEDIA.has(binding.medium)) {
        errors.push(`identity.presentation.bindings[${index}].medium is unsupported`);
      } else if (binding.medium !== 'none'
        && binding.medium !== payload.identity.presentation.handoff) {
        errors.push(`identity.presentation.bindings[${index}].medium does not match presentation handoff`);
      }
      requireDigest(
        binding.source_hash,
        `identity.presentation.bindings[${index}].source_hash`,
        errors,
      );
      requireBoolean(binding.required, `identity.presentation.bindings[${index}].required`, errors);
      requireBoolean(binding.redact, `identity.presentation.bindings[${index}].redact`, errors);
    }
  }

  const allowedDelegators = payload.delegation?.allowed_delegators;
  if (!Array.isArray(allowedDelegators)
    || allowedDelegators.some(value => typeof value !== 'string' || value.length === 0)
    || new Set(allowedDelegators).size !== allowedDelegators.length
    || allowedDelegators.some((value, index) => index > 0 && value < allowedDelegators[index - 1])) {
    errors.push('delegation.allowed_delegators must be a sorted unique array of non-empty strings');
  } else if (payload.delegation.allowed_delegators_hash !== artifactDigest(allowedDelegators)) {
    errors.push('delegation.allowed_delegators_hash does not match allowed_delegators');
  }

  const proofMethod = payload.authorization_proof?.method;
  if (!Object.hasOwn(payload.authorization_proof ?? {}, 'verification_context_hash')) {
    errors.push('authorization_proof.verification_context_hash is required');
  }
  if (['jwt', 'detached-signature', 'certificate'].includes(proofMethod)) {
    if (!SHA256.test(payload.authorization_proof?.verification_context_hash)) {
      errors.push('authorization_proof.verification_context_hash is required for cryptographic proofs');
    }
    if (
      payload.authorization_proof.artifact_binding_required !== true
      || payload.authorization_proof.replay_protection_required !== true
      || payload.authorization_proof.revocation_check_required !== true
    ) {
      errors.push('cryptographic proofs must require artifact binding, replay protection, and revocation');
    }
  }
  if (payload.evidence?.provider
    && payload.evidence.signed_or_provider_verified_required !== true) {
    errors.push('declared evidence providers require signed or provider-verified evidence');
  }
  if (payload.delegation?.mode && payload.delegation.mode !== 'none'
    && payload.delegation.source_binding !== 'source_run_id') {
    errors.push('delegation must bind to source_run_id');
  }

  let digest = null;
  try {
    digest = artifactDigest(payload);
  } catch (error) {
    errors.push(error.message);
  }
  if (expectedDigest != null) {
    requireDigest(expectedDigest, 'expectedDigest', errors, false);
    if (digest && digest !== expectedDigest) errors.push('artifact digest does not match payload');
  }

  if (job) {
    if (payload.compiled?.job_id !== job.id) errors.push('compiled.job_id does not match job id');
    if (payload.lifecycle?.target?.session_target !== job.session_target) {
      errors.push('lifecycle target session_target does not match job');
    }
    if (payload.lifecycle?.target?.payload_kind !== job.payload_kind) {
      errors.push('lifecycle target payload_kind does not match job');
    }
    if ((payload.lifecycle?.target?.agent_id ?? null) !== (job.agent_id ?? null)) {
      errors.push('lifecycle target agent_id does not match job');
    }
    if (payload.runtime?.timeout_ms !== job.run_timeout_ms) {
      errors.push('runtime timeout does not match job');
    }
    if (payload.approval?.required !== Boolean(job.approval_required)) {
      errors.push('approval required does not match job');
    }
    if ((payload.approval?.timeout_s ?? 3600) !== (job.approval_timeout_s ?? 3600)) {
      errors.push('approval timeout does not match job');
    }
    if ((payload.approval?.auto ?? 'reject') !== (job.approval_auto ?? 'reject')) {
      errors.push('approval auto policy does not match job');
    }
    if ((payload.approval?.risk_level ?? null) !== (job.approval_risk_level ?? null)) {
      errors.push('approval risk level does not match job');
    }
    if ((payload.approval?.approver_scope ?? null) !== (job.approval_approver_scope ?? null)) {
      errors.push('approval scope does not match job');
    }
    if ((payload.output?.format ?? null) !== (job.output_format ?? null)) {
      errors.push('output format does not match job');
    }
    if ((payload.verification?.shell_sha256 ?? null) !== (job.verify_shell == null ? null : sha256(job.verify_shell))) {
      errors.push('verification command digest does not match job');
    }
    if ((payload.verification?.timeout_s ?? null) !== (job.verify_timeout_s ?? null)
      || (payload.verification?.on_failure ?? null) !== (job.verify_on_failure ?? null)) {
      errors.push('verification policy does not match job');
    }
    if ((payload.intent?.mode ?? 'execute') !== (job.execution_intent ?? 'execute')
      || payload.intent?.read_only !== Boolean(job.execution_read_only)) {
      errors.push('execution intent does not match job');
    }
    if ((payload.child_credential_policy ?? null) !== (job.child_credential_policy ?? null)) {
      errors.push('child credential policy does not match job');
    }
    if (payload.lifecycle?.enabled !== Boolean(job.enabled)) {
      errors.push('lifecycle enabled does not match job');
    }
    if (payload.lifecycle?.delete_after_run !== Boolean(job.delete_after_run)) {
      errors.push('lifecycle delete_after_run does not match job');
    }
    if (payload.command?.payload_message_sha256 !== sha256(job.payload_message ?? '')) {
      errors.push('payload message digest does not match job');
    }
    if (payload.compiled?.effective_task_hash !== job.effective_task_hash) {
      errors.push('effective task hash does not match job');
    }
    const jobBindingDigest = artifactDigest(schedulerJobExecutionProjection(job));
    if (payload.scheduler_job_binding?.digest !== jobBindingDigest) {
      errors.push('scheduler job execution binding does not match artifact');
    }
  }

  return { ok: errors.length === 0, payload, digest, errors };
}

export function assertValidHandoffArtifact(input, opts = {}) {
  const validation = validateHandoffArtifact(input, opts);
  if (!validation.ok) {
    throw handoffError(
      validation.errors.some(error => error === 'artifact digest does not match payload')
        ? 'HANDOFF_ARTIFACT_DIGEST_MISMATCH'
        : 'HANDOFF_ARTIFACT_INVALID',
      validation.errors.join('; '),
      { errors: validation.errors },
    );
  }
  return validation;
}

export function persistHandoffArtifact(input, expectedDigest, opts = {}) {
  const db = opts.db || getDb();
  const validation = assertValidHandoffArtifact(input, { expectedDigest });
  const payloadText = canonicalStringify(validation.payload);
  const existing = db.prepare(
    'SELECT payload FROM handoff_artifacts WHERE digest = ?',
  ).get(validation.digest);
  if (existing) {
    if (existing.payload !== payloadText) {
      throw handoffError(
        'HANDOFF_ARTIFACT_IMMUTABLE',
        'Existing handoff artifact digest is bound to a different payload',
      );
    }
    return getHandoffArtifact(validation.digest, { db });
  }

  db.prepare(`
    INSERT INTO handoff_artifacts (
      digest, artifact_schema_version, handoff_version, scheduler_schema_min,
      canonicalization, canonicalization_version,
      execution_binding_version, manifest_digest, workflow_id, task_id,
      job_id, effective_task_hash, payload, payload_bytes
    ) VALUES (?, ?, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    validation.digest,
    validation.payload.artifact_schema_version,
    validation.payload.scheduler_schema_min,
    validation.payload.canonicalization.name,
    validation.payload.canonicalization.version,
    validation.payload.execution_binding_version,
    validation.payload.manifest.digest,
    validation.payload.manifest.workflow_id,
    validation.payload.manifest.task_id,
    validation.payload.compiled.job_id,
    validation.payload.compiled.effective_task_hash,
    payloadText,
    Buffer.byteLength(payloadText, 'utf8'),
  );
  return getHandoffArtifact(validation.digest, { db });
}

export function getHandoffArtifact(digest, opts = {}) {
  const db = opts.db || getDb();
  const row = db.prepare('SELECT * FROM handoff_artifacts WHERE digest = ?').get(digest);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

export function assertArtifactMatchesJob(job, opts = {}) {
  if (Number(job?.handoff_version) !== 4) return null;
  if (!job.handoff_artifact_digest) {
    throw handoffError('HANDOFF_ARTIFACT_REQUIRED', 'Handoff v4 job is missing artifact digest');
  }
  const artifact = getHandoffArtifact(job.handoff_artifact_digest, opts);
  if (!artifact) {
    throw handoffError('HANDOFF_ARTIFACT_REQUIRED', 'Handoff v4 artifact is not persisted');
  }
  const validation = assertValidHandoffArtifact(artifact.payload, {
    expectedDigest: job.handoff_artifact_digest,
    job,
  });
  return { ...artifact, payload: validation.payload };
}
