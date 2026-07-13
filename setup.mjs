#!/usr/bin/env node
/**
 * OpenClaw Scheduler -- Interactive Setup Wizard
 *
 * Run from the scheduler directory:
 *   node setup.mjs
 *
 * What it does:
 *  1. Runs DB migrations (creates/upgrades scheduler.db)
 *  2. Appends scheduler queue/consumer entries to MEMORY.md + workspace-index.md
 *  3. Creates Inbox Consumer + Stuck Run Detector scheduler jobs
 *  4. Installs a macOS launchd or Linux/WSL2 service (optional)
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

import { fileURLToPath } from 'url';
import { ensureSchedulerDbParent, resolveSchedulerDbPath, resolveServiceWorkingDirectory } from './paths.js';
import { parseGatewayBaseUrl } from './identifiers.js';
import { createJob } from './jobs.js';
import { initDb } from './db.js';
import {
  MACOS_CHMOD_PATH,
  MACOS_LAUNCHCTL_PATH,
  MACOS_SUDO_PATH,
  buildLaunchctlBootstrapArgs,
  buildNpmConfigGetArgs,
  buildPm2StartArgs,
  buildSudoChmodPrivateArgs,
  buildSudoInstallArgs,
  buildSudoLaunchctlBootstrapArgs,
  createSetupCommandRunner,
  encodeLaunchdPlistValue,
  formatPosixCommand,
  renderSystemdUserService,
} from './setup-service-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_MAC_SERVICE_MODES = new Set(['agent', 'daemon', 'skip']);
const runSetupCommand = createSetupCommandRunner(execFileSync);

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

const platform = process.platform;
const isWSL = platform === 'linux' && Boolean(
  process.env.WSL_DISTRO_NAME
  || process.env.WSL_INTEROP
  || (() => {
    try {
      return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch {
      return false;
    }
  })()
);
const wslVersion = isWSL
  ? (() => {
      try {
        return fs.readFileSync('/proc/version', 'utf8').includes('WSL2') ? 2 : 1;
      } catch {
        return null;
      }
    })()
  : null;

if (platform === 'win32') {
  process.stderr.write('Native Windows is not supported. Install WSL2, open the Linux distribution, and run setup there.\n');
  process.stderr.write('See INSTALL-WINDOWS.md for the supported installation path.\n');
  process.exit(1);
}
if (isWSL && wslVersion === 1) {
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  process.stderr.write('WSL1 is not supported. Convert this distribution from PowerShell before running setup:\n');
  process.stderr.write(`  wsl --set-version "${distro}" 2\n`);
  process.stderr.write('Then run wsl --shutdown, reopen WSL2, and run setup again.\n');
  process.exit(1);
}

// --- Helpers ------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(resolve => {
  const hint = def ? ` (${def})` : '';
  rl.question(`${q}${hint}: `, ans => resolve(ans.trim() || def || ''));
});

async function askGatewayUrl(defaultValue) {
  while (true) {
    const candidate = await ask('Gateway URL', defaultValue);
    try {
      return parseGatewayBaseUrl(candidate, 'Gateway URL').href.replace(/\/$/u, '');
    } catch (error) {
      warn(error.message);
    }
  }
}
const confirm = async (q) => {
  const ans = await ask(`${q} [y/N]`);
  return /^y(es)?$/i.test(ans);
};
const print = (msg = '') => console.log(msg);
const ok   = (msg) => console.log(`  [ok] ${msg}`);
const warn = (msg) => console.log(`  [WARN] ${msg}`);
const skip = (msg) => console.log(`  [skip] ${msg}`);

function appendIfMissing(filePath, anchor, content) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(anchor)) return 'exists';
  fs.appendFileSync(filePath, '\n' + content + '\n');
  return true;
}

function getNpmConfigValue(key) {
  try {
    return runSetupCommand('npm', buildNpmConfigGetArgs(key), { encoding: 'utf8' }).trim();
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

// --- Main ---------------------------------------------------------------------

print();
print('+======================================================+');
print('|     OpenClaw Scheduler -- Setup Wizard               |');
print('+======================================================+');
print();
print('This wizard will:');
print('  * Run DB migrations');
print('  * Add scheduler queue + consumer notes to agent memory files');
print('  * Create Inbox Consumer + Stuck Run Detector jobs');
print('  * Install a macOS launchd or Linux/WSL2 service (optional)');
print();

// --- Step 1: Paths ------------------------------------------------------------

print('-- Step 1: Paths ---------------------------------------');
const schedulerInstallRoot = __dirname;
const serviceWorkingDirectory = resolveServiceWorkingDirectory({ env: process.env, moduleDir: schedulerInstallRoot });
const defaultWorkspace = path.join(os.homedir(), '.openclaw', 'workspace');
const workspacePath = await ask('Workspace path', defaultWorkspace);
const defaultGateway = 'http://127.0.0.1:18789';
const gatewayUrl = await askGatewayUrl(defaultGateway);
const deliverTo = await ask('Telegram delivery ID for alerts (user or group ID, or blank to skip)');
const schedulerDbPath = resolveSchedulerDbPath({ env: process.env });
if (schedulerDbPath !== ':memory:') ensureSchedulerDbParent(schedulerDbPath);

print();
print(`  Scheduler install root: ${schedulerInstallRoot}`);
print(`  Service working dir:   ${serviceWorkingDirectory}`);
print(`  Workspace:             ${workspacePath}`);
print(`  Gateway:               ${gatewayUrl}`);
print(`  Deliver to:            ${deliverTo || '(none -- skipping job creation)'}`);
print();

// --- Preflight: npm install behavior -----------------------------------------

print('-- Preflight: npm install behavior -------------------');
const ignoreScripts = getNpmConfigValue('ignore-scripts').toLowerCase();
if (ignoreScripts === 'true') {
  warn('Detected npm config: ignore-scripts=true');
  warn('better-sqlite3 requires install scripts to build/load native bindings.');
  warn('Recommended fix:');
  warn(`  ${formatPosixCommand('npm', [
    'rebuild', '--prefix', schedulerInstallRoot, 'better-sqlite3', '--ignore-scripts=false',
  ])}`);
  const continueAnyway = await confirm('Continue setup anyway?');
  if (!continueAnyway) {
    print('Setup aborted. Run the scoped rebuild command, then rerun setup.');
    rl.close();
    process.exit(1);
  }
} else {
  ok('npm install scripts are enabled');
}
print();

// --- Step 2: DB migrations ----------------------------------------------------

print('-- Step 2: Database migrations -------------------------');
try {
  const { setDbPath } = await import(path.join(schedulerInstallRoot, 'db.js'));
  setDbPath(schedulerDbPath);
  const migrate = (await import(path.join(schedulerInstallRoot, 'migrate-consolidate.js'))).default;
  const ran = migrate();
  if (ran) {
    ok(`Migrations applied -> ${schedulerDbPath}`);
  } else {
    ok(`DB already up to date -> ${schedulerDbPath}`);
  }
} catch (err) {
  warn(`Migration failed: ${err.message}`);
  warn('Continuing -- you can run migrations manually: node migrate-consolidate.js');
}
print();

// --- Step 3: Memory files ----------------------------------------------------

print('-- Step 3: Agent memory files --------------------------');

const memoryMd = path.join(workspacePath, 'MEMORY.md');
const memoryEntry = `- **Scheduler Queue Pattern:** Use \`node ${schedulerInstallRoot}/cli.js msg send <from> <to> "body"\` for signal-only queue entries.
  Inbox Consumer (\`${schedulerInstallRoot}/scripts/inbox-consumer.mjs\`) drains pending queue messages to Telegram.
  Stuck Run Detector (\`${schedulerInstallRoot}/scripts/stuck-run-detector.mjs\`) alerts on stale \`running\` runs.`;

const memResult = appendIfMissing(memoryMd, 'Scheduler Queue Pattern', memoryEntry);
if (memResult === true)       ok('Appended scheduler queue entry -> MEMORY.md');
else if (memResult === 'exists') skip('Scheduler queue entry already in MEMORY.md');
else                          warn(`MEMORY.md not found at ${memoryMd} -- skipping`);

const workspaceIndex = path.join(workspacePath, 'memory', 'workspace-index.md');
const indexSection = `### Scheduler & Dispatch
> Covers: standalone scheduler, message queue, inbox consumer

| File | Covers | Load |
|------|--------|------|
| \`${schedulerInstallRoot}/\` | Standalone SQLite scheduler. CLI: \`node cli.js\`. launchd service: \`ai.openclaw.scheduler\`. | Any scheduler/cron work |
| \`${schedulerInstallRoot}/cli.js\` | Queue + run operations: \`msg send\`, \`msg inbox\`, \`runs running\`, \`runs stale\`. | Day-to-day scheduler operations |
| \`${schedulerInstallRoot}/scripts/inbox-consumer.mjs\` | Drains queue messages for one agent and delivers to Telegram. | Queue/inbox consumption |
| \`${schedulerInstallRoot}/scripts/stuck-run-detector.mjs\` | Detects stale \`running\` runs and exits non-zero for alerts. | Run health monitoring |`;

// Try inserting before a common section header, fall back to append.
// NOTE: the link emoji anchors must match the actual markdown heading in
// workspace index files -- do not replace with ASCII.
const idxAnchors = ['### Automation', '### Memory', '## \u{1F517}', '---\n\n## \u{1F517}'];
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

if (idxResult === true)        ok(`Added Scheduler & Dispatch section -> workspace-index.md`);
else if (idxResult === 'exists') skip('Scheduler section already in workspace-index.md');
else                           warn(`workspace-index.md not found at ${workspaceIndex} -- skipping`);

print();

// --- Step 4: Scheduler jobs --------------------------------------------------

print('-- Step 4: Scheduler jobs ------------------------------');

if (!deliverTo) {
  skip('No delivery ID provided -- skipping job creation');
  skip('You can add jobs manually with: node cli.js jobs add \'{ ... }\'');
} else {
  try {
    await initDb();

    const { listJobs } = await import('./jobs.js');
    const existingNames = listJobs().map(r => r.name);

    // Inbox Consumer
    const icScript = path.join(schedulerInstallRoot, 'scripts', 'inbox-consumer.mjs');
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
        payload_message: formatPosixCommand(process.execPath, [icScript, '--to', deliverTo]),
        payload_timeout_seconds: 60,
        delivery_mode: 'announce',
        delivery_channel: 'telegram',
        delivery_to: deliverTo,
        run_timeout_ms: 120000,
        enabled: true,
        origin: 'system',
      });
      ok(`Created "${icName}" job (*/5 * * * *)`);
    }

    // Stuck Run Detector
    const srdName = 'Stuck Run Detector';
    const srdScript = path.join(schedulerInstallRoot, 'scripts', 'stuck-run-detector.mjs');
    const srdCmd = formatPosixCommand(process.execPath, [srdScript, '--threshold-min', '45']);
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
        origin: 'system',
      });
      ok(`Created "${srdName}" job (*/10 * * * *)`);
    }
  } catch (err) {
    warn(`Job creation failed: ${err.message}`);
  }
}

print();

// --- Step 5: Service / auto-start --------------------------------------------

const nodePath  = process.execPath;
const indexPath = path.join(schedulerInstallRoot, 'dispatcher.js');
const logPath   = platform === 'win32'
  ? path.join(os.tmpdir(), 'openclaw-scheduler.log')
  : '/tmp/openclaw-scheduler.log';

let macServiceSummary = null;

// -- macOS ------------------------------------------------------------------
if (platform === 'darwin') {
  print('-- Step 5: Service (macOS launchd) ---------------------');
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
  const hardenExistingServiceFile = (service) => {
    try {
      if (service.mode === 'daemon') {
        runSetupCommand(
          MACOS_SUDO_PATH,
          buildSudoChmodPrivateArgs(service.plistPath),
          { stdio: 'inherit' },
        );
      } else {
        fs.chmodSync(service.plistPath, 0o600);
      }
      ok(`${service.title} plist permissions set to 0600`);
    } catch (error) {
      const chmodCommand = service.mode === 'daemon'
        ? formatPosixCommand(MACOS_SUDO_PATH, buildSudoChmodPrivateArgs(service.plistPath))
        : formatPosixCommand(MACOS_CHMOD_PATH, ['0600', service.plistPath]);
      warn(`Could not set ${service.title} plist permissions: ${error.message}`);
      warn(`Run manually: ${chmodCommand}`);
    }
  };
  let selectedServiceMode = setupOptions.serviceMode;
  if (!selectedServiceMode) {
    print('  Choose how the scheduler should start on macOS:');
    print('  * agent  = user LaunchAgent (best for personal Macs with auto-login)');
    print('  * daemon = system LaunchDaemon (best for headless or pre-login startup)');
    print('  * skip   = do not install a service right now');
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
        print(`  * ${cfg.title}: ${cfg.plistPath}`);
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

    if (macServiceSummary && macServiceSummary !== service) {
      // User declined new service and kept existing one -- skip install block
      hardenExistingServiceFile(macServiceSummary);
    } else if (macServiceSummary && fs.existsSync(service.plistPath)) {
      hardenExistingServiceFile(service);
      skip(`${service.title} already installed`);
      print(`  Path: ${service.plistPath}`);
      if (service.domain) {
        const restartArgs = ['kickstart', '-k', `${service.domain}/${service.label}`];
        const restartCommand = service.mode === 'daemon'
          ? formatPosixCommand(MACOS_SUDO_PATH, ['--', MACOS_LAUNCHCTL_PATH, ...restartArgs])
          : formatPosixCommand(MACOS_LAUNCHCTL_PATH, restartArgs);
        print(`  To restart: ${restartCommand}`);
      }
    } else if (macServiceSummary) {
      const install = await confirm(service.installPrompt);
      if (install) {
        const tokenXml = gatewayToken
          ? `    <key>OPENCLAW_GATEWAY_TOKEN</key>\n    <string>${encodeLaunchdPlistValue(gatewayToken, 'gateway token')}</string>\n`
          : '';
        const userXml = service.mode === 'daemon'
          ? `  <key>UserName</key>\n  <string>${encodeLaunchdPlistValue(serviceUser, 'service user')}</string>\n`
          : '';
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Comment</key>
  <string>${encodeLaunchdPlistValue(service.comment, 'service comment')}</string>
  <key>Label</key>
  <string>${service.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${encodeLaunchdPlistValue(nodePath, 'Node executable path')}</string>
    <string>--no-warnings</string>
    <string>${encodeLaunchdPlistValue(indexPath, 'dispatcher path')}</string>
  </array>
${userXml}  <key>WorkingDirectory</key>
  <string>${encodeLaunchdPlistValue(serviceWorkingDirectory, 'service working directory')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${encodeLaunchdPlistValue(os.homedir(), 'home directory')}</string>
    <key>PATH</key>
    <string>${encodeLaunchdPlistValue(envPath, 'service PATH')}</string>
    <key>OPENCLAW_GATEWAY_URL</key>
    <string>${encodeLaunchdPlistValue(gatewayUrl, 'gateway URL')}</string>
    <key>SCHEDULER_DB</key>
    <string>${encodeLaunchdPlistValue(schedulerDbPath, 'scheduler database path')}</string>
${tokenXml}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${encodeLaunchdPlistValue(logPath, 'stdout log path')}</string>
  <key>StandardErrorPath</key>
  <string>${encodeLaunchdPlistValue(logPath, 'stderr log path')}</string>
</dict>
</plist>`;
        if (service.mode === 'daemon') {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-'));
          const tmpPlistPath = path.join(tmpDir, 'ai.openclaw.scheduler.plist');
          fs.writeFileSync(tmpPlistPath, plist, { mode: 0o600 });
          const installArgs = buildSudoInstallArgs(tmpPlistPath, service.plistPath);
          const bootstrapArgs = buildSudoLaunchctlBootstrapArgs(service.domain, service.plistPath);
          try {
            runSetupCommand(MACOS_SUDO_PATH, installArgs, { stdio: 'inherit' });
            runSetupCommand(MACOS_SUDO_PATH, bootstrapArgs, { stdio: 'inherit' });
            try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
            ok(`${service.title} installed and bootstrapped`);
          } catch (err) {
            ok(`${service.title} plist written -> ${tmpPlistPath}`);
            warn(`Auto-bootstrap failed: ${err.message.trim()}`);
            warn(`Run manually: ${formatPosixCommand(MACOS_SUDO_PATH, installArgs)}`);
            warn(`Then: ${formatPosixCommand(MACOS_SUDO_PATH, bootstrapArgs)}`);
          }
        } else {
          fs.mkdirSync(path.dirname(service.plistPath), { recursive: true });
          fs.writeFileSync(service.plistPath, plist, { mode: 0o600 });
          const bootstrapArgs = buildLaunchctlBootstrapArgs(service.domain, service.plistPath);
          try {
            runSetupCommand(MACOS_LAUNCHCTL_PATH, bootstrapArgs, { stdio: 'inherit' });
            ok(`${service.title} installed and bootstrapped`);
          } catch (err) {
            ok(`${service.title} plist written -> ${service.plistPath}`);
            warn(`Auto-bootstrap failed: ${err.message.trim()}`);
            warn(`Run manually: ${formatPosixCommand(MACOS_LAUNCHCTL_PATH, bootstrapArgs)}`);
          }
        }
        print(`  Logs: ${logPath}`);
      } else {
        skip(`Skipped ${service.title} install -- run again to install later`);
        macServiceSummary = null;
      }
    }
  }

// -- Linux ------------------------------------------------------------------
} else if (platform === 'linux') {
  if (isWSL) {
    const wslLabel = wslVersion ? `WSL${wslVersion}` : 'WSL';
    print(`-- Step 5: Service (${wslLabel}) ------------------------------`);
    if (wslVersion === 1) {
      warn('WSL1 detected. OpenClaw Scheduler supports Windows through WSL2 only.');
      print(`  Convert this distribution from PowerShell: wsl --set-version "${process.env.WSL_DISTRO_NAME || 'Ubuntu'}" 2`);
      print('  Then run wsl --shutdown, reopen WSL2, and run setup again.');
    } else {
      print('  WSL2 detected. Systemd is supported if enabled in /etc/wsl.conf.');
      print('  If not enabled: add [boot] systemd=true to /etc/wsl.conf, then wsl --shutdown.');
    }
  } else {
    print('-- Step 5: Service (Linux) -----------------------------');
  }

  const gatewayToken = getGatewayToken(os.homedir());

  // Detect whether systemd user session is available
  let hasSystemd = false;
  if (isWSL && wslVersion === 1) {
    hasSystemd = false; // WSL1 never has systemd
  } else {
    try {
      runSetupCommand('systemctl', ['--user', 'status'], { stdio: 'ignore' });
      hasSystemd = true;
    } catch {}
    if (!hasSystemd) {
      try {
        runSetupCommand('systemctl', ['--user', 'list-units'], { stdio: 'ignore' });
        hasSystemd = true;
      } catch {}
    }
  }

  // Check for PM2
  let hasPm2 = false;
  try {
    runSetupCommand('pm2', ['--version'], { stdio: 'ignore' });
    hasPm2 = true;
  } catch {}

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
        const unit = renderSystemdUserService({
          workingDirectory: serviceWorkingDirectory,
          nodePath,
          indexPath,
          gatewayUrl,
          gatewayToken,
          schedulerDbPath,
          logPath,
        });
        fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(unitPath, unit, { mode: 0o600 });
        try {
          runSetupCommand('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
          runSetupCommand(
            'systemctl',
            ['--user', 'enable', '--now', 'openclaw-scheduler.service'],
            { stdio: 'inherit' },
          );
          ok('systemd user service installed and started');
        } catch (err) {
          ok(`Unit file written -> ${unitPath}`);
          warn(`Auto-start failed: ${err.message.trim()}`);
          warn('Run manually:');
          warn('  systemctl --user daemon-reload');
          warn('  systemctl --user enable --now openclaw-scheduler');
        }
        print(`  Logs: ${logPath}  (or: journalctl --user -u openclaw-scheduler -f)`);
      } else {
        skip('Skipped -- run again to install later');
      }
    }
  } else if (hasPm2 && (!isWSL || wslVersion !== 1)) {
    print('  systemd user session not available -- using PM2');
    const pm2Name = 'openclaw-scheduler';
    let pm2Running = false;
    try {
      const out = runSetupCommand('pm2', ['list', '--no-color'], { encoding: 'utf8' });
      pm2Running = out.includes(pm2Name);
    } catch {}

    if (pm2Running) {
      skip(`PM2 process "${pm2Name}" already running`);
      print('  To restart: pm2 restart openclaw-scheduler');
    } else {
      const install = await confirm('Register with PM2 (auto-start on login)?');
      if (install) {
        try {
          runSetupCommand(
            'pm2',
            buildPm2StartArgs({
              indexPath,
              processName: pm2Name,
              workingDirectory: serviceWorkingDirectory,
              logPath,
            }),
            {
              stdio: 'inherit',
              env: {
                ...process.env,
                OPENCLAW_GATEWAY_URL: gatewayUrl,
                SCHEDULER_DB: schedulerDbPath,
              },
            }
          );
          runSetupCommand('pm2', ['save'], { stdio: 'inherit' });
          ok('PM2 process started and saved');
          print('  Run `pm2 startup` and follow the instructions to survive reboots.');
        } catch (err) {
          warn(`PM2 start failed: ${err.message.trim()}`);
        }
      } else {
        skip('Skipped -- run again to install later');
      }
    }
  } else {
    if (isWSL && wslVersion === 1) {
      warn('Service installation skipped because WSL1 is unsupported.');
      print('  Convert the distribution to WSL2, enable systemd, and run setup again.');
      print('  See INSTALL-WINDOWS.md for the supported setup.');
    } else {
      warn('Neither systemd user session nor PM2 found');
      print('  Options:');
      print('  * Install PM2:  npm install -g pm2');
      print('  * Or run manually:  node dispatcher.js &');
      print('  * See INSTALL-LINUX.md for systemd setup without a user session');
    }
  }

// -- Windows (native) -------------------------------------------------------
} else if (platform === 'win32') {
  print('-- Step 5: Service (Windows) ---------------------------');
  print();
  warn('Native Windows detected.');
  print('  OpenClaw Scheduler is designed to run inside WSL (Windows Subsystem for Linux).');
  print('  Running natively on Windows is not supported.');
  print();
  print('  Setup steps:');
  print('  1. Install WSL2:  wsl --install  (in PowerShell as Admin)');
  print('  2. Open your WSL terminal and run this wizard again from there:');
  print(`     cd ${schedulerInstallRoot.replace(/\\/g, '/')}`);
  print('     node setup.mjs');
  print();
  print('  WSL2 with systemd enabled gives the best experience (auto-start on login).');
  print('  See INSTALL-WINDOWS.md for the full WSL2 + systemd setup guide.');

// -- Unknown ----------------------------------------------------------------
} else {
  skip(`Unsupported platform: ${platform}`);
  print('  Start manually: node dispatcher.js');
}

print();

// --- Done ---------------------------------------------------------------------

print('-- Done! -----------------------------------------------');
print();
print('Next steps:');

if (platform === 'darwin') {
  if (macServiceSummary?.domain) {
    const checkArgs = ['print', `${macServiceSummary.domain}/${macServiceSummary.label}`];
    const restartArgs = ['kickstart', '-k', `${macServiceSummary.domain}/${macServiceSummary.label}`];
    const formatLaunchctl = args => macServiceSummary.mode === 'daemon'
      ? formatPosixCommand(MACOS_SUDO_PATH, ['--', MACOS_LAUNCHCTL_PATH, ...args])
      : formatPosixCommand(MACOS_LAUNCHCTL_PATH, args);
    print(`  * Service mode:   ${macServiceSummary.title}`);
    print(`  * Check service:  ${formatLaunchctl(checkArgs)}`);
    print(`  * Restart:        ${formatLaunchctl(restartArgs)}`);
  } else {
    print('  * Install later:  node setup.mjs --service-mode agent');
    print('                    node setup.mjs --service-mode daemon');
  }
} else if (platform === 'linux') {
  if (isWSL) {
    if (wslVersion === 1) {
      print('  * Convert this distribution to WSL2 before running the scheduler service');
      print('  * Setup guide:    INSTALL-WINDOWS.md');
    } else {
      print('  * Check service:  systemctl --user status openclaw-scheduler  (or: pm2 status)');
      print('  * Logs:           journalctl --user -u openclaw-scheduler -f   (or: pm2 logs)');
      print('  * Note: if WSL session closes, restart with: systemctl --user start openclaw-scheduler');
    }
  } else {
    print('  * Check service:  systemctl --user status openclaw-scheduler  (or: pm2 status)');
    print('  * Logs:           journalctl --user -u openclaw-scheduler -f   (or: pm2 logs)');
  }
} else if (platform === 'win32') {
  print('  * Run setup inside WSL -- see instructions above');
}

print('  * Scheduler CLI:  node cli.js status');
print('  * List jobs:      node cli.js jobs list');
print('  * Queue test:     node cli.js msg send system main "setup smoke test"');
print(`  * Logs:           ${logPath}`);
print('  * Docs:           README.md');
print();
print('-- [WARN] Important: activate memory changes -------------');
print();
print('  Memory file changes (MEMORY.md, workspace-index.md) only take');
print('  effect in NEW sessions. Your agent\'s current session won\'t see');
print('  them until it explicitly re-reads the files.');
print();
print('  Tell your agent now:');
print();
if (workspacePath) {
  print(`    "Read ${path.join(workspacePath, 'MEMORY.md')} and`);
  print(`     ${path.join(workspacePath, 'memory', 'workspace-index.md')} --`);
  print('     scheduler queue pattern notes were added. Load them into your context."');
} else {
  print('    "Read your MEMORY.md and memory/workspace-index.md --');
  print('     scheduler queue pattern notes were added. Load them into your context."');
}
print();
print('  Future sessions will pick it up automatically via memory_search.');
print();

rl.close();
