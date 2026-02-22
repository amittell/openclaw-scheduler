#!/usr/bin/env node
// Scheduler CLI — manage jobs, runs, messages, agents
import { initDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, getChildJobs, cancelJob } from './jobs.js';
import { getRunsForJob, getRunningRuns, getStaleRuns } from './runs.js';
import { sendMessage, getInbox, getOutbox, getThread, markRead, markAllRead, getUnreadCount } from './messages.js';
import { upsertAgent, getAgent, listAgents } from './agents.js';

const [,, command, sub, ...args] = process.argv;

function usage() {
  console.log(`
Usage: node cli.js <command> [subcommand] [options]

Jobs:
  jobs list                          List all jobs
  jobs tree                          Show jobs as parent/child tree
  jobs get <id>                      Get job details
  jobs add <json>                    Add a job
  jobs enable <id>                   Enable a job
  jobs disable <id>                  Disable a job
  jobs delete <id>                   Delete a job
  jobs cancel <id> [--no-cascade]   Cancel a job (+ children by default)
  jobs update <id> <json>            Update job fields

Runs:
  runs list <job-id> [limit]         List runs for a job
  runs running                       Currently running runs
  runs stale [threshold-s]           Stale runs

Messages:
  msg send <from> <to> <body>        Send a message
  msg inbox <agent-id> [limit]       Get inbox (unread)
  msg outbox <agent-id> [limit]      Get outbox
  msg thread <message-id>            Get message thread
  msg read <message-id>              Mark message as read
  msg readall <agent-id>             Mark all as read
  msg unread <agent-id>              Unread count

Agents:
  agents list                        List registered agents
  agents get <id>                    Get agent details
  agents register <id> [name]        Register/update agent

Status:
  status                             Overall scheduler status
`);
}

initDb();

function fmt(obj) { return JSON.stringify(obj, null, 2); }

switch (command) {
  // ── Jobs ────────────────────────────────────────────────
  case 'jobs':
    switch (sub) {
      case 'list': {
        const jobs = listJobs();
        console.table(jobs.map(j => ({
          id: j.id.slice(0, 8) + '…',
          name: j.name,
          enabled: !!j.enabled,
          cron: j.schedule_cron,
          agent: j.agent_id || 'main',
          target: j.session_target,
          parent: j.parent_id ? j.parent_id.slice(0, 8) + '…' : '-',
          trigger: j.trigger_on || '-',
          nextRun: j.next_run_at,
          lastStatus: j.last_status,
          errors: j.consecutive_errors,
        })));
        break;
      }
      case 'tree': {
        const jobs = listJobs();
        const roots = jobs.filter(j => !j.parent_id);
        const childMap = {};
        for (const j of jobs) {
          if (j.parent_id) {
            if (!childMap[j.parent_id]) childMap[j.parent_id] = [];
            childMap[j.parent_id].push(j);
          }
        }
        function printTree(job, indent = '') {
          const status = job.enabled ? '✅' : '⬚';
          const trigger = job.trigger_on ? ` [on:${job.trigger_on}]` : '';
          const delay = job.trigger_delay_s ? ` (+${job.trigger_delay_s}s)` : '';
          console.log(`${indent}${status} ${job.name} (${job.agent_id || 'main'})${trigger}${delay}`);
          const children = childMap[job.id] || [];
          for (const child of children) {
            printTree(child, indent + '  ├─ ');
          }
        }
        for (const root of roots) printTree(root);
        break;
      }
      case 'get': console.log(fmt(getJob(args[0]))); break;
      case 'add': {
        const job = createJob(JSON.parse(args[0]));
        console.log('Created:', fmt(job));
        break;
      }
      case 'enable': updateJob(args[0], { enabled: 1 }); console.log('Enabled'); break;
      case 'disable': updateJob(args[0], { enabled: 0 }); console.log('Disabled'); break;
      case 'delete': deleteJob(args[0]); console.log('Deleted'); break;
      case 'cancel': {
        const noCascade = args.includes('--no-cascade');
        const id = args.find(a => !a.startsWith('--'));
        const cancelled = cancelJob(id, { cascade: !noCascade });
        console.log(`Cancelled ${cancelled.length} job(s):`, cancelled.map(c => c.slice(0, 8) + '…'));
        break;
      }
      case 'update': {
        const job = updateJob(args[0], JSON.parse(args[1]));
        console.log('Updated:', fmt(job));
        break;
      }
      default: usage();
    }
    break;

  // ── Runs ────────────────────────────────────────────────
  case 'runs':
    switch (sub) {
      case 'list': {
        const runs = getRunsForJob(args[0], parseInt(args[1] || '20', 10));
        console.table(runs.map(r => ({
          id: r.id.slice(0, 8),
          status: r.status,
          started: r.started_at,
          finished: r.finished_at,
          durationMs: r.duration_ms,
          heartbeat: r.last_heartbeat,
        })));
        break;
      }
      case 'running': {
        const runs = getRunningRuns();
        if (runs.length === 0) { console.log('No running runs'); break; }
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
        const stale = getStaleRuns(parseInt(args[0] || '90', 10));
        if (stale.length === 0) { console.log('No stale runs'); break; }
        console.table(stale.map(r => ({
          id: r.id.slice(0, 8),
          job: r.job_name,
          heartbeat: r.last_heartbeat,
        })));
        break;
      }
      default: usage();
    }
    break;

  // ── Messages ────────────────────────────────────────────
  case 'msg':
    switch (sub) {
      case 'send': {
        const [from, to, ...bodyParts] = args;
        const msg = sendMessage({ from_agent: from, to_agent: to, body: bodyParts.join(' ') });
        console.log('Sent:', fmt(msg));
        break;
      }
      case 'inbox': {
        const msgs = getInbox(args[0], { limit: parseInt(args[1] || '20', 10) });
        if (msgs.length === 0) { console.log('Inbox empty'); break; }
        console.table(msgs.map(m => ({
          id: m.id.slice(0, 8),
          from: m.from_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 40),
          status: m.status,
          priority: m.priority,
          created: m.created_at,
        })));
        break;
      }
      case 'outbox': {
        const msgs = getOutbox(args[0], parseInt(args[1] || '20', 10));
        if (msgs.length === 0) { console.log('Outbox empty'); break; }
        console.table(msgs.map(m => ({
          id: m.id.slice(0, 8),
          to: m.to_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 40),
          status: m.status,
          created: m.created_at,
        })));
        break;
      }
      case 'thread': {
        const msgs = getThread(args[0]);
        for (const m of msgs) {
          console.log(`[${m.from_agent} → ${m.to_agent}] (${m.status}) ${m.created_at}`);
          console.log(`  ${m.body.slice(0, 200)}`);
          console.log();
        }
        break;
      }
      case 'read': markRead(args[0]); console.log('Marked read'); break;
      case 'readall': { const r = markAllRead(args[0]); console.log(`Marked ${r.changes} read`); break; }
      case 'unread': console.log(`Unread: ${getUnreadCount(args[0])}`); break;
      default: usage();
    }
    break;

  // ── Agents ──────────────────────────────────────────────
  case 'agents':
    switch (sub) {
      case 'list': {
        const agents = listAgents();
        console.table(agents.map(a => ({
          id: a.id,
          name: a.name,
          status: a.status,
          lastSeen: a.last_seen_at,
          sessionKey: a.session_key,
        })));
        break;
      }
      case 'get': console.log(fmt(getAgent(args[0]))); break;
      case 'register': {
        const a = upsertAgent(args[0], { name: args[1] || args[0] });
        console.log('Registered:', fmt(a));
        break;
      }
      default: usage();
    }
    break;

  // ── Status ──────────────────────────────────────────────
  case 'status': {
    const jobs = listJobs();
    const runningRuns = getRunningRuns();
    const stale = getStaleRuns();
    const agents = listAgents();

    console.log('=== OpenClaw Scheduler Status ===');
    console.log(`Jobs:     ${jobs.length} total, ${jobs.filter(j => j.enabled).length} enabled`);
    console.log(`Running:  ${runningRuns.length}`);
    console.log(`Stale:    ${stale.length}`);
    console.log(`Agents:   ${agents.length}`);

    for (const a of agents) {
      const unread = getUnreadCount(a.id);
      console.log(`  ${a.id}: ${a.status}${unread ? ` (${unread} unread)` : ''}`);
    }

    const nextJob = jobs
      .filter(j => j.enabled && j.next_run_at)
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    if (nextJob) console.log(`\nNext:     ${nextJob.name} at ${nextJob.next_run_at}`);
    break;
  }

  default:
    usage();
    process.exit(command ? 1 : 0);
}
