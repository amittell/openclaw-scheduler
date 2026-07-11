---
name: openclaw-scheduler
description: Use for an OpenClaw continuity sidecar that runs shell work independently of the Gateway and adds durable conditional job graphs, approvals, retries, delivery, and SQLite run state.
---

# OpenClaw Scheduler

OpenClaw Scheduler is a separate runtime for OpenClaw agent jobs and shell workflows. Current OpenClaw already provides durable cron state, command jobs, retries, run history, Task Flow, and approval tooling. Use this scheduler when an operator specifically needs a separate failure domain, Gateway-independent shell execution, direct conditional job graphs, or the governed runtime target for `@amittell/agentcli`.

Source: `github.com/amittell/openclaw-scheduler` (MIT)

Default runtime home: `~/.openclaw/scheduler/`

Runtime: Node.js 22 or newer, SQLite through `better-sqlite3`, cron through `croner`

## Choose the right runtime

Use OpenClaw Scheduler when at least one of these is required:

- Shell jobs must continue while the OpenClaw Gateway is stopped or unhealthy.
- The scheduler must remain a separate failure domain from the Gateway.
- A parent job must trigger children on success, failure, completion, or output conditions.
- The workflow needs durable approval, retry, cancellation, delivery, and audit state in one local database.
- An `@amittell/agentcli` manifest targets `openclaw-scheduler`.

Use native OpenClaw cron when one scheduled command or agent turn is enough. Do not migrate merely to obtain SQLite history, command jobs, or basic retries; native OpenClaw now provides those.

## Install and diagnose

```bash
npm install -g openclaw-scheduler
openclaw-scheduler setup
openclaw-scheduler doctor
openclaw-scheduler status --json
```

`setup` creates or upgrades the runtime database and installs the selected service mode. `doctor` validates schema version 27 and reports dispatcher lease, dispatch queue, delivery outbox, approval, and cancellation state.

## Define a job

Write a complete JSON spec, validate it, then add it:

```bash
openclaw-scheduler jobs validate --file job.json
openclaw-scheduler jobs add --file job.json
```

```json strict
{
  "name": "Hourly queue probe",
  "schedule_cron": "0 * * * *",
  "schedule_tz": "UTC",
  "session_target": "shell",
  "payload_kind": "shellCommand",
  "payload_message": "scripts/check-queue.sh",
  "shell_env_policy": "minimal",
  "run_timeout_ms": 60000,
  "delivery_mode": "none",
  "origin": "system"
}
```

JSON may also be supplied through standard input:

```bash
openclaw-scheduler jobs add --stdin < job.json
```

Every job requires an explicit positive `run_timeout_ms`. Fresh shell jobs default to `shell_env_policy: "minimal"`; use `inherit` only when the job intentionally depends on the service environment.

## Build a conditional chain

Create the parent first, then create children with `parent_id` and `trigger_on` set to `success`, `failure`, or `complete`. Use `trigger_condition` for `contains:` or `regex:` output matching. For larger declarative graphs, install `@amittell/agentcli` and apply a manifest to this runtime.

## Migrate native OpenClaw jobs

The default importer reads supported CLI output from `openclaw cron list --json` and `openclaw cron get <id> --json`:

```bash
openclaw-scheduler migrate --dry-run --json
openclaw-scheduler migrate --json
```

Use `--legacy-json ~/.openclaw/cron/jobs.json` only for an old exported file. Intervals that cannot be represented exactly by five-field cron are rejected. `--allow-inexact-every` is an explicit opt-in to approximation. Disable native jobs only after validating the report and test-running the imported scheduler jobs.

## Operator commands

- `openclaw-scheduler jobs list --json`: job definitions and next-run state
- `openclaw-scheduler runs list <job-id> --json`: run history
- `openclaw-scheduler runs output <run-id> stdout`: stored or offloaded output
- `openclaw-scheduler jobs approve <job-id>` and `jobs reject <job-id>`: resolve a pending gate
- `openclaw-scheduler jobs disable <job-id>` and `jobs enable <job-id>`: stop or resume scheduling
- `openclaw-scheduler jobs cancel <job-id>`: request fenced cancellation for active work and descendants
- `openclaw-scheduler doctor --json`: schema and runtime diagnostics

## Runtime guarantees

- A singleton dispatcher lease and fencing token prevent a second dispatcher from finalizing another dispatcher's work.
- Shell cancellation and timeout terminate the tracked process group before terminal state is committed.
- Dispatch queue claims have leases and stale-claim recovery.
- External delivery uses a transactional outbox separate from agent prompt messages, with durable attachment metadata.
- Approval decisions are atomic and audited.
- Governance fields are enforced at execution time; a job is rejected when its requested policy cannot be enforced.

These controls reduce duplicate side effects but do not make an arbitrary shell command idempotent. Design destructive commands with their own idempotency checks and verify cancellation through `runs get` or `status`, never from asynchronous chat messages.

## Platform boundary

macOS and Linux are supported service targets. Windows deployment uses WSL2. Agent jobs require a reachable Gateway; shell jobs do not. The scheduler and native OpenClaw cron can coexist, but the same job must not remain enabled in both runtimes.
