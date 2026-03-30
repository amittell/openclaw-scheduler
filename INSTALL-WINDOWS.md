# Installing OpenClaw Scheduler on Windows

> **TL;DR:** Use WSL2. It's faster to set up, fully supported, and eliminates every Windows-specific limitation listed in this guide.
>
> **Need examples or migration help?** See [Starter Recipes in the README](README.md#starter-recipes) and [Common Migrations](README.md#common-migrations).

---

## Option A: WSL2 (Strongly Recommended)

If you're running OpenClaw in WSL2, follow the Linux guide: **[INSTALL-LINUX.md](INSTALL-LINUX.md)**

WSL2 gives you a full Linux environment with:
- **systemd support** — Ubuntu 22.04+ in WSL2 ships with systemd enabled by default
- Full bash/zsh shell job compatibility
- No path separator issues, no `.bat` script constraints
- Identical behavior to a native Linux install

To enable systemd in WSL2 (Ubuntu 22.04+), add to `/etc/wsl.conf`:
```ini
[boot]
systemd=true
```

Then restart WSL: `wsl --shutdown` from PowerShell, reopen your terminal.

---

## Option B: PM2 (Native Windows)

Use this path only if you can't use WSL2 — for example, if OpenClaw itself is running natively on Windows (not in WSL2).

> ⚠️ **Shell job limitations apply.** See [Shell Jobs on Windows](#shell-jobs-on-windows) below.

---

### Prerequisites

| Requirement | Install |
|-------------|---------|
| Node.js >= 20 | [nodejs.org](https://nodejs.org) -- use the LTS installer |
| pm2 | `npm install -g pm2` |
| OpenClaw gateway | Must be running with a valid auth token |
| Git for Windows | [git-scm.com](https://git-scm.com) or use GitHub Desktop |

**Build tools for `better-sqlite3`** (required — it compiles a native addon):

Option 1 — automated:
```powershell
npm install -g windows-build-tools
```

Option 2 — manual (more reliable on Windows 11):
1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — select the **"Desktop development with C++"** workload
2. Install [Python 3.x](https://python.org) — check "Add to PATH" during install

Verify:
```powershell
node -e "require('better-sqlite3')" && echo "OK"
```

---

### Step 1: Install Scheduler Files

```powershell
cd $env:USERPROFILE\.openclaw
git clone https://github.com/amittell/openclaw-scheduler.git scheduler
cd scheduler
```

Or npm-first install (no git clone):
```powershell
mkdir $env:USERPROFILE\.openclaw\scheduler -Force
npm install --prefix $env:USERPROFILE\.openclaw\scheduler openclaw-scheduler@latest
npm exec --prefix $env:USERPROFILE\.openclaw\scheduler openclaw-scheduler -- help
```

Runtime state for npm installs defaults to `$env:USERPROFILE\.openclaw\scheduler`, not the package directory under `node_modules`.

---

### Step 2: Install Dependencies

If you used the npm-first install path in Step 1, dependencies are already installed; skip to Step 3.

```powershell
npm install
```

If `better-sqlite3` fails with a build error, make sure Visual Studio Build Tools and Python are installed (see Prerequisites above), then:
```powershell
npm install --build-from-source
```

If Node changes later on this machine, rebuild the native binding before restarting the scheduler:
```powershell
cd $env:USERPROFILE\.openclaw\scheduler
npm rebuild better-sqlite3
```

---

### Step 3: Run Tests

```powershell
$env:SCHEDULER_DB=":memory:"; node test.js
```

All tests must pass before continuing.

---

### Step 4: Enable Chat Completions on Gateway

```powershell
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw gateway restart
```

Verify (PowerShell):
```powershell
$headers = @{ Authorization = "Bearer YOUR_GATEWAY_TOKEN"; "Content-Type" = "application/json" }
$body = '{"model":"openclaw:main","messages":[{"role":"user","content":"reply OK"}]}'
(Invoke-WebRequest -Uri http://127.0.0.1:18789/v1/chat/completions -Method POST -Headers $headers -Body $body).StatusCode
# Expected: 200
```

---

### Step 5: Migrate Jobs from OC Cron

```powershell
node migrate.js
```

Verify:
```powershell
node cli.js jobs list
node cli.js status
```

---

### Step 6: Disable OC Built-in Cron and Heartbeat

```powershell
openclaw cron list
# For each enabled job:
openclaw cron edit <job-id> --disable
openclaw config set cron.enabled false

openclaw config set agents.defaults.heartbeat.every "0m"
# If you have per-agent heartbeat overrides, set/remove those too:
# agents.list[].heartbeat.every = "0m"
openclaw gateway restart
```

Also set `OPENCLAW_SKIP_CRON=1` in your OpenClaw gateway process environment (service wrapper/PM2 ecosystem), then restart the gateway.

---

### Step 7: Start with PM2

```powershell
pm2 start dispatcher.js --name openclaw-scheduler `
  --env OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789 `
  --env OPENCLAW_GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN `
  --env SCHEDULER_TICK_MS=10000 `
  --env SCHEDULER_STALE_THRESHOLD_S=90

# Optional verbose logging:
pm2 restart openclaw-scheduler --update-env --env SCHEDULER_DEBUG=1

# Save PM2 process list (persists across restarts)
pm2 save

# Generate and apply startup hook (run the printed command as Administrator)
pm2 startup
```

Verify:
```powershell
pm2 status
pm2 logs openclaw-scheduler --lines 20
```

---

### Step 8: Smoke Test

> **Note:** These smoke test commands use direct file imports and are for the git-clone install path. For npm installs, use `openclaw-scheduler` CLI commands instead.

```powershell
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
Start-Sleep 20; pm2 logs openclaw-scheduler --lines 20
```

Look for: `Dispatching: Smoke Test` → `Completed: Smoke Test`

---

## PM2 Management

```powershell
# Status
pm2 status

# Logs (live)
pm2 logs openclaw-scheduler

# Restart
pm2 restart openclaw-scheduler

# Stop
pm2 stop openclaw-scheduler

# Remove from PM2
pm2 delete openclaw-scheduler
```

---

## Shell Jobs on Windows

Shell jobs (`session_target: 'shell'`) use **`cmd.exe`** by default on Windows. Override with:

```
SCHEDULER_SHELL=powershell.exe
```

Set this in your PM2 launch command:
```powershell
pm2 start dispatcher.js --name openclaw-scheduler `
  --env SCHEDULER_SHELL=powershell.exe `
  ...
```

### Known Limitations (native Windows)

| Limitation | Impact | Fix |
|------------|--------|-----|
| Shell is `cmd.exe` by default | Bash scripts won't work | Use `.bat`/`.cmd` or set `SCHEDULER_SHELL=powershell.exe` |
| No `/bin/bash` or `/bin/zsh` | Can't use Unix shell syntax | Rewrite scripts as PowerShell |
| Path separators | `\` vs `/` in commands | Use `\\` in `payload_message` strings |
| Line endings | `.sh` scripts may fail | Save scripts with LF line endings |

**WSL2 eliminates all of these.** If you hit these issues in practice, switching to WSL2 will be faster than working around them.

---

## Optional: QMD Memory Daemon

If your OpenClaw instance uses QMD for hybrid memory search:

- **WSL2:** Follow the QMD daemon section in [INSTALL-LINUX.md](INSTALL-LINUX.md) — systemd works identically inside WSL2.
- **Native Windows (PM2):** Not supported. QMD daemon requires a POSIX shell and Metal/CUDA GPU drivers. Run QMD inside WSL2 even if the rest of OpenClaw is native.

Three rules apply on all platforms — see [BEST-PRACTICES.md](BEST-PRACTICES.md) → "Shell Daemon Keepalive Jobs":
1. Wrapper script must block on the daemon PID — never exit after setup
2. Keepalive job must call `deep_search` (not BM25 `qmd search`) to actually warm GPU models
3. Session files must not live in `/tmp` — use `XDG_CACHE_HOME` for persistence across reboots

---

## Rollback

```powershell
# Stop and remove PM2 process
pm2 stop openclaw-scheduler
pm2 delete openclaw-scheduler

# Re-enable OC cron
openclaw cron edit <job-id> --enable  # for each job
openclaw config set cron.enabled true
# remove OPENCLAW_SKIP_CRON=1 from gateway process env

# Re-enable heartbeat
openclaw config set agents.defaults.heartbeat.every "5m"
openclaw gateway restart
```

For a complete removal (deleting all data), see [UNINSTALL.md](UNINSTALL.md).

---

## Upgrading

Already have the scheduler installed and need to update to a newer version? See [UPGRADING.md](UPGRADING.md).

---

## Validation Checklist

- [ ] `$env:SCHEDULER_DB=":memory:"; node test.js` -- all passing, 0 failed
- [ ] `node cli.js status` → shows jobs, 0 stale
- [ ] `pm2 status` → openclaw-scheduler is `online`
- [ ] PM2 log has startup lines, no errors
- [ ] OC cron → all disabled
- [ ] OC heartbeat → `0m`
- [ ] Chat completions → 200
- [ ] Smoke test → dispatched + completed in log
- [ ] First real job → fires on schedule
