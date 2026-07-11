export const TERMINAL_RUN_STATUSES = new Set([
  'ok',
  'error',
  'timeout',
  'skipped',
  'cancelled',
  'crashed',
  'recovery_blocked',
]);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isCancellationRequested(run) {
  return Boolean(run?.cancel_requested_at) || run?.status === 'cancelled';
}

/**
 * Decide how a controller abort observed before execution should affect the
 * durable run. Process lifecycle aborts must remain active for startup orphan
 * recovery; only durable operator cancellation or a health timeout may commit
 * a terminal transition in the current dispatcher.
 */
export function classifyPreExecutionAbort(run, abortKind) {
  if (isCancellationRequested(run)) return 'cancel';
  if (abortKind === 'health_timeout') return 'complete_error';
  return 'recover';
}

/**
 * Commit a terminal state through the run-state compare-and-swap primitive.
 * A pending cancellation always wins over a normal completion.
 */
export function completeRunFenced({
  runId,
  status,
  fields = {},
  ownerId = null,
  fencingToken = null,
  transitionRunTerminal,
}) {
  if (typeof transitionRunTerminal !== 'function') {
    throw new Error('transitionRunTerminal is required');
  }
  if (!isTerminalRunStatus(status)) {
    throw new Error(`Invalid terminal run status "${status}"`);
  }
  const transition = transitionRunTerminal(
    runId,
    status,
    fields,
    { ownerId, fencingToken },
  );
  const run = transition?.run || null;
  const effectiveStatus = run?.status || status;
  return {
    changed: Boolean(transition?.changed),
    run,
    status: effectiveStatus,
    cancelled: effectiveStatus === 'cancelled' || isCancellationRequested(run),
    fenced: Boolean(transition?.fenced),
  };
}

/** Execute all synchronous DB completion bookkeeping atomically. */
export function commitCompletionBookkeeping(db, callback) {
  if (!db || typeof db.transaction !== 'function') throw new Error('A database handle is required');
  if (typeof callback !== 'function') throw new Error('A completion callback is required');
  return db.transaction(callback)();
}

export function shouldRunPostCompletionEffects(completion) {
  return Boolean(completion?.changed) && !completion.cancelled && !completion.fenced;
}
