# Implementation Specification: Scheduler 0.3.0

This document records the current runtime contract. The executable schema is
`schema.sql`; the idempotent upgrade path is `migrate-consolidate.js`.

## Database Contract

Schema version: 27

Initialization is fail closed:

1. Open SQLite with WAL, a busy timeout, and foreign keys enabled.
2. For a fresh database, apply `schema.sql` transactionally.
3. For an existing database, run the idempotent consolidation transaction
   before reapplying the current schema.
4. Throw `DB_INIT_FAILED` on open, schema, or consolidation failure. Do not run
   the dispatcher against a partial schema.

The v27 ownership and delivery tables are:

- `dispatcher_leases`: named owner, monotonically increasing fencing token,
  acquisition, renewal, and expiry times.
- `job_dispatch_queue`: owner/token/expiry for claims plus attempt, replay, and
  error state.
- `runs`: dispatcher fence, cancellation fields, process identity and lifecycle,
  agent-abort audit, and one terminal transition timestamp.
- `approvals`: versioned decisions and explicit approved, rejected, cancelled,
  expired, dispatching, and dispatched timestamps/state.
- `delivery_outbox`: externally addressed output, retry budget, due time, and
  leased claim state.
- `delivery_attachments`: ordered durable content/path, size, MIME type, and
  SHA-256 integrity metadata.

Agent prompt messages remain in `messages`. `prompt_claimed` means a dispatcher
owns prompt injection. An external delivery never enters that route.

## Dispatcher Ownership

`runtime-lease.js` performs atomic acquire, renew, assert, and release operations.
An expired lease can be taken over only with a higher fencing token.

`dispatcher-runtime.js` owns the lease and a bounded in-process worker queue.
The tick loop may enqueue independent work without waiting for a long job to
finish. A worker must assert the live lease before committing owned state.

`run-state.js` compares dispatcher owner and token on active and terminal run
transitions. A stale dispatcher cannot finalize a run after takeover.

## Dispatch Queue Recovery

Queue claims have an owner, random claim token, and expiry. Recovery moves an
expired claim to pending only when no active run references it. Disabled jobs'
non-manual pending dispatches are cancelled before execution. Claim attempts and
last errors remain queryable.

## Completion Transaction

`run-completion.js` commits one terminal state through a compare-and-swap. In
the same SQLite transaction it updates job counters/timestamps and enqueues
eligible retry or child dispatches. If cancellation already won, effective
status is `cancelled` and no delivery or child side effect is created.

## Cancellation

Cancellation records requester, reason, and timestamp before acting on active
work.

- Pending, awaiting-approval, and approved runs may transition directly to
  `cancelled` before execution.
- Shell execution records PID and process-group ID. Timeout or cancellation
  terminates the group, waits for escalation when needed, and records process
  termination before completion.
- Agent execution links abort signals and calls OpenClaw Gateway `chat.abort`
  when a session key exists. The request is best effort and is audited.
- Only the owning fence can commit the final run state.

Cancellation cannot reverse an external side effect that already completed.
Destructive jobs still require idempotent command design.

## Approval State

`approval-state.js` performs versioned atomic transitions. Only one caller can
claim approved work for dispatch. Rejection, timeout, cancellation, disabled
job state, or a cancelled linked run prevents later dispatch. The approval and
linked queue/run state are updated together where required.

## Delivery and Attachments

`delivery-outbox.js` is the only durable route for external channel output.
Completion enqueues an idempotent outbox row. The consumer claims due rows with
an expiry, retries within `max_attempts`, and records delivered or failed state.

`attachment-store.js` stages attachments, validates size, computes SHA-256, and
stores either durable content or a controlled artifact path. Failed enqueue
cleans staged artifacts. Agent prompt consumption cannot claim outbox rows.

## Governance

`governance.js` evaluates every job before execution.

- Fresh shell jobs default to `shell_env_policy: "minimal"`.
- Migrated shell jobs explicitly retain `shell_env_policy: "inherit"` and emit
  a warning.
- A requested sandbox, restricted network, allowed-path boundary, or agent cost
  cap is denied unless the executor reports real enforcement.
- Identity, trust, proof, authorization, and credential handoff failures remain
  fail closed.
- Materialized credential values are cleared during cleanup paths.

The default host executor does not claim container, namespace, firewall,
filesystem, or agent-cost isolation.

## CLI Contract

`help`, `version`, `schema`, `capabilities`, `jobs validate`, and `jobs add
--dry-run` do not initialize the database. Stateful commands initialize schema
first.

JSON errors use a nonzero exit and one object on stdout:

```json strict
{
  "ok": false,
  "error": "Job not found: example-id",
  "code": "NOT_FOUND"
}
```

Job specs may be inline, read with `--file`, or read with `--stdin`. `doctor`
and `status` expose schema, live lease, queue, outbox, approval, and cancellation
diagnostics.

## OpenClaw Import Contract

The default source is `openclaw cron list --json` followed by `openclaw cron get
<id> --json`. Cron expressions are preserved verbatim. One-shot timestamps
remain `schedule_kind: "at"`. Interval schedules import automatically only when
their cadence and phase are exactly representable by five-field cron.

`--allow-inexact-every` opts into approximation and emits a warning.
`--legacy-json` explicitly selects an old file export. The command emits a
per-job structured report and exits nonzero when any job fails.

## Verification Contract

`npm test` runs:

1. the legacy integration suite;
2. every `tests/*.test.mjs` file in its own process and isolated database,
   sequentially;
3. documentation example validation;
4. the sibling agentcli scheduler integration when that checkout is present.

`npm run verify:local` adds lint, type checking, coverage, and a package dry run.
CI uses the same smoke gate without the extra coverage pass.
