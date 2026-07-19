# Implementation Specification: Scheduler 0.5.0

This document records the current runtime contract. The executable schema is
`schema.sql`; the idempotent upgrade path is `migrate-consolidate.js`.

## Database Contract

Schema version: 29

Initialization is fail closed:

1. Open SQLite with WAL, a busy timeout, and foreign keys enabled.
2. For a fresh database, apply `schema.sql` transactionally.
3. For an existing database, run the idempotent consolidation transaction
   before reapplying the current schema.
4. Throw `DB_INIT_FAILED` on open, schema, or consolidation failure. Do not run
   the dispatcher against a partial schema.

The v29 ownership, governance, evidence, and delivery tables are:

- `dispatcher_leases`: named owner, monotonically increasing fencing token,
  acquisition, renewal, and expiry times.
- `job_dispatch_queue`: owner/token/expiry for claims plus attempt, replay, and
  error state.
- `runs`: dispatcher fence, cancellation fields, process identity and lifecycle,
  agent-abort audit, full-output SHA-256 digests, and one terminal transition
  timestamp.
- `approvals`: versioned decisions and explicit approved, rejected, cancelled,
  timed-out, dispatching, and dispatched timestamps/state, plus risk, approver
  scope, and the bound execution-contract hash.
- `delivery_outbox`: externally addressed output, retry budget, due time,
  leased claim state, and multipart group/index/count coordinates.
- `delivery_attachments`: ordered durable content/path, size, MIME type, and
  SHA-256 integrity metadata.
- `completion_debts`: run-scoped completion delivery ownership and recovery
  state.
- `evidence_records`: one immutable canonical SHA-256 evidence row per run.
- `handoff_artifacts`: immutable canonical AgentCLI handoff v4 payloads keyed by
  their SHA-256 digest.
- `runtime_events`: append-only, artifact-bound execution and audit events.
- `provider_sessions`: resumable provider session state scoped to an exact
  artifact and runtime instance.
- `credential_presentations`: cleanup-tracked credential release metadata that
  never stores the credential value.
- `authorization_proof_replay`: proof nonce/JTI claims that reject replay and
  cross-artifact transplantation.

Agent prompt messages remain in `messages`. `prompt_claimed` means a dispatcher
owns prompt injection. An external delivery never enters that route.

## AgentCLI Handoff Version 4

Handoff v4 is an additive protocol. Existing direct scheduler jobs and AgentCLI
handoff versions 1 through 3 retain their previous storage and execution paths.
A v4 job is accepted only when all of the following agree exactly:

- artifact schema `openclaw.scheduler.handoff-artifact`, version 1;
- handoff version 4 and minimum scheduler schema 29;
- canonicalization `json-sort-v1`, version 1, SHA-256, with undefined values
  normalized to JSON null;
- execution binding version 2;
- scheduler job binding version 1;
- canonical artifact digest, manifest digest, effective task hash, command
  hashes, policy hashes, and the complete persisted scheduler execution
  projection.

The artifact contains resolved execution semantics and hashes, never raw
credentials, proof values, stdin, or environment values. Job creation persists
the artifact before the job. Replacement persists a new immutable artifact,
keeps the prior artifact, applies explicit null clears, and atomically cancels
pending dispatches and approvals bound to the superseded digest. Disabling a v4
job does not rewrite its artifact. Re-enabling is allowed only when the
resulting job once again matches that same persisted artifact exactly.

Every dispatch, approval, run, evidence row, provider session, credential
presentation, and runtime event carries the exact artifact digest. Chain and
retry work additionally bind the exact source run ID and source artifact digest.
Database triggers prevent binding mutation and artifact deletion while runtime
state references it. Run pruning retains every source run referenced by an
immutable v4 dispatch so foreign-key cleanup cannot rewrite that lineage.

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

Every `approval_required` attempt, including scheduled, one-shot, manual,
chain, and retry dispatch, requires a durable queue row. Approval creation snapshots
`approval_risk_level`, `approval_approver_scope`, and a canonical SHA-256
binding of the persisted execution contract. Scope matching supports exact,
local username, numeric UID, and normalized local-principal identities. The CLI
derives these values from the invoking operating-system account; flags and
environment variables cannot substitute another identity. Domain scopes are
rejected. An approve decision for a scoped gate must match, and scoped gates
cannot timeout-auto-approve. Mutation, disable, or delete cancels the bound
approval.

Cryptographic proof verification persists the verified not-before and expiry
window plus the exact clock skew used for the decision. After an approval wait,
the scheduler rechecks that trusted window and revocation state without
claiming the proof replay identifier a second time.

`approvals approve/reject APPROVAL_ID` is the primary decision surface. Legacy
`jobs approve/reject JOB_ID` first resolves that job's current pending approval
and never selects approver identity. Operators use `approvals list --json` to
obtain the complete approval UUID.

## Structured Output

`output_format` accepts `json`, `ndjson`, or `text`. JSON parses as one value;
every nonblank NDJSON line parses independently; text uses the normalized text
result. The run records the declared format, validity, warning, raw byte count,
SHA-256 digest, and either the parsed value or an offloaded artifact reference.
Malformed JSON or NDJSON is nonfatal and does not change an otherwise
successful execution or block success children.

## Post-success Verification

Synchronous jobs may declare a local shell check through `verify_shell`,
`verify_timeout_s`, and `verify_on_failure`. Verification executes after primary execution and
structured-output parsing but before credentials are cleaned up, terminal
evidence is persisted, delivery is enqueued, or children are dispatched. The
runtime applies the same timeout, cancellation, process-group, fencing, and
environment controls as ordinary shell execution. Audit state contains only
status, timing, exit metadata, byte counts, and output hashes. `error` converts
verification failure to terminal error; `warn` preserves success. Interrupted
verification receives a terminal evidence outcome during recovery.

## Delivery and Attachments

`delivery-outbox.js` is the only durable route for external channel output.
Completion enqueues an idempotent outbox row. The consumer claims due rows with
an expiry, retries within `max_attempts`, and records delivered or failed state.
Long output is split into independent rows with deterministic
`:part:i/N` idempotency keys. `getDeliveryCheckpoint()` reports aggregate and
per-part status so a retry resumes without resending completed parts.

`attachment-store.js` stages attachments, validates size, computes SHA-256, and
stores either durable content or a controlled artifact path. Failed enqueue
cleans staged artifacts. Agent prompt consumption cannot claim outbox rows.

Completion delivery ownership is scoped to the tuple of task label, session,
and run, not only the task label or session. Both `dispatch done` and routed
watchers must acquire that claim and enqueue through `delivery_outbox`; they do
not send completion output through the agent inbox. A routed watcher writes no
delivery body to stdout and emits `WATCHER_ALREADY_DELIVERED` after durable
enqueue. That legacy-named marker is an enqueue ownership signal for the
scheduler wrapper, not a channel delivery receipt. The completion debt remains
open until reconciliation confirms every outbox part is delivered. A route-less
watcher retains stdout compatibility after acquiring its claim. Claim-store
errors fail closed as `COMPLETION_CLAIM_UNAVAILABLE`.

Legacy completion schemas reserve one active scope and reject stale-run claims.
Schema migration 28 rebuilds legacy completion debts transactionally and
derives their delivery scope without discarding existing rows. A successful
watcher result resets both 529 overload and Gateway-restart retry counters,
including when completion is observed exactly at the deadline.

## Governance

`governance.js` evaluates every job before execution.

- Fresh shell jobs default to `shell_env_policy: "minimal"`.
- Migrated shell jobs explicitly retain `shell_env_policy: "inherit"` and emit
  a warning. Inherit exposes the scheduler's complete process environment,
  including any bearer or master credentials stored there.
- A requested sandbox, restricted network, allowed-path boundary, or agent cost
  cap is denied unless the executor reports real enforcement.
- Identity, trust, proof, authorization, and credential handoff failures remain
  fail closed.
- Materialized credential values are cleared during cleanup paths.
- Provider sessions are released only after an explicit not-revoked result;
  missing, malformed, or indeterminate revocation responses fail closed.
  Newly resolved, refreshed, or adopted sessions that are already expired are
  rejected before persistence or credential materialization.
- Provider results must match every immutable presentation binding by name,
  medium, environment key, file name, cardinality, and required state before
  any value is exposed. Stdin credentials are piped to shell stdin and cleared
  with the rest of the materialization.
- Delegation validation enforces declared mode, maximum depth, allowed
  delegators, per-hop grants, cycles, and provider denial before execution.
- `authorization_ref` resolves only through a loaded provider implementing
  `resolvePolicy()` or `resolveAuthorization()`; all resolution failures deny.
- Shell credential handoff materializes locally. Isolated-agent handoff requires
  Gateway capability `chat-completions-env-inject-v1` before the scoped
  `x-openclaw-env-inject` header is sent. Main-session materialization is
  rejected. Auth-profile-only isolated jobs remain backward compatible.

The default host executor does not claim container, namespace, firewall,
filesystem, or agent-cost isolation.

## Evidence Contract

Handoff versions 1 through 3 retain the scheduler-native checksum backend. It
accepts a legacy checksum declaration or `provider: "sha256"`/`"checksum"`,
omitted methods or exactly `methods: ["sha256"]`, `verify.required: false`, and
canonical JSON payload format.

Handoff v4 consumes the complete AgentCLI evidence declaration. The runtime
builds a canonical evidence payload from the exact artifact, runtime instance,
source lineage, identity, proof, authorization, command result, structured
output, postcondition, and terminal status. The selected AgentCLI evidence
provider signs or externally verifies that payload. The scheduler persists the
envelope only after verification succeeds when verification is required. It
never downgrades a signed or provider-verified declaration to checksum evidence.

Result evidence binds the SHA-256 digest and byte count of complete stdout and
stderr, including offloaded artifacts rather than their database excerpts.
Re-verification reloads the immutable artifact named by the historical run,
not the job's current artifact, and rejects missing or modified offloaded
output. A finite v4 retention policy permits deletion only after its persisted
deadline; pruning first validates the immutable envelope binding and leaves an
auditable run tombstone.

Cryptographic evidence also snapshots its audit-safe provider, principal, and
verification trust path. If normal run history or the owning job is removed
before evidence retention expires, verification uses the retained signed
payload, immutable evidence row, and historical handoff artifact instead of
reporting the missing operational rows as an integrity failure.

The SSH provider uses `ssh-keygen -Y sign` and `ssh-keygen -Y verify` with the
declared key, principal, namespace, and allowed-signers file. Provider methods,
verification metadata, payload hash, artifact digest, and verification outcome
are immutable. `runs evidence RUN_ID --json` reconstructs the persisted
execution input and cryptographically re-verifies the envelope. Tampering,
transplantation, a stale artifact, or unavailable required verification exits
nonzero.

## Gateway Compatibility

`gateway-capabilities.js` discovers metadata only from explicit JSON capability
declarations returned by `GET /v1/info` or `GET /health`, then caches the
bounded result per Gateway for ordinary discovery. Before every isolated
request with a non-empty materialized environment, it force-refreshes that
metadata so a Gateway restart or downgrade cannot reuse a stale positive
result. The request requires `chat-completions-env-inject-v1`; missing support
fails before the credential-bearing chat request with
`GATEWAY_ENV_INJECT_UNSUPPORTED`. Plain-text health, JSON without an explicit
capability declaration, and current OpenClaw Gateway 2026.6.11 therefore
advertise no capabilities and fail closed for this surface.

`capabilities --json` advertises handoff version 4. Relevant exact feature
values are `evidence_generation: true`,
`checksum_evidence_generation: true`,
`evidence_integrity: "artifact-bound-signed-or-provider-verified-v4"`,
`evidence_contract: "agentcli-handoff-v4"`,
`handoff_v4_artifact: true`, `artifact_bound_proofs: true`,
`signed_or_provider_verified_evidence: true`, `provider_session_cache: true`,
`credential_presentation: true`, `source_run_bound_delegation: true`, and
`immutable_runtime_events: true`. The legacy checksum capability remains
advertised separately for earlier handoff consumers. Other exact values include
`approval_scope_enforcement: false`,
`gateway_capability_discovery: true`,
`gateway_env_injection_negotiation: true`,
`multipart_delivery_checkpoints: true`, and
`completion_delivery_scope: "run"`.

The handoff v4 scheduler-job digest also binds `job_type` and every watchdog
execution input: target label, a SHA-256 digest of the check command, timeout,
alert route, self-destruction policy, and start timestamp. Synchronous isolated
and main-session v4 requests require a fresh artifact-bound Gateway capability
binding. Main-session fire-and-forget is rejected for v4 because the
system-event CLI has no binding transport; legacy jobs retain that mode.

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
4. both scheduler-agentcli integration suites when a checkout is present;
5. shared positive and negative v4 conformance fixtures in both repositories;
6. a public fresh-database v4 E2E that restarts the runtime, executes schedule,
   one-shot, manual, chain, and retry dispatches, and cryptographically verifies
   persisted evidence and exactly-once delivery.

`npm run verify:local` adds lint, type checking, coverage, and a package dry run.
An absent local agentcli checkout is reported explicitly. `npm run
test:agentcli` requires it. CI uses the smoke gate without the extra coverage
pass and has separate required compatibility jobs against the exact published
AgentCLI package and the retained handoff v2 compatibility commit.
