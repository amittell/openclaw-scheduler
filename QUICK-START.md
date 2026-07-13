# Quick Start: OpenClaw Scheduler

OpenClaw Scheduler is a continuity and governed-workflow sidecar for OpenClaw. Current OpenClaw already has SQLite cron state, command jobs, retries, run history, Task Flow, and approval tooling. Add this scheduler when shell work must survive Gateway downtime, when a separate failure domain matters, or when a workflow needs direct conditional job graphs and the `@amittell/agentcli` runtime contract.

For the complete reference, see [README.md](README.md).

## 1. Install

```bash
mkdir -p ~/.openclaw/scheduler
npm install --ignore-scripts=false --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
alias ocs='npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler --'
ocs setup
```

The explicit `--ignore-scripts=false` lets the trusted `better-sqlite3`
dependency install its native binding. If an earlier install disabled lifecycle
scripts, rebuild it with `npm rebuild --ignore-scripts=false better-sqlite3`.

The setup wizard creates or upgrades the database and installs the selected macOS launchd or Linux systemd service.

## 2. Diagnose the runtime

```bash
ocs doctor
ocs status --json
```

`doctor` verifies schema version 28, required tables, database writability, the singleton dispatcher lease, dispatch queue claims, delivery outbox claims, approval state, immutable evidence storage, and pending cancellations. A missing active lease is a warning when the dispatcher is intentionally stopped.

## 3. Create a shell job

Save this as `queue-probe.json`:

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

Validate before writing, add the job, then trigger a manual run:

```bash
ocs jobs validate --file queue-probe.json
ocs jobs add --file queue-probe.json
ocs jobs list --json
ocs jobs run <job-id>
ocs runs list <job-id> --json
```

Every job needs an explicit positive `run_timeout_ms`. Fresh shell jobs default to `shell_env_policy: "minimal"`. Choose `inherit` only when the job intentionally depends on the service environment.

## 4. Create an isolated agent job

Save this as `morning-briefing.json`:

```json strict
{
  "name": "Morning briefing",
  "schedule_cron": "0 8 * * 1-5",
  "schedule_tz": "America/New_York",
  "session_target": "isolated",
  "agent_id": "main",
  "payload_kind": "agentTurn",
  "payload_message": "Summarize overnight alerts and list the three highest-priority follow-ups.",
  "run_timeout_ms": 300000,
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "123456789",
  "origin": "telegram:123456789"
}
```

```bash
ocs jobs validate --file morning-briefing.json
ocs jobs add --file morning-briefing.json
```

Agent jobs require a reachable Gateway. Shell jobs do not.

## 5. Build a conditional chain

Create the parent job first. Copy its returned `job.id` into a child spec as `parent_id`, omit the child's cron schedule, and set one trigger:

- `trigger_on: "success"`
- `trigger_on: "failure"`
- `trigger_on: "complete"`

Add `trigger_condition: "contains:ALERT"` or `trigger_condition: "regex:ERROR.*critical"` when output must also match. Add `approval_required: true` to risky work. Approval gates apply to root, manual, scheduled, one-shot, and chain dispatches. For scoped production work, add `approval_risk_level: "high"` and `approval_approver_scope: "user:alex"`, then use `ocs approvals approve <approval-id> --reason "Reviewed"` from that local OS account. Approval decisions are atomic and execution-bound; rejected, expired, changed, disabled, or cancelled work cannot be dispatched later by a stale approval record. Domain scopes and caller-selected approver identity are not supported.

For larger graphs, install the control-plane companion:

```bash
npm install -g @amittell/agentcli
agentcli validate manifest.json
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db --dry-run
agentcli apply manifest.json --db ~/.openclaw/scheduler/scheduler.db
```

## 6. Migrate current OpenClaw cron jobs

The default importer uses the supported OpenClaw CLI. It reads `openclaw cron list --json`, then fetches each stored definition with `openclaw cron get <id> --json`.

Always inspect a dry run first:

```bash
ocs migrate --dry-run --json > migration-report.json
ocs migrate --json
ocs jobs list --json
```

Dry-run conversion does not open, create, or migrate the target scheduler
database. Because it intentionally avoids that state, an existing scheduler job
with the same ID is reported as `skipped` only during the real import.

Cron expressions and one-shot `at` timestamps are preserved. An `every` interval is imported automatically only when five-field cron can represent its cadence and phase exactly. Other intervals fail the migration report. Approximation requires an explicit choice:

```bash
ocs migrate --allow-inexact-every --dry-run --json
```

For an old pre-SQLite export, select legacy mode explicitly:

```bash
ocs migrate --legacy-json ~/.openclaw/cron/jobs.json --dry-run --json
ocs migrate --legacy-json ~/.openclaw/cron/jobs.json --json
```

Do not disable native OpenClaw jobs until the report is successful and representative imported jobs have completed test runs. Then disable only the migrated native jobs so the same side effect cannot run in both systems:

```bash
openclaw cron edit <job-id> --disable
```

Rollback is the reverse: stop the scheduler, disable its imported jobs, and re-enable the corresponding native jobs. Keep the scheduler database until rollback verification is complete.

## 7. Operate safely

```bash
ocs jobs disable <job-id>
ocs jobs enable <job-id>
ocs jobs cancel <job-id>
ocs runs get <run-id> --json
ocs runs output <run-id> stdout
ocs runs evidence <run-id> --json
ocs approvals list --json
ocs doctor --json
```

Cancellation is fenced against dispatcher ownership. Shell cancellation and timeout terminate the tracked process group before a terminal transition is committed. Agent cancellation records the Gateway cancellation request. Always confirm the authoritative run state with `runs get`, `runs running`, or `status`; asynchronous chat updates can be stale.

External delivery is committed through a transactional outbox that is separate from agent prompt messages. Attachments are retained with size and SHA-256 metadata. Delivery is retried under a claim lease and cannot be consumed as another agent's prompt context. Durable enqueue is not a delivery receipt; completion debt closes only after every outbox part is actually delivered.

Governance fields are execution controls in version 0.4.0. If a requested sandbox, path, network, credential, trust, proof, delegation, authorization, output, evidence, or cost policy cannot be enforced, execution fails closed. These controls do not make a destructive command idempotent, so the command itself must still detect prior completion safely.

## 8. Run the complete repository gate

```bash
npm run verify:local
```

The gate runs linting, type checking, the legacy integration suite, every focused `tests/*.test.mjs` file sequentially with an isolated database, documentation example validation, the sibling `agentcli` integration suite when that checkout is available, coverage, and a package dry run.

## Next references

- [JOB-QUICK-REF.md](JOB-QUICK-REF.md) for job fields and recipes
- [BEST-PRACTICES.md](BEST-PRACTICES.md) for production patterns
- [UPGRADING.md](UPGRADING.md) for schema migration and rollback
- [UNINSTALL.md](UNINSTALL.md) for removal and native-job restoration
- [docs/trust-architecture.md](docs/trust-architecture.md) for enforcement boundaries
