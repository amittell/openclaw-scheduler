#!/usr/bin/env node
// Scheduler CLI — manage jobs, runs, messages, agents
import { initDb, getDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, getChildJobs, cancelJob, runJobNow, validateJobSpec } from './jobs.js';
import { getRunsForJob, getRunningRuns, getStaleRuns } from './runs.js';
import {
  sendMessage, getInbox, getOutbox, getThread, markRead, markAllRead, getUnreadCount, pruneMessages,
  ackMessage, listMessageReceipts, getTeamMessages,
} from './messages.js';
import { upsertAgent, getAgent, listAgents } from './agents.js';
import { SCHEDULER_SCHEMAS } from './scheduler-schema.js';

const cliArgs = process.argv.slice(2);
const jsonFlagIndex = cliArgs.indexOf('--json');
const jsonMode = jsonFlagIndex >= 0;
if (jsonFlagIndex >= 0) cliArgs.splice(jsonFlagIndex, 1);
const [command, sub, ...args] = cliArgs;

function usage() {
  console.log(`
Usage: node cli.js <command> [subcommand] [options]

Global:
  --json                             Emit machine-readable JSON

Jobs:
  jobs list                          List all jobs
  jobs tree                          Show jobs as parent/child tree
  jobs get <id>                      Get job details
  jobs add <json>                    Add a job
  jobs validate <json>               Validate a job spec without writing it
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
  msg team-inbox <team-id> [limit] [member-id] [task-id]  Get team mailbox
  msg outbox <agent-id> [limit]      Get outbox
  msg thread <message-id>            Get message thread
  msg ack <message-id> [actor] [note] Mark message as acknowledged/read
  msg receipts <message-id> [limit]  Show delivery/ack receipt events
  msg read <message-id>              Mark message as read
  msg readall <agent-id>             Mark all as read
  msg unread <agent-id>              Unread count

Team Adapter:
  team map [limit]                           Project unmapped team messages into mailbox/task events
  team tasks <team-id> [limit]               List projected team tasks
  team events <team-id> [limit] [task-id]    List team mailbox events
  team gate <team-id> <task-id> <members-json> [timeout-s]  Open task completion gate
  team check-gates [limit]                   Evaluate/advance team task gates
  team ack <message-id> [actor] [note]       Team-aware ACK (creates team mailbox event)

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

Schema:
  schema [jobs|runs|messages|approvals|dispatches|all]
`);
}

await initDb();

function fmt(obj) { return JSON.stringify(obj, null, 2); }

function emit(data, human = null) {
  if (jsonMode) {
    console.log(fmt(data));
    return;
  }
  if (typeof human === 'function') {
    human();
    return;
  }
  if (typeof human === 'string') {
    console.log(human);
    return;
  }
  console.log(typeof data === 'string' ? data : fmt(data));
}

function fail(message, code = 1) {
  if (jsonMode) {
    console.error(fmt({ ok: false, error: message }));
  } else {
    console.error(message);
  }
  process.exit(code);
}

switch (command) {
  // ── Jobs ────────────────────────────────────────────────
  case 'jobs':
    switch (sub) {
      case 'list': {
        const jobs = listJobs();
        const rows = jobs.map(j => ({
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
        }));
        emit(jsonMode ? jobs : rows, () => console.table(rows));
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
        function treeNode(job) {
          return {
            id: job.id,
            name: job.name,
            enabled: !!job.enabled,
            agent_id: job.agent_id || 'main',
            trigger_on: job.trigger_on || null,
            trigger_delay_s: job.trigger_delay_s || 0,
            children: (childMap[job.id] || []).map(treeNode),
          };
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
        emit(roots.map(treeNode), () => {
          for (const root of roots) printTree(root);
        });
        break;
      }
      case 'get': emit(getJob(args[0])); break;
      case 'add': {
        const dryRun = args.includes('--dry-run');
        const payload = args.find(a => a !== '--dry-run');
        if (!payload) fail('Usage: jobs add <json> [--dry-run]');
        const spec = JSON.parse(payload);
        const normalized = validateJobSpec(spec, null, 'create');
        if (dryRun) {
          emit({ ok: true, dry_run: true, valid: true, normalized });
          break;
        }
        const job = createJob(spec);
        emit({ ok: true, job }, `Created: ${fmt(job)}`);
        break;
      }
      case 'validate': {
        if (!args[0]) fail('Usage: jobs validate <json>');
        const spec = JSON.parse(args[0]);
        const normalized = validateJobSpec(spec, null, 'create');
        emit({ ok: true, valid: true, normalized });
        break;
      }
      case 'enable': updateJob(args[0], { enabled: 1 }); emit({ ok: true, job_id: args[0], enabled: true }, 'Enabled'); break;
      case 'disable': updateJob(args[0], { enabled: 0 }); emit({ ok: true, job_id: args[0], enabled: false }, 'Disabled'); break;
      case 'delete': deleteJob(args[0]); emit({ ok: true, job_id: args[0], deleted: true }, 'Deleted'); break;
      case 'cancel': {
        const noCascade = args.includes('--no-cascade');
        const id = args.find(a => !a.startsWith('--'));
        const cancelled = cancelJob(id, { cascade: !noCascade });
        emit({ ok: true, cancelled }, `Cancelled ${cancelled.length} job(s): ${cancelled.map(c => c.slice(0, 8) + '…').join(', ')}`);
        break;
      }
      case 'update': {
        const dryRun = args.includes('--dry-run');
        const updateArgs = args.filter(a => a !== '--dry-run');
        const current = getJob(updateArgs[0]);
        if (!current) fail(`Job not found: ${updateArgs[0]}`);
        const patch = JSON.parse(updateArgs[1]);
        const normalized = validateJobSpec(patch, current, 'update');
        if (dryRun) {
          emit({ ok: true, dry_run: true, valid: true, normalized });
          break;
        }
        const job = updateJob(updateArgs[0], patch);
        emit({ ok: true, job }, `Updated: ${fmt(job)}`);
        break;
      }
      case 'run': {
        const job = runJobNow(args[0]);
        if (!job) fail(`Job not found: ${args[0]}`);
        emit(
          { ok: true, job_id: job.id, name: job.name, dispatch_id: job.dispatch_id, dispatch_kind: job.dispatch_kind },
          `Scheduled for immediate run: ${job.name} (dispatch: ${job.dispatch_id})`
        );
        break;
      }
      case 'approve': {
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(args[0]);
        if (!approval) fail(`No pending approval for job: ${args[0]}`);
        resolveApproval(approval.id, 'approved', 'operator');
        emit({ ok: true, approval_id: approval.id, job_id: approval.job_id, status: 'approved' }, `Approved: ${approval.job_id}`);
        break;
      }
      case 'reject': {
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(args[0]);
        if (!approval) fail(`No pending approval for job: ${args[0]}`);
        const reason = args.slice(1).join(' ') || null;
        resolveApproval(approval.id, 'rejected', 'operator', reason);
        getDb().prepare("UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'awaiting_approval'").run(approval.run_id);
        emit(
          { ok: true, approval_id: approval.id, job_id: approval.job_id, status: 'rejected', reason },
          `Rejected: ${approval.job_id}${reason ? ' — ' + reason : ''}`
        );
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
        const rows = runs.map(r => ({
          id: r.id.slice(0, 8),
          status: r.status,
          started: r.started_at,
          finished: r.finished_at,
          durationMs: r.duration_ms,
          heartbeat: r.last_heartbeat,
        }));
        emit(jsonMode ? runs : rows, () => console.table(rows));
        break;
      }
      case 'running': {
        const runs = getRunningRuns();
        if (runs.length === 0) { emit([] , 'No running runs'); break; }
        const rows = runs.map(r => ({
          id: r.id.slice(0, 8),
          job: r.job_name,
          started: r.started_at,
          heartbeat: r.last_heartbeat,
          sessionKey: r.session_key,
        }));
        emit(jsonMode ? runs : rows, () => console.table(rows));
        break;
      }
      case 'stale': {
        const stale = getStaleRuns(parseInt(args[0] || '90', 10));
        if (stale.length === 0) { emit([], 'No stale runs'); break; }
        const rows = stale.map(r => ({
          id: r.id.slice(0, 8),
          job: r.job_name,
          heartbeat: r.last_heartbeat,
        }));
        emit(jsonMode ? stale : rows, () => console.table(rows));
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
      case 'team-inbox': {
        const teamId = args[0];
        if (!teamId) { console.error('Usage: msg team-inbox <team-id> [limit] [member-id] [task-id]'); process.exit(1); }
        const limit = parseInt(args[1] || '20', 10);
        const memberId = args[2] || null;
        const taskId = args[3] || null;
        const msgs = getTeamMessages(teamId, { limit, memberId, taskId, includeRead: true });
        if (msgs.length === 0) { console.log('Team inbox empty'); break; }
        console.table(msgs.map(m => ({
          id: m.id.slice(0, 8),
          from: m.from_agent,
          to: m.to_agent,
          member: m.member_id || '-',
          task: m.task_id || '-',
          kind: m.kind,
          status: m.status,
          ackRequired: !!m.ack_required,
          ackAt: m.ack_at || '-',
          attempts: m.delivery_attempts || 0,
          lastError: m.last_error || '-',
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
      case 'ack': {
        if (!args[0]) { console.error('Usage: msg ack <message-id> [actor] [note]'); process.exit(1); }
        const actor = args[1] || 'operator';
        const detail = args.slice(2).join(' ') || null;
        const msg = ackMessage(args[0], actor, detail);
        if (!msg) { console.error('Message not found:', args[0]); process.exit(1); }
        console.log('Acknowledged:', fmt({
          id: msg.id,
          status: msg.status,
          ack_at: msg.ack_at,
          read_at: msg.read_at,
        }));
        break;
      }
      case 'receipts': {
        if (!args[0]) { console.error('Usage: msg receipts <message-id> [limit]'); process.exit(1); }
        const rows = listMessageReceipts(args[0], parseInt(args[1] || '20', 10));
        if (rows.length === 0) { console.log('No receipts for message'); break; }
        console.table(rows.map(r => ({
          id: r.id.slice(0, 8),
          type: r.event_type,
          attempt: r.attempt ?? '-',
          actor: r.actor || '-',
          detail: (r.detail || '').slice(0, 80),
          at: r.created_at,
        })));
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
        const rows = agents.map(a => ({
          id: a.id,
          name: a.name,
          status: a.status,
          lastSeen: a.last_seen_at,
          sessionKey: a.session_key,
        }));
        emit(jsonMode ? agents : rows, () => console.table(rows));
        break;
      }
      case 'get': emit(getAgent(args[0])); break;
      case 'register': {
        const a = upsertAgent(args[0], { name: args[1] || args[0] });
        emit({ ok: true, agent: a }, `Registered: ${fmt(a)}`);
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
        if (approvals.length === 0) { emit([], 'No pending approvals'); break; }
        const rows = approvals.map(a => ({
          id: a.id.slice(0, 8),
          job: a.job_id.slice(0, 8),
          job_name: a.job_name || '-',
          run: a.run_id?.slice(0, 8) || '-',
          status: a.status,
          requested: a.requested_at,
        }));
        emit(jsonMode ? approvals : rows, () => console.table(rows));
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

  // ── Team Adapter ───────────────────────────────────────
  case 'team': {
    const {
      mapTeamMessages, listTeamTasks, listTeamMailboxEvents,
      createTeamTaskGate, checkTeamTaskGates, ackTeamMessage,
    } = await import('./team-adapter.js');

    switch (sub) {
      case 'map': {
        const mapped = mapTeamMessages(parseInt(args[0] || '200', 10));
        console.log(`Mapped ${mapped} team message(s)`);
        break;
      }
      case 'tasks': {
        if (!args[0]) { console.error('Usage: team tasks <team-id> [limit]'); process.exit(1); }
        const rows = listTeamTasks(args[0], parseInt(args[1] || '50', 10));
        if (rows.length === 0) { console.log('No team tasks'); break; }
        console.table(rows.map(t => ({
          team: t.team_id,
          task: t.id,
          member: t.member_id || '-',
          status: t.status,
          gateTracker: t.gate_tracker_id ? t.gate_tracker_id.slice(0, 8) + '…' : '-',
          gateStatus: t.gate_status || '-',
          updated: t.updated_at,
          completed: t.completed_at || '-',
        })));
        break;
      }
      case 'events': {
        if (!args[0]) { console.error('Usage: team events <team-id> [limit] [task-id]'); process.exit(1); }
        const teamId = args[0];
        const limit = parseInt(args[1] || '50', 10);
        const taskId = args[2] || null;
        const rows = listTeamMailboxEvents(teamId, { limit, taskId });
        if (rows.length === 0) { console.log('No team events'); break; }
        console.table(rows.map(e => ({
          id: e.id.slice(0, 8),
          team: e.team_id,
          member: e.member_id || '-',
          task: e.task_id || '-',
          message: e.message_id ? e.message_id.slice(0, 8) : '-',
          type: e.event_type,
          at: e.created_at,
        })));
        break;
      }
      case 'gate': {
        if (!args[0] || !args[1] || !args[2]) {
          console.error('Usage: team gate <team-id> <task-id> <members-json> [timeout-s]');
          console.error('Example: team gate core-team deploy-001 "[\\"writer\\",\\"reviewer\\"]" 900');
          process.exit(1);
        }
        const teamId = args[0];
        const taskId = args[1];
        const members = JSON.parse(args[2]);
        const timeoutS = parseInt(args[3] || '600', 10);
        const gate = createTeamTaskGate({ teamId, taskId, expectedMembers: members, timeoutS });
        console.log('Gate opened:', fmt(gate));
        break;
      }
      case 'check-gates': {
        const result = checkTeamTaskGates(parseInt(args[0] || '100', 10));
        console.log(fmt(result));
        break;
      }
      case 'ack': {
        if (!args[0]) { console.error('Usage: team ack <message-id> [actor] [note]'); process.exit(1); }
        const actor = args[1] || 'team-member';
        const detail = args.slice(2).join(' ') || null;
        const msg = ackTeamMessage(args[0], actor, detail);
        if (!msg) { console.error('Team message not found:', args[0]); process.exit(1); }
        console.log('Team ACK:', fmt({ id: msg.id, status: msg.status, ack_at: msg.ack_at }));
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
        if (aliases.length === 0) { emit([], 'No aliases defined'); break; }
        const rows = aliases.map(a => ({
          alias: a.alias,
          channel: a.channel,
          target: a.target,
          description: a.description || '',
        }));
        emit(jsonMode ? aliases : rows, () => console.table(rows));
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
        emit({ ok: true, alias: name, channel, target, description }, `Added alias: ${name} → ${channel}/${target}`);
        break;
      }
      case 'remove': {
        if (!args[0]) fail('Usage: alias remove <name>');
        const result = db.prepare('DELETE FROM delivery_aliases WHERE alias = ?').run(args[0]);
        if (result.changes > 0) emit({ ok: true, alias: args[0], removed: true }, `Removed alias: ${args[0]}`);
        else fail(`Alias not found: ${args[0]}`);
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
    const nextJob = jobs
      .filter(j => j.enabled && j.next_run_at)
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0] || null;
    const payload = {
      jobs_total: jobs.length,
      jobs_enabled: jobs.filter(j => j.enabled).length,
      running_runs: runningRuns.length,
      stale_runs: stale.length,
      agents: agents.map(a => ({
        id: a.id,
        status: a.status,
        unread: getUnreadCount(a.id),
      })),
      next_job: nextJob ? { id: nextJob.id, name: nextJob.name, next_run_at: nextJob.next_run_at } : null,
    };
    emit(payload, () => {
      console.log('=== OpenClaw Scheduler Status ===');
      console.log(`Jobs:     ${jobs.length} total, ${jobs.filter(j => j.enabled).length} enabled`);
      console.log(`Running:  ${runningRuns.length}`);
      console.log(`Stale:    ${stale.length}`);
      console.log(`Agents:   ${agents.length}`);
      for (const a of agents) {
        const unread = getUnreadCount(a.id);
        console.log(`  ${a.id}: ${a.status}${unread ? ` (${unread} unread)` : ''}`);
      }
      if (nextJob) console.log(`\nNext:     ${nextJob.name} at ${nextJob.next_run_at}`);
    });
    break;
  }

  case 'schema': {
    const key = (sub || 'all').toLowerCase();
    if (key === 'all') {
      emit(SCHEDULER_SCHEMAS);
      break;
    }
    const singularMap = {
      job: 'jobs',
      run: 'runs',
      message: 'messages',
      approval: 'approvals',
      dispatch: 'dispatches',
    };
    const resolved = singularMap[key] || key;
    if (!SCHEDULER_SCHEMAS[resolved]) fail(`Unknown schema target: ${sub}`);
    emit(SCHEDULER_SCHEMAS[resolved]);
    break;
  }

  default:
    usage();
    process.exit(command ? 1 : 0);
}
