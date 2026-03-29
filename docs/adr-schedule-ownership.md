# ADR: Schedule Ownership Between OpenClaw and openclaw-scheduler

Date: 2026-03-28
Status: Accepted

## Context

Three systems have scheduling-adjacent capabilities:

- OpenClaw provides native heartbeat and cron for personal assistant automation. These are product-level features built into the OpenClaw runtime for simple recurring prompts and periodic health signals.
- openclaw-scheduler provides durable orchestration with queueing, retries, approvals, chaining, audit, and recovery. It backs all of this with SQLite and supports mixed shell and agent workflows in the same chain.
- agentcli compiles manifest workflows toward openclaw-scheduler. It is the control plane for manifest authoring, validation, and compilation, but it does not execute prompt tasks locally and does not own a queue, retry engine, or approval state.

Without an explicit boundary, new work risks duplicating scheduling features across layers with slightly different semantics. OpenClaw's built-in cron might gain retry logic, agentcli might accumulate scheduling state, or openclaw-scheduler might start interpreting raw manifest schemas -- each case eroding the separation that keeps the three layers manageable.

## Decision

1. OpenClaw native cron/heartbeat is for product-level personal assistant automation. These jobs are non-durable: they have no retry, no approval gate, no chaining, and no guaranteed delivery. If the gateway is down when a cron job fires, the execution is silently skipped.
2. openclaw-scheduler is for manifest-native durable workflows that need queueing, retries, approvals, audit, chaining, and guaranteed delivery. It owns run history, failure recovery, overlap policies, and the full lifecycle of shell and agent jobs.
3. agentcli NEVER targets OpenClaw native cron directly. All recurring prompt tasks in agentcli manifests compile toward openclaw-scheduler via `compileManifestToScheduler`. The `TARGETS` registry in agentcli has no OpenClaw-cron target and should not gain one.
4. OpenClaw native cron remains intentionally non-durable compared to openclaw-scheduler. This is a deliberate tradeoff, not a gap to close. Native cron optimizes for simplicity and zero configuration; openclaw-scheduler optimizes for reliability and auditability.

## Decision Rule

If the automation needs any of the following, it belongs in openclaw-scheduler:

- Retry on failure
- Approval gates
- Workflow chaining (parent/child task relationships)
- Audit trail with queryable run history
- Guaranteed delivery (at-least-once semantics)
- Crash recovery and durable state
- Overlap policies (skip, queue, allow)
- Conditional triggers based on parent task outcome or output content

If the automation is a simple personal assistant convenience that can tolerate silent failure and does not need delivery confirmation, run history, or post-failure logic -- OpenClaw native cron is appropriate.

## Consequences

- agentcli manifests remain the single authoring surface for durable scheduled work. Users do not need to learn two scheduling APIs.
- OpenClaw native cron stays simple. It does not need to grow retry, approval, or chaining features because those concerns live in openclaw-scheduler.
- Operators can distinguish scheduler-dispatched runs from native cron jobs inside OpenClaw. Scheduler runs carry origin metadata (`origin: "system"`) and are visible through the scheduler's runs API.
- Triggered tasks in agentcli use the sentinel cron pattern `0 0 31 2 *` (February 31, which never fires) to satisfy the scheduler schema requirement for a cron field. Actual dispatch for triggered tasks is controlled by parent task outcome and the scheduler runtime queue, not by the sentinel cron.
- Adding new scheduling features (e.g., rate limiting, cost budgets, SLA monitoring) should happen in openclaw-scheduler, not in OpenClaw native cron or agentcli.
- Users who currently rely on OpenClaw native cron for simple automations do not need to migrate. The two systems coexist, and the decision rule above clarifies when to use each one.

## Examples

### Example 1: Daily Status Summary

**As OpenClaw native cron:**
- Configure a cron job in OpenClaw that sends "summarize today's activity" to the assistant every day at 9am
- If the gateway is down at 9am, the job is silently skipped
- No retry, no delivery confirmation, no audit record

**As agentcli manifest via openclaw-scheduler:**
- Define a manifest with a scheduled task: cron "0 9 * * *", delivery_mode "announce", delivery_guarantee "at-least-once"
- If the first attempt fails, the scheduler retries (max_retries: 2)
- Result is delivered to the configured channel with guaranteed delivery
- Audit record tracks execution time, status, and output summary

### Example 2: Shell Health Check Every 5 Minutes

**As OpenClaw native cron:**
- Heartbeat fires a shell command every 5 minutes
- Output is not captured or delivered
- If the host is rebooting, checks are silently missed

**As agentcli manifest via openclaw-scheduler:**
- Define a manifest with session_target "shell", cron "*/5 * * * *", overlap_policy "skip"
- On failure, the scheduler can trigger a child alert task (trigger_on: "failure")
- Watchdog monitors the health check job itself
- Shell output stored and queryable via runs API
