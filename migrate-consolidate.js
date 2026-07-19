/**
 * migrate-consolidate.js -- Single idempotent migration for existing databases
 *
 * Brings any DB from any prior version up to the current schema (v29).
 * Fresh installs get everything from schema.sql directly -- this only
 * runs ALTER TABLEs needed for DBs created before the current schema.
 *
 * Replaces: migrate-v3.js, migrate-v3b.js, migrate-v5.js, migrate-v6.js,
 *           migrate-v7.js, migrate-v8.js, migrate-v9.js, migrate-v10.js, migrate-v11.js, migrate-v12.js, migrate-v13.js, migrate-v14.js, migrate-v15.js, migrate-v16.js, migrate-v17.js, migrate-v18.js, migrate-v19.js, migrate-v20.js
 *
 * Safe to run multiple times -- all operations are idempotent.
 * Note: schedule_cron NOT NULL constraint cannot be dropped via ALTER TABLE in SQLite.
 * At-jobs on existing DBs use sentinel '0 0 31 2 *' to satisfy the constraint.
 */

import { Cron } from 'croner';
import { applyBundledSchema, getDb } from './db.js';

function nextRunFromCron(cronExpr, tz) {
  const cron = new Cron(cronExpr, { timezone: tz || 'UTC' });
  const next = cron.nextRun();
  if (!next) return null;
  return next.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export default function migrateConsolidate() {
  const db = getDb();
  const hasTable = (name) => !!db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name);
  const hasIndex = (name) => !!db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'index' AND name = ?
    LIMIT 1
  `).get(name);
  const hasTrigger = (name) => !!db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'trigger' AND name = ?
    LIMIT 1
  `).get(name);

  // Already fully up to date?
  // Note: we can't just check schema_migrations version -- schema.sql inserts
  // version markers via INSERT OR IGNORE, but CREATE TABLE IF NOT EXISTS
  // doesn't add new columns to existing tables. So we also check if the
  // latest column actually exists before skipping.
  const current = hasTable('schema_migrations')
    ? (db.prepare('SELECT MAX(version) as v FROM schema_migrations').get()?.v ?? 0)
    : 0;
  if (current > 29) {
    const error = new Error(`Database schema version ${current} is newer than supported version 29`);
    error.code = 'SCHEMA_VERSION_UNSUPPORTED';
    throw error;
  }
  // SQLite PRAGMA does not support bound parameters; table names here are all hardcoded literals.
  const columnInfoFor = (table) => db.prepare(`PRAGMA table_info(${table})`).all();
  const columnsFor = (table) => new Set(columnInfoFor(table).map((c) => c.name));
  const hasColumns = (actual, required) => required.every((name) => actual.has(name));
  const jobColumns = columnsFor('jobs');
  const runColumns = columnsFor('runs');
  const agentColumns = columnsFor('agents');
  const msgColumns = columnsFor('messages');
  const approvalColumns = columnsFor('approvals');
  const queueColumns = columnsFor('job_dispatch_queue');
  const queueBindingIsNotNull = columnInfoFor('job_dispatch_queue')
    .some((column) => column.name === 'binding_scheduled_for' && column.notnull === 1);
  const trackerColumns = columnsFor('task_tracker');
  const trackerAgentColumns = columnsFor('task_tracker_agents');
  const completionDebtColumns = columnsFor('completion_debts');
  const completionDebtSql = hasTable('completion_debts')
    ? db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'completion_debts'").get()?.sql || ''
    : '';
  const completionDebtHasTableUnique = /UNIQUE\s*\(\s*task_label\s*,\s*delivery_scope\s*\)/i.test(completionDebtSql);
  const outboxColumns = columnsFor('delivery_outbox');
  const evidenceColumns = columnsFor('evidence_records');
  const evidenceHasForeignKeys = hasTable('evidence_records')
    && db.prepare('PRAGMA foreign_key_list(evidence_records)').all().length > 0;
  const hasLatestColumns =
    hasColumns(jobColumns, [
      'job_type', 'execution_intent', 'execution_read_only', 'shell_env_policy',
      'agent_id', 'payload_model', 'payload_thinking', 'payload_timeout_seconds',
      'overlap_policy', 'max_queued_dispatches', 'max_pending_approvals',
      'max_trigger_fanout', 'output_store_limit_bytes',
      'output_excerpt_limit_bytes', 'output_summary_limit_bytes',
      'output_offload_threshold_bytes', 'ttl_hours', 'auth_profile',
      'payload_model_fallback', 'auth_profile_fallback',
      'schedule_kind', 'schedule_at', 'delivery_channel', 'delivery_to',
      'delivery_opt_out_reason', 'origin', 'parent_id', 'created_at',
      'updated_at', 'delete_after_run', 'next_run_at', 'last_run_at',
      'last_status', 'consecutive_errors',
      'identity_principal', 'identity_run_as', 'identity_attestation',
      'identity_ref', 'identity_subject_kind', 'identity_subject_principal',
      'identity_trust_level', 'identity_delegation_mode', 'identity',
      'authorization_proof_ref', 'authorization_proof',
      'authorization_ref', 'authorization',
      'evidence_ref', 'evidence',
      'contract_required_trust_level', 'contract_trust_enforcement',
      'contract_sandbox', 'contract_allowed_paths', 'contract_network',
      'contract_max_cost_usd', 'contract_audit',
      'child_credential_policy',
      'approval_risk_level', 'approval_approver_scope', 'output_format',
      'verify_shell', 'verify_timeout_s', 'verify_on_failure',
      'handoff_version', 'handoff_artifact_digest', 'effective_task_hash',
    ])
    && hasColumns(runColumns, [
      'dispatch_queue_id', 'shell_exit_code', 'shell_signal', 'shell_timed_out',
      'shell_stdout', 'shell_stderr', 'shell_stdout_path', 'shell_stderr_path',
      'shell_stdout_bytes', 'shell_stderr_bytes', 'shell_stdout_sha256',
      'shell_stderr_sha256', 'idempotency_key',
      'summary', 'error_message', 'session_key', 'session_id',
      'dispatched_at', 'last_heartbeat',
      'identity_resolved', 'trust_evaluation', 'authorization_decision',
      'authorization_proof_verification', 'evidence_required',
      'evidence_execution_snapshot', 'evidence_declaration_snapshot',
      'evidence_ref_snapshot', 'evidence_record',
      'credential_handoff_summary',
      'delegation_validation', 'output_format', 'structured_output',
      'structured_output_valid', 'structured_output_warning',
      'structured_output_bytes', 'structured_output_sha256',
      'structured_output_path', 'verification_result', 'approval_used',
      'dispatcher_owner', 'dispatcher_token', 'dispatch_started_at',
      'cancel_requested_at', 'cancel_requested_by', 'cancel_reason',
      'process_pid', 'process_pgid', 'process_identity', 'process_started_at',
      'process_terminated_at', 'agent_cancel_requested_at',
      'terminal_transition_at', 'handoff_artifact_digest',
      'runtime_instance_id', 'source_run_id',
      'source_run_handoff_artifact_digest',
    ])
    && hasColumns(agentColumns, ['delivery_channel', 'delivery_to', 'brand_name'])
    && hasColumns(msgColumns, [
      'from_agent', 'to_agent', 'reply_to', 'kind', 'subject', 'body',
      'metadata', 'priority', 'channel', 'delivery_to', 'status',
      'delivered_at', 'read_at', 'expires_at', 'created_at', 'job_id',
      'run_id', 'owner', 'team_id', 'member_id', 'task_id',
      'ack_required', 'ack_at', 'delivery_attempts', 'last_error',
      'team_mapped_at', 'idempotency_key',
    ])
    && hasColumns(approvalColumns, [
      'job_id', 'run_id', 'dispatch_queue_id', 'status', 'requested_at',
      'resolved_at', 'resolved_by', 'notes', 'decision_version',
      'cancelled_reason', 'expires_at', 'approved_at', 'rejected_at',
      'dispatched_at', 'risk_level', 'approver_scope', 'binding_hash',
      'gate_kind', 'decision_context', 'handoff_artifact_digest',
      'source_run_id', 'source_run_handoff_artifact_digest',
    ])
    && hasColumns(queueColumns, [
      'claim_owner', 'claim_token', 'claim_expires_at', 'attempt_count',
      'last_error', 'replay_of_run_id', 'binding_scheduled_for',
      'handoff_artifact_digest', 'source_run_handoff_artifact_digest',
    ])
    && hasColumns(outboxColumns, [
      'delivery_group_id', 'part_index', 'part_count',
      'completion_label', 'completion_scope',
    ])
    && hasColumns(trackerColumns, [
      'name', 'created_at', 'created_by', 'expected_agents', 'timeout_s',
      'status', 'completed_at', 'delivery_channel', 'delivery_to', 'summary',
    ])
    && hasColumns(trackerAgentColumns, [
      'tracker_id', 'agent_label', 'status', 'started_at', 'finished_at',
      'exit_message', 'error', 'session_key', 'last_heartbeat',
    ]);
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
  const legacyMissingDeliveryOptOutCount = (
    jobColumns.has('parent_id')
    && jobColumns.has('payload_kind')
    && jobColumns.has('delivery_mode')
    && jobColumns.has('delivery_opt_out_reason')
  )
    ? (db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM jobs
        WHERE parent_id IS NULL
          AND payload_kind = 'agentTurn'
          AND delivery_mode = 'none'
          AND (delivery_opt_out_reason IS NULL OR trim(delivery_opt_out_reason) = '')
      `).get()?.cnt ?? 0)
    : 0;
  const unsupportedDeliveryModeCount = jobColumns.has('delivery_mode')
    ? (db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM jobs
        WHERE delivery_mode IS NOT NULL
          AND trim(delivery_mode) != ''
          AND delivery_mode NOT IN ('announce', 'announce-always', 'none')
      `).get()?.cnt ?? 0)
    : 0;
  const schemaNoOpTables = [
    'agents', 'approvals', 'completion_debts', 'delivery_aliases',
    'delivery_attachments', 'delivery_outbox', 'dispatcher_leases',
    'evidence_records', 'idempotency_ledger', 'job_dispatch_queue', 'jobs',
    'message_receipts', 'messages', 'runs', 'schema_migrations',
    'task_tracker', 'task_tracker_agents', 'team_mailbox_events', 'team_tasks',
    'handoff_artifacts', 'runtime_events', 'proof_replay_ledger',
    'proof_revocations', 'provider_sessions', 'credential_presentations',
  ];
  const schemaNoOpIndexes = [
    'idx_approvals_dispatch_queue', 'idx_approvals_job', 'idx_approvals_status',
    'idx_completion_debts_scope', 'idx_completion_debts_session',
    'idx_completion_debts_status', 'idx_completion_debts_task',
    'idx_delivery_attachments_message', 'idx_delivery_outbox_claim_expiry',
    'idx_delivery_outbox_completion', 'idx_delivery_outbox_due',
    'idx_delivery_outbox_group_part', 'idx_delivery_outbox_group_status',
    'idx_delivery_outbox_idempotency', 'idx_dispatch_queue_claim_expiry',
    'idx_dispatch_queue_due', 'idx_dispatch_queue_job',
    'idx_dispatch_queue_source_run', 'idx_dispatcher_leases_expiry',
    'idx_evidence_records_created_run', 'idx_evidence_records_hash',
    'idx_evidence_records_job', 'idx_idem_expires', 'idx_idem_job',
    'idx_jobs_next_run', 'idx_jobs_parent', 'idx_messages_ack_pending',
    'idx_messages_created', 'idx_messages_from', 'idx_messages_idempotency',
    'idx_messages_pending', 'idx_messages_task', 'idx_messages_team',
    'idx_messages_to', 'idx_receipts_message', 'idx_runs_cancel_requested',
    'idx_runs_dispatch_queue', 'idx_runs_dispatcher_owner',
    'idx_runs_idempotency', 'idx_runs_job_id', 'idx_runs_status',
    'idx_task_tracker_status', 'idx_team_events_task', 'idx_team_events_team',
    'idx_team_tasks_gate', 'idx_team_tasks_status', 'idx_tta_session_key',
    'idx_tta_status', 'idx_tta_tracker',
    'idx_handoff_artifacts_job', 'idx_handoff_artifacts_manifest',
    'idx_runtime_events_run', 'idx_runtime_events_artifact',
    'idx_runtime_events_type', 'idx_proof_replay_expires',
    'idx_proof_revocations_lookup', 'idx_provider_sessions_status', 'idx_credential_presentations_run',
    'idx_credential_presentations_status',
  ];
  const schemaNoOpTriggers = [
    'trg_handoff_artifacts_no_update', 'trg_handoff_artifacts_no_delete',
    'trg_runtime_events_no_update', 'trg_runtime_events_no_delete',
    'trg_v4_jobs_no_downgrade', 'trg_v4_runs_binding_immutable', 'trg_v4_approvals_binding_immutable', 'trg_v4_dispatches_binding_immutable', 'trg_v4_evidence_no_update', 'trg_v4_evidence_no_delete', 'trg_proof_revocations_no_update', 'trg_proof_revocations_no_delete',
  ];
  const migrationRequiredTables = [
    'approvals', 'completion_debts', 'delivery_aliases',
    'delivery_attachments', 'delivery_outbox', 'dispatcher_leases',
    'evidence_records', 'job_dispatch_queue', 'handoff_artifacts',
    'runtime_events', 'proof_replay_ledger', 'proof_revocations',
    'provider_sessions', 'credential_presentations',
  ];
  const migrationRequiredIndexes = [
    'idx_approvals_dispatch_queue', 'idx_completion_debts_scope',
    'idx_completion_debts_task', 'idx_delivery_attachments_message',
    'idx_delivery_outbox_claim_expiry', 'idx_delivery_outbox_completion',
    'idx_delivery_outbox_due', 'idx_delivery_outbox_group_part',
    'idx_delivery_outbox_group_status', 'idx_delivery_outbox_idempotency',
    'idx_dispatch_queue_claim_expiry', 'idx_dispatch_queue_due',
    'idx_dispatch_queue_job', 'idx_dispatch_queue_source_run',
    'idx_dispatcher_leases_expiry', 'idx_evidence_records_created_run',
    'idx_evidence_records_hash', 'idx_evidence_records_job',
    'idx_handoff_artifacts_job', 'idx_handoff_artifacts_manifest',
    'idx_runtime_events_run', 'idx_runtime_events_artifact',
    'idx_runtime_events_type', 'idx_proof_replay_expires',
    'idx_proof_revocations_lookup', 'idx_provider_sessions_status', 'idx_credential_presentations_run',
    'idx_credential_presentations_status',
  ];
  const criticalUniqueIndexes = [
    {
      name: 'idx_completion_debts_scope',
      table: 'completion_debts',
      columns: ['task_label', 'delivery_scope'],
      where: null,
    },
    {
      name: 'idx_messages_idempotency',
      table: 'messages',
      columns: ['idempotency_key'],
      where: 'idempotency_key is not null',
    },
    {
      name: 'idx_runs_idempotency',
      table: 'runs',
      columns: ['idempotency_key'],
      where: 'idempotency_key is not null',
    },
    {
      name: 'idx_delivery_outbox_idempotency',
      table: 'delivery_outbox',
      columns: ['idempotency_key'],
      where: 'idempotency_key is not null',
    },
    {
      name: 'idx_delivery_outbox_group_part',
      table: 'delivery_outbox',
      columns: ['delivery_group_id', 'part_index'],
      where: 'delivery_group_id is not null',
    },
  ];
  const normalizeSql = value => String(value || '')
    .toLowerCase()
    .replaceAll(/["'`[\]]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const criticalIndexMatches = (spec) => {
    if (!hasIndex(spec.name)) return false;
    const listed = db.prepare(`PRAGMA index_list(${spec.table})`).all()
      .find(index => index.name === spec.name);
    if (!listed || listed.unique !== 1) return false;
    const columns = db.prepare(`PRAGMA index_info(${spec.name})`).all()
      .sort((left, right) => left.seqno - right.seqno)
      .map(column => column.name);
    if (JSON.stringify(columns) !== JSON.stringify(spec.columns)) return false;
    const sql = normalizeSql(
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(spec.name)?.sql,
    );
    const where = sql.includes(' where ') ? sql.slice(sql.indexOf(' where ') + 7) : null;
    return where === spec.where;
  };
  const recordedVersionCount = hasTable('schema_migrations')
    ? db.prepare(`
        SELECT COUNT(DISTINCT version) AS count
        FROM schema_migrations
        WHERE version BETWEEN 1 AND 29
      `).get().count
    : 0;
  if (
    current >= 29
    && recordedVersionCount === 29
    && hasLatestColumns
    && queueBindingIsNotNull
    && hasTable('completion_debts')
    && hasTable('dispatcher_leases')
    && hasTable('delivery_outbox')
    && hasTable('delivery_attachments')
    && hasTable('evidence_records')
    && hasColumns(evidenceColumns, [
      'retention_policy', 'retention_until', 'handoff_artifact_digest',
      'source_run_id', 'source_run_handoff_artifact_digest',
      'evidence_method', 'evidence_verified', 'evidence_envelope',
    ])
    && !evidenceHasForeignKeys
    && hasColumns(completionDebtColumns, ['id', 'task_label', 'delivery_scope'])
    && !completionDebtHasTableUnique
    && schemaNoOpTables.every(hasTable)
    && schemaNoOpIndexes.every(hasIndex)
    && schemaNoOpTriggers.every(hasTrigger)
    && criticalUniqueIndexes.every(criticalIndexMatches)
    && legacyAtIsoCount === 0
    && legacyPayloadMismatchCount === 0
    && legacyMissingDeliveryOptOutCount === 0
    && unsupportedDeliveryModeCount === 0
  ) {
    return false;
  }

  // -- Column additions (all idempotent -- column already exists = silent ignore) -

  const alters = [
    // Legacy partial-table backfills for jobs
    `ALTER TABLE jobs ADD COLUMN agent_id TEXT DEFAULT 'main'`,
    `ALTER TABLE jobs ADD COLUMN payload_model TEXT`,
    `ALTER TABLE jobs ADD COLUMN payload_thinking TEXT`,
    `ALTER TABLE jobs ADD COLUMN payload_timeout_seconds INTEGER DEFAULT 120`,
    `ALTER TABLE jobs ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip'`,
    `ALTER TABLE jobs ADD COLUMN delivery_channel TEXT`,
    `ALTER TABLE jobs ADD COLUMN delivery_to TEXT`,
    `ALTER TABLE jobs ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE jobs ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE jobs ADD COLUMN delete_after_run INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE jobs ADD COLUMN next_run_at TEXT`,
    `ALTER TABLE jobs ADD COLUMN last_run_at TEXT`,
    `ALTER TABLE jobs ADD COLUMN last_status TEXT`,
    `ALTER TABLE jobs ADD COLUMN consecutive_errors INTEGER NOT NULL DEFAULT 0`,
    // Legacy partial-table backfills for messages
    `ALTER TABLE messages ADD COLUMN to_agent TEXT`,
    `ALTER TABLE messages ADD COLUMN from_agent TEXT`,
    `ALTER TABLE messages ADD COLUMN reply_to TEXT`,
    `ALTER TABLE messages ADD COLUMN kind TEXT`,
    `ALTER TABLE messages ADD COLUMN subject TEXT`,
    `ALTER TABLE messages ADD COLUMN body TEXT`,
    `ALTER TABLE messages ADD COLUMN metadata TEXT`,
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
    `ALTER TABLE runs ADD COLUMN finished_at TEXT`,
    `ALTER TABLE runs ADD COLUMN duration_ms INTEGER`,
    `ALTER TABLE runs ADD COLUMN last_heartbeat TEXT DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE runs ADD COLUMN session_key TEXT`,
    `ALTER TABLE runs ADD COLUMN session_id TEXT`,
    `ALTER TABLE runs ADD COLUMN summary TEXT`,
    `ALTER TABLE runs ADD COLUMN error_message TEXT`,
    `ALTER TABLE runs ADD COLUMN dispatched_at TEXT`,
    `ALTER TABLE runs ADD COLUMN run_timeout_ms INTEGER NOT NULL DEFAULT 300000`,
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
    `ALTER TABLE messages ADD COLUMN idempotency_key TEXT`,
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
    `ALTER TABLE jobs ADD COLUMN output_excerpt_limit_bytes INTEGER NOT NULL DEFAULT 65536`,
    `ALTER TABLE jobs ADD COLUMN output_summary_limit_bytes INTEGER NOT NULL DEFAULT 65536`,
    `ALTER TABLE jobs ADD COLUMN output_offload_threshold_bytes INTEGER NOT NULL DEFAULT 65536`,
    `ALTER TABLE jobs ADD COLUMN shell_env_policy TEXT NOT NULL DEFAULT 'inherit'`,
    `ALTER TABLE runs ADD COLUMN shell_stdout_path TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stderr_path TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stdout_bytes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN shell_stderr_bytes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN shell_stdout_sha256 TEXT`,
    `ALTER TABLE runs ADD COLUMN shell_stderr_sha256 TEXT`,
    // v27: dispatcher ownership, cancellation, and child-process tracking
    `ALTER TABLE runs ADD COLUMN dispatcher_owner TEXT`,
    `ALTER TABLE runs ADD COLUMN dispatcher_token INTEGER`,
    `ALTER TABLE runs ADD COLUMN dispatch_started_at TEXT`,
    `ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT`,
    `ALTER TABLE runs ADD COLUMN cancel_requested_by TEXT`,
    `ALTER TABLE runs ADD COLUMN cancel_reason TEXT`,
    `ALTER TABLE runs ADD COLUMN process_pid INTEGER`,
    `ALTER TABLE runs ADD COLUMN process_pgid INTEGER`,
    `ALTER TABLE runs ADD COLUMN process_identity TEXT`,
    `ALTER TABLE runs ADD COLUMN process_started_at TEXT`,
    `ALTER TABLE runs ADD COLUMN process_terminated_at TEXT`,
    `ALTER TABLE runs ADD COLUMN agent_cancel_requested_at TEXT`,
    `ALTER TABLE runs ADD COLUMN terminal_transition_at TEXT`,
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
    // v22: v0.2 identity
    `ALTER TABLE jobs ADD COLUMN identity_principal TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_run_as TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_attestation TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_ref TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_subject_kind TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_subject_principal TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_trust_level TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity_delegation_mode TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN identity TEXT DEFAULT NULL`,
    // v22: v0.2 authorization proof
    `ALTER TABLE jobs ADD COLUMN authorization_proof_ref TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN authorization_proof TEXT DEFAULT NULL`,
    // v22: v0.2 authorization
    `ALTER TABLE jobs ADD COLUMN authorization_ref TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN authorization TEXT DEFAULT NULL`,
    // v22: v0.2 evidence
    `ALTER TABLE jobs ADD COLUMN evidence_ref TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN evidence TEXT DEFAULT NULL`,
    // v22: v0.2 contract
    `ALTER TABLE jobs ADD COLUMN contract_required_trust_level TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_trust_enforcement TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_sandbox TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_allowed_paths TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_network TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_max_cost_usd REAL DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN contract_audit TEXT DEFAULT NULL`,
    // v22: v0.2 outcomes (runs table)
    `ALTER TABLE runs ADD COLUMN identity_resolved TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN trust_evaluation TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN authorization_decision TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN authorization_proof_verification TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN evidence_record TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN credential_handoff_summary TEXT DEFAULT NULL`,
    // v23: child credential policy
    `ALTER TABLE jobs ADD COLUMN child_credential_policy TEXT DEFAULT NULL`,
    // v24: explicit fallback model/auth selection
    `ALTER TABLE jobs ADD COLUMN payload_model_fallback TEXT`,
    `ALTER TABLE jobs ADD COLUMN auth_profile_fallback TEXT DEFAULT NULL`,
    // v28: agentcli handoff v3 governance and structured-output contract
    `ALTER TABLE jobs ADD COLUMN approval_risk_level TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN approval_approver_scope TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN output_format TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN verify_shell TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN verify_timeout_s INTEGER DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN verify_on_failure TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN delegation_validation TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN output_format TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output_valid INTEGER DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output_warning TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output_bytes INTEGER DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output_sha256 TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN structured_output_path TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN verification_result TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN approval_used TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN evidence_required INTEGER NOT NULL DEFAULT 0 CHECK (evidence_required IN (0,1))`,
    `ALTER TABLE runs ADD COLUMN evidence_execution_snapshot TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN evidence_declaration_snapshot TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN evidence_ref_snapshot TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN risk_level TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN approver_scope TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN binding_hash TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN gate_kind TEXT NOT NULL DEFAULT 'job'`,
    `ALTER TABLE approvals ADD COLUMN decision_context TEXT DEFAULT NULL`,
    `ALTER TABLE delivery_outbox ADD COLUMN delivery_group_id TEXT DEFAULT NULL`,
    `ALTER TABLE delivery_outbox ADD COLUMN part_index INTEGER DEFAULT NULL`,
    `ALTER TABLE delivery_outbox ADD COLUMN part_count INTEGER DEFAULT NULL`,
    `ALTER TABLE delivery_outbox ADD COLUMN completion_label TEXT DEFAULT NULL`,
    `ALTER TABLE delivery_outbox ADD COLUMN completion_scope TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN retention_policy TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN retention_until TEXT DEFAULT NULL`,
    // v27: leased queue claims and replay diagnostics
    `ALTER TABLE job_dispatch_queue ADD COLUMN claim_owner TEXT`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN claim_token TEXT`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN claim_expires_at TEXT`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN last_error TEXT`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN replay_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN binding_scheduled_for TEXT`,
    // v27: atomic approval decisions and audit timestamps
    `ALTER TABLE approvals ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE approvals ADD COLUMN cancelled_reason TEXT`,
    `ALTER TABLE approvals ADD COLUMN expires_at TEXT`,
    `ALTER TABLE approvals ADD COLUMN approved_at TEXT`,
    `ALTER TABLE approvals ADD COLUMN rejected_at TEXT`,
    `ALTER TABLE approvals ADD COLUMN dispatched_at TEXT`,
    // v29: agentcli handoff v4 artifact and execution bindings
    `ALTER TABLE jobs ADD COLUMN handoff_version INTEGER DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN effective_task_hash TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN runtime_instance_id TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN source_run_id TEXT DEFAULT NULL`,
    `ALTER TABLE runs ADD COLUMN source_run_handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN source_run_id TEXT DEFAULT NULL`,
    `ALTER TABLE approvals ADD COLUMN source_run_handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE job_dispatch_queue ADD COLUMN source_run_handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN source_run_id TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN source_run_handoff_artifact_digest TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN evidence_method TEXT DEFAULT NULL`,
    `ALTER TABLE evidence_records ADD COLUMN evidence_verified INTEGER DEFAULT NULL CHECK (evidence_verified IN (0,1))`,
    `ALTER TABLE evidence_records ADD COLUMN evidence_envelope TEXT DEFAULT NULL`,
  ];

  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('duplicate column name') || msg.includes('no such table')) continue;
      throw err;
    }
  }

  // SQLite cannot strengthen a column to NOT NULL with ALTER TABLE. Rebuild
  // the queue while foreign-key enforcement is temporarily disabled so child
  // approval/run links are preserved rather than receiving ON DELETE effects.
  const queueNeedsBindingConstraint = hasTable('job_dispatch_queue')
    && !columnInfoFor('job_dispatch_queue')
      .some((column) => column.name === 'binding_scheduled_for' && column.notnull === 1);
  if (queueNeedsBindingConstraint) {
    const foreignKeysWereEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      if (db.pragma('foreign_keys', { simple: true }) !== 0) {
        throw new Error('Migration v28 queue rebuild could not disable foreign key enforcement');
      }
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS job_dispatch_queue_v28;
          CREATE TABLE job_dispatch_queue_v28 (
            id              TEXT PRIMARY KEY,
            job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            dispatch_kind   TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending',
            scheduled_for   TEXT NOT NULL,
            binding_scheduled_for TEXT NOT NULL,
            source_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
            retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            claimed_at      TEXT,
            processed_at    TEXT,
            claim_owner     TEXT,
            claim_token     TEXT,
            claim_expires_at TEXT,
            attempt_count   INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            replay_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
            handoff_artifact_digest TEXT,
            source_run_handoff_artifact_digest TEXT
          );
          INSERT INTO job_dispatch_queue_v28 (
            id, job_id, dispatch_kind, status, scheduled_for,
            binding_scheduled_for, source_run_id, retry_of_run_id, created_at,
            claimed_at, processed_at, claim_owner, claim_token,
            claim_expires_at, attempt_count, last_error, replay_of_run_id,
            handoff_artifact_digest, source_run_handoff_artifact_digest
          )
          SELECT
            id, job_id, dispatch_kind, status, scheduled_for,
            COALESCE(binding_scheduled_for, scheduled_for), source_run_id,
            retry_of_run_id, created_at, claimed_at, processed_at, claim_owner,
            claim_token, claim_expires_at, attempt_count, last_error,
            replay_of_run_id, handoff_artifact_digest,
            source_run_handoff_artifact_digest
          FROM job_dispatch_queue;
          DROP TABLE job_dispatch_queue;
          ALTER TABLE job_dispatch_queue_v28 RENAME TO job_dispatch_queue;
        `);
        const violations = db.pragma('foreign_key_check');
        if (violations.length > 0) {
          throw new Error(`Migration v28 queue rebuild violated ${violations.length} foreign key constraint(s)`);
        }
      })();
    } finally {
      db.pragma(`foreign_keys = ${foreignKeysWereEnabled ? 'ON' : 'OFF'}`);
    }
  }

  // Wrap all backfill statements, table creation, index creation, and version
  // inserts in a single transaction so that partial backfill cannot occur.
  // ALTER TABLE stays outside because some SQLite builds reject DDL in transactions.
  db.transaction(() => {

  // v29: immutable handoff artifacts, ordered runtime events, proof replay,
  // provider sessions, and credential presentation recovery state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_artifacts (
      digest TEXT PRIMARY KEY,
      artifact_schema_version INTEGER NOT NULL CHECK (artifact_schema_version = 1),
      handoff_version INTEGER NOT NULL CHECK (handoff_version = 4),
      scheduler_schema_min INTEGER NOT NULL,
      canonicalization TEXT NOT NULL CHECK (canonicalization = 'json-sort-v1'),
      canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version = 1),
      execution_binding_version INTEGER NOT NULL,
      manifest_digest TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      effective_task_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_artifacts_job
      ON handoff_artifacts(job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_handoff_artifacts_manifest
      ON handoff_artifacts(manifest_digest, workflow_id, task_id);
    CREATE TRIGGER IF NOT EXISTS trg_handoff_artifacts_no_update
    BEFORE UPDATE ON handoff_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'handoff artifacts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_handoff_artifacts_no_delete
    BEFORE DELETE ON handoff_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'handoff artifacts are immutable');
    END;

    CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      job_id TEXT,
      dispatch_queue_id TEXT,
      run_id TEXT,
      approval_id TEXT,
      handoff_artifact_digest TEXT,
      source_run_id TEXT,
      source_run_handoff_artifact_digest TEXT,
      payload TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_events_run ON runtime_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_runtime_events_artifact
      ON runtime_events(handoff_artifact_digest, id);
    CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(event_type, id);
    CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_update
    BEFORE UPDATE ON runtime_events
    BEGIN
      SELECT RAISE(ABORT, 'runtime events are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runtime_events_no_delete
    BEFORE DELETE ON runtime_events
    BEGIN
      SELECT RAISE(ABORT, 'runtime events are immutable');
    END;

    CREATE TABLE IF NOT EXISTS proof_replay_ledger (
      replay_key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      issuer TEXT,
      subject TEXT,
      proof_id TEXT NOT NULL,
      handoff_artifact_digest TEXT NOT NULL,
      run_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_proof_replay_expires
      ON proof_replay_ledger(expires_at);

    CREATE TABLE IF NOT EXISTS proof_revocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      issuer TEXT,
      proof_id TEXT,
      key_id TEXT,
      reason TEXT,
      revoked_by TEXT,
      revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (proof_id IS NOT NULL OR key_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_proof_revocations_lookup
      ON proof_revocations(method, issuer, proof_id, key_id);

    CREATE TABLE IF NOT EXISTS provider_sessions (
      id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      cache_key_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','refreshing','expired','revoked','failed')),
      handoff_artifact_digest TEXT,
      subject_principal TEXT,
      scope TEXT,
      session_summary TEXT,
      expires_at TEXT,
      refresh_after TEXT,
      rotation_counter INTEGER NOT NULL DEFAULT 0,
      revocation_checked_at TEXT,
      transient_error_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_type, provider_name, cache_key_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_sessions_status
      ON provider_sessions(status, expires_at);

    CREATE TABLE IF NOT EXISTS credential_presentations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      handoff_artifact_digest TEXT NOT NULL,
      provider_session_id TEXT,
      binding_name TEXT NOT NULL,
      medium TEXT NOT NULL CHECK (medium IN ('env','temp-file','stdin','gateway-env-header')),
      env_key TEXT,
      temp_path TEXT,
      stdin_sha256 TEXT,
      value_sha256 TEXT NOT NULL,
      file_mode TEXT,
      status TEXT NOT NULL CHECK (status IN ('materialized','cleaned','recovery_cleaned','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      cleaned_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credential_presentations_run
      ON credential_presentations(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_credential_presentations_status
      ON credential_presentations(status, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_proof_revocations_no_update
    BEFORE UPDATE ON proof_revocations
    BEGIN SELECT RAISE(ABORT, 'proof revocations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_proof_revocations_no_delete
    BEFORE DELETE ON proof_revocations
    BEGIN SELECT RAISE(ABORT, 'proof revocations are immutable'); END;
  `);

  if (hasTable('job_dispatch_queue')) {
    db.prepare(`
      UPDATE job_dispatch_queue
      SET binding_scheduled_for = scheduled_for
      WHERE binding_scheduled_for IS NULL
    `).run();
  }

  // v28: completion claims are scoped to one concrete dispatch/run. The old
  // task_label primary key could not represent overlapping or re-dispatched
  // runs with the same human label, so rebuild the table with a surrogate key
  // and a composite uniqueness constraint.
  if (
    hasTable('completion_debts')
    && (!completionDebtColumns.has('id') || !completionDebtColumns.has('delivery_scope'))
  ) {
    db.exec(`
      DROP TABLE IF EXISTS completion_debts_v28;
      CREATE TABLE completion_debts_v28 (
        id                      TEXT PRIMARY KEY,
        task_label              TEXT NOT NULL,
        delivery_scope          TEXT NOT NULL,
        session_key             TEXT,
        source                  TEXT NOT NULL DEFAULT 'dispatch',
        status                  TEXT NOT NULL DEFAULT 'tracking',
        open_reason             TEXT,
        close_reason            TEXT,
        opened_at               TEXT,
        closed_at               TEXT,
        last_checkin_at         TEXT,
        last_progress_at        TEXT,
        last_visible_update_at  TEXT,
        final_reported_at       TEXT,
        last_reminder_at        TEXT,
        reminder_count          INTEGER NOT NULL DEFAULT 0,
        awaiting_user           INTEGER NOT NULL DEFAULT 0,
        no_reply                INTEGER NOT NULL DEFAULT 0,
        metadata                TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO completion_debts_v28 (
        id, task_label, delivery_scope, session_key, source, status,
        open_reason, close_reason, opened_at, closed_at, last_checkin_at,
        last_progress_at, last_visible_update_at, final_reported_at,
        last_reminder_at, reminder_count, awaiting_user, no_reply, metadata,
        created_at, updated_at
      )
      SELECT
        lower(hex(randomblob(16))),
        task_label,
        COALESCE(
          CASE
            WHEN json_valid(metadata)
            THEN NULLIF(json_extract(metadata, '$._completion_delivery.scope_key'), '')
          END,
          CASE
            WHEN session_key IS NOT NULL AND trim(session_key) != ''
            THEN 'session:' || session_key
          END,
          'legacy:' || task_label
        ),
        session_key, source, status, open_reason, close_reason, opened_at,
        closed_at, last_checkin_at, last_progress_at, last_visible_update_at,
        final_reported_at, last_reminder_at, reminder_count, awaiting_user,
        no_reply,
        CASE
          WHEN json_valid(metadata)
            AND NULLIF(json_extract(metadata, '$._completion_delivery.scope_key'), '') IS NOT NULL
          THEN metadata
          WHEN json_valid(metadata) AND json_type(metadata) = 'object'
          THEN json_set(metadata, '$._completion_delivery.migrated_legacy_unscoped', 1)
          ELSE json_object(
            '_completion_delivery',
            json_object('migrated_legacy_unscoped', 1)
          )
        END,
        created_at, updated_at
      FROM completion_debts;
      DROP TABLE completion_debts;
      ALTER TABLE completion_debts_v28 RENAME TO completion_debts;
    `);
  } else if (hasTable('completion_debts') && completionDebtHasTableUnique) {
    // Early v28 candidates declared both a table-level UNIQUE constraint and
    // the named unique index repaired below. Rebuild once so each write updates
    // only the named index while preserving every debt row verbatim.
    db.exec(`
      DROP TABLE IF EXISTS completion_debts_v28;
      CREATE TABLE completion_debts_v28 (
        id                      TEXT PRIMARY KEY,
        task_label              TEXT NOT NULL,
        delivery_scope          TEXT NOT NULL,
        session_key             TEXT,
        source                  TEXT NOT NULL DEFAULT 'dispatch',
        status                  TEXT NOT NULL DEFAULT 'tracking',
        open_reason             TEXT,
        close_reason            TEXT,
        opened_at               TEXT,
        closed_at               TEXT,
        last_checkin_at         TEXT,
        last_progress_at        TEXT,
        last_visible_update_at  TEXT,
        final_reported_at       TEXT,
        last_reminder_at        TEXT,
        reminder_count          INTEGER NOT NULL DEFAULT 0,
        awaiting_user           INTEGER NOT NULL DEFAULT 0,
        no_reply                INTEGER NOT NULL DEFAULT 0,
        metadata                TEXT,
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO completion_debts_v28 (
        id, task_label, delivery_scope, session_key, source, status,
        open_reason, close_reason, opened_at, closed_at, last_checkin_at,
        last_progress_at, last_visible_update_at, final_reported_at,
        last_reminder_at, reminder_count, awaiting_user, no_reply, metadata,
        created_at, updated_at
      )
      SELECT
        id, task_label, delivery_scope, session_key, source, status,
        open_reason, close_reason, opened_at, closed_at, last_checkin_at,
        last_progress_at, last_visible_update_at, final_reported_at,
        last_reminder_at, reminder_count, awaiting_user, no_reply, metadata,
        created_at, updated_at
      FROM completion_debts;
      DROP TABLE completion_debts;
      ALTER TABLE completion_debts_v28 RENAME TO completion_debts;
    `);
  }

  // Evidence is an audit artifact, not subordinate run/job history. Earlier
  // v28 prerelease schemas cascaded it away when runs were pruned or jobs were
  // deleted, so rebuild without foreign keys while preserving identifiers.
  if (evidenceHasForeignKeys) {
    db.exec(`
      DROP TABLE IF EXISTS evidence_records_v28;
      CREATE TABLE evidence_records_v28 (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL UNIQUE,
        job_id          TEXT NOT NULL,
        evidence_ref    TEXT,
        algorithm       TEXT NOT NULL DEFAULT 'sha256',
        hash            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        retention_policy TEXT,
        retention_until TEXT,
        handoff_artifact_digest TEXT,
        source_run_id TEXT,
        source_run_handoff_artifact_digest TEXT,
        evidence_method TEXT,
        evidence_verified INTEGER DEFAULT NULL CHECK (evidence_verified IN (0,1)),
        evidence_envelope TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(algorithm, hash, run_id)
      );
      INSERT INTO evidence_records_v28 (
        id, run_id, job_id, evidence_ref, algorithm, hash, payload,
        retention_policy, retention_until, handoff_artifact_digest,
        source_run_id, source_run_handoff_artifact_digest, evidence_method,
        evidence_verified, evidence_envelope, created_at
      )
      SELECT
        id, run_id, job_id, evidence_ref, algorithm, hash, payload,
        retention_policy, retention_until, handoff_artifact_digest,
        source_run_id, source_run_handoff_artifact_digest, evidence_method,
        evidence_verified, evidence_envelope, created_at
      FROM evidence_records;
      DROP TABLE evidence_records;
      ALTER TABLE evidence_records_v28 RENAME TO evidence_records;
    `);
  }

  // Legacy active approvals have no immutable execution binding. Require a
  // fresh decision under v0.4 rather than allowing an unbound approval to run.
  const unboundApprovals = hasTable('approvals')
    ? db.prepare(`
        SELECT id, run_id, dispatch_queue_id
        FROM approvals
        WHERE status IN ('pending', 'approved', 'dispatching')
          AND (binding_hash IS NULL OR trim(binding_hash) = '')
      `).all()
    : [];
  const unboundReason = 'Approval cancelled during schema 28 upgrade because it predates immutable execution binding';
  for (const approval of unboundApprovals) {
    db.prepare(`
      UPDATE approvals
      SET status = 'cancelled', resolved_at = datetime('now'),
          resolved_by = 'migration-v28', cancelled_reason = ?,
          notes = COALESCE(notes, ?), decision_version = decision_version + 1
      WHERE id = ? AND status IN ('pending', 'approved', 'dispatching')
    `).run(unboundReason, unboundReason, approval.id);
    if (approval.run_id) {
      db.prepare(`
        UPDATE runs
        SET status = 'cancelled', finished_at = datetime('now'),
            error_message = COALESCE(error_message, ?),
            terminal_transition_at = COALESCE(terminal_transition_at, datetime('now'))
        WHERE id = ? AND status IN ('pending', 'awaiting_approval', 'approved', 'running')
      `).run(unboundReason, approval.run_id);
    }
    if (approval.dispatch_queue_id) {
      db.prepare(`
        UPDATE job_dispatch_queue
        SET status = 'cancelled', processed_at = datetime('now'), last_error = ?,
            claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE id = ? AND status IN ('pending', 'claimed', 'awaiting_approval')
      `).run(unboundReason, approval.dispatch_queue_id);
    }
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

  // Backfill modern message body from the old content column when present.
  try {
    db.exec(`
      UPDATE messages
      SET body = COALESCE(body, content)
      WHERE content IS NOT NULL
        AND (body IS NULL OR trim(body) = '');
    `);
  } catch {
    /* best-effort normalization for legacy rows */
  }

  // Backfill root scheduling state for legacy jobs that gained next_run_at late.
  try {
    const rowsNeedingNextRun = db.prepare(`
      SELECT id, schedule_kind, schedule_at, schedule_cron, schedule_tz, parent_id
      FROM jobs
      WHERE next_run_at IS NULL
    `).all();
    const updateNextRun = db.prepare('UPDATE jobs SET next_run_at = ? WHERE id = ?');
    for (const row of rowsNeedingNextRun) {
      let nextRun = null;
      if (!row.parent_id) {
        if (row.schedule_kind === 'at') {
          nextRun = row.schedule_at || null;
        } else if (row.schedule_cron) {
          try {
            nextRun = nextRunFromCron(row.schedule_cron, row.schedule_tz || 'UTC');
          } catch {
            nextRun = null;
          }
        }
      }
      if (nextRun !== null) {
        updateNextRun.run(nextRun, row.id);
      }
    }
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

      UPDATE jobs
      SET delivery_mode = 'announce-always'
      WHERE delivery_mode = 'announce-on-output';
    `);
  } catch {
    /* best-effort normalization for legacy rows */
  }

  const unsupportedDeliveryModes = db.prepare(`
    SELECT id, delivery_mode
    FROM jobs
    WHERE delivery_mode IS NOT NULL
      AND trim(delivery_mode) != ''
      AND delivery_mode NOT IN ('announce', 'announce-always', 'none')
    ORDER BY id
    LIMIT 10
  `).all();
  if (unsupportedDeliveryModes.length > 0) {
    const modes = [...new Set(unsupportedDeliveryModes.map(row => row.delivery_mode))];
    const error = new Error(`Unsupported persisted delivery mode(s): ${modes.join(', ')}`);
    error.code = 'SCHEMA_LEGACY_DELIVERY_MODE_UNSUPPORTED';
    throw error;
  }

  // -- Tables that may be absent on very old installs ---------------------

  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_aliases (
      alias       TEXT PRIMARY KEY,
      channel     TEXT NOT NULL,
      target      TEXT NOT NULL,
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
      dispatch_queue_id TEXT REFERENCES job_dispatch_queue(id) ON DELETE SET NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      resolved_by     TEXT,
      notes           TEXT,
      decision_version INTEGER NOT NULL DEFAULT 0,
      cancelled_reason TEXT,
      expires_at      TEXT,
      approved_at     TEXT,
      rejected_at     TEXT,
      dispatched_at   TEXT,
      risk_level      TEXT,
      approver_scope  TEXT,
      binding_hash    TEXT,
      gate_kind       TEXT NOT NULL DEFAULT 'job',
      decision_context TEXT,
      handoff_artifact_digest TEXT,
      source_run_id TEXT,
      source_run_handoff_artifact_digest TEXT
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
      binding_scheduled_for TEXT NOT NULL,
      source_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL,
      retry_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at      TEXT,
      processed_at    TEXT,
      claim_owner     TEXT,
      claim_token     TEXT,
      claim_expires_at TEXT,
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      replay_of_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      handoff_artifact_digest TEXT,
      source_run_handoff_artifact_digest TEXT
    );

    CREATE TABLE IF NOT EXISTS dispatcher_leases (
      name            TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL,
      fencing_token   INTEGER NOT NULL,
      acquired_at     TEXT NOT NULL,
      renewed_at      TEXT NOT NULL,
      expires_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id              TEXT PRIMARY KEY,
      message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
      job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
      channel         TEXT NOT NULL,
      target          TEXT NOT NULL,
      body            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      idempotency_key TEXT,
      delivery_group_id TEXT,
      part_index      INTEGER,
      part_count      INTEGER,
      completion_label TEXT,
      completion_scope TEXT,
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      claim_owner     TEXT,
      claim_token     TEXT,
      claim_expires_at TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS delivery_attachments (
      id              TEXT PRIMARY KEY,
      outbox_id       TEXT NOT NULL REFERENCES delivery_outbox(id) ON DELETE CASCADE,
      message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
      ordinal         INTEGER NOT NULL,
      name            TEXT NOT NULL,
      mime_type       TEXT,
      source_path     TEXT,
      content_blob    BLOB,
      size_bytes      INTEGER NOT NULL,
      sha256          TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(outbox_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS evidence_records (
      id              TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL UNIQUE,
      job_id          TEXT NOT NULL,
      evidence_ref    TEXT,
      algorithm       TEXT NOT NULL DEFAULT 'sha256',
      hash            TEXT NOT NULL,
      payload         TEXT NOT NULL,
      retention_policy TEXT,
      retention_until TEXT,
      handoff_artifact_digest TEXT,
      source_run_id TEXT,
      source_run_handoff_artifact_digest TEXT,
      evidence_method TEXT,
      evidence_verified INTEGER DEFAULT NULL CHECK (evidence_verified IN (0,1)),
      evidence_envelope TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(algorithm, hash, run_id)
    );

    CREATE TABLE IF NOT EXISTS completion_debts (
      id                      TEXT PRIMARY KEY,
      task_label              TEXT NOT NULL,
      delivery_scope          TEXT NOT NULL,
      session_key             TEXT,
      source                  TEXT NOT NULL DEFAULT 'dispatch',
      status                  TEXT NOT NULL DEFAULT 'tracking',
      open_reason             TEXT,
      close_reason            TEXT,
      opened_at               TEXT,
      closed_at               TEXT,
      last_checkin_at         TEXT,
      last_progress_at        TEXT,
      last_visible_update_at  TEXT,
      final_reported_at       TEXT,
      last_reminder_at        TEXT,
      reminder_count          INTEGER NOT NULL DEFAULT 0,
      awaiting_user           INTEGER NOT NULL DEFAULT 0,
      no_reply                INTEGER NOT NULL DEFAULT 0,
      metadata                TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_v4_jobs_no_downgrade
    BEFORE UPDATE ON jobs
    WHEN OLD.handoff_version = 4 AND (
      NEW.handoff_version IS NOT 4 OR
      NEW.handoff_artifact_digest IS NULL OR
      NEW.effective_task_hash IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'handoff v4 job bindings cannot be downgraded or cleared'); END;
    CREATE TRIGGER IF NOT EXISTS trg_v4_runs_binding_immutable
        BEFORE UPDATE ON runs
        WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
          NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
          NEW.runtime_instance_id IS NOT OLD.runtime_instance_id OR
          NEW.source_run_id IS NOT OLD.source_run_id OR
          NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
        )
        BEGIN SELECT RAISE(ABORT, 'handoff v4 run bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_v4_approvals_binding_immutable
        BEFORE UPDATE ON approvals
        WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
          NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
          NEW.source_run_id IS NOT OLD.source_run_id OR
          NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
        )
        BEGIN SELECT RAISE(ABORT, 'handoff v4 approval bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_v4_dispatches_binding_immutable
        BEFORE UPDATE ON job_dispatch_queue
        WHEN OLD.handoff_artifact_digest IS NOT NULL AND (
          NEW.handoff_artifact_digest IS NOT OLD.handoff_artifact_digest OR
          NEW.source_run_id IS NOT OLD.source_run_id OR
          NEW.source_run_handoff_artifact_digest IS NOT OLD.source_run_handoff_artifact_digest
        )
        BEGIN SELECT RAISE(ABORT, 'handoff v4 dispatch bindings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_v4_evidence_no_update
        BEFORE UPDATE ON evidence_records
        WHEN OLD.handoff_artifact_digest IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'handoff v4 evidence is immutable'); END;
        DROP TRIGGER IF EXISTS trg_v4_evidence_no_delete;
        CREATE TRIGGER trg_v4_evidence_no_delete
        BEFORE DELETE ON evidence_records
        WHEN OLD.handoff_artifact_digest IS NOT NULL AND NOT (
          OLD.retention_until IS NOT NULL
          AND julianday(OLD.retention_until) <= julianday('now')
        )
        BEGIN SELECT RAISE(ABORT, 'handoff v4 evidence is immutable'); END;
  `);

  // -- Indexes that may be absent ----------------------------------------

  for (const spec of criticalUniqueIndexes) {
    if (hasIndex(spec.name) && !criticalIndexMatches(spec)) {
      db.exec(`DROP INDEX ${spec.name}`);
    }
  }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_next_run
      ON jobs(next_run_at) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_jobs_parent
      ON jobs(parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_job_id
      ON runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS idx_messages_to
      ON messages(to_agent, status);
      CREATE INDEX IF NOT EXISTS idx_messages_from
      ON messages(from_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_created
      ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_pending
      ON messages(to_agent, status, priority DESC) WHERE status = 'pending';
    `);
  } catch { /* base table may be irreparably incomplete; final checks fail closed */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_completion_debts_status
      ON completion_debts(status, updated_at)
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_completion_debts_session
      ON completion_debts(session_key) WHERE session_key IS NOT NULL
    `);
  } catch { /* index may already exist */ }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_completion_debts_task
      ON completion_debts(task_label, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_debts_scope
      ON completion_debts(task_label, delivery_scope);
      CREATE INDEX IF NOT EXISTS idx_evidence_records_job
      ON evidence_records(job_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evidence_records_hash
      ON evidence_records(algorithm, hash);
      CREATE INDEX IF NOT EXISTS idx_evidence_records_created_run
      ON evidence_records(created_at DESC, run_id DESC)
    `);
  } catch { /* indexes may already exist */ }

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
      ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL
    `);
  } catch { /* index may already exist */ }

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

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_queue_claim_expiry
      ON job_dispatch_queue(status, claim_expires_at) WHERE status = 'claimed';
      CREATE INDEX IF NOT EXISTS idx_runs_dispatcher_owner
      ON runs(dispatcher_owner, status) WHERE dispatcher_owner IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_cancel_requested
      ON runs(cancel_requested_at, status) WHERE cancel_requested_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_dispatcher_leases_expiry
      ON dispatcher_leases(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_idempotency
      ON delivery_outbox(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_due
      ON delivery_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_claim_expiry
      ON delivery_outbox(status, claim_expires_at) WHERE status = 'claimed';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_group_part
      ON delivery_outbox(delivery_group_id, part_index) WHERE delivery_group_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_group_status
      ON delivery_outbox(delivery_group_id, status, part_index) WHERE delivery_group_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_delivery_outbox_completion
      ON delivery_outbox(completion_label, completion_scope, status) WHERE completion_label IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_delivery_attachments_message
      ON delivery_attachments(message_id) WHERE message_id IS NOT NULL;
    `);
  } catch { /* indexes may already exist */ }

  // Fail closed if any required current-schema object was not created. Earlier releases
  // treated index creation as best effort; a missing uniqueness or due-work
  // index changes correctness, not just performance.
  for (const table of migrationRequiredTables) {
    if (!hasTable(table)) throw new Error(`Migration v29 failed to create required table ${table}`);
  }
  for (const index of migrationRequiredIndexes) {
    if (!hasIndex(index)) throw new Error(`Migration v29 failed to create required index ${index}`);
  }
  for (const spec of criticalUniqueIndexes) {
    if (hasTable(spec.table) && !criticalIndexMatches(spec)) {
      throw new Error(`Migration v29 failed to enforce required unique index ${spec.name}`);
    }
  }
  for (const trigger of schemaNoOpTriggers) {
    if (!hasTrigger(trigger)) {
      throw new Error(`Migration v29 failed to create required trigger ${trigger}`);
    }
  }

  // -- Record all versions -----------------------------------------------

  const stmt = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]) {
    stmt.run(v);
  }

  })(); // end backfill + version-insert transaction

  return true;
}

// Allow running as standalone script: node migrate-consolidate.js
if (process.argv[1] && process.argv[1].endsWith('migrate-consolidate.js')) {
  const applied = migrateConsolidate();
  if (applied) {
    applyBundledSchema('standalone schema apply');
    if (migrateConsolidate()) {
      throw new Error('Consolidation migration did not reach a complete schema no-op state');
    }
  }
  console.log(applied
    ? 'Consolidation migration applied -- DB is now at schema v29'
    : 'DB already at v29 -- nothing to do'
  );
}
