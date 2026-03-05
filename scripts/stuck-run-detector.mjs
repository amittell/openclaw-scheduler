#!/usr/bin/env node
/**
 * stuck-run-detector.mjs
 *
 * Checks for stale running runs and exits non-zero when any are found.
 * Pair with scheduler shell jobs using delivery_mode="announce" for alert-only behavior.
 *
 * Usage:
 *   node scripts/stuck-run-detector.mjs [--threshold-min 15] [--limit 20]
 *
 * Exit codes:
 *   0: no stale runs found
 *   1: stale runs found or hard error
 */

import { getDb } from '../db.js';

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

const args = parseArgs(process.argv.slice(2));
const thresholdMin = parsePositiveInt(args['threshold-min'], 15);
const thresholdS = thresholdMin * 60;
const limit = parsePositiveInt(args.limit, 20);

try {
  const db = getDb();
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

  process.stdout.write(`Detected ${rows.length} stale run(s) older than ${thresholdMin} minute(s):\n`);
  for (const r of rows) {
    process.stdout.write(
      `- run=${r.id} job="${r.job_name}" job_id=${r.job_id} started=${r.started_at} last_heartbeat=${r.last_heartbeat} stale_s=${r.stale_s} timeout_ms=${r.run_timeout_ms}\n`
    );
  }
  process.exit(1);
} catch (err) {
  process.stderr.write(`[stuck-run-detector] error: ${err.stack || err.message}\n`);
  process.exit(1);
}
