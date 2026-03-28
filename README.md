# OpenClaw Scheduler

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](INSTALL.md)
[![License](https://img.shields.io/badge/license-MIT-blue)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)]()

A durable orchestration runtime for [OpenClaw](https://openclaw.ai) agents and shell workflows. Use it when built-in cron and heartbeat stop being enough: jobs fail and disappear into logs, shell scripts depend on gateway uptime, multi-step workflows need retries and approvals, and you want a real audit trail for what ran, what failed, and what triggered what.

It replaces OpenClaw's built-in cron/heartbeat with a SQLite-backed scheduler that keeps full run history, supports shell and agent steps in the same workflow, and lets you build chains like `shell check -> agent diagnosis -> human approval -> remediation`.

**Repo:** `github.com/amittell/openclaw-scheduler`
**Location:** `~/.openclaw/scheduler/`
**Service:** `ai.openclaw.scheduler` (macOS launchd: LaunchAgent or LaunchDaemon)
**Runtime:** Node.js 20+ (ESM), SQLite via `better-sqlite3`, cron parsing via `croner`
**Tests:** 1013 (full suite, in-memory SQLite + dispatcher integration)
**Platform:** macOS · Linux · Windows (WSL2)

In practice, this gives you:
- scheduled jobs with real run history instead of “it probably ran”
- shell jobs that still work when the gateway is unhealthy
- AI jobs that stay isolated from your personal chats
- chains, retries, and approval gates for workflows that are bigger than one cron line

---

## Table of Contents

1. [Why This Exists](#why-this-exists)
2. [Concrete Use Cases](#concrete-use-cases)
3. [When To Use It](#when-to-use-it)
4. [What Replaced What](#what-replaced-what)
5. [Quick Start](#quick-start)
6. [Five-Minute Setup](#five-minute-setup)
7. [Starter Recipes](#starter-recipes)
8. [Common Migrations](#common-migrations)
9. [Platform Support](#platform-support)
10. [Architecture](#architecture)
11. [How Jobs Execute](#how-jobs-execute)
12. [Delivery Modes](#delivery-modes)
13. [Delivery Aliases](#delivery-aliases)
14. [Shell Jobs](#shell-jobs)
15. [HITL Approval Gates](#hitl-approval-gates)
16. [Idempotency](#idempotency)
17. [Context Retrieval](#context-retrieval)
18. [Task Tracker](#task-tracker)
19. [Resource Pools](#resource-pools)
20. [Workflow Chains](#workflow-chains)
21. [Retry Logic](#retry-logic)
22. [Chain Safety](#chain-safety)
23. [Inter-Agent Messaging](#inter-agent-messaging)
24. [Backup & Recovery](#backup--recovery)
25. [Agent Registry](#agent-registry)
26. [Database Schema](#database-schema)
27. [CLI Reference](#cli-reference)
28. [Configuration](#configuration)
29. [Service Management](#service-management)
30. [Error Handling & Backoff](#error-handling--backoff)
31. [Migration & History](#migration--history)
32. [Removing the Scheduler](#removing-the-scheduler)
33. [Best Practices](#best-practices)
34. [File Reference](#file-reference)
35. [Testing](#testing)
36. [Companion Scripts](#companion-scripts)
37. [Sub-agent Dispatch](#sub-agent-dispatch)
38. [Troubleshooting](#troubleshooting)

---

## Why This Exists

OpenClaw's built-in cron and heartbeat are fine until your workflows stop being simple.

The pain usually looks like this:

- A scheduled agent run fails, but the only record is a log line or a chat reply.
- A shell script is operationally important, but it should keep running even if the gateway is unhealthy.
- One step should trigger another, but only on success, only on failure, or only if the output contains a specific signal.
- A risky action needs a human in the loop instead of firing immediately.
- An agent needs to hand work to another agent or process, and you want that handoff tracked and auditable.

`openclaw-scheduler` exists to solve those problems without making you build a second application stack. It gives OpenClaw a durable runtime for workflows: jobs, runs, chains, retries, shell execution, approvals, and message routing all backed by SQLite.

## Concrete Use Cases

These are the kinds of workflows this scheduler is meant for:

- `metrics capture -> analysis -> approval -> report publish`
  You want each step tracked, retried if needed, and gated before the final action.
- `shell ingest fails -> agent diagnoses failure -> operator approves remediation`
  The ingest should still run without the gateway, but the failure follow-up can use an agent.
- `workspace audit -> diagnosis -> memory compression`
  The audit is a shell step, the diagnosis is an agent step, and the remediation should only run if the diagnosis actually recommends it.
- `bot health check -> alert -> repair action`
  A shell check runs on schedule, an agent summarizes the issue, and a repair step waits for approval.

The differentiator is not just "better cron". It is mixed shell + agent workflows with durable state and control over what happens after success, failure, timeout, or explicit signals in output.

## When To Use It

Use it when you want:

- reliable scheduled execution with history and retries
- shell jobs that do not depend on OpenClaw gateway availability
- parent/child workflow chains
- approval gates before risky steps
- auditable inter-agent or agent-to-shell handoffs

Do not use it if simple cron is enough. If all you need is “run one thing every hour” and you do not care about retries, chains, approvals, or run history, this is probably more system than you need.

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

If you are new, use the npm-first path below and then jump straight to [Five-Minute Setup](#five-minute-setup). The rest of this README is the deeper reference manual.

### Option A: npm-first (publish/install flow)

```bash
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup
```

This installs the package without cloning the repo. The launcher command maps to:
- `openclaw-scheduler setup` → `setup.mjs`
- `openclaw-scheduler start` → `dispatcher.js`
- `openclaw-scheduler webhook-check` → `scripts/telegram-webhook-check.mjs`
- `openclaw-scheduler <anything-else>` → `cli.js`

For npm installs, scheduler state defaults to `~/.openclaw/scheduler/` rather than `node_modules/openclaw-scheduler/`, so upgrades do not trample the database path.

If your Node runtime changes later, rebuild the native SQLite binding before restarting the scheduler:

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3
```

This is commonly needed after a Homebrew Node upgrade on macOS or any major Node ABI change.

### Option B: source clone (dev/contributor flow)

```bash
git clone https://github.com/amittell/openclaw-scheduler ~/.openclaw/scheduler
cd ~/.openclaw/scheduler
npm install
npm test                             # should print: 1013 passed, 0 failed
npm run lint                         # static checks
npm run typecheck                    # exported API declarations
npm run coverage                     # coverage summary + lcov report
npm run verify:local                 # full local maintainer gate
npm run verify:smoke                 # lightweight smoke gate used by GitHub Actions
```

GitHub Actions intentionally stays minimal: one Ubuntu/Node 20 smoke run on pushes to `main`, pull requests, or manual dispatch. The full release gate runs locally via `npm run verify:local` and is enforced again by `prepublishOnly`.

The package also exports a small safe programmatic API surface for tooling:

```js
import { db, jobs, runs, shellResults } from 'openclaw-scheduler';
```

Then run the interactive setup wizard:

```bash
npm exec openclaw-scheduler -- setup
# or: node setup.mjs
```

The wizard will:
- Run DB migrations
- Append scheduler queue/inbox-consumer entries to your agent's `MEMORY.md` and `workspace-index.md`
- Create **Inbox Consumer** + **Stuck Run Detector** scheduler jobs
- Configure dispatcher auto-start service:
  - macOS: LaunchAgent (personal auto-login Mac) or LaunchDaemon (headless/pre-login startup)
  - Linux/WSL2: systemd user service (or PM2 fallback)

After setup:

```bash
npm exec openclaw-scheduler -- status # verify scheduler is running
node scripts/stuck-run-detector.mjs   # should print: No stale runs older than 15 minute(s).
tail -5 /tmp/openclaw-scheduler.log   # live logs
```

Dispatcher setup is covered in:
- [INSTALL.md](INSTALL.md) (macOS launchd: LaunchAgent or LaunchDaemon)
- [INSTALL-LINUX.md](INSTALL-LINUX.md) (Linux/WSL2 systemd + PM2 fallback)
- [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) (WSL2 setup path)
For additional hosts, see [INSTALL-ADDITIONAL-HOST.md](INSTALL-ADDITIONAL-HOST.md).

---

## Five-Minute Setup

This is the shortest path from "I installed it" to "I have a real job running."

### 1. Install and initialize

```bash
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
alias ocs='npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler --'
ocs setup
ocs status
```

What this does:
- installs the package into `~/.openclaw/scheduler`
- creates or migrates `scheduler.db`
- installs the scheduler service using the launchd mode you choose (`agent` or `daemon`)
- creates the built-in helper jobs like `Inbox Consumer` and `Stuck Run Detector`

If you plan to use the scheduler often, add the `ocs` alias to your shell profile.

### 2. Add your first real job

This example runs a simple shell health check every 15 minutes.

```bash
ocs jobs add '{
  "name": "Disk Space Check",
  "schedule_cron": "*/15 * * * *",
  "session_target": "shell",
  "payload_message": "df -h /",
  "delivery_mode": "none",
  "origin": "system"
}'
```

What it means in plain English:
- `schedule_cron`: run every 15 minutes
- `session_target: "shell"`: run a shell command directly, no AI needed
- `payload_message`: the command to run
- `delivery_mode: "none"`: do not send the output anywhere automatically
- `origin: "system"`: this job was created by the system, not from a user chat

### 3. Run it now and inspect the result

```bash
ocs jobs list
# copy the job ID for "Disk Space Check"

ocs jobs run <job-id>
ocs runs list <job-id> 5
```

If you want the full run record:

```bash
ocs runs get <run-id>
```

At that point you have a working scheduler install, a real job, and visible run history. Everything after this is layering on more power: AI jobs, delivery, retries, workflow chains, and approvals.

---

## Starter Recipes

These are copy-paste examples for the most common first workflows.

### 1. Shell health check with failure alerts

Use this when you want a script to run reliably even if the OpenClaw gateway is down.

```bash
ocs jobs add '{
  "name": "API Health Check",
  "schedule_cron": "*/15 * * * *",
  "session_target": "shell",
  "payload_message": "curl -fsS http://127.0.0.1:8080/health || exit 1",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Why this is useful:
- it runs even if the gateway is unhealthy
- it only announces on failure
- every run is stored in history

### 2. Daily AI summary

Use this when you want a scheduled agent report instead of a shell script.

```bash
ocs jobs add '{
  "name": "Daily Ops Summary",
  "schedule_cron": "0 9 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "isolated",
  "payload_message": "Summarize the last 24 hours of important errors, deploys, and follow-ups in 5 bullet points.",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Why this is useful:
- the agent runs in its own isolated session
- the result is delivered every time
- the run history stays separate from your personal chat threads

### 3. Approval-gated follow-up step

Use this when a risky step should wait for a human before it runs.

```bash
ocs jobs add '{
  "name": "Delete Old Backups",
  "parent_id": "<parent-job-id>",
  "trigger_on": "success",
  "approval_required": 1,
  "approval_timeout_s": 3600,
  "approval_auto": "reject",
  "session_target": "shell",
  "payload_message": "find /backups -type f -mtime +14 -delete",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Why this is useful:
- the parent job can run automatically
- the risky cleanup step pauses until someone approves it
- the scheduler records who approved or rejected it

Approve or reject later with:

```bash
ocs approvals list
ocs jobs approve <job-id>
ocs jobs reject <job-id> "Not today"
```

---

## Common Migrations

If you already have cron jobs, OpenClaw cron entries, or shell scripts, this is the simplest way to think about the conversion.

### 1. OpenClaw built-in cron -> import first, then clean up

If your jobs already live in `~/.openclaw/cron/jobs.json`, start with the importer:

```bash
cd ~/.openclaw/scheduler
node migrate.js
node cli.js jobs list
```

Then disable the old scheduler path:

```bash
openclaw cron edit <job-id> --disable
openclaw config set cron.enabled false
openclaw config set agents.defaults.heartbeat.every "0m"
```

Use this path when the existing jobs are already OpenClaw-native. It gets you into SQLite quickly, then you can refine the imported jobs later.

### 2. Plain shell cron line -> `session_target: "shell"`

If you have a normal cron line like:

```cron
*/5 * * * * /usr/local/bin/check-api.sh
```

Convert it to:

```bash
ocs jobs add '{
  "name": "API Check",
  "schedule_cron": "*/5 * * * *",
  "session_target": "shell",
  "payload_message": "/usr/local/bin/check-api.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Choose `shell` when the task is deterministic and you do not need AI reasoning.

### 3. AI-ish cron job -> `session_target: "isolated"`

If the old job was really “run a prompt every morning”, use an isolated agent job instead of a shell script:

```bash
ocs jobs add '{
  "name": "Daily Status Summary",
  "schedule_cron": "0 8 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "isolated",
  "payload_message": "Summarize the most important errors, deploys, and follow-ups from the last 24 hours in 5 bullet points.",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Choose `isolated` when the job needs reasoning, writing, summarization, or tools.

### 4. Two cron jobs with manual ordering -> parent/child chain

If your current workflow is:
- run a backup
- wait
- run verification

Model that as a chain instead of two unrelated cron entries:

```bash
ocs jobs add '{
  "name": "Nightly Backup",
  "schedule_cron": "0 2 * * *",
  "session_target": "shell",
  "payload_message": "/usr/local/bin/nightly-backup.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Then create the follow-up:

```bash
ocs jobs add '{
  "name": "Verify Nightly Backup",
  "parent_id": "<backup-job-id>",
  "trigger_on": "success",
  "trigger_delay_s": 60,
  "session_target": "shell",
  "payload_message": "/usr/local/bin/verify-backup.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

This is one of the biggest upgrades over plain cron: the second step now runs because the first step succeeded, not because the clock happened to reach another minute.

### 5. Risky follow-up -> add `approval_required`

If the current process is “job runs, then a human decides whether to continue,” model that decision directly:

```bash
ocs jobs add '{
  "name": "Delete Temp Files",
  "parent_id": "<analysis-job-id>",
  "trigger_on": "success",
  "approval_required": 1,
  "approval_timeout_s": 3600,
  "approval_auto": "reject",
  "session_target": "shell",
  "payload_message": "find /tmp/myapp -type f -mtime +7 -delete",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

That keeps the job automated, but only up to the point where human judgment is actually needed.

### Rule of thumb

When converting existing work:
- start with `shell` unless you clearly need AI reasoning
- add delivery only if someone really needs to see the output
- use chains when one step depends on another
- use approvals when the next step would be annoying, expensive, or risky if it ran by mistake

---

## Platform Support

| Platform | Service Manager | Shell Jobs | Status |
|----------|----------------|------------|--------|
| macOS | launchd (`agent` or `daemon`) | `/bin/zsh` | ✅ Tested |
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
│  Scheduler (launchd service)                 │
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
openclaw-scheduler alias add my_team telegram -1001234567890

# Use @alias in job (resolves at dispatch time)
openclaw-scheduler jobs add '{
  "name": "Alert",
  "delivery_mode": "announce",
  "delivery_to": "@my_team",
  ...
}'

# List aliases
openclaw-scheduler alias list

# Remove an alias
openclaw-scheduler alias remove my_team
```

Aliases are resolved at dispatch time. If an alias is deleted, jobs fall back to suppressed delivery.

---

## Shell Jobs

Shell jobs run a command directly on the host — no gateway or LLM required. Ideal for backups, scripts, maintenance tasks, and anything that doesn't need AI.

```bash
openclaw-scheduler jobs add '{
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
- Output captured up to 1MB, with preview/offload budgets to keep large output out of the main run row
- Shell runs persist structured failure context on `runs`: `shell_exit_code`, `shell_signal`, `shell_timed_out`, `shell_stdout`, `shell_stderr`, plus optional `shell_stdout_path` / `shell_stderr_path` when large output is offloaded
- Failure-triggered agent children receive shell context with separate exit code, stdout, and stderr blocks
- `run_timeout_ms` controls max execution time (default 300000ms = 5 min)
- Workflow chains work the same way — shell jobs can trigger children on success/failure
- Shell jobs now honor `max_retries` before failure children fire, the same as isolated agent jobs
- `openclaw-scheduler runs output <run-id> stdout|stderr` retrieves stored or offloaded shell output on demand

**With environment variables:**
```bash
openclaw-scheduler jobs add '{
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
openclaw-scheduler jobs add '{
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
openclaw-scheduler jobs approve <job-id>
openclaw-scheduler jobs reject <job-id> "Postponing — too late in the day"
openclaw-scheduler approvals list
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
openclaw-scheduler jobs update <id> '{"delivery_guarantee":"at-least-once"}'

# Default (at-most-once): no replay
openclaw-scheduler jobs update <id> '{"delivery_guarantee":"at-most-once"}'
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
openclaw-scheduler jobs update <id> '{"context_retrieval":"recent","context_retrieval_limit":3}'

# Hybrid: recent runs + TF-IDF search for semantically relevant summaries
openclaw-scheduler jobs update <id> '{"context_retrieval":"hybrid","context_retrieval_limit":5}'
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
openclaw-scheduler tasks create '{
  "name": "v2-release-team",
  "expected_agents": ["schema-agent","frontend-agent","docs-agent"],
  "timeout_s": 1800,
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'

# Monitor
openclaw-scheduler tasks list
openclaw-scheduler tasks status <tracker-id>
```

Each agent in the team must send heartbeat updates. If an agent goes silent past its timeout, it's declared dead. When all agents complete or time out, a summary is delivered to the configured channel.

---

## Resource Pools

Prevent concurrent execution across different jobs that share a resource.

```bash
# Two jobs that must not run concurrently
openclaw-scheduler jobs add '{"name":"DB Migration","resource_pool":"database",...}'
openclaw-scheduler jobs add '{"name":"DB Backup","resource_pool":"database",...}'
```

If one job in a pool is currently running, all other pool members skip their tick (same behavior as `overlap_policy: 'skip'`, but cross-job rather than per-job). Pool membership is set via the `resource_pool` string field.

---

## Workflow Chains

Jobs can be linked into parent → child chains. When a parent completes, its children fire automatically.

### Pattern 1: Chained Jobs

```bash
# Parent: runs on cron
openclaw-scheduler jobs add '{
  "name": "Build App",
  "schedule_cron": "0 10 * * *",
  "payload_message": "Build the application"
}'
# → id: "abc123..."

# Child: fires when parent succeeds
openclaw-scheduler jobs add '{
  "name": "Deploy App",
  "payload_message": "Deploy to production",
  "parent_id": "abc123...",
  "trigger_on": "success"
}'

# Child: fires when parent fails
openclaw-scheduler jobs add '{
  "name": "Build Alert",
  "payload_message": "Build failed — check logs",
  "parent_id": "abc123...",
  "trigger_on": "failure",
  "delivery_mode": "announce",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'
```

**Trigger types:**
- `success` — parent run status = `ok`
- `failure` — parent run status = `error` or `timeout`
- `complete` — any completion (success, failure, or timeout)
- Child jobs are chain-triggered only. Use `trigger_delay_s` to delay a child run; one-shot `schedule_kind: "at"` is for root jobs only.

### Pattern 2: Output-Based Trigger Conditions

```bash
# Only fire child if parent output contains "ALERT"
openclaw-scheduler jobs add '{
  "name": "Alert Handler",
  "parent_id": "<monitor-job-id>",
  "trigger_on": "success",
  "trigger_condition": "contains:ALERT",
  "payload_message": "Handle the alert"
}'

# Regex condition
openclaw-scheduler jobs add '{
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
openclaw-scheduler jobs add '{
  "name": "Deploy",
  "payload_message": "deploy",
  "agent_id": "ops",
  "parent_id": "<build-id>",
  "trigger_on": "success"
}'
```

### Pattern 4: Delayed Triggers

```bash
openclaw-scheduler jobs add '{
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
openclaw-scheduler jobs tree <job-id>

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
openclaw-scheduler jobs add '{
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

This retry ladder now applies uniformly to shell jobs, isolated agent jobs, and main-session jobs that surface dispatch failures.

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
openclaw-scheduler jobs cancel <job-id>
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
openclaw-scheduler msg send <from-agent> <to-agent> "message body"

# Read inbox
openclaw-scheduler msg inbox <agent-id>

# Mark all read
openclaw-scheduler msg readall <agent-id>
```

### Signal Queue Consumer Example

Use this when you want scripts to enqueue only actionable signals, then a single consumer job pushes those signals to Telegram.

```bash
# 1) Enqueue a signal
openclaw-scheduler msg send monitor-agent main "Found 3 critical errors in prod logs"

# 2) Add a consumer shell job (every 5 minutes)
openclaw-scheduler jobs add '{
  "name": "Inbox Consumer",
  "schedule_cron": "*/5 * * * *",
  "session_target": "shell",
  "payload_message": "npm exec --prefix ~/.openclaw/scheduler openclaw-inbox-consumer -- --to YOUR_TELEGRAM_ID",
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
node backup.js restore

# Prune old backups
node backup.js prune
```

**Configuration via environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_BACKUP_MC_ALIAS` | `backupstore` | MinIO client alias |
| `SCHEDULER_BACKUP_BUCKET` | `scheduler-backups` | MinIO bucket name |
| `SCHEDULER_BACKUP_PREFIX` | `scheduler` | Path prefix within bucket |

Requires `mc` (MinIO client) in PATH and a configured `backupstore` alias.

**Built-in (when running as a background service):**
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
openclaw-scheduler agents list
openclaw-scheduler agents get <id>
openclaw-scheduler agents register <id> [name]
```

---

## Database Schema

**Schema version:** 20 | **Mode:** WAL | **Foreign keys:** ON

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
id, name, enabled, schedule_kind, schedule_cron, schedule_at, schedule_tz,
session_target, agent_id, payload_kind, payload_message,
payload_model, payload_thinking, execution_intent, execution_read_only,
overlap_policy, run_timeout_ms, max_queued_dispatches, max_pending_approvals,
max_trigger_fanout, output_store_limit_bytes, output_excerpt_limit_bytes,
output_summary_limit_bytes, output_offload_threshold_bytes,
max_retries, delivery_mode, delivery_channel,
delivery_to, delivery_guarantee, delete_after_run, ttl_hours,
parent_id, trigger_on, trigger_delay_s, trigger_condition,
resource_pool, auth_profile,
approval_required, approval_timeout_s, approval_auto,
context_retrieval, context_retrieval_limit,
preferred_session_key, job_type, watchdog_target_label,
watchdog_check_cmd, watchdog_timeout_min, watchdog_alert_channel,
watchdog_alert_target, watchdog_self_destruct, watchdog_started_at,
next_run_at, last_run_at, last_status, consecutive_errors,
created_at, updated_at
```

### Runs (key columns)

```
id, job_id, status, started_at, finished_at, duration_ms,
last_heartbeat, session_key, session_id, summary,
error_message, shell_exit_code, shell_signal, shell_timed_out,
shell_stdout, shell_stderr, shell_stdout_path, shell_stderr_path,
shell_stdout_bytes, shell_stderr_bytes, dispatched_at, run_timeout_ms,
triggered_by_run, retry_of, retry_count, replay_of
```

**Run statuses:** `pending`, `running`, `ok`, `error`, `timeout`, `skipped`, `cancelled`, `crashed`

### Messages (key columns)

```
id, from_agent, to_agent, reply_to, kind, subject, body,
metadata, priority, channel, owner, status, delivered_at,
read_at, expires_at, created_at, job_id, run_id
```

### Agents (10 columns)

```
id, name, status, last_seen_at, session_key, capabilities,
delivery_channel, delivery_to, brand_name, created_at
```

---

## CLI Reference

```bash
# ── Jobs ──────────────────────────────────────────
openclaw-scheduler jobs list                     # List all (shows agent, parent, trigger)
openclaw-scheduler jobs get <id>                 # Full details as JSON
openclaw-scheduler jobs add '<json>'             # Create a job
openclaw-scheduler jobs update <id> '<json>'     # Partial update
openclaw-scheduler jobs enable <id>
openclaw-scheduler jobs disable <id>              # NOTE: disabled jobs are auto-pruned after 24h
openclaw-scheduler jobs delete <id>              # Cascades to runs
openclaw-scheduler jobs tree                     # Visual chain hierarchy
openclaw-scheduler jobs cancel <id>              # Cancel running chain

# ── Runs ──────────────────────────────────────────
openclaw-scheduler runs list <job-id> [limit]    # Run history
openclaw-scheduler runs get <run-id>             # Full run details
openclaw-scheduler runs output <run-id> stdout   # Stored/offloaded stdout or stderr
openclaw-scheduler runs running                  # Active runs
openclaw-scheduler runs stale [threshold-s]      # Stale runs (default 90s)

# ── Messages ──────────────────────────────────────
openclaw-scheduler msg send <from> <to> <body>
openclaw-scheduler msg inbox <agent-id> [limit]
openclaw-scheduler msg outbox <agent-id> [limit]
openclaw-scheduler msg thread <message-id>
openclaw-scheduler msg ack <message-id> [actor] [note]
openclaw-scheduler msg receipts <message-id> [limit]
openclaw-scheduler msg team-inbox <team-id> [limit] [member-id] [task-id]
openclaw-scheduler msg read <message-id>
openclaw-scheduler msg readall <agent-id>
openclaw-scheduler msg unread <agent-id>

# ── Agents ────────────────────────────────────────
openclaw-scheduler agents list
openclaw-scheduler agents get <id>
openclaw-scheduler agents register <id> [name]

# ── Approvals ─────────────────────────────────────
openclaw-scheduler jobs approve <id>            # Approve pending gate
openclaw-scheduler jobs reject <id> [reason]    # Reject pending gate
openclaw-scheduler approvals list               # All pending approvals

# ── Task Tracker ──────────────────────────────────
openclaw-scheduler tasks create '<json>'        # Create task group
openclaw-scheduler tasks list                   # Active task groups
openclaw-scheduler tasks status <id>            # Detailed status
openclaw-scheduler tasks history [limit]        # Recently completed groups
openclaw-scheduler tasks heartbeat <id> <label> running|completed|failed [msg]
openclaw-scheduler tasks register-session <id> <label> <session-key>  # Enable auto-heartbeat

# ── Queue ─────────────────────────────────────────
openclaw-scheduler queue list [agent] [limit]    # Pending + delivered messages
openclaw-scheduler queue clear [agent]           # Mark all messages read
openclaw-scheduler queue prune                   # Prune old messages

# ── Team Adapter ─────────────────────────────────
openclaw-scheduler team map [limit]                          # Project team messages into events
openclaw-scheduler team tasks <team-id> [limit]              # List team tasks
openclaw-scheduler team events <team-id> [limit] [task-id]   # List team events
openclaw-scheduler team gate <team-id> <task-id> <members-json> [timeout-s]
openclaw-scheduler team check-gates [limit]                  # Evaluate task gates
openclaw-scheduler team ack <message-id> [actor] [note]      # Team-aware ACK

# ── Idempotency ──────────────────────────────────
openclaw-scheduler idem status <job-id>          # Recent idempotency keys
openclaw-scheduler idem check <key>              # Check if key is claimed
openclaw-scheduler idem release <key>            # Manually release a key
openclaw-scheduler idem prune                    # Force prune expired entries

# ── Delivery Aliases ──────────────────────────────
openclaw-scheduler alias list                 # List all aliases
openclaw-scheduler alias add <name> <channel> <target> [description]
openclaw-scheduler alias remove <name>

# ── Schema Introspection ─────────────────────────
openclaw-scheduler schema jobs              # JSON schema for job fields (types, defaults, enums)
openclaw-scheduler schema runs              # Run statuses and key fields
openclaw-scheduler schema messages          # Message kinds and statuses
openclaw-scheduler schema approvals         # Approval statuses
openclaw-scheduler schema dispatches        # Dispatch kinds and statuses
openclaw-scheduler schema all               # Everything

# ── Status ────────────────────────────────────────
openclaw-scheduler status
```

All CLI commands support `--json` for machine-readable output (useful for piping into `jq` or agent toolchains).

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Gateway auth token |
| `SCHEDULER_HOME` | `~/.openclaw/scheduler` | Base dir for scheduler data when installed from npm or when the package dir is not a writable source checkout |
| `SCHEDULER_DB` | auto (`./scheduler.db` in a writable source checkout, else `~/.openclaw/scheduler/scheduler.db`) | SQLite database path |
| `SCHEDULER_BACKUP_STAGING_DIR` | `~/.openclaw/scheduler/.backup-staging` | Temp folder used by `backup.js` snapshot/restore |
| `SCHEDULER_TICK_MS` | `10000` | Tick interval (10s) |
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Stale run threshold |
| `SCHEDULER_HEARTBEAT_CHECK_MS` | `30000` | Health check interval |
| `SCHEDULER_MESSAGE_DELIVERY_MS` | `15000` | Message + spawn processing interval |
| `SCHEDULER_PRUNE_MS` | `3600000` | Prune interval (1 hour) |
| `SCHEDULER_BACKUP_MS` | `300000` | MinIO backup interval (5 min) |
| `SCHEDULER_BACKUP` | *(unset)* | Set to `1` to enable MinIO backups (requires `mc` CLI) |
| `SCHEDULER_BACKUP_MC_ALIAS` | `backupstore` | MinIO alias used by `mc` for backup snapshots |
| `SCHEDULER_BACKUP_BUCKET` | `scheduler-backups` | MinIO bucket for snapshots |
| `SCHEDULER_BACKUP_PREFIX` | `scheduler` | Object prefix inside bucket |
| `SCHEDULER_ARTIFACTS_DIR` | `~/.openclaw/scheduler/artifacts` | Directory for offloaded shell stdout/stderr files |
| `SCHEDULER_DEBUG` | *(unset)* | `1` for debug logging |
| `SCHEDULER_SHELL` | `/bin/zsh` (macOS), `/bin/bash` (Linux/WSL), `cmd.exe` (Windows) | Shell used for shell jobs |
| `DISPATCH_CONFIG_DIR` | `~/.openclaw/dispatch` | Override dispatch config directory (labels.json, config.json) |
| `DISPATCH_LABELS_PATH` | *(auto)* | Override path to labels.json for dispatch session tracking |
| `DISPATCH_INDEX_PATH` | *(auto)* | Override path to dispatch/index.mjs (used by watcher) |
| `DISPATCH_HOST` | `hostname()` | Host identifier sent with dispatch hook events |
| `DISPATCH_WEBHOOK_URL` | *(unset)* | Webhook URL for dispatch lifecycle events (hooks.mjs) |
| `LOKI_PUSH_URL` | *(unset)* | Loki push endpoint for dispatch event logging (hooks.mjs) |
| `TELEGRAM_BOT_TOKEN` | *(unset)* | Bot token for webhook health check utility |
| `TELEGRAM_WEBHOOK_URL` | *(unset)* | Expected webhook URL for Telegram webhook check |
| `INBOX_AGENT` | `main` | Target agent for inbox-consumer.mjs |
| `INBOX_DELIVERY_CHANNEL` | *(unset)* | Delivery channel for inbox-consumer.mjs forwarding |
| `INBOX_DELIVERY_TO` | *(unset)* | Delivery target for inbox-consumer.mjs forwarding |
| `INBOX_LIMIT` | `10` | Batch size for inbox-consumer.mjs |

---

## Service Management

> **Platform note:** The commands below are for macOS (launchd). For Linux, see [INSTALL-LINUX.md](INSTALL-LINUX.md). For Windows, see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

Choose the launchd mode that matches your host:
- **LaunchAgent**: best for a personal Mac that auto-logs in and should run the scheduler in your user session
- **LaunchDaemon**: best for a headless Mac or for starting the scheduler before login

Install either mode with the setup wizard:

```bash
openclaw-scheduler setup --service-mode agent
# or
openclaw-scheduler setup --service-mode daemon
```

### macOS LaunchAgent

```bash
# Start / bootstrap
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Stop
launchctl bootout gui/$UID/ai.openclaw.scheduler

# Restart
launchctl kickstart -k gui/$UID/ai.openclaw.scheduler

# Status
launchctl print gui/$UID/ai.openclaw.scheduler
ps aux | grep dispatcher | grep -v grep

# Logs
tail -f /tmp/openclaw-scheduler.log

# Quick health
openclaw-scheduler status
```

### macOS LaunchDaemon

```bash
# Start / bootstrap
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.scheduler.plist

# Stop
sudo launchctl bootout system/ai.openclaw.scheduler

# Restart
sudo launchctl kickstart -k system/ai.openclaw.scheduler

# Status
sudo launchctl print system/ai.openclaw.scheduler
ps aux | grep dispatcher | grep -v grep

# Logs
tail -f /tmp/openclaw-scheduler.log

# Quick health
openclaw-scheduler status
```

Both modes use `RunAtLoad: true` and `KeepAlive: true`. LaunchDaemon also sets `UserName: <your-user>` so the service runs under your OpenClaw account while still surviving headless reboots.

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

As of public release `v0.1.0`, the schema is consolidated in `schema.sql` (baseline `v14`, now `v20`).

- Net-new installs: `initDb()` applies `schema.sql` directly.
- Existing/pre-release DBs: `initDb()` runs `migrate-consolidate.js` to backfill missing columns/tables/indexes.

### What was disabled in OpenClaw

| System | How disabled | Revert |
|--------|-------------|--------|
| Built-in cron | Jobs disabled (`openclaw cron edit <id> --disable`) + global cron off (`cron.enabled=false`) + gateway env `OPENCLAW_SKIP_CRON=1` | Re-enable jobs + `cron.enabled=true` + unset `OPENCLAW_SKIP_CRON` |
| Heartbeat | `agents.defaults.heartbeat.every: "0m"` and disable/remove any per-agent `agents.list[].heartbeat` overrides | Set defaults/per-agent heartbeat cadence back (for example `"5m"`) |
| Chat completions | Enabled for scheduler | Can leave enabled |

### Public release

| Version | Date | Schema | Key changes |
|---------|------|--------|-------------|
| 0.2.0 | 2026-03-11 | v20 | Dispatch `done` hardening, auth profile support, one-shot `at` scheduling, expanded type coverage, UTC scheduling defaults, and portability/runtime fixes |
| 0.1.0 | 2026-03-08 | v14 | First public release: workflow engine, structured shell failure triage, watchdog jobs, output offloading, execution-intent controls, safer migration checks, and public-release cleanup |

### Pre-public development milestones

| Date | Former internal tag | Schema | Key changes |
|------|----------------------|--------|-------------|
| 2026-02-21 | 0.1.0 | v1 | Initial: jobs, runs, messages, agents, standalone dispatch |
| 2026-02-22 | 0.4.0 | v3 | Workflow chains, cycle detection, spawn messages, multi-agent |
| 2026-02-23 | 0.5.0 | v3b | Retry logic, max chain depth, chain cancellation, queue overlap |
| 2026-02-24 | 0.6.0 | v5 | Shell jobs, announce-always, MinIO backup, resource pools, delivery aliases |
| 2026-02-25 | 0.7.0 | v6/v7 | Idempotency, at-least-once, context retrieval, approval gates, task tracker, typed messages |
| 2026-02-26 | 1.0.0 | v6 | Docs, LICENSE, CHANGELOG, package metadata |
| 2026-03-02 | 1.0.1 | v9 | Consolidated schema + migration path, task tracker heartbeat/session baseline columns, session reuse field, Windows shell default fix (`cmd.exe`) |
| 2026-03-03 | 1.0.2 | v10 | Team-aware routing fields on messages, explicit message receipt events, team adapter projection + task completion gates |
| 2026-03-05 | 1.0.3 | v10 | Dispatch hardening: seeded 529 recovery job reconciliation, watcher token-telemetry safeguards, robust home-path resolution, and watcher DB checks without external `sqlite3` CLI |
| 2026-03-08 | 1.1.0 | v13 | Structured shell failure triage, watchdog job type, safer migration skip checks, and public-release cleanup for docs/examples |

---

## Removing the Scheduler

To stop the scheduler and restore OpenClaw's built-in cron/heartbeat, see [UNINSTALL.md](UNINSTALL.md).

Quick summary:
1. Stop the service (launchctl / systemctl / pm2)
2. Re-enable OC cron globally: `openclaw config set cron.enabled true` and remove `OPENCLAW_SKIP_CRON=1` from gateway service env
3. Re-enable OC cron jobs: `openclaw cron edit <id> --enable` for each job
4. Re-enable heartbeat: `openclaw config set agents.defaults.heartbeat.every "5m"` and restore any per-agent `agents.list[].heartbeat` overrides you use
5. Optionally delete `~/.openclaw/scheduler/`

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
├── schema.sql             # Complete schema (v20) — all tables and columns, no incremental DDL
├── migrate-consolidate.js # Single migration for existing DBs: brings any prior version to v20
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
├── backup.js              # MinIO snapshot/rollup/restore (requires `mc` CLI)
├── cli.js                 # CLI management tool
├── migrate.js             # Import from OC jobs.json
├── scripts/
│   ├── dispatch-cli-utils.mjs       # Dispatch CLI path resolution helpers
│   ├── inbox-consumer.mjs           # Drains queue messages and delivers to Telegram
│   ├── stuck-run-detector.mjs       # Detects stale running runs (alert-only via non-zero exit)
│   └── telegram-webhook-check.mjs   # Telegram webhook health check / repair utility
│
│  Service & docs
├── ~/Library/LaunchAgents/ai.openclaw.scheduler.plist  # macOS LaunchAgent location after install
├── /Library/LaunchDaemons/ai.openclaw.scheduler.plist  # macOS LaunchDaemon location after install
├── INSTALL.md             # Full installation guide — macOS (first host)
├── INSTALL-ADDITIONAL-HOST.md  # Installation guide for additional hosts
├── INSTALL-LINUX.md       # Installation guide for Linux (systemd user service)
├── INSTALL-WINDOWS.md     # Installation guide for Windows (WSL2 or PM2)
├── UNINSTALL.md           # Removal guide (all platforms)
├── BEST-PRACTICES.md      # Job type selection, prompt writing, agent integration
├── openclaw-scheduler.service  # Linux systemd user service template
├── CHANGELOG.md           # Version history
└── README.md              # This file
```

---

## Testing

```bash
# Run all tests (1013 tests, in-memory SQLite)
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

## Sub-agent Dispatch

The dispatch module (`dispatch/index.mjs`) spawns and steers isolated agent sessions via the OpenClaw Gateway API and tracks them by a human-readable label. Unlike the scheduler's job/run model, dispatch calls the gateway directly -- no scheduler tick delay, no DB write required to start a session. Each session is assigned a unique session key, recorded in a local `labels.json` ledger, and auto-announces its result when the agent calls `done` as its final action. The module also supports symlink-based branding: a wrapper directory (such as `my-brand`) contains a `config.json` with a custom name and a symlink to `dispatch/index.mjs`, giving the same CLI a different identity in notifications and logs.

### Quick Example

```bash
# Dispatch a sub-agent task and deliver the result to Telegram
openclaw-scheduler enqueue \
  --label       "fix-deploy-script"                                          \
  --message     "Fix the deploy script in ~/app to handle missing .env files" \
  --mode        fresh                                                         \
  --thinking    high                                                          \
  --timeout     3600                                                          \
  --deliver-to  YOUR_TELEGRAM_ID                                                     \
  --delivery-mode announce

# Fallback (if openclaw-scheduler is not in PATH):
node ~/.openclaw/scheduler/dispatch/index.mjs enqueue \
  --label "fix-deploy-script" --message "..." --deliver-to YOUR_TELEGRAM_ID
```

### Flag Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--label` | required | Human-readable name for the session. Used for status lookups, reuse, and watchdog tracking. |
| `--message` | required* | Prompt sent to the agent. |
| `--message-file` | -- | Path to a file whose contents are used as the prompt. Alternative to `--message`; avoids shell-escaping issues with long prompts. |
| `--mode` | `fresh` | `fresh` creates a new session. `reuse` continues the last session recorded for this label. |
| `--thinking` | -- | Reasoning budget: `low`, `high`, or `xhigh`. |
| `--model` | -- | Model override, e.g. `anthropic/claude-sonnet-4-6`. |
| `--deliver-to` | -- | Delivery target (e.g. Telegram chat ID). Registers a scheduler watcher job for reliable at-least-once delivery. |
| `--delivery-mode` | `announce` | `announce` delivers only when output is non-empty. `announce-always` delivers unconditionally. `none` suppresses delivery. |
| `--timeout` | `300` | Session timeout in seconds. |
| `--monitor` | on | Auto-register a watchdog job that alerts if the session goes silent past the configured threshold. |
| `--no-monitor` | -- | Disable watchdog registration for this dispatch. |

*Either `--message` or `--message-file` is required.

### Subcommand Reference

| Subcommand | Description |
|------------|-------------|
| `enqueue` | Spawn a new agent session (or resume one with `--mode reuse`) and optionally register a scheduler watcher for delivery. |
| `status` | Show current status for a label: session key, spawn time, running/done/error, and liveness data from the sessions store. |
| `stuck` | Check all running sessions against the stuck threshold. Exits 1 if genuinely stuck sessions remain after auto-resolving completed ones. |
| `result` | Retrieve the last assistant reply from a session transcript via `chat.history`. |
| `sync` | Reconcile `labels.json` with sessions store state. Auto-marks sessions as done or error based on idle time. Supports `--dry-run`. |
| `done` | Agent-side completion signal. The agent calls this as its final action to mark itself done immediately (push-based; no idle timeout wait). |
| `send` | Inject a message into a running session for mid-run steering. The agent sees it as a new user turn. |
| `steer` | Alias for `send`. The name makes steering intent explicit. |
| `heartbeat` | Check whether a session has been active within the last 10 minutes. Accepts `--label` or `--session-key`. |
| `list` | List all tracked labels in `labels.json`, sorted by most recent. Accepts `--status running|done|error` and `--limit`. |

### Multi-agent Orchestration

The main agent acts as the orchestrator and delegates parallel units of work to sub-agents via `enqueue`. Each sub-agent runs in an isolated session, completes its assigned task, and calls `done` as its last action. Results are delivered back to the requesting Telegram chat without the orchestrator polling.

**Spawn depth constraint:** The gateway enforces `maxSpawnDepth: 2`. The main agent (depth 0) spawns sub-agents (depth 1), which can spawn nested sub-agents (depth 2). Depth 3 is blocked. The dispatcher sets `spawnDepth: 1` on each fresh session automatically.

**Example: 3 parallel workers**

```bash
# Orchestrator dispatches three workers in parallel.
# All three run concurrently in isolated sessions.

openclaw-scheduler enqueue \
  --label   "worker-schema"   \
  --message "Review the DB schema and write documentation for all tables" \
  --thinking high --timeout 600 --deliver-to YOUR_TELEGRAM_ID

openclaw-scheduler enqueue \
  --label   "worker-frontend" \
  --message "Audit the React components for accessibility issues" \
  --thinking high --timeout 600 --deliver-to YOUR_TELEGRAM_ID

openclaw-scheduler enqueue \
  --label   "worker-docs"     \
  --message "Update the API docs to reflect the new /v2 endpoints" \
  --thinking high --timeout 600 --deliver-to YOUR_TELEGRAM_ID

# Each worker auto-announces its result to Telegram when done.
# No polling needed. Watchdog jobs are auto-registered for each.
```

Check status at any time:

```bash
openclaw-scheduler list --status running
openclaw-scheduler status --label worker-schema
```

### Branding and Configuration

`dispatch/index.mjs` resolves `config.json` relative to the directory of the invoking script, not the module itself. This means a symlink at `~/.openclaw/my-brand/index.mjs -> ~/.openclaw/scheduler/dispatch/index.mjs` will load `~/.openclaw/my-brand/config.json`, giving the same CLI a different brand name and defaults. All config fields are optional.

**`config.json` fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `name` | `"dispatch"` | Brand name shown in Telegram notifications and log output. |
| `startupGraceMs` | `90000` | Grace period (ms) after spawn before stuck detection and auto-resolve activate. |
| `stuckThresholdMs` | `600000` | Silence duration (ms) before a session is considered stuck. |
| `maxWatcherAgeMs` | `7200000` | Max watcher process age (ms) before it is treated as stale. |
| `watchdogIntervalCron` | `"*/15 * * * *"` | Cron schedule for the auto-registered watchdog job. |
| `watchdogTimeoutMin` | `60` | Sessions running longer than this (minutes) without completing trigger a watchdog alert. |
| `deliver_watcher_ttl_hours` | `48` | TTL (hours) for scheduler-registered deliver-watcher jobs. These jobs are transient; they auto-prune once delivery is confirmed. Lower values prune faster; higher values retain audit history longer. |

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `DISPATCH_LABELS_PATH` | Override path for `labels.json`. Default: `<invoke_dir>/labels.json`. |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token. Falls back to `~/.openclaw/openclaw.json` if unset. |

**Minimal `config.json`:**

```json
{
  "name": "my-brand",
  "watchdogIntervalCron": "*/15 * * * *",
  "watchdogTimeoutMin": 60
}
```

### Monitoring and the Watchdog

When `--deliver-to` is set and `--no-monitor` is not passed, `enqueue` automatically registers a watchdog job in the scheduler DB alongside the delivery watcher job. The watchdog runs on the configured cron schedule and calls `stuck --threshold-min <watchdogTimeoutMin>` for the dispatched label. If the session has been silent past the threshold, the watchdog posts an alert to the configured Telegram target and then disables itself.

Check active dispatch sessions:

```bash
# List all running dispatch sessions
openclaw-scheduler list --status running

# Check whether any session is stuck (exits 1 if found)
node ~/.openclaw/scheduler/dispatch/index.mjs stuck --threshold-min 15

# Status for a specific label
openclaw-scheduler status --label fix-deploy-script
```

The watchdog disarms itself automatically when the agent calls `done`, when `status` or `sync` auto-resolves the session from gateway idle state, or when `result` is fetched after a successful completion.

---

## Troubleshooting

### Dispatcher isn't dispatching

```bash
ps aux | grep dispatcher              # Is it running?
tail -20 /tmp/openclaw-scheduler.log   # Any errors?
curl http://127.0.0.1:18789/health     # Gateway reachable?
openclaw-scheduler jobs list                  # Is nextRun in the past?
openclaw-scheduler runs running               # Overlap blocking?
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
# LaunchAgent
plutil -lint ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
launchctl print gui/$UID/ai.openclaw.scheduler

# LaunchDaemon
sudo plutil -lint /Library/LaunchDaemons/ai.openclaw.scheduler.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.scheduler.plist
sudo launchctl print system/ai.openclaw.scheduler
```

### Logs not updating

Dispatcher logs to stderr (unbuffered). If logs look stale, the process may have crashed. Check the service that matches your launchd mode:
- LaunchAgent: `launchctl print gui/$UID/ai.openclaw.scheduler`
- LaunchDaemon: `sudo launchctl print system/ai.openclaw.scheduler`

### Job shows 'awaiting_approval'

```bash
openclaw-scheduler approvals list
openclaw-scheduler jobs approve <id>   # or reject
```

### Backup failing

```bash
mc alias list   # verify backupstore alias configured
# Check: SCHEDULER_BACKUP_MC_ALIAS, SCHEDULER_BACKUP_BUCKET, SCHEDULER_BACKUP_PREFIX env vars or defaults in backup.js
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
