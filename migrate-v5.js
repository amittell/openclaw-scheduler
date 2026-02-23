// Migration: v4 → v5
// Adds delivery semantics, job class, approval gates, context retrieval,
// typed messages with owner, context summary on runs, and the approvals table.
import { getDb } from './db.js';

export default function migrate() {
  const db = getDb();

  // Check if v5 already applied
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get();
  if (row) return false; // already migrated

  // -- Jobs: new columns --------------------------------------------------
  const jobCols = [
    `ALTER TABLE jobs ADD COLUMN delivery_guarantee TEXT DEFAULT 'at-most-once'`,
    `ALTER TABLE jobs ADD COLUMN job_class TEXT DEFAULT 'standard'`,
    `ALTER TABLE jobs ADD COLUMN approval_required INTEGER DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN approval_timeout_s INTEGER DEFAULT 3600`,
    `ALTER TABLE jobs ADD COLUMN approval_auto TEXT DEFAULT 'reject'`,
    `ALTER TABLE jobs ADD COLUMN context_retrieval TEXT DEFAULT 'none'`,
    `ALTER TABLE jobs ADD COLUMN context_retrieval_limit INTEGER DEFAULT 5`,
  ];

  // -- Runs: new columns --------------------------------------------------
  const runCols = [
    `ALTER TABLE runs ADD COLUMN context_summary TEXT`,
    `ALTER TABLE runs ADD COLUMN replay_of TEXT`,
  ];

  // -- Messages: new column -----------------------------------------------
  const msgCols = [
    `ALTER TABLE messages ADD COLUMN owner TEXT`,
  ];

  const allAlters = [...jobCols, ...runCols, ...msgCols];
  for (const sql of allAlters) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }

  // -- Approvals table ----------------------------------------------------
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
  `);

  // -- Record migration ---------------------------------------------------
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (5)').run();

  return true; // migration applied
}
