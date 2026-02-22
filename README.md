# OpenClaw Scheduler v2

Full standalone scheduler + message router replacing OpenClaw's built-in `cron/jobs.json` + heartbeat.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Dispatcher Loop (10s tick)               │
│                                                         │
│  1. Gateway health check                                │
│  2. Find due jobs → dispatch independently              │
│     - main: openclaw system event                       │
│     - isolated: /v1/chat/completions API                │
│  3. Check runs for staleness (implicit heartbeat)       │
│  4. Deliver pending inter-agent messages                │
│  5. Expire/prune old messages + runs                    │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
  ┌──────────────────┐     ┌──────────────────┐
  │    SQLite DB      │     │ OpenClaw Gateway  │
  │  jobs / runs /    │     │  chat completions │
  │  messages / agents│     │  system events    │
  └──────────────────┘     │  tools/invoke     │
                           └──────────────────┘
```

## Key Design Decisions

- **Full standalone** — dispatches independently via chat completions API, not via OC's cron.run
- **Cron strings only** — no mixed schedule formats
- **Skip-overlap** — won't re-fire if previous run still active
- **Implicit heartbeat** — checks session activity, no agent cooperation needed
- **Stale threshold: 90s** — 3 missed 30s checks
- **Absolute timeout fallback** — `run_timeout_ms` per job (default 5min)
- **Inter-agent messaging** — queue with priority, threading, read receipts
- **Agent registry** — track status, capabilities, session keys

## What was deprecated

- OpenClaw built-in cron jobs (3 jobs disabled in jobs.json)
- OpenClaw heartbeat (interval set to 0m)
- Chat completions endpoint enabled in gateway config for dispatch

## Quick Start

```bash
npm install
node test.js         # 47 tests
node migrate.js      # Import from OC's jobs.json
node dispatcher.js   # Start

# Or as launchd service:
cp ai.openclaw.scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

## CLI

```bash
# Jobs
node cli.js jobs list
node cli.js jobs get <id>
node cli.js jobs add '{"name":"...","schedule_cron":"...","payload_message":"..."}'
node cli.js jobs enable|disable|delete <id>

# Runs
node cli.js runs list <job-id>
node cli.js runs running
node cli.js runs stale [threshold-s]

# Messages
node cli.js msg send <from> <to> <body>
node cli.js msg inbox <agent-id>
node cli.js msg outbox <agent-id>
node cli.js msg thread <message-id>
node cli.js msg read <id> | readall <agent-id> | unread <agent-id>

# Agents
node cli.js agents list|get|register

# Status
node cli.js status
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_DB` | `./scheduler.db` | SQLite database path |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway HTTP endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | (none) | Gateway auth token |
| `SCHEDULER_TICK_MS` | `10000` | Dispatcher tick interval |
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Stale run detection threshold |
| `SCHEDULER_HEARTBEAT_CHECK_MS` | `30000` | Session activity check interval |
| `SCHEDULER_MESSAGE_DELIVERY_MS` | `15000` | Message delivery check interval |
| `SCHEDULER_PRUNE_MS` | `3600000` | Run/message prune interval |
| `SCHEDULER_DEBUG` | (unset) | Enable debug logging |

## Stale Detection

Uses **implicit session heartbeat** — no agent cooperation needed:

1. Every 30s, checks `sessions_list` for active sessions
2. Running runs with active sessions get `last_heartbeat` updated
3. If `last_heartbeat` > 90s old → stale → marked timeout
4. Fallback: absolute `run_timeout_ms` per job

Crashed agent = dead session = detected in ~2 minutes.
Active agent making tool calls = alive = stays running.
