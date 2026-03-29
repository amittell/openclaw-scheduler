# Installing OpenClaw Scheduler on macOS

Step-by-step guide to deploy the scheduler on a macOS OpenClaw instance.

If you just want the fastest path to a working local install, start with the npm-first flow and [Five-Minute Setup in the README](README.md#five-minute-setup). This document is the full host deployment guide.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| macOS or Linux | Tested on macOS arm64 |
| Node.js >= 20 | `node --version` |
| OpenClaw gateway running | With auth token |
| Git or SCP access | To clone/copy the repo |

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

If Node changes later under this checkout, rebuild the native module before restarting the scheduler:

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3
```

Typical cases:
- `brew upgrade node` on macOS
- switching major Node versions with `nvm`, `fnm`, or `asdf`
- distro package upgrades that replace the Node binary

On Linux, install build deps first:
```bash
sudo apt install build-essential python3   # Ubuntu/Debian
sudo dnf install gcc gcc-c++ make python3   # Fedora/RHEL
```

---

## Step 2.5: Fix macOS shell PATH and completions

If you use `zsh` on macOS, make sure Homebrew is available to non-interactive shells too.

This matters for commands like:
- `ssh host 'node cli.js status'`
- remote admin scripts
- one-off maintenance commands that do not run inside an interactive terminal

`~/.zprofile` is not enough for that case. Put the minimal PATH bootstrap in `~/.zshenv`:

```zsh
# ~/.zshenv — sourced by all zsh instances, including non-interactive SSH commands
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

If you load OpenClaw completions in `~/.zshrc`, run `compinit` before sourcing them:

```zsh
autoload -Uz compinit
compinit

if [ -f "$HOME/.openclaw/completions/openclaw.zsh" ]; then
  source "$HOME/.openclaw/completions/openclaw.zsh"
fi
```

Avoid version-pinned Node PATH entries like `/opt/homebrew/opt/node@22/bin`. Use `/opt/homebrew/bin/node` instead so normal `brew upgrade node` keeps working.

Verify:

```bash
ssh "$HOST" 'command -v node && node -v'
```

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

## Step 5: Migrate Jobs from OC Cron

```bash
cd ~/.openclaw/scheduler
node migrate.js
```

This imports jobs from `~/.openclaw/cron/jobs.json` → SQLite, converting schedule formats:
- `cron` → direct expression
- `every` → approximate cron (e.g., 30min → `*/30 * * * *`)
- `at` → one-shot with `delete_after_run=true`

Good default approach:
- if the old job was just a script, keep it as a `shell` job
- if the old job was really “run a prompt on a schedule,” rewrite it as an `isolated` job
- if two jobs depended on manual ordering, convert them into a parent/child chain instead of two independent schedules

For copy-paste examples, see [Starter Recipes in the README](README.md#starter-recipes) and [Common Migrations](README.md#common-migrations).

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

Also set `OPENCLAW_SKIP_CRON=1` in your OpenClaw gateway service environment (launchctl/systemd/pm2), then restart the gateway.

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

## Step 8: Choose a macOS launchd mode

OpenClaw Scheduler supports both common macOS service styles:

- **LaunchAgent**: best for a personal Mac that auto-logs in and should run the scheduler inside your user session
- **LaunchDaemon**: best for a headless Mac or for starting before login

The simplest path is to let the setup wizard install the launchd plist for you:

```bash
cd ~/.openclaw/scheduler
node setup.mjs --service-mode agent
# or:
node setup.mjs --service-mode daemon
```

If you installed from npm:

```bash
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup --service-mode agent
# or:
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup --service-mode daemon
```

What each mode does:

- `agent` writes `~/Library/LaunchAgents/ai.openclaw.scheduler.plist` and bootstraps `gui/$UID/ai.openclaw.scheduler`
- `daemon` writes `/Library/LaunchDaemons/ai.openclaw.scheduler.plist` and bootstraps `system/ai.openclaw.scheduler`

Verify the mode you chose:

```bash
# LaunchAgent
launchctl print gui/$UID/ai.openclaw.scheduler

# LaunchDaemon
sudo launchctl print system/ai.openclaw.scheduler

# Either mode
sleep 5 && tail -5 /tmp/openclaw-scheduler.log
```

---

## Step 9: Smoke Tests

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
  origin: 'system',
  run_timeout_ms: 300000,
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
  origin: 'system',
  run_timeout_ms: 300000,
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
launchctl bootout gui/$UID/ai.openclaw.scheduler     # if using LaunchAgent
sudo launchctl bootout system/ai.openclaw.scheduler  # if using LaunchDaemon

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

## Upgrading

Already have the scheduler installed and need to update to a newer version? See [UPGRADING.md](UPGRADING.md).

---

## Validation Checklist

- [ ] `SCHEDULER_DB=:memory: node test.js` -- all passing, 0 failed
- [ ] `node cli.js status` → shows jobs, 0 stale
- [ ] `launchctl print gui/$UID/ai.openclaw.scheduler` or `sudo launchctl print system/ai.openclaw.scheduler` → running
- [ ] Log file has startup lines, no errors
- [ ] OC cron → all disabled
- [ ] OC heartbeat → `0m`
- [ ] Chat completions → 200
- [ ] Smoke test → dispatched + completed in log
- [ ] Telegram test → message received
- [ ] First real job → fires on schedule
