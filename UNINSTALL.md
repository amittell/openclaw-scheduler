# Uninstalling OpenClaw Scheduler

Two levels of removal:

1. **Stop the scheduler** and re-enable any native jobs that it replaced: reversible
2. **Full removal**: delete all scheduler files and data: irreversible

---

## Step 1: Stop the Scheduler Service

### macOS

Remove the launchd mode you actually used:

**LaunchAgent**

```bash
launchctl bootout gui/$UID/ai.openclaw.scheduler
rm ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
```

**LaunchDaemon**

```bash
sudo launchctl bootout system/ai.openclaw.scheduler
sudo rm /Library/LaunchDaemons/ai.openclaw.scheduler.plist
```

### Linux

```bash
systemctl --user stop openclaw-scheduler
systemctl --user disable openclaw-scheduler
rm ~/.config/systemd/user/openclaw-scheduler.service
systemctl --user daemon-reload
```

### Windows (PM2)

```powershell
pm2 stop openclaw-scheduler
pm2 delete openclaw-scheduler
pm2 save   # persist the removal
```

---

## Step 2: Re-enable Replaced Native Jobs

### Re-enable cron (if you had OC cron jobs before)

```bash
openclaw cron list
openclaw cron edit <job-id> --enable   # repeat for each job you want back
```

Re-enable only jobs that were disabled after a verified scheduler import. Leave
unrelated native jobs unchanged. Run each restored job or inspect its next-run
state before removing the scheduler database.

### Re-enable heartbeat only if the scheduler replaced it

```bash
openclaw config set agents.defaults.heartbeat.every "5m"
# If you had per-agent heartbeat overrides, restore those too:
# agents.list[].heartbeat.every = "5m"
openclaw gateway restart
```

---

## Step 3: Full Removal (optional)

> **Warning:** This permanently deletes job definitions, run history, approval
> audit, delivery outbox and attachment state, log files, and all scheduler data.
> This cannot be undone.

**Export your jobs first (optional):**

```bash
openclaw-scheduler jobs list --json > ~/scheduler-jobs-backup.json
sqlite3 ~/.openclaw/scheduler/scheduler.db ".backup '$HOME/scheduler.db.uninstall-backup'"
```

**Remove the scheduler directory:**

```bash
# macOS / Linux
rm -rf ~/.openclaw/scheduler/

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.openclaw\scheduler"
```

**Remove log files:**

```bash
# macOS / Linux
rm -f /tmp/openclaw-scheduler.log
```

On Windows, PM2 stores logs in `~/.pm2/logs/`. Remove if desired:

```powershell
Remove-Item -Force "$env:USERPROFILE\.pm2\logs\openclaw-scheduler-out.log"
Remove-Item -Force "$env:USERPROFILE\.pm2\logs\openclaw-scheduler-error.log"
```

---

## About the Chat Completions Endpoint

The scheduler enabled the OpenClaw gateway's chat completions endpoint (`/v1/chat/completions`). This endpoint is also used by Claude Code, other AI tools, and the OpenClaw API. **You probably want to leave it enabled.**

If you specifically want to disable it:

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled false
openclaw gateway restart
```

---

## Linger (Linux only)

If you enabled linger to keep the service running without a login session, you can disable it:

```bash
loginctl disable-linger $USER
```

This stops systemd user services from running when you're not logged in. Only do this if you don't need other user services running persistently.
