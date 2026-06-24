# AGENTS

## Purpose

`openclaw-scheduler` is the durable orchestration runtime for OpenClaw agents
and shell workflows. It manages scheduling, retries, approvals, delivery, and
persistent state.

Use this tool when the task is about:

- creating scheduled or triggered jobs
- running shell commands on a schedule
- building multi-step workflow chains
- delivering results to messaging channels
- inspecting run history and job status

For manifest authoring, validation, and identity/authorization profiles, use
`agentcli`. The scheduler is the runtime; agentcli is the control plane.

## Working Rules

- Pass `--json` to any command for machine-readable JSON output.
- `run_timeout_ms` is required on every job. There is no default -- this
  prevents jobs from running indefinitely.
- Use `jobs validate` to check a spec before `jobs add`.
- Prefer `delivery_to` with an alias (`@team_room`) over hardcoded chat IDs.
- Shell jobs (`session_target: "shell"`) run without the gateway. Agent jobs
  (`session_target: "isolated"` or `"main"`) require a running gateway.

## Checking Job Status — Always Poll, Never Infer

When reporting on whether a dispatched job is running, done, or stuck, **always call the status command directly** — never infer from check-in messages or notifications that appeared in your conversation.

Check-in messages are delivered asynchronously. By the time they appear, the job may already be finished, failed, or on a later step. Conversation messages are stale by definition.

```bash
# For chilisaus-dispatched jobs:
node ~/.openclaw/chilisaus/index.mjs status --label <label>

# For scheduler jobs:
openclaw-scheduler runs list <job-id> --json
openclaw-scheduler runs running --json
```

The `status` output gives authoritative `status` (`accepted` / `running` / `done` / `error`), `updatedAt` timestamp, and final `summary`. Use that.

**Rule: if you haven't polled status, you don't know the status.**

---

## Error Handling

CLI errors exit non-zero. In plain-text mode, the message goes to stderr. With
`--json`, the structured error object goes to stdout:

```json
{ "ok": false, "error": "Human-readable error message" }
```

Successful operations return:

```json
{ "ok": true, "job": { ... } }
```

## Discovery Flow

When first interacting with `openclaw-scheduler`, use this sequence:

1. `openclaw-scheduler` -- show usage (plain-text help output)
2. `openclaw-scheduler jobs list --json` -- enumerate existing jobs
3. `openclaw-scheduler agents list --json` -- see registered agents
4. `openclaw-scheduler schema jobs` -- get the job field schema
5. `openclaw-scheduler capabilities --json` -- check runtime feature support

## Creating Jobs

### Required fields

Every job needs at minimum:

```json
{
  "name": "Job Name",
  "schedule_cron": "0 9 * * *",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "echo hello",
  "run_timeout_ms": 300000,
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "YOUR_CHAT_ID"
}
```

For agent jobs, use `"session_target": "isolated"` and
`"payload_kind": "systemEvent"`.

### One-shot jobs (run once)

```bash
openclaw-scheduler jobs add '{ ... }' --at '2026-04-01T09:00:00-04:00'
openclaw-scheduler jobs add '{ ... }' --in '15m'
```

### Workflow chains (parent triggers child)

```bash
# Parent runs on cron
openclaw-scheduler jobs add '{ "name": "Collect", "schedule_cron": "0 6 * * *", "run_timeout_ms": 300000, "origin": "system", ... }'
# Child triggers on parent success
openclaw-scheduler jobs add '{ "name": "Process", "parent_id": "<PARENT_ID>", "trigger_on": "success", "run_timeout_ms": 300000, "origin": "system", ... }'
```

## Managing Jobs

```bash
openclaw-scheduler jobs list --json          # list all jobs
openclaw-scheduler jobs get <id> --json      # get job details
openclaw-scheduler jobs update <id> '{ "enabled": 0 }'  # disable
openclaw-scheduler jobs enable <id>          # re-enable
openclaw-scheduler jobs disable <id>         # disable
openclaw-scheduler jobs run <id>             # trigger immediate run
openclaw-scheduler jobs delete <id>          # delete job
openclaw-scheduler jobs cancel <id>          # cancel job + children
```

## Inspecting Runs

```bash
openclaw-scheduler runs list <job-id> --json       # run history
openclaw-scheduler runs get <run-id> --json        # run details
openclaw-scheduler runs running --json             # active runs
openclaw-scheduler runs output <run-id>            # shell output
```

## Delivery

The scheduler delivers job output through the OpenClaw gateway. All channels
the gateway supports work with the scheduler: Telegram, Discord, WhatsApp,
Signal, iMessage, and Slack.

Set `delivery_channel` and `delivery_to` on the job, or use delivery aliases:

```bash
openclaw-scheduler alias add ops_team telegram -100200000000
# Then use @ops_team as delivery_to in any job
```

## Common Patterns

### Cron shell job with delivery

```json
{
  "name": "Daily Backup",
  "schedule_cron": "0 2 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "backup.sh",
  "run_timeout_ms": 600000,
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "system"
}
```

### Agent task (isolated session)

```json
{
  "name": "Morning Briefing",
  "schedule_cron": "0 8 * * 1-5",
  "session_target": "isolated",
  "agent_id": "main",
  "payload_kind": "systemEvent",
  "payload_message": "Prepare the morning briefing. Summarize overnight alerts.",
  "run_timeout_ms": 300000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "YOUR_CHAT_ID"
}
```

### Retry on failure

```json
{
  "max_retries": 3
}
```

### Approval gate

```json
{
  "approval_required": true,
  "approval_timeout_s": 3600
}
```

## Multi-Agent

The scheduler dispatches to specific agents via the `agent_id` field. A single
scheduler serves all agents through one shared gateway.

```json
{ "agent_id": "main" }
{ "agent_id": "ops" }
```

## Migrating from Built-in Cron/Heartbeat

OpenClaw's built-in `cron/jobs.json` and heartbeat work for simple tasks. The
scheduler replaces them when jobs need run history, retries, chains, approvals,
or delivery.

### Import existing cron jobs

```bash
openclaw-scheduler migrate    # imports from ~/.openclaw/cron/jobs.json
openclaw-scheduler jobs list  # verify imported jobs
```

### Disable the old cron system

After importing, disable the built-in cron so jobs do not run in both systems:

```bash
openclaw cron edit <job-id> --disable    # for each job
openclaw config set cron.enabled false
openclaw config set agents.defaults.heartbeat.every "0m"
```

### Heartbeat replacement

Replace `heartbeat.every` with a scheduler job:

```json
{
  "name": "Gateway Liveness Check",
  "schedule_cron": "*/5 * * * *",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "curl -sf http://127.0.0.1:18789/health || exit 1",
  "run_timeout_ms": 30000,
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "system"
}
```

See [QUICK-START.md](QUICK-START.md) for detailed migration examples including
shell crons, agent prompts, and multi-step chains.

## Using with agentcli

agentcli is the control-plane companion. It provides declarative manifests,
stable job IDs, workflow chain compilation, and v0.2 identity/authorization
support. The scheduler works without it, but agentcli is preferred for
complex workflows.

### Installing alongside the scheduler (same time)

```bash
npm install -g agentcli
agentcli validate manifest.json
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db --dry-run
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db
```

Jobs created via `agentcli apply` use stable IDs (SHA256 of workflow:task) and
can be updated by re-applying the same manifest.

### Adding agentcli later (adopting existing jobs)

If the scheduler already has jobs created directly via CLI or by the agent,
agentcli can adopt them:

1. Write a manifest with task names matching the existing job names.

2. Run a one-time adoption by name:

```bash
agentcli apply manifest.json \
  --db ~/.openclaw/scheduler/scheduler.db \
  --adopt-by name --dry-run           # preview first

agentcli apply manifest.json \
  --db ~/.openclaw/scheduler/scheduler.db \
  --adopt-by name                     # execute adoption
```

This replaces each matched job with a stable-ID version. The old job is
deleted after the new one is created.

3. On subsequent applies, use the default (no `--adopt-by` flag):

```bash
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db
```

Jobs are now matched by stable ID, so the manifest can be renamed or
reorganized without losing job mapping.

### Full migration path: OOB cron -> scheduler -> agentcli

1. Import OOB cron jobs: `openclaw-scheduler migrate`
2. Disable built-in cron (see "Migrating from Built-in Cron" above)
3. Verify jobs run correctly in the scheduler
4. Install agentcli: `npm install -g agentcli`
5. Write a manifest covering the imported jobs
6. Adopt by name: `agentcli apply manifest.json --adopt-by name`
7. Future updates: `agentcli apply manifest.json` (stable IDs)

See the
[agentcli AGENTS.md](https://github.com/amittell/agentcli/blob/main/AGENTS.md)
for agentcli-specific agent instructions and the
[MANIFEST-QUICK-REF.md](https://github.com/amittell/agentcli/blob/main/MANIFEST-QUICK-REF.md)
for copy-paste manifest patterns.

<!-- coord:begin -->
<!-- AUTO-GENERATED by 'coord upgrade'. Do not hand-edit; next upgrade will overwrite. -->
## Coordination protocol (mandatory)

Multi-agent file coordination via the `coord` MCP server. Required calls every session:

1. `list_claims` at task start.
2. `claim_files` before editing.
3. `release_claims` (or `release_session` to drop everything this MCP session holds, v0.6+) when done.

If `claim_files` returns conflicts, stop and ask the user. No edits outside claimed scope; no opportunistic refactors; shared config edits only with explicit user approval.

### Sub-file (symbol-level) claims (v0.14+)

When two agents need different parts of the same file, claim symbols instead of whole files. Pass `symbols={"src/auth/login.ts": ["handleLogin"]}` to `claim_files` so the claim scopes to just that function. Two agents on disjoint symbols of the same file auto-coexist with no 409.

- `Foo::handleA` (v0.16): method-level notation. Sibling methods of the same class auto-coexist; the bare class blocks all of its methods.
- `Outer::Inner::method` (v0.17): recursive nesting works to any depth.
- Server-side validation (v0.17): when `COORD_REPO_ROOT` is set, the server rejects symbols that do not exist in the file with a hint listing what is parseable. The MCP wrapper pre-validates locally before POST so typos fail fast; disable with `COORD_DISABLE_CLIENT_VALIDATION=1`.

### Queueing instead of bouncing (v0.21+)

When a hot file is contested and your work is blocking the team, pass `wait_seconds=60` to `claim_files`. The request joins a FIFO queue behind the blocking holder; on release the next queued requester is auto-granted. Pair with `urgency='low' | 'normal' | 'high' | 'blocking'` (v0.25) to jump ahead of lower-priority waiters; long-waiting entries age-boost one level after `COORD_QUEUE_AGE_BOOST_SECONDS` (v0.26). Abandon a wait early via `cancel_queue_request(queue_id, engineer=...)` (v0.26). Inspect your own queue rows via `my_requests(queued=True)` (v0.22).

### Asking the holder directly (v0.6+ / v0.11+ decisions)

If queueing will not work either:
- `request_release` files an explicit ask against the holder's claim. The holder's TTL shortens; their decision lands back in your `my_requests` view.
- `respond_to_request` decisions (v0.11+): `approved` (release whole claim), `denied` (keep it), `narrowed` (close the claim, open a tighter one -- pass `narrowed_pattern`), `coexist` (let the requester have a sibling claim on the same scope -- pass `coexist_pattern`). `coexist` is cooperative not enforced; agents on the same file still handle imports and module-level state themselves.

### Operator visibility

Poll `pending_requests` between operations to see who is blocked on your scope and respond via `respond_to_request`. The dashboard surfaces hotspot files, an auto-resolution heatmap, and a pending-queue panel for ambient awareness.
<!-- coord:end -->
