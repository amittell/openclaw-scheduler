import { getDb } from './db.js';

export const ACTIVE_RUN_STATUSES = Object.freeze([
  'pending',
  'running',
  'awaiting_approval',
  'approved',
]);

export const TERMINAL_RUN_STATUSES = Object.freeze([
  'ok',
  'error',
  'timeout',
  'skipped',
  'cancelled',
  'crashed',
  'recovery_blocked',
]);

const ACTIVE_STATUS_SQL = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
const TERMINAL_STATUS_SET = new Set(TERMINAL_RUN_STATUSES);
const CREDENTIAL_CLEANUP_STATUSES = new Set([
  'pending',
  'not_required',
  'cleaned',
  'failed',
]);
const FINISH_FIELD_COLUMNS = new Map([
  ['summary', 'summary'],
  ['error_message', 'error_message'],
  ['context_summary', 'context_summary'],
  ['shell_exit_code', 'shell_exit_code'],
  ['shell_signal', 'shell_signal'],
  ['shell_timed_out', 'shell_timed_out'],
  ['shell_stdout', 'shell_stdout'],
  ['shell_stderr', 'shell_stderr'],
  ['shell_stdout_path', 'shell_stdout_path'],
  ['shell_stderr_path', 'shell_stderr_path'],
  ['shell_stdout_bytes', 'shell_stdout_bytes'],
  ['shell_stderr_bytes', 'shell_stderr_bytes'],
  ['process_terminated_at', 'process_terminated_at'],
  ['output_format', 'output_format'],
  ['structured_output', 'structured_output'],
  ['structured_output_valid', 'structured_output_valid'],
]);

function assertRunId(runId) {
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new Error('runId must be a non-empty string');
  }
}

function normalizeFence(opts = {}, { required = false } = {}) {
  const ownerId = opts.ownerId ?? opts.dispatcherOwner ?? opts.dispatcher_owner ?? null;
  const fencingToken = opts.fencingToken ?? opts.dispatcherToken ?? opts.dispatcher_token ?? null;
  const hasOwner = typeof ownerId === 'string' && ownerId.trim().length > 0;
  const hasToken = Number.isInteger(fencingToken) && fencingToken > 0;

  if (required && (!hasOwner || !hasToken)) {
    throw new Error('ownerId and fencingToken are required');
  }
  if (hasOwner !== hasToken) {
    throw new Error('ownerId and fencingToken must be provided together');
  }
  const leaseName = typeof opts.leaseName === 'string' && opts.leaseName.trim()
    ? opts.leaseName.trim()
    : 'scheduler-dispatcher';
  return hasOwner ? { ownerId, fencingToken, leaseName } : null;
}

function fenceSql(fence, values, { requireLiveLease = true } = {}) {
  if (fence) {
    if (!requireLiveLease) {
      values.push(fence.ownerId, fence.fencingToken);
      return 'dispatcher_owner = ? AND dispatcher_token = ?';
    }
    values.push(
      fence.ownerId,
      fence.fencingToken,
      fence.leaseName,
      fence.ownerId,
      fence.fencingToken,
    );
    return `
      dispatcher_owner = ? AND dispatcher_token = ?
      AND EXISTS (
        SELECT 1 FROM dispatcher_leases dl
        WHERE dl.name = ?
          AND dl.owner_id = ?
          AND dl.fencing_token = ?
          AND julianday(dl.expires_at) > julianday('now')
      )
    `;
  }
  return 'dispatcher_owner IS NULL AND dispatcher_token IS NULL';
}

function isFenceLive(fence) {
  if (!fence) return false;
  return Boolean(getDb().prepare(`
    SELECT 1 FROM dispatcher_leases
    WHERE name = ?
      AND owner_id = ?
      AND fencing_token = ?
      AND julianday(expires_at) > julianday('now')
  `).get(fence.leaseName, fence.ownerId, fence.fencingToken));
}

function getRun(runId) {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId) || null;
}

export function claimRunForDispatch(runId, opts = {}) {
  assertRunId(runId);
  const fence = normalizeFence(opts, { required: true });
  const row = getDb().prepare(`
    UPDATE runs
    SET dispatcher_owner = ?,
        dispatcher_token = ?,
        dispatch_started_at = COALESCE(dispatch_started_at, datetime('now')),
        dispatched_at = COALESCE(dispatched_at, datetime('now'))
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
      AND (
        (dispatcher_owner IS NULL AND dispatcher_token IS NULL)
        OR (dispatcher_owner = ? AND dispatcher_token = ?)
      )
      AND EXISTS (
        SELECT 1 FROM dispatcher_leases dl
        WHERE dl.name = ?
          AND dl.owner_id = ?
          AND dl.fencing_token = ?
          AND julianday(dl.expires_at) > julianday('now')
      )
    RETURNING *
  `).get(
    fence.ownerId,
    fence.fencingToken,
    runId,
    ...ACTIVE_RUN_STATUSES,
    fence.ownerId,
    fence.fencingToken,
    fence.leaseName,
    fence.ownerId,
    fence.fencingToken,
  );
  return row || null;
}

/**
 * Persist the credential-cleanup safety state inside context_summary while
 * preserving the rest of the run context. The initial pending marker requires
 * a live dispatcher lease. Its terminal cleanup result may be recorded after
 * lease loss only by the exact owner/token that created the active run; this
 * monotonic, run-scoped update lets a successor fail closed without allowing a
 * stale worker to change scheduling or terminal status.
 */
export function recordRunCredentialCleanupState(runId, state, opts = {}) {
  assertRunId(runId);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('credential cleanup state must be an object');
  }
  if (!CREDENTIAL_CLEANUP_STATUSES.has(state.status)) {
    throw new Error(`invalid credential cleanup status: ${state.status}`);
  }
  const fence = normalizeFence(opts, { required: true });
  const normalized = {
    status: state.status,
    attempts: Number.isInteger(state.attempts) && state.attempts >= 0 ? state.attempts : 0,
    operator_action_required: state.status === 'failed',
    updated_at: new Date().toISOString(),
    ...(typeof state.error === 'string' && state.error.trim()
      ? { error: state.error.trim().slice(0, 1000) }
      : {}),
  };
  const values = [JSON.stringify(normalized), runId, ...ACTIVE_RUN_STATUSES];
  const ownership = fenceSql(fence, values, {
    requireLiveLease: opts.allowAfterLeaseLoss !== true,
  });
  return getDb().prepare(`
    UPDATE runs
    SET context_summary = json_set(
      CASE WHEN json_valid(context_summary) THEN context_summary ELSE '{}' END,
      '$.credential_cleanup',
      json(?)
    )
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
      AND ${ownership}
    RETURNING *
  `).get(...values) || null;
}

export function requestRunCancellation(runId, opts = {}) {
  assertRunId(runId);
  const requestedBy = typeof opts.requestedBy === 'string' && opts.requestedBy.trim()
    ? opts.requestedBy.trim()
    : 'operator';
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim()
    : 'Cancellation requested';

  const row = getDb().prepare(`
    UPDATE runs
    SET cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
        cancel_requested_by = COALESCE(cancel_requested_by, ?),
        cancel_reason = COALESCE(cancel_reason, ?)
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
    RETURNING *
  `).get(requestedBy, reason, runId, ...ACTIVE_RUN_STATUSES);

  return { changed: Boolean(row), run: row || getRun(runId) };
}

export function cancelRunBeforeExecution(runId, opts = {}) {
  assertRunId(runId);
  const requestedBy = typeof opts.requestedBy === 'string' && opts.requestedBy.trim()
    ? opts.requestedBy.trim()
    : 'operator';
  const reason = typeof opts.reason === 'string' && opts.reason.trim()
    ? opts.reason.trim()
    : 'Cancelled before execution';
  const row = getDb().prepare(`
    UPDATE runs
    SET status = 'cancelled',
        cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
        cancel_requested_by = COALESCE(cancel_requested_by, ?),
        cancel_reason = COALESCE(cancel_reason, ?),
        summary = COALESCE(summary, ?),
        finished_at = datetime('now'),
        duration_ms = MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)),
        terminal_transition_at = datetime('now')
    WHERE id = ?
      AND status IN ('pending', 'awaiting_approval', 'approved')
      AND process_started_at IS NULL
    RETURNING *
  `).get(requestedBy, reason, reason, runId);
  return { changed: Boolean(row), run: row || getRun(runId) };
}

export function getRunCancellation(runId) {
  assertRunId(runId);
  const row = getDb().prepare(`
    SELECT cancel_requested_at, cancel_requested_by, cancel_reason,
           agent_cancel_requested_at
    FROM runs
    WHERE id = ?
  `).get(runId);
  if (!row?.cancel_requested_at) return null;
  return row;
}

export function isRunCancellationRequested(runId) {
  return Boolean(getRunCancellation(runId));
}

export function recordRunProcess(runId, processInfo, opts = {}) {
  assertRunId(runId);
  if (!processInfo || !Number.isInteger(processInfo.pid) || processInfo.pid <= 0) {
    throw new Error('processInfo.pid must be a positive integer');
  }
  const pgid = processInfo.pgid == null ? null : processInfo.pgid;
  if (pgid != null && (!Number.isInteger(pgid) || pgid <= 0)) {
    throw new Error('processInfo.pgid must be a positive integer or null');
  }
  const processIdentity = processInfo.processIdentity == null
    ? null
    : String(processInfo.processIdentity).trim();
  if (processInfo.processIdentity != null && !processIdentity) {
    throw new Error('processInfo.processIdentity must be a non-empty string or null');
  }
  const fence = normalizeFence(opts);
  const values = [processInfo.pid, pgid, processIdentity, runId, ...ACTIVE_RUN_STATUSES];
  const ownership = fenceSql(fence, values);

  const row = getDb().prepare(`
    UPDATE runs
    SET process_pid = ?,
        process_pgid = ?,
        process_identity = ?,
        process_started_at = COALESCE(process_started_at, datetime('now')),
        process_terminated_at = NULL
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
      AND cancel_requested_at IS NULL
      AND ${ownership}
    RETURNING *
  `).get(...values);
  return row || null;
}

export function recordRunProcessTerminated(runId, opts = {}) {
  assertRunId(runId);
  const fence = normalizeFence(opts);
  const values = [runId];
  // Permit the owning worker to record confirmed termination after its lease
  // expires. This audit-only write prevents recovery from killing a reused PID;
  // it cannot change run status or trigger completion effects.
  const ownership = fenceSql(fence, values, { requireLiveLease: false });
  const row = getDb().prepare(`
    UPDATE runs
    SET process_terminated_at = COALESCE(process_terminated_at, datetime('now'))
    WHERE id = ? AND ${ownership}
    RETURNING *
  `).get(...values);
  return row || null;
}

export function markAgentCancellationRequested(runId, opts = {}) {
  assertRunId(runId);
  const fence = normalizeFence(opts);
  const values = [runId, ...ACTIVE_RUN_STATUSES];
  const ownership = fenceSql(fence, values);
  const row = getDb().prepare(`
    UPDATE runs
    SET agent_cancel_requested_at = COALESCE(agent_cancel_requested_at, datetime('now'))
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
      AND ${ownership}
    RETURNING *
  `).get(...values);
  return row || null;
}

/**
 * Compare-and-swap an active run into a terminal state.
 *
 * Owned runs require the exact dispatcher owner and fencing token. Calls with
 * no fence can only finish legacy/unowned runs, which prevents an old
 * dispatcher from finalizing work after another dispatcher has taken over.
 */
export function transitionRunTerminal(runId, status, fields = {}, opts = {}) {
  assertRunId(runId);
  if (!TERMINAL_STATUS_SET.has(status)) {
    throw new Error(`status must be terminal: ${TERMINAL_RUN_STATUSES.join(', ')}`);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('fields must be an object');
  }

  const fence = normalizeFence(opts);
  const run = getRun(runId);
  if (!run) return { changed: false, run: null, fenced: false };

  const startedAt = run.started_at
    ? new Date(run.started_at.includes('T') ? run.started_at : `${run.started_at.replace(' ', 'T')}Z`).getTime()
    : Date.now();
  const durationMs = Number.isInteger(fields.duration_ms) && fields.duration_ms >= 0
    ? fields.duration_ms
    : Math.max(0, Date.now() - (Number.isFinite(startedAt) ? startedAt : Date.now()));

  const sets = [
    "status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE ? END",
    "finished_at = datetime('now')",
    'duration_ms = ?',
    "terminal_transition_at = datetime('now')",
  ];
  const values = [status, durationMs];

  for (const [field, column] of FINISH_FIELD_COLUMNS) {
    if (!(field in fields) || fields[field] == null) continue;
    let value = fields[field];
    if (field === 'context_summary' && typeof value !== 'string') value = JSON.stringify(value);
    if (field === 'shell_timed_out') value = Number(Boolean(value));
    sets.push(`${column} = ?`);
    values.push(value);
  }

  values.push(runId, ...ACTIVE_RUN_STATUSES);
  const ownership = fenceSql(fence, values);
  const changedRun = getDb().prepare(`
    UPDATE runs
    SET ${sets.join(', ')}
    WHERE id = ?
      AND status IN (${ACTIVE_STATUS_SQL})
      AND ${ownership}
    RETURNING *
  `).get(...values);

  const currentRun = changedRun || getRun(runId);
  const fenced = Boolean(
    fence &&
    !changedRun &&
    currentRun &&
    ACTIVE_RUN_STATUSES.includes(currentRun.status) &&
    (
      currentRun.dispatcher_owner !== fence.ownerId ||
      currentRun.dispatcher_token !== fence.fencingToken ||
      !isFenceLive(fence)
    )
  );
  return { changed: Boolean(changedRun), run: currentRun, fenced };
}

export function getOwnedActiveRuns(ownerId, fencingToken) {
  const fence = normalizeFence({ ownerId, fencingToken }, { required: true });
  return getDb().prepare(`
    SELECT *
    FROM runs
    WHERE dispatcher_owner = ?
      AND dispatcher_token = ?
      AND status IN (${ACTIVE_STATUS_SQL})
    ORDER BY started_at ASC
  `).all(fence.ownerId, fence.fencingToken, ...ACTIVE_RUN_STATUSES);
}
