#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Dispatch subcommands — routed to dispatch/index.mjs
const DISPATCH_SUBCOMMANDS = new Set([
  'dispatch',
  'enqueue',
  'status',
  'stuck',
  'result',
  'sync',
  'done',
  'send',
  'steer',
  'heartbeat',
  'list',
]);

function printUsage() {
  process.stdout.write(`
openclaw-scheduler <command> [args]

Commands:
  setup            Run interactive setup wizard
  start            Start dispatcher loop
  migrate          Import OC cron jobs from ~/.openclaw/cron/jobs.json
  webhook-check    Run Telegram webhook health check / repair utility
  help             Show this help

Dispatch subcommands (routed to dispatch/index.mjs):
  dispatch <sub>   Explicit dispatch namespace
  enqueue          Spawn a sub-agent session (alias: dispatch enqueue)
  status           Query session status by label
  stuck            Find sessions running past threshold
  result           Get last assistant reply from a session
  send / steer     Send/steer a running session
  heartbeat        Check session liveness
  list             List all tracked labels
  sync             Reconcile labels.json with sessions store
  done             Agent-side completion signal

All other commands are forwarded to scheduler CLI (cli.js):
  openclaw-scheduler jobs list
  openclaw-scheduler runs running
  openclaw-scheduler msg send system main "hello"

Flags:
  --json               Output machine-readable JSON (supported by all CLI subcommands)

Environment:
  DISPATCH_CONFIG_DIR   Override dispatch config directory (default: ~/.openclaw/dispatch)
`);
}

function runScript(script, args) {
  const scriptPath = join(root, script);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(`Error: could not run ${script}: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

/**
 * Run dispatch/index.mjs with the given args.
 * Honors DISPATCH_CONFIG_DIR env var for config override.
 * Defaults to ~/.openclaw/dispatch if not set.
 */
function runDispatch(args) {
  const dispatchScript = join(root, 'dispatch', 'index.mjs');
  const env = { ...process.env };
  if (!env.DISPATCH_CONFIG_DIR) {
    env.DISPATCH_CONFIG_DIR = join(process.env.HOME || homedir(), '.openclaw', 'dispatch');
  }
  const result = spawnSync(process.execPath, [dispatchScript, ...args], {
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    process.stderr.write(`Error: could not run dispatch: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

const args = process.argv.slice(2);
const cmd = args[0] || '';

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printUsage();
  process.exit(0);
}

if (cmd === 'setup') {
  runScript('setup.mjs', args.slice(1));
}

if (cmd === 'start' || cmd === 'dispatcher') {
  runScript('dispatcher.js', args.slice(1));
}

if (cmd === 'migrate') {
  runScript('migrate.js', args.slice(1));
}

if (cmd === 'webhook-check') {
  runScript('scripts/telegram-webhook-check.mjs', args.slice(1));
}

if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
  process.exit(0);
}

// Route dispatch subcommands to dispatch/index.mjs
if (DISPATCH_SUBCOMMANDS.has(cmd)) {
  // If the command is 'dispatch', strip it and pass the rest
  // If it's a convenience alias (enqueue, status, etc.), pass everything as-is
  if (cmd === 'dispatch') {
    runDispatch(args.slice(1));
  } else {
    runDispatch(args);
  }
}

runScript('cli.js', args);
