# chilisaus 🌶️

**Companion dispatch CLI for OpenClaw Scheduler.**

chilisaus is a label-based CLI for orchestrating sub-agent work on top of the
scheduler. It is a **companion tool** — not part of the core scheduler — and
lives in this subdirectory to reflect that separation.

The scheduler handles *scheduling and executing jobs*. chilisaus handles the
*control-plane pattern*: how an orchestrator agent decides to dispatch work,
tracks it by human-readable label, and gets results back.

---

## Files

| File | Purpose |
|---|---|
| `index.mjs` | CLI entry point — 6 subcommands |
| `hooks.mjs` | Lifecycle event emitter (Loki + optional HTTP webhook) |
| `README.md` | This file |

---

## How it works

chilisaus opens the scheduler DB directly and uses the same tables:

- **`jobs`** — `enqueue` creates one-shot jobs (`run_now=true`, `delete_after_run=true`)
- **`runs`** — `status`, `stuck`, `result`, `heartbeat` all read/write runs
- **`messages`** — `send` puts messages in a worker's inbox via the message queue
- **`jobs.preferred_session_key`** — `--mode reuse` populates this so the dispatcher passes the prior session key to the gateway

```
Orchestrator calls:
  chilisaus enqueue --label ticket-42 --message "Fix the deploy script"

  → Creates one-shot scheduler job
  → Scheduler dispatches on next tick (≤10s)
  → Run tracked in runs table with session_key + heartbeat
  → Result announced to configured delivery_to (Telegram etc.)
  → hooks.mjs fires dispatch.started / dispatch.finished to Loki
```

---

## Subcommands

### `enqueue` — dispatch a one-shot task

```bash
node chilisaus/index.mjs enqueue \
  --label   "ticket-42"          \
  --message "Fix the deploy script" \
  --mode    fresh                 \   # fresh | reuse | auto
  --agent   main                  \
  --thinking xhigh                \
  --timeout  300                  \
  --deliver-to 484946046          \
  --delivery-mode announce
```

| Flag | Default | Description |
|---|---|---|
| `--label` | required | Human name — used for `status`/`result`/reuse lookup |
| `--message` | required | Prompt sent to the agent |
| `--mode` | `fresh` | `fresh` = new session; `reuse` = continue last session; `auto` = try reuse, fall back |
| `--session-key` | — | Explicit session key (bypasses ledger lookup) |
| `--agent` | `main` | Agent ID |
| `--thinking` | — | Reasoning level: `low`, `high`, `xhigh` |
| `--timeout` | `300` | Seconds before run times out |
| `--deliver-to` | — | Telegram user/group ID for result delivery |
| `--delivery-mode` | `announce` | `announce`, `announce-always`, `none` |

### `status` — recent runs for a label

```bash
node chilisaus/index.mjs status --label "ticket-42" --limit 5
```

### `stuck` — find stuck running runs

```bash
node chilisaus/index.mjs stuck --threshold-min 15
```

Exit 0 = nothing stuck (silent when used as a scheduler shell job).
Exit 1 = stuck runs found (triggers `announce` delivery to configured DM).

### `result` — last finished run result

```bash
node chilisaus/index.mjs result --label "ticket-42"
```

### `send` — message a running worker

```bash
node chilisaus/index.mjs send \
  --label "ticket-42" \
  --message "Tests still failing on line 42" \
  --kind text
```

### `heartbeat` — touch a run's heartbeat

```bash
node chilisaus/index.mjs heartbeat --label "ticket-42"
# or:
node chilisaus/index.mjs heartbeat --run-id <uuid>
```

---

## Session reuse

`--mode reuse` queries the `runs` table for the last `session_key` for this
label and stores it as `jobs.preferred_session_key`. The dispatcher then passes
it as `x-openclaw-session-key` to the gateway — the agent picks up where it
left off.

If the prior session has expired, the gateway starts a new session with that
key. Nothing breaks either way.

---

## Lifecycle hooks (`hooks.mjs`)

Fires structured events to Loki and/or an HTTP webhook on dispatch lifecycle:

| Event | When |
|---|---|
| `dispatch.started` | Job created and queued |
| `dispatch.finished` | Run completed (ok or error) |
| `dispatch.stuck` | `stuck` subcommand found stuck runs |
| `dispatch.cancelled` | Run manually cancelled |

**Configuration:**

```bash
# Required to enable Loki push:
export LOKI_PUSH_URL=http://your-loki-host/loki/api/v1/push

# Optional HTTP webhook:
export DISPATCH_WEBHOOK_URL=https://your-endpoint.example.com/hook

# Optional host label in Loki stream:
export CHILISAUS_HOST=my-agent-host
```

Hooks are best-effort and non-blocking — a failed push never prevents dispatch.

---

## Stuck Run Detector (scheduler job)

Set up a shell job to periodically alert on stuck runs:

```bash
node cli.js jobs add '{
  "name": "Stuck Run Detector",
  "schedule_cron": "*/10 * * * *",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "node /path/to/scheduler/chilisaus/index.mjs stuck --threshold-min 15",
  "payload_timeout_seconds": 30,
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'
```

Silent on exit 0 (nothing stuck). Announces to your DM on exit 1.

---

## Worker result schema

Workers should post structured results to the message queue. The recommended
payload schema is defined in `docs/schemas/worker-result.schema.json` in the
workspace repo. Key fields:

```json
{
  "ok": true,
  "summary": "Fixed the deploy script — 2 files changed",
  "task": "ticket-42",
  "session_key": "scheduler:...",
  "files_changed": ["scripts/deploy.sh"],
  "error": null
}
```

Post via:
```bash
node cli.js msg send worker orchestrator '<json>'
# or:
node chilisaus/index.mjs send --label orchestrator --message '<json>' --kind result
```

---

## Agent Memory Integration

After installing chilisaus, add the following to your agent's memory files so
it knows these tools exist across context resets.

> **Tip:** Run `node setup.mjs` from the scheduler root — it will do this
> automatically and interactively.

### Add to `MEMORY.md`

Under your `## Active Projects` or equivalent section:

```markdown
- **chilisaus 🌶️:** Sub-agent dispatch CLI at `~/.openclaw/scheduler/chilisaus/index.mjs`.
  Commands: `enqueue` (spawn sub-agent), `status`, `stuck`, `result`, `send` (queue message), `heartbeat`.
  Backed by scheduler DB (runs/jobs tables). Queue (`send`) is signal-only — scripts enqueue only when
  actionable. Inbox Consumer (`scripts/inbox-consumer.mjs`) drains queue → Telegram DM every 5 min.
  Docs: `~/.openclaw/scheduler/chilisaus/README.md`.
```

### Add to `memory/workspace-index.md`

Add a **Scheduler & Dispatch** section:

```markdown
### Scheduler & Dispatch
> Covers: standalone scheduler, sub-agent dispatch, inbox queue

| File | Covers | Load |
|------|--------|------|
| `~/.openclaw/scheduler/` | Standalone SQLite scheduler. CLI: `node cli.js`. LaunchAgent: `ai.openclaw.scheduler`. | Any scheduler/cron work |
| `~/.openclaw/scheduler/chilisaus/index.mjs` | Sub-agent dispatch CLI 🌶️. Commands: `enqueue`, `status`, `stuck`, `result`, `send`, `heartbeat`. | Dispatching sub-agents or sending queue messages |
| `~/.openclaw/scheduler/chilisaus/hooks.mjs` | Loki lifecycle hooks. Only fires if `LOKI_PUSH_URL` env set. | Sub-agent observability |
| `scripts/inbox-consumer.mjs` | Drains chilisaus queue → Telegram DM. Runs every 5 min via scheduler. Signal-only. | Queue/inbox debugging |
```

---

## Signal Queue Pattern (Inbox Consumer)

The message queue is for **signal**, not for status. The distinction matters:

| Path | When to use |
|---|---|
| `delivery_mode: announce` | Failures — immediate, unconditional, no consumer needed |
| `chilisaus send` + Inbox Consumer | Signal — script found something worth surfacing, LLM/human decides |

### The rule

**Scripts write to the queue only when they have found something actionable.**

```bash
# ✅ Correct — enqueue only when there is signal
edges=$(run_edge_scan)
if [ -n "$edges" ]; then
  node chilisaus/index.mjs send \
    --label main \
    --message "$edges" \
    --kind result \
    --subject "Edge scan: $(date +%Y-%m-%d)"
fi
# exit 0 → announce silent (nothing found)
# exit 1 → announce fires directly to Telegram (error, not queue)

# ❌ Wrong — unconditional queue write, floods inbox
node chilisaus/index.mjs send --label main --message "Scan complete: nothing found"
```

### The Inbox Consumer

A companion scheduler job (shell, `*/5 * * * *`) that drains the queue and
delivers queued messages to Telegram. Because scripts only enqueue signal, the
consumer never needs to filter — everything in the queue is worth forwarding.

```bash
# workspace/scripts/inbox-consumer.mjs
# Reads pending messages → formats → deliverMessage() → marks read
# exit 0 = nothing queued (announce stays silent)
# exit 1 = delivery error (announce fires)
```

**Scheduler job:**
```json
{
  "name": "Inbox Consumer",
  "session_target": "shell",
  "payload_message": "node /path/to/workspace/scripts/inbox-consumer.mjs",
  "schedule_cron": "*/5 * * * *",
  "delivery_mode": "announce",
  "delivery_to": "YOUR_TELEGRAM_ID"
}
```

### Delivery separation

```
Failure path:    dispatcher → delivery_mode: announce → Telegram (immediate)
Signal path:     script → chilisaus send → queue → Inbox Consumer → Telegram

Queue is NEVER written by the dispatcher automatically.
Each message in the queue was put there by a script that had something to say.
```

> **Note:** Older versions of the dispatcher unconditionally wrote a `result` message
> to the queue after every shell/isolated job completion. This was removed in
> commit `32b8ea6` — it produced noise with no consumer. Traceability is
> provided by the `runs` table, `delivery_mode: announce`, and
> `chilisaus result/status` queries instead.
