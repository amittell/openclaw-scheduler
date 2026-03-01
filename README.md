# chilisaus 🌶️

**Sub-agent dispatch CLI for OpenClaw — native gateway API edition.**

chilisaus spawns and steers isolated agent sessions directly via the OpenClaw
Gateway API. It tracks label→session mappings in a local JSON ledger, giving
you a simple CLI to dispatch work, check on it, steer it mid-run, and get
results back.

No scheduler DB dependency. No dispatcher tick delay. Sessions start instantly.

---

## Files

| File | Purpose |
|---|---|
| `index.mjs` | CLI entry point — 8 subcommands |
| `hooks.mjs` | Lifecycle event emitter (Loki + optional HTTP webhook) |
| `labels.json` | Local label→session ledger (gitignored) |
| `README.md` | This file |

---

## How it works

chilisaus calls the OpenClaw Gateway RPC API directly:

1. **`sessions.patch`** — configure the session (model, thinking level, spawn depth)
2. **`agent`** — send a message into the session (spawning it if new)
3. **`sessions.list`** — query session status and liveness
4. **`chat.history`** — read session transcripts for results

```
Orchestrator calls:
  chilisaus enqueue --label ticket-42 --message "Fix the deploy script"

  → Creates session key: agent:main:subagent:<uuid>
  → Patches session with model/thinking/spawnDepth
  → Calls gateway `agent` method with the task
  → Session starts immediately (no scheduler tick delay)
  → Tracks label→sessionKey in labels.json
  → Agent auto-announces results on completion
  → hooks.mjs fires dispatch.started to Loki
```

---

## Subcommands

### `enqueue` — spawn a new session

```bash
node chilisaus/index.mjs enqueue \
  --label   "ticket-42"             \
  --message "Fix the deploy script" \
  --mode    fresh                   \   # fresh | reuse
  --agent   main                    \
  --model   anthropic/claude-sonnet-4-6 \
  --thinking high                   \
  --timeout  300                    \
  --deliver-to YOUR_TELEGRAM_ID     \
  --delivery-mode announce
```

| Flag | Default | Description |
|---|---|---|
| `--label` | required | Human name — used for lookup/reuse |
| `--message` | required | Prompt sent to the agent |
| `--mode` | `fresh` | `fresh` = new session; `reuse` = continue last session for this label |
| `--session-key` | — | Explicit session key (bypasses ledger lookup) |
| `--agent` | `main` | Agent ID |
| `--model` | — | Model override (e.g. `anthropic/claude-sonnet-4-6`) |
| `--thinking` | — | Reasoning level: `low`, `high`, `xhigh` |
| `--timeout` | `300` | Seconds before run times out |
| `--deliver-to` | — | Delivery target (kept for compat) |
| `--delivery-mode` | `announce` | `announce`, `announce-always`, `none` |

### `status` — session status for a label

```bash
node chilisaus/index.mjs status --label "ticket-42"
```

Returns ledger info + live session data from gateway (model, age, token usage).

### `stuck` — find stuck running sessions

```bash
node chilisaus/index.mjs stuck --threshold-min 15
```

Exit 0 = nothing stuck (silent).
Exit 1 = stuck sessions found (triggers announce delivery).

Checks labels.json for sessions marked `running`, cross-references gateway
session store for last activity timestamp.

### `result` — last assistant reply from a session

```bash
node chilisaus/index.mjs result --label "ticket-42"
```

Reads the session transcript via `chat.history` and returns the last assistant
message.

### `send` — message a running session

```bash
node chilisaus/index.mjs send \
  --label "ticket-42" \
  --message "Tests still failing on line 42, focus on the edge case"
```

Sends a message directly into the running session. The agent sees it as a new
user turn and continues working. This is the **mid-session steering superpower**.

### `steer` — alias for send

```bash
node chilisaus/index.mjs steer \
  --label "ticket-42" \
  --message "Change approach: use the new API instead"
```

Identical to `send`. The name makes intent explicit.

### `heartbeat` — check session liveness

```bash
node chilisaus/index.mjs heartbeat --label "ticket-42"
# or:
node chilisaus/index.mjs heartbeat --session-key "agent:main:subagent:..."
```

Returns whether the session is alive (updated within the last 10 minutes),
plus session metadata.

### `list` — list all tracked labels

```bash
node chilisaus/index.mjs list [--status running] [--limit 10]
```

Shows all labels in the ledger, sorted by most recent. Filter by status.

---

## Session Reuse

`--mode reuse` looks up the last session key for this label in `labels.json`
and sends the new message into that existing session. The agent picks up where
it left off with full conversation history.

```bash
# First run — fresh session
node chilisaus/index.mjs enqueue --label "daily-report" --message "Generate today's report"

# Later — continue in the same session
node chilisaus/index.mjs enqueue --label "daily-report" --message "Add the Q4 numbers" --mode reuse
```

---

## Labels Ledger (`labels.json`)

Local JSON file mapping labels to session keys:

```json
{
  "ticket-42": {
    "sessionKey": "agent:main:subagent:9131309b-...",
    "runId": "46030a3d-...",
    "agent": "main",
    "mode": "fresh",
    "model": null,
    "thinking": null,
    "spawnedAt": "2026-03-01T04:27:52.181Z",
    "status": "running",
    "summary": null,
    "error": null,
    "updatedAt": "2026-03-01T04:27:52.182Z"
  }
}
```

Gitignored by default. Session-local, not shared.

---

## Lifecycle Hooks (`hooks.mjs`)

Fires structured events to Loki and/or an HTTP webhook:

| Event | When |
|---|---|
| `dispatch.started` | Session spawned |
| `dispatch.finished` | Session completed |
| `dispatch.stuck` | `stuck` subcommand found stuck sessions |

**Configuration:**

```bash
export LOKI_PUSH_URL=http://your-loki-host/loki/api/v1/push
export DISPATCH_WEBHOOK_URL=https://your-endpoint.example.com/hook
export CHILISAUS_HOST=my-agent-host
```

---

## Gateway Auth

chilisaus reads the gateway token from:
1. `OPENCLAW_GATEWAY_TOKEN` environment variable
2. `~/.openclaw/openclaw.json` → `gateway.auth.token`

No manual token configuration needed on a standard OpenClaw install.

---

## Architecture: Before & After

### Before (scheduler DB dispatch)
```
chilisaus enqueue → creates job in scheduler DB → dispatcher picks up on tick
→ runs as isolated session → announces result → hooks fire
```

### After (native gateway API)
```
chilisaus enqueue → calls gateway API directly → session starts immediately
→ tracks in labels.json → announces result → hooks fire
```

Key improvements:
- **Instant dispatch** — no scheduler tick delay (was up to 10s)
- **Mid-session steering** — `send`/`steer` inject messages into running sessions
- **No DB dependency** — labels.json is a simple JSON file
- **Session reuse** — `--mode reuse` continues conversations
- **Simpler** — ~450 lines vs ~300+ lines + DB schema + dispatcher integration

---

## Stuck Run Detector (cron job)

```bash
openclaw cron add '{
  "name": "Stuck Session Detector",
  "schedule": "*/10 * * * *",
  "sessionTarget": "shell",
  "payload": {
    "kind": "shellCommand",
    "message": "node ~/.openclaw/scheduler/chilisaus/index.mjs stuck --threshold-min 15"
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "YOUR_TELEGRAM_ID"
  }
}'
```

---

## Migration from Scheduler-DB Version

If upgrading from the scheduler-DB version:

1. Replace `index.mjs` (this file replaces it)
2. `hooks.mjs` is unchanged (no DB imports)
3. `labels.json` is created automatically on first `enqueue`
4. Old scheduler jobs for chilisaus tasks can be removed
5. The scheduler DB is no longer needed for dispatch

The CLI flags are identical — existing scripts/agents calling chilisaus
don't need changes (except `--mode auto` is gone; use `fresh` or `reuse`).

New additions: `steer` subcommand (alias for `send`), `list` subcommand,
`--model` flag on `enqueue`.
