#!/usr/bin/env node
// Scheduler CLI — manage jobs, runs, messages, agents
import { initDb, getDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, getChildJobs, cancelJob, runJobNow } from './jobs.js';
import { getRunsForJob, getRunningRuns, getStaleRuns } from './runs.js';
import { sendMessage, getInbox, getOutbox, getThread, markRead, markAllRead, getUnreadCount, pruneMessages } from './messages.js';
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
  jobs run <id>                      Trigger immediate run (sets next_run_at to now)
  jobs approve <id>                  Approve a pending job
  jobs reject <id> [reason]          Reject with optional reason

Runs:
  runs list <job-id> [limit]         List runs for a job
  runs running                       Currently running runs
  runs stale [threshold-s]           Stale runs

Queue:
  queue list [agent] [limit]         Show pending + delivered messages (default: main)
  queue clear [agent]                Mark all messages read
  queue prune                        Prune old messages now

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

Tasks:
  tasks list                                    List active task groups
  tasks status <id>                             Detailed status of a task group
  tasks create <json>                           Create a tracked task group
  tasks history [limit]                         Recent completed task groups
  tasks heartbeat <id> <label> running|completed|failed [msg]  Sub-agent reports status
  tasks register-session <id> <label> <key>    Orchestrator links session key to agent

Approvals:
  approvals list                     List pending approvals
  approvals pending                  Alias for list

Idempotency:
  idem status <job-id>               Show recent idempotency keys for a job
  idem check <key>                   Check if a key is claimed
  idem release <key>                 Manually release a claimed key
  idem prune                         Force prune expired entries

Aliases:
  alias list                         List all delivery aliases
  alias add <name> <ch> <tgt> [desc] Add a delivery alias
  alias remove <name>                Remove a delivery alias

Status:
  status                             Overall scheduler status
`);
}

await initDb();

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
          guarantee: j.delivery_guarantee || 'at-most-once',
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
      case 'run': {
        const job = runJobNow(args[0]);
        if (!job) { console.error('Job not found:', args[0]); process.exit(1); }
        console.log(`Scheduled for immediate run: ${job.name} (next_run_at: ${job.next_run_at})`);
        break;
      }
      case 'approve': {
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(args[0]);
        if (!approval) { console.error('No pending approval for job:', args[0]); process.exit(1); }
        resolveApproval(approval.id, 'approved', 'operator');
        console.log(`Approved: ${approval.job_id}`);
        break;
      }
      case 'reject': {
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(args[0]);
        if (!approval) { console.error('No pending approval for job:', args[0]); process.exit(1); }
        const reason = args.slice(1).join(' ') || null;
        resolveApproval(approval.id, 'rejected', 'operator', reason);
        getDb().prepare("UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
        console.log(`Rejected: ${approval.job_id}${reason ? ' — ' + reason : ''}`);
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
        const msgs = getInbox(args[0], { limit: parseInt(args[1] || '20', 10), includeDelivered: true });
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

  // ── Queue ────────────────────────────────────────────────
  case 'queue':
    switch (sub) {
      case 'list':
      case undefined: {
        const agent = args[0] || 'main';
        const limit = parseInt(args[1] || '50', 10);
        const msgs = getInbox(agent, { limit, includeDelivered: true });
        const pending = msgs.filter(m => m.status === 'pending');
        const delivered = msgs.filter(m => m.status === 'delivered');
        const unread = getUnreadCount(agent);
        console.log(`\nQueue for agent: ${agent} | ${unread} pending | ${delivered.length} delivered (showing last ${limit})\n`);
        if (msgs.length === 0) { console.log('  Queue empty'); break; }
        console.table(msgs.map(m => ({
          id: m.id.slice(0, 8),
          from: m.from_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 45),
          status: m.status,
          priority: m.priority,
          created: m.created_at,
        })));
        break;
      }
      case 'clear': {
        const r = markAllRead(args[0] || 'main');
        console.log(`Cleared ${r.changes} messages`);
        break;
      }
      case 'prune': {
        pruneMessages();
        console.log('Pruned old messages (read/delivered >3d, system >3d, expired/failed >30d)');
        break;
      }
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

  // ── Tasks ────────────────────────────────────────────────
  case 'tasks':
    switch (sub) {
      case 'list': {
        const { listActiveTaskGroups, getTaskGroupStatus } = await import('./task-tracker.js');
        const groups = listActiveTaskGroups();
        if (groups.length === 0) { console.log('No active task groups'); break; }
        console.table(groups.map(g => {
          const status = getTaskGroupStatus(g.id);
          const agents = JSON.parse(g.expected_agents);
          return {
            id: g.id.slice(0, 8) + '…',
            name: g.name,
            agents: `${status.agents.filter(a => a.status === 'completed').length}/${agents.length}`,
            status: g.status,
            elapsed: `${status.elapsed}s`,
            timeout: `${g.timeout_s}s`,
          };
        }));
        break;
      }
      case 'status': {
        const { getTaskGroupStatus } = await import('./task-tracker.js');
        const status = getTaskGroupStatus(args[0]);
        if (!status) { console.error('Task group not found:', args[0]); process.exit(1); }
        console.log(`\nTask Group: ${status.name}`);
        console.log(`Status:     ${status.status}`);
        console.log(`Elapsed:    ${status.elapsed}s / ${status.remaining_timeout + status.elapsed}s timeout`);
        console.log(`\nAgents:`);
        for (const a of status.agents) {
          const icon = a.status === 'completed' ? '✅' : a.status === 'failed' ? '❌' : a.status === 'dead' ? '💀' : a.status === 'running' ? '🔄' : '⬜';
          const dur = a.duration != null ? ` (${a.duration}s)` : '';
          const detail = a.exit_message || a.error || '';
          console.log(`  ${icon} ${a.label}: ${a.status}${dur}${detail ? ' — ' + detail : ''}`);
        }
        if (status.summary) {
          console.log(`\nSummary:\n${status.summary}`);
        }
        break;
      }
      case 'create': {
        const { createTaskGroup } = await import('./task-tracker.js');
        const group = createTaskGroup(JSON.parse(args[0]));
        console.log('Created:', fmt(group));
        break;
      }
      case 'history': {
        const limit = parseInt(args[0] || '10', 10);
        const rows = getDb().prepare(
          "SELECT * FROM task_tracker WHERE status != 'active' ORDER BY completed_at DESC LIMIT ?"
        ).all(limit);
        if (rows.length === 0) { console.log('No completed task groups'); break; }
        console.table(rows.map(g => ({
          id: g.id.slice(0, 8) + '…',
          name: g.name,
          status: g.status,
          completed: g.completed_at,
          created_by: g.created_by,
        })));
        break;
      }

      // ── tasks heartbeat ──────────────────────────────────
      // Called BY sub-agents during execution to report status.
      // Usage: tasks heartbeat <trackerId> <agentLabel> running|completed|failed [message]
      case 'heartbeat': {
        const { agentStarted, agentCompleted, agentFailed } = await import('./task-tracker.js');
        const [trackerId, agentLabel, status, ...msgParts] = args;
        const exitMsg = msgParts.join(' ') || undefined;

        if (!trackerId || !agentLabel || !status) {
          console.error('Usage: tasks heartbeat <trackerId> <agentLabel> running|completed|failed [message]');
          process.exit(1);
        }

        if (status === 'running') {
          agentStarted(trackerId, agentLabel);
          console.log(`✅ Heartbeat recorded: ${agentLabel} → running`);
        } else if (status === 'completed') {
          agentCompleted(trackerId, agentLabel, exitMsg);
          console.log(`✅ Heartbeat recorded: ${agentLabel} → completed${exitMsg ? ` (${exitMsg})` : ''}`);
        } else if (status === 'failed') {
          agentFailed(trackerId, agentLabel, exitMsg || 'failed');
          console.log(`✅ Heartbeat recorded: ${agentLabel} → failed${exitMsg ? ` (${exitMsg})` : ''}`);
        } else {
          console.error(`Unknown status: "${status}". Valid values: running | completed | failed`);
          process.exit(1);
        }
        break;
      }

      // ── tasks register-session ────────────────────────────
      // Called BY the orchestrator after spawning a sub-agent.
      // Links the sub-agent's OC session key to the tracker agent so
      // the dispatcher can auto-detect heartbeats without CLI calls.
      // Usage: tasks register-session <trackerId> <agentLabel> <sessionKey>
      case 'register-session': {
        const { registerAgentSession } = await import('./task-tracker.js');
        const [trackerId, agentLabel, sessionKey] = args;
        if (!trackerId || !agentLabel || !sessionKey) {
          console.error('Usage: tasks register-session <trackerId> <agentLabel> <sessionKey>');
          console.error('Example: tasks register-session abc-123 writer agent:main:subagent:xyz-456');
          process.exit(1);
        }
        registerAgentSession(trackerId, agentLabel, sessionKey);
        console.log(`✅ Session registered: ${agentLabel} → ${sessionKey}`);
        break;
      }

      default: usage();
    }
    break;

  // ── Approvals ──────────────────────────────────────────────
  case 'approvals':
    switch (sub) {
      case 'list':
      case 'pending': {
        const { listPendingApprovals } = await import('./approval.js');
        const approvals = listPendingApprovals();
        if (approvals.length === 0) { console.log('No pending approvals'); break; }
        console.table(approvals.map(a => ({
          id: a.id.slice(0, 8),
          job: a.job_id.slice(0, 8),
          job_name: a.job_name || '-',
          run: a.run_id?.slice(0, 8) || '-',
          status: a.status,
          requested: a.requested_at,
        })));
        break;
      }
      default: usage();
    }
    break;

  // ── Idempotency ────────────────────────────────────────
  case 'idem': {
    const { listIdempotencyForJob, getIdempotencyEntry, releaseIdempotencyKey, forcePruneIdempotency, checkIdempotencyKey } = await import('./idempotency.js');
    switch (sub) {
      case 'status': {
        if (!args[0]) { console.error('Usage: idem status <job-id>'); process.exit(1); }
        const entries = listIdempotencyForJob(args[0]);
        if (entries.length === 0) { console.log('No idempotency entries for this job'); break; }
        console.table(entries.map(e => ({
          key: e.key.slice(0, 12) + '…',
          run: e.run_id.slice(0, 8) + '…',
          status: e.status,
          claimed: e.claimed_at,
          released: e.released_at || '-',
          expires: e.expires_at,
          hash: e.result_hash || '-',
        })));
        break;
      }
      case 'check': {
        if (!args[0]) { console.error('Usage: idem check <key>'); process.exit(1); }
        const entry = getIdempotencyEntry(args[0]);
        if (!entry) { console.log('Key not found in ledger'); break; }
        console.log(fmt(entry));
        break;
      }
      case 'release': {
        if (!args[0]) { console.error('Usage: idem release <key>'); process.exit(1); }
        const before = getIdempotencyEntry(args[0]);
        if (!before) { console.error('Key not found in ledger'); process.exit(1); }
        if (before.status === 'released') { console.log('Key already released'); break; }
        releaseIdempotencyKey(args[0]);
        console.log(`Released idempotency key: ${args[0].slice(0, 12)}…`);
        break;
      }
      case 'prune': {
        const result = forcePruneIdempotency();
        console.log(`Pruned ${result} expired idempotency entries`);
        break;
      }
      default: usage();
    }
    break;
  }

  // ── Aliases ─────────────────────────────────────────────
  case 'alias': {
    const db = getDb();
    switch (sub) {
      case 'list': {
        const aliases = db.prepare('SELECT alias, channel, target, description, created_at FROM delivery_aliases ORDER BY alias').all();
        if (aliases.length === 0) { console.log('No aliases defined'); break; }
        console.table(aliases.map(a => ({
          alias: a.alias,
          channel: a.channel,
          target: a.target,
          description: a.description || '',
        })));
        break;
      }
      case 'add': {
        const [name, channel, target, ...descParts] = args;
        if (!name || !channel || !target) {
          console.error('Usage: alias add <name> <channel> <target> [description]');
          process.exit(1);
        }
        const description = descParts.length > 0 ? descParts.join(' ') : null;
        db.prepare('INSERT OR REPLACE INTO delivery_aliases (alias, channel, target, description) VALUES (?, ?, ?, ?)')
          .run(name, channel, target, description);
        console.log(`Added alias: ${name} → ${channel}/${target}`);
        break;
      }
      case 'remove': {
        if (!args[0]) { console.error('Usage: alias remove <name>'); process.exit(1); }
        const result = db.prepare('DELETE FROM delivery_aliases WHERE alias = ?').run(args[0]);
        if (result.changes > 0) console.log(`Removed alias: ${args[0]}`);
        else console.error(`Alias not found: ${args[0]}`);
        break;
      }
      default: usage();
    }
    break;
  }

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
