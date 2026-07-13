# Installing OpenClaw Scheduler on Windows

OpenClaw Scheduler supports Windows through WSL2 only. Native Windows and
WSL1 are not supported runtime environments. Do not run the dispatcher with
native Windows PM2, `cmd.exe`, or PowerShell shell jobs.

Inside WSL2 the scheduler uses the same Linux runtime, shell behavior, SQLite
binding, and service configuration documented in [INSTALL-LINUX.md](INSTALL-LINUX.md).

## 1. Install or update WSL2

Run the following in an elevated PowerShell terminal:

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
wsl --update
wsl --list --verbose
```

The Ubuntu row must report version `2`. If an existing Ubuntu distribution is
still version `1`, convert it before installing the scheduler:

```powershell
wsl --set-version Ubuntu 2
wsl --list --verbose
```

Open the Ubuntu terminal after installation completes.

## 2. Enable systemd in WSL2

Run these commands inside Ubuntu:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Exit Ubuntu, then restart WSL from PowerShell:

```powershell
wsl --shutdown
wsl -d Ubuntu
```

Back inside Ubuntu, verify the user service manager is available:

```bash
systemctl --user status
```

If that command fails, confirm `/etc/wsl.conf` contains the `[boot]` section,
run `wsl --shutdown` again from PowerShell, and reopen Ubuntu.

## 3. Install the Linux prerequisites

Continue inside Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential git python3 sqlite3
```

Install a supported Node.js release as described in
[INSTALL-LINUX.md](INSTALL-LINUX.md#prerequisites), then verify it:

```bash
node --version
npm --version
```

## 4. Install and configure the scheduler

Follow the complete [Linux installation guide](INSTALL-LINUX.md) from
"Step 1: Install Scheduler Files" onward. Run every scheduler, OpenClaw, npm,
and systemctl command inside the WSL2 distribution, not from Windows
PowerShell.

The npm-first path is:

```bash
mkdir -p ~/.openclaw/scheduler
npm install --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
npm exec --prefix ~/.openclaw/scheduler openclaw-scheduler -- setup
```

For a source checkout, use:

```bash
git clone https://github.com/amittell/openclaw-scheduler.git ~/.openclaw/scheduler
cd ~/.openclaw/scheduler
npm install
npm run verify:local
node setup.mjs
```

## 5. Verify the service and runtime

Run inside WSL2:

```bash
systemctl --user --no-pager --full status openclaw-scheduler
journalctl --user -u openclaw-scheduler -n 20 --no-pager
openclaw-scheduler doctor --json
openclaw-scheduler status --json
```

Shell jobs execute under `/bin/bash` by default. Override that only with a
Linux shell path, for example `SCHEDULER_SHELL=/usr/bin/bash`.

## WSL lifecycle notes

- A Windows reboot or `wsl --shutdown` stops the WSL virtual machine and all
  scheduler processes inside it.
- The enabled systemd user unit starts when the WSL2 distribution starts and
  the user service manager becomes available.
- Keep the OpenClaw Gateway and scheduler in the same WSL2 environment when
  using the default `http://127.0.0.1:18789` Gateway URL.
- Store scheduler state in the Linux filesystem under
  `~/.openclaw/scheduler`, not under `/mnt/c`, to retain Linux permissions and
  SQLite filesystem semantics.

## Upgrading and removal

Use the Linux/WSL2 commands in [UPGRADING.md](UPGRADING.md). For removal and
rollback to native OpenClaw jobs, follow [UNINSTALL.md](UNINSTALL.md) from
inside WSL2.
