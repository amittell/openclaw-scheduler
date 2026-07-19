-- OpenClaw Scheduler Schema (current: v0.5.0, schema version: 29)
-- Full standalone scheduler + message router

-- ============================================================
-- JOBS: scheduled tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  
  -- Schedule: cron or one-shot 'at'
  schedule_kind   TEXT NOT NULL DEFAULT 'cron',          -- 'cron' | 'at'
  schedule_at     TEXT DEFAULT NULL,                     -- SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS'), only for kind='at'
  schedule_cron   TEXT,                                  -- NULL allowed for at-jobs (use sentinel '0 0 31 2 *' on old DBs)
  schedule_tz     TEXT NOT NULL DEFAULT 'UTC',
  
  -- Execution
  session_target  TEXT NOT NULL DEFAULT 'isolated',  -- 'main' | 'isolated' | 'shell'
  agent_id        TEXT DEFAULT 'main',
  
  -- Payload
  payload_kind    TEXT NOT NULL,                      -- 'systemEvent' | 'agentTurn' | 'shellCommand'
  payload_message TEXT NOT NULL,
  payload_model   TEXT,
  payload_model_fallback TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER DEFAULT 120,
  execution_intent TEXT NOT NULL DEFAULT 'execute',   -- 'execute' | 'plan' | 'fire-and-forget'
  execution_read_only INTEGER NOT NULL DEFAULT 0,
  shell_env_policy TEXT NOT NULL DEFAULT 'minimal',   -- 'minimal' | 'inherit'; existing installs migrate to 'inherit'

  -- Overlap & timeout
  overlap_policy  TEXT NOT NULL DEFAULT 'skip',       -- 'skip' | 'allow' | 'queue'
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,
  max_queued_dispatches INTEGER NOT NULL DEFAULT 25,
  max_pending_approvals INTEGER NOT NULL DEFAULT 10,
  max_trigger_fanout INTEGER NOT NULL DEFAULT 25,

  -- Delivery
  delivery_mode   TEXT DEFAULT 'announce',            -- 'announce' | 'announce-always' | 'none'
  delivery_channel TEXT,
  delivery_to     TEXT,
  
  -- Metadata
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delete_after_run INTEGER NOT NULL DEFAULT 0,
  ttl_hours       INTEGER DEFAULT NULL,  -- auto-delete N hours after last_run_at if terminal status

  -- Workflow chaining (v3)
  parent_id       TEXT,                          -- soft ref to parent job id
  trigger_on      TEXT,                         -- 'success' | 'failure' | 'complete' | NULL
  trigger_delay_s INTEGER DEFAULT 0,

  -- Output-based trigger condition (v4)
  trigger_condition TEXT DEFAULT NULL,           -- 'contains:ALERT' | 'regex:pattern' | NULL

  -- Retry logic (v3b)
  max_retries     INTEGER DEFAULT 0,             -- 0 = no retry

  -- Queue overlap (v3c)
  queued_count    INTEGER DEFAULT 0,             -- pending dispatches waiting for current run
  
  -- Sub-agent scope (v3c)
  payload_scope   TEXT NOT NULL DEFAULT 'own',   -- 'own' | 'global'

  -- Resource pool (concurrency across different jobs)
  resource_pool   TEXT DEFAULT NULL,

  -- Delivery semantics (v5)
  delivery_guarantee TEXT DEFAULT 'at-most-once',  -- 'at-most-once'|'at-least-once'
  job_class       TEXT DEFAULT 'standard',          -- 'standard'|'pre_compaction_flush'

  -- HITL approval gates (v5)
  approval_required  INTEGER DEFAULT 0,
  approval_timeout_s INTEGER DEFAULT 3600,
  approval_auto      TEXT DEFAULT 'reject',         -- 'approve'|'reject'
  approval_risk_level TEXT DEFAULT NULL,             -- NULL|'low'|'medium'|'high'
  approval_approver_scope TEXT DEFAULT NULL,          -- local exact, principal:<id>, user:<name>, or uid:<number>

  -- Context retrieval (v5)
  context_retrieval       TEXT DEFAULT 'none',      -- 'none'|'recent'|'hybrid'
  context_retrieval_limit INTEGER DEFAULT 5,

  -- Output handling (v14)
  output_store_limit_bytes INTEGER NOT NULL DEFAULT 65536,
  output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 65536,
  output_summary_limit_bytes INTEGER NOT NULL DEFAULT 65536,
  output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536,
  output_format TEXT DEFAULT NULL,                    -- NULL|'json'|'ndjson'|'text'

  -- Post-success verification contract (agentcli handoff v2)
  verify_shell TEXT DEFAULT NULL,
  verify_timeout_s INTEGER DEFAULT NULL,
  verify_on_failure TEXT DEFAULT NULL,                 -- NULL|'warn'|'error'

  -- Session continuity (v9)
  preferred_session_key TEXT DEFAULT NULL,           -- pass to gateway for session reuse

  -- Auth profile override (v16)
  auth_profile    TEXT DEFAULT NULL,                  -- null=default, 'inherit'=main session profile, or 'provider:label'

  -- Fallback selection overrides (v24)
  auth_profile_fallback TEXT DEFAULT NULL,            -- optional fallback auth profile used after primary selection failure

  -- Delivery opt-out (v19)
  delivery_opt_out_reason TEXT DEFAULT NULL,          -- set when delivery_mode='none' to explicitly skip delivery

  -- Origin tracking (v20)
  origin          TEXT DEFAULT NULL,                  -- where job was dispatched from: "telegram:<chat_id>", "system", etc.

  -- v0.2 Identity (v22)
  identity_principal         TEXT DEFAULT NULL,
  identity_run_as            TEXT DEFAULT NULL,
  identity_attestation       TEXT DEFAULT NULL,
  identity_ref               TEXT DEFAULT NULL,
  identity_subject_kind      TEXT DEFAULT NULL,
  identity_subject_principal TEXT DEFAULT NULL,
  identity_trust_level       TEXT DEFAULT NULL,
  identity_delegation_mode   TEXT DEFAULT NULL,
  identity                   TEXT DEFAULT NULL,

  -- v0.2 Authorization Proof (v22)
  authorization_proof_ref    TEXT DEFAULT NULL,
  authorization_proof        TEXT DEFAULT NULL,

  -- v0.2 Authorization (v22)
  authorization_ref          TEXT DEFAULT NULL,
  authorization              TEXT DEFAULT NULL,

  -- v0.2 Evidence (v22)
  evidence_ref               TEXT DEFAULT NULL,
  evidence                   TEXT DEFAULT NULL,

  -- v0.2 Contract (v22)
  contract_required_trust_level TEXT DEFAULT NULL,
  contract_trust_enforcement    TEXT DEFAULT NULL,
  contract_sandbox              TEXT DEFAULT NULL,
  contract_allowed_paths        TEXT DEFAULT NULL,
  contract_network              TEXT DEFAULT NULL,
  contract_max_cost_usd         REAL DEFAULT NULL,
  contract_audit                TEXT DEFAULT NULL,

  -- v0.2 Child Credential Policy (v23)
  child_credential_policy   TEXT DEFAULT NULL,

  -- Agentcli handoff v4 immutable compiled artifact (v29)
  handoff_version           INTEGER DEFAULT NULL,
  handoff_artifact_digest   TEXT DEFAULT NULL,
  effective_task_hash       TEXT DEFAULT NULL,

  -- Watchdog monitoring (v13)
  job_type              TEXT NOT NULL DEFAULT 'standard',  -- 'standard' | 'watchdog'
  watchdog_target_label TEXT,                         -- label of the task being monitored
  watchdog_check_cmd    TEXT,                         -- shell command to check target status
  watchdog_timeout_min  INTEGER,                      -- alert if target running longer than this
  watchdog_alert_channel TEXT,                        -- e.g. 'telegram'
  watchdog_alert_target TEXT,                         -- e.g. '<telegram-user-id>'
  watchdog_self_destruct INTEGER NOT NULL DEFAULT 1,  -- delete when target done
  watchdog_started_at   TEXT,                         -- ISO timestamp when target was dispatched

  -- Scheduling state (denormalized)
  next_run_at     TEXT,
  last_run_at     TEXT,
  last_status     TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,

  -- Delivery target constraint: announce modes require a delivery_to
  CHECK (
    delivery_mode NOT IN ('announce', 'announce-always')
    OR (delivery_to IS NOT NULL AND delivery_to != '')
  )
);

CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- RUNS: job execution history with heartbeat tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|running|ok|error|timeout|skipped|awaiting_approval|approved|cancelled|crashed|recovery_blocked
  
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  duration_ms     INTEGER,
  
  -- Implicit heartbeat (updated by dispatcher checking session activity)
  last_heartbeat  TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Session tracking
  session_key     TEXT,
  session_id      TEXT,
  
  -- Result
  summary         TEXT,
  error_message   TEXT,
  shell_exit_code INTEGER,
  shell_signal    TEXT,
  shell_timed_out INTEGER NOT NULL DEFAULT 0,
  shell_stdout    TEXT,
  shell_stderr    TEXT,
  shell_stdout_path TEXT,
  shell_stderr_path TEXT,
  shell_stdout_bytes INTEGER NOT NULL DEFAULT 0,
  shell_stderr_bytes INTEGER NOT NULL DEFAULT 0,
  shell_stdout_sha256 TEXT,
  shell_stderr_sha256 TEXT,
  dispatched_at   TEXT,
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,

  -- Dispatcher ownership and cancellation fencing (v27)
  dispatcher_owner TEXT,
  dispatcher_token INTEGER,
  dispatch_started_at TEXT,
  cancel_requested_at TEXT,
  cancel_requested_by TEXT,
  cancel_reason TEXT,
  process_pid INTEGER,
  process_pgid INTEGER,
  process_identity TEXT,
  process_started_at TEXT,
  process_terminated_at TEXT,
  agent_cancel_requested_at TEXT,
  terminal_transition_at TEXT,

  -- Retry tracking (v3b)
  retry_count     INTEGER DEFAULT 0,
  retry_of        TEXT,                             -- original run id if this is a retry
  triggered_by_run TEXT,                            -- parent run id if this run was chain-triggered
  dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,

  -- Context & replay (v5)
  context_summary TEXT,                             -- JSON: {messages_injected,scope,...}
  replay_of       TEXT,                             -- run id if this is a crash replay

  -- Idempotency (v7)
  idempotency_key TEXT,                             -- deterministic key for dedup

  -- v0.2 Outcomes (v22)
  identity_resolved                TEXT DEFAULT NULL,
  trust_evaluation                 TEXT DEFAULT NULL,
  authorization_decision           TEXT DEFAULT NULL,
  authorization_proof_verification TEXT DEFAULT NULL,
  evidence_required                INTEGER NOT NULL DEFAULT 0 CHECK (evidence_required IN (0,1)),
  evidence_execution_snapshot      TEXT DEFAULT NULL,
  evidence_declaration_snapshot    TEXT DEFAULT NULL,
  evidence_ref_snapshot            TEXT DEFAULT NULL,
  evidence_record                  TEXT DEFAULT NULL,
  credential_handoff_summary       TEXT DEFAULT NULL,
  delegation_validation            TEXT DEFAULT NULL,
  approval_used                     TEXT DEFAULT NULL,

  -- Agentcli handoff v4 execution binding (v29)
  handoff_artifact_digest            TEXT DEFAULT NULL,
  runtime_instance_id                TEXT DEFAULT NULL,
  source_run_id                      TEXT DEFAULT NULL,
  source_run_handoff_artifact_digest TEXT DEFAULT NULL,

  -- Structured output contract result (v28)
  output_format                     TEXT DEFAULT NULL,
  structured_output                TEXT DEFAULT NULL,
  structured_output_valid          INTEGER DEFAULT NULL,
  structured_output_warning        TEXT DEFAULT NULL,
  structured_output_bytes          INTEGER DEFAULT NULL,
  structured_output_sha256         TEXT DEFAULT NULL,
  structured_output_path           TEXT DEFAULT NULL,

  -- Post-success verification outcome (agentcli handoff v2)
  verification_result              TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_dispatch_queue ON runs(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_dispatcher_owner ON runs(dispatcher_owner, status) WHERE dispatcher_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_cancel_requested ON runs(cancel_requested_at, status) WHERE cancel_requested_at IS NOT NULL;

-- ============================================================
-- MESSAGES: inter-agent message queue
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  
  -- Routing
  from_agent      TEXT NOT NULL,                      -- sender agent id or 'scheduler' or 'user'
  to_agent        TEXT NOT NULL,                      -- recipient agent id or 'broadcast'
  team_id         TEXT,                               -- optional team routing namespace
  member_id       TEXT,                               -- optional team member routing key
  task_id         TEXT,                               -- optional team task correlation key
  reply_to        TEXT REFERENCES messages(id) ON DELETE SET NULL, -- threading
  
  -- Content
  kind            TEXT NOT NULL DEFAULT 'text',       -- 'text' | 'task' | 'result' | 'status' | 'system'
  subject         TEXT,                               -- optional subject line
  body            TEXT NOT NULL,
  metadata        TEXT,                               -- JSON blob for structured data
  
  -- Priority & delivery
  priority        INTEGER NOT NULL DEFAULT 0,         -- higher = more urgent (0=normal, 1=high, 2=urgent)
  channel         TEXT,                               -- optional: route via specific channel
  delivery_to     TEXT,                               -- optional: target chat/user id for outbound delivery
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|prompt_claimed|delivered|read|expired|failed
  delivered_at    TEXT,
  read_at         TEXT,
  ack_required    INTEGER NOT NULL DEFAULT 0,         -- message requires explicit ACK
  ack_at          TEXT,                               -- explicit acknowledgement timestamp
  delivery_attempts INTEGER NOT NULL DEFAULT 0,       -- outbound delivery attempts
  last_error      TEXT,                               -- last delivery/adapter error
  team_mapped_at  TEXT,                               -- when team adapter projected this message
  expires_at      TEXT,                               -- optional TTL
  
  -- Metadata
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Link to job/run if this message is job-related
  job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,

  -- Typed message owner (v5)
  owner           TEXT,                               -- originator of typed message

  -- Deterministic dedup key for exactly-once enqueue (v26). NULL for messages
  -- that do not opt into idempotency (the common case).
  idempotency_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(to_agent, status, priority DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_messages_team ON messages(team_id, member_id, status) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(team_id, task_id, created_at) WHERE team_id IS NOT NULL AND task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_ack_pending ON messages(ack_required, ack_at, status) WHERE ack_required = 1 AND ack_at IS NULL;

-- ============================================================
-- AGENTS: registered agents and status
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,                   -- agent id (e.g. 'main', 'ops')
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',       -- idle|busy|offline
  last_seen_at    TEXT,
  session_key     TEXT,                               -- current active session key
  capabilities    TEXT,                               -- JSON array of capability tags
  delivery_channel TEXT,                              -- e.g. 'telegram'
  delivery_to      TEXT,                              -- e.g. '<telegram-user-id>'
  brand_name       TEXT,                              -- display name for notifications
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- DELIVERY ALIASES: named targets for job delivery
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_aliases (
  alias       TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  target      TEXT NOT NULL,
  description TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Example delivery aliases -- replace targets with real Telegram chat/user IDs.
-- These placeholder IDs are non-functional; run `openclaw-scheduler aliases update`
-- or INSERT your own rows to configure delivery routing.
-- Example delivery aliases (not seeded — add via CLI or SQL):
--   INSERT INTO delivery_aliases (alias, channel, target, description) VALUES
--     ('team_room', 'telegram', '<your-chat-id>', 'Team room'),
--     ('owner_dm',  'telegram', '<your-user-id>', 'Owner DM');

-- ============================================================
-- APPROVALS: HITL approval gates (v5)
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|dispatching|dispatched|rejected|timed_out|cancelled
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     TEXT,                               -- 'operator'|'timeout'|'api'
  notes           TEXT,
  decision_version INTEGER NOT NULL DEFAULT 0,
  cancelled_reason TEXT,
  expires_at      TEXT,
  approved_at     TEXT,
  rejected_at     TEXT,
  dispatched_at   TEXT,
  risk_level      TEXT,
  approver_scope  TEXT,
  binding_hash    TEXT,
  gate_kind       TEXT NOT NULL DEFAULT 'job',         -- job|authorization
  decision_context TEXT,                               -- audit-safe JSON context for escalation
  handoff_artifact_digest TEXT,
  source_run_id TEXT,
  source_run_handoff_artifact_digest TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals(job_id);
CREATE INDEX IF NOT EXISTS idx_approvals_dispatch_queue ON approvals(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL;

-- ============================================================
-- DISPATCH QUEUE: durable non-cron invocations (v11)
-- ============================================================
CREATE TABLE IF NOT EXISTS job_dispatch_queue (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  dispatch_kind   TEXT NOT NULL,                   -- schedule|at|manual|chain|retry
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|awaiting_approval|done|cancelled|failed
  scheduled_for   TEXT NOT NULL,
  binding_scheduled_for TEXT NOT NULL,              -- immutable occurrence timestamp used by approval bindings
  source_run_id   TEXT,                              -- immutable lineage survives source-run retention cleanup
  retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at      TEXT,
  processed_at    TEXT,
  claim_owner     TEXT,
  claim_token     TEXT,
  claim_expires_at TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  replay_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  handoff_artifact_digest TEXT,
  source_run_handoff_artifact_digest TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_due ON job_dispatch_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_job ON job_dispatch_queue(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_source_run ON job_dispatch_queue(source_run_id) WHERE source_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_claim_expiry ON job_dispatch_queue(status, claim_expires_at) WHERE status = 'claimed';

-- ============================================================
-- DISPATCHER LEASES: singleton leadership with fencing (v27)
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatcher_leases (
  name            TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  fencing_token   INTEGER NOT NULL,
  acquired_at     TEXT NOT NULL,
  renewed_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatcher_leases_expiry ON dispatcher_leases(expires_at);

-- ============================================================
-- DELIVERY OUTBOX: durable external delivery, separate from
-- the agent inbox (v27)
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_outbox (
  id              TEXT PRIMARY KEY,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL,
  target          TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|delivered|failed|cancelled
  idempotency_key TEXT,
  delivery_group_id TEXT,
  part_index      INTEGER,
  part_count      INTEGER,
  completion_label TEXT,
  completion_scope TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  claim_owner     TEXT,
  claim_token     TEXT,
  claim_expires_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_idempotency ON delivery_outbox(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_due ON delivery_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_claim_expiry ON delivery_outbox(status, claim_expires_at) WHERE status = 'claimed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_group_part ON delivery_outbox(delivery_group_id, part_index) WHERE delivery_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_group_status ON delivery_outbox(delivery_group_id, status, part_index) WHERE delivery_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_completion ON delivery_outbox(completion_label, completion_scope, status) WHERE completion_label IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_attachments (
  id              TEXT PRIMARY KEY,
  outbox_id       TEXT NOT NULL REFERENCES delivery_outbox(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  ordinal         INTEGER NOT NULL,
  name            TEXT NOT NULL,
  mime_type       TEXT,
  source_path     TEXT,
  content_blob    BLOB,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(outbox_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_delivery_attachments_message ON delivery_attachments(message_id) WHERE message_id IS NOT NULL;

-- ============================================================
-- EVIDENCE RECORDS: immutable, content-addressed execution evidence (v28)
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence_records (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL UNIQUE,
  job_id          TEXT NOT NULL,
  evidence_ref    TEXT,
  algorithm       TEXT NOT NULL DEFAULT 'sha256',
  hash            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  retention_policy TEXT,
  retention_until TEXT,
  handoff_artifact_digest TEXT,
  source_run_id TEXT,
  source_run_handoff_artifact_digest TEXT,
  evidence_method TEXT,
  evidence_verified INTEGER DEFAULT NULL CHECK (evidence_verified IN (0,1)),
  evidence_envelope TEXT,
  evidence_provider TEXT,
  evidence_principal TEXT,
  evidence_allowed_signers_path TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(algorithm, hash, run_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_records_job ON evidence_records(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_records_hash ON evidence_records(algorithm, hash);
CREATE INDEX IF NOT EXISTS idx_evidence_records_created_run ON evidence_records(created_at DESC, run_id DESC);

-- ============================================================
-- HANDOFF V4 ARTIFACTS AND RUNTIME SECURITY STATE (v29)
-- ============================================================
CREATE TABLE IF NOT EXISTS handoff_artifacts (
  digest TEXT PRIMARY KEY,
  artifact_schema_version INTEGER NOT NULL CHECK (artifact_schema_version = 1),
  handoff_version INTEGER NOT NULL CHECK (handoff_version = 4),
  scheduler_schema_min INTEGER NOT NULL,
  canonicalization TEXT NOT NULL CHECK (canonicalization = 'json-sort-v1'),
  canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version = 1),
  execution_binding_version INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  effective_task_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_handoff_artifacts_job ON handoff_artifacts(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_artifacts_manifest ON handoff_artifacts(manifest_digest, workflow_id, task_id);
CREATE TRIGGER IF NOT EXISTS trg_handoff_artifacts_no_update
BEFORE UPDATE ON handoff_artifacts
BEGIN
  SELECT RAISE(ABORT, 'handoff artifacts are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_handoff_artifacts_no_delete
BEFORE DELETE ON handoff_artifacts
BEGIN
  SELECT RAISE(ABORT, 'handoff artifacts are immutable');
END;

CREATE TABLE IF NOT EXISTS runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  job_id TEXT,
  dispatch_queue_id TEXT,
  run_id TEXT,
  approval_id TEXT,
  handoff_artifact_digest TEXT,
  source_run_id TEXT,
  source_run_handoff_artifact_digest TEXT,
  payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runtime_events_run ON runtime_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_artifact ON runtime_events(handoff_artifact_digest, id);
CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(event_type, id);
CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_update
BEFORE UPDATE ON runtime_events
BEGIN
  SELECT RAISE(ABORT, 'runtime events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_delete
BEFORE DELETE ON runtime_events
BEGIN
  SELECT RAISE(ABORT, 'runtime events are immutable');
END;

CREATE TABLE IF NOT EXISTS proof_replay_ledger (
  replay_key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  issuer TEXT,
  subject TEXT,
  proof_id TEXT NOT NULL,
  handoff_artifact_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proof_replay_expires ON proof_replay_ledger(expires_at);

CREATE TABLE IF NOT EXISTS proof_revocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  issuer TEXT,
  proof_id TEXT,
  key_id TEXT,
  reason TEXT,
  revoked_by TEXT,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (proof_id IS NOT NULL OR key_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_proof_revocations_lookup
  ON proof_revocations(method, issuer, proof_id, key_id);

CREATE TABLE IF NOT EXISTS provider_sessions (
  id TEXT PRIMARY KEY,
  provider_type TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  cache_key_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','refreshing','expired','revoked','failed')),
  handoff_artifact_digest TEXT,
  subject_principal TEXT,
  scope TEXT,
  session_summary TEXT,
  expires_at TEXT,
  refresh_after TEXT,
  rotation_counter INTEGER NOT NULL DEFAULT 0,
  revocation_checked_at TEXT,
  transient_error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider_type, provider_name, cache_key_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_status ON provider_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS credential_presentations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  handoff_artifact_digest TEXT NOT NULL,
  provider_session_id TEXT,
  binding_name TEXT NOT NULL,
  medium TEXT NOT NULL CHECK (medium IN ('env','temp-file','stdin','gateway-env-header')),
  env_key TEXT,
  temp_path TEXT,
  stdin_sha256 TEXT,
  value_sha256 TEXT NOT NULL,
  file_mode TEXT,
  status TEXT NOT NULL CHECK (status IN ('materialized','cleaned','recovery_cleaned','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  cleaned_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_credential_presentations_run ON credential_presentations(run_id, status);
CREATE INDEX IF NOT EXISTS idx_credential_presentations_status ON credential_presentations(status, created_at);

  CREATE TRIGGER IF NOT EXISTS trg_v4_jobs_no_downgrade
  BEFORE UPDATE ON jobs
  WHEN OLD.handoff_version = 4 AND (
    NEW.handoff_version IS NOT 4 OR
    NEW.handoff_artifact_digest IS NULL OR
    NEW.effective_task_hash IS NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'handoff v4 job bindings cannot be downgraded or cleared');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_v4_runs_binding_immutable
BEFORE UPDATE ON runs
WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
  NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
  NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR
  NEW.source_run_id IS NOT OLD.source_run_id OR
  NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
)
BEGIN
  SELECT RAISE(ABORT, 'handoff v4 run bindings are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_v4_approvals_binding_immutable
BEFORE UPDATE ON approvals
WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
  NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
  NEW.source_run_id IS NOT OLD.source_run_id OR
  NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
)
BEGIN
  SELECT RAISE(ABORT, 'handoff v4 approval bindings are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_v4_dispatches_binding_immutable
BEFORE UPDATE ON job_dispatch_queue
WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
  NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
  NEW.source_run_id IS NOT OLD.source_run_id OR
  NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
)
BEGIN
  SELECT RAISE(ABORT, 'handoff v4 dispatch bindings are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_v4_evidence_no_update
BEFORE UPDATE ON evidence_records
WHEN OLD.handoff_artifact_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'handoff v4 evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_v4_evidence_no_delete
BEFORE DELETE ON evidence_records
WHEN OLD.handoff_artifact_digest IS NOT NULL AND NOT (
  OLD.retention_until IS NOT NULL
  AND julianday(OLD.retention_until) <= julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'handoff v4 evidence is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_proof_revocations_no_update
BEFORE UPDATE ON proof_revocations
BEGIN
  SELECT RAISE(ABORT, 'proof revocations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_proof_revocations_no_delete
BEFORE DELETE ON proof_revocations
BEGIN
  SELECT RAISE(ABORT, 'proof revocations are immutable');
END;

-- ============================================================
-- IDEMPOTENCY LEDGER: tracks claimed idempotency keys (v7)
-- ============================================================
CREATE TABLE IF NOT EXISTS idempotency_ledger (
  key             TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'claimed',  -- claimed | released
  claimed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  released_at     TEXT,
  result_hash     TEXT,          -- optional: hash of the result for verification
  expires_at      TEXT NOT NULL   -- auto-expire old entries to prevent unbounded growth
);
CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_ledger(expires_at);
CREATE INDEX IF NOT EXISTS idx_idem_job ON idempotency_ledger(job_id);

-- ============================================================
-- TASK TRACKER: dead-man's-switch monitoring for sub-agent teams (v6)
-- ============================================================
CREATE TABLE IF NOT EXISTS task_tracker (
  id              TEXT PRIMARY KEY,           -- unique task group id
  name            TEXT NOT NULL,              -- human label e.g. "v5-agent-team"
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL DEFAULT 'main', -- who spawned the task group
  expected_agents TEXT NOT NULL,              -- JSON array: ["schema-and-data","runtime-integration","rfc-docs"]
  timeout_s       INTEGER NOT NULL DEFAULT 600,
  status          TEXT NOT NULL DEFAULT 'active', -- active|completed|failed|timed_out
  completed_at    TEXT,
  delivery_channel TEXT,                      -- where to send updates
  delivery_to     TEXT,                       -- target for updates
  summary         TEXT                        -- final summary on completion
);
CREATE INDEX IF NOT EXISTS idx_task_tracker_status ON task_tracker(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS task_tracker_agents (
  id              TEXT PRIMARY KEY,
  tracker_id      TEXT NOT NULL REFERENCES task_tracker(id) ON DELETE CASCADE,
  agent_label     TEXT NOT NULL,              -- matches label in expected_agents
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|dead
  started_at      TEXT,
  finished_at     TEXT,
  exit_message    TEXT,                       -- agent's final status message
  error           TEXT,
  session_key     TEXT,                       -- OpenClaw session key for auto-correlation (v8)
  last_heartbeat  TEXT                        -- last activity detected (CLI or auto-correlation)
);
CREATE INDEX IF NOT EXISTS idx_tta_tracker ON task_tracker_agents(tracker_id);
CREATE INDEX IF NOT EXISTS idx_tta_status ON task_tracker_agents(status) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_tta_session_key ON task_tracker_agents(session_key) WHERE session_key IS NOT NULL;

-- ============================================================
-- MESSAGE RECEIPTS: explicit delivery/ack audit trail (v10)
-- ============================================================
CREATE TABLE IF NOT EXISTS message_receipts (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,                      -- attempt|error|ack|read|adapter
  attempt         INTEGER,
  actor           TEXT,                               -- dispatcher|consumer|agent|team-adapter|operator
  detail          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_message ON message_receipts(message_id, created_at DESC);

-- ============================================================
-- TEAM ADAPTER TABLES: mailbox/task projection + gates (v10)
-- ============================================================
CREATE TABLE IF NOT EXISTS team_tasks (
  team_id         TEXT NOT NULL,
  id              TEXT NOT NULL,                      -- task id within a team namespace
  member_id       TEXT,                               -- owner/assignee
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'open',       -- open|blocked|completed|failed
  gate_tracker_id TEXT REFERENCES task_tracker(id) ON DELETE SET NULL,
  gate_status     TEXT,                               -- waiting|passed|failed|NULL
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  PRIMARY KEY (team_id, id)
);
CREATE INDEX IF NOT EXISTS idx_team_tasks_status ON team_tasks(team_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_tasks_gate ON team_tasks(gate_tracker_id) WHERE gate_tracker_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_mailbox_events (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  member_id       TEXT,
  task_id         TEXT,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,                      -- mailbox|task_created|task_message|gate_open|gate_passed|gate_failed|ack
  payload         TEXT,                               -- JSON details
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_events_team ON team_mailbox_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_events_task ON team_mailbox_events(team_id, task_id, created_at DESC) WHERE task_id IS NOT NULL;

-- ============================================================
-- COMPLETION DEBTS: durable record of dispatch completions that
-- still owe the user a visible announce, plus an atomic delivery
-- claim so the done-path and the watcher never both deliver. The v28
-- delivery_scope makes claims run-scoped, so concurrent or re-dispatched
-- uses of the same label do not suppress one another.
-- ============================================================
CREATE TABLE IF NOT EXISTS completion_debts (
  id                      TEXT PRIMARY KEY,
  task_label              TEXT NOT NULL,
  delivery_scope          TEXT NOT NULL,
  session_key             TEXT,
  source                  TEXT NOT NULL DEFAULT 'dispatch',
  status                  TEXT NOT NULL DEFAULT 'tracking',   -- tracking|open|delivering|closed
  open_reason             TEXT,
  close_reason            TEXT,
  opened_at               TEXT,
  closed_at               TEXT,
  last_checkin_at         TEXT,
  last_progress_at        TEXT,
  last_visible_update_at  TEXT,
  final_reported_at       TEXT,
  last_reminder_at        TEXT,
  reminder_count          INTEGER NOT NULL DEFAULT 0,
  awaiting_user           INTEGER NOT NULL DEFAULT 0,
  no_reply                INTEGER NOT NULL DEFAULT 0,
  metadata                TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_completion_debts_status ON completion_debts(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_completion_debts_session ON completion_debts(session_key) WHERE session_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_completion_debts_task ON completion_debts(task_label, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_debts_scope ON completion_debts(task_label, delivery_scope);

-- ============================================================
-- MIGRATION LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fresh installs seed all versions 1-29 (all columns already in schema above).
-- Existing installs are brought up to v29 by migrate-consolidate.js.
INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (5);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (6);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (7);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (8);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (9);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (10);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (11);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (12);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (13);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (14);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (15);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (16);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (17);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (18);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (19);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (20);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (21);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (22);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (23);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (24);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (25);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (26);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (27);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (28);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (29);
