/**
 * migrate-consolidate.js — Single idempotent migration for existing databases
 *
 * Brings any DB from any prior version up to the current schema (v9).
 * Fresh installs get everything from schema.sql directly — this only
 * runs ALTER TABLEs needed for DBs created before the current schema.
 *
 * Replaces: migrate-v3.js, migrate-v3b.js, migrate-v5.js, migrate-v6.js,
 *           migrate-v7.js, migrate-v8.js, migrate-v9.js
 *
 * Safe to run multiple times — all operations are idempotent.
 */

import { getDb } from './db.js';

export default function migrateConsolidate() {
  const db = getDb();

  // Already fully up to date?
  const current = db.prepare(
    'SELECT MAX(version) as v FROM schema_migrations'
  ).get()?.v ?? 0;
  if (current >= 9) return false;

  // ── Column additions (all idempotent — column already exists = silent ignore) ─

  const alters = [
    // v3: workflow chaining
    `ALTER TABLE jobs ADD COLUMN parent_id TEXT`,
    `ALTER TABLE jobs ADD COLUMN trigger_on TEXT`,
    `ALTER TABLE jobs ADD COLUMN trigger_delay_s INTEGER DEFAULT 0`,
    // v3b: retry logic
    `ALTER TABLE jobs ADD COLUMN max_retries INTEGER DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN retry_count INTEGER DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN retry_of TEXT`,
    // v3c: queue overlap + scope
    `ALTER TABLE jobs ADD COLUMN queued_count INTEGER DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN payload_scope TEXT NOT NULL DEFAULT 'own'`,
    `ALTER TABLE jobs ADD COLUMN resource_pool TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN trigger_condition TEXT DEFAULT NULL`,
    // v5: delivery semantics + approval gates + context retrieval
    `ALTER TABLE jobs ADD COLUMN delivery_guarantee TEXT DEFAULT 'at-most-once'`,
    `ALTER TABLE jobs ADD COLUMN job_class TEXT DEFAULT 'standard'`,
    `ALTER TABLE jobs ADD COLUMN approval_required INTEGER DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN approval_timeout_s INTEGER DEFAULT 3600`,
    `ALTER TABLE jobs ADD COLUMN approval_auto TEXT DEFAULT 'reject'`,
    `ALTER TABLE jobs ADD COLUMN context_retrieval TEXT DEFAULT 'none'`,
    `ALTER TABLE jobs ADD COLUMN context_retrieval_limit INTEGER DEFAULT 5`,
    `ALTER TABLE runs ADD COLUMN context_summary TEXT`,
    `ALTER TABLE runs ADD COLUMN replay_of TEXT`,
    `ALTER TABLE messages ADD COLUMN owner TEXT`,
    // v7: idempotency
    `ALTER TABLE runs ADD COLUMN idempotency_key TEXT`,
    // v8: task tracker session correlation
    `ALTER TABLE task_tracker_agents ADD COLUMN session_key TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN last_heartbeat TEXT`,
    // v9: session reuse
    `ALTER TABLE jobs ADD COLUMN preferred_session_key TEXT DEFAULT NULL`,
  ];

  for (const sql of alters) {
    try { db.exec(sql); } catch { /* column already exists — ignore */ }
  }

  // ── Tables that may be absent on very old installs ────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      resolved_by     TEXT,
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals(job_id);

    CREATE TABLE IF NOT EXISTS task_tracker (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      created_by      TEXT NOT NULL DEFAULT 'main',
      expected_agents TEXT NOT NULL,
      timeout_s       INTEGER NOT NULL DEFAULT 600,
      status          TEXT NOT NULL DEFAULT 'active',
      completed_at    TEXT,
      delivery_channel TEXT,
      delivery_to     TEXT,
      summary         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_tracker_status ON task_tracker(status) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS task_tracker_agents (
      id              TEXT PRIMARY KEY,
      tracker_id      TEXT NOT NULL REFERENCES task_tracker(id) ON DELETE CASCADE,
      agent_label     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      started_at      TEXT,
      finished_at     TEXT,
      exit_message    TEXT,
      error           TEXT,
      session_key     TEXT,
      last_heartbeat  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tta_tracker ON task_tracker_agents(tracker_id);
    CREATE INDEX IF NOT EXISTS idx_tta_status ON task_tracker_agents(status) WHERE status IN ('pending','running');

    CREATE TABLE IF NOT EXISTS idempotency_ledger (
      key             TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL,
      run_id          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'claimed',
      claimed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      released_at     TEXT,
      result_hash     TEXT,
      expires_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_ledger(expires_at);
    CREATE INDEX IF NOT EXISTS idx_idem_job ON idempotency_ledger(job_id);
  `);

  // ── Indexes that may be absent ────────────────────────────────────────

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
      ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tta_session_key
      ON task_tracker_agents(session_key) WHERE session_key IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  // ── Record all versions ───────────────────────────────────────────────

  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    stmt.run(v);
  }

  return true;
}

// Allow running as standalone script: node migrate-consolidate.js
if (process.argv[1] && process.argv[1].endsWith('migrate-consolidate.js')) {
  const applied = migrateConsolidate();
  console.log(applied
    ? 'Consolidation migration applied — DB is now at schema v9'
    : 'DB already at v9 — nothing to do'
  );
}
