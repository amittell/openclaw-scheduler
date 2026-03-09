#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function printUsage() {
  process.stdout.write(`
openclaw-scheduler <command> [args]

Commands:
  setup            Run interactive setup wizard
  start            Start dispatcher loop
  migrate          Import OC cron jobs from ~/.openclaw/cron/jobs.json
  webhook-check    Run Telegram webhook health check / repair utility
  help             Show this help

All other commands are forwarded to scheduler CLI (cli.js):
  openclaw-scheduler status
  openclaw-scheduler jobs list
  openclaw-scheduler msg send system main "hello"
`);
}

function runScript(script, args) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (typeof result.status === 'number') {
    process.exit(result.status);
  }
  process.exit(1);
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

runScript('cli.js', args);
