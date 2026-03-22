#!/usr/bin/env node
// Migrate existing OpenClaw cron jobs.json → SQLite scheduler
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
    return { cron: schedule.expr, tz: schedule.tz || 'America/New_York' };
  }
  if (schedule.kind === 'every') {
    // Convert interval to approximate cron. everyMs → minutes
    const mins = Math.max(1, Math.round(schedule.everyMs / 60000));
    if (mins < 60) return { cron: `*/${mins} * * * *`, tz: schedule.tz || 'America/New_York' };
    const hours = Math.round(mins / 60);
    return { cron: `0 */${hours} * * *`, tz: schedule.tz || 'America/New_York' };
  }
  if (schedule.kind === 'at') {
    // One-shot: create a cron that fires once (we'll mark delete_after_run)
    // For now, use a placeholder cron that fires every minute — the job will delete after first run
    // In practice, we'd need to compute the specific minute/hour/day
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

  const data = JSON.parse(readFileSync(JOBS_JSON, 'utf8'));
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
        delivery_mode: job.delivery?.mode || 'announce',
        delivery_channel: job.delivery?.channel || null,
        delivery_to: job.delivery?.to || null,
        delete_after_run: job.schedule?.kind === 'at',
        origin: job.origin || 'system',
      });

      console.log(`  OK: ${job.name} → cron="${cron}" tz=${tz}`);
      imported++;
    } catch (err) {
      console.error(`  ERR: ${job.name}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped`);
}

main();
