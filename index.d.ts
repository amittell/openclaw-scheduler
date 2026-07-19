export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// -- SQLite RunResult returned by write operations --
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SchedulerStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SchedulerTransaction<T> {
  (): T;
  deferred(): T;
  immediate(): T;
  exclusive(): T;
}

export interface SchedulerDatabase {
  readonly inTransaction: boolean;
  prepare(source: string): SchedulerStatement;
  transaction<T>(callback: () => T): SchedulerTransaction<T>;
  exec(source: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

// -- Record interfaces matching schema.sql --

export interface JobSpec {
  id?: string;
  name: string;
  enabled?: number | boolean;

  // Schedule
  schedule_kind?: 'cron' | 'at';
  schedule_cron?: string | null;
  schedule_at?: string | null;
  schedule_tz?: string | null;

  // Execution
  session_target?: 'main' | 'isolated' | 'shell';
  agent_id?: string | null;

  // Payload
  payload_kind?: 'systemEvent' | 'agentTurn' | 'shellCommand';
  payload_message: string;
  payload_model?: string | null;
  payload_model_fallback?: string | null;
  payload_thinking?: string | null;
  payload_timeout_seconds?: number;
  payload_scope?: 'own' | 'global';
  execution_intent?: 'execute' | 'plan' | 'fire-and-forget';
  execution_read_only?: number | boolean;
  shell_env_policy?: 'minimal' | 'inherit';

  // Overlap & timeout
  overlap_policy?: 'skip' | 'allow' | 'queue';
  run_timeout_ms: number;
  max_queued_dispatches?: number;
  max_pending_approvals?: number;
  max_trigger_fanout?: number;

  // Delivery
  delivery_mode?: 'announce' | 'announce-always' | 'none';
  delivery_channel?: string | null;
  delivery_to?: string | null;
  delivery_guarantee?: 'at-most-once' | 'at-least-once';

  // Workflow chaining
  parent_id?: string | null;
  trigger_on?: 'success' | 'failure' | 'complete' | null;
  trigger_delay_s?: number;
  trigger_condition?: string | null;

  // Retry
  max_retries?: number;

  // Metadata
  delete_after_run?: number | boolean;
  ttl_hours?: number | null;
  resource_pool?: string | null;
  job_class?: 'standard' | 'pre_compaction_flush';

  // HITL approval gates
  approval_required?: number | boolean;
  approval_timeout_s?: number;
  approval_auto?: 'approve' | 'reject';
  approval_risk_level?: 'low' | 'medium' | 'high' | null;
  approval_approver_scope?: string | null;

  // Context retrieval
  context_retrieval?: 'none' | 'recent' | 'hybrid';
  context_retrieval_limit?: number;

  // Output handling
  output_store_limit_bytes?: number;
  output_excerpt_limit_bytes?: number;
  output_summary_limit_bytes?: number;
  output_offload_threshold_bytes?: number;
  output_format?: 'json' | 'ndjson' | 'text' | null;
  verify_shell?: string | null;
  verify_timeout_s?: number | null;
  verify_on_failure?: 'warn' | 'error' | null;

  // Session continuity
  preferred_session_key?: string | null;

  // Auth profile override
  auth_profile?: string | null;
  auth_profile_fallback?: string | null;

  // Delivery opt-out
  delivery_opt_out_reason?: string | null;

  // Watchdog monitoring
  job_type?: 'standard' | 'watchdog';
  watchdog_target_label?: string | null;
  watchdog_check_cmd?: string | null;
  watchdog_timeout_min?: number | null;
  watchdog_alert_channel?: string | null;
  watchdog_alert_target?: string | null;
  watchdog_self_destruct?: number | boolean;
  watchdog_started_at?: string | null;

  // Origin tracking
  origin?: string | null;

  // Convenience flag (create-time only)
  run_now?: boolean;

  // v0.2 Identity
  identity_principal?: string | null;
  identity_run_as?: string | null;
  identity_attestation?: string | null;
  identity_ref?: string | null;
  identity_subject_kind?: 'agent' | 'service' | 'workload' | 'user' | 'composite' | 'delegated-agent' | 'unknown' | null;
  identity_subject_principal?: string | null;
  identity_trust_level?: 'untrusted' | 'restricted' | 'supervised' | 'autonomous' | null;
  identity_delegation_mode?: 'none' | 'on-behalf-of' | 'impersonation' | null;
  identity?: string | null;

  // v0.2 Authorization Proof
  authorization_proof_ref?: string | null;
  authorization_proof?: string | null;

  // v0.2 Authorization
  authorization_ref?: string | null;
  authorization?: string | null;

  // v0.2 Evidence
  evidence_ref?: string | null;
  evidence?: string | null;

  // v0.2 Contract
  contract_required_trust_level?: 'untrusted' | 'restricted' | 'supervised' | 'autonomous' | null;
  contract_trust_enforcement?: 'none' | 'warn' | 'block' | 'advisory' | 'strict' | null;
  contract_sandbox?: string | null;
  contract_allowed_paths?: string | null;
  contract_network?: string | null;
  contract_max_cost_usd?: number | null;
  contract_audit?: string | null;
  child_credential_policy?: 'none' | 'inherit' | 'downscope' | 'independent' | null;

  // Handoff v4 immutable execution binding
  handoff_version?: 4 | null;
  handoff_artifact_digest?: string | null;
  /** Create/update input only. Persisted artifacts are addressed by digest. */
  handoff_artifact_payload?: string | Record<string, unknown> | null;
  effective_task_hash?: string | null;

  [key: string]: unknown;
}

export interface JobRecord extends JobSpec {
  id: string;
  enabled: number;
  schedule_kind: 'cron' | 'at';
  schedule_cron: string | null;
  schedule_at: string | null;
  schedule_tz: string;
  payload_model_fallback?: string | null;
  auth_profile_fallback?: string | null;
  payload_kind: 'systemEvent' | 'agentTurn' | 'shellCommand';
  payload_message: string;
  ttl_hours: number | null;
  auth_profile: string | null;
  delivery_opt_out_reason: string | null;

  // Scheduling state (denormalized)
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  consecutive_errors?: number;
  queued_count?: number;

  // Timestamps
  created_at?: string;
  updated_at?: string;
}

export interface RunRecord {
  id: string;
  job_id: string;
  status: string;

  // Timestamps
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  dispatched_at?: string | null;
  last_heartbeat?: string | null;

  // Session tracking
  session_key?: string | null;
  session_id?: string | null;

  // Result
  summary?: string | null;
  error_message?: string | null;
  shell_exit_code?: number | null;
  shell_signal?: string | null;
  shell_timed_out?: number | boolean | null;
  shell_stdout?: string | null;
  shell_stderr?: string | null;
  shell_stdout_path?: string | null;
  shell_stderr_path?: string | null;
  shell_stdout_bytes?: number | null;
  shell_stderr_bytes?: number | null;

  // Timeout
  run_timeout_ms?: number;

  // Retry tracking
  retry_count?: number;
  retry_of?: string | null;
  triggered_by_run?: string | null;
  dispatch_queue_id?: string | null;
  handoff_artifact_digest?: string | null;
  runtime_instance_id?: string | null;
  source_run_id?: string | null;
  source_run_handoff_artifact_digest?: string | null;
  evidence_required?: number | boolean;
  evidence_execution_snapshot?: string | null;
  evidence_declaration_snapshot?: string | null;
  evidence_ref_snapshot?: string | null;

  // Context & replay
  context_summary?: string | null;
  replay_of?: string | null;

  // Idempotency
  idempotency_key?: string | null;

  // v0.2 Outcomes
  identity_resolved?: string | null;
  trust_evaluation?: string | null;
  authorization_decision?: string | null;
  authorization_proof_verification?: string | null;
  evidence_record?: string | null;
  credential_handoff_summary?: string | null;
  delegation_validation?: string | null;

  // Structured output contract result
  output_format?: 'json' | 'ndjson' | 'text' | null;
  structured_output?: string | null;
  structured_output_valid?: number | boolean | null;
  structured_output_warning?: string | null;
  structured_output_bytes?: number | null;
  structured_output_sha256?: string | null;
  structured_output_path?: string | null;
  verification_result?: string | null;
  approval_used?: string | null;

  // Dispatcher ownership, cancellation, and process tracking
  dispatcher_owner?: string | null;
  dispatcher_token?: number | null;
  dispatch_started_at?: string | null;
  cancel_requested_at?: string | null;
  cancel_requested_by?: string | null;
  cancel_reason?: string | null;
  process_pid?: number | null;
  process_pgid?: number | null;
  process_identity?: string | null;
  process_started_at?: string | null;
  process_terminated_at?: string | null;
  agent_cancel_requested_at?: string | null;
  terminal_transition_at?: string | null;

  [key: string]: unknown;
}

export interface MessageRecord {
  id: string;

  // Routing
  from_agent?: string | null;
  to_agent?: string | null;
  team_id?: string | null;
  member_id?: string | null;
  task_id?: string | null;
  reply_to?: string | null;

  // Content
  kind: string;
  subject?: string | null;
  body: string;
  metadata?: JsonValue | null;

  // Priority & delivery
  priority?: number;
  channel?: string | null;
  delivery_to?: string | null;

  // Status
  status?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  ack_required?: number;
  ack_at?: string | null;
  delivery_attempts?: number;
  last_error?: string | null;
  team_mapped_at?: string | null;
  expires_at?: string | null;

  // Metadata
  created_at?: string;

  // Links
  job_id?: string | null;
  run_id?: string | null;
  owner?: string | null;

  // Idempotency
  idempotency_key?: string | null;
  /** Set by sendMessage when an idempotency-key conflict returned the existing row. */
  deduped?: boolean;

  [key: string]: unknown;
}

export interface ApprovalRecord {
  id: string;
  job_id: string;
  run_id?: string | null;
  dispatch_queue_id?: string | null;
  status: string;
  requested_at?: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  notes?: string | null;
  decision_version?: number;
  cancelled_reason?: string | null;
  expires_at?: string | null;
  approved_at?: string | null;
  rejected_at?: string | null;
  dispatched_at?: string | null;
  risk_level?: 'low' | 'medium' | 'high' | null;
  approver_scope?: string | null;
  binding_hash?: string | null;
  gate_kind: 'job' | 'authorization';
  decision_context?: string | null;
  handoff_artifact_digest?: string | null;
  source_run_id?: string | null;
  source_run_handoff_artifact_digest?: string | null;
  deduped?: boolean;
  [key: string]: unknown;
}

export interface EvidenceRecord {
  id: string;
  run_id: string;
  job_id: string;
  evidence_ref?: string | null;
  algorithm: 'sha256';
  hash: string;
  payload: JsonValue | null;
  retention_policy?: string | null;
  retention_until?: string | null;
  handoff_artifact_digest?: string | null;
  source_run_id?: string | null;
  source_run_handoff_artifact_digest?: string | null;
  evidence_method?: string | null;
  evidence_verified?: number | boolean;
  evidence_envelope?: string | Record<string, unknown> | null;
  created_at: string;
  integrity: {
    valid: boolean;
    cryptographically_verified?: boolean;
    provider?: string | null;
    method?: string | null;
    principal?: string | null;
    key_fingerprint?: string | null;
    code?: string;
    algorithm?: 'sha256';
    expected_hash?: string;
    actual_hash?: string;
    error?: string;
    errors?: string[];
  };
}

export interface AgentRecord {
  id: string;
  name?: string | null;
  status?: string | null;
  last_seen_at?: string | null;
  session_key?: string | null;
  capabilities?: JsonValue | null;
  delivery_channel?: string | null;
  delivery_to?: string | null;
  brand_name?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface DispatchRecord {
  id: string;
  job_id: string;
  dispatch_kind: 'schedule' | 'at' | 'manual' | 'chain' | 'retry';
  status: string;
  scheduled_for: string;
  binding_scheduled_for: string;
  source_run_id?: string | null;
  retry_of_run_id?: string | null;
  created_at?: string;
  claimed_at?: string | null;
  processed_at?: string | null;
  claim_owner?: string | null;
  claim_token?: string | null;
  claim_expires_at?: string | null;
  attempt_count?: number;
  last_error?: string | null;
  replay_of_run_id?: string | null;
  handoff_artifact_digest?: string | null;
  source_run_handoff_artifact_digest?: string | null;
  [key: string]: unknown;
}

export interface HandoffArtifactRecord {
  digest: string;
  artifact_schema_version: 1;
  handoff_version: 4;
  scheduler_schema_min: 29;
  canonicalization: 'json-sort-v1';
  canonicalization_version: 1;
  execution_binding_version: 2;
  manifest_digest: string;
  workflow_id?: string | null;
  task_id?: string | null;
  job_id: string;
  effective_task_hash: string;
  payload: Record<string, unknown>;
  payload_bytes: number;
  created_at?: string;
  [key: string]: unknown;
}

export interface RuntimeEventRecord {
  id: number;
  event_type: string;
  event_version: number;
  job_id?: string | null;
  dispatch_queue_id?: string | null;
  run_id?: string | null;
  approval_id?: string | null;
  handoff_artifact_digest?: string | null;
  source_run_id?: string | null;
  source_run_handoff_artifact_digest?: string | null;
  payload: Record<string, unknown>;
  payload_sha256: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ProviderSessionRecord {
  id: string;
  provider_type: string;
  provider_name: string;
  cache_key_hash: string;
  status: 'active' | 'refreshing' | 'expired' | 'revoked' | 'failed';
  handoff_artifact_digest: string;
  subject_principal?: string | null;
  scope?: string | null;
  session_summary: string;
  expires_at?: string | null;
  refresh_after?: string | null;
  rotation_counter: number;
  revocation_checked_at?: string | null;
  transient_error_count?: number;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface CredentialPresentationRecord {
  id: string;
  run_id: string;
  handoff_artifact_digest: string;
  provider_session_id?: string | null;
  binding_name: string;
  medium: 'env' | 'temp-file' | 'stdin' | 'gateway-env-header';
  env_key?: string | null;
  temp_path?: { basename: string; sha256: string } | null;
  stdin_sha256?: string | null;
  value_sha256: string;
  file_mode?: '0600' | null;
  status: 'materialized' | 'cleaned' | 'recovery_cleaned' | 'failed';
  expires_at?: string | null;
  cleaned_at?: string | null;
  last_error?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface CredentialMaterialization {
  env: Record<string, string>;
  gatewayEnv: Record<string, string>;
  stdin: Uint8Array | null;
  presentationIds: string[];
  tempPaths: string[];
  runtimeRoot: string;
}

export interface ArtifactEvidenceVerification {
  id: string;
  run_id: string;
  job_id: string;
  evidence_ref?: string | null;
  handoff_artifact_digest: string;
  payload: JsonValue | null;
  integrity: EvidenceRecord['integrity'];
  [key: string]: unknown;
}

export interface ShellResult {
  status: 'ok' | 'error' | 'timeout';
  summary: string;
  deliveryText: string;
  errorMessage: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  contextSummary: Record<string, JsonValue>;
}

/** Partial shell result returned by extractShellResultFromRun (no status/summary/deliveryText/contextSummary). */
export interface PartialShellResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  errorMessage: string | null;
}

// -- Parameter option interfaces --

export interface SendMessageOpts {
  from_agent: string;
  to_agent: string;
  kind?: string;
  subject?: string;
  body: string;
  metadata?: JsonValue | null;
  priority?: number;
  channel?: string | null;
  expires_at?: string | null;
  reply_to?: string | null;
  team_id?: string | null;
  member_id?: string | null;
  task_id?: string | null;
  job_id?: string | null;
  run_id?: string | null;
  owner?: string | null;
  ack_required?: number | boolean;
  delivery_to?: string | null;
  /** Deterministic dedup key; a re-send with the same key returns the original row. */
  idempotency_key?: string | null;
}

export interface CreateRunOpts {
  status?: string;
  run_timeout_ms?: number;
  session_key?: string | null;
  session_id?: string | null;
  context_summary?: string | object | null;
  replay_of?: string | null;
  idempotency_key?: string | null;
  retry_count?: number;
  retry_of?: string | null;
  triggered_by_run?: string | null;
  dispatch_queue_id?: string | null;
  evidence_required?: number | boolean;
  approval_used?: JsonValue | string | null;
  ownerId?: string | null;
  fencingToken?: number | null;
}

export interface FinishRunOpts {
  summary?: string | null;
  error_message?: string | null;
  context_summary?: string | object | null;
  shell_exit_code?: number | null;
  shell_signal?: string | null;
  shell_timed_out?: number | boolean | null;
  shell_stdout?: string | null;
  shell_stderr?: string | null;
  shell_stdout_path?: string | null;
  shell_stderr_path?: string | null;
  shell_stdout_bytes?: number | null;
  shell_stderr_bytes?: number | null;

  // v0.2 Outcomes
  identity_resolved?: string | object | null;
  trust_evaluation?: string | object | null;
  authorization_decision?: string | object | null;
  authorization_proof_verification?: string | object | null;
  evidence_record?: string | object | null;
  credential_handoff_summary?: string | object | null;
  delegation_validation?: string | object | null;
  output_format?: 'json' | 'ndjson' | 'text' | null;
  structured_output?: string | null;
  structured_output_valid?: number | boolean | null;
  structured_output_warning?: string | null;
  structured_output_bytes?: number | null;
  structured_output_sha256?: string | null;
  structured_output_path?: string | null;
  verification_result?: string | object | null;
  ownerId?: string;
  fencingToken?: number;
}

export interface NormalizeShellOpts {
  runId?: string | null;
  timeoutMs?: number;
  storeLimit?: number;
  excerptLimit?: number;
  summaryLimit?: number;
  offloadThreshold?: number;
  artifactsDir?: string;
}

export interface InboxOpts {
  limit?: number;
  includeRead?: boolean;
  includeDelivered?: boolean;
  teamId?: string;
  memberId?: string;
  taskId?: string;
}

export interface TeamMessagesOpts {
  limit?: number;
  includeRead?: boolean;
  memberId?: string;
  taskId?: string;
}

export interface DbPathParams {
  env?: Record<string, string | undefined>;
  explicitPath?: string;
  moduleDir?: string;
}

export interface ArtifactsDirParams {
  env?: Record<string, string | undefined>;
  explicitPath?: string;
  dbPath?: string;
}

export interface AgentTurnOpts {
  message: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
  authProfile?: string | null;
  materializedEnv?: Record<string, string> | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  cancelOnAbort?: boolean;
}

export interface AgentTurnWithTimeoutOpts {
  message: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
  authProfile?: string | null;
  materializedEnv?: Record<string, string> | null;
  sessionKinds?: string[];
  idleTimeoutMs?: number;
  pollIntervalMs?: number;
  absoluteTimeoutMs?: number;
  signal?: AbortSignal;
  cancelOnAbort?: boolean;
}

export interface AgentTurnResult {
  ok: true;
  content: string;
  usage?: Record<string, unknown>;
  sessionKey?: string;
  raw: Record<string, unknown>;
}

export interface GatewayCapabilities {
  readonly version: string | null;
  readonly protocol: number | null;
  readonly capabilities: readonly string[];
  readonly source: string;
  readonly legacy: boolean;
}

export interface GatewayCapabilityDiscoveryOpts {
  gatewayUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  requestHeaders?: Record<string, string>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

export interface GatewayEnvironmentNegotiation {
  readonly headers: Readonly<Record<string, string>>;
  readonly gateway: GatewayCapabilities | null;
}

export interface GatewayCompatibilityError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly gatewayVersion?: string | null;
  readonly gatewayProtocol?: number | null;
  readonly gatewayCapabilities?: string[];
  readonly discoverySource?: string;
  readonly legacyGateway?: boolean;
  readonly requiredCapability?: string;
}

export interface DeliveryResult {
  ok: true;
  channel?: string | null;
  target?: string | null;
  parts: number;
  lastResponse: unknown;
  responses?: unknown[];
}

export interface DispatcherLeaseRecord {
  name: string;
  owner_id: string;
  fencing_token: number;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  active?: number;
}

export interface DeliveryAttachmentRecord {
  id: string;
  outbox_id: string;
  message_id?: string | null;
  ordinal: number;
  name: string;
  mime_type?: string | null;
  source_path: string | null;
  content_blob?: Uint8Array | null;
  size_bytes: number;
  sha256: string;
  created_at?: string;
}

export interface DeliveryOutboxRecord {
  id: string;
  message_id?: string | null;
  job_id?: string | null;
  run_id?: string | null;
  channel: string;
  target: string;
  body: string;
  status: 'pending' | 'claimed' | 'delivered' | 'failed' | 'cancelled';
  idempotency_key?: string | null;
  delivery_group_id?: string | null;
  part_index?: number | null;
  part_count?: number | null;
  completion_label?: string | null;
  completion_scope?: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  claim_owner?: string | null;
  claim_token?: string | null;
  claim_expires_at?: string | null;
  last_error?: string | null;
  created_at: string;
  delivered_at?: string | null;
  attachments?: DeliveryAttachmentRecord[];
  deduped?: boolean;
}

export interface MultipartDeliveryResult extends DeliveryOutboxRecord {
  partCount: number;
  deliveries: DeliveryOutboxRecord[];
  checkpointKey: string | null;
}

export interface DeliveryCheckpoint {
  idempotencyKey: string;
  partCount: number;
  complete: boolean;
  statusCounts: Record<string, number>;
  deliveries: DeliveryOutboxRecord[];
}

export interface GovernanceDecision {
  allowed: boolean;
  violations: string[];
  warnings: string[];
  policy: Record<string, unknown>;
  enforcement: Record<string, boolean>;
  evaluated_at: string;
}

export interface AuthenticatedApprovalActor {
  authenticated: true;
  source: 'os-user';
  canonical: string;
  username: string;
  uid: number | null;
  aliases: readonly string[];
}

export interface ApprovalTransitionResult {
  changed: boolean;
  approval: ApprovalRecord | null;
  reason: string | null;
}

export interface ApprovalStateOpts {
  db?: SchedulerDatabase;
  resolvedBy?: string;
  authenticatedActor?: AuthenticatedApprovalActor;
  automatic?: boolean;
  notes?: string | null;
  reason?: string | null;
}

export interface DeliveryAttachmentInput {
  path?: string;
  sourcePath?: string;
  source_path?: string;
  name?: string | null;
  mimeType?: string | null;
  mime_type?: string | null;
}

export interface DeliveryAttachmentOpts {
  db?: SchedulerDatabase;
  dbPath?: string;
  artifactsDir?: string;
  maxBytes?: number;
  maxCount?: number;
  maxTotalBytes?: number;
  persistFiles?: boolean;
  includeContent?: boolean;
}

export interface RunTransitionResult {
  changed: boolean;
  run: RunRecord | null;
  fenced?: boolean;
}

// -- Module declarations --

export const db: {
  setDbPath(path: string): void;
  getDb(): SchedulerDatabase;
  getResolvedDbPath(): string;
  applyBundledSchema(label?: string): SchedulerDatabase;
  initDb(): Promise<unknown>;
  checkpointWal(): { busy: number; checkpointed: number; log: number } | null;
  closeDb(): void;
};

export const jobs: {
  // Validation
  validateJobSpec(opts: JobSpec, currentJob?: Partial<JobRecord> | null, mode?: 'create' | 'update'): JobSpec;
  validateJobPayload(sessionTarget: string, payloadKind: string): void;

  // CRUD
  createJob(opts: JobSpec): JobRecord;
  getJob(id: string): JobRecord | undefined;
  listJobs(opts?: { enabledOnly?: boolean }): JobRecord[];
  updateJob(id: string, patch: Partial<JobSpec>): JobRecord | null;
  deleteJob(id: string): void;

  // At-job helpers
  parseInDuration(duration: string): string;
  AT_JOB_CRON_SENTINEL: string;

  // Scheduling
  nextRunFromCron(cronExpr: string, tz?: string | null): string | null;
  getDueJobs(): JobRecord[];
  getDueAtJobs(): JobRecord[];
  runJobNow(id: string): (JobRecord & { dispatch_id: string; dispatch_kind: string }) | null;

  // Chaining
  getTriggeredChildren(parentId: string, status: string): JobRecord[];
  getChildJobs(parentId: string): JobRecord[];
  evalTriggerCondition(condition: string | null, content: string): boolean;
  fireTriggeredChildren(parentId: string, status: string, content: string, parentRunId?: string | null): Array<JobRecord & { dispatch_id: string; scheduled_for: string }>;
  detectCycle(childId: string, parentId: string): void;
  getChainDepth(jobId: string): number;

  // Queue management
  enqueueJob(jobId: string): { queued: boolean; queued_count: number; limited: boolean };
  dequeueJob(jobId: string): boolean;
  getDispatchBacklogCount(jobId: string): number;
  canEnqueueDispatch(jobId: string, maxQueuedDispatches?: number): boolean;

  // Retry
  shouldRetry(job: JobRecord, runId: string): boolean;
  scheduleRetry(job: JobRecord, failedRunId: string): {
    retryCount: number;
    delaySec: number;
    retryOf: string;
    dispatch: DispatchRecord | null;
    skipped?: boolean;
  };

  // Overlap detection
  hasRunningRun(jobId: string): boolean;
  hasRunningRunForPool(poolName: string): boolean;

  // Lifecycle
  cancelJob(jobId: string, opts?: { cascade?: boolean }): string[];
  pruneExpiredJobs(): number;
};

export const runs: {
  createRun(jobId: string, opts?: CreateRunOpts): RunRecord;
  getRun(id: string): RunRecord | undefined;
  getRunsForJob(jobId: string, limit?: number): RunRecord[];
  finishRun(id: string, status: string, opts?: FinishRunOpts): RunRecord | null;
  finishRunCas(id: string, status: string, opts?: FinishRunOpts): RunTransitionResult;
  updateHeartbeat(id: string): void;
  updateRunSession(id: string, sessionKey: string | null, sessionId: string | null): void;
  getStaleRuns(thresholdSeconds?: number): Array<RunRecord & { job_name: string; job_timeout_ms: number }>;
  getTimedOutRuns(): Array<RunRecord & { job_name: string; job_timeout_ms: number }>;
  getRunningRuns(): Array<RunRecord & { job_name: string; job_timeout_ms: number }>;
  getRunningRunsByPool(poolName: string): Array<RunRecord & { job_name: string }>;
  pruneRuns(keepPerJob?: number): void;
  updateContextSummary(runId: string, summaryObj: unknown): RunRecord | undefined;
  persistV02Outcomes(runId: string, outcomes: Record<string, unknown>, opts?: { db?: SchedulerDatabase }): void;
  persistTerminalEvidence(
    job: JobRecord,
    runId: string,
    status: string,
    fields?: FinishRunOpts & Record<string, unknown>,
    outcomes?: Record<string, unknown>,
    opts?: Record<string, unknown> & { db?: SchedulerDatabase },
  ): EvidenceRecord | null;
  quarantineRunRecovery(
    runId: string,
    reason: string,
    opts?: {
      db?: SchedulerDatabase;
      dispatcherFence?: {
        ownerId: string;
        fencingToken: number;
        leaseName?: string;
      } | null;
      allowStaleRunOwner?: boolean;
    },
  ): { changed: boolean; run: RunRecord | null };
  transitionRunTerminalWithEvidence(
    job: JobRecord,
    runId: string,
    status: string,
    fields?: FinishRunOpts & Record<string, unknown>,
    outcomes?: Record<string, unknown>,
    opts?: Record<string, unknown> & { db?: SchedulerDatabase },
  ): RunTransitionResult;
  getEvidenceRecord(runId: string, opts?: { db?: SchedulerDatabase }): EvidenceRecord | null;
  pruneEvidenceRecords(opts?: { db?: SchedulerDatabase; limit?: number; now?: string | number | Date }): SqliteRunResult;
};

export const messages: {
  sendMessage(opts: SendMessageOpts): MessageRecord;
  getMessage(id: string): MessageRecord | undefined;
  getInbox(agentId: string, opts?: InboxOpts): MessageRecord[];
  claimInboxForRun(agentId: string, runId: string, opts?: { limit?: number; db?: SchedulerDatabase }): MessageRecord[];
  ackClaimedInboxForRun(runId: string, messageIds: string[], opts?: { db?: SchedulerDatabase }): { acked: number; messages: MessageRecord[] };
  releaseClaimedInboxForRun(runId: string, messageIds: string[], opts?: { db?: SchedulerDatabase; reason?: string }): { released: number; messages: MessageRecord[] };
  recoverStaleInboxClaims(opts?: { olderThanSeconds?: number; db?: SchedulerDatabase }): { recovered: number; messages: MessageRecord[] };
  getOutbox(agentId: string, limit?: number): MessageRecord[];
  getThread(messageId: string): MessageRecord[];
  getTeamMessages(teamId: string, opts?: TeamMessagesOpts): MessageRecord[];
  markDelivered(id: string): void;
  markRead(id: string): void;
  markAllRead(agentId: string): SqliteRunResult;
  getUnreadCount(agentId: string): number;
  ackMessage(id: string, actor?: string, detail?: string | null): MessageRecord;
  expireMessages(): SqliteRunResult;
  pruneMessages(keepDays?: number, deliveredKeepDays?: number, systemKeepDays?: number): SqliteRunResult;
  recordMessageAttempt(messageId: string, opts?: { ok?: boolean; actor?: string; error?: string }): MessageRecord | null;
  listMessageReceipts(messageId: string, limit?: number): Array<Record<string, unknown>>;
};

export const approvals: {
  APPROVAL_STATUSES: Readonly<Record<'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMED_OUT' | 'CANCELLED' | 'DISPATCHING' | 'DISPATCHED', string>>;
  createApproval(jobId: string, runId: string | null, dispatchQueueId?: string | null, opts?: {
    db?: SchedulerDatabase;
    gateKind?: 'job' | 'authorization';
    timeoutSeconds?: number;
    expiresAt?: string | number | Date;
    riskLevel?: 'low' | 'medium' | 'high';
    approverScope?: string | null;
    decisionContext?: string | Record<string, unknown> | null;
    releaseIdempotencyKey?: string | null;
  }): ApprovalRecord & { deduped: boolean };
  getApproval(id: string): ApprovalRecord | undefined;
  getPendingApproval(jobId: string, opts?: { db?: SchedulerDatabase }): ApprovalRecord | undefined;
  listPendingApprovals(): Array<ApprovalRecord & { job_name: string }>;
  resolveApproval(id: string, status: string, resolvedBy?: string | null, notes?: string | null, opts?: { automatic?: boolean }): ApprovalRecord | null;
  countPendingApprovalsForJob(jobId: string): number;
  getTimedOutApprovals(): Array<ApprovalRecord & { job_name: string; approval_timeout_s: number; approval_auto: string }>;
  pruneApprovals(retentionDays?: number): SqliteRunResult;
  getApprovalForDispatch(dispatchQueueId: string, opts?: Record<string, unknown>): ApprovalRecord | null;
  beginApprovalDispatch(dispatchQueueId: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  deferApprovalDispatch(dispatchQueueId: string, reason?: string | null, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  markApprovalDispatched(dispatchQueueId: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  cancelApprovalForDispatch(dispatchQueueId: string, reason?: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  cancelApprovalsForJob(jobId: string, reason?: string, opts?: Record<string, unknown>): { changed: number; approvals: ApprovalRecord[] };
  cancelApproval(id: string, reason?: string, opts?: Record<string, unknown>): ApprovalTransitionResult;
  cancelUnavailableJobApprovals(opts?: { db?: SchedulerDatabase }): { changed: number; approvals: ApprovalRecord[] };
  recoverInterruptedApprovalDispatches(opts?: { db?: SchedulerDatabase }): { recovered: number };
  approverMatchesScope(approver: string | { aliases: readonly string[] }, scope: string | null): boolean;
};

export const agents: {
  upsertAgent(id: string, opts?: { name?: string; status?: string; session_key?: string | null; capabilities?: JsonValue | null; delivery_channel?: string | null; delivery_to?: string | null; brand_name?: string | null }): AgentRecord;
  getAgent(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
  setAgentStatus(id: string, status: string, sessionKey?: string | null): void;
  touchAgent(id: string): void;
};

export const dispatchQueue: {
  enqueueDispatch(jobId: string, opts?: {
    id?: string;
    kind?: string;
    status?: string;
    scheduled_for?: string;
    source_run_id?: string | null;
    retry_of_run_id?: string | null;
    claimed_at?: string | null;
    processed_at?: string | null;
    replay_of_run_id?: string | null;
  }): DispatchRecord;
  getDispatch(id: string): DispatchRecord | null;
  getDueDispatches(limit?: number): Array<DispatchRecord & { job_name: string }>;
  claimDispatch(id: string, opts?: Record<string, unknown>): DispatchRecord | null;
  renewDispatchClaim(id: string, opts?: Record<string, unknown>): DispatchRecord | null;
  releaseDispatch(id: string, scheduledFor?: string | null, opts?: Record<string, unknown>): DispatchRecord | null;
  setDispatchStatus(id: string, status: string, opts?: Record<string, unknown>): DispatchRecord | null;
  recoverStaleDispatchClaims(opts?: Record<string, unknown>): number;
  cancelDisabledDispatches(): number;
  listDispatchesForJob(jobId: string, limit?: number): DispatchRecord[];
};

export const gateway: {
  TELEGRAM_MAX_MESSAGE_LENGTH: number;
  ISOLATED_DISPATCH_PRIMITIVE: string;
  GATEWAY_ENV_INJECT_HEADER: string;
  GATEWAY_ENV_INJECT_CAPABILITY: string;
  MAX_GATEWAY_ENV_ENTRIES: number;
  MAX_GATEWAY_ENV_KEY_BYTES: number;
  MAX_GATEWAY_ENV_VALUE_BYTES: number;
  MAX_GATEWAY_ENV_INJECT_HEADER_BYTES: number;
  resolveGatewayTokenPath(configuredPath?: string): string | null;
  GatewayCompatibilityError: new (
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions & { retryable?: boolean },
  ) => GatewayCompatibilityError;
  buildGatewayEnvInjectHeader(materializedEnv?: Record<string, string> | null): Record<string, string>;
  discoverGatewayCapabilities(opts?: GatewayCapabilityDiscoveryOpts): Promise<GatewayCapabilities>;
  clearGatewayCapabilityCache(gatewayUrl?: string): void;
  negotiateGatewayEnvironmentInjection(materializedEnv?: Record<string, string> | null, opts?: GatewayCapabilityDiscoveryOpts): Promise<GatewayEnvironmentNegotiation>;
  cancelAgentSession(sessionKey: string, opts?: { agentId?: string; runId?: string; timeoutMs?: number }): Promise<{ ok: boolean; aborted: boolean; error?: string }>;
  isAgentCancellationConfirmed(outcome: unknown): boolean;
  runAgentTurn(opts: AgentTurnOpts): Promise<AgentTurnResult>;
  runAgentTurnWithActivityTimeout(opts: AgentTurnWithTimeoutOpts): Promise<AgentTurnResult>;
  runIsolatedAgentTurn(opts: AgentTurnWithTimeoutOpts): Promise<AgentTurnResult>;
  sendSystemEvent(text: string, mode?: string): Promise<Record<string, unknown>>;
  invokeGatewayTool(tool: string, args: Record<string, unknown>, sessionKey?: string): Promise<Record<string, unknown>>;
  listSessions(opts?: { activeMinutes?: number; limit?: number; kinds?: string[] }): Promise<Record<string, unknown>>;
  getAllSubAgentSessions(activeMinutes?: number): Promise<Array<Record<string, unknown>>>;
  splitMessageForChannel(channel: string, message: string): string[];
  normalizeDeliveryTarget(channel: string | null, target: string | null): { channel: string | null; target: string | null };
  resolveDeliveryAlias(rawTarget: string): { channel: string; target: string } | null;
  deliverMessage(channel: string, target: string, message: string): Promise<DeliveryResult>;
  checkGatewayHealth(): Promise<boolean>;
  waitForGateway(timeoutMs?: number, intervalMs?: number): Promise<boolean>;
  applySessionOverridesToSessionStore(sessionKey: string, overrides?: { authProfile?: string | null; modelRef?: string | null }, agentId?: string): { ok: boolean; error?: string };
  applyAuthProfileToSessionStore(sessionKey: string, authProfile: string, agentId?: string): { ok: boolean; error?: string };
  /** @deprecated Gateway-backed dispatch owns authentication and does not copy credential files. */
  syncAuthStoreToSession(agentId?: string): { ok: boolean; skipped?: boolean; reason?: string; error?: string };
};

export const paths: {
  resolveSchedulerHome(env?: Record<string, string | undefined>): string;
  resolveSchedulerDbPath(params?: DbPathParams): string;
  ensureSchedulerDbParent(dbPath: string): string;
  resolveBackupStagingDir(env?: Record<string, string | undefined>): string;
  resolveServiceWorkingDirectory(params?: DbPathParams): string;
  resolveArtifactsDir(params?: ArtifactsDirParams): string;
  ensureArtifactsDir(dirPath: string): string;
};

export const promptContext: {
  buildTriggeredRunContext(run: RunRecord, deps?: {
    getRunById?: (id: string) => RunRecord | undefined;
    getJobById?: (id: string) => JobRecord | undefined;
  }): {
    text: string;
    meta: Record<string, unknown>;
  };
};

export const retrieval: {
  getRecentRunSummaries(jobId: string, limit?: number): Array<{
    id: string;
    job_id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    context_summary: string | null;
    summary: string | null;
  }>;
  searchRunSummaries(jobId: string, query: string, limit?: number): Array<{
    id: string;
    job_id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    context_summary: string | null;
    summary: string | null;
    _score: number;
  }>;
  buildRetrievalContext(job: JobRecord): string;
};

export const shellResults: {
  DEFAULT_STORE_LIMIT: number;
  DEFAULT_EXCERPT_LIMIT: number;
  DEFAULT_SUMMARY_LIMIT: number;
  DEFAULT_OFFLOAD_THRESHOLD: number;
  storeRunArtifact(kind: string, runId: string, text: unknown, artifactsDir?: string): string | null;
  normalizeShellResult(result: { stdout?: string; stderr?: string; error?: unknown }, opts?: NormalizeShellOpts): ShellResult;
  extractShellResultFromRun(run: RunRecord): PartialShellResult | null;
};

export const shellRuntime: {
  DEFAULT_MAX_BUFFER: number;
  DEFAULT_SHELL: string;
  buildShellEnvironment(env?: Record<string, string> | null, policy?: 'minimal' | 'inherit'): Record<string, string>;
  inspectProcessIdentity(pid: number): { alive: boolean; identity: string | null };
  terminateProcessTree(child: { pid: number; kill(signal?: string | number): boolean }, opts?: { pgid?: number; graceMs?: number }): Promise<boolean>;
  runShellCommand(command: string, timeoutMs?: number, env?: Record<string, string> | null, opts?: {
    signal?: AbortSignal;
    envPolicy?: 'minimal' | 'inherit';
    cwd?: string;
    shell?: string;
    maxBuffer?: number;
    killGraceMs?: number;
    onProcess?: (process: { pid: number; pgid: number | null; processIdentity: string | null; startedAt: string; terminate(reason?: unknown): void }) => void | Promise<void>;
    onProcessTerminated?: (result: Record<string, unknown>) => void | Promise<void>;
  }): Promise<Record<string, unknown>>;
};

export const runtimeLease: {
  createDispatcherOwnerId(prefix?: string): string;
  getDispatcherLease(name: string): DispatcherLeaseRecord | null;
  acquireDispatcherLease(name: string, ownerId: string, ttlMs?: number): DispatcherLeaseRecord | null;
  renewDispatcherLease(name: string, ownerId: string, fencingToken: number, ttlMs?: number): DispatcherLeaseRecord | null;
  assertDispatcherLease(name: string, ownerId: string, fencingToken: number): boolean;
  releaseDispatcherLease(name: string, ownerId: string, fencingToken: number): boolean;
};

export const dispatcherRuntime: {
  createDispatcherOwnerId(): string;
  createDispatcherRuntime(opts: Record<string, unknown>): {
    readonly ownerId: string;
    readonly fencingToken: number | null;
    readonly maxConcurrency: number;
    readonly maxPending: number;
    readonly activeCount: number;
    readonly pendingCount: number;
    readonly isLeader: boolean;
    start(): DispatcherLeaseRecord | null;
    renew(): DispatcherLeaseRecord | null;
    assertLeadership(): boolean;
    submit(key: string, task: (fence: { ownerId: string; fencingToken: number; leaseName: string }) => unknown): boolean;
    waitForIdle(): Promise<void>;
    stop(opts?: { drain?: boolean }): Promise<void>;
  };
};

export const runState: {
  ACTIVE_RUN_STATUSES: readonly string[];
  TERMINAL_RUN_STATUSES: readonly string[];
  claimRunForDispatch(runId: string, opts: { ownerId: string; fencingToken: number }): RunRecord | null;
  recordRunCredentialCleanupState(runId: string, state: {
    status: 'pending' | 'not_required' | 'cleaned' | 'failed';
    attempts?: number;
    error?: string;
  }, opts: {
    ownerId: string;
    fencingToken: number;
    leaseName?: string;
    allowAfterLeaseLoss?: boolean;
  }): RunRecord | null;
  requestRunCancellation(runId: string, opts?: { requestedBy?: string; reason?: string }): RunTransitionResult;
  cancelRunBeforeExecution(runId: string, opts?: { requestedBy?: string; reason?: string }): RunTransitionResult;
  getRunCancellation(runId: string): Record<string, unknown> | null;
  isRunCancellationRequested(runId: string): boolean;
  recordRunProcess(runId: string, processInfo: { pid: number; pgid?: number | null; processIdentity?: string | null }, opts?: Record<string, unknown>): RunRecord | null;
  recordRunProcessTerminated(runId: string, opts?: Record<string, unknown>): RunRecord | null;
  markAgentCancellationRequested(runId: string, opts?: Record<string, unknown>): RunRecord | null;
  transitionRunTerminal(runId: string, status: string, fields?: FinishRunOpts, opts?: Record<string, unknown>): RunTransitionResult;
  getOwnedActiveRuns(ownerId: string, fencingToken: number): RunRecord[];
};

export const runCompletion: {
  TERMINAL_RUN_STATUSES: Set<string>;
  isTerminalRunStatus(status: string): boolean;
  isCancellationRequested(run: RunRecord | null): boolean;
  classifyPreExecutionAbort(run: RunRecord | null, abortKind?: string | null): 'cancel' | 'complete_error' | 'recover';
  completeRunFenced(opts: Record<string, unknown>): RunTransitionResult & { status: string; cancelled: boolean };
  commitCompletionBookkeeping<T>(db: SchedulerDatabase, callback: () => T): T;
  shouldRunPostCompletionEffects(completion: RunTransitionResult & { cancelled?: boolean }): boolean;
};

export const governance: {
  isReservedCredentialEnvironmentKey(key: unknown): boolean;
  assertCredentialEnvironmentKeyAllowed(key: string): void;
  evaluateGovernance(job: JobSpec | JobRecord, opts?: Record<string, unknown>): GovernanceDecision;
  assertGovernance(job: JobSpec | JobRecord, opts?: Record<string, unknown>): GovernanceDecision;
  buildShellEnvironment(job: JobSpec | JobRecord, materializedEnv?: Record<string, string> | null, baseEnv?: Record<string, string | undefined>): Record<string, string>;
  clearMaterializedEnvironment(materializedEnv: Record<string, string> | null): void;
  summarizeGovernance(decision: GovernanceDecision | null): Record<string, unknown> | null;
};

export const deliveryOutbox: {
  DELIVERY_STATUSES: Readonly<Record<string, string>>;
  DEFAULT_DELIVERY_RETENTION_DAYS: number;
  DEFAULT_DELIVERY_PRUNE_LIMIT: number;
  DEFAULT_TELEGRAM_DELIVERY_PART_BYTES: number;
  splitDeliveryBody(body: string, opts?: { channel?: string; maxPartBytes?: number }): string[];
  enqueueDelivery(opts: Record<string, unknown>): DeliveryOutboxRecord;
  enqueueMultipartDelivery(opts: Record<string, unknown>): MultipartDeliveryResult;
  getDelivery(id: string, opts?: Record<string, unknown>): DeliveryOutboxRecord | null;
  getDeliveryCheckpoint(idempotencyKey: string, opts?: Record<string, unknown>): DeliveryCheckpoint;
  getDeliveryByIdempotencyKey(key: string, opts?: Record<string, unknown>): DeliveryOutboxRecord | null;
  listDeliveries(opts?: Record<string, unknown>): DeliveryOutboxRecord[];
  claimDueDeliveries(opts?: Record<string, unknown>): DeliveryOutboxRecord[];
  claimDelivery(id: string, opts?: Record<string, unknown>): DeliveryOutboxRecord | null;
  renewDeliveryClaim(id: string, claimToken: string, opts?: Record<string, unknown>): Record<string, unknown>;
  markDeliveryDelivered(id: string, claimToken: string, opts?: Record<string, unknown>): Record<string, unknown>;
  retryDelivery(id: string, claimToken: string, error: unknown, opts?: Record<string, unknown>): Record<string, unknown>;
  markDeliveryFailed(id: string, claimToken: string, error: unknown, opts?: Record<string, unknown>): Record<string, unknown>;
  cancelDelivery(id: string, reason?: string, opts?: Record<string, unknown>): Record<string, unknown>;
  cancelDeliveriesForRun(runId: string, reason?: string, opts?: Record<string, unknown>): number;
  cancelDeliveriesForJob(jobId: string, reason?: string, opts?: Record<string, unknown>): number;
  retryFailedDelivery(id: string, opts?: Record<string, unknown>): Record<string, unknown>;
  recoverExpiredDeliveryClaims(opts?: Record<string, unknown>): Record<string, number>;
  pruneTerminalDeliveries(opts?: Record<string, unknown>): Record<string, unknown>;
};

export const deliveryAttachments: {
  DEFAULT_MAX_ATTACHMENT_BYTES: number;
  DEFAULT_MAX_ATTACHMENT_COUNT: number;
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES: number;
  stageDeliveryAttachments(outboxId: string, attachmentInputs?: Array<string | DeliveryAttachmentInput>, opts?: DeliveryAttachmentOpts): DeliveryAttachmentRecord[];
  persistStagedAttachments(staged?: DeliveryAttachmentRecord[], opts?: DeliveryAttachmentOpts): DeliveryAttachmentRecord[];
  insertStagedAttachments(db: SchedulerDatabase, outboxId: string, messageId: string | null, staged?: DeliveryAttachmentRecord[]): void;
  cleanupStagedAttachments(staged?: DeliveryAttachmentRecord[], opts?: DeliveryAttachmentOpts): void;
  cleanupDeliveryAttachmentMaterial(outboxIds?: string[], attachments?: DeliveryAttachmentRecord[], opts?: DeliveryAttachmentOpts): {
    filesRemoved: number;
    directoriesRemoved: number;
    skippedUnsafePaths: number;
  };
  listDeliveryAttachments(outboxId: string, opts?: Record<string, unknown>): DeliveryAttachmentRecord[];
  verifyDeliveryAttachment(attachment: DeliveryAttachmentRecord): boolean;
  materializeDeliveryAttachment(attachment: DeliveryAttachmentRecord, opts?: Record<string, unknown>): string;
};

export const approvalState: {
  APPROVAL_STATUSES: Readonly<Record<'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMED_OUT' | 'CANCELLED' | 'DISPATCHING' | 'DISPATCHED', string>>;
  transitionPendingApproval(id: string, status: string, opts?: ApprovalStateOpts): ApprovalTransitionResult;
  getApprovalForDispatch(dispatchQueueId: string, opts?: { db?: SchedulerDatabase; activeOnly?: boolean }): ApprovalRecord | null;
  beginApprovalDispatch(dispatchQueueId: string, opts?: { db?: SchedulerDatabase }): ApprovalTransitionResult;
  markApprovalDispatched(dispatchQueueId: string, opts?: { db?: SchedulerDatabase; notes?: string | null }): ApprovalTransitionResult;
  deferApprovalDispatch(dispatchQueueId: string, reason?: string | null, opts?: { db?: SchedulerDatabase; scheduledFor?: string | null }): ApprovalTransitionResult;
  cancelApproval(id: string, reason?: string, opts?: { db?: SchedulerDatabase; resolvedBy?: string }): ApprovalTransitionResult;
  cancelApprovalForDispatch(dispatchQueueId: string, reason?: string, opts?: { db?: SchedulerDatabase; resolvedBy?: string }): ApprovalTransitionResult;
  cancelApprovalsForJob(jobId: string, reason?: string, opts?: { db?: SchedulerDatabase; resolvedBy?: string }): { changed: number; approvals: ApprovalRecord[] };
  cancelUnavailableJobApprovals(opts?: { db?: SchedulerDatabase }): { changed: number; approvals: ApprovalRecord[] };
  recoverInterruptedApprovalDispatches(opts?: { db?: SchedulerDatabase }): { recovered: number };
};

export const idempotency: {
  generateIdempotencyKey(jobId: string, scheduledTime: string): string;
  generateChainIdempotencyKey(parentRunId: string, childJobId: string): string;
  generateRunNowIdempotencyKey(jobId: string, dispatchId?: string | null): string;
  checkIdempotencyKey(key: string): Record<string, unknown> | null;
  getIdempotencyEntry(key: string): Record<string, unknown> | null;
  claimIdempotencyKey(key: string, jobId: string, runId: string, expiresAt: string): boolean;
  releaseIdempotencyKey(key: string): void;
  updateIdempotencyResultHash(key: string, content: string): void;
  listIdempotencyForJob(jobId: string, limit?: number): Array<Record<string, unknown>>;
  forcePruneIdempotency(): number;
};

export interface TaskGroupOpts {
  name: string;
  expectedAgents: string[];
  timeoutS?: number;
  createdBy?: string;
  deliveryChannel?: string | null;
  deliveryTo?: string | null;
}

export interface TaskGroupResult {
  id: string;
  name: string;
  status: string;
  created_at: string;
  created_by: string;
  agents: Array<{ agent_label: string; status: string }>;
}

export interface TaskGroupStatus {
  id: string;
  name: string;
  status: string;
  agents: Array<{
    label: string;
    status: string;
    session_key?: string;
    last_heartbeat?: string;
    duration: number | null;
    exit_message?: string;
    error?: string;
  }>;
  elapsed: number;
  remaining_timeout: number;
  summary?: string;
  delivery_channel: string | null;
  delivery_to: string | null;
}

export const taskTracker: {
  createTaskGroup(opts: TaskGroupOpts): TaskGroupResult;
  getTaskGroup(id: string): Record<string, unknown> | undefined;
  listActiveTaskGroups(): Array<Record<string, unknown>>;
  agentStarted(trackerId: string, agentLabel: string, sessionKey?: string): void;
  registerAgentSession(trackerId: string, agentLabel: string, sessionKey: string): void;
  touchAgentHeartbeat(trackerId: string, agentLabel: string): void;
  agentCompleted(trackerId: string, agentLabel: string, exitMessage?: string): void;
  agentFailed(trackerId: string, agentLabel: string, error?: string): void;
  checkDeadAgents(): Array<{ tracker_id: string; agent_label: string; agent_id: string }>;
  checkGroupCompletion(trackerId: string): Record<string, unknown> | null;
  getTaskGroupStatus(trackerId: string): TaskGroupStatus | null;
};

export interface TeamTaskGateOpts {
  teamId: string;
  taskId: string;
  expectedMembers: string[];
  timeoutS?: number;
  createdBy?: string;
  deliveryChannel?: string | null;
  deliveryTo?: string | null;
}

export const teamAdapter: {
  mapTeamMessages(limit?: number): number;
  listTeamTasks(teamId: string, limit?: number): Array<Record<string, unknown>>;
  listTeamMailboxEvents(teamId: string, opts?: { limit?: number; taskId?: string | null }): Array<Record<string, unknown>>;
  createTeamTaskGate(opts: TeamTaskGateOpts): {
    team_id: string;
    task_id: string;
    gate_status: string;
    tracker_id: string;
    expected_members: string[];
  };
  checkTeamTaskGates(limit?: number): { passed: number; failed: number; pending: number };
  ackTeamMessage(messageId: string, actor?: string, detail?: string | null): Record<string, unknown> | null;
};

export const SCHEDULER_SCHEMAS: {
  jobs: {
    type: string;
    required: string[];
    fields: Record<string, {
      type: string;
      default?: unknown;
      enum?: string[];
      min?: number;
      maxLength?: number;
      [key: string]: unknown;
    }>;
  };
  runs: {
    statuses: string[];
    key_fields: string[];
  };
  approvals: {
    statuses: string[];
    key_fields: string[];
  };
  dispatches: {
    kinds: string[];
    statuses: string[];
    key_fields: string[];
  };
  messages: {
    kinds: string[];
    statuses: string[];
  };
  dispatcher_leases: { key_fields: string[] };
  delivery_outbox: { statuses: string[]; key_fields: string[] };
  delivery_attachments: { key_fields: string[] };
  evidence_records: { key_fields: string[] };
};

export const handoffArtifacts: {
  HANDOFF_V4_SCHEMA: 'openclaw.scheduler.handoff-artifact';
  HANDOFF_V4_ARTIFACT_SCHEMA_VERSION: 1;
  HANDOFF_V4_CANONICALIZATION: 'json-sort-v1';
  HANDOFF_V4_CANONICALIZATION_VERSION: 1;
  HANDOFF_V4_VERSION: 4;
  HANDOFF_V4_SCHEMA_MIN: 29;
  sortKeysDeep<T>(value: T): T;
  canonicalStringify(value: unknown): string;
  sha256(value: string | Uint8Array): string;
  artifactDigest(value: unknown): string;
  validateHandoffArtifact(input: string | Record<string, unknown>, opts?: { expectedDigest?: string | null; job?: JobRecord | null }): { ok: boolean; payload: Record<string, unknown> | null; digest: string | null; errors: string[] };
  assertValidHandoffArtifact(input: string | Record<string, unknown>, opts?: { expectedDigest?: string | null; job?: JobRecord | null }): { ok: true; payload: Record<string, unknown>; digest: string; errors: [] };
  persistHandoffArtifact(input: string | Record<string, unknown>, expectedDigest: string, opts?: { db?: SchedulerDatabase }): HandoffArtifactRecord;
  getHandoffArtifact(digest: string, opts?: { db?: SchedulerDatabase }): HandoffArtifactRecord | null;
  assertArtifactMatchesJob(job: JobRecord, opts?: { db?: SchedulerDatabase }): HandoffArtifactRecord | null;
};

export const runtimeEvents: {
  appendRuntimeEvent(eventType: string, fields?: Record<string, unknown>, opts?: { db?: SchedulerDatabase }): RuntimeEventRecord;
  getRuntimeEvent(id: number, opts?: { db?: SchedulerDatabase }): RuntimeEventRecord | null;
  listRuntimeEvents(filter?: { runId?: string; jobId?: string; handoffArtifactDigest?: string; eventType?: string; limit?: number }, opts?: { db?: SchedulerDatabase }): RuntimeEventRecord[];
};

export const providerSessions: {
  resolveProviderSession(provider: Record<string, unknown>, request?: Record<string, unknown>, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ row: ProviderSessionRecord; session: Record<string, unknown>; cache_key_hash: string }>;
  getProviderSession(id: string, opts?: { db?: SchedulerDatabase }): ProviderSessionRecord | null;
  resumeProviderSession(provider: Record<string, unknown>, id: string, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ row: ProviderSessionRecord; session: Record<string, unknown> }>;
  adoptProviderSession(provider: Record<string, unknown>, request: Record<string, unknown>, resolved: Record<string, unknown>, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): { row: ProviderSessionRecord; session: Record<string, unknown>; cache_key_hash: string };
  listProviderSessions(filter?: { status?: ProviderSessionRecord['status'] }, opts?: { db?: SchedulerDatabase }): ProviderSessionRecord[];
  cleanupProviderSession(provider: Record<string, unknown>, id: string, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ ok: true; missing?: true }>;
  _resetProviderSessionMemoryForTesting(): void;
};

export const credentialRuntime: {
  materializeCredentials(provider: Record<string, unknown>, providerSession: Record<string, unknown>, presentation: Record<string, unknown>, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<CredentialMaterialization>;
  cleanupCredentialMaterialization(materialization: CredentialMaterialization, ctx?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ ok: true; cleaned: number }>;
  recoverCredentialPresentations(opts?: Record<string, unknown>): { recovered: string[]; failed: Array<{ id: string; error: string }> };
  listCredentialPresentations(filter?: { runId?: string }, opts?: { db?: SchedulerDatabase }): CredentialPresentationRecord[];
};

export const capabilityNegotiation: {
  LOCAL_ARTIFACT_BINDING_CAPABILITY: 'artifact-bound-runtime-v1';
  LOCAL_SHELL_CREDENTIAL_CAPABILITY: 'shell-credential-presentation-v1';
  negotiateCredentialCapabilities(materialized: CredentialMaterialization | null, ctx: Record<string, unknown>, opts?: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>>;
};

export const delegationRuntime: {
  validateArtifactBoundDelegation(job: JobRecord, artifactRecord: HandoffArtifactRecord | Record<string, unknown>, dispatchRecord: DispatchRecord | null, ctx?: Record<string, unknown>, opts?: { db?: SchedulerDatabase }): Readonly<Record<string, unknown>> | null;
};

export const proofRuntime: {
  claimProofReplay(db: SchedulerDatabase, input: Record<string, unknown>): { claimed: boolean; reason?: string; existingArtifactDigest?: string | null; existingRunId?: string | null };
  verifyArtifactBoundProof(job: JobRecord, artifactRecord: HandoffArtifactRecord | Record<string, unknown>, run: RunRecord, opts?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  revokeProof(input: Record<string, unknown>, opts?: { db?: SchedulerDatabase }): Record<string, unknown>;
};

export const evidenceRuntime: {
  prepareArtifactBoundEvidence(job: JobRecord, artifactRecord: HandoffArtifactRecord | Record<string, unknown>, run: RunRecord, opts?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  persistPreparedArtifactBoundEvidence(prepared: Record<string, unknown>, opts?: { db?: SchedulerDatabase }): EvidenceRecord | null;
  persistArtifactBoundEvidence(job: JobRecord, artifactRecord: HandoffArtifactRecord | Record<string, unknown>, runId: string, opts?: Record<string, unknown>): Promise<EvidenceRecord | null>;
  verifyPersistedArtifactBoundEvidence(runId: string, opts?: Record<string, unknown>): Promise<ArtifactEvidenceVerification>;
};

export const identityRuntime: {
  resolveArtifactBoundIdentity(job: JobRecord, artifactRecord: HandoffArtifactRecord | Record<string, unknown>, run: RunRecord, opts?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
};

// -- v0.2 Runtime result interfaces --

export interface ResolvedIdentity {
  provider?: string;
  session?: Record<string, unknown> | null;
  source?: 'provider' | 'provider-error';
  subject_kind?: string;
  principal?: string | null;
  trust_level?: string | null;
  delegation_mode?: string | null;
  raw?: Record<string, unknown> | null;
  transient?: boolean;
  error?: string;
}

export interface TrustEvaluation {
  effective_level: string | null;
  required_level: string | null;
  decision: 'permit' | 'deny' | 'warn';
  reason: string;
}

export interface AuthorizationProofResult {
  verified: boolean;
  method: string | null;
  ref: string | null;
  source?: 'provider' | 'provider-error' | 'explicit-opt-out' | 'verifier-required';
  provider?: string;
  error?: string;
}

export interface AuthorizationResult {
  decision: 'permit' | 'deny' | 'escalate';
  reason: string;
  ref: string | null;
  source?: 'provider' | 'provider-error' | 'reference' | 'reference-error' | 'structural' | 'structural-error';
  provider?: string;
  policy_digest?: string;
  provider_context_hash?: string | null;
  decision_context_hash?: string | null;
}

export interface EvidenceResult {
  evidence_ref: string | null;
  created_at: string;
  algorithm: 'sha256';
  hash: string;
  integrity: 'sha256';
  canonicalization: 'json-sort-v1';
  retention_policy: string | null;
  retention_until: string | null;
  payload: Record<string, unknown>;
  payload_summary: Record<string, unknown>;
}

export interface EvidenceExecutionSnapshot {
  command: Record<string, JsonValue>;
  contract: Record<string, JsonValue>;
  job_snapshot: Record<string, JsonValue>;
  hash: string;
}

export interface DelegationValidationResult {
  valid: boolean;
  mode: string | null;
  depth: number;
  max_depth: number;
  acyclic: boolean | null;
  no_duplicate_hops: boolean;
  cycle_check: 'explicit-edges' | 'not-representable';
  all_grants_present: boolean;
  provider_validated: boolean;
  errors: string[];
}

export interface CredentialHandoffSummary {
  mode: string | null;
  bindings_count: number;
  cleanup_required: boolean;
  error?: string;
}

export const v02Runtime: {
  TRUST_LEVELS: readonly string[];
  compareTrustLevels(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1;
  resolveIdentity(job: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<ResolvedIdentity | null>;
  validateDelegation(job: Record<string, unknown>, resolvedIdentity: ResolvedIdentity | null): DelegationValidationResult | null;
  evaluateTrust(job: Record<string, unknown>, resolvedIdentity: ResolvedIdentity | null): TrustEvaluation;
  verifyAuthorizationProof(job: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<AuthorizationProofResult | null>;
  evaluateAuthorization(job: Record<string, unknown>, identityResult: ResolvedIdentity | null, trustResult: TrustEvaluation | null, ctx?: Record<string, unknown>): Promise<AuthorizationResult | null>;
  buildEvidenceExecutionSnapshot(job: Record<string, unknown>): EvidenceExecutionSnapshot;
  generateEvidence(job: Record<string, unknown>, runResult: Record<string, unknown> | null, outcomes: Record<string, unknown> | null): EvidenceResult | null;
  verifyEvidenceRecord(record: EvidenceResult | string): { valid: boolean; algorithm?: 'sha256'; expected_hash?: string; actual_hash?: string; error?: string; errors?: string[] };
  summarizeCredentialHandoff(job: Record<string, unknown>): CredentialHandoffSummary | null;
};
