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

  // Context retrieval
  context_retrieval?: 'none' | 'recent' | 'hybrid';
  context_retrieval_limit?: number;

  // Output handling
  output_store_limit_bytes?: number;
  output_excerpt_limit_bytes?: number;
  output_summary_limit_bytes?: number;
  output_offload_threshold_bytes?: number;

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
  [key: string]: unknown;
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
  usage: Record<string, unknown>;
  sessionKey: string;
  raw: Record<string, unknown>;
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
  source_path: string;
  content_blob?: Buffer | null;
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

export interface GovernanceDecision {
  allowed: boolean;
  violations: string[];
  warnings: string[];
  policy: Record<string, unknown>;
  enforcement: Record<string, boolean>;
  evaluated_at: string;
}

export interface RunTransitionResult {
  changed: boolean;
  run: RunRecord | null;
  fenced?: boolean;
}

// -- Module declarations --

export const db: {
  setDbPath(path: string): void;
  getDb(): import('better-sqlite3').Database;
  getResolvedDbPath(): string;
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
};

export const messages: {
  sendMessage(opts: SendMessageOpts): MessageRecord;
  getMessage(id: string): MessageRecord | undefined;
  getInbox(agentId: string, opts?: InboxOpts): MessageRecord[];
  claimInboxForRun(agentId: string, runId: string, opts?: { limit?: number; db?: import('better-sqlite3').Database }): MessageRecord[];
  ackClaimedInboxForRun(runId: string, messageIds: string[], opts?: { db?: import('better-sqlite3').Database }): { acked: number; messages: MessageRecord[] };
  releaseClaimedInboxForRun(runId: string, messageIds: string[], opts?: { db?: import('better-sqlite3').Database; reason?: string }): { released: number; messages: MessageRecord[] };
  recoverStaleInboxClaims(opts?: { olderThanSeconds?: number; db?: import('better-sqlite3').Database }): { recovered: number; messages: MessageRecord[] };
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
  createApproval(jobId: string, runId: string, dispatchQueueId?: string | null): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  getPendingApproval(jobId: string): ApprovalRecord | undefined;
  listPendingApprovals(): Array<ApprovalRecord & { job_name: string }>;
  resolveApproval(id: string, status: string, resolvedBy: string, notes?: string): ApprovalRecord;
  countPendingApprovalsForJob(jobId: string): number;
  getTimedOutApprovals(): Array<ApprovalRecord & { job_name: string; approval_timeout_s: number; approval_auto: string }>;
  pruneApprovals(retentionDays?: number): SqliteRunResult;
  getApprovalForDispatch(dispatchQueueId: string, opts?: Record<string, unknown>): ApprovalRecord | null;
  beginApprovalDispatch(dispatchQueueId: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  deferApprovalDispatch(dispatchQueueId: string, reason?: string | null, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  markApprovalDispatched(dispatchQueueId: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  cancelApprovalForDispatch(dispatchQueueId: string, reason?: string, opts?: Record<string, unknown>): { changed: boolean; approval: ApprovalRecord | null; reason: string | null };
  cancelApprovalsForJob(jobId: string, reason?: string, opts?: Record<string, unknown>): { changed: number; approvals: ApprovalRecord[] };
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
  cancelAgentSession(sessionKey: string, opts?: { agentId?: string; runId?: string; timeoutMs?: number }): Promise<{ ok: boolean; aborted: boolean; error?: string }>;
  runAgentTurn(opts: AgentTurnOpts): Promise<AgentTurnResult>;
  runAgentTurnWithActivityTimeout(opts: AgentTurnWithTimeoutOpts): Promise<AgentTurnResult>;
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
};

export const paths: {
  resolveSchedulerHome(env?: Record<string, string | undefined>): string;
  resolveSchedulerDbPath(params?: DbPathParams): string;
  ensureSchedulerDbParent(dbPath: string): string;
  resolveBackupStagingDir(env?: Record<string, string | undefined>): string;
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
  normalizeShellResult(result: { stdout?: string; stderr?: string; error?: unknown }, opts?: NormalizeShellOpts): ShellResult;
  extractShellResultFromRun(run: RunRecord): PartialShellResult | null;
};

export const shellRuntime: {
  DEFAULT_MAX_BUFFER: number;
  DEFAULT_SHELL: string;
  buildShellEnvironment(env?: Record<string, string> | null, policy?: 'minimal' | 'inherit'): Record<string, string>;
  inspectProcessIdentity(pid: number): { alive: boolean; identity: string | null };
  terminateProcessTree(child: { pid: number; kill(signal?: NodeJS.Signals): boolean }, opts?: { pgid?: number; graceMs?: number }): Promise<boolean>;
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
  completeRunFenced(opts: Record<string, unknown>): RunTransitionResult & { status: string; cancelled: boolean };
  commitCompletionBookkeeping<T>(db: import('better-sqlite3').Database, callback: () => T): T;
  shouldRunPostCompletionEffects(completion: RunTransitionResult & { cancelled?: boolean }): boolean;
};

export const governance: {
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
  enqueueDelivery(opts: Record<string, unknown>): DeliveryOutboxRecord;
  getDelivery(id: string, opts?: Record<string, unknown>): DeliveryOutboxRecord | null;
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
  listDeliveryAttachments(outboxId: string, opts?: Record<string, unknown>): DeliveryAttachmentRecord[];
  verifyDeliveryAttachment(attachment: DeliveryAttachmentRecord): boolean;
  materializeDeliveryAttachment(attachment: DeliveryAttachmentRecord, opts?: Record<string, unknown>): string;
};

export const approvalState: Record<string, unknown>;

export const idempotency: {
  generateIdempotencyKey(jobId: string, scheduledTime?: string): string;
  generateChainIdempotencyKey(parentRunId: string, childJobId: string): string;
  generateRunNowIdempotencyKey(jobId: string): string;
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
};

// -- v0.2 Runtime result interfaces --

export interface ResolvedIdentity {
  provider?: string;
  session?: Record<string, unknown> | null;
  source?: 'provider' | 'provider-error';
  subject_kind: string;
  principal: string | null;
  trust_level: string | null;
  delegation_mode: string | null;
  raw: Record<string, unknown> | null;
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
  source?: 'provider' | 'provider-error';
  provider?: string;
  error?: string;
}

export interface AuthorizationResult {
  decision: 'permit' | 'deny' | 'escalate';
  reason: string;
  ref: string | null;
  source?: 'provider' | 'provider-error';
  provider?: string;
}

export interface EvidenceResult {
  evidence_ref: string | null;
  created_at: string;
  hash: string | null;
  integrity: 'none';
  payload_summary: Record<string, unknown>;
}

export interface CredentialHandoffSummary {
  mode: string | null;
  bindings_count: number;
  cleanup_required: boolean;
}

export const v02Runtime: {
  TRUST_LEVELS: readonly string[];
  compareTrustLevels(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1;
  resolveIdentity(job: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<ResolvedIdentity | null>;
  evaluateTrust(job: Record<string, unknown>, resolvedIdentity: ResolvedIdentity | null): TrustEvaluation;
  verifyAuthorizationProof(job: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<AuthorizationProofResult | null>;
  evaluateAuthorization(job: Record<string, unknown>, identityResult: ResolvedIdentity | null, trustResult: TrustEvaluation | null, ctx?: Record<string, unknown>): Promise<AuthorizationResult | null>;
  generateEvidence(job: Record<string, unknown>, runResult: Record<string, unknown> | null, outcomes: Record<string, unknown> | null): EvidenceResult | null;
  summarizeCredentialHandoff(job: Record<string, unknown>): CredentialHandoffSummary | null;
};
