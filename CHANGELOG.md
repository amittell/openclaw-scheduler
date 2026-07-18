# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] -- 2026-07-18

### Security

- replaced native regular-expression evaluation for user-authored
  `trigger_condition` values with the exact-pinned, linear-time RE2JS engine;
  unsupported legacy patterns now fail closed and regex input is bounded
- rejected unsafe agent identifiers and session keys at job, dispatch, Gateway,
  registry, and filesystem boundaries, with lexical and canonical containment
  checks protecting OpenClaw session stores from traversal and symlink escapes
- encoded persisted session keys as a single Gateway URL path segment so label
  metadata cannot redirect an authenticated activity check to another endpoint
- replaced interpolated installer shell commands with argv-based process
  execution and hardened systemd value encoding against quote, backslash, and
  control-character injection; launchd service files that may contain Gateway
  credentials are now created with owner-only permissions
- made dispatcher timing, lease, queue, batch, and boolean environment settings
  use exact, safe-integer, bounded parsing so malformed or overflowing values
  fail startup instead of creating hot loops or unbounded runtime settings

### Changed

- kept GitHub as the release authority for tag-triggered npm OIDC publication
  while mirroring GitHub branches and tags to WritHub with a repository-scoped
  credential and non-force, atomic ref updates
- made maintenance timeout recovery commit terminal evidence and job or retry
  bookkeeping in one transaction, and reconcile already-terminal schedule rows
  whose job schedule update was interrupted
- normalize the legacy `announce-on-output` delivery mode to the current
  output-preserving `announce-always` contract and fail closed on unknown
  persisted delivery modes
- bounded session IDs so the `.jsonl` transcript suffix remains within the
  portable 255-byte filename-component limit
- invalid persisted dispatch/session metadata now reports a deterministic error
  and fails closed without accessing paths outside the configured OpenClaw roots
- malformed existing dispatch label ledgers remain byte-for-byte intact and
  reject every mutating command until an operator repairs the ledger
- malformed or unsupported persisted trigger regexes no longer crash or block
  the dispatcher and cannot trigger child jobs

## [0.4.0] -- 2026-07-13

### Added

- schema v28 handoff fields for approval risk/scope, structured output,
  delegation results, immutable evidence, and run-scoped completion delivery
- approval gates for every durable dispatch kind, including scheduled,
  one-shot, manual, chain, and retry work, with SHA-256 execution bindings and
  OS-authenticated bare/exact, local-user, UID, or local-principal scopes
- `json`, `ndjson`, and `text` output contracts with persisted validation state
  plus byte counts, SHA-256 digests, and artifact references for large values
- post-success shell verification with bounded execution, fenced cancellation,
  `error` or `warn` policies, digest-only audit metadata, and terminal evidence
- provider-backed `authorization_ref` resolution, provider-independent
  delegation-chain validation, and immutable `json-sort-v1` SHA-256 evidence
  records that exclude raw credentials
- immutable per-run execution, evidence-declaration, and reference snapshots so
  evidence remains bound to the configuration that actually started even when
  a job is later edited or deleted
- terminal evidence coverage for normal completion, cancellation, timeout,
  authorization rejection, crash recovery, and recovery quarantine, with
  retention tombstones and corruption-aware pruning
- fail-closed evidence validation for unsupported external providers such as
  `ssh` or `none`, non-SHA-256 methods, and required signature verification;
  the built-in backend is checksum-only
- Gateway capability discovery through explicit JSON capability metadata from
  `GET /v1/info` or `GET /health`, with bounded parsing and a per-Gateway cache
- forced Gateway capability refresh before every credential-bearing isolated
  request, so a restart or downgrade cannot reuse stale positive capability
  metadata; current OpenClaw Gateway 2026.6.11 advertises no capabilities and
  therefore fails closed for task-scoped environment injection
- per-request Gateway token-file reads so bearer-token rotation no longer
  requires restarting the scheduler process
- capability-negotiated task credential injection for isolated agent jobs using
  `chat-completions-env-inject-v1` and `x-openclaw-env-inject`
- scheduler capability flags `gateway_capability_discovery` and
  `gateway_env_injection_negotiation` for handoff v3 consumers
- run-scoped completion ownership, durable per-part delivery checkpoints, and
  capability flags `completion_delivery_scope: "run"` and
  `multipart_delivery_checkpoints: true`
- handoff v3 capability declarations for `root_approval_gate`,
  `structured_output_format`,
  `delegation_validation`, and `authorization_ref_resolution`; the runtime
  advertises `approval_scope_enforcement: false` so agentcli scoped manifests
  fail negotiation instead of partially accepting unsupported domain scopes,
  honestly advertises `evidence_generation: false` for agentcli evidence plus
  `checksum_evidence_generation: true` and
  `evidence_integrity: "checksum-sha256-v3"` for its native evidence records
- required hosted compatibility jobs against exact public agentcli commits for
  handoff v3 (`f1fed6d7d451196bda316b82d6567b174012a4ba`) and backward-compatible
  handoff v2 (`317cc0eea8b4c65bc3213f5f329124a45c958bd3`)
- a release-gating black-box test against the signed and attested published
  `@amittell/agentcli@0.4.1` package, including task working-directory and
  sanitized runtime-environment parity for post-success verification
- full upstream handoff v3 integration coverage without excluded assertions,
  plus producer-to-terminal approval tests for schedule, one-shot, manual,
  chain, and retry dispatches

### Changed

- malformed JSON or NDJSON now records a nonfatal structured-output warning
  and null parsed value while preserving successful execution and child flow
- approval bindings include immutable dispatch and lineage identity, approved
  work rechecks OS-authenticated scope at consumption, and execution runs retain
  the approval-use snapshot; pending approvals from earlier binding versions
  must be retriggered after upgrade
- approval creation, consumption, and crash recovery now correlate job, run,
  dispatch, and exact approval identity before mutating or resuming work
- manual execution now rejects disabled jobs before queueing, matching every
  other dispatch kind and preventing a disabled job from bypassing governance
- `doctor` bounds ordinary evidence verification to the newest 500 records and
  reports incomplete coverage; `doctor --deep` verifies the complete set
- native evidence payloads use checksum contract v3 and bind structured-output
  and verification metadata while retaining v2 verification compatibility
- `identity.presentation` and `credential_handoff` may materialize credentials
  for shell jobs locally and for isolated agent jobs through a capable Gateway;
  main-session agent jobs continue to reject credential materialization
- approval decisions now use the invoking OS account through
  `approvals approve/reject APPROVAL_ID`; caller-supplied approver identity and
  domain scopes are rejected, while legacy job-ID commands resolve only the
  current pending gate
- legacy or current Gateways that do not advertise environment injection now
  fail closed with `GATEWAY_ENV_INJECT_UNSUPPORTED` before a credential-bearing
  agent request is sent; auth-profile-only isolated turns remain compatible
- isolated dispatch leaves auth-store ownership with the running Gateway and
  no longer copies credential files between agent scopes, avoiding obsolete
  file-store warnings and unsafe OAuth refresh-token duplication
- Gateway token-file paths are canonicalized before every read and accepted
  only beneath `~/.openclaw/credentials`, `/run/secrets`, or
  `/var/run/secrets`; paths outside those roots and symlink escapes are rejected
- Windows support is consistently WSL2-only across setup, install, upgrade, and
  uninstall guidance
- GitHub Actions are pinned to immutable action commits, and npm publication is
  performed only by the tag-triggered provenance workflow after confirming the
  tagged commit is contained in `origin/main`
- dispatch spawn confirmation now inspects an already-present session before
  waiting for retry intervals while preserving the complete 30-second failure
  window, reducing enqueue latency and repeated local/CI test time
- the npm tarball includes the complete lint, typecheck, test, documentation,
  coverage, and verification harness referenced by its published scripts
- package verification now installs the packed tarball into an isolated
  production consumer, type-checks its public declarations with library checks
  enabled, and verifies the installed CLI version
- public TypeScript declarations no longer require consumers to install
  `better-sqlite3` or ambient Node types merely to type-check scheduler APIs
- dispatch completion from both `done` and routed watchers now enters only the
  delivery outbox; routed watchers emit `WATCHER_ALREADY_DELIVERED` with no
  delivery body on stdout, while route-less watchers retain stdout
  compatibility. The marker prevents wrapper duplication but is not a channel
  delivery receipt
- a completion debt remains open after durable enqueue and closes only after
  every outbox part is actually delivered
- completion claim-store failures fail closed as
  `COMPLETION_CLAIM_UNAVAILABLE`, and legacy completion schemas reserve the
  active run so a stale run cannot take its delivery claim
- multipart output uses independently retryable outbox rows with deterministic
  `:part:i/N` idempotency keys and queryable delivery checkpoints
- ordinary scheduler announcements use the same durable multipart rows and
  enforce predecessor ordering even through direct outbox claim APIs
- successful watcher completion resets both overload and Gateway-restart retry
  counters, including completion observed exactly at the deadline
- dispatch prompts include a literal checkpoint command without claiming that
  a `CHECKPOINT_NOTIFY_CMD` environment variable exists
- updated `better-sqlite3` to 12.11.1, ESLint to 10.7.0, and `globals` to 17.7.0
  while retaining TypeScript 5
- Dependabot now proposes weekly npm and GitHub Actions updates

### Migration Notes

- migration 28 transactionally rebuilds legacy `completion_debts` rows with a
  derived delivery scope, creates `evidence_records`, adds multipart
  `delivery_group_id`/`part_index`/`part_count` coordinates and indexes to the
  outbox, preserves existing data, and records schema version 28
- rerunning migration 28 repairs any missing required correctness index instead
  of treating a version marker alone as proof that the schema is complete
- run `openclaw-scheduler doctor --json` after upgrade and use
  `openclaw-scheduler runs evidence RUN_ID --json` to verify generated evidence

## [0.3.0] -- 2026-07-11

### Added

- schema v27 dispatcher leases, fencing tokens, run ownership, durable cancellation fields, leased dispatch claims, atomic approval audit fields, a transactional delivery outbox, and durable attachment integrity metadata
- bounded dispatcher worker ownership so one long run does not block scheduler maintenance or unrelated dispatches
- independent lease renewal during slow gateway, delivery, provider, and recovery operations
- process-group identity tracking and confirmed termination for shell timeout, cancellation, and crash recovery, plus OpenClaw `chat.abort` confirmation for active agent sessions
- fail-closed `recovery_blocked` quarantine when crash recovery cannot prove the original process or agent turn stopped
- execution-time governance decisions and a minimal-by-default shell environment; migrated jobs retain explicit `shell_env_policy: "inherit"`
- `doctor` and expanded `status` diagnostics for live lease, queue, outbox, approval, cancellation, cleanup debt, SQLite integrity, foreign keys, and schema state
- job JSON input through `--file` or `--stdin`
- a current OpenClaw CLI importer with structured dry-run reports, exact cron and one-shot preservation, explicit legacy JSON mode, and opt-in interval approximation

### Changed

- repositioned the project as an OpenClaw continuity and governed-workflow sidecar; native OpenClaw remains the default for ordinary cron, command, history, retry, Task Flow, and approval needs
- database schema and consolidation failures now stop initialization
- external delivery is separated from agent prompt messages and committed through the outbox
- delivery claims heartbeat throughout slow chunked sends; idempotency collisions are rejected unless payloads are equivalent
- terminal delivery and attachment retention is bounded, including filesystem artifact cleanup and outer-transaction rollback safety
- run completion, job state, and child dispatch enqueue are committed atomically
- cancellation closes claimed dispatches atomically before run creation, while preparing runs are protected from concurrent health finalization
- approval resolution uses versioned atomic transitions and rechecks disabled or cancelled state before dispatch
- credential cleanup is retried, persisted as an operator-visible failure on exhaustion, and disables the affected job without repeating user work
- `npm test` now runs the legacy suite, every focused test file sequentially with isolated databases, documentation validation, and sibling `agentcli` integration when available
- package and documentation references use `@amittell/agentcli`

### Migration Notes

- the default job importer now calls `openclaw cron list/get --json`; pass `--legacy-json` only for an old export
- interval schedules that five-field cron cannot represent exactly fail unless `--allow-inexact-every` is explicitly selected
- run `openclaw-scheduler doctor --json` after upgrading and before restarting destructive workflows
- keep a pre-upgrade database backup until scheduler and rollback verification are complete

## [0.2.17] -- 2026-07-04

### Fixed
- fix(gateway): detect in-band tool failures (`result.isError` / `ok:false`) on message delivery so a failed send is recorded as a failed attempt and retried instead of being silently acked; normalize non-Error throws and keep failure detection to the verified gateway contract
- feat(messages): idempotent completion enqueue via a deterministic `idempotency_key` (schema v26) so a crash-retry or a second delivery path for the same run's completion collapses to one message row instead of a duplicate announce

## [0.2.16] -- 2026-07-03

### Fixed
- fix(dispatch): treat gateway terminal session status (`timeout`/`failed`/`killed`) as authoritative for liveness so interrupted sessions resolve immediately instead of waiting out the watcher heartbeat ceiling; a clean `done` status is left to the normal completion path
- fix(dispatch): preserve the agent-authored completion summary via `summaryStyle` so archived status/result/list views keep the real words while delivery still leads with a humanized summary
- fix(dispatch): guarantee a completion announce from the done payload through the post-office, backed by a durable `completion_debts` table and an atomic single-writer delivery claim so the done-path and watcher never double-deliver
- fix(dispatch): define `completion_debts` in the canonical schema and migration (schema v25) so completion-debt tracking works on fresh and upgraded installs instead of silently no-oping
- fix(gateway): detect in-band tool failures (`result.isError` / `ok:false`) on message delivery so a failed send is recorded as a failed attempt and retried instead of being silently acked
- fix: prefer the runtime scheduler DB path
- fix(dispatch): classify aborted watcher artifacts

## [0.2.15] -- 2026-06-29

### Fixed
- Ensure npm install scripts run for the scheduler package so native dependencies such as `better-sqlite3` build correctly during host installs.

## [0.2.14] -- 2026-06-28

### Fixed
- fix(dispatch): honor configured dispatch default models from wrapper config, `DISPATCH_DEFAULT_MODEL`, and OpenClaw agent defaults before falling back to the static default
- fix(dispatch): verify interrupted sessions before marking watcher failures
- fix(dispatch): prefer human completion summaries in delivery flows

### Changed
- chore: upgrade coord to v0.35.0
- docs(dispatch): retire old chilisaus fork paths and document migrated dispatch configuration

## [0.2.13] -- 2026-06-24

### Fixed
- fix(dispatch): prefer structured completion payloads for chilisaus status/result/list summaries before falling back to generic label summaries or transcript text

## [0.2.12] -- 2026-06-23

### Changed
- docs(dispatch): document that `dispatch done` must run from the originating local dispatch shell and that terminal-output watcher fallback requires strict clean completion evidence

## [0.2.11] -- 2026-06-23

### Fixed
- fix(dispatch): clarify that completion markers must run in the originating local dispatch shell, and allow watcher delivery from clean terminal `stop_reason=end_turn` replies without broadening plain `lastReply` success detection
- fix(watcher): use the fatal idle threshold for stalled-session errors while keeping quiet high-thinking sessions pending at the probe threshold

## [0.2.5] -- 2026-04-27

### Fixed
- fix(dispatch): make completion prompts task-aware so `dispatch done` no longer implies `tests_passed:true` / `pushed:true` for tasks that explicitly should not push or do not require tests
- fix(dispatch): recover completion text conservatively from terminal assistant turns instead of treating arbitrary mid-task chatter as the final delivery payload
- fix(watcher): surface real missed-`done` final reports as interrupted diagnostics instead of silently timing out without useful delivery context
- fix(dispatch): prefer structured, human-readable completion summaries and suppress generic/internal completion noise in announce flows
- fix(dispatch): preserve embedded completion summaries, prefer explicit delivery targets for origin detection, and normalize dispatched completion delivery behavior
- fix(dispatch): harden literal-safe prompt input handling and watcher SIGTERM handoff during delivery/recovery paths

### Added
- feat(dispatch): prefer structured human completion summaries in dispatch delivery flows
- feat(dispatch): add inbox watcher delivery guardrail to catch broken packaged-layout consumer wiring earlier

## [0.2.4] -- 2026-04-18

### Fixed
- fix(package): include dispatch/completion.mjs in the published npm tarball so dispatch CLI and watcher startup no longer crash with ERR_MODULE_NOT_FOUND in installed deployments

## [0.2.3] -- 2026-04-16

### Fixed
- fix(cli): harden runtime DB path resolution so installed package layouts prefer `~/.openclaw/scheduler/scheduler.db` instead of a repo-local checkout DB
- fix(cli): refuse validation-only commands (`jobs validate`, `jobs add --dry-run`) when a source checkout detects an existing runtime DB mismatch
- test(cli): add installed-package and repo/runtime mismatch coverage for DB path hardening

### Changed
- docs: bump minimum supported Node.js version from 20 to 22 to match the package engine requirement

## [0.2.2] -- 2026-04-15

### Fixed
- fix(dispatch): make completion delivery deterministic
- fix(dispatch): suppress junk completion fallbacks
- fix(package): include provider registry in npm tarball
- fix(scheduler): canonicalize isolated session auth overrides
- fix(dispatch): delete watchdog jobs on disarm instead of disable to prevent accumulation

### Added
- feat(watcher): add stop_reason-based early delivery (Path 2a)
- feat(dispatch): auto-inject ORIGIN_CHAT_ID from deliverTo into prompt
- fix(dispatch): prefer group sessions over DM in auto-detected origin

### Changed
- ci: upgrade checkout and setup-node actions to v5
- docs: align packaged runtime path with host layout
- docs: document local npm pack install and upgrade flow
- test: remove dead locals in watcher coverage

## [0.2.1] -- 2026-04-01

### Fixed
- fix(watcher): exit cleanly when session status=done (PR #1)
- fix(watchdog): prevent auto-resolving active sessions with heartbeat + hard ceiling (PR #2)
- fix(gateway): reset idle timer while fetch is in flight (PR #3)
- fix(watcher): prevent premature kill of active subagent sessions with JSONL activity signal (PR #7)
- fix(db): add SQLite busy_timeout (5s) to prevent SQLITE_BUSY on CLI + dispatcher contention
- fix(approvals): prevent double-dispatch race on auto-approved jobs
- fix(watcher): cap deadline extension at min(timeout, 4h) to prevent zombie watchers
- fix(runs): preserve empty string summary/error_message (use ?? instead of ||)
- fix(runs): guard getTimedOutRuns against NULL run_timeout_ms on legacy rows
- fix(gateway): use byte length for Telegram message chunking (4096-byte limit)
- fix(jobs): validate schedule_tz as real IANA timezone via Intl.DateTimeFormat
- fix(dispatcher): wrap delete_after_run cleanup in transaction
- fix(dispatch): remove 4000-char truncation in formatMessageForDelivery
- fix(dispatch): add retry exception path delivery announcement
- fix(dispatch): fix dispatch CLI subcommand routing in bin wrapper

### Added
- feat: v0.2 runtime with identity/trust/authorization/evidence/credential handoff (PR #4)
- feat: x-openclaw-env-inject header for agent task credentials (PR #5)
- feat: [IMAGE:path] marker protocol for shell job image attachments
- feat: auto-delete watcher and watchdog jobs after completion (delete_after_run)
- feat(jobs): add durable payload_model_fallback/auth_profile_fallback fields with same-run fallback retry
- feat: enforce delivery_to as required field on job INSERT
- feat: multi-platform CI (Linux, macOS, Windows)
- docs: trust architecture, multi-agent gateway routing, agent adoption files
- docs: AGENTS.md, CONTEXT.md, JOB-QUICK-REF.md for agent adoption

### Changed
- chore: replace non-ASCII characters with ASCII equivalents (PR #6)
- chore: bump output_excerpt_limit and output_summary_limit defaults to 64KB

## [0.2.0] -- 2026-03-11

### Added
- Strategy pattern refactor: decomposed 614-line `dispatchJob` closure into explicit `DispatchContext` + strategy functions (`prepareDispatch`, `executeStrategy`, `finalizeDispatch`) in new `dispatcher-strategies.js`
- Auth profile resolution for isolated agent turns: `auth_profile` field on jobs supports `'inherit'` (looks up main session profile) or explicit `'provider:label'`
- Drain-error retry: transient infrastructure errors (HTTP 529) bypass normal retry ladder and re-enqueue immediately
- One-shot `at`-style scheduling via `schedule_kind: 'at'` and `schedule_at` fields (schema v18)
- Complete TypeScript type coverage: 26 previously missing function signatures, 4 corrected return types, 51 missing schema columns added to `index.d.ts`
- Expanded type smoke tests from 23 to 192+ lines exercising all typed APIs
- 5 new test coverage areas: dispatcher-utils, dispatch-queue lifecycle, approval timeout/prune/count, run session/context, prompt-context edge cases
- `idempotency`, `taskTracker`, and `teamAdapter` modules now exported from `index.js` for programmatic consumers

### Fixed
- `updateJobAfterRun` null guard prevents crash when job is deleted mid-dispatch
- Shell timeout and retry exhaustion handling corrected
- Boolean job flags normalized for SQLite writes
- Numeric enabled flags treated as disabled on create
- Child jobs can no longer self-fire as autonomous one-shot schedules; due selectors are root-only
- Disabled future one-shot jobs are no longer pruned before they ever run
- Consolidation migration now backfills partial legacy message/task-tracker tables without noisy fallback errors

### Changed
- Default `schedule_tz` changed from `America/New_York` to `UTC` in schema, validation, and setup
- `--json` mode wired through all CLI subcommands (msg, tasks, team, queue, idem) via `emit()`/`fail()` helpers
- Dispatch subsystem portability: `process.execPath` replaces bare `node`, `__dirname`-relative paths replace hardcoded install paths
- Dispatcher reduced from ~1200 lines to ~850 lines; `dispatchJob` is now a 5-line orchestrator (strategy code lives in `dispatcher-strategies.js`)
- `buildDispatchDeps()` wires 36+ dependencies via dependency injection
- Full validation gate moved into local verification commands (`npm run verify:local` / `npm run verify:smoke`); GitHub Actions now runs a single lightweight smoke job
- Test baseline updated to 1410 passed
- Schema baseline is now v23

## [0.1.0] -- 2026-03-08

First public release.

### Added
- Watchdog job type for long-running task monitoring, including dedicated watchdog fields, CLI support, dispatcher handling, and config example scaffolding
- Durable dispatch queue for manual runs, retries, and chain-triggered executions, with persisted run causality via `dispatch_queue_id` and `triggered_by_run`
- Structured shell result persistence on runs: exit code, signal, timeout flag, stdout, and stderr
- Richer shell-failure context for triggered follow-up jobs and agent triage flows
- CLI improvements for machine use and release readiness, including `--json`, `jobs validate`, schema introspection, and improved npm-install defaults
- Safe typed root exports for programmatic tooling (`index.js` + `index.d.ts`)

### Fixed
- Shell timeouts are now classified correctly as `timeout`, with `shell_timed_out` persisted on runs
- Shell retries now exhaust correctly and fire failure children only after the retry ladder is complete
- Consolidated migration skip logic now checks for actual column presence instead of relying on version markers alone
- Runtime startup version logging now reads from `package.json` instead of a stale hardcoded string
- Public-facing docs/examples no longer include private hostnames or deployment-specific Telegram identifiers
- Node 20 compatibility by removing runtime dependence on `node:sqlite` and JSON import attributes

### Changed
- Schema baseline is now `v14`
- Added execution-intent fields, queue / approval / fan-out caps, shell-output offloading, and runtime budget visibility
- Tightened ESLint rules, added TypeScript declaration smoke tests, and enforced global coverage floors
- Extracted dispatcher approvals, delivery, maintenance, and shell helpers into dedicated modules
- Versioning reset to `0.1.0` as the first public release
- Updated verification baseline to `581 passed, 0 failed`

## Pre-release

Internal development versions consolidated into 0.1.0. See git history for details.
