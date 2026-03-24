-- OpenClaw Scheduler Schema (current: v1.7.0, schema version: 20)
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
  schedule_at     TEXT DEFAULT NULL,                     -- ISO-8601 UTC timestamp, only for kind='at'
  schedule_cron   TEXT,                                  -- NULL allowed for at-jobs (use sentinel '0 0 31 2 *' on old DBs)
  schedule_tz     TEXT NOT NULL DEFAULT 'UTC',
  
  -- Execution
  session_target  TEXT NOT NULL DEFAULT 'isolated',  -- 'main' | 'isolated' | 'shell'
  agent_id        TEXT DEFAULT 'main',
  
  -- Payload
  payload_kind    TEXT NOT NULL,                      -- 'systemEvent' | 'agentTurn' | 'shellCommand'
  payload_message TEXT NOT NULL,
  payload_model   TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER DEFAULT 120,
  execution_intent TEXT NOT NULL DEFAULT 'execute',   -- 'execute' | 'plan'
  execution_read_only INTEGER NOT NULL DEFAULT 0,

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

  -- Context retrieval (v5)
  context_retrieval       TEXT DEFAULT 'none',      -- 'none'|'recent'|'hybrid'
  context_retrieval_limit INTEGER DEFAULT 5,

  -- Output handling (v14)
  output_store_limit_bytes INTEGER NOT NULL DEFAULT 65536,
  output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 2000,
  output_summary_limit_bytes INTEGER NOT NULL DEFAULT 5000,
  output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536,

  -- Session continuity (v9)
  preferred_session_key TEXT DEFAULT NULL,           -- pass to gateway for session reuse

  -- Auth profile override (v16)
  auth_profile    TEXT DEFAULT NULL,                  -- null=default, 'inherit'=main session profile, or 'provider:label'

  -- Delivery opt-out (v19)
  delivery_opt_out_reason TEXT DEFAULT NULL,          -- set when delivery_mode='none' to explicitly skip delivery

  -- Origin tracking (v20)
  origin          TEXT DEFAULT NULL,                  -- where job was dispatched from: "telegram:<chat_id>", "system", etc.

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
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- RUNS: job execution history with heartbeat tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|running|ok|error|timeout|skipped|awaiting_approval|approved|cancelled|crashed
  
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
  dispatched_at   TEXT,
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,

  -- Retry tracking (v3b)
  retry_count     INTEGER DEFAULT 0,
  retry_of        TEXT,                             -- original run id if this is a retry
  triggered_by_run TEXT,                            -- parent run id if this run was chain-triggered
  dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,

  -- Context & replay (v5)
  context_summary TEXT,                             -- JSON: {messages_injected,scope,...}
  replay_of       TEXT,                             -- run id if this is a crash replay

  -- Idempotency (v7)
  idempotency_key TEXT                              -- deterministic key for dedup
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_dispatch_queue ON runs(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL;

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
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|delivered|read|expired|failed
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
  owner           TEXT                                -- originator of typed message
);

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
INSERT OR IGNORE INTO delivery_aliases (alias, channel, target, description) VALUES
  ('team_room', 'telegram', '-1000000001', 'Team room (placeholder -- replace with <your-telegram-chat-id>)'),
  ('owner_dm',  'telegram', '1000000001',  'Owner DM (placeholder -- replace with <your-telegram-user-id>)');

-- ============================================================
-- APPROVALS: HITL approval gates (v5)
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|timed_out|dispatched
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     TEXT,                               -- 'operator'|'timeout'|'api'
  notes           TEXT
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
  dispatch_kind   TEXT NOT NULL,                   -- manual|chain|retry
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|awaiting_approval|done|cancelled
  scheduled_for   TEXT NOT NULL,
  source_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
  retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at      TEXT,
  processed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_due ON job_dispatch_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_job ON job_dispatch_queue(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_queue_source_run ON job_dispatch_queue(source_run_id) WHERE source_run_id IS NOT NULL;

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
-- MIGRATION LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fresh installs start at v12 (all columns already in schema above).
-- Existing installs are brought up to v20 by migrate-consolidate.js.
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

-- ============================================================
-- SEED JOBS
-- ============================================================

-- Dispatch 529 Recovery: safety net -- scans for 529-failed sessions and re-enqueues.
INSERT OR IGNORE INTO jobs (
  id, name, enabled,
  schedule_cron, schedule_tz,
  session_target, agent_id,
  payload_kind, payload_message,
  payload_timeout_seconds,
  next_run_at,
  created_at, updated_at
) VALUES (
  '8f2be5bd-b537-48c7-b277-44e934104ddc',
  'Dispatch 529 Recovery',
  0,
  '*/10 * * * *',
  'UTC',
  'shell',
  'main',
  'shellCommand',
  'node dispatch/529-recovery.mjs',
  120,
  NULL,
  datetime('now'),
  datetime('now')
);

-- Reconcile previously seeded broken recovery rows:
-- - wrong target ('isolated' + 'shellCommand')
-- - legacy script path under ~/.openclaw/<legacy-folder>
-- - missing next_run_at (never becomes due)
UPDATE jobs
SET
  session_target = 'shell',
  payload_kind = 'shellCommand',
  payload_message = 'node dispatch/529-recovery.mjs',
  next_run_at = CASE
    WHEN enabled = 1 AND next_run_at IS NULL THEN datetime('now', '-1 second')
    ELSE next_run_at
  END,
  updated_at = datetime('now')
WHERE
  id = '8f2be5bd-b537-48c7-b277-44e934104ddc'
  AND (
    session_target = 'isolated'
    OR payload_message LIKE 'node ~/.openclaw/%/529-recovery.mjs'
    OR (enabled = 1 AND next_run_at IS NULL)
  );
