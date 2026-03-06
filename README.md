# OpenClaw Scheduler

[![Tests](https://img.shields.io/badge/tests-388%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green)]()

A standalone job scheduler, workflow engine, and inter-agent message router for [OpenClaw](https://openclaw.ai). Replaces OpenClaw's built-in cron and heartbeat with a SQLite-backed system that dispatches jobs independently via the chat completions API — complete run history, workflow chains, retry logic, shell jobs, approval gates, and MinIO backup.

**Repo:** `github.com/amittell/openclaw-scheduler`
**Location:** `~/.openclaw/scheduler/`
**Service:** `ai.openclaw.scheduler` (macOS LaunchAgent)
**Runtime:** Node.js (ESM), SQLite via `better-sqlite3`, cron parsing via `croner`
**Tests:** 388 (full suite, in-memory SQLite)
**Platform:** macOS · Linux · Windows (WSL2)

---

## Table of Contents

1. [What Replaced What](#what-replaced-what)
2. [Quick Start](#quick-start)
3. [Platform Support](#platform-support)
4. [Architecture](#architecture)
5. [How Jobs Execute](#how-jobs-execute)
6. [Delivery Modes](#delivery-modes)
7. [Delivery Aliases](#delivery-aliases)
8. [Shell Jobs](#shell-jobs)
9. [HITL Approval Gates](#hitl-approval-gates)
10. [Idempotency](#idempotency)
11. [Context Retrieval](#context-retrieval)
12. [Task Tracker](#task-tracker)
13. [Resource Pools](#resource-pools)
14. [Workflow Chains](#workflow-chains)
15. [Retry Logic](#retry-logic)
16. [Chain Safety](#chain-safety)
17. [Inter-Agent Messaging](#inter-agent-messaging)
18. [Backup & Recovery](#backup--recovery)
19. [Agent Registry](#agent-registry)
20. [Database Schema](#database-schema)
21. [CLI Reference](#cli-reference)
22. [Configuration](#configuration)
23. [Service Management](#service-management)
24. [Error Handling & Backoff](#error-handling--backoff)
25. [Migration & History](#migration--history)
26. [Removing the Scheduler](#removing-the-scheduler)
27. [Best Practices](#best-practices)
28. [File Reference](#file-reference)
29. [Testing](#testing)
30. [Companion Scripts](#companion-scripts)
31. [Troubleshooting](#troubleshooting)

---

## What Replaced What

| Before (OC built-in) | After (scheduler) |
|----------------------|-------------------|
| `~/.openclaw/cron/jobs.json` | SQLite `jobs` table with full run history |
| `heartbeat.every: "5m"` | Scheduled jobs (e.g., "Daily Workspace Audit") |
| No run tracking | Full run lifecycle with status, duration, summary |
| No chain support | Parent/child jobs with trigger-on-completion |
| No retry | Auto-retry with configurable attempts and delay |
| No inter-agent comms | Message queue with priority, threading, broadcast |
| Shell scripts (manual) | Shell job target — cron-scheduled scripts, no gateway needed |

---

## Quick Start

```bash
git clone https://github.com/amittell/openclaw-scheduler ~/.openclaw/scheduler
cd ~/.openclaw/scheduler
npm install
npm test                             # should print: 445 passed, 0 failed
npm run lint                         # static checks
npm run coverage                     # coverage summary + lcov report
```

Then run the interactive setup wizard:

```bash
node setup.mjs
```

The wizard will:
- Run DB migrations
- Append scheduler queue/inbox-consumer entries to your agent's `MEMORY.md` and `workspace-index.md`
- Create **Inbox Consumer** + **Stuck Run Detector** scheduler jobs
- Install and load the macOS LaunchAgent (optional)

After setup:

```bash
node cli.js status                    # verify scheduler is running
node scripts/stuck-run-detector.mjs   # should print: No stale runs older than 15 minute(s).
tail -5 /tmp/openclaw-scheduler.log   # live logs
```

For full manual installation details, see [INSTALL.md](INSTALL.md).
For Linux and Windows (WSL2), follow [INSTALL-LINUX.md](INSTALL-LINUX.md). For WSL2 setup on Windows, see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).
For additional hosts, see [INSTALL-ADDITIONAL-HOST.md](INSTALL-ADDITIONAL-HOST.md).

---

## Platform Support

| Platform | Service Manager | Shell Jobs | Status |
|----------|----------------|------------|--------|
| macOS | LaunchAgent | `/bin/zsh` | ✅ Tested |
| Linux | systemd user service | `/bin/bash` | ✅ Supported |
| Windows (WSL2) | systemd (WSL2) / PM2 (WSL1) | `/bin/bash` | ✅ Supported |
| Windows (native) | — | — | ❌ Not supported — use WSL2 |

- **macOS:** Full guide in [INSTALL.md](INSTALL.md)
- **Linux:** Full guide in [INSTALL-LINUX.md](INSTALL-LINUX.md)
- **Windows:** Install WSL2, then follow [INSTALL-LINUX.md](INSTALL-LINUX.md). See [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) for WSL2 setup.

Override the shell for shell jobs with the `SCHEDULER_SHELL=/path/to/shell` environment variable.

---

## Architecture

The scheduler sits alongside the OpenClaw gateway as an independent process. It creates **isolated sessions** for each job — they never touch the user's main conversation.

```
┌─────────────────────────────────────────────┐
│  Host Machine (e.g., scheduler-host.local)  │
│                                              │
│  OpenClaw Gateway (:18789)                   │
│    ├─ Telegram / Discord / etc.              │
│    ├─ Chat completions endpoint (/v1/...)    │
│    ├─ Tool execution (exec, browser, k8s...) │
│    └─ Memory search                          │
│                                              │
│  Scheduler (LaunchAgent)                     │
│    ├─ SQLite DB (scheduler.db)               │
│    ├─ Job dispatch via chat completions      │
│    ├─ Workflow chain engine                  │
│    ├─ Retry logic                            │
│    ├─ Shell job execution                    │
│    ├─ HITL approval gates                    │
│    ├─ Idempotency ledger                     │
│    ├─ Inter-agent message queue              │
│    ├─ Task tracker                           │
│    └─ MinIO backup                           │
└─────────────────────────────────────────────┘
```

### Tick Loop

```
┌──────────────────────────────────────────────────────────────┐
│                   Dispatcher Loop (10s tick)                  │
│                                                              │
│  1. Gateway health check                                     │
│  2. Find due jobs → dispatch                                 │
│  3. Check running runs (stale/timeout detection)             │
│  4. HITL approval gate check                                 │
│  5. Message delivery + spawn handling                        │
│  6. Task tracker dead-man's-switch                           │
│  7. Expire old messages                                      │
│  8. Prune old runs + WAL checkpoint (hourly)                 │
│  9. Backup to MinIO (every 5 min)                            │
└──────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌───────────────────┐        ┌──────────────────────┐
  │     SQLite DB      │        │   OpenClaw Gateway    │
  │                    │        │                       │
  │  • jobs            │        │  • /v1/chat/completions│
  │  • runs            │        │  • /tools/invoke      │
  │  • messages        │        │  • /health            │
  │  • agents          │        │  • system event CLI   │
  │  • approvals       │        └──────────────────────┘
  │  • task_tracker    │
  │  • idempotency_ledger│
  │  • delivery_aliases│
  │  • schema_migrations│
  └───────────────────┘
```

### Session Types

| Session | Created By | Lifetime | Used For |
|---------|-----------|----------|----------|
| User DM | Telegram message | Persistent per-peer | Your conversations |
| Group chat | Group message | Persistent per-group | Team discussions |
| Isolated job | Dispatcher via API | One-shot, dies after completion | Cron jobs, chain steps |
| Main session | `openclaw system event` | Existing main session | Jobs needing main context |
| Shell | Dispatcher (direct) | Per-job (no session) | Cron scripts, backups, maintenance |
| Sub-agent | `sessions_spawn` | Task-scoped | Delegated work |

Scheduler jobs get completely isolated sessions. They can't see your chat history and your chats can't see theirs.

---

## How Jobs Execute

### Isolated Jobs (default)

```
Scheduler tick (every 10s)
  │
  ├─ getDueJobs() → "Hourly Workspace Backup is due"
  ├─ hasRunningRun()? → skip if overlap_policy='skip'
  ├─ createRun() → status='running'
  ├─ setAgentStatus('main', 'busy')
  │
  ├─ POST /v1/chat/completions
  │   session: scheduler:<job_id>:<run_id>  (unique, isolated)
  │   model: openclaw:main
  │   message: [job prompt + any pending inbox messages]
  │
  │   ← "Committed 3 files, pushed to origin"
  │
  ├─ finishRun('ok', summary)
  ├─ setAgentStatus('main', 'idle')
  ├─ Deliver to Telegram? → delivery_mode + channel + target
  ├─ Queue result message for traceability
  ├─ Advance next_run_at to next cron fire
  └─ Trigger child jobs if any (workflow chain)
```

### Main Session Jobs

For jobs that need the main session context (rare):

```
Dispatcher → exec: openclaw system event --text "..." --mode now
```

This injects directly into the active agent session.

### Shell Jobs

```
Shell Job (session_target='shell')
  │
  ├─ getDueJobs() → "Hourly Backup is due"
  ├─ createRun() → status='running'
  ├─ run "<payload_message>" via shell (platform default or SCHEDULER_SHELL)
  │   (no gateway required)
  │   ← exit 0: "Backup complete, 3 files"
  │
  ├─ finishRun(exit===0 ? 'ok' : 'error')
  ├─ announce: post output if exit ≠ 0
  ├─ announce-always: post output regardless
  └─ Trigger child jobs if any
```

### Prompt Building

Each isolated job prompt includes:
1. Header: `[scheduler:<job_id> <job_name>]`
2. Pending inbox messages for the agent (up to 5)
3. Context from prior runs (if `context_retrieval` is set)
4. The job's `payload_message`

---

## Delivery Modes

| Mode | When output is delivered |
|------|-------------------------|
| `none` | Never (background jobs) |
| `announce` | LLM jobs: any non-HEARTBEAT_OK response. Shell jobs: non-zero exit only |
| `announce-always` | Always delivers output (LLM or shell) |

> **Note:** delivery is suppressed if `delivery_channel` or `delivery_to` are absent, regardless of `delivery_mode`.

---

## Delivery Aliases

Delivery aliases let you define named delivery targets (e.g., `@my_team`) instead of hard-coding channel/target pairs in every job.

```bash
# Create a named alias
node cli.js aliases add my_team telegram -1001234567890

# Use @alias in job (resolves at dispatch time)
node cli.js jobs add '{
  "name": "Alert",
  "delivery_mode": "announce",
  "delivery_to": "@my_team",
  ...
}'

# List aliases
node cli.js aliases list

# Remove an alias
node cli.js aliases remove my_team
```

Aliases are resolved at dispatch time. If an alias is deleted, jobs fall back to suppressed delivery.

---

## Shell Jobs

Shell jobs run a command directly on the host — no gateway or LLM required. Ideal for backups, scripts, maintenance tasks, and anything that doesn't need AI.

```bash
node cli.js jobs add '{
  "name": "Hourly Backup",
  "schedule_cron": "0 * * * *",
  "schedule_tz": "America/New_York",
  "session_target": "shell",
  "payload_message": "/path/to/backup.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'
```

**Key properties:**
- **No gateway dependency** — runs even when gateway is down
- `payload_message` is the command to execute (shell string passed to the configured shell)
- Output captured up to 1MB, truncated to 5000 chars in run summary
- `run_timeout_ms` controls max execution time (default 300000ms = 5 min)
- Workflow chains work the same way — shell jobs can trigger children on success/failure

**With environment variables:**
```bash
node cli.js jobs add '{
  "name": "DB Dump",
  "schedule_cron": "0 3 * * *",
  "session_target": "shell",
  "payload_message": "PGPASSWORD=secret pg_dump mydb > /backups/mydb.sql && echo OK",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'
```

---

## HITL Approval Gates

Jobs with `approval_required: 1` pause before each chain-triggered execution and wait for a human to approve or reject.

```bash
# Job that requires operator approval before each chain-triggered execution
node cli.js jobs add '{
  "name": "Deploy to Prod",
  "parent_id": "<build-job-id>",
  "trigger_on": "success",
  "approval_required": 1,
  "approval_timeout_s": 3600,
  "approval_auto": "reject",
  "payload_message": "Deploy the application to production"
}'
```

When triggered, the job creator receives: `⚠️ Job 'Deploy to Prod' requires approval.`

```bash
node cli.js jobs approve <job-id>
node cli.js jobs reject <job-id> "Postponing — too late in the day"
node cli.js approvals list
```

**Key notes:**
- Approval gates only apply to **chain-triggered** jobs (`parent_id` set)
- Cron-scheduled jobs always dispatch without waiting for approval
- `approval_timeout_s` — auto-resolve timeout (seconds)
- `approval_auto` — `"approve"` or `"reject"` — what happens on timeout

---

## Idempotency

Control what happens when the dispatcher crashes mid-run.

```bash
# Enable at-least-once: crashed runs replay on next startup
node cli.js jobs update <id> '{"delivery_guarantee":"at-least-once"}'

# Default (at-most-once): no replay
node cli.js jobs update <id> '{"delivery_guarantee":"at-most-once"}'
```

**How it works:**
- **`at-most-once`** (default): if dispatcher crashes mid-run, run is marked `crashed` and the schedule advances normally. The run is not replayed.
- **`at-least-once`**: on startup, any `running` run from a crashed dispatcher is replayed with a new run. `replay_of` field tracks the original run ID for lineage.

**Idempotent agents** can return `IDEMPOTENT_SKIP` in their response to acknowledge they've already processed this execution (detected via the idempotency ledger).

The ledger also prevents double-dispatch in concurrent tick scenarios — each run acquires a lock before dispatch.

---

## Context Retrieval

Inject prior run summaries into a job's prompt so the agent has awareness of recent outcomes.

```bash
# Inject last 3 run summaries into job prompt
node cli.js jobs update <id> '{"context_retrieval":"recent","context_retrieval_limit":3}'

# Hybrid: recent runs + TF-IDF search for semantically relevant summaries
node cli.js jobs update <id> '{"context_retrieval":"hybrid","context_retrieval_limit":5}'
```

**Modes:**
| Mode | Description |
|------|-------------|
| `none` | No context injected (default) |
| `recent` | Last N run summaries, newest first |
| `hybrid` | Recent runs + TF-IDF similarity search against all prior summaries |

Useful for health check jobs that should know about yesterday's failures, or audit jobs that build incrementally on prior work.

---

## Task Tracker

The task tracker provides a dead-man's-switch for coordinating multi-agent sub-agent teams. Create a tracker, assign expected agents, and receive a summary when all agents complete (or time out).

```bash
# Create a task group to monitor N sub-agents
node cli.js tasks create '{
  "name": "v2-release-team",
  "expected_agents": ["schema-agent","frontend-agent","docs-agent"],
  "timeout_s": 1800,
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'

# Monitor
node cli.js tasks list
node cli.js tasks status <tracker-id>
```

Each agent in the team must send heartbeat updates. If an agent goes silent past its timeout, it's declared dead. When all agents complete or time out, a summary is delivered to the configured channel.

---

## Resource Pools

Prevent concurrent execution across different jobs that share a resource.

```bash
# Two jobs that must not run concurrently
node cli.js jobs add '{"name":"DB Migration","resource_pool":"database",...}'
node cli.js jobs add '{"name":"DB Backup","resource_pool":"database",...}'
```

If one job in a pool is currently running, all other pool members skip their tick (same behavior as `overlap_policy: 'skip'`, but cross-job rather than per-job). Pool membership is set via the `resource_pool` string field.

---

## Workflow Chains

Jobs can be linked into parent → child chains. When a parent completes, its children fire automatically.

### Pattern 1: Chained Jobs

```bash
# Parent: runs on cron
node cli.js jobs add '{
  "name": "Build App",
  "schedule_cron": "0 10 * * *",
  "payload_message": "Build the application"
}'
# → id: "abc123..."

# Child: fires when parent succeeds
node cli.js jobs add '{
  "name": "Deploy App",
  "payload_message": "Deploy to production",
  "parent_id": "abc123...",
  "trigger_on": "success"
}'

# Child: fires when parent fails
node cli.js jobs add '{
  "name": "Build Alert",
  "payload_message": "Build failed — check logs",
  "parent_id": "abc123...",
  "trigger_on": "failure",
  "delivery_mode": "announce",
  "delivery_to": "1000000001"
}'
```

**Trigger types:**
- `success` — parent run status = `ok`
- `failure` — parent run status = `error` or `timeout`
- `complete` — any completion (success, failure, or timeout)

### Pattern 2: Output-Based Trigger Conditions

```bash
# Only fire child if parent output contains "ALERT"
node cli.js jobs add '{
  "name": "Alert Handler",
  "parent_id": "<monitor-job-id>",
  "trigger_on": "success",
  "trigger_condition": "contains:ALERT",
  "payload_message": "Handle the alert"
}'

# Regex condition
node cli.js jobs add '{
  "name": "Critical Error Handler",
  "parent_id": "<monitor-job-id>",
  "trigger_on": "success",
  "trigger_condition": "regex:ERROR.*critical",
  "payload_message": "Handle critical error"
}'
```

### Pattern 3: Multi-Agent Workflows

Chain jobs targeting different agents:

```
Build (agent: main, cron: 10am)
  └─ Deploy (agent: ops, trigger: success)
      └─ Health Check (agent: main, trigger: success, delay: 60s)
```

```bash
node cli.js jobs add '{
  "name": "Deploy",
  "payload_message": "deploy",
  "agent_id": "ops",
  "parent_id": "<build-id>",
  "trigger_on": "success"
}'
```

### Pattern 4: Delayed Triggers

```bash
node cli.js jobs add '{
  "name": "Post-Deploy Check",
  "payload_message": "Verify services healthy",
  "parent_id": "<deploy-id>",
  "trigger_on": "success",
  "trigger_delay_s": 60
}'
```

### Pattern 5: Runtime Spawning

A running agent can create new jobs on the fly by sending a `spawn` message:

```json
{
  "from_agent": "main",
  "to_agent": "scheduler",
  "kind": "spawn",
  "body": "{\"name\":\"Dynamic Task\",\"payload_message\":\"analyze results\",\"delete_after_run\":true,\"run_now\":true}"
}
```

### Visualizing Chains

```bash
node cli.js jobs tree <job-id>

# Output:
# Build App
#   └─ Deploy App [→success] (agent:ops)
#   └─ Build Alert [→failure]
#   └─ Health Check [→complete +60s]
```

---

## Retry Logic

Jobs can auto-retry before declaring failure and triggering failure children.

```bash
node cli.js jobs add '{
  "name": "Flaky Deploy",
  "schedule_cron": "0 10 * * *",
  "payload_message": "deploy to prod",
  "max_retries": 3
}'
```

**How it works:**

1. Job fails → check `max_retries`
2. Retries remaining → schedule retry with exponential backoff (30s, 60s, 120s, ...)
3. Retry run tracks lineage: `retry_of` → failed run ID, `retry_count` incremented
4. All retries exhausted → trigger failure children + apply error backoff
5. Any retry succeeds → trigger success children, reset `consecutive_errors`

**Key:** failure children don't fire until all retries are exhausted. This prevents false alerts on transient failures.

| Field | Default | Description |
|-------|---------|-------------|
| `max_retries` | 0 | Max retry attempts (0 = no retry) |
| `runs.retry_of` | null | ID of the failed run being retried |
| `runs.retry_count` | 0 | Which attempt this is (0 = first try) |

---

## Chain Safety

### Max Chain Depth

`MAX_CHAIN_DEPTH = 10` — enforced on:
- `createJob` — can't add a child deeper than 10 levels
- `updateJob` — can't move a job to create a chain deeper than 10
- `triggerChildren` — runtime safeguard stops dispatch at depth 10

### Cycle Detection

`detectCycle()` walks up the parent chain on both create and update. Catches:
- Self-referential: A → A
- Deep cycles: A → B → C → A
- Throws with descriptive error message

### Chain Cancellation

```bash
node cli.js jobs cancel <job-id>
# Cancels all running runs for this job + every descendant
```

Sets `status = 'cancelled'` on all running runs in the chain. No-op on finished runs.

---

## Inter-Agent Messaging

Agents exchange messages through the scheduler's queue.

### Features
- **Priority:** 0 (normal), 1 (high), 2 (urgent) — inbox sorted by priority then time
- **Threading:** `reply_to` links messages into conversations
- **Read receipts:** pending → delivered → read (with timestamps)
- **Broadcast:** `to_agent = 'broadcast'` reaches all agents
- **TTL/Expiry:** `expires_at` auto-expires unread messages
- **Metadata:** JSON blob for structured data
- **Kinds:** `text`, `task`, `result`, `status`, `system`, `spawn`, `decision`, `constraint`, `fact`, `preference`
- **Owner field:** `owner` tracks message originator for audit
- **Job linking:** messages can reference `job_id` and `run_id`

### Delivery

Messages are delivered inline with job prompts. When the dispatcher builds a prompt, it includes up to 5 pending messages for the target agent, marked as `delivered`.

### Usage

```bash
# Send a message
node cli.js msg send <from-agent> <to-agent> "message body"

# Read inbox
node cli.js msg inbox <agent-id>

# Mark all read
node cli.js msg readall <agent-id>
```

### Signal Queue Consumer Example

Use this when you want scripts to enqueue only actionable signals, then a single consumer job pushes those signals to Telegram.

```bash
# 1) Enqueue a signal
node cli.js msg send monitor-agent main "Found 3 critical errors in prod logs"

# 2) Add a consumer shell job (every 5 minutes)
node cli.js jobs add '{
  "name": "Inbox Consumer",
  "schedule_cron": "*/5 * * * *",
  "session_target": "shell",
  "payload_message": "node ~/.openclaw/scheduler/scripts/inbox-consumer.mjs --to YOUR_TELEGRAM_ID",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "run_timeout_ms": 60000
}'
```

---

## Backup & Recovery

The scheduler can back up its SQLite database to MinIO automatically.

```bash
# Manual snapshot
node backup.js snapshot

# Manual rollup (hourly aggregate)
node backup.js rollup

# Check backup status
node backup.js status

# Restore from snapshot
node backup.js restore scheduler-backups/scheduler/snapshots/2026-02-26/14-00.db

# Prune old backups
node backup.js prune
```

**Configuration via environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_ALIAS` | `backupstore` | MinIO client alias |
| `BUCKET` | `scheduler-backups` | MinIO bucket name |
| `PREFIX` | `scheduler` | Path prefix within bucket |

Requires `mc` (MinIO client) in PATH and a configured `backupstore` alias.

**Built-in (when running via LaunchAgent):**
- Snapshot every 5 minutes (`SCHEDULER_BACKUP_MS`)
- Rollup on the first tick of each hour

---

## Agent Registry

| Operation | Function | Description |
|-----------|----------|-------------|
| Register | `upsertAgent(id, opts)` | Create or update |
| Get | `getAgent(id)` | Fetch by ID |
| List | `listAgents()` | All agents |
| Set status | `setAgentStatus(id, status, sessionKey)` | idle/busy/offline |
| Touch | `touchAgent(id)` | Update last_seen_at |

The dispatcher automatically manages agent status during dispatch (idle → busy → idle).

```bash
node cli.js agents list
node cli.js agents get <id>
node cli.js agents register <id> [name]
```

---

## Database Schema

**Schema version:** 8 | **Mode:** WAL | **Foreign keys:** ON

### Tables

| Table | Description |
|-------|-------------|
| `jobs` | Job definitions (schedule, payload, chain config, delivery) |
| `runs` | Execution history (status, timing, summaries, retry lineage) |
| `messages` | Inter-agent message queue (priority, TTL, typed) |
| `agents` | Agent registry (status, capabilities, last seen) |
| `approvals` | HITL gate records (pending/approved/rejected/expired) |
| `task_tracker` | Multi-agent task group definitions |
| `task_tracker_agents` | Per-agent status within a task group |
| `idempotency_ledger` | Dispatch deduplication and at-least-once tracking |
| `delivery_aliases` | Named delivery targets (channel + target pairs) |
| `schema_migrations` | Baseline schema version log |

### Jobs (key columns)

```
id, name, enabled, schedule_cron, schedule_tz,
session_target, agent_id, payload_kind, payload_message,
payload_model, overlap_policy, run_timeout_ms,
max_retries, delivery_mode, delivery_channel,
delivery_to, delete_after_run, parent_id, trigger_on,
trigger_delay_s, trigger_condition, resource_pool,
approval_required, approval_timeout_s, approval_auto,
delivery_guarantee, context_retrieval, context_retrieval_limit,
next_run_at, last_run_at, last_status, consecutive_errors,
created_at, updated_at
```

### Runs (key columns)

```
id, job_id, status, started_at, finished_at, duration_ms,
last_heartbeat, session_key, session_id, summary,
error_message, dispatched_at, run_timeout_ms,
triggered_by_run, retry_of, retry_count, replay_of
```

**Run statuses:** `pending`, `running`, `ok`, `error`, `timeout`, `skipped`, `cancelled`, `crashed`

### Messages (key columns)

```
id, from_agent, to_agent, reply_to, kind, subject, body,
metadata, priority, channel, owner, status, delivered_at,
read_at, expires_at, created_at, job_id, run_id
```

### Agents (7 columns)

```
id, name, status, last_seen_at, session_key, capabilities, created_at
```

---

## CLI Reference

```bash
cd ~/.openclaw/scheduler

# ── Jobs ──────────────────────────────────────────
node cli.js jobs list                     # List all (shows agent, parent, trigger)
node cli.js jobs get <id>                 # Full details as JSON
node cli.js jobs add '<json>'             # Create a job
node cli.js jobs update <id> '<json>'     # Partial update
node cli.js jobs enable <id>
node cli.js jobs disable <id>
node cli.js jobs delete <id>              # Cascades to runs
node cli.js jobs tree <id>                # Visual chain hierarchy
node cli.js jobs children <id> [status]   # Triggered children
node cli.js jobs cancel <id>              # Cancel running chain

# ── Runs ──────────────────────────────────────────
node cli.js runs list <job-id> [limit]    # Run history
node cli.js runs running                  # Active runs
node cli.js runs stale [threshold-s]      # Stale runs (default 90s)

# ── Messages ──────────────────────────────────────
node cli.js msg send <from> <to> <body>
node cli.js msg inbox <agent-id> [limit]
node cli.js msg outbox <agent-id> [limit]
node cli.js msg thread <message-id>
node cli.js msg read <message-id>
node cli.js msg readall <agent-id>
node cli.js msg unread <agent-id>

# ── Agents ────────────────────────────────────────
node cli.js agents list
node cli.js agents get <id>
node cli.js agents register <id> [name]

# ── Approvals ─────────────────────────────────────
node cli.js jobs approve <id>            # Approve pending gate
node cli.js jobs reject <id> [reason]    # Reject pending gate
node cli.js approvals list               # All pending approvals

# ── Task Tracker ──────────────────────────────────
node cli.js tasks create '<json>'        # Create task group
node cli.js tasks list                   # Active task groups
node cli.js tasks status <id>            # Detailed status
node cli.js tasks history [limit]        # Recently completed groups
node cli.js tasks heartbeat <id> <label> running|completed|failed [msg]
node cli.js tasks register-session <id> <label> <session-key>  # Enable auto-heartbeat

# ── Delivery Aliases ──────────────────────────────
node cli.js aliases list                 # List all aliases
node cli.js aliases add <name> <channel> <target> [description]
node cli.js aliases remove <name>

# ── Status ────────────────────────────────────────
node cli.js status
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Gateway auth token |
| `SCHEDULER_DB` | `./scheduler.db` | SQLite database path |
| `SCHEDULER_TICK_MS` | `10000` | Tick interval (10s) |
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Stale run threshold |
| `SCHEDULER_HEARTBEAT_CHECK_MS` | `30000` | Health check interval |
| `SCHEDULER_MESSAGE_DELIVERY_MS` | `15000` | Message + spawn processing interval |
| `SCHEDULER_PRUNE_MS` | `3600000` | Prune interval (1 hour) |
| `SCHEDULER_BACKUP_MS` | `300000` | MinIO backup interval (5 min) |
| `SCHEDULER_DEBUG` | *(unset)* | `1` for debug logging |
| `SCHEDULER_SHELL` | `/bin/zsh` (macOS), `/bin/bash` (Linux/WSL), `cmd.exe` (Windows) | Shell used for shell jobs |

---

## Service Management

> **Platform note:** The commands below are for macOS (launchctl). For Linux, see [INSTALL-LINUX.md](INSTALL-LINUX.md). For Windows, see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

```bash
# Start
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Stop
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Restart
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist && \
  sleep 1 && \
  launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Status
launchctl list | grep scheduler
ps aux | grep dispatcher | grep -v grep

# Logs
tail -f /tmp/openclaw-scheduler.log

# Quick health
node cli.js status
```

LaunchAgent config: `RunAtLoad: true`, `KeepAlive: true` (auto-restart on crash).

---

## Error Handling & Backoff

### On dispatch failure

1. Run marked `error`, `consecutive_errors` increments
2. If `max_retries > 0` and retries remain → schedule retry (failure children wait)
3. If retries exhausted → trigger failure children, apply backoff

### Backoff schedule

| Consecutive errors | Delay |
|-------------------|-------|
| 1 | 30s |
| 2 | 1 min |
| 3 | 5 min |
| 4 | 15 min |
| 5+ | 1 hour |

Backoff is applied on top of the cron schedule (whichever is later). Resets to 0 on success.

### Stale run detection

- Every 30s, dispatcher checks if running runs still have active sessions
- No activity for 90s → marked `timeout`
- Fallback: runs exceeding `run_timeout_ms` are force-timed-out

### Gateway health

`GET /health` checked before each tick. If unreachable, isolated jobs are deferred; shell and main-session jobs continue.

---

## Migration & History

### Importing from OC cron (first host only)

```bash
node migrate.js   # imports from ~/.openclaw/cron/jobs.json
```

### Schema baseline

As of `v1.0.3`, the schema is consolidated in `schema.sql` (baseline `v10`).

- Net-new installs: `initDb()` applies `schema.sql` directly.
- Existing/pre-release DBs: `initDb()` runs `migrate-consolidate.js` to backfill missing columns/tables/indexes.

### What was disabled in OpenClaw

| System | How disabled | Revert |
|--------|-------------|--------|
| Built-in cron | All jobs set `enabled: false` via API | `openclaw cron edit <id> --enable` |
| Heartbeat | `heartbeat.every: "0m"` | Set back to `"5m"` |
| Chat completions | Enabled for scheduler | Can leave enabled |

### Version history

| Version | Date | Schema | Key changes |
|---------|------|--------|-------------|
| 0.1.0 | 2026-02-21 | v1 | Initial: jobs, runs, messages, agents, standalone dispatch |
| 0.4.0 | 2026-02-22 | v3 | Workflow chains, cycle detection, spawn messages, multi-agent |
| 0.5.0 | 2026-02-23 | v3b | Retry logic, max chain depth, chain cancellation, queue overlap |
| 0.6.0 | 2026-02-24 | v5 | Shell jobs, announce-always, MinIO backup, resource pools, delivery aliases |
| 0.7.0 | 2026-02-25 | v6/v7 | Idempotency, at-least-once, context retrieval, approval gates, task tracker, typed messages |
| 1.0.0 | 2026-02-26 | v6 | Public release: docs, LICENSE, CHANGELOG, package metadata |
| 1.0.1 | 2026-03-02 | v9 | Consolidated schema + migration path, task tracker heartbeat/session baseline columns, session reuse field, Windows shell default fix (`cmd.exe`) |
| 1.0.2 | 2026-03-03 | v10 | Team-aware routing fields on messages, explicit message receipt events (attempt/error/ack), team adapter projection + task completion gates |
| 1.0.3 | 2026-03-05 | v10 | Dispatch hardening: seeded 529 recovery job reconciliation, watcher token-telemetry safeguards, robust home-path resolution, and watcher DB checks without external `sqlite3` CLI |

---

## Removing the Scheduler

To stop the scheduler and restore OpenClaw's built-in cron/heartbeat, see [UNINSTALL.md](UNINSTALL.md).

Quick summary:
1. Stop the service (launchctl / systemctl / pm2)
2. Re-enable OC cron: `openclaw cron edit <id> --enable` for each job
3. Re-enable heartbeat: `openclaw config set agents.defaults.heartbeat.every "5m"`
4. Optionally delete `~/.openclaw/scheduler/`

---

## Best Practices

See [BEST-PRACTICES.md](BEST-PRACTICES.md) for:
- Choosing between `shell`, `isolated`, and `main` session targets
- Writing effective payload prompts for LLM jobs
- When to use chains vs standalone jobs
- Delivery mode selection
- How to integrate the scheduler with your OpenClaw agent
- Example MEMORY.md entries for agent awareness

---

## File Reference

```
~/.openclaw/scheduler/
│
│  Core scheduler
├── dispatcher.js          # Main process — tick loop, dispatch, chains, retry, backups
├── db.js                  # SQLite connection (WAL, FK ON, WAL checkpoint)
├── schema.sql             # Complete schema (v10) — all tables and columns, no incremental DDL
├── migrate-consolidate.js # Single migration for existing DBs: brings any prior version to v10
├── jobs.js                # Job CRUD, cron, chains, cycle detection, resource pools, queue
├── runs.js                # Run lifecycle, stale/timeout, cancellation, context summary
├── messages.js            # Inter-agent message queue (priority, TTL, typed messages)
├── agents.js              # Agent registry
├── gateway.js             # OpenClaw API client (chat completions, events, delivery, aliases)
├── approval.js            # HITL approval gates
├── idempotency.js         # Idempotency ledger (at-least-once delivery dedup)
├── retrieval.js           # Context retrieval (recent/hybrid run summaries)
├── task-tracker.js        # Dead-man's-switch for multi-agent sub-agent teams
├── team-adapter.js        # Team mailbox/task projection and task completion gates
├── backup.js              # MinIO snapshot/rollup/restore
├── cli.js                 # CLI management tool
├── migrate.js             # Import from OC jobs.json
├── test.js                # Full test suite (352 assertions, in-memory)
├── scripts/
│   ├── inbox-consumer.mjs      # Drains queue messages and delivers to Telegram
│   └── stuck-run-detector.mjs  # Detects stale running runs (alert-only via non-zero exit)
│
│  Service & docs
├── ai.openclaw.scheduler.plist  # macOS LaunchAgent template
├── INSTALL.md             # Full installation guide — macOS (first host)
├── INSTALL-ADDITIONAL-HOST.md  # Installation guide for additional hosts
├── INSTALL-LINUX.md       # Installation guide for Linux (systemd user service)
├── INSTALL-WINDOWS.md     # Installation guide for Windows (WSL2 or PM2)
├── UNINSTALL.md           # Removal guide (all platforms)
├── BEST-PRACTICES.md      # Job type selection, prompt writing, agent integration
├── openclaw-scheduler.service  # Linux systemd user service template
├── IMPLEMENTATION_SPEC.md # Internal developer reference (v5+ feature specs)
├── CHANGELOG.md           # Version history
└── README.md              # This file
```

---

## Testing

```bash
# Run all tests (352 assertions, in-memory SQLite)
SCHEDULER_DB=:memory: node test.js

# Or via npm:
npm test
```

### Test categories

- Schema creation & integrity
- Job CRUD, cron parsing, due detection
- Run lifecycle (create, heartbeat, finish, stale, timeout)
- Agent registry (upsert, status, capabilities)
- Message queue (priority, broadcast, TTL, typed messages)
- Cascade deletes, pruning
- Workflow chains (parent/child, trigger matching, tree traversal, trigger conditions)
- Cycle detection (self, deep)
- Max chain depth enforcement
- Retry tracking and sequencing
- Chain cancellation
- Shell job execution
- Approval gate lifecycle
- Idempotency key claiming/releasing
- Context retrieval (recent/hybrid)
- Dispatcher integration (full dispatch pipeline with mock gateway)

---

## Troubleshooting

### Dispatcher isn't dispatching

```bash
ps aux | grep dispatcher              # Is it running?
tail -20 /tmp/openclaw-scheduler.log   # Any errors?
curl http://127.0.0.1:18789/health     # Gateway reachable?
node cli.js jobs list                  # Is nextRun in the past?
node cli.js runs running               # Overlap blocking?
```

### Wrong next_run_at

All dates must be SQLite format (`YYYY-MM-DD HH:MM:SS`, UTC). `nextRunFromCron()` handles this. If manually setting dates, don't use ISO format with `T`/`Z`.

### Force a job to run now

```bash
sqlite3 scheduler.db "UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = '<job-id>'"
```

### Check schema version

```bash
sqlite3 scheduler.db "SELECT * FROM schema_migrations"
```

### Service won't start

```bash
plutil -lint ~/Library/LaunchAgents/ai.openclaw.scheduler.plist  # Valid plist?
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
launchctl list | grep scheduler
```

### Logs not updating

Dispatcher logs to stderr (unbuffered). If logs look stale, the process may have crashed — check `launchctl list | grep scheduler` (exit code in second column, 0 = running).

### Job shows 'awaiting_approval'

```bash
node cli.js approvals list
node cli.js jobs approve <id>   # or reject
```

### Backup failing

```bash
mc alias list   # verify backupstore alias configured
# Check: MC_ALIAS, BUCKET, PREFIX env vars or defaults in backup.js
# Verify MinIO is reachable: mc ls backupstore/
```

---

## Companion Scripts

The `scripts/` directory contains optional operational helpers built on top of core scheduler primitives.

These scripts are not required for scheduling itself, but they are useful for production operations:
- `scripts/inbox-consumer.mjs` drains queued messages and delivers them to Telegram.
- `scripts/stuck-run-detector.mjs` detects stale `running` runs and exits non-zero for alerting.

### Signal Queue Pattern

The message queue (`messages` table) plus `cli.js msg send` implements a **signal-only** delivery path that complements `delivery_mode: announce`:

```
Failure path:  dispatcher → announce → Telegram (immediate, unconditional)
Signal path:   script → cli.js msg send → queue → Inbox Consumer → Telegram
```

Scripts write to the queue **only when they have found something** — not unconditionally. A companion `scripts/inbox-consumer.mjs` shell job (run every 5 min) drains the queue and delivers to Telegram. It exits 0 when the queue is empty, so there is no noise.

> **Important:** The dispatcher does **not** write to the message queue automatically.
> Every message in the queue was put there by a script with a specific receiver in mind.
> Traceability for completed jobs comes from the `runs` table, `delivery_mode: announce`,
> and run history/CLI views — not from queued messages.
