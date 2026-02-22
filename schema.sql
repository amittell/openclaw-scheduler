-- OpenClaw Scheduler Schema v1
-- Replaces jobs.json + heartbeat with SQLite-backed scheduling

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- JOBS: what to run and when
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,                -- UUID
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,      -- 0/1
  
  -- Schedule: always a cron expression (no mixed formats)
  schedule_cron   TEXT NOT NULL,                    -- 5-field cron expr
  schedule_tz     TEXT NOT NULL DEFAULT 'America/New_York',  -- IANA timezone
  
  -- Execution target
  session_target  TEXT NOT NULL DEFAULT 'isolated', -- 'main' | 'isolated'
  agent_id        TEXT DEFAULT 'main',
  
  -- Payload
  payload_kind    TEXT NOT NULL,                    -- 'systemEvent' | 'agentTurn'
  payload_message TEXT NOT NULL,                    -- prompt or event text
  payload_model   TEXT,                             -- optional model override
  payload_thinking TEXT,                            -- optional thinking level
  payload_timeout_seconds INTEGER DEFAULT 120,      -- agent turn timeout
  
  -- Overlap policy
  overlap_policy  TEXT NOT NULL DEFAULT 'skip',     -- 'skip' | 'allow' | 'queue'
  
  -- Stale run detection
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000,  -- 5 min default; fallback if heartbeat fails
  
  -- Delivery
  delivery_mode   TEXT DEFAULT 'announce',          -- 'announce' | 'none'
  delivery_channel TEXT,                            -- 'telegram' | 'whatsapp' | etc
  delivery_to     TEXT,                             -- target chat/recipient
  
  -- Metadata
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- One-shot behavior
  delete_after_run INTEGER NOT NULL DEFAULT 0,      -- 0/1; for one-shot jobs
  
  -- Scheduling state (denormalized for fast dispatcher queries)
  next_run_at     TEXT,                             -- ISO datetime of next scheduled run
  last_run_at     TEXT,                             -- ISO datetime of last run start
  last_status     TEXT,                             -- 'ok' | 'error' | 'timeout' | 'skipped'
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);

-- ============================================================
-- RUNS: execution history with heartbeat tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,                -- UUID
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  
  -- Status lifecycle: pending -> running -> ok|error|timeout|skipped
  status          TEXT NOT NULL DEFAULT 'pending',
  
  -- Timing
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  duration_ms     INTEGER,
  
  -- Heartbeat: dispatcher updates this by checking session activity
  last_heartbeat  TEXT NOT NULL DEFAULT (datetime('now')),
  
  -- Session tracking (for implicit heartbeat via session activity)
  session_key     TEXT,                            -- OpenClaw session key for this run
  session_id      TEXT,                            -- OpenClaw session id
  
  -- Result
  summary         TEXT,                            -- output summary
  error_message   TEXT,                            -- error details if failed
  
  -- Dispatcher metadata
  dispatched_at   TEXT,                            -- when dispatcher actually fired this
  
  -- Denormalized for fast stale queries
  run_timeout_ms  INTEGER NOT NULL DEFAULT 300000  -- copied from job at dispatch time
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_runs_stale ON runs(status, last_heartbeat) WHERE status = 'running';

-- ============================================================
-- MIGRATION LOG: track schema versions
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version   INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
