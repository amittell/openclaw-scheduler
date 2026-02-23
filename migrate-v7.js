// Migration: v6 → v7
// Adds idempotency key support: column on runs, idempotency_ledger table.
import { getDb } from './db.js';

export default function migrate() {
  const db = getDb();

  // Check if v7 already applied
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 7').get();
  if (row) {
    // Even if version is recorded (e.g. fresh schema.sql), ensure the index exists
    // since schema.sql doesn't create it (to avoid column-not-found on legacy DBs)
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`);
    } catch { /* column may not exist in edge cases — ignore */ }
    return false;
  }

  // -- Runs: idempotency_key column ---------------------------------------
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN idempotency_key TEXT`);
  } catch { /* column already exists — safe to ignore */ }

  // -- Unique partial index on runs.idempotency_key -----------------------
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // -- Idempotency ledger table -------------------------------------------
  db.exec(`
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

  // -- Record migration ---------------------------------------------------
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (7)').run();

  return true; // migration applied
}
