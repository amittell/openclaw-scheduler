// Job CRUD operations
import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { getDb } from './db.js';


const MAX_CHAIN_DEPTH = 10;

/**
 * Calculate next run time from a cron expression.
 */
export function nextRunFromCron(cronExpr, tz) {
  const cron = new Cron(cronExpr, { timezone: tz });
  const next = cron.nextRun();
  if (!next) return null;
  // Use SQLite-compatible format: 'YYYY-MM-DD HH:MM:SS' (UTC)
  return next.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/**
 * Create a new job.
 */
export function createJob(opts) {
  const db = getDb();
  const id = opts.id || randomUUID();
  const isChild = !!opts.parent_id;
  const cronExpr = opts.schedule_cron || (isChild ? '0 0 31 2 *' : null);
  if (!cronExpr && !isChild) throw new Error('schedule_cron is required for root jobs');

  // Cycle detection + depth check for child jobs
  if (isChild) {
    const depth = getChainDepth(opts.parent_id) + 1; // +1 for the new child
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Max chain depth (${MAX_CHAIN_DEPTH}) exceeded. Chain would be ${depth} deep.`);
    }
  }

  let nextRun;
  if (opts.run_now) {
    nextRun = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  } else {
    nextRun = isChild ? null : nextRunFromCron(cronExpr, opts.schedule_tz || 'America/New_York');
  }

  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, name, enabled, schedule_cron, schedule_tz,
      session_target, agent_id, payload_kind, payload_message,
      payload_model, payload_thinking, payload_timeout_seconds,
      overlap_policy, run_timeout_ms,
      delivery_mode, delivery_channel, delivery_to,
      delete_after_run, next_run_at,
      parent_id, trigger_on, trigger_delay_s,
      max_retries, payload_scope, resource_pool,
      trigger_condition,
      delivery_guarantee, job_class,
      approval_required, approval_timeout_s, approval_auto,
      context_retrieval, context_retrieval_limit,
      preferred_session_key
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?
    )
  `);

  stmt.run(
    id,
    opts.name,
    opts.enabled !== false ? 1 : 0,
    cronExpr,
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
    nextRun,
    opts.parent_id || null,
    opts.trigger_on || null,
    opts.trigger_delay_s || 0,
    opts.max_retries || 0,
    opts.payload_scope || 'own',
    opts.resource_pool || null,
    opts.trigger_condition || null,
    opts.delivery_guarantee || 'at-most-once',
    opts.job_class || 'standard',
    opts.approval_required ? 1 : 0,
    opts.approval_timeout_s || 3600,
    opts.approval_auto || 'reject',
    opts.context_retrieval || 'none',
    opts.context_retrieval_limit || 5,
    opts.preferred_session_key || null
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
    'consecutive_errors', 'parent_id', 'trigger_on', 'trigger_delay_s',
    'max_retries', 'payload_scope', 'resource_pool', 'trigger_condition',
    'delivery_guarantee', 'job_class',
    'approval_required', 'approval_timeout_s', 'approval_auto',
    'context_retrieval', 'context_retrieval_limit',
    'preferred_session_key'
  ];

  // Cycle detection if parent_id is being changed
  if (patch.parent_id) {
    detectCycle(id, patch.parent_id);
    const depth = getChainDepth(patch.parent_id) + 1;
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Max chain depth (${MAX_CHAIN_DEPTH}) exceeded.`);
    }
  }

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
 * Schedule an existing job for immediate execution by setting next_run_at to 1 second in the past.
 * The job's cron schedule is unchanged; after it runs, updateJobAfterRun restores normal scheduling.
 */
export function runJobNow(id) {
  const db = getDb();
  const pastSecond = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  db.prepare(`UPDATE jobs SET next_run_at = ?, updated_at = datetime('now') WHERE id = ?`).run(pastSecond, id);
  return getJob(id);
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
 * Prune expired disabled jobs (one-shots that already ran, or disabled jobs
 * whose next_run_at is in the past and won't fire again).
 */
export function pruneExpiredJobs() {
  const db = getDb();
  // Delete disabled one-shot jobs (delete_after_run=1) that already have a last_run_at
  const oneShots = db.prepare(`
    DELETE FROM jobs
    WHERE enabled = 0
      AND delete_after_run = 1
      AND last_run_at IS NOT NULL
  `).run();
  // Delete disabled jobs whose cron only matches dates in the past (one-time crons like '0 4 18 2 *')
  // by checking if next_run_at is >30 days from now (means it wrapped to next year = expired)
  const stale = db.prepare(`
    DELETE FROM jobs
    WHERE enabled = 0
      AND next_run_at > datetime('now', '+300 days')
  `).run();
  // Delete any disabled job that's been sitting for >24h since last run (or creation if never ran)
  const aged = db.prepare(`
    DELETE FROM jobs
    WHERE enabled = 0
      AND (
        (last_run_at IS NOT NULL AND last_run_at < datetime('now', '-24 hours'))
        OR (last_run_at IS NULL AND created_at < datetime('now', '-24 hours'))
      )
  `).run();
  // Delete orphaned children whose parent no longer exists
  const orphans = db.prepare(`
    DELETE FROM jobs
    WHERE parent_id IS NOT NULL
      AND parent_id NOT IN (SELECT id FROM jobs)
  `).run();
  return oneShots.changes + stale.changes + aged.changes + orphans.changes;
}

/**
 * Get child jobs triggered by a parent completing with a given status.
 */
export function getTriggeredChildren(parentId, status) {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE parent_id = ? AND enabled = 1
      AND (trigger_on = 'complete' OR trigger_on = ?)
  `).all(parentId, status === 'ok' ? 'success' : 'failure');
}

/**
 * Get all child jobs of a parent.
 */
export function getChildJobs(parentId) {
  return getDb().prepare(`SELECT * FROM jobs WHERE parent_id = ?`).all(parentId);
}

/**
 * Evaluate a trigger_condition pattern against parent run output content.
 * Supports:
 *   - null / undefined → always matches (no condition)
 *   - "contains:<substr>" → substring match (case-sensitive)
 *   - "regex:<pattern>" → regex match
 * Returns true if the condition matches (or is absent).
 */
export function evalTriggerCondition(condition, content) {
  if (!condition) return true;
  const str = content || '';
  if (condition.startsWith('contains:')) {
    const substr = condition.slice('contains:'.length);
    return str.includes(substr);
  }
  if (condition.startsWith('regex:')) {
    const pattern = condition.slice('regex:'.length);
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false; // Invalid regex never matches
    }
  }
  // Unknown prefix — treat as literal substring match for safety
  return str.includes(condition);
}

/**
 * Fire triggered children by setting their next_run_at.
 * @param {string} parentId - parent job id
 * @param {string} status - 'ok' | 'error'
 * @param {string} [content] - parent run output (used to evaluate trigger_condition)
 * Returns array of triggered children.
 */
export function fireTriggeredChildren(parentId, status, content) {
  const candidates = getTriggeredChildren(parentId, status);
  const db = getDb();
  const triggered = [];
  for (const child of candidates) {
    // Check output-based trigger condition if set
    if (!evalTriggerCondition(child.trigger_condition, content)) continue;
    const delay = child.trigger_delay_s || 0;
    if (delay > 0) {
      db.prepare(`UPDATE jobs SET next_run_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`).run(delay, child.id);
    } else {
      db.prepare(`UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?`).run(child.id);
    }
    triggered.push(child);
  }
  return triggered;
}

/**
 * Increment the queued dispatch counter for a job (overlap_policy=queue).
 */
export function enqueueJob(jobId) {
  getDb().prepare('UPDATE jobs SET queued_count = queued_count + 1 WHERE id = ?').run(jobId);
}

/**
 * Consume one queued dispatch. Returns true if there was something queued.
 */
export function dequeueJob(jobId) {
  const job = getJob(jobId);
  if (!job || job.queued_count <= 0) return false;
  const db = getDb();
  db.prepare('UPDATE jobs SET queued_count = queued_count - 1 WHERE id = ?').run(jobId);
  // Schedule it to fire on the next tick
  db.prepare(`UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?`).run(jobId);
  return true;
}

/**
 * Detect cycles in the parent chain. Throws if adding childId → parentId would create a loop.
 */
export function detectCycle(childId, parentId) {
  const db = getDb();
  const visited = new Set([childId]);
  let current = parentId;
  while (current) {
    if (visited.has(current)) {
      throw new Error(`Cycle detected: job ${childId} → ${parentId} would create a loop`);
    }
    visited.add(current);
    const job = db.prepare('SELECT parent_id FROM jobs WHERE id = ?').get(current);
    current = job?.parent_id || null;
  }
}

/**
 * Get the depth of a job's parent chain (0 = root).
 */
export function getChainDepth(jobId) {
  const db = getDb();
  let depth = 0;
  let current = jobId;
  while (current) {
    const job = db.prepare('SELECT parent_id FROM jobs WHERE id = ?').get(current);
    if (!job || !job.parent_id) break;
    depth++;
    current = job.parent_id;
    if (depth > MAX_CHAIN_DEPTH) break; // safety valve
  }
  return depth;
}

/**
 * Check if a failed run should be retried. Returns true if retry was scheduled.
 */
export function shouldRetry(job, runId) {
  if (!job.max_retries || job.max_retries <= 0) return false;
  const db = getDb();
  // Count retries for this job's most recent failure chain
  const run = db.prepare('SELECT retry_count FROM runs WHERE id = ?').get(runId);
  const retryCount = run?.retry_count || 0;
  if (retryCount >= job.max_retries) return false;
  return true;
}

/**
 * Schedule a retry for a failed run. Returns the new retry run's next_run_at or null.
 */
export function scheduleRetry(job, failedRunId) {
  const db = getDb();
  const failedRun = db.prepare('SELECT retry_count FROM runs WHERE id = ?').get(failedRunId);
  const retryCount = (failedRun?.retry_count || 0) + 1;
  // Exponential backoff: 30s, 60s, 120s, etc.
  const delaySec = 30 * Math.pow(2, retryCount - 1);
  db.prepare(`UPDATE jobs SET next_run_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`)
    .run(delaySec, job.id);
  // Store retry metadata for the next run
  db.prepare(`UPDATE jobs SET consecutive_errors = 0 WHERE id = ?`).run(job.id);
  return { retryCount, delaySec, retryOf: failedRunId };
}

/**
 * Cancel a job and optionally cascade to children.
 * Sets status to disabled and cancels any running runs.
 */
export function cancelJob(jobId, opts = {}) {
  const db = getDb();
  const cascade = opts.cascade !== false; // default: cascade

  // Disable the job
  db.prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(jobId);

  // Cancel any running runs
  const runningRuns = db.prepare(`
    SELECT id FROM runs WHERE job_id = ? AND status = 'running'
  `).all(jobId);
  for (const run of runningRuns) {
    db.prepare(`
      UPDATE runs SET status = 'cancelled', finished_at = datetime('now')
      WHERE id = ?
    `).run(run.id);
  }

  const cancelled = [jobId];

  // Cascade to children
  if (cascade) {
    const children = getChildJobs(jobId);
    for (const child of children) {
      const childCancelled = cancelJob(child.id, { cascade: true });
      cancelled.push(...childCancelled);
    }
  }

  return cancelled;
}

/**
 * Check if ANY job with the given resource_pool has a running run.
 * Returns true if the pool is busy (at least one running run for any job in the pool).
 */
export function hasRunningRunForPool(poolName) {
  if (!poolName) return false;
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running' AND j.resource_pool = ?
  `).get(poolName);
  return row.cnt > 0;
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
