# Job Quick Reference

Copy-paste patterns for common scheduler jobs.

## Shell job with cron schedule

```json
{
  "name": "Daily Backup",
  "schedule_cron": "0 2 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "/usr/local/bin/backup.sh",
  "run_timeout_ms": 600000,
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "system"
}
```

## Agent task (isolated session)

```json
{
  "name": "Morning Briefing",
  "schedule_cron": "0 8 * * 1-5",
  "schedule_tz": "America/New_York",
  "session_target": "isolated",
  "agent_id": "main",
  "payload_kind": "systemEvent",
  "payload_message": "Prepare the morning briefing with overnight alerts.",
  "run_timeout_ms": 300000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "CHAT_ID"
}
```

## Main session event (inject into persistent session)

```json
{
  "name": "Pending Acks Check",
  "schedule_cron": "*/30 * * * *",
  "session_target": "main",
  "agent_id": "main",
  "payload_kind": "systemEvent",
  "payload_message": "Check for unacknowledged messages and follow up.",
  "run_timeout_ms": 120000,
  "delivery_mode": "none",
  "origin": "system"
}
```

## One-shot job (run once at a specific time)

```bash
openclaw-scheduler jobs add '{
  "name": "Deploy v2.1",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "deploy.sh v2.1",
  "run_timeout_ms": 600000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "system"
}' --at '2026-04-01T14:00:00-04:00'
```

Or with relative time:

```bash
openclaw-scheduler jobs add '{ ... }' --in '30m'
openclaw-scheduler jobs add '{ ... }' --in '2h'
```

## Workflow chain (parent triggers child)

```json
[
  {
    "name": "Nightly Score Capture",
    "schedule_cron": "30 0 * * *",
    "session_target": "shell",
    "payload_kind": "shellCommand",
    "payload_message": "capture-scores.sh",
    "run_timeout_ms": 300000,
    "delivery_mode": "announce",
    "delivery_channel": "telegram",
    "delivery_to": "CHAT_ID",
    "origin": "system"
  },
  {
    "name": "Auto-Settle Bets",
    "parent_id": "<SCORE_CAPTURE_JOB_ID>",
    "trigger_on": "success",
    "session_target": "shell",
    "payload_kind": "shellCommand",
    "payload_message": "settle-bets.sh",
    "run_timeout_ms": 300000,
    "delivery_mode": "announce",
    "delivery_channel": "telegram",
    "delivery_to": "CHAT_ID",
    "origin": "system"
  }
]
```

Create parent first, then child with `parent_id` set to the parent's ID.

## Job with retries

```json
{
  "name": "API Sync",
  "schedule_cron": "0 */4 * * *",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "sync-api.sh",
  "run_timeout_ms": 120000,
  "max_retries": 3,
  "retry_delay_s": 60,
  "retry_backoff": "exponential",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "system"
}
```

## Job with approval gate

```json
{
  "name": "Production Deploy",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "deploy-prod.sh",
  "run_timeout_ms": 600000,
  "approval_required": true,
  "approval_timeout_s": 3600,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "system"
}
```

Approve or reject:

```bash
openclaw-scheduler jobs approve <id>
openclaw-scheduler jobs reject <id> "not ready yet"
```

## Multi-agent job (target a specific agent)

```json
{
  "name": "Ops Agent Task",
  "schedule_cron": "0 9 * * *",
  "session_target": "isolated",
  "agent_id": "ops",
  "payload_kind": "systemEvent",
  "payload_message": "Check infrastructure health.",
  "run_timeout_ms": 300000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "CHAT_ID",
  "origin": "CHAT_ID"
}
```

## Trigger conditions

```json
{ "trigger_on": "success" }
{ "trigger_on": "failure" }
{ "trigger_on": "complete" }
{ "trigger_on": "success", "trigger_condition": "contains:DEPLOYED" }
{ "trigger_on": "success", "trigger_condition": "regex:status:\\s*healthy" }
{ "trigger_on": "success", "trigger_delay_s": 60 }
```

## Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Job name |
| `schedule_cron` | string | yes* | Cron expression (5-field). *Not needed for triggered children or at-jobs |
| `schedule_tz` | string | no | Timezone (default: UTC) |
| `session_target` | string | yes | `shell`, `isolated`, or `main` |
| `agent_id` | string | no | Target agent (default: `main`) |
| `payload_kind` | string | yes | `shellCommand` or `systemEvent` |
| `payload_message` | string | yes | Shell command or agent prompt |
| `payload_model` | string | no | Model override for agent tasks |
| `run_timeout_ms` | integer | yes | Max run duration in ms (no default) |
| `delivery_mode` | string | no | `none`, `announce`, `announce-always` |
| `delivery_channel` | string | no | Channel name (telegram, discord, etc.) |
| `delivery_to` | string | no | Chat ID, channel ID, or @alias |
| `origin` | string | yes | Source chat ID or `system` |
| `parent_id` | string | no | Parent job ID (for chains) |
| `trigger_on` | string | no | `success`, `failure`, `complete` |
| `trigger_condition` | string | no | `contains:X` or `regex:X` |
| `trigger_delay_s` | integer | no | Delay before trigger fires |
| `max_retries` | integer | no | Retry count on failure |
| `retry_delay_s` | integer | no | Delay between retries |
| `retry_backoff` | string | no | `fixed` or `exponential` |
| `overlap_policy` | string | no | `allow`, `skip`, `queue` |
| `approval_required` | boolean | no | Require HITL approval |
| `approval_timeout_s` | integer | no | Approval window in seconds |
| `enabled` | integer | no | 1 (enabled) or 0 (disabled) |

## Delivery channels

All channels supported by the OpenClaw gateway work with the scheduler:
Telegram, Discord, WhatsApp, Signal, iMessage, and Slack.

Examples in this document use `telegram` as the delivery_channel.
Replace with your channel of choice.
