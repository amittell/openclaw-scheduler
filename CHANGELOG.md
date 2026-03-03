# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] — 2026-03-02

### Changed
- Consolidated schema management into `schema.sql` + `initDb()` reconciliation (no standalone `migrate-v*` scripts)
- Set schema baseline to v8 and ensured idempotency/session indexes are created from baseline
- Updated shell default on native Windows to `cmd.exe` (`SCHEDULER_SHELL` override still supported)

### Fixed
- Auto-reconciliation now adds `task_tracker_agents.session_key` and `last_heartbeat` for legacy/pre-release DBs

---

## [1.0.0] — 2026-02-26

First public release. Combines all prior development into a stable, documented package.

### Added
- Full documentation (README, INSTALL guides, CHANGELOG)
- MIT license
- Proper package.json metadata

---

## [0.7.0] — 2026-02-25

### Added
- **Idempotency ledger** — `idempotency_ledger` table prevents double-dispatch on concurrent ticks
- **At-least-once delivery** — `delivery_guarantee` field; crashed runs replay on next startup (`replay_of` tracking)
- **Crash replay** — `replayOrphanedRuns()` runs on startup, replays at-least-once jobs
- **Context retrieval** — `context_retrieval` field (`none`/`recent`/`hybrid`); injects prior run summaries into job prompt
- **HITL approval gates** — `approval_required`, `approval_timeout_s`, `approval_auto` fields; `approvals` table; CLI `approve`/`reject` commands
- **Task tracker** — dead-man's-switch for multi-agent sub-agent teams; `task_tracker` + `task_tracker_agents` tables
- **Typed messages** — new message kinds: `decision`, `constraint`, `fact`, `preference`; `owner` field on messages; priority-ordered inbox

---

## [0.6.0] — 2026-02-24

### Added
- **Shell job target** — `session_target: 'shell'` runs payload as shell command via `/bin/zsh`; no gateway dependency
- **`announce-always` delivery mode** — posts output regardless of exit code (contrast with `announce` = failure only)
- **MinIO backup** — `backup.js` snapshots DB to MinIO every 5 minutes; hourly rollups; restore support
- **Resource pools** — `resource_pool` field prevents concurrent execution across different jobs sharing a resource
- **Delivery aliases** — `delivery_aliases` table maps short names (e.g., `@team_room`) to `channel`+`target` pairs
- **WAL checkpoint on prune cycle** — forces in-memory WAL to disk every hour

---

## [0.5.0] — 2026-02-23

### Added
- **Retry logic** — `max_retries` + `retry_delay_s`; retries before triggering failure children; `retry_of`/`retry_count` tracking on runs
- **Max chain depth** — `MAX_CHAIN_DEPTH = 10`; enforced at create, update, and runtime
- **Chain cancellation** — `jobs cancel <id>` cascades to all running descendant runs
- **Overlap policy queue** — `overlap_policy: 'queue'` queues dispatch instead of skipping
- **Output-based trigger conditions** — `trigger_condition: 'contains:TEXT'` or `'regex:PATTERN'`

---

## [0.4.0] — 2026-02-22

### Added
- **Workflow chains** — `parent_id`, `trigger_on` (`success`/`failure`/`complete`), `trigger_delay_s`
- **Cycle detection** — `detectCycle()` prevents circular chains at create/update time
- **Spawn messages** — running jobs can request child job creation via `kind: 'spawn'` message
- **Multi-agent dispatch** — chains can target different agent IDs per step
- **`jobs tree` CLI** — visualize chain hierarchy

---

## [0.1.0] — 2026-02-21

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
