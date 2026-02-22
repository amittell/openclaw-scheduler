-- OpenClaw Scheduler Schema v2
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

  -- Retry logic (v3b)
  max_retries     INTEGER DEFAULT 0,             -- 0 = no retry
  
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
  retry_of        TEXT                              -- original run id if this is a retry
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status) WHERE status = 'running';

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
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL
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
-- MIGRATION LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
