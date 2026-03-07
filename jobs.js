// Job CRUD operations
import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { getDb } from './db.js';
import { enqueueDispatch } from './dispatch-queue.js';

const MAX_CHAIN_DEPTH = 10;
const VALID_TRIGGERS = new Set(['success', 'failure', 'complete']);
const VALID_OVERLAP_POLICIES = new Set(['skip', 'allow', 'queue']);
const VALID_DELIVERY_MODES = new Set(['announce', 'announce-always', 'none']);
const VALID_PAYLOAD_SCOPES = new Set(['own', 'global']);
const VALID_DELIVERY_GUARANTEES = new Set(['at-most-once', 'at-least-once']);
const VALID_JOB_CLASSES = new Set(['standard', 'pre_compaction_flush']);
const VALID_APPROVAL_AUTO = new Set(['approve', 'reject']);
const VALID_CONTEXT_RETRIEVAL = new Set(['none', 'recent', 'hybrid']);

/**
 * Valid payload_kind values for each session_target.
 *   - main:     systemEvent only  (inject into the main session)
 *   - shell:    shellCommand only (run a shell command)
 *   - isolated: systemEvent or agentTurn (standalone agent session)
 */
const VALID_PAYLOADS_BY_TARGET = {
  main:     ['systemEvent'],
  shell:    ['shellCommand'],
  isolated: ['systemEvent', 'agentTurn'],
};

function sqliteNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function normalizeNullableString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? null : value;
}

function assertSafeString(name, value, opts = {}) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  if (!opts.allowEmpty && value.trim().length === 0) {
    throw new Error(`${name} cannot be empty`);
  }
  const hasControlChars = [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127;
  });
  if (hasControlChars) {
    throw new Error(`${name} contains unsupported control characters`);
  }
  if (opts.maxLength && value.length > opts.maxLength) {
    throw new Error(`${name} exceeds max length of ${opts.maxLength}`);
  }
}

function assertInt(name, value, min = 0) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
}

function assertEnum(name, value, allowed, { nullable = false } = {}) {
  if (value == null && nullable) return;
  if (!allowed.has(value)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
  }
}

function validateTriggerConditionSyntax(condition) {
  if (condition == null) return;
  assertSafeString('trigger_condition', condition, { maxLength: 1024 });
  if (condition.startsWith('contains:')) {
    if (!condition.slice('contains:'.length)) {
      throw new Error('trigger_condition contains: pattern cannot be empty');
    }
    return;
  }
  if (condition.startsWith('regex:')) {
    const pattern = condition.slice('regex:'.length);
    if (!pattern) {
      throw new Error('trigger_condition regex pattern cannot be empty');
    }
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new Error(`Invalid trigger_condition regex: ${err.message}`, { cause: err });
    }
  }
}

export function validateJobSpec(opts, currentJob = null, mode = 'create') {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error('Job spec must be an object');
  }

  const normalized = { ...opts };
  for (const key of [
    'delivery_channel',
    'delivery_to',
    'resource_pool',
    'preferred_session_key',
    'payload_model',
    'payload_thinking',
    'trigger_condition',
  ]) {
    if (key in normalized) normalized[key] = normalizeNullableString(normalized[key]);
  }

  const merged = { ...(currentJob || {}), ...normalized };
  const isChild = !!merged.parent_id;

  if (mode === 'create' || 'name' in normalized) {
    assertSafeString('name', merged.name, { maxLength: 200 });
  }
  if (mode === 'create' || 'payload_message' in normalized) {
    assertSafeString('payload_message', merged.payload_message, { maxLength: 100000 });
  }
  if (mode === 'create' || 'agent_id' in normalized) {
    assertSafeString('agent_id', merged.agent_id || 'main', { maxLength: 128 });
  }
  if (mode === 'create' || 'session_target' in normalized || 'payload_kind' in normalized) {
    const finalTarget = merged.session_target || 'isolated';
    const finalKind = merged.payload_kind || (finalTarget === 'main' ? 'systemEvent' : 'agentTurn');
    validateJobPayload(finalTarget, finalKind);
  }
  if (!isChild && !merged.schedule_cron) {
    throw new Error('schedule_cron is required for root jobs');
  }
  if (merged.schedule_cron) {
    assertSafeString('schedule_cron', merged.schedule_cron, { maxLength: 128 });
    nextRunFromCron(merged.schedule_cron, merged.schedule_tz || 'America/New_York');
  }
  if (mode === 'create' || 'schedule_tz' in normalized) {
    assertSafeString('schedule_tz', merged.schedule_tz || 'America/New_York', { maxLength: 128 });
  }

  assertEnum('overlap_policy', merged.overlap_policy || 'skip', VALID_OVERLAP_POLICIES);
  assertEnum('delivery_mode', merged.delivery_mode || 'announce', VALID_DELIVERY_MODES);
  assertEnum('payload_scope', merged.payload_scope || 'own', VALID_PAYLOAD_SCOPES);
  assertEnum('delivery_guarantee', merged.delivery_guarantee || 'at-most-once', VALID_DELIVERY_GUARANTEES);
  assertEnum('job_class', merged.job_class || 'standard', VALID_JOB_CLASSES);
  assertEnum('approval_auto', merged.approval_auto || 'reject', VALID_APPROVAL_AUTO);
  assertEnum('context_retrieval', merged.context_retrieval || 'none', VALID_CONTEXT_RETRIEVAL);

  if (merged.trigger_on != null) {
    assertEnum('trigger_on', merged.trigger_on, VALID_TRIGGERS);
  }
  validateTriggerConditionSyntax(merged.trigger_condition);

  if (mode === 'create' || 'delivery_channel' in normalized) {
    assertSafeString('delivery_channel', merged.delivery_channel, { allowEmpty: false, maxLength: 64 });
  }
  if (mode === 'create' || 'delivery_to' in normalized) {
    assertSafeString('delivery_to', merged.delivery_to, { allowEmpty: false, maxLength: 256 });
  }
  if (mode === 'create' || 'resource_pool' in normalized) {
    assertSafeString('resource_pool', merged.resource_pool, { allowEmpty: false, maxLength: 128 });
  }
  if (mode === 'create' || 'preferred_session_key' in normalized) {
    assertSafeString('preferred_session_key', merged.preferred_session_key, { allowEmpty: false, maxLength: 512 });
  }
  if (mode === 'create' || 'payload_model' in normalized) {
    assertSafeString('payload_model', merged.payload_model, { allowEmpty: false, maxLength: 256 });
  }
  if (mode === 'create' || 'payload_thinking' in normalized) {
    assertSafeString('payload_thinking', merged.payload_thinking, { allowEmpty: false, maxLength: 64 });
  }

  for (const [name, min] of [
    ['payload_timeout_seconds', 1],
    ['run_timeout_ms', 1],
    ['trigger_delay_s', 0],
    ['max_retries', 0],
    ['approval_timeout_s', 1],
    ['context_retrieval_limit', 1],
    ['consecutive_errors', 0],
  ]) {
    if (name in normalized || (mode === 'create' && merged[name] != null)) {
      assertInt(name, merged[name], min);
    }
  }

  return normalized;
}

/**
 * Validate that a session_target + payload_kind combination is allowed.
 * Throws a descriptive Error on invalid combos.
 * @param {string} sessionTarget
 * @param {string} payloadKind
 */
export function validateJobPayload(sessionTarget, payloadKind) {
  const allowed = VALID_PAYLOADS_BY_TARGET[sessionTarget];
  if (!allowed) {
    throw new Error(
      `Unknown session_target "${sessionTarget}". Valid targets: ${Object.keys(VALID_PAYLOADS_BY_TARGET).join(', ')}`
    );
  }
  if (!allowed.includes(payloadKind)) {
    throw new Error(
      `Invalid payload_kind "${payloadKind}" for session_target "${sessionTarget}". ` +
      `Allowed: ${allowed.join(', ')}`
    );
  }
}

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
  const normalized = validateJobSpec(opts, null, 'create');
  const db = getDb();
  const id = normalized.id || randomUUID();
  const isChild = !!normalized.parent_id;
  const cronExpr = normalized.schedule_cron || (isChild ? '0 0 31 2 *' : null);

  // Cycle detection + depth check for child jobs
  if (isChild) {
    const depth = getChainDepth(normalized.parent_id) + 1; // +1 for the new child
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Max chain depth (${MAX_CHAIN_DEPTH}) exceeded. Chain would be ${depth} deep.`);
    }
  }

  // Resolve final payload_kind (after defaults) and validate combo
  const finalTarget = normalized.session_target || 'isolated';
  const finalKind = normalized.payload_kind || (finalTarget === 'main' ? 'systemEvent' : 'agentTurn');
  validateJobPayload(finalTarget, finalKind);

  let nextRun;
  if (normalized.run_now) {
    nextRun = sqliteNow(-1000);
  } else {
    nextRun = isChild ? null : nextRunFromCron(cronExpr, normalized.schedule_tz || 'America/New_York');
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
    normalized.name,
    normalized.enabled !== false ? 1 : 0,
    cronExpr,
    normalized.schedule_tz || 'America/New_York',
    normalized.session_target || 'isolated',
    normalized.agent_id || 'main',
    normalized.payload_kind || (normalized.session_target === 'main' ? 'systemEvent' : 'agentTurn'),
    normalized.payload_message,
    normalized.payload_model || null,
    normalized.payload_thinking || null,
    normalized.payload_timeout_seconds || 120,
    normalized.overlap_policy || 'skip',
    normalized.run_timeout_ms || 300000,
    normalized.delivery_mode || 'announce',
    normalized.delivery_channel || null,
    normalized.delivery_to || null,
    normalized.delete_after_run ? 1 : 0,
    nextRun,
    normalized.parent_id || null,
    normalized.trigger_on || null,
    normalized.trigger_delay_s || 0,
    normalized.max_retries || 0,
    normalized.payload_scope || 'own',
    normalized.resource_pool || null,
    normalized.trigger_condition || null,
    normalized.delivery_guarantee || 'at-most-once',
    normalized.job_class || 'standard',
    normalized.approval_required ? 1 : 0,
    normalized.approval_timeout_s || 3600,
    normalized.approval_auto || 'reject',
    normalized.context_retrieval || 'none',
    normalized.context_retrieval_limit || 5,
    normalized.preferred_session_key || null
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
  const current = getJob(id);
  if (!current) return null;
  const normalized = validateJobSpec(patch, current, 'update');
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
  if (normalized.parent_id) {
    detectCycle(id, normalized.parent_id);
    const depth = getChainDepth(normalized.parent_id) + 1;
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Max chain depth (${MAX_CHAIN_DEPTH}) exceeded.`);
    }
  }

  const sets = [];
  const values = [];

  for (const [key, val] of Object.entries(normalized)) {
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
  if (normalized.schedule_cron || normalized.schedule_tz) {
    const job = getJob(id);
    if (job) {
      const nextRun = job.parent_id ? null : nextRunFromCron(job.schedule_cron, job.schedule_tz);
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
  const job = getJob(id);
  if (!job) return null;
  const dispatch = enqueueDispatch(id, {
    kind: 'manual',
    scheduled_for: sqliteNow(-1000),
  });
  return { ...job, dispatch_id: dispatch.id, dispatch_kind: dispatch.dispatch_kind };
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
export function fireTriggeredChildren(parentId, status, content, parentRunId = null) {
  const candidates = getTriggeredChildren(parentId, status);
  const triggered = [];
  for (const child of candidates) {
    // Check output-based trigger condition if set
    if (!evalTriggerCondition(child.trigger_condition, content)) continue;
    const delay = child.trigger_delay_s || 0;
    const dispatch = enqueueDispatch(child.id, {
      kind: 'chain',
      scheduled_for: sqliteNow(delay > 0 ? delay * 1000 : -1000),
      source_run_id: parentRunId || null,
    });
    triggered.push({ ...child, dispatch_id: dispatch.id, scheduled_for: dispatch.scheduled_for });
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
  const dispatch = enqueueDispatch(job.id, {
    kind: 'retry',
    scheduled_for: sqliteNow(delaySec * 1000),
    source_run_id: failedRunId,
    retry_of_run_id: failedRunId,
  });
  if (!job.parent_id) {
    db.prepare(`UPDATE jobs SET next_run_at = ?, consecutive_errors = 0 WHERE id = ?`)
      .run(nextRunFromCron(job.schedule_cron, job.schedule_tz), job.id);
  } else {
    db.prepare(`UPDATE jobs SET consecutive_errors = 0 WHERE id = ?`).run(job.id);
  }
  // Store retry metadata for the next run
  return { retryCount, delaySec, retryOf: failedRunId, dispatch };
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
