#!/usr/bin/env node
// Migrate existing OpenClaw cron jobs.json -> SQLite scheduler
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { initDb } from './db.js';
import { createJob, listJobs } from './jobs.js';

import { homedir } from 'os';

const JOBS_JSON = process.env.OPENCLAW_JOBS_JSON
  || join(process.env.HOME || homedir(), '.openclaw/cron/jobs.json');

function cronFromSchedule(schedule) {
  // OpenClaw supports: cron (expr), every (everyMs), at (one-shot ISO)
  if (schedule.kind === 'cron') {
    return { cron: schedule.expr, tz: schedule.tz || 'UTC' };
  }
  if (schedule.kind === 'every') {
    // Convert interval to approximate cron. everyMs -> minutes
    if (schedule.everyMs < 60000) {
      console.warn(`  WARN: ${schedule.everyMs}ms interval rounded up to 1 minute (cron minimum)`);
    }
    const mins = Math.max(1, Math.round(schedule.everyMs / 60000));
    if (mins < 60) return { cron: `*/${mins} * * * *`, tz: schedule.tz || 'UTC' };
    const hours = Math.max(1, Math.round(mins / 60));
    const remaining = mins % 60;
    const clampedHours = Math.min(hours, 23);
    if (hours > 23) {
      console.warn(`  WARN: ${schedule.everyMs}ms interval exceeds 23 hours; clamping to */23 hours`);
    }
    if (remaining !== 0) {
      console.warn(`  WARN: ${schedule.everyMs}ms interval (${mins}min) cannot be represented exactly in standard cron; approximating to every ${clampedHours} hour(s)`);
    }
    return { cron: `0 */${clampedHours} * * *`, tz: schedule.tz || 'UTC' };
  }
  if (schedule.kind === 'at') {
    // One-shot: compute the specific minute/hour/day cron that fires once
    const d = new Date(schedule.at);
    return {
      cron: `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`,
      tz: 'UTC',
    };
  }
  throw new Error(`Unknown schedule kind: ${schedule.kind}`);
}

function main() {
  if (!existsSync(JOBS_JSON)) {
    console.error(`No jobs.json found at: ${JOBS_JSON}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(JOBS_JSON, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${JOBS_JSON}: ${err.message}`);
    process.exit(1);
  }
  const jobs = data.jobs || [];

  console.log(`Found ${jobs.length} job(s) in ${JOBS_JSON}`);

  initDb();

  const existing = listJobs();
  const existingIds = new Set(existing.map(j => j.id));

  let imported = 0;
  let skipped = 0;

  for (const job of jobs) {
    if (existingIds.has(job.id)) {
      console.log(`  SKIP: ${job.name} (already exists)`);
      skipped++;
      continue;
    }

    try {
      const { cron, tz } = cronFromSchedule(job.schedule);

      let deliveryMode = job.delivery?.mode || 'announce';
      const deliveryTo = job.delivery?.to || null;
      let deliveryOptOutReason = null;

      if ((deliveryMode === 'announce' || deliveryMode === 'announce-always') && !deliveryTo) {
        console.warn(`  WARN: ${job.name}: delivery_mode='${deliveryMode}' but no delivery_to configured; downgrading to 'none'`);
        deliveryMode = 'none';
        deliveryOptOutReason = 'migrated: no delivery target configured';
      }

      createJob({
        id: job.id,
        name: job.name,
        enabled: job.enabled !== false,
        schedule_cron: cron,
        schedule_tz: tz,
        session_target: job.sessionTarget || 'isolated',
        agent_id: job.agentId || 'main',
        payload_kind: job.payload?.kind || 'agentTurn',
        payload_message: job.payload?.message || job.payload?.text || '',
        payload_model: job.payload?.model || null,
        payload_thinking: job.payload?.thinking || null,
        payload_timeout_seconds: job.payload?.timeoutSeconds || 120,
        overlap_policy: 'skip',
        run_timeout_ms: 300000,
        delivery_mode: deliveryMode,
        delivery_channel: job.delivery?.channel || null,
        delivery_to: deliveryTo,
        delivery_opt_out_reason: deliveryOptOutReason,
        delete_after_run: job.schedule?.kind === 'at',
        origin: job.origin || 'system',
      });

      console.log(`  OK: ${job.name} -> cron="${cron}" tz=${tz}`);
      imported++;
    } catch (err) {
      console.error(`  ERR: ${job.name}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped`);
}

main();
