/**
 * migrate-consolidate.js — Single idempotent migration for existing databases
 *
 * Brings any DB from any prior version up to the current schema (v21).
 * Fresh installs get everything from schema.sql directly — this only
 * runs ALTER TABLEs needed for DBs created before the current schema.
 *
 * Replaces: migrate-v3.js, migrate-v3b.js, migrate-v5.js, migrate-v6.js,
 *           migrate-v7.js, migrate-v8.js, migrate-v9.js, migrate-v10.js, migrate-v11.js, migrate-v12.js, migrate-v13.js, migrate-v14.js, migrate-v15.js, migrate-v16.js, migrate-v17.js, migrate-v18.js, migrate-v19.js, migrate-v20.js
 *
 * Safe to run multiple times — all operations are idempotent.
 * Note: schedule_cron NOT NULL constraint cannot be dropped via ALTER TABLE in SQLite.
 * At-jobs on existing DBs use sentinel '0 0 31 2 *' to satisfy the constraint.
 */

import { getDb } from './db.js';

export default function migrateConsolidate() {
  const db = getDb();
  const hasTable = (name) => !!db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name);

  // Already fully up to date?
  // Note: we can't just check schema_migrations version — schema.sql inserts
  // version markers via INSERT OR IGNORE, but CREATE TABLE IF NOT EXISTS
  // doesn't add new columns to existing tables. So we also check if the
  // latest column actually exists before skipping.
  const current = hasTable('schema_migrations')
    ? (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get()?.v ?? 0)
    : 0;
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
  const runColumns = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  const hasLatestColumns =
    jobColumns.has('job_type')
    && jobColumns.has('execution_intent')
    && jobColumns.has('max_queued_dispatches')
    && jobColumns.has('output_offload_threshold_bytes')
    && runColumns.has('dispatch_queue_id')
    && runColumns.has('shell_exit_code')
    && runColumns.has('shell_signal')
    && runColumns.has('shell_timed_out')
    && runColumns.has('shell_stdout')
    && runColumns.has('shell_stderr')
    && runColumns.has('shell_stdout_path')
    && runColumns.has('shell_stderr_path')
    && jobColumns.has('ttl_hours')
    && jobColumns.has('auth_profile')
    && jobColumns.has('schedule_kind')
    && jobColumns.has('schedule_at')
    && jobColumns.has('delivery_opt_out_reason')
    && jobColumns.has('origin');
  const agentColumns = new Set(db.prepare('PRAGMA table_info(agents)').all().map(c => c.name));
  const hasAgentDelivery = agentColumns.has('delivery_channel')
    && agentColumns.has('delivery_to')
    && agentColumns.has('brand_name');
  const msgColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
  const hasMsgDeliveryTo = msgColumns.has('delivery_to');
  const legacyAtIsoCount = (jobColumns.has('schedule_kind') && jobColumns.has('schedule_at'))
    ? (db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM jobs
        WHERE schedule_kind = 'at'
          AND schedule_at IS NOT NULL
          AND instr(schedule_at, 'T') > 0
      `).get()?.cnt ?? 0)
    : 0;
  const legacyPayloadMismatchCount = (jobColumns.has('session_target') && jobColumns.has('payload_kind'))
    ? (db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM jobs
        WHERE (session_target = 'shell' AND payload_kind != 'shellCommand')
           OR (session_target = 'main' AND payload_kind != 'systemEvent')
      `).get()?.cnt ?? 0)
    : 0;
  const legacyMissingDeliveryOptOutCount = (jobColumns.has('payload_kind') && jobColumns.has('delivery_mode') && jobColumns.has('delivery_opt_out_reason'))
    ? (db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM jobs
        WHERE parent_id IS NULL
          AND payload_kind = 'agentTurn'
          AND delivery_mode = 'none'
          AND (delivery_opt_out_reason IS NULL OR trim(delivery_opt_out_reason) = '')
      `).get()?.cnt ?? 0)
    : 0;
  if (
    current >= 21
    && hasLatestColumns
    && hasAgentDelivery
    && hasMsgDeliveryTo
    && legacyAtIsoCount === 0
    && legacyPayloadMismatchCount === 0
    && legacyMissingDeliveryOptOutCount === 0
  ) {
    return false;
  }

  // ── Column additions (all idempotent — column already exists = silent ignore) ─

  const alters = [
    // Legacy partial-table backfills for messages
    `ALTER TABLE messages ADD COLUMN to_agent TEXT`,
    `ALTER TABLE messages ADD COLUMN from_agent TEXT`,
    `ALTER TABLE messages ADD COLUMN kind TEXT`,
    `ALTER TABLE messages ADD COLUMN content TEXT`,
    `ALTER TABLE messages ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN channel TEXT`,
    `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE messages ADD COLUMN delivered_at TEXT`,
    `ALTER TABLE messages ADD COLUMN read_at TEXT`,
    `ALTER TABLE messages ADD COLUMN expires_at TEXT`,
    `ALTER TABLE messages ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE messages ADD COLUMN job_id TEXT`,
    `ALTER TABLE messages ADD COLUMN run_id TEXT`,
    // Legacy partial-table backfills for approvals
    `ALTER TABLE approvals ADD COLUMN job_id TEXT`,
    `ALTER TABLE approvals ADD COLUMN run_id TEXT`,
    `ALTER TABLE approvals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE approvals ADD COLUMN requested_at TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE approvals ADD COLUMN resolved_at TEXT`,
    `ALTER TABLE approvals ADD COLUMN resolved_by TEXT`,
    `ALTER TABLE approvals ADD COLUMN notes TEXT`,
    // Legacy partial-table backfills for task tracking
    `ALTER TABLE task_tracker ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE task_tracker ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE task_tracker ADD COLUMN created_by TEXT NOT NULL DEFAULT 'main'`,
    `ALTER TABLE task_tracker ADD COLUMN expected_agents TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE task_tracker ADD COLUMN timeout_s INTEGER NOT NULL DEFAULT 600`,
    `ALTER TABLE task_tracker ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE task_tracker ADD COLUMN completed_at TEXT`,
    `ALTER TABLE task_tracker ADD COLUMN delivery_channel TEXT`,
    `ALTER TABLE task_tracker ADD COLUMN delivery_to TEXT`,
    `ALTER TABLE task_tracker ADD COLUMN summary TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN tracker_id TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN agent_label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE task_tracker_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE task_tracker_agents ADD COLUMN started_at TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN finished_at TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN exit_message TEXT`,
    `ALTER TABLE task_tracker_agents ADD COLUMN error TEXT`,
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
    // v14: execution intent, budgets, and shell-output offloading
    `ALTER TABLE jobs ADD COLUMN execution_intent TEXT NOT NULL DEFAULT 'execute'`,
    `ALTER TABLE jobs ADD COLUMN execution_read_only INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN max_queued_dispatches INTEGER NOT NULL DEFAULT 25`,
    `ALTER TABLE jobs ADD COLUMN max_pending_approvals INTEGER NOT NULL DEFAULT 10`,
    `ALTER TABLE jobs ADD COLUMN max_trigger_fanout INTEGER NOT NULL DEFAULT 25`,
    `ALTER TABLE jobs ADD COLUMN output_store_limit_bytes INTEGER NOT NULL DEFAULT 65536`,
    `ALTER TABLE jobs ADD COLUMN output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 2000`,
    `ALTER TABLE jobs ADD COLUMN output_summary_limit_bytes INTEGER NOT NULL DEFAULT 5000`,
    `ALTER TABLE jobs ADD COLUMN output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536`,
    `ALTER TABLE runs ADD COLUMN shell_stdout_path TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stderr_path TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stdout_bytes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN shell_stderr_bytes INTEGER NOT NULL DEFAULT 0`,
    // v15: TTL-based auto-deletion
    `ALTER TABLE jobs ADD COLUMN ttl_hours INTEGER DEFAULT NULL`,
    // v16: auth profile override
    `ALTER TABLE jobs ADD COLUMN auth_profile TEXT DEFAULT NULL`,
    // v17: agent delivery config
    `ALTER TABLE agents ADD COLUMN delivery_channel TEXT`,
    `ALTER TABLE agents ADD COLUMN delivery_to TEXT`,
    `ALTER TABLE agents ADD COLUMN brand_name TEXT`,
    // v18: one-shot 'at'-style scheduling
    // Note: schedule_cron NOT NULL constraint cannot be dropped in SQLite via ALTER TABLE.
    // At-jobs on existing DBs must use sentinel cron '0 0 31 2 *' to satisfy the constraint.
    `ALTER TABLE jobs ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'cron'`,
    `ALTER TABLE jobs ADD COLUMN schedule_at TEXT DEFAULT NULL`,
    // v19: delivery opt-out reason
    `ALTER TABLE jobs ADD COLUMN delivery_opt_out_reason TEXT DEFAULT NULL`,
    // v20: origin tracking
    `ALTER TABLE jobs ADD COLUMN origin TEXT DEFAULT NULL`,
    // v21: per-message delivery routing
    `ALTER TABLE messages ADD COLUMN delivery_to TEXT`,
  ];

  for (const sql of alters) {
    try { db.exec(sql); } catch { /* column already exists — ignore */ }
  }

  // Normalize legacy ISO schedule_at / next_run_at values for at-jobs so due checks
  // use a consistent SQLite UTC datetime format after upgrades.
  try {
    db.exec(`
      UPDATE jobs
      SET schedule_at = strftime('%Y-%m-%d %H:%M:%S', schedule_at)
      WHERE schedule_kind = 'at'
        AND schedule_at IS NOT NULL
        AND instr(schedule_at, 'T') > 0
        AND strftime('%Y-%m-%d %H:%M:%S', schedule_at) IS NOT NULL;

      UPDATE jobs
      SET next_run_at = strftime('%Y-%m-%d %H:%M:%S', next_run_at)
      WHERE schedule_kind = 'at'
        AND next_run_at IS NOT NULL
        AND instr(next_run_at, 'T') > 0
        AND strftime('%Y-%m-%d %H:%M:%S', next_run_at) IS NOT NULL;
    `);
  } catch {
    /* best-effort normalization for legacy rows */
  }

  // Normalize legacy session_target/payload_kind mismatches left behind by older
  // imports or hand-edited rows so current validation/dispatch rules behave
  // consistently on upgraded installs.
  try {
    db.exec(`
      UPDATE jobs
      SET payload_kind = 'shellCommand'
      WHERE session_target = 'shell'
        AND payload_kind != 'shellCommand';

      UPDATE jobs
      SET payload_kind = 'systemEvent'
      WHERE session_target = 'main'
        AND payload_kind != 'systemEvent';

      UPDATE jobs
      SET delivery_opt_out_reason = 'legacy scheduler job intentionally suppresses automatic delivery'
      WHERE parent_id IS NULL
        AND payload_kind = 'agentTurn'
        AND delivery_mode = 'none'
        AND (delivery_opt_out_reason IS NULL OR trim(delivery_opt_out_reason) = '');
    `);
  } catch {
    /* best-effort normalization for legacy rows */
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
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]) {
    stmt.run(v);
  }

  return true;
}

// Allow running as standalone script: node migrate-consolidate.js
if (process.argv[1] && process.argv[1].endsWith('migrate-consolidate.js')) {
  const applied = migrateConsolidate();
  console.log(applied
    ? 'Consolidation migration applied — DB is now at schema v21'
    : 'DB already at v21 — nothing to do'
  );
}
