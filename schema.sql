-- OpenClaw Scheduler Schema (current: v1.0.0, schema version: 6)
-- Full standalone scheduler + message router

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- JOBS: scheduled tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  
  -- Schedule: always cron (no mixed formats)
  schedule_cron   TEXT NOT NULL,
  schedule_tz     TEXT NOT NULL DEFAULT 'America/New_York',
  
  -- Execution
  session_target  TEXT NOT NULL DEFAULT 'isolated',  -- 'main' | 'isolated'
  agent_id        TEXT DEFAULT 'main',
  
  -- Payload
  payload_kind    TEXT NOT NULL,                      -- 'systemEvent' | 'agentTurn'
  payload_message TEXT NOT NULL,
  payload_model   TEXT,
  payload_thinking TEXT,
  payload_timeout_seconds INTEGER DEFAULT 120,
  
  -- Overlap & timeout
  overlap_policy  TEXT NOT NULL DEFAULT 'skip',       -- 'skip' | 'allow' | 'queue'
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,
  
  -- Delivery
  delivery_mode   TEXT DEFAULT 'announce',            -- 'announce' | 'none'
  delivery_channel TEXT,
  delivery_to     TEXT,
  
  -- Metadata
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delete_after_run INTEGER NOT NULL DEFAULT 0,

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
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|running|ok|error|timeout|skipped
  
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
  dispatched_at   TEXT,
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,

  -- Retry tracking (v3b)
  retry_count     INTEGER DEFAULT 0,
  retry_of        TEXT,                             -- original run id if this is a retry

  -- Context & replay (v5)
  context_summary TEXT,                             -- JSON: {messages_injected,scope,...}
  replay_of       TEXT,                             -- run id if this is a crash replay

  -- Idempotency (v7)
  idempotency_key TEXT                              -- deterministic key for dedup
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status) WHERE status = 'running';
-- idx_runs_idempotency created by migrate-v7.js (cannot reference column before migration adds it)

-- ============================================================
-- MESSAGES: inter-agent message queue
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  
  -- Routing
  from_agent      TEXT NOT NULL,                      -- sender agent id or 'scheduler' or 'user'
  to_agent        TEXT NOT NULL,                      -- recipient agent id or 'broadcast'
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

INSERT OR IGNORE INTO delivery_aliases (alias, channel, target, description) VALUES
  ('team_room', 'telegram', '-1000000001', 'Team room'),
  ('owner_dm',  'telegram', '1000000001',  'Owner DM');

-- ============================================================
-- APPROVALS: HITL approval gates (v5)
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|timed_out
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     TEXT,                               -- 'operator'|'timeout'|'api'
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals(job_id);

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

-- ============================================================
-- MIGRATION LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (6);
-- v7: idempotency ledger (applied by migrate-v7.js)
-- v8: task_tracker_agents.session_key + last_heartbeat (applied by migrate-v8.js)
