// Job CRUD operations
import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { getDb } from './db.js';

/**
 * Calculate next run time from a cron expression.
 */
export function nextRunFromCron(cronExpr, tz) {
  const cron = new Cron(cronExpr, { timezone: tz });
  const next = cron.nextRun();
  return next ? next.toISOString() : null;
}

/**
 * Create a new job.
 */
export function createJob(opts) {
  const db = getDb();
  const id = opts.id || randomUUID();
  const nextRun = nextRunFromCron(opts.schedule_cron, opts.schedule_tz || 'America/New_York');

  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      payload_model, payload_thinking, payload_timeout_seconds,
      overlap_policy, run_timeout_ms,
      delivery_mode, delivery_channel, delivery_to,
      delete_after_run, next_run_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    id,
    opts.name,
    opts.enabled !== false ? 1 : 0,
    opts.schedule_cron,
    opts.schedule_tz || 'America/New_York',
    opts.session_target || 'isolated',
    opts.agent_id || 'main',
    opts.payload_kind || (opts.session_target === 'main' ? 'systemEvent' : 'agentTurn'),
    opts.payload_message,
    opts.payload_model || null,
    opts.payload_thinking || null,
    opts.payload_timeout_seconds || 120,
    opts.overlap_policy || 'skip',
    opts.run_timeout_ms || 300000,
    opts.delivery_mode || 'announce',
    opts.delivery_channel || null,
    opts.delivery_to || null,
    opts.delete_after_run ? 1 : 0,
    nextRun
  );

  return getJob(id);
}

/**
 * Get a job by ID.
 */
export function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

/**
 * List all jobs, optionally filtered.
 */
export function listJobs(opts = {}) {
  const db = getDb();
  if (opts.enabledOnly) {
    return db.prepare('SELECT * FROM jobs WHERE enabled = 1 ORDER BY next_run_at').all();
  }
  return db.prepare('SELECT * FROM jobs ORDER BY name').all();
}

/**
 * Update a job (partial patch).
 */
export function updateJob(id, patch) {
  const db = getDb();
  const allowed = [
    'name', 'enabled', 'schedule_cron', 'schedule_tz',
    'session_target', 'agent_id', 'payload_kind', 'payload_message',
    'payload_model', 'payload_thinking', 'payload_timeout_seconds',
    'overlap_policy', 'run_timeout_ms',
    'delivery_mode', 'delivery_channel', 'delivery_to',
    'delete_after_run', 'next_run_at', 'last_run_at', 'last_status',
    'consecutive_errors'
  ];

  const sets = [];
  const values = [];

  for (const [key, val] of Object.entries(patch)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (sets.length === 0) return getJob(id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  // Recalculate next_run_at if schedule changed
  if (patch.schedule_cron || patch.schedule_tz) {
    const job = getJob(id);
    if (job) {
      const nextRun = nextRunFromCron(job.schedule_cron, job.schedule_tz);
      db.prepare('UPDATE jobs SET next_run_at = ? WHERE id = ?').run(nextRun, id);
    }
  }

  return getJob(id);
}

/**
 * Delete a job and its runs.
 */
export function deleteJob(id) {
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

/**
 * Get jobs that are due to run (next_run_at <= now, enabled).
 */
export function getDueJobs() {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE enabled = 1
      AND next_run_at IS NOT NULL
      AND next_run_at <= datetime('now')
    ORDER BY next_run_at ASC
  `).all();
}

/**
 * Check if a job has a running run (for skip-overlap).
 */
export function hasRunningRun(jobId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM runs
    WHERE job_id = ? AND status = 'running'
  `).get(jobId);
  return row.cnt > 0;
}
