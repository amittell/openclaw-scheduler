# Quick Start -- OpenClaw Scheduler

This guide gets you from zero to a running scheduler with real jobs in under 10 minutes. It covers:

1. Installing and starting the scheduler
2. Converting your existing OpenClaw cron jobs
3. Building your first workflow chain

For the full reference manual, see [README.md](README.md).

---

## Why switch from built-in cron?

OpenClaw's built-in `cron/jobs.json` and heartbeat are fine for simple tasks. The scheduler replaces them when you need:

- **Run history** -- know what ran, when, and whether it succeeded
- **Shell jobs** -- scripts that run even when the gateway is down
- **Retries** -- automatic retry with exponential backoff on failure
- **Chains** -- parent/child jobs that trigger on success, failure, or output patterns
- **Approval gates** -- human-in-the-loop before risky steps execute
- **Delivery** -- send results to Telegram, with alias routing and chunking
- **Audit trail** -- every dispatch, retry, and delivery is recorded in SQLite

| Before (built-in) | After (scheduler) |
|---|---|
| `~/.openclaw/cron/jobs.json` | SQLite `jobs` table with full run history |
| No run tracking | Status, duration, summary for every run |
| No retry | Configurable retries with exponential backoff |
| No chains | Parent/child jobs with trigger conditions |
| Shell scripts are manual | Shell jobs with cron, delivery, and audit |

---

## 1. Install

```bash
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
```

Create a shell alias for convenience:

```bash
alias ocs='npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler --'
```

Add this line to your `~/.zshrc` or `~/.bashrc` to make it permanent.

## 2. Run setup

```bash
ocs setup
```

The wizard will:
- Create or migrate `scheduler.db`
- Install a system service (macOS launchd or Linux systemd)
- Create built-in helper jobs (Inbox Consumer, Stuck Run Detector)

## 3. Verify

```bash
ocs status
```

You should see the scheduler running with at least the built-in jobs.

---

## Converting existing OpenClaw crons

### Automatic import

If you have jobs in `~/.openclaw/cron/jobs.json`:

```bash
ocs migrate
ocs jobs list
```

This imports all existing cron jobs into the scheduler's SQLite database.

Then disable the old cron system:

```bash
openclaw cron edit <job-id> --disable    # for each job
openclaw config set cron.enabled false
openclaw config set agents.defaults.heartbeat.every "0m"
```

### Manual conversion

Here is how each type of OpenClaw cron entry maps to a scheduler job:

#### Simple cron line (shell)

**Before:** `*/5 * * * * /usr/local/bin/check-api.sh`

**After:**
```bash
ocs jobs add '{
  "name": "API Check",
  "schedule_cron": "*/5 * * * *",
  "session_target": "shell",
  "payload_message": "/usr/local/bin/check-api.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Key fields:
- `session_target: "shell"` -- runs a shell command directly, no AI needed
- `payload_message` -- the command to execute
- `delivery_mode: "announce"` -- sends output only on failure

#### Heartbeat / AI prompt

**Before:** `heartbeat.every: "30m"` with a prompt

**After:**
```bash
ocs jobs add '{
  "name": "Daily Status Summary",
  "schedule_cron": "0 8 * * *",
  "schedule_tz": "America/New_York",
  "session_target": "isolated",
  "payload_message": "Summarize the most important errors and follow-ups from the last 24 hours.",
  "delivery_mode": "announce-always",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

Key fields:
- `session_target: "isolated"` -- runs in its own agent session
- `delivery_mode: "announce-always"` -- always sends output, not just on failure

#### Two sequential tasks

**Before:** two cron entries with manual timing

**After:** a parent/child chain:

```bash
# Step 1: parent job
ocs jobs add '{
  "name": "Nightly Backup",
  "schedule_cron": "0 2 * * *",
  "session_target": "shell",
  "payload_message": "/usr/local/bin/nightly-backup.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

```bash
# Step 2: child job (runs after parent succeeds)
ocs jobs add '{
  "name": "Verify Backup",
  "parent_id": "BACKUP_JOB_ID",
  "trigger_on": "success",
  "trigger_delay_s": 60,
  "session_target": "shell",
  "payload_message": "/usr/local/bin/verify-backup.sh",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID",
  "origin": "system"
}'
```

The second job only runs when the first one succeeds. No more hoping the timing is right.

---

## Common operations

```bash
# List all jobs
ocs jobs list

# Run a job immediately
ocs jobs run <job-id>

# View recent runs for a job
ocs runs list <job-id> 10

# View a specific run's details
ocs runs get <run-id>

# Disable a job
ocs jobs update <job-id> '{"enabled": false}'

# Enable a job
ocs jobs update <job-id> '{"enabled": true}'

# Delete a job
ocs jobs delete <job-id>

# Check scheduler health
ocs status

# View logs
tail -f /tmp/openclaw-scheduler.log
```

---

## Session targets explained

| Target | When to use | Gateway needed? |
|---|---|---|
| `shell` | Deterministic commands, scripts, health checks | No |
| `isolated` | AI reasoning, summarization, writing, tool use | Yes |
| `main` | Inject into the main session (system events) | Yes |

**Rule of thumb:** if the task has a predictable answer, use `shell`. If it needs thinking, use `isolated`.

---

## Delivery modes explained

| Mode | Behavior |
|---|---|
| `announce` | Send output only on failure |
| `announce-always` | Send output on every run (success and failure) |
| `none` | Never send output |

For `announce` and `announce-always`, you must set `delivery_channel` and `delivery_to`.

---

## Next steps

- [INSTALL.md](INSTALL.md) -- detailed macOS launchd setup
- [INSTALL-LINUX.md](INSTALL-LINUX.md) -- Linux/WSL2 systemd setup
- [BEST-PRACTICES.md](BEST-PRACTICES.md) -- operational patterns and anti-patterns
- [README.md](README.md) -- full reference manual (chains, retries, approvals, messaging, etc.)
- [UNINSTALL.md](UNINSTALL.md) -- how to remove the scheduler and restore built-in cron
