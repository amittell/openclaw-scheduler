export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JobSpec {
  id?: string;
  name: string;
  schedule_cron?: string | null;
  schedule_tz?: string | null;
  enabled?: number | boolean;
  session_target?: 'main' | 'isolated' | 'shell';
  payload_kind?: 'systemEvent' | 'agentTurn' | 'shellCommand';
  payload_message?: string;
  agent_id?: string | null;
  parent_id?: string | null;
  trigger_on?: 'success' | 'failure' | 'complete' | null;
  trigger_delay_s?: number;
  trigger_condition?: string | null;
  delivery_mode?: 'announce' | 'announce-always' | 'none';
  delivery_channel?: string | null;
  delivery_to?: string | null;
  overlap_policy?: 'skip' | 'allow' | 'queue';
  run_timeout_ms?: number;
  payload_timeout_seconds?: number;
  max_retries?: number;
  approval_required?: number | boolean;
  approval_timeout_s?: number;
  approval_auto?: 'approve' | 'reject';
  context_retrieval?: 'none' | 'recent' | 'hybrid';
  context_retrieval_limit?: number;
  execution_intent?: 'execute' | 'plan';
  execution_read_only?: number | boolean;
  max_queued_dispatches?: number;
  max_pending_approvals?: number;
  max_trigger_fanout?: number;
  output_store_limit_bytes?: number;
  output_excerpt_limit_bytes?: number;
  output_summary_limit_bytes?: number;
  output_offload_threshold_bytes?: number;
  resource_pool?: string | null;
  delete_after_run?: number | boolean;
  [key: string]: unknown;
}

export interface JobRecord extends JobSpec {
  id: string;
  enabled: number;
  last_status?: string | null;
  next_run_at?: string | null;
}

export interface RunRecord {
  id: string;
  job_id: string;
  status: string;
  summary?: string | null;
  error_message?: string | null;
  retry_count?: number;
  retry_of?: string | null;
  triggered_by_run?: string | null;
  dispatch_queue_id?: string | null;
  shell_exit_code?: number | null;
  shell_signal?: string | null;
  shell_timed_out?: number | boolean | null;
  shell_stdout?: string | null;
  shell_stderr?: string | null;
  shell_stdout_path?: string | null;
  shell_stderr_path?: string | null;
  shell_stdout_bytes?: number | null;
  shell_stderr_bytes?: number | null;
  [key: string]: unknown;
}

export interface MessageRecord {
  id: string;
  from_agent?: string | null;
  to_agent?: string | null;
  kind: string;
  body: string;
  status?: string | null;
  metadata?: JsonValue | null;
  [key: string]: unknown;
}

export interface ApprovalRecord {
  id: string;
  job_id: string;
  run_id?: string | null;
  status: string;
  [key: string]: unknown;
}

export interface AgentRecord {
  id: string;
  name?: string | null;
  status?: string | null;
  session_key?: string | null;
  capabilities?: JsonValue | null;
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
  contextSummary: Record<string, JsonValue>;
}

export const db: {
  setDbPath(path: string): void;
  getDb(): unknown;
  getResolvedDbPath(): string;
  initDb(): Promise<unknown>;
  checkpointWal(): unknown;
  closeDb(): void;
};

export const jobs: {
  validateJobSpec(opts: JobSpec, currentJob?: Partial<JobRecord> | null, mode?: 'create' | 'update'): JobSpec;
  validateJobPayload(sessionTarget: string, payloadKind: string): void;
  nextRunFromCron(cronExpr: string, tz?: string | null): string | null;
  createJob(opts: JobSpec): JobRecord;
  getJob(id: string): JobRecord | undefined;
  listJobs(opts?: Record<string, unknown>): JobRecord[];
  updateJob(id: string, patch: Partial<JobSpec>): JobRecord;
  deleteJob(id: string): void;
  runJobNow(id: string): { queued: boolean; dispatch_id: string };
  getDueJobs(): JobRecord[];
  getTriggeredChildren(parentId: string, status: string): JobRecord[];
  getChildJobs(parentId: string): JobRecord[];
  evalTriggerCondition(condition: string | null, content: string): boolean;
  fireTriggeredChildren(parentId: string, status: string, content: string, parentRunId?: string | null): JobRecord[];
  enqueueJob(jobId: string): { queued: boolean; queued_count: number };
  dequeueJob(jobId: string): boolean;
  shouldRetry(job: JobRecord, runId: string): boolean;
  scheduleRetry(job: JobRecord, failedRunId: string): { dispatch: unknown; retryCount: number; delaySec: number };
};

export const runs: {
  createRun(jobId: string, opts?: Record<string, unknown>): RunRecord;
  getRun(id: string): RunRecord | undefined;
  getRunsForJob(jobId: string, limit?: number): RunRecord[];
  finishRun(id: string, status: string, opts?: Record<string, unknown>): RunRecord | null;
  updateRunSession(id: string, sessionKey: string | null, sessionId: string | null): void;
  getStaleRuns(thresholdSeconds?: number): RunRecord[];
  getTimedOutRuns(): RunRecord[];
  getRunningRuns(): RunRecord[];
  pruneRuns(keepPerJob?: number): void;
  updateContextSummary(runId: string, summaryObj: unknown): RunRecord | undefined;
};

export const messages: {
  sendMessage(opts: Record<string, unknown>): MessageRecord;
  getMessage(id: string): MessageRecord | undefined;
  getInbox(agentId: string, opts?: Record<string, unknown>): MessageRecord[];
  getOutbox(agentId: string, limit?: number): MessageRecord[];
  getThread(messageId: string): MessageRecord[];
  markDelivered(id: string): void;
  markRead(id: string): void;
  markAllRead(agentId: string): void;
  getUnreadCount(agentId: string): number;
};

export const approvals: {
  createApproval(jobId: string, runId: string, dispatchQueueId?: string | null): ApprovalRecord;
  getApproval(id: string): ApprovalRecord | undefined;
  getPendingApproval(jobId: string): ApprovalRecord | undefined;
  listPendingApprovals(): ApprovalRecord[];
  resolveApproval(id: string, status: string, resolvedBy: string, notes?: string): void;
};

export const agents: {
  upsertAgent(id: string, opts?: Record<string, unknown>): AgentRecord;
  getAgent(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
  setAgentStatus(id: string, status: string, sessionKey?: string | null): void;
  touchAgent(id: string): void;
};

export const dispatchQueue: {
  enqueueDispatch(jobId: string, opts?: Record<string, unknown>): unknown;
  getDispatch(id: string): unknown;
  getDueDispatches(limit?: number): unknown[];
  claimDispatch(id: string): unknown;
  releaseDispatch(id: string, scheduledFor?: string | null): unknown;
  setDispatchStatus(id: string, status: string): unknown;
};

export const gateway: {
  TELEGRAM_MAX_MESSAGE_LENGTH: number;
  splitMessageForChannel(channel: string, message: string): string[];
  resolveDeliveryAlias(rawTarget: string): { channel: string; target: string } | null;
  deliverMessage(channel: string, target: string, message: string): Promise<void>;
  checkGatewayHealth(): Promise<boolean>;
  waitForGateway(timeoutMs?: number, intervalMs?: number): Promise<boolean>;
};

export const paths: {
  resolveSchedulerHome(env?: Record<string, string | undefined>): string;
  resolveSchedulerDbPath(params?: Record<string, unknown>): string;
  ensureSchedulerDbParent(dbPath: string): void;
  resolveArtifactsDir(params?: Record<string, unknown>): string;
  ensureArtifactsDir(dirPath: string): string;
};

export const promptContext: {
  buildTriggeredRunContext(run: Record<string, unknown>, deps?: Record<string, unknown>): {
    text: string;
    meta: Record<string, unknown>;
  };
};

export const retrieval: {
  getRecentRunSummaries(jobId: string, limit?: number): unknown[];
  searchRunSummaries(jobId: string, query: string, limit?: number): unknown[];
  buildRetrievalContext(job: JobRecord): string;
};

export const shellResults: {
  DEFAULT_STORE_LIMIT: number;
  DEFAULT_EXCERPT_LIMIT: number;
  DEFAULT_SUMMARY_LIMIT: number;
  DEFAULT_OFFLOAD_THRESHOLD: number;
  normalizeShellResult(result: Record<string, unknown>, opts?: Record<string, unknown>): ShellResult;
  extractShellResultFromRun(run: RunRecord): ShellResult;
};

export const SCHEDULER_SCHEMAS: Record<string, unknown>;
