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
| `index.mjs` | CLI entry point — 12 subcommands |
| `hooks.mjs` | Lifecycle event emitter (Loki + optional HTTP webhook) |
| `watcher.mjs` | Delivery monitoring process |
| `label-lock.mjs` | Process-safe mutex for ledger read-modify-write operations |
| `529-recovery.mjs` | Transient error recovery |
| `deliver-watcher.sh` | Shell wrapper for result retrieval |
| `chilisaus.mjs` | Branded chilisaus wrapper over this dispatch engine |
| `gateway-rpc.mjs` | Gateway CLI parsing and RPC error-envelope validation |
| `session-store.mjs` | Read-only SQLite-first session/transcript compatibility layer |
| `config.example.json` | Example config |
| `chilisaus.config.example.json` | Chilisaus branding config example |
| `test-done-postoffice.mjs` | Done handler test |
| `~/.openclaw/scheduler/dispatch/labels.json` | Durable label→session ledger |
| `README.md` | This file |

---

## How it works

dispatch calls the OpenClaw Gateway RPC API directly:

1. **`sessions.patch`** — configure supported session overrides (model, thinking level)
2. **`agent`** — send a message into the session (spawning it if new)
3. **`sessions.list`** — query session status and liveness
4. **`chat.history`** — read session transcripts for results

```
Orchestrator calls:
  dispatch enqueue --label ticket-42 --message "Fix the deploy script"

  → Creates session key: agent:main:subagent:<uuid>
  → Patches supported model/thinking overrides when requested
  → Calls gateway `agent` method with the task
  → Session starts immediately (no scheduler tick delay)
  → Tracks label→sessionKey in the durable labels ledger
  → Agent auto-announces results on completion
  → hooks.mjs fires dispatch.started to Loki
```

### Labels mutex and upgrades

Labels writers use the existing `better-sqlite3` dependency to hold a
`BEGIN IMMEDIATE` transaction in a dedicated `labels.json.lock.sqlite3` file
beside the configured ledger. It stores no labels or transcript data. The
persistent file is expected after release; do not delete it to unlock a live
writer. The OS releases a crashed process's ownership, and waiting writers
have a bounded timeout. This mutex is separate from the scheduler database.
Keep the ledger and mutex on one host's local filesystem.

When upgrading from the former JSON `labels.json.lock` protocol, stop all
writers, including running watchers and CLI invocations, before replacing any
of these dispatch files. Restart them from the same upgraded package. Old and
new writers must not overlap because their mutex protocols differ. Retain
that quiescence when rolling back. An old JSON lock can be archived only after
all old writers stop; the new implementation never deletes it automatically.

### Chilisaus branding

Chilisaus is not a separate implementation. It is the branded entrypoint in this
directory:

```bash
node dispatch/chilisaus.mjs enqueue --label ticket-42 --message "Fix it"
```

`chilisaus.mjs` sets `DISPATCH_CONFIG_DIR` to this dispatch directory, then loads
`index.mjs`. To use the historical chilisaus branding, copy
`chilisaus.config.example.json` to `config.json` in the same directory. Runtime
changes belong in this `openclaw-scheduler/dispatch` tree.

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
  --source-context '{"channel":"telegram","target":"YOUR_CHAT_ID","messageId":"INBOUND_MESSAGE_ID","threadId":null}' \
  --deliver-to YOUR_CHAT_ID     \
  --deliver-channel telegram        \
  --delivery-mode announce

# Literal-safe prompt input for shell-sensitive text:
cat prompt.md | node dispatch/index.mjs enqueue \
  --label "ticket-43" \
  --message-stdin \
  --origin system \
  --delivery-mode none
```

`--source-context` is evidence about where the inbound request actually arrived;
`--deliver-to` and `--deliver-channel` are the durable completion destination.
For chat-triggered calls the source envelope is mandatory and authoritative. If
legacy `--origin` or explicit delivery metadata disagrees after normalization,
enqueue exits 2 before Gateway calls, ledger writes, watcher jobs, or
notifications. Manual/local calls may omit source context when inbound metadata
is genuinely unavailable.

| Flag | Default | Description |
|---|---|---|
| `--label` | required | Human name — used for lookup/reuse |
| `--message` | required* | Prompt sent to the agent |
| `--message-file` | — | Read prompt text from a file. Use `-` to read from stdin. Safer than inline shell quoting for prompts with backticks, quotes, or markdown. |
| `--message-env` | — | Read prompt text from an environment variable. |
| `--message-stdin` | — | Read prompt text from stdin explicitly. If stdin is piped and no explicit source is set, dispatch auto-reads stdin. |
| `--mode` | `fresh` | `fresh` = new session; `reuse` = continue last session for this label |
| `--session-key` | — | Explicit session key (bypasses ledger lookup) |
| `--agent` | `main` | Agent ID |
| `--model` | configured OpenClaw default | Model override (e.g. `anthropic/claude-sonnet-4-6`). When omitted, dispatch uses wrapper `config.defaultModel`, wrapper `config.dispatch.model`, `DISPATCH_DEFAULT_MODEL`, `agents.defaults.dispatch.model`, or `agents.defaults.model`; otherwise the Gateway selects its configured default. An explicitly rejected override fails enqueue instead of silently falling back. |
| `--thinking` | — | Reasoning level: `low`, `high`, `xhigh` |
| `--timeout` | `300` | Seconds before run times out |
| `--source-context` | — | Authoritative inbound JSON envelope: `channel`, `target`, `messageId`, and optional `threadId`. Chat-triggered callers must pass it. Only identifier fields are accepted. |
| `--deliver-to` | — | Durable completion delivery target (chat ID, channel ID, handle, etc.). With `--source-context`, it must match `target` or enqueue exits 2 before any side effect. Manual/local callers without inbound metadata retain the legacy fallback. |
| `--deliver-channel` | `telegram` | Delivery channel for `--deliver-to` (telegram, slack, etc.) |
| `--delivery-mode` | `announce` | `announce`, `announce-always`, `none` |
| `--origin` | -- | Legacy audit origin (e.g. `telegram:12345`). With `--source-context`, it must normalize to the same channel and target. Without source context, existing derivation and manual/local active-session fallback remain compatible. |
| `--no-monitor` | false | Skip watcher monitoring |
| `--monitor-interval` | -- | Watcher cron expression |
| `--monitor-timeout` | -- | Watcher timeout in minutes |
| `--verify-cmd` | -- | Post-completion verification command |

*One prompt source is required: `--message`, `--message-file`, `--message-env`, `--message-stdin`, or piped stdin.

### `status` — session status for a label

```bash
node dispatch/index.mjs status --label "ticket-42"
```

Returns ledger info + live session data from gateway (model, age, token usage).
The JSON includes `sourceContext` when the dispatch had authoritative inbound
metadata.

### `stuck` — find stuck running sessions

```bash
node dispatch/index.mjs stuck --threshold-min 15
```

Exit 0 = nothing stuck (silent).
Exit 1 = stuck sessions found (triggers announce delivery).

Checks the labels ledger for sessions marked `running` and cross-references the
SQLite-first local compatibility store plus visible Gateway state for activity.

### `result` — last assistant reply from a session

```bash
node dispatch/index.mjs result --label "ticket-42"
```

Reads the current SQLite transcript first, with legacy JSONL and visible
`chat.history` fallbacks, and returns the last assistant message. The JSON
includes the stored `sourceContext` even after completion.

### `route` — durable source route for follow-up

```bash
node dispatch/index.mjs route --label "ticket-42"
```

Returns `sourceContext`, legacy `origin`, and the durable completion `delivery`
route. For a chat-triggered dispatch, use `sourceContext.channel`,
`sourceContext.target`, and, when present, `sourceContext.threadId` for later
follow-up instead of a remembered group map.

### `done` — mark a tracked session complete

```bash
node dispatch/index.mjs done \
  --label "ticket-42" \
  --summary "Work complete" \
  --checklist '{"work_complete":true}'
```

Marks the label as `done` immediately so the watcher can resolve the run without
waiting for timeout polling. Run this command from the same local dispatch shell
that created the label. Do not run it from inside `ssh`, Docker, tmux, or another
nested shell unless that shell intentionally points at the originating dispatch
host and `labels.json`; otherwise it can update a different label store.

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

cat <<'EOF' | node dispatch/index.mjs send --label "ticket-42" --message-stdin
Use literal `code`, quotes, and $(examples) safely
EOF
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

Reconciles the labels ledger with the gateway sessions store. Sessions that no
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
    "origin": "telegram:YOUR_CHAT_ID",
    "sourceContext": {
      "channel": "telegram",
      "target": "YOUR_CHAT_ID",
      "messageId": "INBOUND_MESSAGE_ID",
      "threadId": null
    },
    "deliverTo": "YOUR_CHAT_ID",
    "deliverChannel": "telegram",
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
after dispatching the session. The watcher polls until the agent sends the
structured local `done` completion signal. Both the `done` path and the routed
watcher acquire the same label/session/run-scoped completion claim and enqueue
the final message in `delivery_outbox`. They never place externally addressed
completion output in the agent inbox. If the structured signal is missed but
the transcript has strict clean terminal completion evidence, the watcher may
enqueue that terminal assistant report; arbitrary mid-task replies remain
diagnostics.

```
dispatch enqueue --deliver-to <telegram-user-id>
  -> gateway agent call (deliver: false, fire-and-forget)
  -> scheduler job: <brand>-deliver:<label> (run_now: true, shell, one-shot)
  -> watcher.mjs: long-running blocking process polls session status
  -> on success: watcher enqueues to delivery_outbox and emits no delivery stdout
  -> outbox consumer delivers to telegram/<telegram-user-id>
  -> job auto-prunes via ttl_hours (default 48h)
```

**Why scheduler instead of gateway `deliver:true`?**
- Retryable durable delivery with idempotency checkpoints
- Delivery aliases (scheduler resolves `@team_room` → channel/target)
- Audit trail (runs table records every attempt)
- Chain triggers (completion can fire child jobs)
- Resilient to gateway restarts mid-run

### Watcher script

`deliver-watcher.sh` checks the session result. For a configured route, a
successful watcher enqueues the completion durably, exits 0 with empty stdout,
and emits `WATCHER_ALREADY_DELIVERED` on stderr so the scheduler wrapper does
not enqueue a duplicate. The legacy marker is not a channel delivery receipt;
completion debt remains open until all outbox parts are actually delivered.
Without a route, the watcher retains its historical stdout delivery result
after acquiring the durable completion claim. Exit 1 with no output means retry
on the next cron tick.

Completion claims are scoped to the label, session, and run, so reusing a label
does not suppress a later run. If the claim store is unavailable, the operation
fails closed as `COMPLETION_CLAIM_UNAVAILABLE`. Multipart messages use separate
outbox rows with deterministic `:part:i/N` idempotency keys, allowing retries
to resume from the durable per-part checkpoint.

Quiet sessions are treated conservatively. The watcher does not mark a running
job failed just because the local SQLite session/transcript state (or the legacy
JSON/JSONL fallback) has been quiet for 60 seconds. For high/xhigh reasoning work, the first idle result probe waits
at least 10 minutes, idle auto-resolution waits at least 20 minutes, and the hard
failure ceiling is longer than the requested task timeout. Missing or ambiguous
gateway/session liveness fails open to "still monitoring" until the hard timeout
window or a clear terminal error.

Current OpenClaw stores session lifecycle in the per-agent read-only database
`~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` (`session_nodes`,
`session_windows`, and `transcript_events`). Dispatch reads that database with
WAL-compatible SQLite access and never mutates it. Older OpenClaw installs may
fall back to `sessions/sessions.json` and JSONL transcripts. Gateway
`sessions.list` and `chat.history` remain useful fallbacks, but tree visibility
can intentionally hide a child created outside the caller's current session
tree, so API absence alone is not a failure signal.

While a label is still `running`, a plain assistant reply is diagnostic only.
Successful final delivery prefers the agent-side local `done` signal and its
structured completion payload. The terminal-assistant fallback is intentionally
narrow: it requires clean completion evidence from the transcript, not just the
latest assistant text. If an older watcher records an error and the worker later
sends a valid local `done`, the later completion is authoritative and the stale
error is cleared from the label.

### Progress check-ins from subagent sessions

The dispatch prompt includes a literal `openclaw-scheduler messages send`
checkpoint command that the worker can copy at logical milestones. It does not
promise a `CHECKPOINT_NOTIFY_CMD` environment variable. If the scheduler CLI is
not available in the worker environment, use the gateway HTTP API directly:

```bash
GW_TOKEN=$(python3 -c "import json, os; print(json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))['gateway']['auth']['token'])")
curl -s -X POST http://127.0.0.1:18789/tools/invoke \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $GW_TOKEN" \
  -d '{"tool":"message","args":{"action":"send","channel":"telegram","target":"<telegram-user-id>","message":"<label>: <progress update>"},"sessionKey":"main","agentId":"main"}'
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
