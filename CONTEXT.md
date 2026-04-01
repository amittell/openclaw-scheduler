# Context

## Problem

Scheduled agent and shell workflows need durability: run history, retries,
approval gates, delivery, triggered chains, and an audit trail. Built-in
cron/heartbeat does not provide these.

## Repo Position

`openclaw-scheduler` is the durable runtime. It sits below the control plane
(`agentcli`) and beside the gateway (`openclaw`).

- It can work standalone with jobs created by agents or operators via CLI.
- It can be driven by `agentcli` for declarative manifest-based workflows.
- It dispatches to the OpenClaw gateway for agent sessions.
- It runs shell jobs directly without the gateway.

## Design Bias

- scheduling and state in SQLite (single-file, no external services)
- shell jobs are first-class, not second-class to agent jobs
- delivery is channel-agnostic (Telegram, Discord, WhatsApp, Signal, iMessage, Slack)
- run_timeout_ms is required on every job (no indefinite runs)
- overlap, retry, and delivery guarantee are per-job configuration
- keep the scheduler process stateless between ticks (all state in the DB)
