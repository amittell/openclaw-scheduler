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

// ─── Step 5: LaunchAgent (macOS only) ────────────────────────────────────────

print('── Step 5: LaunchAgent (macOS) ─────────────────────────');

if (process.platform !== 'darwin') {
  skip('Not macOS — skipping LaunchAgent');
  print('  For Linux, use PM2 or systemd. See docs/platform-support.md');
} else {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.openclaw.scheduler.plist');
  if (fs.existsSync(plistPath)) {
    skip('LaunchAgent already installed');
    print(`  Path: ${plistPath}`);
    print('  To restart: launchctl kickstart -k gui/$UID/ai.openclaw.scheduler');
  } else {
    const install = await confirm('Install LaunchAgent (auto-start on login)?');
    if (install) {
      const nodePath = process.execPath;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.scheduler</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(schedulerPath, 'index.js')}</string>
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
  <string>/tmp/openclaw-scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw-scheduler.log</string>
</dict>
</plist>`;
      fs.writeFileSync(plistPath, plist);
      try {
        execSync(`launchctl load "${plistPath}"`);
        ok('LaunchAgent installed and loaded');
        print(`  Path: ${plistPath}`);
        print('  Logs: /tmp/openclaw-scheduler.log');
      } catch (err) {
        ok(`LaunchAgent plist written to ${plistPath}`);
        warn(`Auto-load failed (${err.message.trim()})`);
        warn(`Run manually: launchctl load "${plistPath}"`);
      }
    } else {
      skip('Skipped — run again to install later');
    }
  }
}

print();

// ─── Done ─────────────────────────────────────────────────────────────────────

print('── Done! ───────────────────────────────────────────────');
print();
print('Next steps:');
print('  • Start the scheduler:  launchctl kickstart -k gui/$UID/ai.openclaw.scheduler');
print('  • Check status:         node cli.js status');
print('  • List jobs:            node cli.js jobs list');
print('  • Test dispatch:        node chilisaus/index.mjs enqueue --label test --message "Hello"');
print('  • Docs:                 chilisaus/README.md');
print();

rl.close();
