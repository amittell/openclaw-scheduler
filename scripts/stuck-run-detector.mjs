#!/usr/bin/env node
/**
 * stuck-run-detector.mjs
 *
 * Three-phase stuck detection: liveness gating → steer → alert.
 *
 * Phase 1 (Liveness gate): For dispatch-tracked runs, check actual session
 *   activity via `dispatch status`. Skip if tokens recently active or status=done.
 * Phase 2 (Steer): Send a nudge into the session before alerting. Give it
 *   one more cycle to respond.
 * Phase 3 (Alert): If steer was ignored (tokens flat), alert as genuinely stuck.
 *
 * Non-dispatch scheduler jobs skip phases 1–2 and alert immediately (old behavior).
 *
 * State persisted in /tmp/stuck-detector-state.json (volatile, OK to lose on reboot).
 *
 * Usage:
 *   node scripts/stuck-run-detector.mjs [--threshold-min 45] [--limit 20]
 *
 * Exit codes:
 *   0: no stuck runs (includes steered-but-not-yet-stuck)
 *   1: genuinely stuck runs found or hard error
 */

import { getDb } from '../db.js';
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { resolveDispatchCliPath, resolveDispatchLabel } from './dispatch-cli-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ────────────────────────────────────────────────────

const LABELS_PATH  = process.env.DISPATCH_LABELS_PATH || join(__dirname, '..', 'dispatch', 'labels.json');
const STATE_PATH   = process.env.STUCK_STATE_PATH || join(tmpdir(), 'stuck-detector-state.json');
const DISPATCH_CLI = resolveDispatchCliPath(process.env);
const DISPATCH_IS_BIN = !DISPATCH_CLI.includes('/') && !DISPATCH_CLI.includes('\\');

// ── Constants ────────────────────────────────────────────────

const LIVENESS_THRESHOLD_MS = 180_000; // 3 min — tokens active within this = alive

// ── Arg Parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      out[key] = value;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parsePositiveInt(input, fallback) {
  const n = Number.parseInt(String(input ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Labels & State ───────────────────────────────────────────

function loadLabels() {
  try {
    return JSON.parse(readFileSync(LABELS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// ── Dispatch Integration ────────────────────────────────────

/**
 * Get liveness info from `dispatch status --label <label>`.
 * Returns { ageMs, tokens, status } or null on failure.
 */
function getDispatchLiveness(label) {
  try {
    const execArgs = DISPATCH_IS_BIN
      ? [DISPATCH_CLI, ['status', '--label', label]]
      : [process.execPath, [DISPATCH_CLI, 'status', '--label', label]];
    const result = execFileSync(execArgs[0], execArgs[1], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(result.trim());
    return {
      ageMs:     parsed?.liveness?.ageMs ?? null,
      tokens:    parsed?.liveness?.tokens ?? null,
      status:    parsed?.status ?? null,
      updatedAt: parsed?.liveness?.updatedAt ?? null,
    };
  } catch (err) {
    process.stderr.write(
      `[stuck-detector] dispatch status for "${label}" failed: ${err.message}\n`
    );
    return null;
  }
}

/**
 * Send a steering message into a dispatch session.
 * Returns true on success, false on failure.
 */
function steerSession(label, staleMins) {
  const msg = [
    `[Auto-steer] You have been silent for ${staleMins} minutes.`,
    `Please reply with a brief progress update, then continue your task.`,
    `If you are done, call the done signal as instructed in your prompt.`,
  ].join(' ');
  try {
    const execArgs = DISPATCH_IS_BIN
      ? [DISPATCH_CLI, ['send', '--label', label, '--message', msg]]
      : [process.execPath, [DISPATCH_CLI, 'send', '--label', label, '--message', msg]];
    execFileSync(execArgs[0], execArgs[1], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    process.stderr.write(`[stuck-detector] steer for "${label}" failed: ${err.message}\n`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────

const args         = parseArgs(process.argv.slice(2));
const thresholdMin = parsePositiveInt(args['threshold-min'], 45);  // coding tasks regularly take 30m+
const thresholdS   = thresholdMin * 60;
const limit        = parsePositiveInt(args.limit, 20);

try {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT
      r.id,
      r.job_id,
      r.started_at,
      r.last_heartbeat,
      r.run_timeout_ms,
      j.name AS job_name,
      CAST((julianday('now') - julianday(COALESCE(r.last_heartbeat, r.started_at))) * 86400 AS INTEGER) AS stale_s
    FROM runs r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.status = 'running'
      AND COALESCE(r.last_heartbeat, r.started_at) < datetime('now', '-' || ? || ' seconds')
    ORDER BY stale_s DESC
    LIMIT ?
  `).all(thresholdS, limit);

  if (rows.length === 0) {
    process.stdout.write(`No stale runs older than ${thresholdMin} minute(s).\n`);
    process.exit(0);
  }

  const labels       = loadLabels();
  const state        = loadState();
  const alertRuns    = [];   // Phase 3: genuinely stuck
  const steeredRuns  = [];   // Phase 2: nudged, awaiting response
  const skippedRuns  = [];   // Phase 1: alive or done
  let   stateChanged = false;

  // Track which labels appeared as stale this cycle (for state cleanup)
  const staleLabelsThisCycle = new Set();

  for (const r of rows) {
    const label = resolveDispatchLabel(r.job_name, labels);

    // ── Non-dispatch job: alert immediately (old behavior) ──
    if (!label) {
      alertRuns.push(r);
      continue;
    }

    staleLabelsThisCycle.add(label);

    // ── Phase 1: Liveness gate ──────────────────────────────

    // Quick check: if labels.json already says done, skip (DB lag)
    if (labels[label]?.status === 'done') {
      skippedRuns.push({ ...r, reason: 'labels.json status=done (DB lag)', label });
      continue;
    }

    const liveness = getDispatchLiveness(label);

    // dispatch status returned done → skip
    if (liveness?.status === 'done') {
      skippedRuns.push({ ...r, reason: 'dispatch status=done', label });
      continue;
    }

    // Tokens recently active → skip (not stuck, just no heartbeat to DB)
    if (
      liveness &&
      typeof liveness.ageMs === 'number' &&
      liveness.ageMs < LIVENESS_THRESHOLD_MS
    ) {
      skippedRuns.push({
        ...r,
        reason: `active (ageMs=${liveness.ageMs}ms < ${LIVENESS_THRESHOLD_MS}ms)`,
        label,
      });
      continue;
    }

    // ── Phase 2 / Phase 3: Steer or Alert ───────────────────

    if (state[label]?.alertedAt) {
      // Already alerted -- don't re-steer or re-alert
      continue;
    }

    if (!state[label]) {
      // Phase 2: First detection — steer before alerting
      const staleMins = Math.round(r.stale_s / 60);
      const ok = steerSession(label, staleMins);

      if (ok) {
        state[label] = {
          steeredAt:      new Date().toISOString(),
          tokensAtSteer:  liveness?.tokens ?? 0,
          staleS:         r.stale_s,
        };
        stateChanged = true;
        steeredRuns.push({
          ...r,
          label,
          ageMs:  liveness?.ageMs ?? null,
          tokens: liveness?.tokens ?? null,
        });
      } else {
        // Steer call failed — still alert, note the failure
        alertRuns.push({ ...r, steerNote: 'steer=failed' });
      }
    } else {
      // Phase 3: Already steered — did it help?
      const prevTokens = state[label].tokensAtSteer;
      const curTokens  = liveness?.tokens ?? 0;

      if (curTokens > prevTokens) {
        // Tokens grew since steer → it worked, clear state, skip alert
        delete state[label];
        stateChanged = true;
        skippedRuns.push({
          ...r,
          reason: `steer worked (tokens ${prevTokens}→${curTokens})`,
          label,
        });
      } else {
        // Tokens flat since steer -> genuinely stuck -> alert
        alertRuns.push({ ...r, steerNote: 'steer=ignored' });
        state[label] = { alertedAt: new Date().toISOString() };
        stateChanged = true;
      }
    }
  }

  // ── Clean state entries for labels no longer appearing as stale ──
  for (const key of Object.keys(state)) {
    if (!staleLabelsThisCycle.has(key)) {
      delete state[key];
      stateChanged = true;
    }
  }

  if (stateChanged) {
    saveState(state);
  }

  // ── Output ─────────────────────────────────────────────────

  for (const s of skippedRuns) {
    process.stdout.write(
      `Skipped: job="${s.job_name}" label="${s.label}" — ${s.reason}\n`
    );
  }

  for (const s of steeredRuns) {
    process.stdout.write(
      `Steered: label=${s.label} ageMs=${s.ageMs ?? '?'} tokens=${s.tokens ?? '?'} (awaiting response)\n`
    );
  }

  if (alertRuns.length === 0) {
    if (steeredRuns.length > 0) {
      process.stdout.write(
        `No stuck runs — ${steeredRuns.length} steered, awaiting response.\n`
      );
    } else {
      process.stdout.write(`No stale runs older than ${thresholdMin} minute(s).\n`);
    }
    process.exit(0);
  }

  process.stdout.write(
    `Detected ${alertRuns.length} stale run(s) older than ${thresholdMin} minute(s):\n`
  );
  for (const r of alertRuns) {
    const suffix = r.steerNote ? ` ${r.steerNote}` : '';
    process.stdout.write(
      `- run=${r.id} job="${r.job_name}" job_id=${r.job_id} started=${r.started_at} last_heartbeat=${r.last_heartbeat} stale_s=${r.stale_s} timeout_ms=${r.run_timeout_ms}${suffix}\n`
    );
  }
  process.exit(1);
} catch (err) {
  process.stderr.write(`[stuck-run-detector] error: ${err.stack || err.message}\n`);
  process.exit(1);
}
