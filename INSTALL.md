# Installing OpenClaw Scheduler on a New Host

Step-by-step guide to deploy the scheduler on another OpenClaw instance (e.g., `scheduler-host.local`).

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| macOS or Linux | Tested on macOS arm64 |
| Node.js ≥ 22 | `node --version` |
| OpenClaw gateway running | With auth token |
| Git or SCP access | To clone/copy the repo |

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

## Step 2: Install Dependencies

```bash
cd ~/.openclaw/scheduler
npm install
```

Installs `better-sqlite3` (native, compiles for your arch) and `croner`.

If `better-sqlite3` fails: `xcode-select --install` (macOS).

On Linux, install build deps first:
```bash
sudo apt install build-essential python3   # Ubuntu/Debian
sudo dnf install gcc gcc-c++ make python3   # Fedora/RHEL
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

Or disable all programmatically — see the [README](README.md) for API-based approach.

Verify: `openclaw cron list` shows no enabled jobs (or "No cron jobs").

---

## Step 7: Disable OC Heartbeat

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw gateway restart
```

---

## Step 8: Install LaunchAgent

Create `~/Library/LaunchAgents/ai.openclaw.scheduler.plist`:

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

**Replace** `YOUR_USER` and `YOUR_GATEWAY_TOKEN` with actual values.

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

## Step 9: Smoke Tests

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
- [ ] `launchctl list | grep scheduler` → running
- [ ] Log file has startup lines, no errors
- [ ] OC cron → all disabled
- [ ] OC heartbeat → `0m`
- [ ] Chat completions → 200
- [ ] Smoke test → dispatched + completed in log
- [ ] Telegram test → message received
- [ ] First real job → fires on schedule
