#!/usr/bin/env node
/**
 * chilisaus watcher — polls a session until done, outputs the result.
 *
 * Used by scheduler shell jobs for async delivery with retry + audit trail.
 * The scheduler runs this as a shell job with delivery_mode='announce-always',
 * so stdout is delivered via handleDelivery (retry, alias, audit).
 *
 * Detection strategy:
 *   1. Check `status --label` — if auto-resolved to 'done', use it
 *   2. If status says 'running' but session is idle (no activity for >60s),
 *      also check `result --label` for a lastReply — if found, session completed
 *      but status hasn't caught up yet (auto-resolve has 10min threshold)
 *
 * Usage: node watcher.mjs --label <label> [--timeout <seconds>] [--poll-interval <seconds>]
 *
 * Exit codes:
 *   0 — session completed, result on stdout
 *   1 — timeout or error
 *   2 — argument error
 */

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, 'index.mjs');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a.startsWith('--') && next && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
    }
  }
  return flags;
}

/**
 * Run a chilisaus subcommand and return parsed JSON, or null on failure.
 */
function chilisaus(subcmd, args) {
  try {
    const result = execFileSync('node', [INDEX_PATH, subcmd, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result.trim());
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Format and output the delivery message, then exit 0.
 */
function deliverResult(label, lastReply, fallbackSummary) {
  if (lastReply) {
    const maxLen = 3500;
    const reply = lastReply.length > maxLen
      ? lastReply.slice(0, maxLen) + '\n\n…[truncated]'
      : lastReply;
    process.stdout.write(`🌶️ *chilisaus* [${label}] completed:\n\n${reply}\n`);
  } else {
    process.stdout.write(
      `🌶️ *chilisaus* [${label}] completed (no reply captured)\n` +
      `Summary: ${fallbackSummary || 'none'}\n`
    );
  }
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────

const flags = parseFlags(process.argv.slice(2));
const label       = flags.label;
const timeoutS    = parseInt(flags.timeout || '600', 10);
const pollS       = parseInt(flags['poll-interval'] || '20', 10);

// How long a session must be idle before we proactively check result
const IDLE_RESULT_CHECK_MS = 60000;

if (!label) {
  process.stderr.write('[watcher] --label is required\n');
  process.exit(2);
}

const deadline = Date.now() + timeoutS * 1000;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;

process.stderr.write(`[watcher] watching label="${label}" timeout=${timeoutS}s poll=${pollS}s\n`);

while (Date.now() < deadline) {
  const status = chilisaus('status', ['--label', label]);

  if (!status?.ok) {
    consecutiveFailures++;
    process.stderr.write(`[watcher] status check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})\n`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      process.stdout.write(`⚠️ chilisaus [${label}] watcher: gave up after ${MAX_CONSECUTIVE_FAILURES} consecutive status failures\n`);
      process.exit(1);
    }
    await sleep(pollS * 1000);
    continue;
  }

  consecutiveFailures = 0;

  // ── Path 1: status auto-resolved to done ──────────────────
  if (status.status !== 'running') {
    const result = chilisaus('result', ['--label', label]);
    deliverResult(label, result?.lastReply, status.summary);
  }

  // ── Path 2: status says 'running' but session may be idle ─
  // If the session has no recent activity, proactively check for a result.
  // This catches the gap where the session completed but status hasn't
  // auto-resolved yet (10min threshold in checkSessionDone).
  const ageMs = status.liveness?.ageMs;
  if (ageMs != null && ageMs >= IDLE_RESULT_CHECK_MS) {
    process.stderr.write(`[watcher] ${label} idle for ${Math.round(ageMs / 1000)}s — checking result\n`);
    const result = chilisaus('result', ['--label', label]);
    if (result?.lastReply) {
      process.stderr.write(`[watcher] ${label} has result despite 'running' status — delivering\n`);
      deliverResult(label, result.lastReply, null);
    }
  }

  // Still running and active — log and wait
  if (ageMs != null) {
    process.stderr.write(`[watcher] ${label} still running (last activity ${Math.round((ageMs || 0) / 1000)}s ago)\n`);
  }

  await sleep(pollS * 1000);
}

// Timed out — try one last result check
const finalResult = chilisaus('result', ['--label', label]);
if (finalResult?.lastReply) {
  deliverResult(label, finalResult.lastReply, null);
}

process.stdout.write(`⏱ chilisaus [${label}] watcher timed out after ${timeoutS}s — session may still be running\n`);
process.exit(1);
