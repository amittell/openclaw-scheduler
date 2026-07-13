# Suggested Title

openclaw-scheduler: Gateway-independent shell continuity and conditional workflows for OpenClaw

# Post Draft

Hey everyone. I have been building
[openclaw-scheduler](https://github.com/amittell/openclaw-scheduler), a local
SQLite-backed sidecar for OpenClaw agents and shell workflows.

This is not a claim that OpenClaw has no scheduler. Current OpenClaw already
has persistent cron state, command jobs, retries, run history, Task Flow, and
Lobster approval checkpoints. Native OpenClaw cron is the right default for a
single scheduled command or agent turn.

The sidecar is for narrower operational cases where a separate runtime is
useful:

- A deterministic shell job must still run while the OpenClaw Gateway is down.
- Scheduled work should have a failure domain separate from the Gateway.
- A workflow needs direct parent/child triggers based on success, failure, or
  output conditions.
- Shell and agent steps should share one durable graph with explicit timeout,
  retry, overlap, cancellation, and approval state.
- An `@amittell/agentcli` manifest needs a durable scheduler runtime target.

The scheduler can coexist with native OpenClaw cron. The important rule is not
to enable the same job in both systems.

## What it adds

The scheduler maintains its own jobs, run history, dispatch queue, approvals,
and delivery outbox in SQLite. It supports:

- Gateway-independent shell execution
- Isolated or main-session OpenClaw agent turns
- Conditional workflow chains and bounded retry policies
- Durable, fenced cancellation and timeout handling
- Human approval gates for root or triggered work
- Transactional delivery enqueueing with leased retries and deduplication
- Machine-readable CLI output for status, history, diagnostics, and automation

External chat delivery still depends on the Gateway and destination channel.
The outbox makes the scheduler-side handoff durable; it does not claim that a
third-party messaging service can never fail.

A representative workflow is:

```text
shell health check -> agent diagnosis -> operator approval -> shell remediation
```

The first step can run without the Gateway. Agent and chat-delivery steps wait
for Gateway availability, while the scheduler retains their durable state.

## Where agentcli fits

The scheduler works directly through its CLI and JSON job specifications.
[agentcli](https://github.com/amittell/agentcli) is the optional control plane
for declarative manifests, validation, stable workflow/task IDs, dry runs, and
repeatable apply operations.

Identity, authorization, and trust declarations are evaluated by the scheduler
runtime. Agentcli evidence declarations fail capability negotiation because the
scheduler implements a separate checksum-only evidence record, not agentcli's
complete payload and envelope contract. Provider-backed or executor-backed
controls require the corresponding configured provider or executor. When a
requested control cannot be enforced, the runtime rejects the work instead of
treating a declaration as proof that the control exists.

The split is deliberately simple:

- `openclaw-scheduler` is the durable runtime.
- `agentcli` is the declarative control plane.

## Try it

```bash
mkdir -p ~/.openclaw/scheduler
npm install --ignore-scripts=false --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- doctor --json
```

Optionally add the control plane:

```bash
npm install -g @amittell/agentcli
agentcli validate workflow.json
agentcli apply workflow.json \
  --db ~/.openclaw/scheduler/scheduler.db \
  --scheduler-prefix ~/.openclaw/scheduler \
  --dry-run
```

## Links

- [openclaw-scheduler](https://github.com/amittell/openclaw-scheduler)
- [agentcli](https://github.com/amittell/agentcli)
- [OpenClaw cron CLI](https://docs.openclaw.ai/cli/cron)
- [OpenClaw Task Flow](https://docs.openclaw.ai/automation/taskflow)
- [OpenClaw Lobster approvals](https://docs.openclaw.ai/tools/lobster)

Short version: use native OpenClaw scheduling for ordinary jobs. Use this
sidecar when Gateway-independent shell continuity, a separate failure domain,
or direct conditional mixed shell/agent graphs justify another runtime.
