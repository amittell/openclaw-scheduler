# Suggested Title

openclaw-scheduler: durable workflows for OpenClaw when built-in cron stops being enough

# Post Draft

Hey everyone. I've been building [openclaw-scheduler](https://github.com/amittell/openclaw-scheduler), a durable orchestration runtime for OpenClaw agents and shell workflows.

OpenClaw's built-in cron and heartbeat are good for simple personal-assistant automation. If all you need is "send this prompt every hour" and silent failure is acceptable, the built-in path is fine.

`openclaw-scheduler` is for the point where that stops being good enough.

## Why use `openclaw-scheduler` instead of out-of-the-box OpenClaw?

Built-in OpenClaw cron/heartbeat are intentionally simple. They do **not** give you:

- durable run history
- retries on failure
- approval gates
- workflow chaining
- overlap / queue control
- guaranteed delivery
- shell jobs that keep running when the gateway is unhealthy

That matters once the automation is operationally important.

A common failure mode with OOTB cron is: the gateway is down when the job fires, the run gets skipped, and your only evidence is "maybe there was a log line." There is no real run ledger, retry story, or structured post-failure flow.

`openclaw-scheduler` replaces that with a SQLite-backed runtime for jobs and runs. It gives you:

- **Run history**: status, timestamps, output, and failure visibility for every run
- **Shell + agent workflows**: mix deterministic shell steps and OpenClaw agent steps in the same chain
- **Retries and recovery**: backoff, queueing, overlap policies, and crash recovery
- **Approval gates**: pause risky follow-up actions until a human approves them
- **Workflow chaining**: `shell health check -> agent diagnosis -> operator approval -> remediation`
- **Delivery**: route results and failures through the OpenClaw gateway instead of hoping someone checks logs

One especially useful distinction: `session_target: "shell"` jobs do **not** depend on the gateway. So backups, health checks, syncs, and other deterministic tasks can keep running even if OpenClaw itself is having a bad day.

So the short framing is:

- **Built-in OpenClaw cron/heartbeat**: convenience automation
- **`openclaw-scheduler`**: durable, auditable workflows you actually need to trust

## Where `agentcli` fits

`openclaw-scheduler` works on its own. You can create jobs directly, and OpenClaw can create them too.

[agentcli](https://github.com/amittell/agentcli) is the control-plane layer you add when you want those workflows to be declarative, repeatable, and identity-aware.

On top of the scheduler, `agentcli` adds:

- **Manifest authoring + validation** instead of hand-managing jobs
- **Stable job IDs** so re-applying a workflow updates the right jobs predictably
- **Repeatable apply / dry-run** workflows for safe changes
- **Adoption of existing scheduler jobs** by name, then long-term management by stable ID
- **Local validation + preview** before pushing changes into the durable runtime
- **Execution identity / trust / evidence** via v0.2 identity profiles, authorization proofs, and signed execution evidence

Importantly, `agentcli` is not trying to turn built-in OpenClaw cron into something it isn't. Durable scheduled work compiles to `openclaw-scheduler`, which stays the runtime.

So the split is:

- `openclaw-scheduler` = runtime
- `agentcli` = control plane

## Why mention `agentcli-demo` at all?

[agentcli-demo](https://github.com/amittell/agentcli-demo) is not really the OpenClaw-specific product. It is just the clearest end-to-end example of the "better together" story.

It uses a real manifest to provision infra with Stripe Projects, deploy a Next.js/Vercel/Neon stack, split identities by task, enforce least-privilege Stripe/Vercel access, generate signed evidence, and compile the same workflow toward `openclaw-scheduler`.

So I only bring it up as proof that this is more than "another cron wrapper" and more than "another manifest format." The combo can govern real multi-step workflows with durable runtime behavior underneath.

## Try it

```bash
# install the durable runtime
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup

# optionally add the control plane
npm install -g @amittell/agentcli

# validate and preview a manifest
agentcli validate my-workflow.json
agentcli apply my-workflow.json \
  --db ~/.openclaw/scheduler/scheduler.db \
  --scheduler-prefix ~/.openclaw/scheduler \
  --dry-run
```

## Links

- [openclaw-scheduler](https://github.com/amittell/openclaw-scheduler)
- [agentcli](https://github.com/amittell/agentcli)
- [agentcli-demo](https://github.com/amittell/agentcli-demo)

Short version: if built-in OpenClaw cron is enough, keep using it. If you need durability, retries, chaining, approvals, shell jobs, and real run history, use `openclaw-scheduler`. If you also want declarative manifests, stable IDs, identity, trust, and audit evidence, add `agentcli` on top.
