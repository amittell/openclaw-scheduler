#!/usr/bin/env node
/**
 * chilisaus — Sub-agent dispatch CLI for OpenClaw Scheduler
 *
 * Control plane CLI backed directly by the scheduler DB.
 * All dispatch is tracked in the runs table; Loki gets every lifecycle event.
 *
 * Subcommands:
 *   enqueue    Create + immediately queue a one-shot isolated job
 *   status     Show last run(s) for a label
 *   stuck      List running runs past heartbeat threshold (exit 1 if any found)
 *   result     Get the summary/result of the last finished run for a label
 *   send       Put a message in a job agent's inbox (message queue)
 *   heartbeat  Manually touch the heartbeat for a running run
 *
 * Exit codes:
 *   0  — success / nothing stuck
 *   1  — stuck runs found, or hard error
 *   2  — argument error
 *
 * Usage: node chilisaus.mjs <subcommand> [options]
 * Full reference: docs/tools/chilisaus.md
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { createJob, getJob } from './jobs.js';
import { getStaleRuns, getRunsForJob, getRunningRuns, updateHeartbeat } from './runs.js';
import { sendMessage, getInbox } from './messages.js';
import { onStarted, onFinished, onStuck } from './chilisaus-hooks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`[chilisaus] ${msg}\n`);
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Parse --flag value pairs from argv */
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

/** Resolve a label to the most recent job with that name */
function jobByLabel(label) {
  const db = getDb();
  // Most recently created job with this name
  return db.prepare(
    'SELECT * FROM jobs WHERE name = ? ORDER BY created_at DESC LIMIT 1'
  ).get(label);
}

/** Get runs for a job name, most recent first */
function runsByLabel(label, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, j.name as job_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE j.name = ?
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(label, limit);
}

/** Get last finished run (status != 'running') for a label */
function lastFinishedRun(label) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, j.name as job_name
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE j.name = ? AND r.status != 'running'
    ORDER BY r.finished_at DESC
    LIMIT 1
  `).get(label);
}

// ── Subcommands ──────────────────────────────────────────────

/**
 * enqueue — create a one-shot isolated job and queue it for immediate dispatch.
 *
 * Flags:
 *   --label <string>         Required. Human-readable name (used for lookup + Loki labels)
 *   --message <string>       Required. Prompt sent to the agent
 *   --agent <string>         Agent ID (default: main)
 *   --thinking <string>      Reasoning level: low|high|xhigh (default: not set)
 *   --timeout <seconds>      Run timeout in seconds (default: 300)
 *   --deliver-to <target>    Delivery target for results (Telegram user/group ID)
 *   --delivery-mode <mode>   announce|announce-always|none (default: announce)
 *   --mode <fresh|reuse|auto>
 *       fresh  — always dispatch a new session (default)
 *       reuse  — look up last session_key for this label and pass it to the gateway
 *       auto   — try reuse, fall back to fresh if no prior session found
 *   --session-key <key>      Explicit session key override (bypasses ledger lookup)
 */
async function cmdEnqueue(flags) {
  const label = flags.label;
  const message = flags.message;
  if (!label)   die('--label is required', 2);
  if (!message) die('--message is required', 2);

  const agent       = flags.agent          || 'main';
  const thinking    = flags.thinking       || null;
  const timeoutS    = parseInt(flags.timeout || '300', 10);
  const deliverTo   = flags['deliver-to']  || null;
  const deliverMode = flags['delivery-mode'] || 'announce';
  const mode        = flags.mode           || 'fresh';

  // ── Session key resolution ──────────────────────────────────
  let preferredSessionKey = flags['session-key'] || null;

  if (!preferredSessionKey && (mode === 'reuse' || mode === 'auto')) {
    // Look up last successful/finished run for this label that has a session_key
    const db = getDb();
    const lastRun = db.prepare(`
      SELECT r.session_key FROM runs r
      JOIN jobs j ON r.job_id = j.id
      WHERE j.name = ?
        AND r.status IN ('ok', 'running')
        AND r.session_key IS NOT NULL
      ORDER BY r.started_at DESC
      LIMIT 1
    `).get(label);

    if (lastRun?.session_key) {
      preferredSessionKey = lastRun.session_key;
      process.stderr.write(`[chilisaus] mode=${mode} → reusing session ${preferredSessionKey}\n`);
    } else if (mode === 'reuse') {
      die(`mode=reuse: no prior session found for label "${label}". Use --mode fresh or --mode auto.`);
    } else {
      process.stderr.write(`[chilisaus] mode=auto → no prior session for "${label}", dispatching fresh\n`);
    }
  }

  // Use a never-fires cron (Feb 31) so scheduler doesn't auto-re-schedule
  const NEVER_CRON = '0 0 31 2 *';

  let job;
  try {
    job = createJob({
      name:                    label,
      schedule_cron:           NEVER_CRON,
      schedule_tz:             'America/New_York',
      session_target:          'isolated',
      agent_id:                agent,
      payload_kind:            'agentTurn',
      payload_message:         message,
      payload_thinking:        thinking,
      payload_timeout_seconds: timeoutS,
      run_now:                 true,
      delete_after_run:        true,
      delivery_mode:           deliverMode,
      delivery_channel:        deliverTo ? 'telegram' : null,
      delivery_to:             deliverTo,
      overlap_policy:          'skip',
      run_timeout_ms:          timeoutS * 1000,
      preferred_session_key:   preferredSessionKey,   // null = fresh session
    });
  } catch (err) {
    die(`createJob failed: ${err.message}`);
  }

  // Fire dispatch.started hook (best-effort)
  await onStarted({ label, job_id: job.id, agent, mode }).catch(() => {});

  out({
    ok:                  true,
    label,
    job_id:              job.id,
    mode,
    agent,
    preferred_session_key: preferredSessionKey || null,
    status:              'queued',
    message:             `Job queued. Scheduler will dispatch on next tick (≤${(parseInt(process.env.SCHEDULER_TICK_MS || '10000') / 1000).toFixed(0)}s).`,
  });
}

/**
 * status — show recent runs for a label.
 *
 * Flags:
 *   --label <string>    Required
 *   --limit <n>         Number of runs to show (default: 5)
 */
function cmdStatus(flags) {
  const label = flags.label;
  if (!label) die('--label is required', 2);

  const limit = parseInt(flags.limit || '5', 10);
  const runs  = runsByLabel(label, limit);

  if (!runs.length) {
    out({ ok: true, label, runs: [], message: 'No runs found for this label' });
    return;
  }

  out({
    ok:    true,
    label,
    count: runs.length,
    runs:  runs.map(r => ({
      run_id:       r.id,
      status:       r.status,
      started_at:   r.started_at,
      finished_at:  r.finished_at,
      duration_ms:  r.duration_ms,
      last_heartbeat: r.last_heartbeat,
      session_key:  r.session_key,
      summary:      r.summary ? r.summary.slice(0, 200) : null,
      error:        r.error_message || null,
    })),
  });
}

/**
 * stuck — list running runs past heartbeat threshold.
 * Exits 1 if any stuck runs found (delivery_mode: announce = DM on exit 1).
 *
 * Flags:
 *   --threshold-min <n>   Minutes without heartbeat to consider stuck (default: 15)
 *   --threshold-s <n>     Same in seconds (overrides threshold-min)
 */
async function cmdStuck(flags) {
  const thresholdMin = parseFloat(flags['threshold-min'] || '15');
  const thresholdS   = flags['threshold-s']
    ? parseInt(flags['threshold-s'], 10)
    : Math.round(thresholdMin * 60);

  const staleRuns = getStaleRuns(thresholdS);

  // Also find runs that are 'running' but have no heartbeat at all and are old
  const db = getDb();
  const noHeartbeatRuns = db.prepare(`
    SELECT r.*, j.name as job_name,
      CAST((julianday('now') - julianday(r.started_at)) * 86400 AS INTEGER) as age_s
    FROM runs r
    JOIN jobs j ON r.job_id = j.id
    WHERE r.status = 'running'
      AND r.last_heartbeat IS NULL
      AND r.started_at < datetime('now', '-' || ? || ' seconds')
  `).all(thresholdS);

  // Merge, dedup by run id
  const seen = new Set();
  const allStuck = [];
  for (const r of [...staleRuns, ...noHeartbeatRuns]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      allStuck.push(r);
    }
  }

  if (!allStuck.length) {
    out({ ok: true, stuck_count: 0, stuck_runs: [], threshold_s: thresholdS });
    process.exit(0);
  }

  // Format for announcement
  const lines = allStuck.map(r => {
    const ageMin = r.age_s ? Math.round(r.age_s / 60) : '?';
    const hbAgo  = r.last_heartbeat
      ? `last hb ${Math.round((Date.now() - new Date(r.last_heartbeat + 'Z').getTime()) / 60000)}min ago`
      : 'no heartbeat';
    return `• ${r.job_name} (run ${r.id.slice(0, 8)}, running ${ageMin}min, ${hbAgo})`;
  }).join('\n');

  process.stdout.write(
    `⚠️ ${allStuck.length} stuck run${allStuck.length > 1 ? 's' : ''}:\n${lines}\n`
  );

  // Emit to Loki (best-effort)
  await onStuck(allStuck.map(r => ({
    id:         r.id,
    job_name:   r.job_name,
    started_at: r.started_at,
    age_s:      r.age_s || thresholdS,
  }))).catch(() => {});

  process.exit(1); // triggers announce delivery
}

/**
 * result — get the summary/result of the last finished run for a label.
 *
 * Flags:
 *   --label <string>    Required
 */
function cmdResult(flags) {
  const label = flags.label;
  if (!label) die('--label is required', 2);

  const run = lastFinishedRun(label);
  if (!run) {
    out({ ok: false, label, message: 'No finished runs found for this label' });
    return;
  }

  out({
    ok:          true,
    label,
    run_id:      run.id,
    status:      run.status,
    started_at:  run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    session_key: run.session_key,
    summary:     run.summary || null,
    error:       run.error_message || null,
  });
}

/**
 * send — put a message in a job agent's inbox via the message queue.
 *
 * Flags:
 *   --label <string>     Required. Target agent label (job name)
 *   --from <string>      Sender agent ID (default: orchestrator)
 *   --message <string>   Required. Message body
 *   --kind <string>      Message kind: text|task|result|status (default: text)
 *   --subject <string>   Optional subject
 */
function cmdSend(flags) {
  const label   = flags.label;
  const message = flags.message;
  if (!label)   die('--label is required', 2);
  if (!message) die('--message is required', 2);

  const from    = flags.from    || 'orchestrator';
  const kind    = flags.kind    || 'text';
  const subject = flags.subject || null;

  const msg = sendMessage({
    from_agent: from,
    to_agent:   label,
    kind,
    subject,
    body:       message,
  });

  out({ ok: true, message_id: msg.id, from, to: label, kind });
}

/**
 * heartbeat — touch the heartbeat for a running run.
 *
 * Flags:
 *   --run-id <string>    Required. Run ID to heartbeat
 *   --label <string>     Alternative: find the last running run for this label
 */
function cmdHeartbeat(flags) {
  let runId = flags['run-id'];

  if (!runId && flags.label) {
    const db = getDb();
    const run = db.prepare(`
      SELECT r.id FROM runs r
      JOIN jobs j ON r.job_id = j.id
      WHERE j.name = ? AND r.status = 'running'
      ORDER BY r.started_at DESC LIMIT 1
    `).get(flags.label);
    runId = run?.id;
  }

  if (!runId) die('--run-id or --label (with a running run) is required', 2);

  updateHeartbeat(runId);
  out({ ok: true, run_id: runId, heartbeat: new Date().toISOString() });
}

// ── Usage ────────────────────────────────────────────────────

function usage() {
  process.stdout.write(`
chilisaus — sub-agent dispatch CLI

Usage: node chilisaus.mjs <subcommand> [flags]

Subcommands:
  enqueue  --label <l> --message <m> [--agent <a>] [--thinking <t>]
           [--timeout <s>] [--deliver-to <id>] [--delivery-mode <m>]
           [--mode fresh|reuse|auto]

  status   --label <l> [--limit <n>]

  stuck    [--threshold-min <n>]      (exits 1 if stuck runs found)

  result   --label <l>

  send     --label <l> --message <m> [--from <agent>] [--kind <k>]

  heartbeat --run-id <id>  OR  --label <l>

Full reference: docs/tools/chilisaus.md
`);
}

// ── Main ─────────────────────────────────────────────────────

const [,, subcommand, ...rest] = process.argv;
const flags = parseFlags(rest);

// Ensure DB is open (read-only for status/stuck/result, write for enqueue/send/heartbeat)
getDb();

switch (subcommand) {
  case 'enqueue':   await cmdEnqueue(flags);   break;
  case 'status':    cmdStatus(flags);          break;
  case 'stuck':     await cmdStuck(flags);     break;
  case 'result':    cmdResult(flags);          break;
  case 'send':      cmdSend(flags);            break;
  case 'heartbeat': cmdHeartbeat(flags);       break;
  default:          usage(); process.exit(2);
}
