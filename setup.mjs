#!/usr/bin/env node
/**
 * OpenClaw Scheduler — Interactive Setup Wizard
 *
 * Run from the scheduler directory:
 *   node setup.mjs
 *
 * What it does:
 *  1. Runs DB migrations (creates/upgrades scheduler.db)
 *  2. Appends scheduler queue/consumer entries to MEMORY.md + workspace-index.md
 *  3. Creates Inbox Consumer + Stuck Run Detector scheduler jobs
 *  4. Installs a macOS launchd service (LaunchAgent or LaunchDaemon, optional)
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

import { fileURLToPath } from 'url';
import { ensureSchedulerDbParent, resolveSchedulerDbPath } from './paths.js';
import { createJob } from './jobs.js';
import { initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_MAC_SERVICE_MODES = new Set(['agent', 'daemon', 'skip']);

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function printSetupUsage() {
  process.stdout.write(`OpenClaw Scheduler setup

Usage:
  node setup.mjs [--service-mode agent|daemon|skip]

Options:
  --service-mode <mode>   macOS only. Choose launchd install mode.
                          agent  -> user LaunchAgent (best for auto-login workstation use)
                          daemon -> system LaunchDaemon (best for headless/pre-login startup)
                          skip   -> do not install a macOS service
  -h, --help             Show this help
`);
}

function parseSetupArgs(argv) {
  const options = { help: false, serviceMode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--service-mode') {
      const value = argv[i + 1];
      if (!value) throw new Error('--service-mode requires a value: agent, daemon, or skip');
      options.serviceMode = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--service-mode=')) {
      options.serviceMode = arg.split('=')[1] || '';
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (options.serviceMode && !VALID_MAC_SERVICE_MODES.has(options.serviceMode)) {
    throw new Error(`Invalid --service-mode "${options.serviceMode}". Use agent, daemon, or skip.`);
  }
  return options;
}

const setupOptions = (() => {
  try {
    return parseSetupArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    printSetupUsage();
    process.exit(1);
  }
})();

if (setupOptions.help) {
  printSetupUsage();
  process.exit(0);
}

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

function getNpmConfigValue(key) {
  try {
    return execSync(`npm config get ${key}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getGatewayToken(homeDir) {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfgPath = path.join(homeDir, '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

print();
print('╔══════════════════════════════════════════════════════╗');
print('║     OpenClaw Scheduler — Setup Wizard  🌶️             ║');
print('╚══════════════════════════════════════════════════════╝');
print();
print('This wizard will:');
print('  • Run DB migrations');
print('  • Add scheduler queue + consumer notes to agent memory files');
print('  • Create Inbox Consumer + Stuck Run Detector jobs');
print('  • Install a macOS LaunchAgent or LaunchDaemon (optional)');
print();

// ─── Step 1: Paths ────────────────────────────────────────────────────────────

print('── Step 1: Paths ───────────────────────────────────────');
const schedulerPath = __dirname;
const defaultWorkspace = path.join(os.homedir(), '.openclaw', 'workspace');
const workspacePath = await ask('Workspace path', defaultWorkspace);
const defaultGateway = 'http://127.0.0.1:18789';
const gatewayUrl = await ask('Gateway URL', defaultGateway);
const deliverTo = await ask('Telegram delivery ID for alerts (user or group ID)');
const schedulerDbPath = resolveSchedulerDbPath({ env: process.env });
if (schedulerDbPath !== ':memory:') ensureSchedulerDbParent(schedulerDbPath);

print();
print(`  Scheduler:  ${schedulerPath}`);
print(`  Workspace:  ${workspacePath}`);
print(`  Gateway:    ${gatewayUrl}`);
print(`  Deliver to: ${deliverTo || '(none — skipping job creation)'}`);
print();

// ─── Preflight: npm install behavior ─────────────────────────────────────────

print('── Preflight: npm install behavior ───────────────────');
const ignoreScripts = getNpmConfigValue('ignore-scripts').toLowerCase();
if (ignoreScripts === 'true') {
  warn('Detected npm config: ignore-scripts=true');
  warn('better-sqlite3 requires install scripts to build/load native bindings.');
  warn('Recommended fix:');
  warn('  npm config set ignore-scripts false');
  warn('  npm install --ignore-scripts=false');
  const continueAnyway = await confirm('Continue setup anyway?');
  if (!continueAnyway) {
    print('Setup aborted. Fix npm config, then rerun: node setup.mjs');
    rl.close();
    process.exit(1);
  }
} else {
  ok('npm install scripts are enabled');
}
print();

// ─── Step 2: DB migrations ────────────────────────────────────────────────────

print('── Step 2: Database migrations ─────────────────────────');
try {
  const { setDbPath } = await import(path.join(schedulerPath, 'db.js'));
  setDbPath(schedulerDbPath);
  const migrate = (await import(path.join(schedulerPath, 'migrate-consolidate.js'))).default;
  const ran = migrate();
  if (ran) {
    ok(`Migrations applied → ${schedulerDbPath}`);
  } else {
    ok(`DB already up to date → ${schedulerDbPath}`);
  }
} catch (err) {
  warn(`Migration failed: ${err.message}`);
  warn('Continuing — you can run migrations manually: node migrate-consolidate.js');
}
print();

// ─── Step 3: Memory files ────────────────────────────────────────────────────

print('── Step 3: Agent memory files ──────────────────────────');

const memoryMd = path.join(workspacePath, 'MEMORY.md');
const memoryEntry = `- **Scheduler Queue Pattern:** Use \`node ${schedulerPath}/cli.js msg send <from> <to> "body"\` for signal-only queue entries.
  Inbox Consumer (\`${schedulerPath}/scripts/inbox-consumer.mjs\`) drains pending queue messages to Telegram.
  Stuck Run Detector (\`${schedulerPath}/scripts/stuck-run-detector.mjs\`) alerts on stale \`running\` runs.`;

const memResult = appendIfMissing(memoryMd, 'Scheduler Queue Pattern', memoryEntry);
if (memResult === true)       ok('Appended scheduler queue entry → MEMORY.md');
else if (memResult === 'exists') skip('Scheduler queue entry already in MEMORY.md');
else                          warn(`MEMORY.md not found at ${memoryMd} — skipping`);

const workspaceIndex = path.join(workspacePath, 'memory', 'workspace-index.md');
const indexSection = `### Scheduler & Dispatch
> Covers: standalone scheduler, message queue, inbox consumer

| File | Covers | Load |
|------|--------|------|
| \`${schedulerPath}/\` | Standalone SQLite scheduler. CLI: \`node cli.js\`. launchd service: \`ai.openclaw.scheduler\`. | Any scheduler/cron work |
| \`${schedulerPath}/cli.js\` | Queue + run operations: \`msg send\`, \`msg inbox\`, \`runs running\`, \`runs stale\`. | Day-to-day scheduler operations |
| \`${schedulerPath}/scripts/inbox-consumer.mjs\` | Drains queue messages for one agent and delivers to Telegram. | Queue/inbox consumption |
| \`${schedulerPath}/scripts/stuck-run-detector.mjs\` | Detects stale \`running\` runs and exits non-zero for alerts. | Run health monitoring |`;

// Try inserting before a common section header, fall back to append
const idxAnchors = ['### Automation', '### Memory', '## 🔗', '---\n\n## 🔗'];
let idxResult = false;
if (fs.existsSync(workspaceIndex)) {
  const existing = fs.readFileSync(workspaceIndex, 'utf8');
  if (existing.includes('inbox-consumer.mjs') || existing.includes('stuck-run-detector.mjs')) {
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
    await initDb();

    const { listJobs } = await import('./jobs.js');
    const existingNames = listJobs().map(r => r.name);

    // Inbox Consumer
    const icScript = path.join(schedulerPath, 'scripts', 'inbox-consumer.mjs');
    const icName = 'Inbox Consumer';
    if (existingNames.includes(icName)) {
      skip(`"${icName}" job already exists`);
    } else if (!fs.existsSync(icScript)) {
      warn(`inbox-consumer.mjs not found at ${icScript}`);
      warn('Install is incomplete. Re-clone scheduler repo or add the job manually.');
    } else {
      createJob({
        name: icName,
        schedule_cron: '*/5 * * * *',
        session_target: 'shell',
        payload_message: `node ${icScript} --to ${deliverTo}`,
        payload_timeout_seconds: 60,
        delivery_mode: 'announce',
        delivery_channel: 'telegram',
        delivery_to: deliverTo,
        run_timeout_ms: 120000,
        enabled: true,
      });
      ok(`Created "${icName}" job (*/5 * * * *)`);
    }

    // Stuck Run Detector
    const srdName = 'Stuck Run Detector';
    const srdScript = path.join(schedulerPath, 'scripts', 'stuck-run-detector.mjs');
    const srdCmd = `node ${srdScript} --threshold-min 45`;  // coding tasks regularly take 30m+
    if (existingNames.includes(srdName)) {
      skip(`"${srdName}" job already exists`);
    } else if (!fs.existsSync(srdScript)) {
      warn(`stuck-run-detector.mjs not found at ${srdScript}`);
      warn('Install is incomplete. Re-clone scheduler repo or add the job manually.');
    } else {
      createJob({
        name: srdName,
        schedule_cron: '*/10 * * * *',
        session_target: 'shell',
        payload_message: srdCmd,
        payload_timeout_seconds: 30,
        delivery_mode: 'announce',
        delivery_channel: 'telegram',
        delivery_to: deliverTo,
        run_timeout_ms: 120000,
        enabled: true,
      });
      ok(`Created "${srdName}" job (*/10 * * * *)`);
    }
  } catch (err) {
    warn(`Job creation failed: ${err.message}`);
  }
}

print();

// ─── Step 5: Service / auto-start ────────────────────────────────────────────

const platform = process.platform;
const nodePath  = process.execPath;
const indexPath = path.join(schedulerPath, 'dispatcher.js');
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
let macServiceSummary = null;

// ── macOS ──────────────────────────────────────────────────────────────────
if (platform === 'darwin') {
  print('── Step 5: Service (macOS launchd) ─────────────────────');
  const serviceUser = os.userInfo().username;
  const serviceUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gatewayToken = getGatewayToken(os.homedir());
  const envPath = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  const serviceModes = {
    agent: {
      mode: 'agent',
      title: 'LaunchAgent',
      label: 'ai.openclaw.scheduler',
      plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.scheduler.plist'),
      domain: serviceUid == null ? null : `gui/${serviceUid}`,
      installPrompt: 'Install LaunchAgent (recommended for a personal Mac with auto-login)?',
      comment: 'OpenClaw Scheduler -- LaunchAgent (best for workstation/auto-login use)',
      installMode: 'user',
    },
    daemon: {
      mode: 'daemon',
      title: 'LaunchDaemon',
      label: 'ai.openclaw.scheduler',
      plistPath: '/Library/LaunchDaemons/ai.openclaw.scheduler.plist',
      domain: 'system',
      installPrompt: 'Install LaunchDaemon (recommended for a headless Mac or startup before login)?',
      comment: 'OpenClaw Scheduler -- LaunchDaemon (survives headless reboots)',
      installMode: 'system',
    },
  };
  const existingModes = Object.values(serviceModes).filter(cfg => fs.existsSync(cfg.plistPath));
  let selectedServiceMode = setupOptions.serviceMode;
  if (!selectedServiceMode) {
    print('  Choose how the scheduler should start on macOS:');
    print('  • agent  = user LaunchAgent (best for personal Macs with auto-login)');
    print('  • daemon = system LaunchDaemon (best for headless or pre-login startup)');
    print('  • skip   = do not install a service right now');
    selectedServiceMode = (await ask('Service mode', 'agent')).toLowerCase();
    while (!VALID_MAC_SERVICE_MODES.has(selectedServiceMode)) {
      warn('Choose agent, daemon, or skip.');
      selectedServiceMode = (await ask('Service mode', 'agent')).toLowerCase();
    }
  }

  if (selectedServiceMode === 'skip') {
    skip('Skipped macOS service install');
    print('  Re-run later with: node setup.mjs --service-mode agent');
    print('                 or: node setup.mjs --service-mode daemon');
  } else {
    const service = serviceModes[selectedServiceMode];
    const otherModes = existingModes.filter(cfg => cfg.mode !== service.mode);
    if (otherModes.length) {
      warn(`Detected existing ${otherModes.map(cfg => cfg.title).join(' + ')} install(s):`);
      for (const cfg of otherModes) {
        print(`  • ${cfg.title}: ${cfg.plistPath}`);
      }
      const continueWithDuplicate = await confirm(`Install ${service.title} anyway? (This can run two schedulers if you leave both enabled)`);
      if (!continueWithDuplicate) {
        skip(`Skipped ${service.title} install`);
        if (otherModes.length > 0) {
          print(`  Leaving existing ${otherModes[0].title} in place.`);
          macServiceSummary = otherModes[0];
        }
      } else {
        macServiceSummary = service;
      }
    } else {
      macServiceSummary = service;
    }

    if (macServiceSummary && fs.existsSync(service.plistPath)) {
      skip(`${service.title} already installed`);
      print(`  Path: ${service.plistPath}`);
      if (service.domain) {
        const restartPrefix = service.mode === 'daemon' ? 'sudo ' : '';
        print(`  To restart: ${restartPrefix}launchctl kickstart -k ${service.domain}/${service.label}`);
      }
    } else if (macServiceSummary) {
      const install = await confirm(service.installPrompt);
      if (install) {
        const tokenXml = gatewayToken
          ? `    <key>OPENCLAW_GATEWAY_TOKEN</key>\n    <string>${xmlEscape(gatewayToken)}</string>\n`
          : '';
        const userXml = service.mode === 'daemon'
          ? `  <key>UserName</key>\n  <string>${xmlEscape(serviceUser)}</string>\n`
          : '';
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Comment</key>
  <string>${xmlEscape(service.comment)}</string>
  <key>Label</key>
  <string>${service.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>--no-warnings</string>
    <string>${xmlEscape(indexPath)}</string>
  </array>
${userXml}  <key>WorkingDirectory</key>
  <string>${xmlEscape(schedulerPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(os.homedir())}</string>
    <key>PATH</key>
    <string>${xmlEscape(envPath)}</string>
    <key>OPENCLAW_GATEWAY_URL</key>
    <string>${xmlEscape(gatewayUrl)}</string>
    <key>SCHEDULER_DB</key>
    <string>${xmlEscape(schedulerDbPath)}</string>
${tokenXml}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>`;
        if (service.mode === 'daemon') {
          const tmpPlistPath = path.join(os.tmpdir(), 'ai.openclaw.scheduler.plist');
          fs.writeFileSync(tmpPlistPath, plist);
          try {
            execSync(`sudo install -o root -g wheel -m 644 "${tmpPlistPath}" "${service.plistPath}"`, { stdio: 'inherit' });
            execSync(`sudo launchctl bootstrap ${service.domain} "${service.plistPath}"`, { stdio: 'inherit' });
            ok(`${service.title} installed and bootstrapped`);
          } catch (err) {
            ok(`${service.title} plist written → ${tmpPlistPath}`);
            warn(`Auto-bootstrap failed: ${err.message.trim()}`);
            warn(`Run manually: sudo install -o root -g wheel -m 644 "${tmpPlistPath}" "${service.plistPath}"`);
            warn(`Then: sudo launchctl bootstrap ${service.domain} "${service.plistPath}"`);
          }
        } else {
          fs.mkdirSync(path.dirname(service.plistPath), { recursive: true });
          fs.writeFileSync(service.plistPath, plist);
          try {
            execSync(`launchctl bootstrap ${service.domain} "${service.plistPath}"`, { stdio: 'inherit' });
            ok(`${service.title} installed and bootstrapped`);
          } catch (err) {
            ok(`${service.title} plist written → ${service.plistPath}`);
            warn(`Auto-bootstrap failed: ${err.message.trim()}`);
            warn(`Run manually: launchctl bootstrap ${service.domain} "${service.plistPath}"`);
          }
        }
        print(`  Logs: ${logPath}`);
      } else {
        skip(`Skipped ${service.title} install — run again to install later`);
        macServiceSummary = null;
      }
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

  const gatewayToken = getGatewayToken(os.homedir());

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
ExecStart=${nodePath} --no-warnings ${indexPath}
Environment=OPENCLAW_GATEWAY_URL=${gatewayUrl}${gatewayToken ? `\nEnvironment=OPENCLAW_GATEWAY_TOKEN=${gatewayToken}` : ''}
Environment=SCHEDULER_DB=${schedulerDbPath}
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
            `--log "${logPath}"`,
            {
              stdio: 'inherit',
              env: {
                ...process.env,
                OPENCLAW_GATEWAY_URL: gatewayUrl,
                SCHEDULER_DB: schedulerDbPath,
              },
            }
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
    print('  • Or run manually:  node dispatcher.js &');
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
  print('  Start manually: node dispatcher.js');
}

print();

// ─── Done ─────────────────────────────────────────────────────────────────────

print('── Done! ───────────────────────────────────────────────');
print();
print('Next steps:');

if (platform === 'darwin') {
  if (macServiceSummary?.domain) {
    const prefix = macServiceSummary.mode === 'daemon' ? 'sudo ' : '';
    print(`  • Service mode:   ${macServiceSummary.title}`);
    print(`  • Check service:  ${prefix}launchctl print ${macServiceSummary.domain}/${macServiceSummary.label}`);
    print(`  • Restart:        ${prefix}launchctl kickstart -k ${macServiceSummary.domain}/${macServiceSummary.label}`);
  } else {
    print('  • Install later:  node setup.mjs --service-mode agent');
    print('                    node setup.mjs --service-mode daemon');
  }
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
print('  • Queue test:     node cli.js msg send system main "setup smoke test"');
print(`  • Logs:           ${logPath}`);
print('  • Docs:           README.md');
print();
print('── ⚠️  Important: activate memory changes ───────────────');
print();
print('  Memory file changes (MEMORY.md, workspace-index.md) only take');
print('  effect in NEW sessions. Your agent\'s current session won\'t see');
print('  them until it explicitly re-reads the files.');
print();
print('  Tell your agent now:');
print();
if (workspacePath) {
  print(`    "Read ${path.join(workspacePath, 'MEMORY.md')} and`);
  print(`     ${path.join(workspacePath, 'memory', 'workspace-index.md')} —`);
  print('     scheduler queue pattern notes were added. Load them into your context."');
} else {
  print('    "Read your MEMORY.md and memory/workspace-index.md —');
  print('     scheduler queue pattern notes were added. Load them into your context."');
}
print();
print('  Future sessions will pick it up automatically via memory_search.');
print();

rl.close();
