#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Dispatch subcommands -- routed to dispatch/index.mjs
const DISPATCH_SUBCOMMANDS = new Set([
  'dispatch',
  'enqueue',
  'stuck',
  'result',
  'route',
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
  setup [--service-mode agent|daemon|skip]
                   Run interactive setup wizard
  start            Start dispatcher loop
  migrate          Import jobs through the OpenClaw cron CLI
                   Use --legacy-json [path] only for pre-SQLite jobs.json exports
  status           Show live scheduler state and queue/outbox diagnostics
  doctor           Validate DB schema, lease, queue, outbox, and approval health
  webhook-check    Run Telegram webhook health check / repair utility
  help             Show this help

Dispatch subcommands (routed to dispatch/index.mjs):
  dispatch <sub>   Explicit dispatch namespace
  enqueue          Spawn a sub-agent session (alias: dispatch enqueue)
  dispatch status  Query session status by label
  stuck            Find sessions running past threshold
  result           Get last assistant reply from a session
  route            Get durable authoritative source route for follow-up
  send / steer     Send/steer a running session
  heartbeat        Check session liveness
  list             List all tracked labels
  sync             Reconcile labels.json with sessions store
  done             Agent-side completion signal

All other commands are forwarded to scheduler CLI (cli.js):
  openclaw-scheduler jobs list
  openclaw-scheduler jobs validate --file job.json
  openclaw-scheduler runs running
  openclaw-scheduler msg send system main "hello"

Flags:
  --json               Output machine-readable JSON (supported by all CLI subcommands)

Environment:
  DISPATCH_CONFIG_DIR   Override dispatch config directory (default: ~/.openclaw/dispatch)
`);
}

function hasDispatchStatusLabel(args) {
  return args.some(arg => arg === '--label' || arg.startsWith('--label='));
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
const commandIndex = args[0] === '--json' ? 1 : 0;
const cmd = args[commandIndex] || '';
const commandArgs = [
  ...args.slice(0, commandIndex),
  ...args.slice(commandIndex + 1),
];
const dispatchCommandArgs = commandArgs[0] === '--json'
  ? [...commandArgs.slice(1), '--json']
  : commandArgs;

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printUsage();
  process.exit(0);
} else if (cmd === 'setup') {
  runScript('setup.mjs', commandArgs);
} else if (cmd === 'start' || cmd === 'dispatcher') {
  runScript('dispatcher.js', commandArgs);
} else if (cmd === 'migrate') {
  runScript('migrate.js', commandArgs);
} else if (cmd === 'webhook-check') {
  runScript('scripts/telegram-webhook-check.mjs', commandArgs);
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (commandArgs.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2)}\n`);
  } else {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
  }
  process.exit(0);
} else if (cmd === 'status' && hasDispatchStatusLabel(commandArgs)) {
  // Preserve the historical dispatch convenience alias:
  //   openclaw-scheduler status --label <name>
  // Without --label, "status" means scheduler health via cli.js.
  runDispatch([cmd, ...commandArgs]);
} else if (DISPATCH_SUBCOMMANDS.has(cmd)) {
  // Route dispatch subcommands to dispatch/index.mjs
  // If the command is 'dispatch', strip it and pass the rest
  // If it's a convenience alias (enqueue, status, etc.), pass everything as-is
  if (cmd === 'dispatch') {
    runDispatch(dispatchCommandArgs);
  } else {
    runDispatch([cmd, ...commandArgs]);
  }
} else {
  // All other commands forwarded to scheduler CLI (cli.js)
  runScript('cli.js', args);
}
