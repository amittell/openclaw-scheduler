# Job Quick Reference

Copy-paste patterns for scheduler 0.4.0 and schema 28. Validate a saved spec
with `openclaw-scheduler jobs validate --file job.json` before adding it.

## Shell job with cron schedule

```json
{
  "name": "Daily Backup",
  "schedule_cron": "0 2 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "/usr/local/bin/backup.sh",
  "shell_env_policy": "minimal",
  "run_timeout_ms": 600000,
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
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
  "payload_kind": "agentTurn",
  "payload_message": "Prepare the morning briefing with overnight alerts.",
  "run_timeout_ms": 300000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "YOUR_CHAT_ID"
}
```

## Main session event (inject into persistent session)

```json
{
  "name": "Pending Acks Check",
  "schedule_cron": "*/30 * * * *",
  "session_target": "main",
  "agent_id": "main",
  "payload_kind": "agentTurn",
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
  "delivery_to": "YOUR_CHAT_ID",
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
    "delivery_to": "YOUR_CHAT_ID",
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
    "delivery_to": "YOUR_CHAT_ID",
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
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
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
  "approval_auto": "reject",
  "approval_risk_level": "high",
  "approval_approver_scope": "user:alex",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "system"
}
```

Approve or reject:

```bash
openclaw-scheduler approvals list --json
openclaw-scheduler approvals approve APPROVAL_ID --reason "Change window open"
openclaw-scheduler approvals reject APPROVAL_ID --reason "not ready yet"
```

Approval gates apply to root, manual, scheduled, one-shot, and chain-triggered
dispatches. Approving a scoped gate requires the invoking local OS identity to
match, and scoped gates cannot use timeout auto-approval. Any
execution-contract change cancels the pending approval. Legacy
`jobs approve/reject JOB_ID` commands resolve only the job's current pending
gate and cannot choose a different identity.

## Handoff v3 governed fields

```json
{
  "approval_required": true,
  "approval_risk_level": "high",
  "approval_approver_scope": "user:alex",
  "approval_auto": "reject",
  "output_format": "json",
  "authorization_ref": "opa:deployments/production",
  "evidence_ref": "audit:production-deploy",
  "evidence": "{\"provider\":\"sha256\",\"methods\":[\"sha256\"],\"verify\":{\"required\":false},\"collect\":[\"result\"],\"format\":\"json\"}"
}
```

- `approval_risk_level`: `low`, `medium`, or `high`.
- `approval_approver_scope`: unprefixed exact identity, `exact:`,
  `user:`, `uid:`, or `principal:` local identity. Domain scopes are rejected.
- `output_format`: `json`, `ndjson`, or `text`. Invalid declared output fails
  the run and blocks children.
- `authorization_ref`: `provider:policy-ref` or
  `provider://provider/policy-ref`. The provider must implement
  `resolvePolicy()` or `resolveAuthorization()`; resolution errors deny.
- Delegation declarations are validated for mode, chain depth, allowed
  delegators, per-hop grants, cycles, and provider denial before execution.
- Supported checksum evidence is canonicalized with `json-sort-v1`, hashed with
  SHA-256, and stored as one immutable record per run without raw credentials.
  External providers such as `ssh` or `none`, non-SHA-256 methods, and required
  signature verification fail validation.
- `identity.presentation` and `credential_handoff` work locally for shell jobs
  and through `chat-completions-env-inject-v1` for isolated jobs. They are
  rejected for main-session jobs. Auth-profile-only isolated jobs remain
  compatible with Gateways that do not advertise env injection.

Inspect the runtime contract and evidence:

```bash
openclaw-scheduler capabilities --json
openclaw-scheduler runs evidence RUN_ID --json
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
  "delivery_to": "YOUR_CHAT_ID",
  "origin": "YOUR_CHAT_ID"
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
| `payload_kind` | string | yes | `shellCommand`, `systemEvent`, or `agentTurn` |
| `payload_message` | string | yes | Shell command or agent prompt |
| `payload_model` | string | no | Model override for agent tasks |
| `payload_model_fallback` | string | no | Optional fallback model override for same-run retry after primary selection failure |
| `execution_intent` | string | no | `execute`, `plan`, or `fire-and-forget` |
| `shell_env_policy` | string | no | `minimal` for fresh jobs or explicit legacy-compatible `inherit` |
| `auth_profile_fallback` | string | no | Optional fallback auth profile for same-run retry after primary selection failure |
| `run_timeout_ms` | integer | yes | Max run duration in ms (no default) |
| `delivery_mode` | string | no | `none`, `announce`, `announce-always` |
| `delivery_channel` | string | no | Channel name (telegram, discord, etc.) |
| `delivery_to` | string | no | Chat ID, channel ID, or @alias |
| `origin` | string | yes (root jobs only; child jobs inherit) | Source chat ID or `system` |
| `parent_id` | string | no | Parent job ID (for chains) |
| `trigger_on` | string | no | `success`, `failure`, `complete` |
| `trigger_condition` | string | no | `contains:X` or `regex:X` |
| `trigger_delay_s` | integer | no | Delay before trigger fires |
| `max_retries` | integer | no | Retry count on failure |
| `overlap_policy` | string | no | `allow`, `skip`, `queue` |
| `approval_required` | boolean | no | Require HITL approval |
| `approval_timeout_s` | integer | no | Approval window in seconds |
| `approval_auto` | string | no | `approve` or `reject`; scoped gates require `reject` |
| `approval_risk_level` | string | no | `low`, `medium`, or `high` |
| `approval_approver_scope` | string | no | OS-authenticated bare/exact, local-user, UID, or local-principal scope |
| `output_format` | string | no | `json`, `ndjson`, or `text` run-output contract |
| `identity_delegation_mode` | string | no | Declared delegation mode validated before execution |
| `authorization_ref` | string | no | Provider-qualified external policy reference |
| `evidence_ref` | string | no | Stable label for immutable run evidence |
| `evidence` | JSON/string | no | Built-in SHA-256 checksum declaration; external signer/verifier providers are rejected |
| `enabled` | integer | no | 1 (enabled) or 0 (disabled) |

For the full field list, run `openclaw-scheduler schema jobs`.

Cancellation and timeout are fenced against dispatcher ownership. Shell jobs
terminate the tracked process group before terminal completion. External
delivery uses the transactional `delivery_outbox`, separate from agent prompt
messages. Use `openclaw-scheduler doctor --json` for schema, lease, queue,
outbox, approval, and cancellation diagnostics.

## Delivery channels

All channels supported by the OpenClaw gateway work with the scheduler:
Telegram, Discord, WhatsApp, Signal, iMessage, and Slack.

Examples in this document use `telegram` as the delivery_channel.
Replace with your channel of choice.
