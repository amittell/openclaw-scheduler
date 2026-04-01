# Changelog

All notable changes to this project will be documented in this file.

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
