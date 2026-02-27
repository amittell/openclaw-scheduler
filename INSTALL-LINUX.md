# Installing OpenClaw Scheduler on Linux

Step-by-step guide to deploy the scheduler on a Linux host running OpenClaw.

> **macOS?** See [INSTALL.md](INSTALL.md).
> **Windows?** See [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 22 | Install via [nvm](https://github.com/nvm-sh/nvm) or [NodeSource](https://github.com/nodesource/distributions) |
| build-essential | `sudo apt install build-essential python3` — required for `better-sqlite3` native compile |
| OpenClaw gateway running | With auth token |
| Git | `sudo apt install git` |
| systemd (user units) | Ubuntu 18.04+, Debian 10+, Fedora, Arch — standard |

---

## Step 1: Clone the Repository

```bash
cd ~/.openclaw
git clone https://github.com/amittell/openclaw-scheduler.git scheduler
cd scheduler
```

Or copy from an existing host:
```bash
scp -r user@source-host:~/.openclaw/scheduler ~/.openclaw/scheduler
```

---

## Step 2: Install Build Dependencies and Node Modules

Install system build tools first — `better-sqlite3` compiles a native addon and needs them:

```bash
# Ubuntu/Debian
sudo apt install build-essential python3

# Fedora/RHEL
sudo dnf install gcc gcc-c++ make python3

# Arch
sudo pacman -S base-devel python
```

Then install Node dependencies:

```bash
cd ~/.openclaw/scheduler
npm install
```

If `better-sqlite3` still fails, check that `node-gyp` can find Python:
```bash
node -e "require('better-sqlite3')" && echo "OK"
```

---

## Step 3: Run Tests

```bash
SCHEDULER_DB=:memory: node test.js  # 346 tests
```

**All tests must pass before proceeding.** Total: 346 tests.

---

## Step 4: Enable Chat Completions on Gateway

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw gateway restart
```

Verify:
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw:main","messages":[{"role":"user","content":"reply OK"}]}' \
  http://127.0.0.1:18789/v1/chat/completions
```

Expected: `200`

---

## Step 5: Migrate Jobs from OC Cron

```bash
cd ~/.openclaw/scheduler
node migrate.js
```

This imports jobs from `~/.openclaw/cron/jobs.json` → SQLite, converting schedule formats:
- `cron` → direct expression
- `every` → approximate cron (e.g., 30min → `*/30 * * * *`)
- `at` → one-shot with `delete_after_run=true`

Verify:
```bash
node cli.js jobs list
node cli.js status
```

---

## Step 6: Disable OC Built-in Cron

```bash
openclaw cron list
# For each enabled job:
openclaw cron edit <job-id> --disable
```

Verify: `openclaw cron list` shows no enabled jobs (or "No cron jobs").

---

## Step 7: Disable OC Heartbeat

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw gateway restart
```

---

## Step 8: Install systemd User Service

The scheduler runs as a **systemd user service** — it runs under your user account, starts on login (and optionally on boot via linger), and restarts automatically on crash.

```bash
# Create user service directory
mkdir -p ~/.config/systemd/user/

# Copy the template
cp ~/.openclaw/scheduler/openclaw-scheduler.service ~/.config/systemd/user/

# Edit the service file
nano ~/.config/systemd/user/openclaw-scheduler.service
```

**Required edits in the service file:**

1. Replace `YOUR_GATEWAY_TOKEN` with your actual OpenClaw gateway token
2. Verify `ExecStart` uses the correct `node` path:
   ```bash
   which node   # check where node is — might be /usr/local/bin/node or ~/.nvm/versions/node/.../bin/node
   ```
   If node is not at `/usr/bin/node`, update the `ExecStart` line:
   ```ini
   ExecStart=/home/youruser/.nvm/versions/node/v22.14.0/bin/node --no-warnings /home/youruser/.openclaw/scheduler/dispatcher.js
   ```
   Note: `%h` expands to your home directory in systemd user units.

**Enable and start:**

```bash
# Reload systemd to pick up the new service
systemctl --user daemon-reload

# Enable autostart
systemctl --user enable openclaw-scheduler

# Start now
systemctl --user start openclaw-scheduler

# Verify
systemctl --user status openclaw-scheduler
journalctl --user -u openclaw-scheduler -f   # live logs (Ctrl-C to exit)
```

**Run without an active login session (important for servers):**

By default, systemd user services stop when you log out. To keep the scheduler running 24/7 even without an active session:

```bash
loginctl enable-linger $USER
```

This is the Linux equivalent of macOS LaunchAgent's `RunAtLoad: true` + `KeepAlive: true`.

---

## Step 9: Smoke Tests

### Isolated dispatch

Shell jobs on Linux use `/bin/bash` by default (or whatever `$SHELL` is set to). Override with `SCHEDULER_SHELL` env var in the service file.

```bash
cd ~/.openclaw/scheduler
node --input-type=module -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const job = createJob({
  name: 'Smoke Test',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'Reply with exactly: SCHEDULER_OK',
  delivery_mode: 'none',
  delete_after_run: true,
});
getDb().prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Created smoke test:', job.id);
"
sleep 20 && tail -10 /tmp/openclaw-scheduler.log
```

Look for: `Dispatching: Smoke Test` → `Completed: Smoke Test`

### Shell job smoke test

```bash
node --input-type=module -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const job = createJob({
  name: 'Shell Smoke Test',
  schedule_cron: '0 0 31 2 *',
  session_target: 'shell',
  payload_message: 'echo scheduler_shell_ok',
  delivery_mode: 'announce-always',
  delete_after_run: true,
});
getDb().prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Created shell smoke test:', job.id);
"
sleep 15 && node cli.js runs list
```

### Telegram delivery

```bash
node --input-type=module -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const job = createJob({
  name: 'Telegram Test',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'Confirm scheduler is working. Send a brief greeting.',
  delivery_mode: 'announce',
  delivery_channel: 'telegram',
  delivery_to: 'YOUR_TELEGRAM_ID',
  delete_after_run: true,
});
getDb().prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Created Telegram test:', job.id);
"
```

You should receive a Telegram message within 30 seconds.

---

## Step 10: Review Migrated Jobs

```bash
node cli.js jobs list
```

- Disable expired one-shot jobs: `node cli.js jobs disable <id>`
- Delete unwanted jobs: `node cli.js jobs delete <id>`
- Adjust timeouts: `node cli.js jobs update <id> '{"run_timeout_ms":600000}'`
- Verify cron conversions are correct for `every`-based schedules

---

## Step 11: Verify First Real Job

Wait for the next scheduled job and confirm:

```bash
# Watch live
journalctl --user -u openclaw-scheduler -f
tail -f /tmp/openclaw-scheduler.log

# After it fires:
node cli.js runs list <job-id>
```

---

## Service Management

```bash
# Start / Stop / Restart
systemctl --user start openclaw-scheduler
systemctl --user stop openclaw-scheduler
systemctl --user restart openclaw-scheduler

# Status
systemctl --user status openclaw-scheduler

# Logs
journalctl --user -u openclaw-scheduler -f
tail -f /tmp/openclaw-scheduler.log

# Disable autostart (won't start on next login)
systemctl --user disable openclaw-scheduler

# Quick health
node cli.js status
```

---

## Rollback

If anything goes wrong:

```bash
# 1. Stop and disable service
systemctl --user stop openclaw-scheduler
systemctl --user disable openclaw-scheduler
rm ~/.config/systemd/user/openclaw-scheduler.service
systemctl --user daemon-reload

# 2. Re-enable OC cron
openclaw cron edit <job-id> --enable  # for each job

# 3. Re-enable heartbeat
openclaw config set agents.defaults.heartbeat.every "5m"
openclaw gateway restart
```

For a complete removal (deleting all data), see [UNINSTALL.md](UNINSTALL.md).

---

## Validation Checklist

- [ ] `SCHEDULER_DB=:memory: node test.js` → 346/346
- [ ] `node cli.js status` → shows jobs, 0 stale
- [ ] `systemctl --user status openclaw-scheduler` → active (running)
- [ ] Log file has startup lines, no errors
- [ ] OC cron → all disabled
- [ ] OC heartbeat → `0m`
- [ ] Chat completions → 200
- [ ] Smoke test → dispatched + completed in log
- [ ] Telegram test → message received
- [ ] First real job → fires on schedule
- [ ] `loginctl enable-linger $USER` → confirmed (for always-on servers)
