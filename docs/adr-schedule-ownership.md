# ADR: Schedule Ownership Between OpenClaw and OpenClaw Scheduler

Date: 2026-03-28

Status: Superseded on 2026-07-10

## Context

The original decision assumed native OpenClaw cron had no durable SQLite state, command jobs, retries, run history, task flows, or resumable approval tooling. That assumption is no longer true. Current OpenClaw provides those capabilities and stores cron state and history in its shared SQLite database.

Three layers remain relevant:

- OpenClaw owns native cron, command and agent execution inside the Gateway, Task Flow, and Lobster approval checkpoints.
- OpenClaw Scheduler is a separate continuity and governed-workflow sidecar. Shell jobs run outside Gateway availability, and direct parent/child graphs can trigger on outcome or output content.
- `@amittell/agentcli` owns declarative manifests, validation, stable task identity, and identity/authorization profiles. It may compile to OpenClaw Scheduler when that runtime is selected.

Duplicating all native OpenClaw scheduling features would add operational cost without a clear boundary. Treating repository documentation as evidence of live capability would also be unsafe, so operators must query both live systems before migration or incident decisions.

## Decision

1. Native OpenClaw cron is the default for a single scheduled command or agent turn, including jobs that need native history and retry behavior.
2. OpenClaw Task Flow or Lobster is the default when its restart-safe flow and resumable checkpoint model fits the workflow.
3. OpenClaw Scheduler is selected when at least one sidecar property is required:
   - shell execution must continue while the Gateway is stopped or unhealthy;
   - scheduler state must be a separate failure domain;
   - a job graph must directly trigger children on success, failure, completion, or output matching;
   - the workflow requires the OpenClaw Scheduler target emitted by `@amittell/agentcli`;
   - local operators require this runtime's fenced cancellation, transactional delivery outbox, and governance contract in one SQLite system.
4. `@amittell/agentcli` remains a control plane, not a scheduler. It does not own run queues, retry execution, or approval runtime state.
5. Native and sidecar jobs may coexist, but the same side effect must not remain enabled in both runtimes.

## Runtime Contract

OpenClaw Scheduler version 0.5.0 and schema 30 provide these ownership rules:

- One live dispatcher holds a named lease and monotonically fenced token.
- Active runs and queue claims carry ownership. A stale owner cannot finalize work or create downstream dispatches.
- Shell cancellation and timeout terminate the tracked process group before a terminal transition is committed.
- Completion, job state, and child enqueue commit atomically.
- External delivery is written to a transactional outbox separate from agent prompt messages.
- Approval decisions are atomic, versioned, and audited.
- Governance requirements fail closed when they cannot be enforced.
- Schema and migration errors abort startup.

These rules reduce duplicate execution but do not make an arbitrary external side effect idempotent.

## Migration Rule

The default importer reads supported live OpenClaw output through `openclaw cron list --json` and `openclaw cron get <id> --json`. It preserves cron expressions and one-shot timestamps. It rejects interval schedules that five-field cron cannot represent exactly unless the operator explicitly opts into approximation.

An old `jobs.json` export is accepted only through `--legacy-json`. Operators dry-run, inspect the structured report, run representative imported jobs, and only then disable the matching native jobs. Rollback stops or disables the imported copies and re-enables the native jobs. The sidecar database is retained until verification is complete.

## Consequences

- The public value proposition is continuity and governed conditional graphs, not a claim that native OpenClaw scheduling is primitive.
- Operators have a clear reason to avoid an additional service when native OpenClaw is sufficient.
- The scheduler can evolve its sidecar invariants without forcing OpenClaw or agentcli to adopt its storage model.
- New features belong where their execution state naturally lives. Manifest syntax belongs in agentcli, Gateway-native behavior belongs in OpenClaw, and sidecar lease/queue/outbox behavior belongs in OpenClaw Scheduler.
