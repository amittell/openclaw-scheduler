// Migration: v5 → v6
// Adds task_tracker and task_tracker_agents tables for dead-man's-switch
// monitoring of sub-agent teams.
import { getDb } from './db.js';

export default function migrate() {
  const db = getDb();

  // Check if v6 already applied
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get();
  if (row) return false; // already migrated

  // -- Task Tracker tables ------------------------------------------------
  db.exec(`
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
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tta_tracker ON task_tracker_agents(tracker_id);
    CREATE INDEX IF NOT EXISTS idx_tta_status ON task_tracker_agents(status) WHERE status IN ('pending','running');
  `);

  // -- Record migration ---------------------------------------------------
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (6)').run();

  return true; // migration applied
}
