# Upgrading OpenClaw Scheduler

How to update an existing OpenClaw Scheduler installation to the latest version.

This guide covers both git-clone and npm-based installs. Each host is independent -- upgrade them one at a time and verify before moving on.

---

## Quick Reference

### macOS (launchd, git-clone install)

```bash
cd ~/.openclaw/scheduler
git pull
npm install
SCHEDULER_DB=:memory: node test.js
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
sleep 3 && tail -5 /tmp/openclaw-scheduler.log
node cli.js status
```

### Linux / Windows WSL2 (systemd, git-clone install)

```bash
cd ~/.openclaw/scheduler
git pull
npm install
SCHEDULER_DB=:memory: node test.js
systemctl --user restart openclaw-scheduler
sleep 3 && systemctl --user --no-pager --full status openclaw-scheduler
node cli.js status
```

### Windows native (PM2, git-clone install)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
git pull
npm install
$env:SCHEDULER_DB=":memory:"; node test.js
pm2 restart openclaw-scheduler
Start-Sleep 3
pm2 logs openclaw-scheduler --lines 5 --nostream
node cli.js status
```

That is the whole process for a routine update. The rest of this document explains each step, covers edge cases, and documents both git-clone and npm install paths.

---

## Before You Start

1. **Check the [CHANGELOG](CHANGELOG.md)** for breaking changes or new schema migrations.
2. **Check current version:**
   ```bash
   cd ~/.openclaw/scheduler
   node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)"
   # or for npm installs:
   npm ls --prefix ~/.openclaw/scheduler openclaw-scheduler
   ```
3. **Check current schema version:**
   ```bash
   node -e "const db=require('better-sqlite3')('scheduler.db');console.log(db.prepare('SELECT MAX(version) as v FROM schema_migrations').get());db.close()"
   ```

---

## Step 1: Pull or Install the Update

### Git-clone installs

#### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
git pull
```

#### Windows native (PowerShell)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
git pull
```

If you have local modifications, stash them first:
```bash
git stash
git pull
git stash pop
```

### npm installs

#### macOS / Linux / Windows WSL2

```bash
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
```

#### Windows native (PowerShell)

```powershell
npm install --prefix $env:USERPROFILE\.openclaw\scheduler openclaw-scheduler@latest
```

---

## Step 2: Install Dependencies

### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
npm install
```

### Windows native (PowerShell)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
npm install
```

If you upgraded Node.js since the last install, also rebuild the native module:

```bash
npm rebuild better-sqlite3
```

Common triggers for needing a rebuild:
- `brew upgrade node` on macOS
- Switching Node major versions with `nvm`, `fnm`, or `asdf`
- Distro package upgrades that replace the Node binary

---

## Step 3: Run Tests

### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
SCHEDULER_DB=:memory: node test.js
```

### Windows native (PowerShell)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
$env:SCHEDULER_DB=":memory:"; node test.js
```

All tests must pass before restarting the service. If tests fail, do not restart -- investigate the failure first and check the CHANGELOG for any required manual steps.

---

## Step 4: Run Migrations (if needed)

The dispatcher runs pending schema migrations automatically on startup. You do not normally need to run them manually.

If the CHANGELOG mentions a schema migration, you can apply it ahead of the restart:

### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
node migrate.js
```

To verify the schema version after migration:

```bash
cd ~/.openclaw/scheduler
node -e "const db=require('better-sqlite3')('scheduler.db');console.log(db.prepare('SELECT MAX(version) as v FROM schema_migrations').get());db.close()"
```

### Windows native (PowerShell)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
node migrate.js
node -e "const db=require('better-sqlite3')('scheduler.db');console.log(db.prepare('SELECT MAX(version) as v FROM schema_migrations').get());db.close()"
```

---

## Step 5: Restart the Service

### macOS (launchd)

```bash
# LaunchAgent (most common)
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler

# LaunchDaemon (headless hosts)
sudo launchctl kickstart -k system/ai.openclaw.scheduler
```

### Linux (systemd)

```bash
systemctl --user restart openclaw-scheduler
# or if running as a system service:
sudo systemctl restart openclaw-scheduler
```

### Windows WSL2 (systemd inside WSL)

```bash
systemctl --user restart openclaw-scheduler
```

### Windows native (PM2)

```powershell
pm2 restart openclaw-scheduler
```

---

## Step 6: Verify

### macOS (launchd)

```bash
launchctl list | grep ai.openclaw.scheduler
tail -10 /tmp/openclaw-scheduler.log
cd ~/.openclaw/scheduler && node cli.js status
```

### Linux / Windows WSL2 (systemd)

```bash
systemctl --user --no-pager --full status openclaw-scheduler
journalctl --user -u openclaw-scheduler -n 20 --no-pager
cd ~/.openclaw/scheduler && node cli.js status
```

### Windows native (PM2)

```powershell
pm2 status
pm2 logs openclaw-scheduler --lines 20 --nostream
cd $env:USERPROFILE\.openclaw\scheduler
node cli.js status
```

A healthy startup log looks like:

```
[scheduler] [info] Starting OpenClaw Scheduler v0.2.0 {"tickMs":10000,...}
[scheduler] [info] Database initialized
[scheduler] [info] Pruned old runs + messages
```

If you see `Gateway unreachable`, isolated agent jobs will be deferred until the gateway is back. Shell jobs and main-session jobs continue unaffected.

---

## Upgrading Multiple Hosts

Each host has its own independent SQLite database and service. Upgrade hosts one at a time:

1. Upgrade the first host following the steps above.
2. Verify it is healthy (`node cli.js status`, check logs).
3. Move on to the next host.

There is no required upgrade order. Hosts do not share state and can run different versions temporarily. However, keeping all hosts on the same version avoids confusion.

### Remote upgrade examples

#### macOS host over SSH

```bash
HOST=alexm@your-mac-host.lan

ssh $HOST "cd ~/.openclaw/scheduler && git pull && npm install"
ssh $HOST "cd ~/.openclaw/scheduler && SCHEDULER_DB=:memory: node test.js" 2>&1 | tail -5
ssh $HOST "launchctl kickstart -k gui/\$(id -u)/ai.openclaw.scheduler"
sleep 3
ssh $HOST "tail -5 /tmp/openclaw-scheduler.log && cd ~/.openclaw/scheduler && node cli.js status"
```

#### Linux / Windows WSL2 host over SSH

```bash
HOST=alexm@your-linux-host.lan

ssh $HOST "cd ~/.openclaw/scheduler && git pull && npm install"
ssh $HOST "cd ~/.openclaw/scheduler && SCHEDULER_DB=:memory: node test.js" 2>&1 | tail -5
ssh $HOST "systemctl --user restart openclaw-scheduler"
sleep 3
ssh $HOST "systemctl --user --no-pager --full status openclaw-scheduler && cd ~/.openclaw/scheduler && node cli.js status"
```

#### Windows native host via PowerShell Remoting

```powershell
$HOST = "your-windows-host"

Invoke-Command -ComputerName $HOST -ScriptBlock {
  cd $env:USERPROFILE\.openclaw\scheduler
  git pull
  npm install
  $env:SCHEDULER_DB=":memory:"
  node test.js
  pm2 restart openclaw-scheduler
  Start-Sleep 3
  pm2 logs openclaw-scheduler --lines 5 --nostream
  node cli.js status
}
```

---

## Rollback

If the new version causes problems:

### Git-clone installs

#### macOS (launchd)

```bash
cd ~/.openclaw/scheduler
git log --oneline -5          # find the previous good commit
git checkout <commit-hash>    # revert to it
npm install                   # restore matching dependencies
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
```

#### Linux / Windows WSL2 (systemd)

```bash
cd ~/.openclaw/scheduler
git log --oneline -5
git checkout <commit-hash>
npm install
systemctl --user restart openclaw-scheduler
```

#### Windows native (PM2)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
git log --oneline -5
git checkout <commit-hash>
npm install
pm2 restart openclaw-scheduler
```

### npm installs

#### macOS (launchd)

```bash
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@<previous-version>
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
```

#### Linux / Windows WSL2 (systemd)

```bash
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@<previous-version>
systemctl --user restart openclaw-scheduler
```

#### Windows native (PM2)

```powershell
npm install --prefix $env:USERPROFILE\.openclaw\scheduler openclaw-scheduler@<previous-version>
pm2 restart openclaw-scheduler
```

**Schema rollback:** Downgrading the code does not undo schema migrations. New columns added by migrations are ignored by older code -- they use `DEFAULT` values and do not cause errors. If a migration added a new table, older code simply does not reference it. In practice, schema changes are forward-compatible and do not require manual rollback.

---

## Provider plugins (v0.2)

If you use provider-backed identity, authorization, or proof verification, set
`SCHEDULER_PROVIDER_PATH` to a directory containing your provider `*.js` files.
This is a high-trust boundary: every file in that directory is dynamically imported
at scheduler startup. The directory must not be world-writable. See
`docs/gateway-contract.md` for the full provider plugin contract.

### Adopting jobs under agentcli

If you install agentcli after upgrading, you can adopt existing scheduler jobs
into declarative manifests. See [AGENTS.md](AGENTS.md#adding-agentcli-later-adopting-existing-jobs)
for the adoption flow and [README.md](README.md#adopting-existing-scheduler-jobs)
for detailed examples.

---

## Troubleshooting

### Tests fail after update

- Check the CHANGELOG for breaking changes or new prerequisites.
- Make sure `npm install` completed without errors.
- If `better-sqlite3` fails to load, run `npm rebuild better-sqlite3`.

### Service won't start after update

- Check the error log: `tail -20 /tmp/openclaw-scheduler.log`
- If the error is a missing module, run `npm install` again.
- If the error is a database issue, check the schema version matches what the new code expects.

### Gateway unreachable after update

The scheduler update does not affect the OpenClaw gateway. If the gateway is down, that is a separate issue. The scheduler logs `Gateway unreachable` on startup but continues running shell and main-session jobs.

### Node version changed

If Node was upgraded alongside the scheduler (e.g., `brew upgrade` updated both), the native `better-sqlite3` module needs rebuilding:

### macOS (launchd)

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
```

### Linux / Windows WSL2 (systemd)

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3
systemctl --user restart openclaw-scheduler
```

### Windows native (PM2)

```powershell
cd $env:USERPROFILE\.openclaw\scheduler
npm rebuild better-sqlite3
pm2 restart openclaw-scheduler
```
