# Best Practices

Guidance on choosing the right job type, writing effective prompts, structuring workflows, and making your OpenClaw agent scheduler-aware.

---

## Table of Contents

1. [Choosing the Right Job Type](#choosing-the-right-job-type)
   - [Session Targets at a Glance](#session-targets-at-a-glance)
   - [When to use `shell`](#when-to-use-shell)
   - [When to use `isolated`](#when-to-use-isolated)
   - [When to use `main`](#when-to-use-main)
   - [Chains vs Standalone](#chains-vs-standalone)
   - [Delivery Modes](#delivery-modes)
   - [Timeouts and Reliability](#timeouts-and-reliability)
2. [Integrating with Your OpenClaw Agent](#integrating-with-your-openclaw-agent)
   - [What the Agent Needs to Know](#what-the-agent-needs-to-know)
   - [Adding the Scheduler to Agent Memory](#adding-the-scheduler-to-agent-memory)
   - [How Scheduled Jobs Appear to the Agent](#how-scheduled-jobs-appear-to-the-agent)
   - [The HEARTBEAT_OK Convention](#the-heartbeat_ok-convention)
   - [Letting the Agent Create Jobs Dynamically](#letting-the-agent-create-jobs-dynamically)
   - [Communicating Between Jobs](#communicating-between-jobs)
   - [Practical Agent Briefing Example](#practical-agent-briefing-example)

---

## Choosing the Right Job Type

### Session Targets at a Glance

| Use Case | Target | Why |
|----------|--------|-----|
| Backups, scripts, log rotation, file cleanup | `shell` | No LLM cost, no gateway dependency, runs even if gateway is down |
| Morning briefings, reports, analysis, summaries | `isolated` | Gets full LLM + tools, isolated from your conversations |
| Urgent alerts that must appear in active chat | `main` | Injects directly into your live session |
| Build → deploy → notify pipelines | Chain of `isolated` jobs | Each step gets fresh context, failures stop the chain |

---

### When to use `shell`

Use `shell` when:
- The task is deterministic — a script, a health check ping, a disk usage check, a backup
- You don't need AI reasoning
- The job must run even when the gateway is down or rate-limited
- Speed matters — shell jobs complete in milliseconds vs 10–60s for LLM calls
- You want to minimize API cost

`payload_message` is passed directly to the shell (`/bin/zsh` on macOS, `/bin/bash` on Linux). Override with `SCHEDULER_SHELL` environment variable.

**Examples:**

```json
{ "session_target": "shell", "payload_message": "~/scripts/backup.sh" }

{ "session_target": "shell", "payload_message": "df -h / | grep -E '^/dev' | awk '{print $5}'" }

{ "session_target": "shell", "payload_message": "curl -sf http://localhost:8080/health || exit 1" }

{ "session_target": "shell", "payload_message": "cd ~/myapp && git pull && npm run build 2>&1" }
```

**Delivery with shell jobs:**
- `delivery_mode: "announce"` — sends output only on non-zero exit (perfect for failure alerts)
- `delivery_mode: "announce-always"` — sends output every time
- `delivery_mode: "none"` — background, check runs via `openclaw-scheduler runs list`

**Shell jobs work great as chain parents too** — a shell build job can trigger an isolated deploy job on success.

#### Shell Daemon Keepalive Jobs — Critical Rules

When using shell jobs to keep a background daemon (e.g. a model server, a vector DB, an MCP bridge) warm and running, three rules prevent silent failures:

**Rule 1: The daemon wrapper script must block.**

If your launchd/systemd service runs a wrapper script that sets up the daemon and then exits, the service manager restarts the script immediately -- potentially spawning multiple daemon instances fighting for the same port, causing hangs or crashes.

```bash
# Wrong -- script exits after setup, KeepAlive loops it immediately
./bridge.py daemon start   # starts daemon, initializes session, exits
./bridge.py warmup         # exits -> service restarts -> another daemon spawns

# Correct -- start daemon in background, block on its PID
./mydaemon --port 8181 &
DAEMON_PID=$!
./bridge.py daemon init    # session setup (runs once)
./bridge.py warmup         # pre-warm (runs once)
wait $DAEMON_PID           # blocks until daemon dies -> then service restarts cleanly
```

On macOS (`KeepAlive: true` launchd, whether LaunchAgent or LaunchDaemon) and Linux (`Restart=always` systemd), the moment your script exits the service manager restarts it. Always block on the daemon process with `wait $PID`.

**Rule 2: Keepalive jobs must exercise the actual hot path.**

A keepalive that pings `/health` or runs a lightweight query does NOT keep ML/neural models warm in GPU memory. Only calls that trigger real model inference keep the models loaded.

```bash
# Wrong -- lightweight health check, no model loading, GPU models go cold
curl -sf http://localhost:8181/health

# Correct -- inference query triggers embedding + reranker model loading
curl -sf http://localhost:8181/v1/embeddings \
  -d '{"input":"keepalive","model":"default"}' > /dev/null
```

Schedule model-warming keepalives at least every 10 minutes. Every 30 minutes is too infrequent -- models unload from GPU between calls, causing cold-start delays (10-20s) on the next real query.

**Rule 3: Daemon session/state files must not live in `/tmp`.**

`/tmp` is cleared on macOS reboot and on Linux boot (or by `systemd-tmpfiles`). If your daemon stores a session ID or token in `/tmp`, any reboot causes the next client call to fail — often silently (e.g. `400 Already Initialized`, empty results, or a crash with no stdout).

```bash
# ❌ Wrong — lost on reboot, daemon calls fail silently after restart
SESSION_FILE=/tmp/my-daemon-session.json

# ✅ Correct — persistent across reboots
SESSION_FILE=${XDG_CACHE_HOME:-$HOME/.cache}/my-daemon/session.json
```

Always store daemon session files in `XDG_CACHE_HOME` or another directory that persists across reboots.

---

### When to use `isolated`

Use `isolated` when:
- The task requires reasoning, writing, planning, or multi-step tool use
- The task reads or writes memory files
- You want OpenClaw's tools available (kubectl, browser, file access, exec, etc.)
- The output should be formatted and delivered to a channel

**Writing effective `isolated` job prompts:**

| Rule | Bad | Good |
|------|-----|------|
| Be imperative and specific | "check kubernetes" | "Check k8s pods in requesthub-prod and requesthub-dev. List any non-Running pods." |
| Include a success signal | *(nothing)* | "If all pods Running, reply with exactly: HEARTBEAT_OK" |
| Specify output format | *(nothing)* | "Format issues as: ⚠️ \<namespace\>/\<pod\>: \<status\>" |
| State available resources | *(implicit)* | "Your memory files are in ~/.openclaw/workspace/memory/" |
| Set realistic timeouts | default 300s | 120s for single-tool, 240s for multi-tool |

**Bad prompt:**
```
Check everything and let me know if anything is wrong
```

**Good prompt:**
```
Check k8s pod health across requesthub-prod and requesthub-dev namespaces.
List any non-Running pods. If all pods are Running, reply with exactly: HEARTBEAT_OK
Format any issues as: ⚠️ <namespace>/<pod>: <status>
```

**Another good prompt (morning briefing):**
```
Read ~/.openclaw/workspace/memory/2026-02-26.md (today's daily log).
Summarize: what was completed, what's in progress, any blockers.
Format as a 3-section bullet list: Done / In Progress / Blocked.
Keep it under 200 words.
```

---

### When to use `main`

Use `main` sparingly. It injects directly into your active agent session — the same conversation you're having with your agent right now.

**Good uses:**
- Long-running task check-ins: "You've been running for 30 minutes — report status"
- Alerts that should appear in your live chat, not delivered separately to a channel
- Jobs that genuinely need your ongoing conversation context (rare)

**Bad uses:**
- Cron jobs that run overnight — they'll clutter your session history when you wake up
- Anything that can be delivered to a channel instead

---

### Chains vs Standalone

**Use standalone jobs for:**
- Independent recurring tasks (morning briefing, daily backup)
- Tasks with no dependencies on other job results
- Anything where a failure shouldn't block anything else

**Use chains for:**
- Pipelines: build → test → deploy → notify
- Conditional work: monitor → (only if ALERT found) → escalate
- Post-processing: analyze → (only if anomaly) → deep-dive
- Cleanup that runs regardless: build → (always) → cleanup temp files

**Good chain example:**

```
[Daily CI Check — 9am]
  └─ [Deploy Staging — trigger:success]
      └─ [Smoke Test — trigger:success, delay:60s]
          └─ [Notify Team — trigger:complete]    ← runs regardless of pass/fail
          └─ [Rollback Staging — trigger:failure]
```

**Key chain tips:**
- Use `trigger_on: "complete"` (not success) for notification/cleanup jobs that should always run
- Use `trigger_delay_s` to give services time to start before smoke tests
- Use `trigger_condition: "contains:ALERT"` to only trigger escalation when the monitor actually finds something
- Set `max_retries: 1` or `2` on the first job in a chain — transient failures shouldn't kill the whole pipeline

---

### Delivery Modes

| Mode | Best for |
|------|----------|
| `none` | Background jobs — check results via `openclaw-scheduler runs list` |
| `announce` | LLM jobs with important output; shell jobs that should alert on failure |
| `announce-always` | Monitoring/audit jobs where you want every result |

**Don't** use `announce-always` on high-frequency jobs (every 5 minutes) unless you want a constant stream of messages. Save it for hourly or less frequent jobs, or jobs where the output is always relevant.

**The `announce` + `HEARTBEAT_OK` pattern** is the most useful combination: zero noise when healthy, immediate delivery when something needs attention. See [The HEARTBEAT_OK Convention](#the-heartbeat_ok-convention).

---

### Timeouts and Reliability

| Job type | Recommended `run_timeout_ms` | Notes |
|----------|------------------------------|-------|
| Simple shell script | 60,000 (60s) | Default 300s is usually too generous |
| LLM job, single tool | 120,000 (120s) | |
| LLM job, multi-tool (k8s + files + analysis) | 240,000 (240s) | |
| Long-running agent work | 600,000 (600s) | |

Set `max_retries: 1` or `max_retries: 2` for any job that hits external services (APIs, databases, GitHub, etc.) — transient failures happen, especially at cron-job-o'clock when everything runs at once.

**Retry tip:** Failure chain children don't fire until all retries are exhausted. This prevents false failure alerts on transient errors. Set retries before worrying about failure notifications.

---

## Integrating with Your OpenClaw Agent

Your agent runs in a fresh context each isolated session. This section covers how to make it scheduler-aware.

### What the Agent Needs to Know

For an agent to use the scheduler effectively, it needs to know:

1. The scheduler exists and where it is (`~/.openclaw/scheduler/`)
2. How to check status, create, and manage jobs via the CLI
3. What scheduled prompts look like — the `[scheduler:...]` header
4. How to respond correctly when *it is* the one receiving a scheduled prompt

---

### Adding the Scheduler to Agent Memory

Add a section like this to your `MEMORY.md` or workspace context file. Your agent reads this at the start of each session and will know how to work with the scheduler:

```markdown
## Scheduler
- Standalone scheduler at `~/.openclaw/scheduler/` — runs 24/7 as a background service
- Check status: `node ~/.openclaw/scheduler/cli.js status`
- List jobs: `node ~/.openclaw/scheduler/cli.js jobs list`
- Create a job: `node ~/.openclaw/scheduler/cli.js jobs add '<json>'`
- View run history: `node ~/.openclaw/scheduler/cli.js runs list <job-id>`
- Dispatch via OpenClaw chat completions API (isolated sessions — no chat history)
- Shell jobs run scripts directly — no LLM call, no gateway needed
- When you receive a prompt starting with [scheduler:...], you are in an isolated session.
  No conversation history. Focus on the task. Reply HEARTBEAT_OK for watchdog jobs when healthy.
```

---

### How Scheduled Jobs Appear to the Agent

When the dispatcher fires an isolated job, the agent receives a message structured like this:

```
[scheduler:abc123 Daily Health Check]

--- Pending Messages ---
From: scheduler | result | Previous backup: 3 files committed, pushed to origin
---

Check k8s pod health across requesthub-prod and requesthub-dev.
If all pods are Running, reply with exactly: HEARTBEAT_OK
Format any issues as: ⚠️ <namespace>/<pod>: <status>
```

The agent should:
- Recognize the `[scheduler:...]` header as a scheduled task prompt
- Understand it's in an isolated session — no access to prior user conversations
- Focus entirely on the task described in `payload_message`
- Use appropriate tools (exec, kubectl, browser, file access) as needed
- Respond concisely — the response becomes the run summary stored in the `runs` table

---

### The HEARTBEAT_OK Convention

For watchdog and health-check jobs, instruct the agent to reply `HEARTBEAT_OK` when nothing needs attention:

```json
{
  "name": "Disk Usage Check",
  "schedule_cron": "0 * * * *",
  "session_target": "isolated",
  "payload_message": "Check disk usage on all mounted filesystems. If all mounts are under 80% full, reply with exactly: HEARTBEAT_OK\nIf any mount is 80% or more, describe the affected mounts and their usage.",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID"
}
```

With `delivery_mode: "announce"`, the result is only delivered if the agent's response does **not** contain `HEARTBEAT_OK`.

Result: zero noise when healthy, immediate alert when something needs attention.

The same works for shell jobs — `announce` only triggers on non-zero exit.

---

### Letting the Agent Create Jobs Dynamically

The agent can create new scheduler jobs at runtime in two ways:

#### 1. Direct CLI (recommended for user-initiated requests)

When a user asks "remind me to review the PR in 2 hours", the agent runs:

```bash
node ~/.openclaw/scheduler/cli.js jobs add '{
  "name": "PR Review Reminder",
  "schedule_cron": "0 17 * * *",
  "session_target": "isolated",
  "payload_message": "Send Jordan a reminder to review the PR they opened this morning. Be specific about which PR.",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_CHAT_ID",
  "delete_after_run": true
}'
```

Use `"delete_after_run": true` for one-shot reminders so they clean up after themselves.

#### 2. Spawn messages (for jobs creating child jobs at runtime)

An isolated job can create new jobs on the fly by sending a spawn message to the scheduler agent:

```json
{
  "from_agent": "main",
  "to_agent": "scheduler",
  "kind": "spawn",
  "body": "{\"name\":\"Follow-up Analysis\",\"payload_message\":\"Analyze the anomaly found in the previous run and prepare a report.\",\"delete_after_run\":true,\"run_now\":true}"
}
```

The dispatcher picks this up on its next tick (within 15s) and creates and immediately runs the spawned job.

---

### Communicating Between Jobs

Jobs can pass data to each other using the inter-agent message queue. Messages injected into a job's context appear in the `--- Pending Messages ---` block at the top of the prompt.

**Pattern: Monitor → Handler**

Monitor job finds an anomaly and sends a task to the handler agent:

```bash
# In the monitor's payload_message, instruct the agent to:
# "If you find any ERROR entries in the log, send a message to agent 'main'
#  with kind='task' and body='<details of the error>'"
```

The handler job reads its inbox automatically at the start of its next run.

**Pattern: Job A → Job B via message queue**

```bash
# Send a message from one job to another
openclaw-scheduler msg send monitor-agent handler-agent "Found 3 critical errors at 14:23"
```

---

### Tracking Spawned Sub-Agents

When you spawn sub-agents to do parallel work, use the task tracker so the scheduler monitors them and delivers a completion summary automatically — without you polling.

**Step 1: Create a tracker before spawning**

```bash
# In your agent session, before spawning:
TRACKER_ID=$(node ~/.openclaw/scheduler/cli.js tasks create '{
  "name": "doc-sprint",
  "expectedAgents": ["writer", "reviewer"],
  "timeoutS": 3600,
  "deliveryChannel": "telegram",
  "deliveryTo": "YOUR_CHAT_ID"
}' | grep '"id"' | cut -d'"' -f4)
```

**Step 2: Spawn sub-agents (via `sessions_spawn` tool), then register their session keys**

```bash
# After getting the childSessionKey from sessions_spawn:
node ~/.openclaw/scheduler/cli.js tasks register-session $TRACKER_ID writer "agent:main:subagent:abc-123"
node ~/.openclaw/scheduler/cli.js tasks register-session $TRACKER_ID reviewer "agent:main:subagent:def-456"
```

Once session keys are registered, the **dispatcher auto-detects heartbeats** by calling `sessions_list` every 30s. As long as the sub-agent's session is active, it's counted as alive — no CLI calls required from inside the sub-agent.

**Step 3: Sub-agents report completion (optional but recommended)**

Add this to the sub-agent's task preamble:

```
## Status Reporting
Tracker ID: <TRACKER_ID>
Your agent label: writer

When you start working:
  node ~/.openclaw/scheduler/cli.js tasks heartbeat <TRACKER_ID> writer running

When you finish successfully:
  node ~/.openclaw/scheduler/cli.js tasks heartbeat <TRACKER_ID> writer completed "Brief summary of what you did"

If something goes wrong:
  node ~/.openclaw/scheduler/cli.js tasks heartbeat <TRACKER_ID> writer failed "What went wrong"
```

**What happens automatically:**
- Dispatcher checks active sessions every 30s — agents with active sessions stay "alive"
- Agents that go silent for > 5 minutes AND whose tracker has timed out → marked dead
- When all agents reach terminal state → delivery summary sent to your configured channel
- Check anytime: `openclaw-scheduler tasks status <TRACKER_ID>`

**Detecting sub-agents from other sessions:**

The scheduler's dispatcher calls `sessions_list` with `kinds: ['subagent']` which returns **all sub-agent sessions across all requesters** — not just the current session. This means:
- Sub-agents spawned from any session are visible to the task tracker
- Works even if the spawning session has ended
- Works across session compaction / context resets

---

### Practical Agent Briefing Example

Here's a complete, self-contained entry to add to your workspace `MEMORY.md` or context file. Copy and adapt it:

```markdown
## OpenClaw Scheduler — How to Use

The scheduler (`~/.openclaw/scheduler/`) runs as a background service (launchd / systemd) 
and fires jobs independently of your chat sessions.

### Quick commands
- Status: `openclaw-scheduler status`
- List jobs: `openclaw-scheduler jobs list`
- Add job: `openclaw-scheduler jobs add '<json>'`
- View runs: `openclaw-scheduler runs list <job-id>`
- Force run now: `sqlite3 scheduler.db "UPDATE jobs SET next_run_at = datetime('now','-1 second') WHERE name = 'Job Name'"`
- Logs: `tail -f /tmp/openclaw-scheduler.log`

### When you receive a scheduled prompt
You're in an isolated session. No conversation history. No context from prior chats.
Read the `[scheduler:...]` header to identify the job, then do exactly what `payload_message` says.
- Reply `HEARTBEAT_OK` for watchdog/health-check jobs when nothing needs attention (suppresses delivery)
- For analysis/report jobs, write a concise summary — it's stored as the run record
- For shell jobs, you're not invoked at all — the command runs directly

### Job types cheatsheet
| Type | Use for |
|------|---------|
| `shell` | Scripts, backups, pings — fast, no LLM, runs even when gateway is down |
| `isolated` | AI tasks needing tools, memory, reasoning — each run gets fresh context |
| `main` | Urgent alerts that must appear in your active chat (use sparingly) |

### Creating jobs
When asked to set up a scheduled task, use:
```bash
node ~/.openclaw/scheduler/cli.js jobs add '{
  "name": "Task Name",
  "schedule_cron": "0 9 * * 1-5",
  "session_target": "isolated",
  "payload_message": "Your clear, specific instructions here.",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "TELEGRAM_ID"
}'
```
```

---

## See Also

- [README.md](README.md) — Full feature reference
- [INSTALL.md](INSTALL.md) — macOS installation
- [INSTALL-LINUX.md](INSTALL-LINUX.md) — Linux installation
- [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) — Windows installation
- [UNINSTALL.md](UNINSTALL.md) — Removing the scheduler
