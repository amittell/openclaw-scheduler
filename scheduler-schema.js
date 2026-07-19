export const SCHEDULER_SCHEMA_VERSION = 29;
export const SCHEDULER_PRODUCT_SCHEMA_LABEL = 'v0.5.0';

export const SCHEDULER_SCHEMAS = {
  jobs: {
    type: 'object',
    required: ['name', 'payload_message', 'run_timeout_ms'], // origin also required for non-child jobs
    fields: {
      name: { type: 'string', maxLength: 200 },
      enabled: { type: 'boolean', default: true },
      schedule_kind: { type: 'string', enum: ['cron', 'at'], default: 'cron' },
      schedule_at: { type: 'string', nullable: true, description: 'UTC SQLite timestamp for one-shot jobs' },
      schedule_cron: { type: 'string', requiredFor: 'root jobs' },
      schedule_tz: { type: 'string', default: 'UTC' },
      session_target: { type: 'string', enum: ['main', 'isolated', 'shell'], default: 'isolated' },
      payload_kind: { type: 'string', enum: ['systemEvent', 'agentTurn', 'shellCommand'] },
      payload_message: { type: 'string', maxLength: 100000 },
      payload_model: { type: 'string', nullable: true },
      payload_model_fallback: { type: 'string', nullable: true, description: 'Optional fallback model override for a same-run retry after primary selection failure' },
      payload_thinking: { type: 'string', nullable: true },
      payload_timeout_seconds: { type: 'integer', min: 1, default: 120 },
      execution_intent: { type: 'string', enum: ['execute', 'plan', 'fire-and-forget'], default: 'execute' },
      execution_read_only: { type: 'boolean', default: false },
      shell_env_policy: { type: 'string', enum: ['minimal', 'inherit'], default: 'minimal', description: 'Fresh jobs default to a minimal environment; migrated jobs retain inherit semantics' },
      overlap_policy: { type: 'string', enum: ['skip', 'allow', 'queue'], default: 'skip' },
      run_timeout_ms: { type: 'integer', min: 1, required: true, description: 'Required: max ms a run may execute before timeout (no default -- caller must be explicit)' },
      max_queued_dispatches: { type: 'integer', min: 1, default: 25 },
      max_pending_approvals: { type: 'integer', min: 1, default: 10 },
      max_trigger_fanout: { type: 'integer', min: 1, default: 25 },
      delivery_mode: { type: 'string', enum: ['announce', 'announce-always', 'none'], default: 'announce' },
      delivery_channel: { type: 'string', nullable: true },
      // REQUIRED on insert for non-exempt jobs. Exempt: job_type='watchdog', name starts with 'watchdog:',
      // session_target='main', or delivery_mode='none'. Set to the origin chat_id so results reach the right chat.
      delivery_to: { type: 'string', nullable: true, required: 'non-system jobs', description: 'Target chat/user id for delivery (e.g. telegram chat_id). Required on insert for non-system jobs.' },
      parent_id: { type: 'string', nullable: true },
      trigger_on: { type: 'string', enum: ['success', 'failure', 'complete'], nullable: true },
      trigger_delay_s: { type: 'integer', min: 0, default: 0 },
      trigger_condition: { type: 'string', nullable: true, examples: ['contains:ALERT', 'regex:ERROR.*critical'] },
      max_retries: { type: 'integer', min: 0, default: 0 },
      payload_scope: { type: 'string', enum: ['own', 'global'], default: 'own' },
      resource_pool: { type: 'string', nullable: true },
      delivery_guarantee: { type: 'string', enum: ['at-most-once', 'at-least-once'], default: 'at-most-once' },
      job_class: { type: 'string', enum: ['standard', 'pre_compaction_flush'], default: 'standard' },
      approval_required: { type: 'boolean', default: false },
      approval_timeout_s: { type: 'integer', min: 1, default: 3600 },
      approval_auto: { type: 'string', enum: ['approve', 'reject'], default: 'reject' },
      approval_risk_level: { type: 'string', enum: ['low', 'medium', 'high'], nullable: true },
      approval_approver_scope: { type: 'string', nullable: true, description: 'Authenticated local OS approver: exact, principal:, user:, or uid: scope' },
      context_retrieval: { type: 'string', enum: ['none', 'recent', 'hybrid'], default: 'none' },
      context_retrieval_limit: { type: 'integer', min: 1, default: 5 },
      output_store_limit_bytes: { type: 'integer', min: 128, default: 65536 },
      output_excerpt_limit_bytes: { type: 'integer', min: 64, default: 65536 },
      output_summary_limit_bytes: { type: 'integer', min: 64, default: 65536 },
      output_offload_threshold_bytes: { type: 'integer', min: 128, default: 65536 },
      output_format: { type: 'string', enum: ['json', 'ndjson', 'text'], nullable: true, description: 'Expected and validated execution output format' },
      verify_shell: { type: 'string', nullable: true, description: 'Post-success verification command' },
      verify_timeout_s: { type: 'integer', min: 1, nullable: true, description: 'Verification timeout in seconds' },
      verify_on_failure: { type: 'string', enum: ['warn', 'error'], nullable: true, description: 'Whether verification failure warns or fails the run' },
      preferred_session_key: { type: 'string', nullable: true },
      auth_profile: { type: 'string', nullable: true, description: 'Auth profile override: null=default, "inherit"=main session profile, or "provider:label"' },
      auth_profile_fallback: { type: 'string', nullable: true, description: 'Optional fallback auth profile for a same-run retry after primary selection failure' },
      delivery_opt_out_reason: { type: 'string', nullable: true, maxLength: 256 },
      origin: { type: 'string', requiredFor: 'root jobs', description: 'Request source or system identity' },
      delete_after_run: { type: 'boolean', default: false },
      run_now: { type: 'boolean', default: false, note: 'create-time convenience flag' },

      // v0.2 Identity
      identity_principal: { type: 'string', nullable: true },
      identity_run_as: { type: 'string', nullable: true },
      identity_attestation: { type: 'string', nullable: true },
      identity_ref: { type: 'string', nullable: true },
      identity_subject_kind: { type: 'string', enum: ['agent', 'service', 'workload', 'user', 'composite', 'delegated-agent', 'unknown'], nullable: true },
      identity_subject_principal: { type: 'string', nullable: true },
      identity_trust_level: { type: 'string', enum: ['untrusted', 'restricted', 'supervised', 'autonomous'], nullable: true },
      identity_delegation_mode: { type: 'string', enum: ['none', 'on-behalf-of', 'impersonation'], nullable: true },
      identity: { type: 'string', nullable: true, description: 'JSON blob: full identity declaration' },

      // v0.2 Authorization Proof
      authorization_proof_ref: { type: 'string', nullable: true },
      authorization_proof: { type: 'string', nullable: true, description: 'JSON blob: authorization proof structure' },

      // v0.2 Authorization
      authorization_ref: { type: 'string', nullable: true },
      authorization: { type: 'string', nullable: true, description: 'JSON blob: authorization policy declaration' },

      // v0.2 Evidence
      evidence_ref: { type: 'string', nullable: true },
      evidence: { type: 'string', nullable: true, description: 'JSON blob: evidence collection declaration' },

      // v0.2 Contract
      contract_required_trust_level: { type: 'string', enum: ['untrusted', 'restricted', 'supervised', 'autonomous'], nullable: true },
      contract_trust_enforcement: { type: 'string', enum: ['none', 'warn', 'block', 'advisory', 'strict'], nullable: true, description: 'advisory/strict normalize to warn/block at runtime' },
      contract_sandbox: { type: 'string', nullable: true, description: 'JSON blob: sandbox constraints' },
      contract_allowed_paths: { type: 'string', nullable: true, description: 'JSON blob: allowed filesystem paths' },
      contract_network: { type: 'string', nullable: true, description: 'JSON blob: network access policy' },
      contract_max_cost_usd: { type: 'number', nullable: true, min: 0 },
      contract_audit: { type: 'string', nullable: true, description: 'JSON blob: audit configuration' },
      child_credential_policy: { type: 'string', nullable: true, enum: ['none', 'inherit', 'downscope', 'independent'], description: 'Credential flow policy for child tasks' },

      // Agentcli handoff v4
      handoff_version: { type: 'integer', enum: [4], nullable: true },
      handoff_artifact_digest: { type: 'string', nullable: true, pattern: '^sha256:[0-9a-f]{64}$' },
      handoff_artifact_payload: { type: 'object', nullable: true, description: 'Canonical v4 artifact payload accepted on create/update and returned only by opt-in hydrated job reads; persisted immutably outside the job row' },
      effective_task_hash: { type: 'string', nullable: true, pattern: '^sha256:[0-9a-f]{64}$' },
    },
  },
  runs: {
    statuses: ['pending', 'running', 'ok', 'error', 'timeout', 'skipped', 'awaiting_approval', 'approved', 'cancelled', 'crashed', 'recovery_blocked'],
    key_fields: ['job_id', 'status', 'started_at', 'finished_at', 'summary', 'error_message', 'shell_exit_code', 'shell_signal', 'shell_timed_out', 'shell_stdout', 'shell_stderr', 'shell_stdout_path', 'shell_stderr_path', 'shell_stdout_bytes', 'shell_stderr_bytes', 'shell_stdout_sha256', 'shell_stderr_sha256', 'dispatcher_owner', 'dispatcher_token', 'dispatch_started_at', 'cancel_requested_at', 'cancel_requested_by', 'cancel_reason', 'process_pid', 'process_pgid', 'process_identity', 'process_started_at', 'process_terminated_at', 'agent_cancel_requested_at', 'terminal_transition_at', 'retry_of', 'triggered_by_run', 'dispatch_queue_id', 'idempotency_key', 'identity_resolved', 'trust_evaluation', 'authorization_decision', 'authorization_proof_verification', 'evidence_required', 'evidence_execution_snapshot', 'evidence_declaration_snapshot', 'evidence_ref_snapshot', 'evidence_record', 'credential_handoff_summary', 'delegation_validation', 'approval_used', 'handoff_artifact_digest', 'runtime_instance_id', 'source_run_id', 'source_run_handoff_artifact_digest', 'output_format', 'structured_output', 'structured_output_valid', 'structured_output_warning', 'structured_output_bytes', 'structured_output_sha256', 'structured_output_path', 'verification_result'],
  },
  approvals: {
    statuses: ['pending', 'approved', 'dispatching', 'dispatched', 'rejected', 'timed_out', 'cancelled'],
    key_fields: ['job_id', 'run_id', 'dispatch_queue_id', 'requested_at', 'resolved_at', 'resolved_by', 'notes', 'decision_version', 'cancelled_reason', 'expires_at', 'approved_at', 'rejected_at', 'dispatched_at', 'risk_level', 'approver_scope', 'binding_hash', 'gate_kind', 'decision_context', 'handoff_artifact_digest', 'source_run_id', 'source_run_handoff_artifact_digest'],
  },
  dispatches: {
    kinds: ['schedule', 'at', 'manual', 'chain', 'retry'],
    statuses: ['pending', 'claimed', 'awaiting_approval', 'done', 'cancelled', 'failed'],
    key_fields: ['job_id', 'dispatch_kind', 'status', 'scheduled_for', 'binding_scheduled_for', 'source_run_id', 'retry_of_run_id', 'claim_owner', 'claim_token', 'claim_expires_at', 'attempt_count', 'last_error', 'replay_of_run_id', 'handoff_artifact_digest', 'source_run_handoff_artifact_digest'],
  },
  messages: {
    kinds: ['text', 'task', 'result', 'status', 'system', 'spawn', 'decision', 'constraint', 'fact', 'preference'],
    statuses: ['pending', 'prompt_claimed', 'delivered', 'read', 'expired', 'failed'],
  },
  dispatcher_leases: {
    key_fields: ['name', 'owner_id', 'fencing_token', 'acquired_at', 'renewed_at', 'expires_at'],
  },
  delivery_outbox: {
    statuses: ['pending', 'claimed', 'delivered', 'failed', 'cancelled'],
    key_fields: ['message_id', 'job_id', 'run_id', 'channel', 'target', 'status', 'idempotency_key', 'delivery_group_id', 'part_index', 'part_count', 'completion_label', 'completion_scope', 'attempt_count', 'max_attempts', 'next_attempt_at', 'claim_owner', 'claim_token', 'claim_expires_at', 'last_error', 'delivered_at'],
  },
  delivery_attachments: {
    key_fields: ['outbox_id', 'message_id', 'ordinal', 'name', 'mime_type', 'source_path', 'content_blob', 'size_bytes', 'sha256'],
  },
  evidence_records: {
    key_fields: ['run_id', 'job_id', 'evidence_ref', 'algorithm', 'hash', 'payload', 'retention_policy', 'retention_until', 'handoff_artifact_digest', 'source_run_id', 'source_run_handoff_artifact_digest', 'evidence_method', 'evidence_verified', 'evidence_envelope', 'evidence_provider', 'evidence_principal', 'evidence_allowed_signers_path', 'created_at'],
  },
  handoff_artifacts: {
    immutable: true,
    key_fields: ['digest', 'artifact_schema_version', 'handoff_version', 'scheduler_schema_min', 'canonicalization', 'canonicalization_version', 'execution_binding_version', 'manifest_digest', 'workflow_id', 'task_id', 'job_id', 'effective_task_hash', 'payload', 'payload_bytes', 'created_at'],
  },
  runtime_events: {
    immutable: true,
    key_fields: ['event_type', 'event_version', 'job_id', 'dispatch_queue_id', 'run_id', 'approval_id', 'handoff_artifact_digest', 'source_run_id', 'source_run_handoff_artifact_digest', 'payload', 'payload_sha256', 'created_at'],
  },
  provider_sessions: {
    statuses: ['active', 'refreshing', 'expired', 'revoked', 'failed'],
    key_fields: ['provider_type', 'provider_name', 'cache_key_hash', 'status', 'handoff_artifact_digest', 'subject_principal', 'scope', 'session_summary', 'expires_at', 'refresh_after', 'rotation_counter', 'revocation_checked_at'],
  },
  credential_presentations: {
    statuses: ['materialized', 'cleaned', 'recovery_cleaned', 'failed'],
    key_fields: ['run_id', 'handoff_artifact_digest', 'provider_session_id', 'binding_name', 'medium', 'env_key', 'stdin_sha256', 'value_sha256', 'file_mode', 'status', 'expires_at', 'cleaned_at'],
  },
  proof_replay_ledger: {
    key_fields: ['replay_key', 'method', 'issuer', 'handoff_artifact_digest', 'run_id', 'expires_at', 'claimed_at'],
  },
};
