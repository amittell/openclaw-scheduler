// Type-level smoke test: exercises all exported APIs to catch declaration errors.
// This file is checked by `npm run typecheck` but never executed at runtime.

import {
  db, jobs, runs, messages, approvals, agents, dispatchQueue, gateway,
  paths, promptContext, retrieval, shellResults, idempotency, taskTracker, teamAdapter,
  SCHEDULER_SCHEMAS,
  type JobSpec, type JobRecord, type RunRecord, type MessageRecord,
  type ApprovalRecord, type AgentRecord, type DispatchRecord,
  type ShellResult, type PartialShellResult,
  type SendMessageOpts, type CreateRunOpts, type FinishRunOpts,
  type NormalizeShellOpts, type InboxOpts, type TeamMessagesOpts,
  type DbPathParams, type ArtifactsDirParams,
  type AgentTurnOpts, type AgentTurnWithTimeoutOpts,
  type AgentTurnResult, type DeliveryResult, type SqliteRunResult,
  type TaskGroupOpts, type TaskGroupResult, type TaskGroupStatus,
  type TeamTaskGateOpts,
} from './index.js';

// ---- db ----
void db.getResolvedDbPath();
void db.setDbPath(':memory:');
void db.closeDb();
const checkpoint = db.checkpointWal();
if (checkpoint) { void checkpoint.busy; void checkpoint.checkpointed; void checkpoint.log; }

// ---- jobs: CRUD ----
const jobSpec: JobSpec = {
  name: 'Type smoke',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'echo ok',
  session_target: 'shell',
  payload_kind: 'shellCommand',
};
const created: JobRecord = jobs.createJob(jobSpec);
const fetched: JobRecord | undefined = jobs.getJob('id');
const listed: JobRecord[] = jobs.listJobs({ enabledOnly: true });
const updated: JobRecord | null = jobs.updateJob('id', { enabled: 0 });
jobs.deleteJob('id');

// ---- jobs: watchdog fields ----
const watchdogSpec: JobSpec = {
  name: 'Watchdog smoke',
  schedule_cron: '*/5 * * * *',
  payload_message: 'echo check',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  job_type: 'watchdog',
  watchdog_target_label: 'my-task',
  watchdog_check_cmd: 'curl -sf http://localhost/health',
  watchdog_timeout_min: 60,
  watchdog_alert_channel: 'telegram',
  watchdog_alert_target: '12345',
  watchdog_self_destruct: 1,
  watchdog_started_at: '2026-01-01 00:00:00',
};
void watchdogSpec;

// ---- jobs: additional fields ----
const fullSpec: JobSpec = {
  name: 'Full smoke',
  payload_scope: 'global',
  payload_model: 'gpt-5-mini',
  payload_thinking: 'extended',
  delivery_guarantee: 'at-least-once',
  job_class: 'standard',
  preferred_session_key: 'my-key',
  delivery_opt_out_reason: 'background job, no delivery needed',
};
void fullSpec;

// ---- jobs: scheduling ----
const nextRun: string | null = jobs.nextRunFromCron('0 0 * * *');
const due: JobRecord[] = jobs.getDueJobs();
const runNow = jobs.runJobNow('id');
if (runNow) { void runNow.dispatch_id; void runNow.dispatch_kind; void runNow.name; }

// ---- jobs: validation ----
jobs.validateJobSpec(jobSpec, null, 'create');
jobs.validateJobPayload('shell', 'shellCommand');

// ---- jobs: chaining ----
const children: JobRecord[] = jobs.getTriggeredChildren('parent', 'ok');
const allChildren: JobRecord[] = jobs.getChildJobs('parent');
const condMatch: boolean = jobs.evalTriggerCondition('contains:ALERT', 'ALERT: disk full');
const fired = jobs.fireTriggeredChildren('parent', 'ok', 'output');
if (fired.length) { void fired[0].dispatch_id; void fired[0].scheduled_for; }
jobs.detectCycle('child', 'parent');
const depth: number = jobs.getChainDepth('id');

// ---- jobs: queue management ----
const enqueued = jobs.enqueueJob('id');
void enqueued.queued; void enqueued.queued_count; void enqueued.limited;
const dequeued: boolean = jobs.dequeueJob('id');
const backlog: number = jobs.getDispatchBacklogCount('id');
const canEnqueue: boolean = jobs.canEnqueueDispatch('id', 25);

// ---- jobs: retry ----
const shouldRetry: boolean = jobs.shouldRetry(created, 'run-id');
const retryResult = jobs.scheduleRetry(created, 'run-id');
void retryResult.retryCount; void retryResult.delaySec; void retryResult.retryOf; void retryResult.dispatch;
if (retryResult.skipped) { void retryResult.skipped; }

// ---- jobs: overlap detection ----
const hasRunning: boolean = jobs.hasRunningRun('id');
const poolRunning: boolean = jobs.hasRunningRunForPool('pool');

// ---- jobs: lifecycle ----
const cancelled: string[] = jobs.cancelJob('id', { cascade: true });
const pruned: number = jobs.pruneExpiredJobs();

// ---- runs ----
const run: RunRecord = runs.createRun('job-1', { status: 'running', retry_count: 0 });
void run.started_at; void run.finished_at; void run.duration_ms;
void run.session_key; void run.last_heartbeat; void run.dispatched_at;
void run.run_timeout_ms; void run.context_summary; void run.replay_of; void run.idempotency_key;
const gotRun: RunRecord | undefined = runs.getRun('id');
const jobRuns: RunRecord[] = runs.getRunsForJob('job-1');
const finished: RunRecord | null = runs.finishRun('id', 'ok', { summary: 'done', shell_exit_code: 0 });
runs.updateHeartbeat('id');
runs.updateRunSession('id', 'key', 'session');
const stale = runs.getStaleRuns(90);
if (stale.length) { void stale[0].job_name; void stale[0].job_timeout_ms; }
const timedOut = runs.getTimedOutRuns();
if (timedOut.length) { void timedOut[0].job_name; }
const running = runs.getRunningRuns();
if (running.length) { void running[0].job_name; void running[0].job_timeout_ms; }
const poolRuns = runs.getRunningRunsByPool('pool');
if (poolRuns.length) { void poolRuns[0].job_name; }
runs.pruneRuns(100);
runs.updateContextSummary('id', { key: 'value' });

// ---- messages ----
const msg: MessageRecord = messages.sendMessage({
  from_agent: 'main', to_agent: 'ops', body: 'hello',
  team_id: 'team-1', member_id: 'm-1', task_id: 't-1',
  kind: 'text', priority: 1, ack_required: 1,
});
void msg.team_id; void msg.member_id; void msg.task_id; void msg.reply_to;
void msg.subject; void msg.priority; void msg.channel;
void msg.delivered_at; void msg.read_at; void msg.ack_required; void msg.ack_at;
void msg.delivery_attempts; void msg.last_error; void msg.team_mapped_at;
void msg.expires_at; void msg.created_at; void msg.job_id; void msg.run_id; void msg.owner;
const gotMsg: MessageRecord | undefined = messages.getMessage('id');
const inbox: MessageRecord[] = messages.getInbox('main', { limit: 10, includeRead: true, teamId: 't' });
const outbox: MessageRecord[] = messages.getOutbox('main', 10);
const thread: MessageRecord[] = messages.getThread('id');
const teamMsgs: MessageRecord[] = messages.getTeamMessages('team-1', { limit: 10, memberId: 'm-1' });
messages.markDelivered('id');
messages.markRead('id');
const markAllResult: SqliteRunResult = messages.markAllRead('main');
void markAllResult.changes;
const unread: number = messages.getUnreadCount('main');
const acked: MessageRecord = messages.ackMessage('id', 'operator', 'acknowledged');
const expireResult: SqliteRunResult = messages.expireMessages();
void expireResult.changes;
const pruneResult: SqliteRunResult = messages.pruneMessages(30, 3, 3);
void pruneResult.changes;
const attempt: MessageRecord | null = messages.recordMessageAttempt('id', { ok: true, actor: 'system' });
const receipts: Array<Record<string, unknown>> = messages.listMessageReceipts('id', 50);

// ---- approvals ----
const approval: ApprovalRecord = approvals.createApproval('job-1', 'run-1', 'dq-1');
void approval.dispatch_queue_id; void approval.requested_at;
void approval.resolved_at; void approval.resolved_by; void approval.notes;
const gotApproval: ApprovalRecord | undefined = approvals.getApproval('id');
const pending: ApprovalRecord | undefined = approvals.getPendingApproval('job-1');
const allPending = approvals.listPendingApprovals();
if (allPending.length) { void allPending[0].job_name; }
const resolved: ApprovalRecord = approvals.resolveApproval('id', 'approved', 'operator', 'lgtm');
const pendingCount: number = approvals.countPendingApprovalsForJob('job-1');
const timedOutApprovals = approvals.getTimedOutApprovals();
if (timedOutApprovals.length) {
  void timedOutApprovals[0].job_name;
  void timedOutApprovals[0].approval_timeout_s;
  void timedOutApprovals[0].approval_auto;
}
const pruneApprovalsResult: SqliteRunResult = approvals.pruneApprovals(30);
void pruneApprovalsResult.changes;

// ---- agents ----
const agent: AgentRecord = agents.upsertAgent('main', { name: 'Main', status: 'idle', capabilities: ['*'] });
void agent.last_seen_at; void agent.created_at;
const gotAgent: AgentRecord | undefined = agents.getAgent('main');
const allAgents: AgentRecord[] = agents.listAgents();
agents.setAgentStatus('main', 'busy', 'session-key');
agents.touchAgent('main');

// ---- dispatchQueue ----
const dispatch: DispatchRecord = dispatchQueue.enqueueDispatch('job-1', { kind: 'manual' });
void dispatch.dispatch_kind; void dispatch.scheduled_for; void dispatch.source_run_id;
void dispatch.claimed_at; void dispatch.processed_at;
const gotDispatch: DispatchRecord | null = dispatchQueue.getDispatch('id');
const dueDispatches = dispatchQueue.getDueDispatches(10);
if (dueDispatches.length) { void dueDispatches[0].job_name; }
const claimed: DispatchRecord | null = dispatchQueue.claimDispatch('id');
const released: DispatchRecord | null = dispatchQueue.releaseDispatch('id', '2026-01-01 00:00:00');
const statusUpdated: DispatchRecord = dispatchQueue.setDispatchStatus('id', 'done');
const jobDispatches: DispatchRecord[] = dispatchQueue.listDispatchesForJob('job-1', 20);

// ---- gateway ----
void gateway.TELEGRAM_MAX_MESSAGE_LENGTH;
const parts: string[] = gateway.splitMessageForChannel('telegram', 'hello');
const alias = gateway.resolveDeliveryAlias('@owner_dm');
if (alias) { void alias.channel; void alias.target; }
const healthy: Promise<boolean> = gateway.checkGatewayHealth();
const waited: Promise<boolean> = gateway.waitForGateway(5000, 1000);

// Async gateway functions (type-check only, not called)
async function _gatewaySmoke() {
  const turnResult: AgentTurnResult = await gateway.runAgentTurn({ message: 'hi' });
  void turnResult.ok; void turnResult.content; void turnResult.usage; void turnResult.sessionKey;

  const activityResult: AgentTurnResult = await gateway.runAgentTurnWithActivityTimeout({
    message: 'hi', idleTimeoutMs: 60000, absoluteTimeoutMs: 300000,
  });
  void activityResult.content;

  const sysEvent: Record<string, unknown> = await gateway.sendSystemEvent('test');
  void sysEvent;

  const toolResult: Record<string, unknown> = await gateway.invokeGatewayTool('sessions_list', {});
  void toolResult;

  const sessions: Record<string, unknown> = await gateway.listSessions({ activeMinutes: 10 });
  void sessions;

  const subSessions: Array<Record<string, unknown>> = await gateway.getAllSubAgentSessions(10);
  void subSessions;

  const delivery: DeliveryResult = await gateway.deliverMessage('telegram', '123', 'hello');
  void delivery.ok; void delivery.parts; void delivery.lastResponse;
}
void _gatewaySmoke;

// ---- paths ----
const home: string = paths.resolveSchedulerHome();
const dbPath: string = paths.resolveSchedulerDbPath({ explicitPath: ':memory:' });
const parent: string = paths.ensureSchedulerDbParent('/tmp/test.db');
const backupDir: string = paths.resolveBackupStagingDir();
const artifactsDir: string = paths.resolveArtifactsDir({ dbPath: ':memory:' });
const ensuredDir: string = paths.ensureArtifactsDir('/tmp/artifacts');

// ---- promptContext ----
const triggerCtx = promptContext.buildTriggeredRunContext(run, {
  getRunById: (id) => runs.getRun(id),
  getJobById: (id) => jobs.getJob(id),
});
void triggerCtx.text; void triggerCtx.meta;

// ---- retrieval ----
const recent = retrieval.getRecentRunSummaries('job-1', 5);
if (recent.length) { void recent[0].started_at; void recent[0].context_summary; }
const searched = retrieval.searchRunSummaries('job-1', 'error', 5);
if (searched.length) { void searched[0]._score; }
const ctx: string = retrieval.buildRetrievalContext(created);

// ---- shellResults ----
void shellResults.DEFAULT_STORE_LIMIT;
void shellResults.DEFAULT_EXCERPT_LIMIT;
void shellResults.DEFAULT_SUMMARY_LIMIT;
void shellResults.DEFAULT_OFFLOAD_THRESHOLD;
const normalized: ShellResult = shellResults.normalizeShellResult(
  { stdout: 'ok', stderr: '', error: null },
  { runId: 'r-1', storeLimit: 1024 },
);
void normalized.stdoutTruncated; void normalized.stderrTruncated;
void normalized.contextSummary;
const extracted: PartialShellResult | null = shellResults.extractShellResultFromRun(run);
if (extracted) {
  void extracted.exitCode; void extracted.signal; void extracted.timedOut;
  void extracted.stdout; void extracted.stderr; void extracted.errorMessage;
  void extracted.stdoutPath; void extracted.stdoutBytes;
}

// ---- SCHEDULER_SCHEMAS ----
void SCHEDULER_SCHEMAS.jobs.type;
void SCHEDULER_SCHEMAS.jobs.required;
void SCHEDULER_SCHEMAS.jobs.fields;
void SCHEDULER_SCHEMAS.runs.statuses;
void SCHEDULER_SCHEMAS.runs.key_fields;
void SCHEDULER_SCHEMAS.approvals.statuses;
void SCHEDULER_SCHEMAS.dispatches.kinds;
void SCHEDULER_SCHEMAS.dispatches.statuses;
void SCHEDULER_SCHEMAS.messages.kinds;
void SCHEDULER_SCHEMAS.messages.statuses;

// ---- idempotency ----
const idemKey: string = idempotency.generateIdempotencyKey('job-1', '2026-01-01');
const chainKey: string = idempotency.generateChainIdempotencyKey('run-1', 'child-1');
const runNowKey: string = idempotency.generateRunNowIdempotencyKey('job-1');
const idemCheck: Record<string, unknown> | null = idempotency.checkIdempotencyKey(idemKey);
const idemEntry: Record<string, unknown> | null = idempotency.getIdempotencyEntry(idemKey);
const idemClaimed: boolean = idempotency.claimIdempotencyKey(idemKey, 'job-1', 'run-1', '2026-12-31');
idempotency.releaseIdempotencyKey(idemKey);
idempotency.updateIdempotencyResultHash(idemKey, 'content');
const idemList: Array<Record<string, unknown>> = idempotency.listIdempotencyForJob('job-1', 10);
const idemForce: number = idempotency.forcePruneIdempotency();

// ---- taskTracker ----
const tgOpts: TaskGroupOpts = { name: 'smoke', expectedAgents: ['a', 'b'] };
const tgResult: TaskGroupResult = taskTracker.createTaskGroup(tgOpts);
void tgResult.id; void tgResult.agents;
const tgGet: Record<string, unknown> | undefined = taskTracker.getTaskGroup('id');
const tgActive: Array<Record<string, unknown>> = taskTracker.listActiveTaskGroups();
taskTracker.agentStarted('t-1', 'agent-a', 'key');
taskTracker.registerAgentSession('t-1', 'agent-a', 'key');
taskTracker.touchAgentHeartbeat('t-1', 'agent-a');
taskTracker.agentCompleted('t-1', 'agent-a', 'done');
taskTracker.agentFailed('t-1', 'agent-a', 'error');
const deadAgents = taskTracker.checkDeadAgents();
if (deadAgents.length) { void deadAgents[0].tracker_id; void deadAgents[0].agent_label; }
const tgCompletion: Record<string, unknown> | null = taskTracker.checkGroupCompletion('t-1');
const tgStatus: TaskGroupStatus | null = taskTracker.getTaskGroupStatus('t-1');
if (tgStatus) { void tgStatus.elapsed; void tgStatus.agents; void tgStatus.remaining_timeout; }

// ---- teamAdapter ----
const mapped: number = teamAdapter.mapTeamMessages(10);
const teamTasks: Array<Record<string, unknown>> = teamAdapter.listTeamTasks('team-1', 10);
const teamEvents: Array<Record<string, unknown>> = teamAdapter.listTeamMailboxEvents('team-1', { limit: 10, taskId: 'task-1' });
const gateOpts: TeamTaskGateOpts = { teamId: 'team-1', taskId: 'task-1', expectedMembers: ['a', 'b'] };
const gate = teamAdapter.createTeamTaskGate(gateOpts);
void gate.team_id; void gate.task_id; void gate.gate_status; void gate.tracker_id;
const gatesResult = teamAdapter.checkTeamTaskGates(10);
void gatesResult.passed; void gatesResult.failed; void gatesResult.pending;
const ackResult: Record<string, unknown> | null = teamAdapter.ackTeamMessage('msg-1', 'operator', 'ok');

// Suppress unused variable warnings
void created; void fetched; void listed; void updated;
void nextRun; void due; void children; void allChildren; void condMatch; void depth;
void dequeued; void backlog; void canEnqueue; void shouldRetry;
void hasRunning; void poolRunning; void cancelled; void pruned;
void gotRun; void jobRuns; void finished;
void gotMsg; void inbox; void outbox; void thread; void teamMsgs; void unread; void acked;
void attempt; void receipts;
void gotApproval; void pending; void resolved; void pendingCount;
void gotAgent; void allAgents;
void gotDispatch; void claimed; void released; void statusUpdated; void jobDispatches;
void healthy; void waited;
void home; void dbPath; void parent; void backupDir; void artifactsDir; void ensuredDir;
void ctx; void normalized; void parts;
void idemKey; void chainKey; void runNowKey; void idemCheck; void idemEntry;
void idemClaimed; void idemList; void idemForce;
void tgOpts; void tgGet; void tgActive; void tgCompletion;
void mapped; void teamTasks; void teamEvents; void gateOpts; void ackResult;
