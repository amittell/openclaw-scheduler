# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-03-08

First public release.

### Added
- Watchdog job type for long-running task monitoring, including dedicated watchdog fields, CLI support, dispatcher handling, and config example scaffolding
- Structured shell failure persistence on runs: exit code, signal, timeout flag, stdout, and stderr
- Richer shell-failure context for triggered agent follow-up jobs

### Fixed
- Shell retries now honor the normal retry ladder before firing failure children
- Consolidated migration skip logic now checks for actual column presence instead of relying on version markers alone
- Public-facing docs/examples no longer include private hostnames or deployment-specific Telegram identifiers

### Changed
- Schema baseline is now `v13`
- Updated test baseline to `534 passed`

## Pre-public development milestones

The sections below describe internal development milestones that were not published as external package releases.

### 2026-03-05 — internal milestone (formerly 1.0.3)

### Fixed
- Seeded `Dispatch 529 Recovery` job now uses valid shell dispatch fields and is immediately schedulable (`next_run_at` set)
- Added seed reconciliation for existing DBs to auto-repair legacy/invalid recovery job rows
- Watcher timeout recovery now avoids steer/kill escalation when token telemetry is unavailable
- Dispatch path handling now uses robust home-directory resolution (no literal `~` fallback paths)
- Replaced watcher-state probe dependency on external `sqlite3` CLI with direct read-only `better-sqlite3` query

### Changed
- Updated release/docs metadata to reflect latest test baseline (`445 passed`) and version history

---

### 2026-03-03 — internal milestone (formerly 1.0.2)

### Added
- Team-aware message routing fields on `messages`: `team_id`, `member_id`, optional `task_id`
- Explicit message receipt audit trail via `message_receipts` (delivery attempts/errors/acks)
- Team adapter module (`team-adapter.js`) with:
  - Message projection to `team_mailbox_events`
  - Team task projection to `team_tasks`
  - Task completion gates backed by `task_tracker` groups
- CLI team operations:
  - `team map`, `team tasks`, `team events`, `team gate`, `team check-gates`, `team ack`
  - `msg receipts`, `msg ack`, `msg team-inbox`

### Changed
- Bumped schema baseline to `v10` in `schema.sql` and `migrate-consolidate.js`
- Dispatcher now runs team adapter mapping + gate checks in message-delivery loop
- Inbox consumer now records delivery attempts and explicit ACKs for consumed messages
- Added release quality scripts: `npm run lint` (ESLint v9) and `npm run coverage` (V8 coverage + lcov)

---

### 2026-03-02 — internal milestone (formerly 1.0.1)

### Changed
- Consolidated schema management into `schema.sql` + `initDb()` reconciliation (no standalone `migrate-v*` scripts)
- Set schema baseline to v8 and ensured idempotency/session indexes are created from baseline
- Updated shell default on native Windows to `cmd.exe` (`SCHEDULER_SHELL` override still supported)

### Fixed
- Auto-reconciliation now adds `task_tracker_agents.session_key` and `last_heartbeat` for legacy/pre-release DBs

---

### 2026-02-26 — internal milestone (formerly 1.0.0)

### Added
- Full documentation (README, INSTALL guides, CHANGELOG)
- MIT license
- Proper package.json metadata

---

### 2026-02-25 — internal milestone (formerly 0.7.0)

### Added
- **Idempotency ledger** — `idempotency_ledger` table prevents double-dispatch on concurrent ticks
- **At-least-once delivery** — `delivery_guarantee` field; crashed runs replay on next startup (`replay_of` tracking)
- **Crash replay** — `replayOrphanedRuns()` runs on startup, replays at-least-once jobs
- **Context retrieval** — `context_retrieval` field (`none`/`recent`/`hybrid`); injects prior run summaries into job prompt
- **HITL approval gates** — `approval_required`, `approval_timeout_s`, `approval_auto` fields; `approvals` table; CLI `approve`/`reject` commands
- **Task tracker** — dead-man's-switch for multi-agent sub-agent teams; `task_tracker` + `task_tracker_agents` tables
- **Typed messages** — new message kinds: `decision`, `constraint`, `fact`, `preference`; `owner` field on messages; priority-ordered inbox

---

### 2026-02-24 — internal milestone (formerly 0.6.0)

### Added
- **Shell job target** — `session_target: 'shell'` runs payload as shell command via `/bin/zsh`; no gateway dependency
- **`announce-always` delivery mode** — posts output regardless of exit code (contrast with `announce` = failure only)
- **MinIO backup** — `backup.js` snapshots DB to MinIO every 5 minutes; hourly rollups; restore support
- **Resource pools** — `resource_pool` field prevents concurrent execution across different jobs sharing a resource
- **Delivery aliases** — `delivery_aliases` table maps short names (e.g., `@team_room`) to `channel`+`target` pairs
- **WAL checkpoint on prune cycle** — forces in-memory WAL to disk every hour

---

### 2026-02-23 — internal milestone (formerly 0.5.0)

### Added
- **Retry logic** — `max_retries` + `retry_delay_s`; retries before triggering failure children; `retry_of`/`retry_count` tracking on runs
- **Max chain depth** — `MAX_CHAIN_DEPTH = 10`; enforced at create, update, and runtime
- **Chain cancellation** — `jobs cancel <id>` cascades to all running descendant runs
- **Overlap policy queue** — `overlap_policy: 'queue'` queues dispatch instead of skipping
- **Output-based trigger conditions** — `trigger_condition: 'contains:TEXT'` or `'regex:PATTERN'`

---

### 2026-02-22 — internal milestone (formerly 0.4.0)

### Added
- **Workflow chains** — `parent_id`, `trigger_on` (`success`/`failure`/`complete`), `trigger_delay_s`
- **Cycle detection** — `detectCycle()` prevents circular chains at create/update time
- **Spawn messages** — running jobs can request child job creation via `kind: 'spawn'` message
- **Multi-agent dispatch** — chains can target different agent IDs per step
- **`jobs tree` CLI** — visualize chain hierarchy

---

### 2026-02-21 — internal milestone

### Added
- Initial release
- Jobs, runs, messages, agents tables
- Cron scheduling via `croner`
- Dispatch via OpenClaw chat completions API (`/v1/chat/completions`)
- Isolated session dispatch (unique session per run)
- Main session dispatch via system event
- Delivery to Telegram/channel on job completion
- Inter-agent message queue with priority, threading, TTL
- Agent registry with status tracking
- Error backoff (30s → 1m → 5m → 15m → 1h)
- Stale run detection and timeout enforcement
- `migrate.js` — import jobs from OC `cron/jobs.json`
- CLI for job, run, message, agent management
- macOS LaunchAgent template
