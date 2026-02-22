# OpenClaw Scheduler

SQLite-backed job scheduler/dispatcher replacing OpenClaw's built-in `cron/jobs.json` + heartbeat system.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Dispatcher Loop                       │
│  (10s tick)                                             │
│                                                         │
│  1. Find due jobs (next_run_at <= now, enabled)         │
│  2. Dispatch: main → system event, isolated → spawn     │
│  3. Check running runs for staleness (implicit hb)      │
│  4. Handle timeouts (absolute fallback)                 │
│  5. Prune old runs (hourly)                             │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
  ┌─────────────┐          ┌──────────────────┐
  │  SQLite DB   │          │ OpenClaw Gateway  │
  │  (jobs/runs) │          │  /tools/invoke    │
  └─────────────┘          └──────────────────┘
```

## Key Design Decisions

- **Cron strings only** — no mixed schedule formats. Every job uses a 5-field cron expression.
- **Skip-overlap** — if a previous run is still active, the next firing is skipped.
- **Implicit heartbeat** — dispatcher checks session activity (via `sessions_list`) to determine if a run is alive. No agent cooperation required.
- **Stale threshold: 90s** — 3 missed 30s heartbeat checks. Tight enough to catch crashes, generous enough for slow ticks.
- **Absolute timeout fallback** — `run_timeout_ms` per job (default 5min) catches edge cases where heartbeat check fails.

## Quick Start

```bash
# Install dependencies
npm install

# Run tests
node test.js

# Migrate existing OpenClaw cron jobs
node migrate.js

# Start the dispatcher
node dispatcher.js

# Or install as launchd service
cp ai.openclaw.scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

## CLI

```bash
node cli.js list                    # List all jobs
node cli.js get <id>                # Job details
node cli.js add '{"name":"...","schedule_cron":"...","payload_message":"..."}'
node cli.js enable <id>
node cli.js disable <id>
node cli.js delete <id>
node cli.js runs <job-id> [limit]   # Run history
node cli.js running                 # Currently running
node cli.js stale [threshold-s]     # Stale runs
node cli.js status                  # Overview
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_DB` | `./scheduler.db` | SQLite database path |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway HTTP endpoint |
| `OPENCLAW_GATEWAY_TOKEN` | (none) | Gateway auth token |
| `SCHEDULER_TICK_MS` | `10000` | Dispatcher tick interval |
| `SCHEDULER_STALE_THRESHOLD_S` | `90` | Seconds before a run is considered stale |
| `SCHEDULER_HEARTBEAT_CHECK_MS` | `30000` | How often to check session activity |
| `SCHEDULER_PRUNE_MS` | `3600000` | How often to prune old runs |

## Stale Detection

The dispatcher uses **implicit session heartbeat** — it doesn't require agents to call back. Instead:

1. Every 30s, dispatcher calls `sessions_list` with `activeMinutes: 5`
2. For each running run, checks if its session appears in the active list
3. If active → updates `last_heartbeat` on the run
4. If `last_heartbeat` is older than 90s → run marked as stale/timed out
5. Fallback: if `started_at + run_timeout_ms < now` → run marked timed out regardless

This means a crashed agent = dead session = detected within ~2 minutes. An agent deep in a long task making tool calls = active session = stays alive.
