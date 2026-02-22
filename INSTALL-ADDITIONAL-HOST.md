# Installing OpenClaw Scheduler v2 on Scheduler host (scheduler-host.local)

Complete step-by-step guide to deploy the scheduler on Scheduler host's OpenClaw instance.

---

## Prerequisites

| Requirement | Scheduler host Status |
|-------------|-------------------|
| macOS (arm64) | ✅ Mac Mini, arm64 |
| Node.js | ✅ v25.6.1 at `/opt/homebrew/bin/node` |
| OpenClaw gateway running | ✅ Port 18789, LaunchAgent |
| Gateway auth token | ✅ `YOUR_GATEWAY_TOKEN` |
| SSH access | ✅ `ssh user@example.com` |
| Git | Required (check: `git --version`) |

---

## Step 1: Clone the Repository

```bash
ssh user@example.com
cd ~/.openclaw
git clone https://github.com/amittell/openclaw-scheduler.git scheduler
cd scheduler
```

If the repo is private, you'll need GitHub auth configured. If `gh` CLI is available:
```bash
gh auth login
gh repo clone amittell/openclaw-scheduler scheduler
```

Alternatively, copy from rh-bot:
```bash
# From scheduler-host.local:
scp -r ~/.openclaw/scheduler user@example.com:~/.openclaw/scheduler
```

---

## Step 2: Install Dependencies

```bash
cd ~/.openclaw/scheduler
source ~/.zprofile   # ensures node is in PATH
npm install
```

This installs:
- `better-sqlite3` (native SQLite driver — will compile for arm64)
- `croner` (cron expression parser)

**If `better-sqlite3` fails to compile:** Install build tools:
```bash
xcode-select --install
```

Verify:
```bash
node -e "import Database from 'better-sqlite3'; console.log('SQLite OK')"
```

---

## Step 3: Run Tests

```bash
cd ~/.openclaw/scheduler
node test.js
```

Expected output: `Results: 47 passed, 0 failed`

If any tests fail, do NOT proceed. Fix the issue first.

---

## Step 4: Enable Chat Completions on Gateway

The scheduler dispatches isolated jobs via the OpenAI-compatible chat completions endpoint. This must be enabled in Scheduler host's gateway config.

### Option A: Via OpenClaw CLI
```bash
source ~/.zprofile
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw gateway restart
```

### Option B: Edit config manually
Edit `~/.openclaw/openclaw.json` and add under the `gateway` key:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

Then restart:
```bash
source ~/.zprofile && openclaw gateway restart
```

### Verify
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

## Step 5: Initialize Database and Migrate Jobs

### Initialize the database
```bash
cd ~/.openclaw/scheduler
node migrate.js
```

This will:
1. Create `scheduler.db` with the v2 schema (jobs, runs, messages, agents tables)
2. Import all jobs from `~/.openclaw/cron/jobs.json`
3. Convert schedule formats:
   - `cron` → direct cron expression
   - `every` → approximate cron (e.g., 1800000ms → `*/30 * * * *`)
   - `at` → one-shot cron with `delete_after_run=true`

### Expected output for Scheduler host

```
Found 27 job(s) in /Users/YOUR_USER/.openclaw/cron/jobs.json
  OK: Smart Email Monitor → cron="0 7-22/2 * * *"
  OK: pending-acks-check → cron="*/30 * * * *"
  OK: Line Capture (4x daily) → cron="0 8,12,16,20 * * *"
  OK: Morning NCAAB/NBA Edge Scan → cron="0 9 * * *"
  OK: Weekly Power Ratings Refresh → cron="0 8 * * 1"
  OK: A2P Campaign Status Check → cron="0 */2 * * *"
  OK: Hourly Workspace Backup → cron="0 8-23 * * *"
  OK: Daily Workspace Audit → cron="0 6 * * *"
  OK: Divorce KB Daily Update → cron="0 6 * * *"
  OK: Early Lines Detection (6 AM) → cron="0 6 * * *"
  OK: Clean Gmail Spam → cron="0 8,20 * * *"
  OK: Memory Compression → cron="0 3 * * *"
  OK: lurker-purge-daily → cron="0 12 * * *"
  OK: telegram-inactive-cleaner → cron="0 9 * * *"
  ... (disabled/one-shot jobs also imported)
```

### Verify
```bash
node cli.js jobs list
node cli.js status
```

---

## Step 6: Disable OpenClaw Built-in Cron Jobs

The scheduler now owns all scheduling. Disable OC's copies to prevent double-firing.

### Disable all enabled jobs via CLI
```bash
source ~/.zprofile

# List current OC cron jobs
openclaw cron list

# Disable each enabled job (get IDs from the list above)
openclaw cron edit <job-id> --disable
```

### Or disable via API (scriptable)
```bash
# Get all job IDs
JOB_IDS=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{"tool":"cron","args":{"action":"list"},"sessionKey":"main"}' \
  http://127.0.0.1:18789/tools/invoke | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
jobs = d.get('result',{}).get('details',{}).get('jobs',[])
for j in jobs:
    if j['enabled']:
        print(j['id'])
")

# Disable each
for ID in $JOB_IDS; do
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
    -d "{\"tool\":\"cron\",\"args\":{\"action\":\"update\",\"jobId\":\"$ID\",\"patch\":{\"enabled\":false}},\"sessionKey\":\"main\"}" \
    http://127.0.0.1:18789/tools/invoke | python3 -c "import json,sys; print('Disabled:', json.load(sys.stdin).get('ok'))"
done
```

### Verify all disabled
```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -d '{"tool":"cron","args":{"action":"list","includeDisabled":true},"sessionKey":"main"}' \
  http://127.0.0.1:18789/tools/invoke | python3 -c "
import json, sys
jobs = json.load(sys.stdin).get('result',{}).get('details',{}).get('jobs',[])
enabled = [j['name'] for j in jobs if j['enabled']]
print('Still enabled:', enabled if enabled else 'NONE (good)')
"
```

---

## Step 7: Disable OpenClaw Heartbeat

The scheduler replaces the heartbeat. Set interval to 0:

### Option A: Via CLI
```bash
source ~/.zprofile
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw gateway restart
```

### Option B: Edit config
In `~/.openclaw/openclaw.json`, change:
```json
"heartbeat": {
  "every": "0m",
  ...
}
```

Then restart the gateway.

### Verify
```bash
python3 -c "
import json, os
c = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))
print('Heartbeat every:', c.get('agents',{}).get('defaults',{}).get('heartbeat',{}).get('every','NOT SET'))
"
```

Expected: `Heartbeat every: 0m`

---

## Step 8: Configure the LaunchAgent

### Create the plist

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

**Important:** The token in this file is Scheduler host's gateway token, NOT source host's.

### Load the service
```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

### Verify
```bash
# Check process
launchctl list | grep scheduler
ps aux | grep dispatcher | grep -v grep

# Check logs (should show startup + no errors)
sleep 5
cat /tmp/openclaw-scheduler.log
```

Expected log output:
```
2026-XX-XX [scheduler] [info] Starting OpenClaw Scheduler v2 (standalone) {"tickMs":10000,...}
2026-XX-XX [scheduler] [info] Database initialized
2026-XX-XX [scheduler] [info] Pruned old runs + messages
```

---

## Step 9: Run Smoke Test

### Test isolated dispatch
```bash
cd ~/.openclaw/scheduler
node -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const db = getDb();
const job = createJob({
  name: 'Smoke Test',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'Reply with exactly: KEBABLEBOT_SCHEDULER_OK',
  session_target: 'isolated',
  payload_timeout_seconds: 60,
  delivery_mode: 'none',
  delete_after_run: true,
});
db.prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Smoke test job created:', job.id);
"
```

Wait 20 seconds, then check:
```bash
sleep 20
tail -10 /tmp/openclaw-scheduler.log
```

Expected: You should see `Dispatching: Smoke Test` followed by `Completed: Smoke Test`.

### Test Telegram delivery
```bash
node -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const db = getDb();
const job = createJob({
  name: 'Telegram Test',
  schedule_cron: '0 0 31 2 *',
  payload_message: 'You are Scheduler host running via the standalone scheduler v2. Send a brief confirmation message.',
  session_target: 'isolated',
  payload_timeout_seconds: 60,
  delivery_mode: 'announce',
  delivery_channel: 'telegram',
  delivery_to: '1000000001',
  delete_after_run: true,
});
db.prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Telegram test job created:', job.id);
"
```

Wait 30 seconds — you should receive a Telegram message from Scheduler host.

### Test main session dispatch
```bash
node -e "
import { initDb, getDb } from './db.js';
import { createJob } from './jobs.js';
initDb();
const db = getDb();
const job = createJob({
  name: 'Main Session Test',
  schedule_cron: '0 0 31 2 *',
  payload_kind: 'systemEvent',
  payload_message: 'Scheduler main session test — system event received.',
  session_target: 'main',
  delivery_mode: 'none',
  delete_after_run: true,
});
db.prepare(\"UPDATE jobs SET next_run_at = datetime('now', '-1 second') WHERE id = ?\").run(job.id);
console.log('Main session test created');
"
```

### Verify overall status
```bash
node cli.js status
```

Expected:
```
=== OpenClaw Scheduler Status ===
Jobs:     N total, N enabled
Running:  0
Stale:    0
Agents:   1
  main: idle

Next:     <next job name> at <time>
```

---

## Step 10: Review and Tune Migrated Jobs

After migration, review the imported jobs. Some may need adjustment:

### Check all jobs
```bash
node cli.js jobs list
```

### Disable jobs you don't want
Some of Scheduler host's one-shot (`at`) jobs are already expired. Disable or delete them:
```bash
# Disable
node cli.js jobs disable <job-id>

# Or delete
node cli.js jobs delete <job-id>
```

### Adjust timeouts
Default is 5 minutes (300000ms). For jobs that need longer:
```bash
node cli.js jobs update <job-id> '{"run_timeout_ms":600000}'
```

### Adjust `every` schedule conversions
The migration converts `everyMs` to approximate cron:
- `1800000ms` (30min) → `*/30 * * * *`
- `7200000ms` (2hr) → `0 */2 * * *`
- `600000ms` (10min) → `*/10 * * * *`

Verify these are correct for each job.

---

## Step 11: Verify First Real Job Fires

Wait for the next scheduled job to fire naturally. Check:
```bash
# Watch the log
tail -f /tmp/openclaw-scheduler.log

# Or check runs
node cli.js runs running    # during execution
node cli.js runs list <job-id>  # after completion
```

---

## Rollback Procedure

If something goes wrong:

### 1. Stop the scheduler
```bash
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

### 2. Re-enable OC cron jobs
```bash
source ~/.zprofile
# For each job:
openclaw cron edit <job-id> --enable
```

### 3. Re-enable heartbeat
Edit `~/.openclaw/openclaw.json`:
```json
"heartbeat": { "every": "5m", ... }
```
```bash
source ~/.zprofile && openclaw gateway restart
```

### 4. (Optional) Disable chat completions
```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled false
openclaw gateway restart
```

---

## Ongoing Maintenance

### View logs
```bash
tail -f /tmp/openclaw-scheduler.log
```

### Check status
```bash
cd ~/.openclaw/scheduler && node cli.js status
```

### Add a new job
```bash
node cli.js jobs add '{"name":"My New Job","schedule_cron":"0 */4 * * *","payload_message":"Do something every 4 hours","delivery_mode":"none"}'
```

### Update the scheduler code
```bash
cd ~/.openclaw/scheduler
git pull
npm install  # if dependencies changed

# Restart service
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

---

## Differences from source host's Instance

| Aspect | source-host (scheduler-host.local) | Scheduler host (scheduler-host.local) |
|--------|----------------------|--------------------------|
| Jobs | 3 (status, backup, audit) | 27 (email, betting, backup, audit, purge, etc.) |
| Gateway token | `YOUR_GATEWAY_TOKEN` | `YOUR_GATEWAY_TOKEN` |
| Node.js | v22.22.0 | v25.6.1 |
| Gateway port | 18789 | 18789 |
| Heartbeat (before) | 5m, mini-beast model | 5m, mini-beast model, active hours 7-23 |

---

## Quick Validation Checklist

After completing all steps, verify:

- [ ] `node test.js` → 47/47 passed
- [ ] `node cli.js status` → shows jobs, 0 running, 0 stale
- [ ] `launchctl list | grep scheduler` → loaded with PID
- [ ] `/tmp/openclaw-scheduler.log` → startup lines, no errors
- [ ] OC cron jobs → all disabled
- [ ] OC heartbeat → `every: "0m"`
- [ ] Chat completions → `curl` returns 200
- [ ] Smoke test → dispatched and completed in log
- [ ] Telegram test → message received
- [ ] First real job → fires at scheduled time
