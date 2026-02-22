# OpenClaw Scheduler v4

A standalone job scheduler, workflow engine, and inter-agent message router for OpenClaw. Replaces OpenClaw's built-in cron and heartbeat systems with a SQLite-backed scheduler that dispatches independently via the chat completions API.

**Repo:** `github.com/amittell/openclaw-scheduler` (private)
**Location:** `~/.openclaw/scheduler/`
**Service:** `ai.openclaw.scheduler` (macOS LaunchAgent)
**Runtime:** Node.js (ESM), SQLite via `better-sqlite3`, cron parsing via `croner`
**Tests:** 169 (91 unit + 78 dispatcher integration)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [How Jobs Execute](#how-jobs-execute)
4. [Workflow Chains](#workflow-chains)
5. [Retry Logic](#retry-logic)
6. [Chain Safety](#chain-safety)
7. [Inter-Agent Messaging](#inter-agent-messaging)
8. [Agent Registry](#agent-registry)
9. [Database Schema](#database-schema)
10. [CLI Reference](#cli-reference)
11. [Configuration](#configuration)
12. [Service Management](#service-management)
13. [Error Handling & Backoff](#error-handling--backoff)
14. [Migration & History](#migration--history)
15. [File Reference](#file-reference)
16. [Testing](#testing)
17. [Troubleshooting](#troubleshooting)

---

## System Overview

The scheduler sits alongside the OpenClaw gateway as an independent process. It creates **isolated sessions** for each job — they never touch the user's main conversation.

```
┌─────────────────────────────────────────────┐
│  Host Machine (e.g., scheduler-host.local)            │
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
│    ├─ Inter-agent message queue              │
│    └─ Agent registry                         │
└─────────────────────────────────────────────┘
```

**What replaced what:**

| Before (OC built-in) | After (scheduler) |
|----------------------|-------------------|
| `~/.openclaw/cron/jobs.json` | SQLite `jobs` table with run history |
| `heartbeat.every: "5m"` | Scheduled jobs (e.g., "Daily Workspace Audit") |
| No run tracking | Full run lifecycle with status, duration, summary |
| No chain support | Parent/child jobs with trigger-on-completion |
| No retry | Auto-retry with configurable attempts and delay |
| No inter-agent comms | Message queue with priority, threading, broadcast |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Dispatcher Loop (10s tick)                  │
│                                                              │
│  1. Gateway health check                                     │
│  2. Find due jobs (next_run_at <= now, enabled=1)            │
│  3. Dispatch:                                                │
│     • isolated → POST /v1/chat/completions (unique session)  │
│     • main     → openclaw system event CLI                   │
│  4. On completion: trigger child jobs in chain               │
│  5. On failure: retry if attempts remain                     │
│  6. Deliver results to Telegram/channel if configured        │
│  7. Process spawn messages (runtime job creation)            │
│  8. Check running runs for staleness (90s threshold)         │
│  9. Expire old messages / prune old runs (hourly)            │
└──────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌───────────────────┐        ┌──────────────────────┐
  │     SQLite DB      │        │   OpenClaw Gateway    │
  │                    │        │                       │
  │  • jobs (29 cols)  │        │  • /v1/chat/completions│
  │  • runs (16 cols)  │        │  • /tools/invoke      │
  │  • messages (17)   │        │  • /health            │
  │  • agents (7)      │        │  • system event CLI   │
  └───────────────────┘        └──────────────────────┘
```

### Session Types

| Session | Created By | Lifetime | Used For |
|---------|-----------|----------|----------|
| User DM | Telegram message | Persistent per-peer | Your conversations |
| Group chat | Group message | Persistent per-group | Team discussions |
| Scheduler job | Dispatcher via API | One-shot, dies after completion | Cron jobs, chain steps |
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

### Prompt Building

Each isolated job prompt includes:
1. Header: `[scheduler:<job_id> <job_name>]`
2. Pending inbox messages for the agent (up to 5)
3. The job's `payload_message`

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

### Pattern 2: Multi-Agent Workflows

Chain jobs targeting different agents:

```
Build (agent: main, cron: 10am)
  └─ Deploy (agent: ops, trigger: success)
      └─ Health Check (agent: main, trigger: success, delay: 60s)
```

```bash
node cli.js jobs add '{"name":"Deploy","payload_message":"deploy","agent_id":"ops","parent_id":"<build-id>","trigger_on":"success"}'
```

### Pattern 3: Delayed Triggers

```bash
node cli.js jobs add '{
  "name": "Post-Deploy Check",
  "payload_message": "Verify services healthy",
  "parent_id": "<deploy-id>",
  "trigger_on": "success",
  "trigger_delay_s": 60
}'
```

The child won't fire until 60 seconds after the parent completes.

### Pattern 4: Runtime Spawning

A running agent can create new jobs on the fly by sending a `spawn` message:

```json
{
  "from_agent": "main",
  "to_agent": "scheduler",
  "kind": "spawn",
  "body": "{\"name\":\"Dynamic Task\",\"payload_message\":\"analyze results\",\"delete_after_run\":true,\"run_now\":true}"
}
```

The dispatcher processes spawn messages every 15 seconds.

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
  "max_retries": 3,
  "retry_delay_s": 30
}'
```

**How it works:**

1. Job fails → check `max_retries`
2. Retries remaining → schedule retry after `retry_delay_s` seconds
3. Retry run tracks lineage: `retry_of` → failed run ID, `retry_count` incremented
4. All retries exhausted → trigger failure children + apply error backoff
5. Any retry succeeds → trigger success children, reset `consecutive_errors`

**Key:** failure children don't fire until all retries are exhausted. This prevents false alerts on transient failures.

| Field | Default | Description |
|-------|---------|-------------|
| `max_retries` | 0 | Max retry attempts (0 = no retry) |
| `retry_delay_s` | 30 | Seconds between retries |
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
- **Kinds:** `text`, `task`, `result`, `status`, `system`, `spawn`
- **Job linking:** messages can reference `job_id` and `run_id`

### Delivery

Messages are delivered inline with job prompts. When the dispatcher builds a prompt, it includes up to 5 pending messages for the target agent, marked as `delivered`.

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

---

## Database Schema

**Schema version:** 4 | **Mode:** WAL | **Foreign keys:** ON

### Jobs (29 columns)

```
id, name, enabled, schedule_cron, schedule_tz,
session_target, agent_id, payload_kind, payload_message,
payload_model, payload_thinking, payload_timeout_seconds,
overlap_policy, run_timeout_ms, max_retries, retry_delay_s,
delivery_mode, delivery_channel, delivery_to,
delete_after_run, parent_id, trigger_on, trigger_delay_s,
next_run_at, last_run_at, last_status, consecutive_errors,
created_at, updated_at
```

### Runs (16 columns)

```
id, job_id, status, started_at, finished_at, duration_ms,
last_heartbeat, session_key, session_id, summary,
error_message, dispatched_at, run_timeout_ms,
triggered_by_run, retry_of, retry_count
```

**Run statuses:** `pending`, `running`, `ok`, `error`, `timeout`, `skipped`, `cancelled`

### Messages (17 columns)

```
id, from_agent, to_agent, reply_to, kind, subject, body,
metadata, priority, channel, status, delivered_at, read_at,
expires_at, created_at, job_id, run_id
```

### Agents (7 columns)

```
id, name, status, last_seen_at, session_key, capabilities, created_at
```

### Indexes (8)

`idx_jobs_next_run`, `idx_jobs_parent`, `idx_runs_job_id`, `idx_runs_status`, `idx_messages_to`, `idx_messages_from`, `idx_messages_created`, `idx_messages_pending`

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
| `SCHEDULER_DEBUG` | *(unset)* | `1` for debug logging |

---

## Service Management

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

`GET /health` checked before each tick. If unreachable, entire tick is skipped.

---

## Migration & History

### Importing from OC cron

```bash
node migrate.js   # imports from ~/.openclaw/cron/jobs.json
```

### Schema migrations

```bash
node migrate-v3.js   # v2 → v3 (chain columns)
node migrate-v4.js   # v3 → v4 (retry columns)
```

### What was disabled in OpenClaw

| System | How disabled | Revert |
|--------|-------------|--------|
| Built-in cron | All jobs set `enabled: false` via API | `openclaw cron edit <id> --enable` |
| Heartbeat | `heartbeat.every: "0m"` | Set back to `"5m"` |
| Chat completions | Enabled for scheduler | Can leave enabled |

### Version history

| Version | Date | Changes |
|---------|------|---------|
| v2 | 2026-02-21 | Initial: jobs, runs, messages, agents, standalone dispatch |
| v3 | 2026-02-22 | Workflow chains: parent_id, trigger_on, trigger_delay_s, cycle detection, spawn messages, multi-agent |
| v4 | 2026-02-22 | Retry logic, max chain depth (10), chain cancellation, async chain fix |

---

## File Reference

```
~/.openclaw/scheduler/
├── dispatcher.js          # Main process — tick loop, dispatch, chains, retry
├── db.js                  # SQLite connection (WAL, FK ON)
├── schema.sql             # v4 schema definition
├── jobs.js                # Job CRUD, cron, chains, cycle detection
├── runs.js                # Run lifecycle, stale/timeout, cancellation
├── messages.js            # Inter-agent message queue
├── agents.js              # Agent registry
├── gateway.js             # OpenClaw API client (chat completions, events, delivery)
├── cli.js                 # CLI management tool
├── migrate.js             # Import from OC jobs.json
├── migrate-v3.js          # Schema v2 → v3
├── migrate-v4.js          # Schema v3 → v4
├── test.js                # Unit tests (91)
├── test-dispatcher.js     # Dispatcher integration tests (78)
├── scheduler.db           # Live SQLite database (gitignored)
├── package.json           # Dependencies
├── INSTALL-ADDITIONAL-HOST.md  # Installation guide for additional hosts
└── README.md              # This file
```

---

## Testing

### Run all tests

```bash
cd ~/.openclaw/scheduler
SCHEDULER_DB=:memory: node test.js            # 91 unit tests
SCHEDULER_DB=:memory: node test-dispatcher.js  # 78 integration tests
```

### Unit tests (test.js) — 91 assertions

- Schema creation & integrity
- Job CRUD, cron parsing, due detection
- Run lifecycle (create, heartbeat, finish, stale, timeout)
- Agent registry (upsert, status, capabilities)
- Message queue (14 operations, 5 kinds, priority, broadcast, expiry)
- Cascade deletes, pruning
- Workflow chains (parent/child, trigger matching, tree traversal)
- Cycle detection (self, deep)
- Max chain depth enforcement
- Retry tracking (retry_of, retry_count)
- Chain cancellation (cascade, no-op on finished)

### Dispatcher integration tests (test-dispatcher.js) — 78 assertions

Uses a mock gateway to test the full dispatch pipeline:

1. Basic isolated dispatch (prompt, delivery, run tracking)
2. Main session dispatch (system event)
3. Failed dispatch (error status, error message queued)
4. HEARTBEAT_OK suppresses delivery
5. Skip-overlap policy
6. One-shot job deletion
7. Retry logic — full 3-attempt cycle, failure children wait
8. Retry succeeds on 2nd attempt → success children fire
9. Chain trigger — 3-deep success path (A→B→C)
10. Chain trigger — failure path (correct children fire)
11. Delayed triggers (scheduled, not immediate)
12. Spawn message processing
13. Invalid spawn rejection
14. Chain cancellation
15. buildJobPrompt includes pending messages
16. Delivery suppressed without channel/target
17. delivery_mode=none suppresses delivery
18. Error backoff calculation
19. Multi-agent chain dispatch (main→ops)
20. getRetryInfo edge cases
21. Consecutive error tracking across retries
22. Complete trigger fires on both success and failure

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
