# Uninstalling OpenClaw Scheduler

Two levels of removal:

1. **Stop the scheduler** and re-enable OpenClaw's built-in cron/heartbeat — reversible
2. **Full removal** — delete all scheduler files and data — irreversible

---

## Step 1: Stop the Scheduler Service

### macOS

```bash
launchctl unload ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
rm ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
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

## Step 2: Re-enable OpenClaw Built-ins

### Re-enable cron (if you had OC cron jobs before)

```bash
openclaw cron list
openclaw cron edit <job-id> --enable   # repeat for each job you want back
```

### Re-enable heartbeat (if you had one)

```bash
openclaw config set agents.defaults.heartbeat.every "5m"
openclaw gateway restart
```

---

## Step 3: Full Removal (optional)

> ⚠️ **This permanently deletes your job definitions, run history, log files, and all scheduler data. This cannot be undone.**

**Export your jobs first (optional):**

```bash
node ~/.openclaw/scheduler/cli.js jobs list > ~/scheduler-jobs-backup.txt
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
