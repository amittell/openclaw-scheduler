# Context

## Problem

Current OpenClaw already provides durable SQLite cron state, command jobs,
retries, run history, Task Flow, and approval tooling. Some operators still
need a scheduler outside the Gateway process so shell jobs continue during
Gateway downtime, or need direct conditional shell and agent graphs under one
local governance and delivery contract.

## Repository Position

`openclaw-scheduler` is that continuity and governed-workflow sidecar.

- It runs shell jobs without the Gateway.
- It calls the Gateway for isolated or main-session agent work.
- It owns leased dispatch state, fenced runs, atomic approvals, retries,
  conditional children, a transactional delivery outbox, and audit history.
- It can be driven directly by operators and agents or by
  `@amittell/agentcli` manifests.
- It is not a replacement for ordinary native OpenClaw cron jobs.

## Version 0.3.0 Design Bias

- schema version 27 in local SQLite with WAL and foreign keys enabled
- fail-closed schema initialization and migration
- one dispatcher lease with monotonically fenced ownership
- bounded concurrent workers rather than a globally serial tick
- durable cancellation with shell process-group termination and best-effort
  Gateway abort for agent sessions
- atomic completion, job update, and child enqueue
- external delivery separate from agent prompt messages
- minimal shell environment for fresh jobs; explicit `inherit` for migrated jobs
- governance requests denied when the selected executor cannot enforce them
- explicit positive `run_timeout_ms` on every authored job
- authoritative status comes from direct CLI/database queries, never from stale
  asynchronous chat notifications

## Control Plane Boundary

`@amittell/agentcli` owns declarative workflow and identity/authorization
manifests. OpenClaw Scheduler owns execution state. Native OpenClaw owns
Gateway-local cron and flow behavior. The same side effect must not remain
enabled in more than one runtime.
