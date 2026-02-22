# OpenClaw Scheduler v2

A full standalone job scheduler, dispatcher, and inter-agent message router for OpenClaw. Replaces OpenClaw's built-in `cron/jobs.json` and heartbeat system with a SQLite-backed scheduler that dispatches independently via the OpenAI-compatible chat completions API.

**Repo:** `github.com/amittell/openclaw-scheduler` (private)  
**Location:** `~/.openclaw/scheduler/`  
**Service:** `ai.openclaw.scheduler` (macOS LaunchAgent)  
**Runtime:** Node.js (ESM), SQLite via `better-sqlite3`, cron parsing via `croner`

---

## Table of Contents

1. [Architecture](#architecture)
2. [Why This Exists](#why-this-exists)
3. [Components](#components)
4. [Database Schema](#database-schema)
5. [Dispatch Flow](#dispatch-flow)
6. [Stale Run Detection](#stale-run-detection)
7. [Inter-Agent Messaging](#inter-agent-messaging)
8. [Agent Registry](#agent-registry)
9. [CLI Reference](#cli-reference)
10. [Configuration](#configuration)
11. [Service Management](#service-management)
12. [Migration from OpenClaw Cron](#migration-from-openclaw-cron)
13. [What Was Deprecated](#what-was-deprecated)
14. [Error Handling & Backoff](#error-handling--backoff)
15. [File Reference](#file-reference)
16. [Testing](#testing)
17. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Dispatcher Loop (10s tick)                  │
│                                                              │
│  1. Gateway health check                                     │
│  2. Find due jobs (next_run_at <= now, enabled=1)            │
│  3. Dispatch:                                                │
│     • main session → openclaw system event CLI               │
│     • isolated     → POST /v1/chat/completions               │
│  4. Check running runs for staleness (implicit heartbeat)    │
│  5. Deliver pending inter-agent messages                     │
│  6. Expire old messages / prune old runs (hourly)            │
└──────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌───────────────────┐        ┌──────────────────────┐
  │     SQLite DB      │        │   OpenClaw Gateway    │
  │                    │        │   (127.0.0.1:18789)   │
  │  • jobs            │        │                       │
  │  • runs            │        │  • /v1/chat/completions│
  │  • messages        │        │  • /tools/invoke      │
  │  • agents          │        │  • system event CLI   │
  └───────────────────┘        └──────────────────────┘
```

### Data Flow

1. **Scheduler tick** (every 10s): queries `jobs` table for rows where `enabled=1` AND `next_run_at <= datetime('now')`
2. **Skip-overlap check**: if `overlap_policy='skip'` and a run with `status='running'` exists for this job, skip
3. **Dispatch**:
   - **Main session jobs**: fires `openclaw system event --text "..." --mode now` which injects into the main agent session
   - **Isolated jobs**: sends `POST /v1/chat/completions` with the job prompt, targeting a unique session key (`scheduler:<job_id>:<run_id>`)
4. **Run tracking**: creates a `runs` row with `status='running'`, updates to `ok`/`error`/`timeout` on completion
5. **Delivery**: if `delivery_mode='announce'`, sends the agent's response to the configured channel (e.g., Telegram) via `/tools/invoke` → `message` tool
6. **Message queue**: result is also queued as an inter-agent message for traceability

---

## Why This Exists

OpenClaw's built-in cron system stores jobs in a flat JSON file (`~/.openclaw/cron/jobs.json`) with no run history, no stale detection, and no inter-agent communication. The heartbeat system runs periodic agent turns but has no concept of job lifecycle.

This scheduler replaces both with:

- **SQLite storage** — ACID, queryable, survives crashes
- **Run history** — every execution tracked with status, duration, summary
- **Stale detection** — implicit heartbeat via session activity monitoring
- **Inter-agent messaging** — agents can send messages, track read receipts, thread conversations
- **Independent dispatch** — uses chat completions API, not OC's internal cron dispatcher

---

## Components

### Files

| File | Purpose |
|------|---------|
| `dispatcher.js` | Main process — tick loop, dispatch, health checks |
| `db.js` | Database connection (SQLite via better-sqlite3) |
| `schema.sql` | Table definitions (v2) |
| `jobs.js` | Job CRUD, scheduling, due detection |
| `runs.js` | Run lifecycle, stale/timeout detection, heartbeat |
| `messages.js` | Inter-agent message queue |
| `agents.js` | Agent registry |
| `gateway.js` | OpenClaw Gateway API client |
| `cli.js` | Command-line management tool |
| `migrate.js` | Import jobs from OC's `jobs.json` |
| `test.js` | Test suite (47 tests) |
| `ai.openclaw.scheduler.plist` | macOS LaunchAgent definition |

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^11.0.0 | SQLite database driver (native, synchronous) |
| `croner` | ^8.0.0 | Cron expression parsing and next-run calculation |

---

## Database Schema

Four tables plus a migration tracker. All dates stored in SQLite-compatible format (`YYYY-MM-DD HH:MM:SS`, UTC).

### `jobs` — Scheduled tasks

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | Human-readable name |
| `enabled` | INTEGER | 0/1 |
| `schedule_cron` | TEXT | 5-field cron expression (e.g., `0 9 * * *`) |
| `schedule_tz` | TEXT | IANA timezone (default: `America/New_York`) |
| `session_target` | TEXT | `main` or `isolated` |
| `agent_id` | TEXT | Target agent (default: `main`) |
| `payload_kind` | TEXT | `systemEvent` or `agentTurn` |
| `payload_message` | TEXT | Prompt or event text |
| `payload_model` | TEXT | Optional model override |
| `payload_thinking` | TEXT | Optional thinking level |
| `payload_timeout_seconds` | INTEGER | Agent turn timeout (default: 120) |
| `overlap_policy` | TEXT | `skip` / `allow` / `queue` (default: `skip`) |
| `run_timeout_ms` | INTEGER | Absolute timeout fallback (default: 300000 = 5min) |
| `delivery_mode` | TEXT | `announce` or `none` |
| `delivery_channel` | TEXT | Channel name (e.g., `telegram`) |
| `delivery_to` | TEXT | Target (e.g., chat ID) |
| `delete_after_run` | INTEGER | 0/1 — for one-shot jobs |
| `next_run_at` | TEXT | Next scheduled run (UTC, SQLite format) |
| `last_run_at` | TEXT | Last run timestamp |
| `last_status` | TEXT | `ok` / `error` / `timeout` / `skipped` |
| `consecutive_errors` | INTEGER | Error count (resets on success) |
| `created_at` | TEXT | Creation timestamp |
| `updated_at` | TEXT | Last update timestamp |

### `runs` — Execution history

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `job_id` | TEXT FK | References `jobs(id)` ON DELETE CASCADE |
| `status` | TEXT | `pending` → `running` → `ok` / `error` / `timeout` / `skipped` |
| `started_at` | TEXT | Run start time |
| `finished_at` | TEXT | Run end time |
| `duration_ms` | INTEGER | Execution duration |
| `last_heartbeat` | TEXT | Updated by dispatcher when session is active |
| `session_key` | TEXT | OpenClaw session key for this run |
| `session_id` | TEXT | OpenClaw session ID |
| `summary` | TEXT | Agent response (first 5000 chars) |
| `error_message` | TEXT | Error details if failed |
| `dispatched_at` | TEXT | When dispatcher fired this |
| `run_timeout_ms` | INTEGER | Copied from job at dispatch time |

### `messages` — Inter-agent message queue

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `from_agent` | TEXT | Sender (agent ID, `scheduler`, or `user`) |
| `to_agent` | TEXT | Recipient (agent ID or `broadcast`) |
| `reply_to` | TEXT FK | References `messages(id)` ON DELETE SET NULL |
| `kind` | TEXT | `text` / `task` / `result` / `status` / `system` |
| `subject` | TEXT | Optional subject line |
| `body` | TEXT | Message content |
| `metadata` | TEXT | JSON blob for structured data |
| `priority` | INTEGER | 0=normal, 1=high, 2=urgent |
| `channel` | TEXT | Optional delivery channel override |
| `status` | TEXT | `pending` → `delivered` → `read` / `expired` / `failed` |
| `delivered_at` | TEXT | When marked delivered |
| `read_at` | TEXT | When marked read |
| `expires_at` | TEXT | Optional TTL |
| `created_at` | TEXT | Creation timestamp |
| `job_id` | TEXT FK | References `jobs(id)` ON DELETE SET NULL |
| `run_id` | TEXT FK | References `runs(id)` ON DELETE SET NULL |

### `agents` — Registered agents

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Agent ID (e.g., `main`, `ops`) |
| `name` | TEXT | Display name |
| `status` | TEXT | `idle` / `busy` / `offline` |
| `last_seen_at` | TEXT | Last activity timestamp |
| `session_key` | TEXT | Current active session |
| `capabilities` | TEXT | JSON array of capability tags |
| `created_at` | TEXT | Registration timestamp |

### Indexes

- `idx_jobs_next_run` — Fast due-job queries (WHERE enabled=1)
- `idx_runs_job_id` — Run lookups by job
- `idx_runs_status` — Running run detection
- `idx_messages_to` — Inbox queries
- `idx_messages_from` — Outbox queries
- `idx_messages_created` — Chronological ordering
- `idx_messages_pending` — Priority-ordered pending message delivery

---

## Dispatch Flow

### Isolated Jobs (chat completions)

```
Dispatcher tick
  │
  ├─ getDueJobs() → finds job where next_run_at <= now
  ├─ hasRunningRun(job_id)? → skip if overlap_policy='skip'
  ├─ createRun(job_id) → status='running'
  ├─ setAgentStatus(agent_id, 'busy')
  │
  ├─ POST /v1/chat/completions
  │   Headers:
  │     Authorization: Bearer <gateway_token>
  │     x-openclaw-agent-id: <agent_id>
  │     x-openclaw-session-key: scheduler:<job_id>:<run_id>
  │   Body:
  │     model: openclaw:<agent_id>
  │     messages: [{ role: user, content: <built prompt> }]
  │
  │   ← response.choices[0].message.content
  │
  ├─ finishRun(run_id, 'ok', { summary })
  ├─ setAgentStatus(agent_id, 'idle')
  ├─ handleDelivery() → POST /tools/invoke → message tool
  ├─ queueMessage() → result message for traceability
  └─ advanceNextRun() → calculate next cron fire time
```

### Main Session Jobs (system event)

```
Dispatcher tick
  │
  ├─ getDueJobs() → finds main session job
  ├─ createRun(job_id)
  ├─ exec: openclaw system event --text "..." --mode now
  ├─ finishRun(run_id, 'ok')
  └─ advanceNextRun()
```

### Prompt Building

For isolated jobs, the dispatcher builds a prompt that includes:

1. A header: `[scheduler:<job_id> <job_name>]`
2. Any pending messages for the target agent (up to 5, marked as delivered)
3. The job's `payload_message`

This means agents receive their messages inline with job prompts — no separate delivery mechanism needed.

---

## Stale Run Detection

The scheduler uses **implicit session heartbeat** — it monitors whether an agent's session is active without requiring the agent to call back.

### How it works

1. Every 30 seconds, the dispatcher calls `sessions_list` via `/tools/invoke` with `activeMinutes: 5`
2. For each running run, it checks if the run's `session_key` appears in the active sessions list
3. If active → `last_heartbeat` is updated to `datetime('now')`
4. If `last_heartbeat` is older than 90 seconds (3 missed checks) → run is marked as `timeout`

### Fallback: absolute timeout

If the heartbeat check itself fails (gateway down, API error), runs that have been `running` longer than their `run_timeout_ms` are force-timed-out. This is the backstop.

### Why implicit heartbeat beats flat timeout

| Scenario | Flat timeout (5min) | Implicit heartbeat (90s) |
|----------|--------------------|-----------------------|
| Job usually takes 20s, agent crashes at 5s | Wait 5 minutes | Detected in ~90s |
| Job takes 4 minutes (long research task) | Killed at 5 min! | Stays alive (active session) |
| Agent stuck in infinite loop (no tool calls) | Wait 5 minutes | Detected in ~90s |

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Seconds without activity before a run is stale |
| Job `run_timeout_ms` | `300000` | Absolute timeout fallback per job (5 min) |

---

## Inter-Agent Messaging

Agents can exchange messages through the scheduler's message queue. Messages support:

### Features

- **Priority levels**: 0 (normal), 1 (high), 2 (urgent) — inbox sorted by priority then time
- **Threading**: `reply_to` field links messages into conversation threads
- **Read receipts**: `pending` → `delivered` → `read` with timestamps
- **Broadcast**: send to `to_agent='broadcast'` to reach all agents
- **TTL/Expiry**: set `expires_at` to auto-expire unread messages
- **Metadata**: attach structured JSON data to any message
- **Message kinds**: `text`, `task`, `result`, `status`, `system`
- **Job linking**: messages can reference a `job_id` and `run_id` for traceability

### How messages are delivered

Currently, pending messages are delivered **inline with job prompts**. When the dispatcher builds a prompt for an isolated job, it includes up to 5 pending messages for the target agent:

```
[scheduler:<job_id> <job_name>]

--- Pending Messages ---
From: ops-agent | task | Deploy review needed
Please review the prod deployment before approving.
---

<actual job prompt>
```

Messages are marked as `delivered` when included in a prompt.

### Message operations

| Operation | Function | Description |
|-----------|----------|-------------|
| Send | `sendMessage(opts)` | Queue a new message |
| Get | `getMessage(id)` | Fetch by ID |
| Inbox | `getInbox(agentId, opts)` | Unread messages, priority-sorted |
| Outbox | `getOutbox(agentId, limit)` | Sent messages |
| Thread | `getThread(messageId)` | Message + all replies |
| Mark delivered | `markDelivered(id)` | Status → delivered |
| Mark read | `markRead(id)` | Status → read (with timestamp) |
| Mark all read | `markAllRead(agentId)` | Batch mark (includes broadcast) |
| Unread count | `getUnreadCount(agentId)` | Count of pending/delivered |
| Expire | `expireMessages()` | Mark expired messages past TTL |
| Prune | `pruneMessages(keepDays)` | Delete old read/expired messages |

---

## Agent Registry

Track agent status and capabilities.

| Operation | Function | Description |
|-----------|----------|-------------|
| Register/update | `upsertAgent(id, opts)` | Create or update agent record |
| Get | `getAgent(id)` | Fetch by ID |
| List | `listAgents()` | All registered agents |
| Set status | `setAgentStatus(id, status, sessionKey)` | Update status + session |
| Touch | `touchAgent(id)` | Update `last_seen_at` |

The dispatcher automatically:
- Registers a `main` agent on startup
- Sets agent to `busy` when dispatching a job
- Sets agent to `idle` when the job completes

---

## CLI Reference

```bash
cd ~/.openclaw/scheduler
```

### Jobs

```bash
# List all jobs
node cli.js jobs list

# Get job details (full JSON)
node cli.js jobs get <job-id>

# Add a job
node cli.js jobs add '{"name":"My Job","schedule_cron":"0 9 * * *","payload_message":"Do the thing","delivery_mode":"none"}'

# Enable/disable
node cli.js jobs enable <job-id>
node cli.js jobs disable <job-id>

# Update fields
node cli.js jobs update <job-id> '{"payload_message":"Updated prompt","run_timeout_ms":600000}'

# Delete
node cli.js jobs delete <job-id>
```

### Runs

```bash
# Run history for a job
node cli.js runs list <job-id> [limit]

# Currently running
node cli.js runs running

# Stale runs (default threshold: 90s)
node cli.js runs stale [threshold-seconds]
```

### Messages

```bash
# Send a message
node cli.js msg send <from-agent> <to-agent> <message body>

# Inbox (unread, priority-sorted)
node cli.js msg inbox <agent-id> [limit]

# Outbox (sent messages)
node cli.js msg outbox <agent-id> [limit]

# Thread view
node cli.js msg thread <message-id>

# Mark as read
node cli.js msg read <message-id>
node cli.js msg readall <agent-id>

# Unread count
node cli.js msg unread <agent-id>
```

### Agents

```bash
# List agents
node cli.js agents list

# Agent details
node cli.js agents get <agent-id>

# Register/update
node cli.js agents register <agent-id> [display-name]
```

### Status

```bash
# Overall scheduler status
node cli.js status

# Output:
# === OpenClaw Scheduler Status ===
# Jobs:     3 total, 3 enabled
# Running:  0
# Stale:    0
# Agents:   1
#   main: idle
#
# Next:     Daily Workspace Audit at 2026-02-22 11:00:00
```

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_DB` | `./scheduler.db` | SQLite database path |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway HTTP endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | *(required)* | Gateway auth token |
| `SCHEDULER_TICK_MS` | `10000` | Main loop interval (10s) |
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Stale run detection threshold |
| `SCHEDULER_HEARTBEAT_CHECK_MS` | `30000` | Session activity check interval |
| `SCHEDULER_MESSAGE_DELIVERY_MS` | `15000` | Message delivery check interval |
| `SCHEDULER_PRUNE_MS` | `3600000` | Run/message prune interval (1 hour) |
| `SCHEDULER_DEBUG` | *(unset)* | Set to `1` for debug logging |

---

## Service Management

### macOS LaunchAgent

The scheduler runs as a macOS LaunchAgent (`ai.openclaw.scheduler`):

```bash
# Install
cp ~/.openclaw/scheduler/ai.openclaw.scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Check status
launchctl list | grep scheduler

# View logs
tail -f /tmp/openclaw-scheduler.log

# Restart
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# Stop
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

The LaunchAgent is configured with:
- `RunAtLoad: true` — starts on login
- `KeepAlive: true` — restarts on crash
- Logs to `/tmp/openclaw-scheduler.log`

### Manual run

```bash
cd ~/.openclaw/scheduler
OPENCLAW_GATEWAY_TOKEN=<token> node dispatcher.js
```

---

## Migration from OpenClaw Cron

The `migrate.js` script imports jobs from OpenClaw's `~/.openclaw/cron/jobs.json`:

```bash
node migrate.js
```

It handles:
- `cron` schedule kind → direct cron expression
- `every` schedule kind → approximate cron (e.g., every 60min → `0 */1 * * *`)
- `at` schedule kind → one-shot cron with `delete_after_run=true`
- Delivery settings (mode, channel, target)
- Agent bindings
- Skips already-imported jobs (by ID)

---

## What Was Deprecated

After deploying the scheduler, the following OpenClaw built-in systems were disabled:

### OpenClaw built-in cron jobs

All 3 jobs in `~/.openclaw/cron/jobs.json` were disabled via the cron tool API:
- Daily Morning Status Update (`0 9 * * *`)
- Hourly Workspace Backup (`0 8-23 * * *`)
- Daily Workspace Audit (`0 6 * * *`)

These same jobs now exist in the scheduler's SQLite database and are dispatched independently.

### OpenClaw heartbeat

The heartbeat interval was set to `0m` (disabled) in `~/.openclaw/openclaw.json`:

```json
"heartbeat": { "every": "0m" }
```

### Gateway changes

The OpenAI-compatible chat completions endpoint was enabled for dispatch:

```json
"gateway": {
  "http": {
    "endpoints": {
      "chatCompletions": { "enabled": true }
    }
  }
}
```

### To re-enable the old system

If you need to revert:

1. Re-enable OC cron jobs: `openclaw cron edit <id> --enable`
2. Re-enable heartbeat: set `heartbeat.every` back to `5m` in config
3. Stop the scheduler: `launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist`

---

## Error Handling & Backoff

### Dispatch failures

If a job dispatch fails (gateway down, API error, agent crash), the run is marked as `error` and the job's `consecutive_errors` counter increments.

### Exponential backoff

After consecutive errors, the next run is delayed:

| Consecutive errors | Backoff |
|-------------------|---------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5+ | 60 minutes |

The backoff is applied on top of the normal cron schedule — whichever is later wins. The counter resets to 0 on the next successful run.

### One-shot jobs

Jobs with `delete_after_run=true` are deleted from the database after a successful run. On failure, they remain and retry with backoff.

### Gateway health

The dispatcher checks gateway health (`GET /health`) before each tick. If the gateway is unreachable, the entire tick is skipped to avoid queuing errors.

---

## File Reference

```
~/.openclaw/scheduler/
├── ai.openclaw.scheduler.plist  # LaunchAgent definition
├── cli.js                       # CLI management tool
├── db.js                        # Database connection
├── dispatcher.js                # Main process (tick loop)
├── gateway.js                   # OpenClaw API client
├── jobs.js                      # Job CRUD operations
├── messages.js                  # Message queue operations
├── agents.js                    # Agent registry operations
├── migrate.js                   # Import from OC jobs.json
├── runs.js                      # Run lifecycle operations
├── schema.sql                   # SQLite schema (v2)
├── test.js                      # Test suite (47 tests)
├── package.json                 # Dependencies
├── scheduler.db                 # SQLite database (gitignored)
└── README.md                    # This file
```

---

## Testing

### Unit tests

```bash
node test.js
```

Runs 47 tests covering:
- Schema creation (4 tests)
- Cron parsing (1 test)
- Job CRUD (6 tests)
- Due job detection (1 test)
- Run lifecycle (6 tests)
- Stale detection (1 test)
- Timeout detection (1 test)
- Agent registry (6 tests)
- Message queue (18 tests: send, reply, priority, inbox, outbox, thread, unread, delivered, read, readall, broadcast, expiry, metadata, all 5 kinds)
- Cascade delete (2 tests)
- Prune (1 test)

Tests use an in-memory SQLite database (`SCHEDULER_DB=:memory:`) so they don't affect the live DB.

### Manual live tests (verified 2026-02-22)

| Test | Result |
|------|--------|
| Service health (process, LaunchAgent, gateway, chat completions) | ✅ 4/4 |
| Database integrity (tables, schema, indexes, WAL, FK) | ✅ 5/5 |
| Job CRUD (create, read, list, update, cron format, due detection, delete) | ✅ 7/7 |
| Run lifecycle (12 checks including stale, timeout, cascade) | ✅ 12/12 |
| Message queue (18 operations) | ✅ 18/18 |
| Agent registry (8 operations) | ✅ 8/8 |
| Live isolated dispatch (chat completions → agent reply → tracked) | ✅ 7/7 |
| Live main session dispatch (system event) | ✅ 3/3 |
| Live Telegram delivery (dispatch → agent → Telegram message) | ✅ 3/3 |
| Skip-overlap policy | ✅ 3/3 |
| Error handling & backoff | ✅ 4/4 |
| CLI commands (all 11 commands) | ✅ 11/11 |
| Deprecation verification (OC cron disabled, heartbeat off) | ✅ 3/3 |
| Migrated jobs (3 production jobs correct) | ✅ 3/3 |
| Dispatcher logs | ✅ |
| Unit test suite | ✅ 47/47 |
| **Total** | **138/138** |

---

## Troubleshooting

### Dispatcher isn't dispatching

1. Check process: `ps aux | grep dispatcher`
2. Check logs: `tail -f /tmp/openclaw-scheduler.log`
3. Check gateway: `curl http://127.0.0.1:18789/health`
4. Check due jobs: `node cli.js jobs list` — is `nextRun` in the past?
5. Check running runs: `node cli.js runs running` — is overlap blocking?

### Jobs show wrong next_run_at

All dates must be in SQLite format (`YYYY-MM-DD HH:MM:SS`, UTC). If you see ISO format with `T` and `Z`, the date comparison will fail. The `nextRunFromCron()` function handles this automatically.

### Stale runs accumulating

The stale threshold is 90 seconds. If the gateway's `sessions_list` isn't returning session activity, heartbeats won't update and runs will be marked stale after 90s. Check:
- Is the gateway responding? `curl http://127.0.0.1:18789/health`
- Is `sessions_list` working? Check via `/tools/invoke`

### Messages not being delivered

Messages are delivered inline with job prompts. If no job fires for an agent, messages accumulate. Future enhancement: immediate delivery for urgent messages via system event.

### Service won't start after reboot

Ensure the plist is in `~/Library/LaunchAgents/` and loaded:
```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

### Log file not updating

Node.js buffers stdout when piped to a file. The dispatcher logs to stderr (unbuffered) to avoid this. If logs appear stale, the process may have crashed — check `launchctl list | grep scheduler`.
