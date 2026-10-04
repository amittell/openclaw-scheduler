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
npm run verify:local
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
sleep 3 && tail -5 /tmp/openclaw-scheduler.log
node cli.js status
```

### Linux / Windows WSL2 (systemd, git-clone install)

```bash
cd ~/.openclaw/scheduler
git pull
npm install
npm run verify:local
systemctl --user restart openclaw-scheduler
sleep 3 && systemctl --user --no-pager --full status openclaw-scheduler
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
   openclaw-scheduler doctor --json
   ```
   Releases before 0.3.0 do not provide `doctor`; use
   `openclaw-scheduler status --json` and continue with the backup step.
4. **Create a consistent SQLite backup before installing new code:**
   ```bash
   cd ~/.openclaw/scheduler
   sqlite3 scheduler.db ".backup 'scheduler.db.pre-upgrade'"
   ```

### Approval note for 0.4.0

Version 0.4.0 strengthens approval bindings with immutable dispatch and lineage
identity. A pending approval created by an earlier version cannot authorize the
new binding contract and is cancelled when resolved. After the upgrade,
retrigger that work to create a fresh approval rather than reusing the old ID.

### Trigger condition note for 0.4.1

Version 0.4.1 evaluates `regex:` trigger conditions with a linear-time RE2
engine. Backreferences, lookahead, and lookbehind that native JavaScript
regular expressions previously accepted are no longer supported. Review
persisted child jobs before upgrade and replace unsupported expressions with
RE2 syntax or `contains:`. Unsupported legacy patterns fail closed and do not
trigger a child until updated. RE2 and native JavaScript regexes can also differ
in Unicode and character-class corner cases, so validate every retained pattern.
Regex conditions fail closed when parent output exceeds 65,536 UTF-8 bytes. Use
`contains:` for literal checks or reduce the parent output below that bound.

### launchd service file permissions for 0.4.1

Version 0.4.1 creates launchd service files with owner-only permissions because
they may contain the Gateway bearer token. Re-running setup tightens an existing
selected service automatically. To remediate manually, run the command matching
the installed service mode:

```bash
chmod 600 ~/Library/LaunchAgents/ai.openclaw.scheduler.plist
sudo chmod 600 /Library/LaunchDaemons/ai.openclaw.scheduler.plist
```

### Dispatch labels path containment for 0.4.2

Version 0.4.2 requires the dispatch labels ledger to remain beneath
`DISPATCH_STATE_DIR`, which defaults to
`~/.openclaw/scheduler/dispatch`. Relative `DISPATCH_LABELS_PATH` values resolve
beneath that directory. Absolute values are accepted only when they remain
beneath the same directory after `path.resolve` normalizes traversal. Existing
parent directories must also remain beneath that root after symbolic links are
resolved.

If an existing service intentionally stores `labels.json` elsewhere, set both
variables to preserve that layout. For example:

```bash
export DISPATCH_STATE_DIR="$HOME/.openclaw/dispatch"
export DISPATCH_LABELS_PATH="$HOME/.openclaw/dispatch/labels.json"
```

An unsafe or mismatched override now fails startup before the scheduler creates,
reads, or writes the escaped path.

### `ssh` evidence trust for 0.6.7

Version 0.6.7 no longer trusts an allowed-signers path because the scheduler
database names it. Before, `runs evidence` and `doctor` re-verified handoff v4
`ssh` evidence against the path recorded on each evidence row, ahead of
`AGENTCLI_ALLOWED_SIGNERS`. Now the dispatcher when it signs, and the CLI when
it re-verifies, use the file `AGENTCLI_ALLOWED_SIGNERS` names in that
process's own environment. A path recorded on the row, or named by a job's
evidence `provider_config`, is used only when the operator lists it in
`SCHEDULER_TRUSTED_ALLOWED_SIGNERS` (absolute paths separated by `:`; relative
entries are ignored with a warning). Evidence from `SCHEDULER_PROVIDER_PATH`
plugins and the checksum evidence of handoff versions 1 to 3 are unaffected.

Check whether a host has `ssh` evidence:

```bash
sqlite3 -readonly "${SCHEDULER_DB:-$HOME/.openclaw/scheduler/scheduler.db}" \
  "SELECT evidence_allowed_signers_path, COUNT(*) FROM evidence_records
   WHERE evidence_method = 'ssh-signature' GROUP BY 1"
```

If that prints nothing, existing evidence is unaffected. Otherwise:

1. Set `AGENTCLI_ALLOWED_SIGNERS` to the absolute path of the allowed-signers
   file the host trusts, in every environment that runs `openclaw-scheduler
   runs evidence` or `doctor`, and in the service environment
   (`EnvironmentVariables` in the launchd plist, or `Environment=` in the
   systemd unit). A shell profile such as `~/.zshenv` reaches only `zsh`; a
   cron or launchd job, CI step, or `bash` or `sh` script that runs `doctor`
   needs the variable in its own environment. The CLI used to work without it
   because it read the recorded path; now `runs evidence` exits 1 and `doctor`
   counts the row as invalid with `EVIDENCE_TRUST_NOT_CONFIGURED`.
2. Rows that record a different path are checked against
   `AGENTCLI_ALLOWED_SIGNERS` instead. If that file does not list their key,
   they fail with `EVIDENCE_VERIFICATION_FAILED`, and the error names the
   recorded path it did not use. Look at each such path before doing anything
   with it. List it in `SCHEDULER_TRUSTED_ALLOWED_SIGNERS` only if you
   recognize it as an allowed-signers file you created, for example the same
   file before it moved, and you still trust every key in it: a listed file is
   trusted for every key it contains and for every row that names it. Do not
   list an old file to keep rows signed by a key you removed because it leaked
   or was retired; those rows should fail. A path you do not recognize, a file
   you do not control, or the scheduler database itself is a sign of a forged
   row; leave it unlisted and investigate. A path that contains `:` cannot be
   listed.
3. Run `openclaw-scheduler doctor --deep --json` and confirm
   `diagnostics.evidence_records.invalid` is `0`.
   `diagnostics.evidence_records.trust_not_configured` counts the rows that
   failed only because no allowed-signers file is configured, and each entry
   in `invalid_samples` carries its error `code`.
   `openclaw-scheduler runs evidence RUN_ID --json` reports which file verified
   a row as `integrity.trust_source`: `operator` or
   `operator-listed-recorded-path`.

Signing changes the same way. A v4 `ssh` job compiled by agentcli already
failed to sign without `AGENTCLI_ALLOWED_SIGNERS` (`allowed_signers file not
found`); it now fails with `EVIDENCE_TRUST_NOT_CONFIGURED`, which names the
variable. A job whose evidence `provider_config` names an allowed-signers file
is signed against `AGENTCLI_ALLOWED_SIGNERS` unless that file is listed.

---

## Step 1: Pull or Install the Update

### Git-clone installs

#### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
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
npm install --ignore-scripts=false --prefix ~/.openclaw/scheduler openclaw-scheduler@latest
```

### Local source tarball upgrade (`npm pack`)

Use this when you want to upgrade a host to a locally built package before publishing to npmjs.org.

```bash
git clone https://github.com/amittell/openclaw-scheduler /tmp/openclaw-scheduler
cd /tmp/openclaw-scheduler
git pull
npm ci
npm run verify:local
npm pack

mkdir -p ~/.openclaw/packages/openclaw-scheduler
npm install --ignore-scripts=false --prefix ~/.openclaw/packages/openclaw-scheduler --omit=dev --no-package-lock ./openclaw-scheduler-*.tgz
```

Keep `SCHEDULER_HOME=~/.openclaw/scheduler` and `SCHEDULER_DB=~/.openclaw/scheduler/scheduler.db`, and point the service at `~/.openclaw/packages/openclaw-scheduler/node_modules/openclaw-scheduler/dispatcher.js`.

---

## Step 2: Install Dependencies

### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
npm install
```

If you upgraded Node.js since the last install, also rebuild the native module:

```bash
npm rebuild better-sqlite3 --ignore-scripts=false
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
npm run verify:local
```

All tests must pass before restarting the service. If tests fail, do not restart -- investigate the failure first and check the CHANGELOG for any required manual steps.

---

## Step 4: Schema Migrations

The dispatcher runs pending schema migrations automatically on startup. No
manual schema command is needed. Schema application and consolidation fail
closed: a migration error stops startup instead of continuing on a partial
schema.

Schema 28 transactionally rebuilds legacy `completion_debts` with a derived
delivery scope, creates immutable `evidence_records` storage and indexes,
preserves existing rows, and records migration version 28. A failure rolls the
migration back and stops startup.

`migrate.js` imports OpenClaw cron definitions through `openclaw cron list/get
--json`; it is not the schema migrator. `--legacy-json` is only for an old
export. Do not run either importer expecting schema changes.

To verify the current schema version:

### macOS / Linux / Windows WSL2

```bash
cd ~/.openclaw/scheduler
openclaw-scheduler doctor --json
```

`doctor` also runs SQLite `quick_check` and `foreign_key_check`. It exits
nonzero for structural corruption, orphan foreign keys, recovery-blocked runs,
or failed credential cleanup. Do not treat these as cosmetic warnings.

Older installations can contain historical runs or dispatch rows whose jobs
were deleted while foreign-key enforcement was disabled. Preserve them in the
pre-upgrade backup before removing the orphan rows:

```bash
sqlite3 scheduler.db "PRAGMA foreign_key_check;"
sqlite3 scheduler.db ".backup 'scheduler.db.before-fk-repair'"
sqlite3 scheduler.db <<'SQL'
BEGIN IMMEDIATE;
DELETE FROM runs
WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = runs.job_id);
DELETE FROM job_dispatch_queue
WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_dispatch_queue.job_id);
COMMIT;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
SQL
```

Only run that repair when the reported violations are those two orphan forms.
Investigate any other parent table or integrity error instead of deleting data
generically.

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

A healthy startup log looks like:

```
[scheduler] [info] Starting OpenClaw Scheduler v0.4.1 {"tickMs":10000,...}
[scheduler] [info] Database initialized
[scheduler] [info] Pruned old runs + messages
```

If you see `Gateway unreachable`, isolated agent jobs are deferred until the
Gateway is back. Shell jobs continue independently. Main-session jobs also
depend on the Gateway: default, `execute`, or `plan` jobs use synchronous agent
execution, while `fire-and-forget` jobs use `openclaw system event`. They can
defer or enter configured retry behavior while the Gateway is unavailable.

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
HOST=youruser@your-mac-host.lan

ssh $HOST "cd ~/.openclaw/scheduler && git pull && npm install"
ssh $HOST "cd ~/.openclaw/scheduler && npm run verify:smoke" 2>&1 | tail -20
ssh $HOST "launchctl kickstart -k gui/\$(id -u)/ai.openclaw.scheduler"
sleep 3
ssh $HOST "tail -5 /tmp/openclaw-scheduler.log && cd ~/.openclaw/scheduler && node cli.js status"
```

#### macOS host over SSH using a local tarball

```bash
HOST=youruser@your-mac-host.lan
TARBALL=./openclaw-scheduler-*.tgz

scp $TARBALL $HOST:~/.openclaw/
ssh $HOST "mkdir -p ~/.openclaw/packages/openclaw-scheduler && npm install --ignore-scripts=false --prefix ~/.openclaw/packages/openclaw-scheduler --omit=dev --no-package-lock ~/.openclaw/$(basename $TARBALL)"
ssh $HOST "launchctl kickstart -k gui/\$(id -u)/ai.openclaw.scheduler"
sleep 3
ssh $HOST "tail -5 /tmp/openclaw-scheduler.log && launchctl print gui/\$(id -u)/ai.openclaw.scheduler | sed -n '1,20p'"
```

#### Linux / Windows WSL2 host over SSH

```bash
HOST=youruser@your-linux-host.lan

ssh $HOST "cd ~/.openclaw/scheduler && git pull && npm install"
ssh $HOST "cd ~/.openclaw/scheduler && npm run verify:smoke" 2>&1 | tail -20
ssh $HOST "systemctl --user restart openclaw-scheduler"
sleep 3
ssh $HOST "systemctl --user --no-pager --full status openclaw-scheduler && cd ~/.openclaw/scheduler && node cli.js status"
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

### npm installs

#### macOS (launchd)

```bash
npm install --ignore-scripts=false --prefix ~/.openclaw/scheduler openclaw-scheduler@<previous-version>
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
```

#### Linux / Windows WSL2 (systemd)

```bash
npm install --ignore-scripts=false --prefix ~/.openclaw/scheduler openclaw-scheduler@<previous-version>
systemctl --user restart openclaw-scheduler
```

**Schema rollback:** Do not assume an older package can safely use a schema 28
database. Stop the service before changing database files. If the previous
version fails its startup checks, preserve the failed database, restore
`scheduler.db.pre-upgrade` to `scheduler.db`, remove stale `scheduler.db-wal`
and `scheduler.db-shm` files only while the service is stopped, then start the
previous package and run its status check. Restoring the backup loses writes
made after the backup, so export or inspect those rows first when they matter.

---

## Provider plugins (v0.2)

If you use provider-backed identity, authorization, proof verification, or
evidence signing, set `SCHEDULER_PROVIDER_PATH` to a directory containing your
provider `*.js` files. This is a high-trust boundary: every file in that
directory is dynamically imported at scheduler startup. The directory must not
be world-writable. See `docs/gateway-contract.md` for the full provider plugin
contract.

`openclaw-scheduler runs evidence` and `openclaw-scheduler doctor` also import
that directory before they verify handoff v4 evidence. When a plugin signs
evidence, set `SCHEDULER_PROVIDER_PATH` in the shell that runs those commands
as well as in the service environment, and use an absolute path: a relative
path resolves against each process's working directory. Without it, a
plugin-signed row reports `EVIDENCE_PROVIDER_NOT_LOADED` and `doctor` counts it
as invalid. The plugin's trust policy, such as its allowlist of signing keys,
must be available to the CLI as well. Because the CLI imports every plugin in
the directory, plugin modules must not print to stdout or start listeners or
timers when imported.

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
- If `better-sqlite3` fails to load, run `npm rebuild better-sqlite3 --ignore-scripts=false`.

### Service won't start after update

- Check the error log: `tail -20 /tmp/openclaw-scheduler.log`
- If the error is a missing module, run `npm install` again.
- If the error is a database issue, check the schema version matches what the new code expects.

### Gateway unreachable after update

The scheduler update does not affect the OpenClaw Gateway. If the Gateway is
down, that is a separate issue. The scheduler continues running shell jobs,
defers isolated agent jobs, and cannot execute main-session jobs until the
Gateway is available. Default, `execute`, or `plan` main jobs use synchronous
agent execution; `fire-and-forget` main jobs use system-event injection.

### Node version changed

If Node was upgraded alongside the scheduler (e.g., `brew upgrade` updated both), the native `better-sqlite3` module needs rebuilding:

### macOS (launchd)

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3 --ignore-scripts=false
launchctl kickstart -k gui/$(id -u)/ai.openclaw.scheduler
```

### Linux / Windows WSL2 (systemd)

```bash
cd ~/.openclaw/scheduler
npm rebuild better-sqlite3 --ignore-scripts=false
systemctl --user restart openclaw-scheduler
```
