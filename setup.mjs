#!/usr/bin/env node
/**
 * OpenClaw Scheduler — Interactive Setup Wizard
 *
 * Run from the scheduler directory:
 *   node setup.mjs
 *
 * What it does:
 *  1. Runs DB migrations (creates/upgrades scheduler.db)
 *  2. Appends chilisaus entries to your agent's MEMORY.md + workspace-index.md
 *  3. Creates Inbox Consumer + Stuck Run Detector scheduler jobs
 *  4. Installs the macOS LaunchAgent (optional)
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(resolve => {
  const hint = def ? ` (${def})` : '';
  rl.question(`${q}${hint}: `, ans => resolve(ans.trim() || def || ''));
});
const confirm = async (q) => {
  const ans = await ask(`${q} [y/N]`);
  return /^y(es)?$/i.test(ans);
};
const print = (msg = '') => console.log(msg);
const ok   = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const skip = (msg) => console.log(`  ⏭️  ${msg}`);

function appendIfMissing(filePath, anchor, content) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(anchor)) return 'exists';
  fs.appendFileSync(filePath, '\n' + content + '\n');
  return true;
}

function insertBeforeIfMissing(filePath, anchor, content) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes('chilisaus')) return 'exists';
  if (!existing.includes(anchor)) return false;
  fs.writeFileSync(filePath, existing.replace(anchor, content + '\n' + anchor));
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

print();
print('╔══════════════════════════════════════════════════════╗');
print('║     OpenClaw Scheduler — Setup Wizard  🌶️             ║');
print('╚══════════════════════════════════════════════════════╝');
print();
print('This wizard will:');
print('  • Run DB migrations');
print('  • Add chilisaus to your agent memory files');
print('  • Create Inbox Consumer + Stuck Run Detector jobs');
print('  • Install the macOS LaunchAgent (optional)');
print();

// ─── Step 1: Paths ────────────────────────────────────────────────────────────

print('── Step 1: Paths ───────────────────────────────────────');
const schedulerPath = __dirname;
const defaultWorkspace = path.join(os.homedir(), '.openclaw', 'workspace');
const workspacePath = await ask('Workspace path', defaultWorkspace);
const defaultGateway = 'http://127.0.0.1:18789';
const gatewayUrl = await ask('Gateway URL', defaultGateway);
const deliverTo = await ask('Telegram delivery ID for alerts (user or group ID)');
const schedulerDbPath = path.join(schedulerPath, 'scheduler.db');

print();
print(`  Scheduler:  ${schedulerPath}`);
print(`  Workspace:  ${workspacePath}`);
print(`  Gateway:    ${gatewayUrl}`);
print(`  Deliver to: ${deliverTo || '(none — skipping job creation)'}`);
print();

// ─── Step 2: DB migrations ────────────────────────────────────────────────────

print('── Step 2: Database migrations ─────────────────────────');
try {
  const migrate = (await import(path.join(schedulerPath, 'migrate-consolidate.js'))).default;
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(schedulerDbPath);
  const ran = migrate(db);
  db.close();
  if (ran) {
    ok(`Migrations applied → ${schedulerDbPath}`);
  } else {
    ok(`DB already up to date (schema v9) → ${schedulerDbPath}`);
  }
} catch (err) {
  warn(`Migration failed: ${err.message}`);
  warn('Continuing — you can run migrations manually: node migrate-consolidate.js');
}
print();

// ─── Step 3: Memory files ────────────────────────────────────────────────────

print('── Step 3: Agent memory files ──────────────────────────');

const memoryMd = path.join(workspacePath, 'MEMORY.md');
const memoryEntry = `- **chilisaus 🌶️:** Sub-agent dispatch CLI at \`${schedulerPath}/chilisaus/index.mjs\`.
  Commands: \`enqueue\` (spawn sub-agent), \`status\`, \`stuck\`, \`result\`, \`send\` (queue message), \`heartbeat\`.
  Backed by scheduler DB (runs/jobs tables). Queue (\`send\`) is signal-only — scripts enqueue only when
  actionable. Inbox Consumer (\`${workspacePath}/scripts/inbox-consumer.mjs\`) drains queue → Telegram DM
  every 5 min. Docs: \`${schedulerPath}/chilisaus/README.md\`.`;

const memResult = appendIfMissing(memoryMd, 'chilisaus', memoryEntry);
if (memResult === true)       ok(`Appended chilisaus entry → MEMORY.md`);
else if (memResult === 'exists') skip('chilisaus already in MEMORY.md');
else                          warn(`MEMORY.md not found at ${memoryMd} — skipping`);

const workspaceIndex = path.join(workspacePath, 'memory', 'workspace-index.md');
const indexSection = `### Scheduler & Dispatch
> Covers: standalone scheduler, sub-agent dispatch, inbox queue

| File | Covers | Load |
|------|--------|------|
| \`${schedulerPath}/\` | Standalone SQLite scheduler. CLI: \`node cli.js\`. LaunchAgent: \`ai.openclaw.scheduler\`. | Any scheduler/cron work |
| \`${schedulerPath}/chilisaus/index.mjs\` | Sub-agent dispatch CLI 🌶️. Commands: \`enqueue\`, \`status\`, \`stuck\`, \`result\`, \`send\`, \`heartbeat\`. | Dispatching sub-agents or queue messages |
| \`${schedulerPath}/chilisaus/hooks.mjs\` | Loki lifecycle hooks. Only fires if \`LOKI_PUSH_URL\` env set. | Sub-agent observability |
| \`${workspacePath}/scripts/inbox-consumer.mjs\` | Drains chilisaus queue → Telegram DM. Runs every 5 min via scheduler. Signal-only. | Queue/inbox debugging |`;

// Try inserting before a common section header, fall back to append
const idxAnchors = ['### Automation', '### Memory', '## 🔗', '---\n\n## 🔗'];
let idxResult = false;
if (fs.existsSync(workspaceIndex)) {
  const existing = fs.readFileSync(workspaceIndex, 'utf8');
  if (existing.includes('chilisaus')) {
    idxResult = 'exists';
  } else {
    for (const anchor of idxAnchors) {
      if (existing.includes(anchor)) {
        fs.writeFileSync(workspaceIndex, existing.replace(anchor, indexSection + '\n\n' + anchor));
        idxResult = true;
        break;
      }
    }
    if (!idxResult) {
      fs.appendFileSync(workspaceIndex, '\n' + indexSection + '\n');
      idxResult = true;
    }
  }
}

if (idxResult === true)        ok(`Added Scheduler & Dispatch section → workspace-index.md`);
else if (idxResult === 'exists') skip('Scheduler section already in workspace-index.md');
else                           warn(`workspace-index.md not found at ${workspaceIndex} — skipping`);

print();

// ─── Step 4: Scheduler jobs ──────────────────────────────────────────────────

print('── Step 4: Scheduler jobs ──────────────────────────────');

if (!deliverTo) {
  skip('No delivery ID provided — skipping job creation');
  skip('You can add jobs manually with: node cli.js jobs add \'{ ... }\'');
} else {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(schedulerDbPath);

    const existing = db.prepare('SELECT name FROM jobs').all().map(r => r.name);

    // Inbox Consumer
    const icScript = path.join(workspacePath, 'scripts', 'inbox-consumer.mjs');
    const icName = 'Inbox Consumer';
    if (existing.includes(icName)) {
      skip(`"${icName}" job already exists`);
    } else if (!fs.existsSync(icScript)) {
      warn(`inbox-consumer.mjs not found at ${icScript}`);
      warn(`Copy it from docs/examples/ then re-run setup, or add the job manually`);
    } else {
      const { v4: uuidv4 } = await import('uuid');
      db.prepare(`
        INSERT INTO jobs (id, name, schedule_cron, enabled, session_target, payload_kind,
          payload_message, payload_timeout_seconds, delivery_mode, delivery_channel, delivery_to)
        VALUES (?, ?, ?, 1, 'shell', 'shellCommand', ?, 60, 'announce', 'telegram', ?)
      `).run(uuidv4(), icName, '*/5 * * * *', `node ${icScript}`, deliverTo);
      ok(`Created "${icName}" job (*/5 * * * *)`);
    }

    // Stuck Run Detector
    const srdName = 'Stuck Run Detector';
    const srdCmd = `node ${path.join(schedulerPath, 'chilisaus', 'index.mjs')} stuck --threshold-min 15`;
    if (existing.includes(srdName)) {
      skip(`"${srdName}" job already exists`);
    } else {
      const { v4: uuidv4 } = await import('uuid');
      db.prepare(`
        INSERT INTO jobs (id, name, schedule_cron, enabled, session_target, payload_kind,
          payload_message, payload_timeout_seconds, delivery_mode, delivery_channel, delivery_to)
        VALUES (?, ?, ?, 1, 'shell', 'shellCommand', ?, 30, 'announce', 'telegram', ?)
      `).run(uuidv4(), srdName, '*/10 * * * *', srdCmd, deliverTo);
      ok(`Created "${srdName}" job (*/10 * * * *)`);
    }

    db.close();
  } catch (err) {
    warn(`Job creation failed: ${err.message}`);
  }
}

print();

// ─── Step 5: Service / auto-start ────────────────────────────────────────────

const platform = process.platform;
const nodePath  = process.execPath;
const indexPath = path.join(schedulerPath, 'index.js');
const logPath   = platform === 'win32'
  ? path.join(os.tmpdir(), 'openclaw-scheduler.log')
  : '/tmp/openclaw-scheduler.log';

// Detect WSL (WSL runs as linux; WSL_DISTRO_NAME is set by Microsoft)
const isWSL = platform === 'linux' && (
  process.env.WSL_DISTRO_NAME ||
  process.env.WSL_INTEROP ||
  (() => { try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })()
);
// WSL2 has systemd support; WSL1 does not
const wslVersion = isWSL && (() => {
  try { return fs.readFileSync('/proc/version', 'utf8').includes('WSL2') ? 2 : 1; } catch { return null; }
})();

// ── macOS ──────────────────────────────────────────────────────────────────
if (platform === 'darwin') {
  print('── Step 5: Service (macOS LaunchAgent) ─────────────────');
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.scheduler.plist');
  if (fs.existsSync(plistPath)) {
    skip('LaunchAgent already installed');
    print(`  Path: ${plistPath}`);
    print('  To restart: launchctl kickstart -k gui/$UID/ai.openclaw.scheduler');
  } else {
    const install = await confirm('Install LaunchAgent (auto-start on login)?');
    if (install) {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.scheduler</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${indexPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${schedulerPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLAW_GATEWAY_URL</key>
    <string>${gatewayUrl}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;
      fs.writeFileSync(plistPath, plist);
      try {
        execSync(`launchctl load "${plistPath}"`);
        ok('LaunchAgent installed and loaded');
      } catch (err) {
        ok(`LaunchAgent plist written → ${plistPath}`);
        warn(`Auto-load failed: ${err.message.trim()}`);
        warn(`Run manually: launchctl load "${plistPath}"`);
      }
      print(`  Logs: ${logPath}`);
    } else {
      skip('Skipped — run again to install later');
    }
  }

// ── Linux ──────────────────────────────────────────────────────────────────
} else if (platform === 'linux') {
  if (isWSL) {
    const wslLabel = wslVersion ? `WSL${wslVersion}` : 'WSL';
    print(`── Step 5: Service (${wslLabel}) ──────────────────────────────`);
    if (wslVersion === 1) {
      print('  WSL1 detected — systemd not supported. Using PM2.');
    } else {
      print('  WSL2 detected. Systemd is supported if enabled in /etc/wsl.conf.');
      print('  If not enabled: add [boot] systemd=true to /etc/wsl.conf, then wsl --shutdown.');
    }
  } else {
    print('── Step 5: Service (Linux) ─────────────────────────────');
  }

  // Detect whether systemd user session is available
  let hasSystemd = false;
  if (isWSL && wslVersion === 1) {
    hasSystemd = false; // WSL1 never has systemd
  } else {
    try { execSync('systemctl --user status', { stdio: 'ignore' }); hasSystemd = true; } catch {}
    if (!hasSystemd) {
      try { execSync('systemctl --user list-units', { stdio: 'ignore' }); hasSystemd = true; } catch {}
    }
  }

  // Check for PM2
  let hasPm2 = false;
  try { execSync('pm2 --version', { stdio: 'ignore' }); hasPm2 = true; } catch {}

  if (hasSystemd) {
    const unitDir  = path.join(os.homedir(), '.config', 'systemd', 'user');
    const unitPath = path.join(unitDir, 'openclaw-scheduler.service');

    if (fs.existsSync(unitPath)) {
      skip('systemd user service already installed');
      print(`  Path: ${unitPath}`);
      print('  To restart: systemctl --user restart openclaw-scheduler');
    } else {
      const install = await confirm('Install systemd user service (auto-start on login)?');
      if (install) {
        const unit = `[Unit]
Description=OpenClaw Scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory=${schedulerPath}
ExecStart=${nodePath} ${indexPath}
Environment=OPENCLAW_GATEWAY_URL=${gatewayUrl}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
        fs.mkdirSync(unitDir, { recursive: true });
        fs.writeFileSync(unitPath, unit);
        try {
          execSync('systemctl --user daemon-reload');
          execSync('systemctl --user enable --now openclaw-scheduler');
          ok('systemd user service installed and started');
        } catch (err) {
          ok(`Unit file written → ${unitPath}`);
          warn(`Auto-start failed: ${err.message.trim()}`);
          warn('Run manually:');
          warn('  systemctl --user daemon-reload');
          warn('  systemctl --user enable --now openclaw-scheduler');
        }
        print(`  Logs: ${logPath}  (or: journalctl --user -u openclaw-scheduler -f)`);
      } else {
        skip('Skipped — run again to install later');
      }
    }
  } else if (hasPm2) {
    print('  systemd user session not available — using PM2');
    const pm2Name = 'openclaw-scheduler';
    let pm2Running = false;
    try {
      const out = execSync('pm2 list --no-color', { encoding: 'utf8' });
      pm2Running = out.includes(pm2Name);
    } catch {}

    if (pm2Running) {
      skip(`PM2 process "${pm2Name}" already running`);
      print('  To restart: pm2 restart openclaw-scheduler');
    } else {
      const install = await confirm('Register with PM2 (auto-start on login)?');
      if (install) {
        try {
          execSync(
            `pm2 start "${indexPath}" --name "${pm2Name}" --cwd "${schedulerPath}" ` +
            `--log "${logPath}" -- --env OPENCLAW_GATEWAY_URL=${gatewayUrl}`,
            { stdio: 'inherit' }
          );
          execSync('pm2 save');
          ok('PM2 process started and saved');
          print('  Run `pm2 startup` and follow the instructions to survive reboots.');
        } catch (err) {
          warn(`PM2 start failed: ${err.message.trim()}`);
        }
      } else {
        skip('Skipped — run again to install later');
      }
    }
  } else {
    warn('Neither systemd user session nor PM2 found');
    print('  Options:');
    print('  • Install PM2:  npm install -g pm2');
    print('  • Or run manually:  node index.js &');
    print('  • See INSTALL-LINUX.md for systemd setup without a user session');
  }

// ── Windows (native) ───────────────────────────────────────────────────────
} else if (platform === 'win32') {
  print('── Step 5: Service (Windows) ───────────────────────────');
  print();
  warn('Native Windows detected.');
  print('  OpenClaw Scheduler is designed to run inside WSL (Windows Subsystem for Linux).');
  print('  Running natively on Windows is not supported.');
  print();
  print('  Setup steps:');
  print('  1. Install WSL2:  wsl --install  (in PowerShell as Admin)');
  print('  2. Open your WSL terminal and run this wizard again from there:');
  print(`     cd ${schedulerPath.replace(/\\/g, '/')}`);
  print('     node setup.mjs');
  print();
  print('  WSL2 with systemd enabled gives the best experience (auto-start on login).');
  print('  See INSTALL-WINDOWS.md for the full WSL2 + systemd setup guide.');

// ── Unknown ────────────────────────────────────────────────────────────────
} else {
  skip(`Unsupported platform: ${platform}`);
  print('  Start manually: node index.js');
}

print();

// ─── Done ─────────────────────────────────────────────────────────────────────

print('── Done! ───────────────────────────────────────────────');
print();
print('Next steps:');

if (platform === 'darwin') {
  print('  • Check service:  launchctl list | grep openclaw');
  print('  • Restart:        launchctl kickstart -k gui/$UID/ai.openclaw.scheduler');
} else if (platform === 'linux') {
  if (isWSL) {
    print('  • Check service:  systemctl --user status openclaw-scheduler  (or: pm2 status)');
    print('  • Logs:           journalctl --user -u openclaw-scheduler -f   (or: pm2 logs)');
    print('  • Note: if WSL session closes, restart with: systemctl --user start openclaw-scheduler');
  } else {
    print('  • Check service:  systemctl --user status openclaw-scheduler  (or: pm2 status)');
    print('  • Logs:           journalctl --user -u openclaw-scheduler -f   (or: pm2 logs)');
  }
} else if (platform === 'win32') {
  print('  • Run setup inside WSL — see instructions above');
}

print('  • Scheduler CLI:  node cli.js status');
print('  • List jobs:      node cli.js jobs list');
print('  • Test dispatch:  node chilisaus/index.mjs enqueue --label test --message "Hello"');
print(`  • Logs:           ${logPath}`);
print('  • Docs:           chilisaus/README.md');
print();

rl.close();
