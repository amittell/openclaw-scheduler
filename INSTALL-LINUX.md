# Installing OpenClaw Scheduler on Linux

Step-by-step guide to deploy the scheduler on a Linux host running OpenClaw.

> **macOS?** See [INSTALL.md](INSTALL.md).
> **Windows?** See [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js >= 20 | Install via [nvm](https://github.com/nvm-sh/nvm) or [NodeSource](https://github.com/nodesource/distributions) |
| build-essential | `sudo apt install build-essential python3` — required for `better-sqlite3` native compile |
| OpenClaw gateway running | With auth token |
| Git | `sudo apt install git` |
| systemd (user units) | Ubuntu 18.04+, Debian 10+, Fedora, Arch — standard |

---

## Step 1: Install Scheduler Files

```bash
cd ~/.openclaw
git clone https://github.com/amittell/openclaw-scheduler.git scheduler
cd scheduler
```

Or copy from an existing host:
```bash
scp -r user@source-host:~/.openclaw/scheduler ~/.openclaw/scheduler
```

Or npm-first install (no git clone):
```bash
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- help
```

Runtime state for npm installs defaults to `~/.openclaw/scheduler/`, not the package directory under `node_modules/`.

---

## Step 2: Install Build Dependencies and Node Modules

If you used the npm-first install path in Step 1, dependencies are already installed; skip to Step 3.

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
SCHEDULER_DB=:memory: node test.js  # 960 tests
```

**All tests must pass before proceeding.** Total: 960 tests.

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
openclaw config set cron.enabled false
```

Also set `OPENCLAW_SKIP_CRON=1` in your OpenClaw gateway service environment (systemd/pm2), then restart the gateway.

Verify: `openclaw cron list` shows no enabled jobs (or "No cron jobs").

---

## Step 7: Disable OC Heartbeat

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
# If you have per-agent heartbeat overrides, set/remove those too:
# agents.list[].heartbeat.every = "0m"
openclaw gateway restart
```

---

## Step 8: Install systemd User Service

The scheduler runs as a **systemd user service** — it runs under your user account, starts on login (and optionally on boot via linger), and restarts automatically on crash.

```bash
# Create user service directory
mkdir -p ~/.config/systemd/user/

# Create the service file
cat > ~/.config/systemd/user/openclaw-scheduler.service <<'EOF'
[Unit]
Description=OpenClaw Scheduler
Documentation=https://github.com/amittell/openclaw-scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.openclaw/scheduler
ExecStart=/usr/bin/node --no-warnings %h/.openclaw/scheduler/dispatcher.js
Environment=OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
Environment=OPENCLAW_GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN
Environment=SCHEDULER_DB=%h/.openclaw/scheduler/scheduler.db
Environment=SCHEDULER_TICK_MS=10000
Environment=SCHEDULER_STALE_THRESHOLD_S=90
Environment=SCHEDULER_DEBUG=1
Restart=always
RestartSec=5
StandardOutput=append:/tmp/openclaw-scheduler.log
StandardError=append:/tmp/openclaw-scheduler.log

[Install]
WantedBy=default.target
EOF

# Edit the service file if needed
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
   ExecStart=/home/youruser/.nvm/versions/node/v20.19.5/bin/node --no-warnings /home/youruser/.openclaw/scheduler/dispatcher.js
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

Shell jobs on Linux use `/bin/bash` by default. Override with `SCHEDULER_SHELL` env var in the service file.

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

## Optional: QMD Memory Daemon (if using QMD as memory backend)

If your OpenClaw instance uses QMD for hybrid memory search (`memory.backend = "qmd"`), you need a persistent systemd service for the QMD MCP daemon — equivalent to the macOS LaunchAgent on `com.openclaw.qmd-daemon`.

### Key rules (learned the hard way)

**The wrapper script must block on the daemon process.** If the script exits after setup, systemd restarts it immediately → multiple daemon instances fight for the port → `deep_search` calls hang indefinitely.

**The keepalive job must call `deep_search`, not `qmd search`.** BM25 (`qmd search`) doesn't load neural models. Only `deep_search` keeps the embedding and reranker models in GPU memory. Run it every 10 minutes.

**Session files must not live in `/tmp`.** Use `XDG_CACHE_HOME` — `/tmp` is cleared on reboot, causing `400 Already Initialized` errors that result in empty search results.

### systemd service

```ini
# ~/.config/systemd/user/qmd-daemon.service
[Unit]
Description=QMD MCP Daemon
After=network.target

[Service]
Environment=XDG_CONFIG_HOME=%h/.openclaw/agents/main/qmd/xdg-config
Environment=XDG_CACHE_HOME=%h/.openclaw/agents/main/qmd/xdg-cache
ExecStart=%h/.openclaw/bin/start-qmd-daemon.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable qmd-daemon
systemctl --user start qmd-daemon
loginctl enable-linger $USER   # keep running without active login session
```

### Daemon wrapper script (`~/.openclaw/bin/start-qmd-daemon.sh`)

```bash
#!/bin/bash
export XDG_CONFIG_HOME=$HOME/.openclaw/agents/main/qmd/xdg-config
export XDG_CACHE_HOME=$HOME/.openclaw/agents/main/qmd/xdg-cache
QMD=$HOME/node_modules/@tobilu/qmd/qmd
BRIDGE="python3 $HOME/.openclaw/scripts/mcporter-qmd.py"

# Wait for model storage to be available (adjust path as needed)
for i in {1..30}; do
    [ -d "/path/to/qmd-cache" ] && break
    sleep 2
done

# Start QMD in background — do NOT exec into it or the wait below won't work
$QMD mcp --http --port 8181 &
QMD_PID=$!

# Wait for port
for i in {1..20}; do
    sleep 0.5
    python3 -c "import socket; s=socket.create_connection(('127.0.0.1',8181),1); s.close()" 2>/dev/null && break
done
sleep 1

# Initialize MCP session (saved to XDG_CACHE_HOME, NOT /tmp)
$BRIDGE daemon start

# Pre-warm embedding + reranker models (one-time on startup)
$BRIDGE call qmd.deep_search   --args '{"query":"memory","limit":1,"minScore":0,"collection":"memory-root-main"}'   --timeout 60000 > /dev/null 2>&1

# Block until QMD exits — systemd only restarts when QMD actually dies
wait $QMD_PID
```

### Keepalive scheduler job

```json
{
  "name": "QMD Daemon Keepalive",
  "schedule_cron": "*/10 * * * *",
  "session_target": "shell",
  "payload_message": "python3 /home/user/.openclaw/scripts/mcporter-qmd.py call qmd.deep_search --args '{"query":"memory","limit":1,"minScore":0,"collection":"memory-root-main"}' --timeout 30000 > /dev/null 2>&1 && echo 'QMD warm' || echo 'QMD cold'",
  "delivery_mode": "none"
}
```

> ⚠️ Do NOT use `qmd search` here — it runs BM25 only and never loads the neural models. Only `deep_search` (via the mcporter bridge) keeps models warm in GPU memory.

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
openclaw config set cron.enabled true
# remove OPENCLAW_SKIP_CRON=1 from gateway service env

# 3. Re-enable heartbeat
openclaw config set agents.defaults.heartbeat.every "5m"
openclaw gateway restart
```

For a complete removal (deleting all data), see [UNINSTALL.md](UNINSTALL.md).

---

## Validation Checklist

- [ ] `SCHEDULER_DB=:memory: node test.js` → 960/960
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
