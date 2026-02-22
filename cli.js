#!/usr/bin/env node
// Scheduler CLI — manage jobs and runs
import { initDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob } from './jobs.js';
import { getRunsForJob, getRunningRuns, getStaleRuns } from './runs.js';

const [,, command, ...args] = process.argv;

function usage() {
  console.log(`
Usage: node cli.js <command> [options]

Commands:
  list                       List all jobs
  get <id>                   Get job details
  add <json>                 Add a job (JSON string)
  enable <id>                Enable a job
  disable <id>               Disable a job
  delete <id>                Delete a job
  runs <job-id> [limit]      List runs for a job
  running                    List currently running runs
  stale [threshold-s]        List stale runs
  status                     Overall scheduler status
`);
}

initDb();

function formatJob(j) {
  return {
    id: j.id,
    name: j.name,
    enabled: !!j.enabled,
    cron: j.schedule_cron,
    tz: j.schedule_tz,
    target: j.session_target,
    nextRun: j.next_run_at,
    lastRun: j.last_run_at,
    lastStatus: j.last_status,
    errors: j.consecutive_errors,
    overlap: j.overlap_policy,
    timeoutMs: j.run_timeout_ms,
  };
}

switch (command) {
  case 'list': {
    const jobs = listJobs();
    console.table(jobs.map(formatJob));
    break;
  }

  case 'get': {
    const job = getJob(args[0]);
    if (!job) { console.error('Job not found'); process.exit(1); }
    console.log(JSON.stringify(job, null, 2));
    break;
  }

  case 'add': {
    const opts = JSON.parse(args[0]);
    const job = createJob(opts);
    console.log('Created:', JSON.stringify(formatJob(job), null, 2));
    break;
  }

  case 'enable': {
    updateJob(args[0], { enabled: 1 });
    console.log('Enabled:', args[0]);
    break;
  }

  case 'disable': {
    updateJob(args[0], { enabled: 0 });
    console.log('Disabled:', args[0]);
    break;
  }

  case 'delete': {
    deleteJob(args[0]);
    console.log('Deleted:', args[0]);
    break;
  }

  case 'runs': {
    const runs = getRunsForJob(args[0], parseInt(args[1] || '20', 10));
    console.table(runs.map(r => ({
      id: r.id.slice(0, 8),
      status: r.status,
      started: r.started_at,
      finished: r.finished_at,
      durationMs: r.duration_ms,
      heartbeat: r.last_heartbeat,
      error: r.error_message?.slice(0, 60),
    })));
    break;
  }

  case 'running': {
    const runs = getRunningRuns();
    console.table(runs.map(r => ({
      id: r.id.slice(0, 8),
      job: r.job_name,
      started: r.started_at,
      heartbeat: r.last_heartbeat,
      sessionKey: r.session_key,
    })));
    break;
  }

  case 'stale': {
    const threshold = parseInt(args[0] || '90', 10);
    const stale = getStaleRuns(threshold);
    if (stale.length === 0) {
      console.log('No stale runs');
    } else {
      console.table(stale.map(r => ({
        id: r.id.slice(0, 8),
        job: r.job_name,
        heartbeat: r.last_heartbeat,
        started: r.started_at,
      })));
    }
    break;
  }

  case 'status': {
    const jobs = listJobs();
    const running = getRunningRuns();
    const stale = getStaleRuns();
    console.log(`Jobs: ${jobs.length} total, ${jobs.filter(j => j.enabled).length} enabled`);
    console.log(`Running: ${running.length}`);
    console.log(`Stale: ${stale.length}`);
    const nextJob = jobs.filter(j => j.enabled && j.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    if (nextJob) console.log(`Next: ${nextJob.name} at ${nextJob.next_run_at}`);
    break;
  }

  default:
    usage();
    process.exit(command ? 1 : 0);
}
