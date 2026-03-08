/**
 * migrate-consolidate.js — Single idempotent migration for existing databases
 *
 * Brings any DB from any prior version up to the current schema (v12).
 * Fresh installs get everything from schema.sql directly — this only
 * runs ALTER TABLEs needed for DBs created before the current schema.
 *
 * Replaces: migrate-v3.js, migrate-v3b.js, migrate-v5.js, migrate-v6.js,
 *           migrate-v7.js, migrate-v8.js, migrate-v9.js, migrate-v10.js, migrate-v11.js, migrate-v12.js
 *
 * Safe to run multiple times — all operations are idempotent.
 */

import { getDb } from './db.js';

function reconcileSeedJobs(db) {
  try {
    db.exec(`
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
        1,
        '*/10 * * * *',
        'UTC',
        'shell',
        'main',
        'shellCommand',
        'node dispatch/529-recovery.mjs',
        120,
        datetime('now', '-1 second'),
        datetime('now'),
        datetime('now')
      );

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
    `);
  } catch {
    // best effort; old schemas may be missing jobs columns before migration
  }
}

export default function migrateConsolidate() {
  const db = getDb();

  // Already fully up to date?
  const current = db.prepare(
    'SELECT MAX(version) as v FROM schema_migrations'
  ).get()?.v ?? 0;
  if (current >= 13) {
    reconcileSeedJobs(db);
    return false;
  }

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
    `ALTER TABLE runs ADD COLUMN triggered_by_run TEXT`,
    `ALTER TABLE runs ADD COLUMN dispatch_queue_id TEXT`,
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
    // v10: team routing + receipts on messages
    `ALTER TABLE messages ADD COLUMN team_id TEXT`,
    `ALTER TABLE messages ADD COLUMN member_id TEXT`,
    `ALTER TABLE messages ADD COLUMN task_id TEXT`,
    `ALTER TABLE messages ADD COLUMN ack_required INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN ack_at TEXT`,
    `ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN last_error TEXT`,
    `ALTER TABLE messages ADD COLUMN team_mapped_at TEXT`,
    // v11: durable non-cron dispatches
    `ALTER TABLE approvals ADD COLUMN dispatch_queue_id TEXT`,
    // v12: structured shell results
    `ALTER TABLE runs ADD COLUMN shell_exit_code INTEGER`,
    `ALTER TABLE runs ADD COLUMN shell_signal TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_timed_out INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN shell_stdout TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stderr TEXT`,
    // v13: watchdog monitoring
    `ALTER TABLE jobs ADD COLUMN job_type TEXT NOT NULL DEFAULT 'standard'`,
    `ALTER TABLE jobs ADD COLUMN watchdog_target_label TEXT`,
    `ALTER TABLE jobs ADD COLUMN watchdog_check_cmd TEXT`,
    `ALTER TABLE jobs ADD COLUMN watchdog_timeout_min INTEGER`,
    `ALTER TABLE jobs ADD COLUMN watchdog_alert_channel TEXT`,
    `ALTER TABLE jobs ADD COLUMN watchdog_alert_target TEXT`,
    `ALTER TABLE jobs ADD COLUMN watchdog_self_destruct INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE jobs ADD COLUMN watchdog_started_at TEXT`,
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
      dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS message_receipts (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      event_type      TEXT NOT NULL,
      attempt         INTEGER,
      actor           TEXT,
      detail          TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_tasks (
      team_id         TEXT NOT NULL,
      id              TEXT NOT NULL,
      member_id       TEXT,
      source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      title           TEXT,
      status          TEXT NOT NULL DEFAULT 'open',
      gate_tracker_id TEXT REFERENCES task_tracker(id) ON DELETE SET NULL,
      gate_status     TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT,
      PRIMARY KEY (team_id, id)
    );

    CREATE TABLE IF NOT EXISTS team_mailbox_events (
      id              TEXT PRIMARY KEY,
      team_id         TEXT NOT NULL,
      member_id       TEXT,
      task_id         TEXT,
      message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
      event_type      TEXT NOT NULL,
      payload         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_dispatch_queue (
      id              TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      dispatch_kind   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      scheduled_for   TEXT NOT NULL,
      source_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
      retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at      TEXT,
      processed_at    TEXT
    );
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

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_team
      ON messages(team_id, member_id, status) WHERE team_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_task
      ON messages(team_id, task_id, created_at)
      WHERE team_id IS NOT NULL AND task_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_ack_pending
      ON messages(ack_required, ack_at, status)
      WHERE ack_required = 1 AND ack_at IS NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_receipts_message
      ON message_receipts(message_id, created_at DESC)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_team_tasks_status
      ON team_tasks(team_id, status, updated_at DESC)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_team_tasks_gate
      ON team_tasks(gate_tracker_id) WHERE gate_tracker_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_team_events_team
      ON team_mailbox_events(team_id, created_at DESC)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_team_events_task
      ON team_mailbox_events(team_id, task_id, created_at DESC)
      WHERE task_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_dispatch_queue
      ON runs(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approvals_dispatch_queue
      ON approvals(dispatch_queue_id) WHERE dispatch_queue_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_due
      ON job_dispatch_queue(status, scheduled_for)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_job
      ON job_dispatch_queue(job_id, created_at DESC)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_source_run
      ON job_dispatch_queue(source_run_id) WHERE source_run_id IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  // ── Record all versions ───────────────────────────────────────────────

  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    stmt.run(v);
  }

  reconcileSeedJobs(db);

  return true;
}

// Allow running as standalone script: node migrate-consolidate.js
if (process.argv[1] && process.argv[1].endsWith('migrate-consolidate.js')) {
  const applied = migrateConsolidate();
  console.log(applied
    ? 'Consolidation migration applied — DB is now at schema v13'
    : 'DB already at v13 — nothing to do'
  );
}
