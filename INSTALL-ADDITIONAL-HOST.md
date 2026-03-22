# Installing OpenClaw Scheduler on an Additional Host

This guide is for setting up the scheduler on a **second or additional OpenClaw instance**. Each host runs its own independent SQLite database and its own LaunchAgent — they don't share state. This is not a replication setup; each host schedules and dispatches jobs independently.

> **Starting fresh:** Unlike migrating from OC cron, on an additional host you'll typically create jobs from scratch. Use the job examples in README.md.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| macOS or Linux | Tested on macOS arm64 |
| Node.js >= 20 | `node --version` (use full path if needed: `/opt/homebrew/bin/node --version`) |
| OpenClaw gateway running | With auth token |
| Git or SCP access | To clone/copy the repo |

> **macOS PATH note:** If installed via Homebrew, `node` and `npm` live at `/opt/homebrew/bin/`. If your terminal doesn't find them, run `export PATH="/opt/homebrew/bin:$PATH"` or add it to your `~/.zprofile`. The LaunchAgent template already includes the correct PATH.

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

## Step 2: Install Dependencies

If you used the npm-first install path in Step 1, dependencies are already installed; skip to Step 3.

```bash
cd ~/.openclaw/scheduler
npm install
```

Installs `better-sqlite3` (native, compiles for your arch) and `croner`.

If `better-sqlite3` fails: `xcode-select --install` (macOS).

---

## Step 3: Run Tests

```bash
SCHEDULER_DB=:memory: node test.js
```

**All tests must pass before proceeding.**

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

## Step 5: Disable OC Built-in Cron

If this host had OC built-in cron jobs enabled, disable them so they don't conflict with the scheduler.

```bash
openclaw cron list
# For each enabled job:
openclaw cron edit <job-id> --disable
openclaw config set cron.enabled false
```

Also set `OPENCLAW_SKIP_CRON=1` in your OpenClaw gateway service environment (launchctl/systemd/pm2), then restart the gateway.

Verify: `openclaw cron list` shows no enabled jobs (or "No cron jobs").

---

## Step 6: Disable OC Heartbeat

If this host had OC heartbeat enabled, disable it:

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
# If you have per-agent heartbeat overrides, set/remove those too:
# agents.list[].heartbeat.every = "0m"
openclaw gateway restart
```

---

## Step 7: Install LaunchAgent

```bash
mkdir -p ~/Library/LaunchAgents
nano ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

Create or edit the plist — replace `YOUR_USER` and `YOUR_GATEWAY_TOKEN`:

The template looks like:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.scheduler</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>--no-warnings</string>
        <string>/Users/YOUR_USER/.openclaw/scheduler/dispatcher.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCLAW_GATEWAY_URL</key>
        <string>http://127.0.0.1:18789</string>
        <key>OPENCLAW_GATEWAY_TOKEN</key>
        <string>YOUR_GATEWAY_TOKEN</string>
        <key>SCHEDULER_TICK_MS</key>
        <string>10000</string>
        <key>SCHEDULER_STALE_THRESHOLD_S</key>
        <string>90</string>
        <key>SCHEDULER_DEBUG</key>
        <string>1</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openclaw-scheduler.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-scheduler.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/.openclaw/scheduler</string>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

Verify:
```bash
launchctl list | grep scheduler
sleep 5 && tail -5 /tmp/openclaw-scheduler.log
```

---

## Step 8: Smoke Tests

> **Note:** These smoke test commands use direct file imports and are for the git-clone install path. For npm installs, use `openclaw-scheduler` CLI commands instead.

### Isolated dispatch
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

## Step 9: Create Your Jobs

Since this is a fresh host, create jobs from scratch using the CLI:

```bash
node cli.js jobs add '{
  "name": "My First Job",
  "schedule_cron": "0 * * * *",
  "payload_message": "Run your task here",
  "delivery_mode": "announce",
  "delivery_channel": "telegram",
  "delivery_to": "YOUR_TELEGRAM_ID"
}'
node cli.js jobs list
node cli.js status
```

See README.md for full job examples including shell jobs, workflow chains, approval gates, and more.

---

## Step 10: Verify First Real Job

Wait for the next scheduled job and confirm:
```bash
tail -f /tmp/openclaw-scheduler.log
# Or after it fires:
node cli.js runs list <job-id>
```

---

## Rollback

If anything goes wrong:

```bash
# 1. Stop scheduler
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist

# 2. Re-enable OC cron (if you disabled it)
openclaw cron edit <job-id> --enable  # for each job
openclaw config set cron.enabled true
# remove OPENCLAW_SKIP_CRON=1 from gateway service env

# 3. Re-enable heartbeat (if you disabled it)
openclaw config set agents.defaults.heartbeat.every "5m"
openclaw gateway restart
```

---

## Validation Checklist

- [ ] `SCHEDULER_DB=:memory: node test.js` -- all passing, 0 failed
- [ ] `node cli.js status` → shows jobs, 0 stale
- [ ] `launchctl list | grep scheduler` → running
- [ ] Log file has startup lines, no errors
- [ ] OC cron → all disabled (if applicable)
- [ ] OC heartbeat → `0m` (if applicable)
- [ ] Chat completions → 200
- [ ] Smoke test → dispatched + completed in log
- [ ] Telegram test → message received
- [ ] First real job → fires on schedule
