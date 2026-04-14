# dispatch

**Sub-agent dispatch CLI for OpenClaw — native gateway API edition.**

dispatch spawns and steers isolated agent sessions directly via the OpenClaw
Gateway API. It tracks label→session mappings in a local JSON ledger, giving
you a simple CLI to dispatch work, check on it, steer it mid-run, and get
results back.

No scheduler DB dependency. No dispatcher tick delay. Sessions start instantly.

---

## Files

| File | Purpose |
|---|---|
| `index.mjs` | CLI entry point — 10 subcommands |
| `hooks.mjs` | Lifecycle event emitter (Loki + optional HTTP webhook) |
| `watcher.mjs` | Delivery monitoring process |
| `529-recovery.mjs` | Transient error recovery |
| `deliver-watcher.sh` | Shell wrapper for result retrieval |
| `chilisaus.mjs` | Branded wrapper |
| `config.example.json` | Example config |
| `test-done-postoffice.mjs` | Done handler test |
| `labels.json` | Local label→session ledger (gitignored) |
| `README.md` | This file |

---

## How it works

dispatch calls the OpenClaw Gateway RPC API directly:

1. **`sessions.patch`** — configure the session (model, thinking level, spawn depth)
2. **`agent`** — send a message into the session (spawning it if new)
3. **`sessions.list`** — query session status and liveness
4. **`chat.history`** — read session transcripts for results

```
Orchestrator calls:
  dispatch enqueue --label ticket-42 --message "Fix the deploy script"

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
node dispatch/index.mjs enqueue \
  --label   "ticket-42"             \
  --message "Fix the deploy script" \
  --mode    fresh                   \   # fresh | reuse
  --agent   main                    \
  --model   anthropic/claude-sonnet-4-6 \
  --thinking high                   \
  --timeout  300                    \
  --deliver-to YOUR_CHAT_ID     \
  --deliver-channel telegram        \
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
| `--deliver-to` | — | Delivery target (chat ID, channel ID, handle, etc.). Enables `deliver:true` on the gateway call. Chat-triggered callers should pass inbound metadata `chat_id` here, especially for group chats. |
| `--deliver-channel` | `telegram` | Delivery channel for `--deliver-to` (telegram, slack, etc.) |
| `--delivery-mode` | `announce` | `announce`, `announce-always`, `none` |
| `--origin` | -- | Dispatch origin (e.g. `telegram:12345`). If omitted but `--deliver-to` is explicit, dispatch derives origin from that target. Active-session auto-detect is fallback for manual/local use only. |
| `--no-monitor` | false | Skip watcher monitoring |
| `--monitor-interval` | -- | Watcher cron expression |
| `--monitor-timeout` | -- | Watcher timeout in minutes |
| `--verify-cmd` | -- | Post-completion verification command |

### `status` — session status for a label

```bash
node dispatch/index.mjs status --label "ticket-42"
```

Returns ledger info + live session data from gateway (model, age, token usage).

### `stuck` — find stuck running sessions

```bash
node dispatch/index.mjs stuck --threshold-min 15
```

Exit 0 = nothing stuck (silent).
Exit 1 = stuck sessions found (triggers announce delivery).

Checks labels.json for sessions marked `running`, cross-references gateway
session store for last activity timestamp.

### `result` — last assistant reply from a session

```bash
node dispatch/index.mjs result --label "ticket-42"
```

Reads the session transcript via `chat.history` and returns the last assistant
message.

### `done` — mark a tracked session complete

```bash
node dispatch/index.mjs done \
  --label "ticket-42" \
  --summary "Work complete" \
  --checklist '{"work_complete":true}'
```

Marks the label as `done` immediately so the watcher can resolve the run without
waiting for timeout polling.

| Flag | Default | Description |
|---|---|---|
| `--label` | required | Label to mark complete |
| `--summary` | `completed (agent signal)` | One-line completion summary |
| `--checklist` | required | JSON object. Must include `work_complete:true`; optional fields like `tests_passed` and `pushed` may not be `false` |
| `--sha` | — | Required when the stored task prompt includes real git commands like `git push`, `git rebase`, `git cherry-pick`, `--force-with-lease`, or `--force-push` |
| `--force-done` | false | Override the minimum-runtime guard for legitimate short tasks |
| `--reason` | — | Required with `--force-done`; records why an unusually short session is still valid |
| `--skip-activity-check` | false | Bypass the gateway message-count heuristic when that check is too strict for the task |

Notes:
- The minimum runtime guard rejects very short sessions unless `--force-done --reason ...` is provided.
- Older labels created before `taskPrompt` storage will warn and skip the git-SHA gate.
- Gateway activity checks fail open: if the session API is unavailable, `done` logs a warning and continues.

### `send` — message a running session

```bash
node dispatch/index.mjs send \
  --label "ticket-42" \
  --message "Tests still failing on line 42, focus on the edge case"
```

Sends a message directly into the running session. The agent sees it as a new
user turn and continues working. This is the **mid-session steering superpower**.

### `steer` — alias for send

```bash
node dispatch/index.mjs steer \
  --label "ticket-42" \
  --message "Change approach: use the new API instead"
```

Identical to `send`. The name makes intent explicit.

### `heartbeat` — check session liveness

```bash
node dispatch/index.mjs heartbeat --label "ticket-42"
# or:
node dispatch/index.mjs heartbeat --session-key "agent:main:subagent:..."
```

Returns whether the session is alive (updated within the last 10 minutes),
plus session metadata.

### `list` — list all tracked labels

```bash
node dispatch/index.mjs list [--status running] [--limit 10]
```

Shows all labels in the ledger, sorted by most recent. Filter by status.

### `sync` -- reconcile labels with sessions store

```bash
node dispatch/index.mjs sync
```

Reconciles `labels.json` with the gateway sessions store. Sessions that no
longer exist on the gateway are marked stale, and sessions present on the
gateway but missing from the ledger are imported. Useful after gateway restarts
or manual session cleanup.

---

## Session Reuse

`--mode reuse` looks up the last session key for this label in `labels.json`
and sends the new message into that existing session. The agent picks up where
it left off with full conversation history.

```bash
# First run — fresh session
node dispatch/index.mjs enqueue --label "daily-report" --message "Generate today's report"

# Later — continue in the same session
node dispatch/index.mjs enqueue --label "daily-report" --message "Add the Q4 numbers" --mode reuse
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
export DISPATCH_HOST=my-agent-host
```

---

## Gateway Auth

dispatch reads the gateway token from:
1. `OPENCLAW_GATEWAY_TOKEN` environment variable
2. `~/.openclaw/openclaw.json` → `gateway.auth.token`

No manual token configuration needed on a standard OpenClaw install.

---

## Delivery

### How it works

When `--deliver-to` is set, dispatch registers a **scheduler watcher job**
after dispatching the session. The watcher polls the session result every
minute until the agent produces a reply, then delivers via the scheduler's
`handleDelivery` pipeline.

```
dispatch enqueue --deliver-to <telegram-user-id>
  -> gateway agent call (deliver: false, fire-and-forget)
  -> scheduler job: <brand>-deliver:<label> (run_now: true, shell, one-shot)
  -> watcher.mjs: long-running blocking process polls session status
  -> on success (exit 0): scheduler delivers output to telegram/<telegram-user-id>
  -> job auto-prunes via ttl_hours (default 48h)
```

**Why scheduler instead of gateway `deliver:true`?**
- Retry / at-least-once delivery guarantee
- Delivery aliases (scheduler resolves `@team_room` → channel/target)
- Audit trail (runs table records every attempt)
- Chain triggers (completion can fire child jobs)
- Resilient to gateway restarts mid-run

### Watcher script

`deliver-watcher.sh` checks the session result. Exit 0 with output = deliver.
Exit 1 with no output = retry on next cron tick (no spam — `announce-always`
only delivers when `output.trim()` is truthy).

### Progress check-ins from subagent sessions

Subagent sessions run without PATH access to the `openclaw` CLI, so
`openclaw system event` silently fails. For mid-task progress updates,
use the gateway HTTP API via curl:

```bash
GW_TOKEN=$(python3 -c "import json, os; print(json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))['gateway']['auth']['token'])")
curl -s -X POST http://127.0.0.1:18789/tools/invoke \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $GW_TOKEN" \
  -d '{"tool":"message","args":{"action":"send","channel":"telegram","target":"<telegram-user-id>","message":"<label>: <progress update>"},"sessionKey":"main"}'
```
---

## Architecture: Before & After

### Before (scheduler DB dispatch)
```
dispatch enqueue → creates job in scheduler DB → dispatcher picks up on tick
→ runs as isolated session → announces result → hooks fire
```

### After (native gateway API)
```
dispatch enqueue → calls gateway API directly → session starts immediately
→ tracks in labels.json → announces result → hooks fire
```

Key improvements:
- **Instant dispatch** — no scheduler tick delay (was up to 10s)
- **Mid-session steering** — `send`/`steer` inject messages into running sessions
- **No DB dependency** — labels.json is a simple JSON file
- **Session reuse** — `--mode reuse` continues conversations
- **Simpler** -- lightweight multi-file CLI vs full DB schema + dispatcher integration

---

## Stuck Run Detector (cron job)

```bash
openclaw-scheduler jobs add '{
  "name": "Stuck Session Detector",
  "schedule_cron": "*/10 * * * *",
  "session_target": "shell",
  "payload_message": "node ~/.openclaw/scheduler/dispatch/index.mjs stuck --threshold-min 15",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID"
}'
```

---

## Migration from Scheduler-DB Version

If upgrading from the scheduler-DB version:

1. Replace `index.mjs` (this file replaces it)
2. `hooks.mjs` is unchanged (no DB imports)
3. `labels.json` is created automatically on first `enqueue`
4. Old scheduler jobs for dispatch tasks can be removed
5. The scheduler DB is no longer needed for dispatch

The CLI flags are identical — existing scripts/agents calling dispatch
don't need changes (except `--mode auto` is gone; use `fresh` or `reuse`).

New additions: `steer` subcommand (alias for `send`), `list` subcommand,
`--model` flag on `enqueue`.
