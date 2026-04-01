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

## Error Handling

CLI errors are written to stderr. With `--json`, structured output goes to
stdout:

```json
{ "ok": false, "error": "Human-readable error message" }
```

Successful operations return:

```json
{ "ok": true, "job": { ... } }
```

## Discovery Flow

When first interacting with `openclaw-scheduler`, use this sequence:

1. `openclaw-scheduler --json` -- show usage (with `--json` for structured help)
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
  "delivery_to": "CHAT_ID",
  "origin": "CHAT_ID"
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
openclaw-scheduler jobs add '{ "name": "Collect", "schedule_cron": "0 6 * * *", ... }'
# Child triggers on parent success
openclaw-scheduler jobs add '{ "name": "Process", "parent_id": "<PARENT_ID>", "trigger_on": "success", ... }'
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
openclaw-scheduler alias add ops_team telegram -1001234567890
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
  "delivery_to": "CHAT_ID",
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
  "delivery_to": "CHAT_ID",
  "origin": "CHAT_ID"
}
```

### Retry on failure

```json
{
  "max_retries": 3,
  "retry_delay_s": 60,
  "retry_backoff": "exponential"
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

## Using with agentcli

If `agentcli` is available, prefer it for complex workflows:

```bash
agentcli validate manifest.json
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db --dry-run
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db
```

agentcli provides stable job IDs, manifest validation, workflow chain
compilation, and v0.2 identity/authorization support. See the
[agentcli AGENTS.md](https://github.com/amittell/agentcli/blob/main/AGENTS.md)
for its agent instructions.
