#!/usr/bin/env node
// Scheduler CLI — manage jobs, runs, messages, agents
import { readFileSync } from 'fs';
import { initDb, getDb } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, cancelJob, runJobNow, validateJobSpec, parseInDuration, AT_JOB_CRON_SENTINEL } from './jobs.js';
import { getRun, getRunsForJob, getRunningRuns, getStaleRuns, finishRun } from './runs.js';
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
Usage: openclaw-scheduler <command> [subcommand] [options]

Global:
  --json                             Emit machine-readable JSON

Jobs:
  jobs list [--type watchdog]        List all jobs (optionally filter by type)
  jobs tree                          Show jobs as parent/child tree
  jobs get <id>                      Get job details
  jobs add <json> [--watchdog] [--at <datetime>] [--in <duration>] [--profile <id>]
                                     Add a job (--watchdog sets defaults for watchdog type)
                                     run_timeout_ms is REQUIRED (no default — prevents indefinite runs)
                                     --at: one-shot schedule, e.g. '2026-03-10T16:47:00-04:00'
                                     --in: one-shot sugar, e.g. '15m', '2h', '30s', '1d'
                                     --profile: auth profile override (null, 'inherit', or 'provider:label')
  jobs validate <json>               Validate a job spec without writing it
  jobs enable <id>                   Enable a job
  jobs disable <id>                  Disable a job
  jobs delete <id>                   Delete a job
  jobs cancel <id> [--no-cascade]   Cancel a job (+ children by default)
  jobs update <id> <json> [--profile <id>]
                                     Update job fields
                                     --profile: auth profile override (null, 'inherit', or 'provider:label')
  jobs run <id>                      Trigger immediate run (sets next_run_at to now)
  jobs approve <id>                  Approve a pending job
  jobs reject <id> [reason]          Reject with optional reason

Runs:
  runs list <job-id> [limit]         List runs for a job
  runs get <run-id>                  Get a run by id
  runs output <run-id> [stdout|stderr]  Print offloaded or stored shell output
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
        let jobs = listJobs();
        // Filter by --type if provided (e.g. --type watchdog)
        const typeFilterIdx = args.indexOf('--type');
        if (typeFilterIdx >= 0 && args[typeFilterIdx + 1]) {
          const typeFilter = args[typeFilterIdx + 1];
          jobs = jobs.filter(j => (j.job_type || 'standard') === typeFilter);
        }
        const rows = jobs.map(j => ({
          id: j.id.slice(0, 8) + '…',
          name: j.name,
          type: j.job_type || 'standard',
          kind: j.schedule_kind || 'cron',
          enabled: !!j.enabled,
          schedule: j.schedule_kind === 'at' ? `at:${(j.schedule_at || '').slice(0, 16)}` : j.schedule_cron,
          agent: j.agent_id || 'main',
          target: j.session_target,
          guarantee: j.delivery_guarantee || 'at-most-once',
          parent: j.parent_id ? j.parent_id.slice(0, 8) + '…' : '-',
          trigger: j.trigger_on || '-',
          ...(j.job_type === 'watchdog' ? { watchdog: j.watchdog_target_label || '-' } : {}),
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
        const isWatchdog = args.includes('--watchdog');
        const profileIdx = args.indexOf('--profile');
        const profileValue = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
        const atIdx = args.indexOf('--at');
        const atValue = atIdx >= 0 ? args[atIdx + 1] : undefined;
        const inIdx = args.indexOf('--in');
        const inValue = inIdx >= 0 ? args[inIdx + 1] : undefined;
        const skipArgs = new Set(['--dry-run', '--watchdog']);
        if (profileIdx >= 0) { skipArgs.add(args[profileIdx]); skipArgs.add(args[profileIdx + 1]); }
        if (atIdx >= 0) { skipArgs.add(args[atIdx]); skipArgs.add(args[atIdx + 1]); }
        if (inIdx >= 0) { skipArgs.add(args[inIdx]); skipArgs.add(args[inIdx + 1]); }
        const payload = args.find(a => !skipArgs.has(a));
        if (!payload) fail('Usage: jobs add <json> [--dry-run] [--watchdog] [--at <datetime>] [--in <duration>] [--profile <id>]');
        let spec;
        try { spec = JSON.parse(payload); } catch { fail('Invalid JSON. Usage: jobs add \'{"name":"..."}\''); }
        if (profileValue !== undefined) spec.auth_profile = profileValue;

        // One-shot scheduling via --at or --in
        if (atValue || inValue) {
          let scheduleAt;
          try {
            if (inValue) {
              scheduleAt = parseInDuration(inValue);
            } else {
              const d = new Date(atValue);
              if (isNaN(d.getTime())) throw new Error(`Invalid datetime: "${atValue}"`);
              scheduleAt = d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
            }
          } catch (err) {
            fail(`--at/--in error: ${err.message}`);
          }
          spec.schedule_kind = 'at';
          spec.schedule_at = scheduleAt;
          // Use sentinel cron to satisfy NOT NULL on existing DBs without nullable schedule_cron
          if (!spec.schedule_cron) spec.schedule_cron = AT_JOB_CRON_SENTINEL;
          spec.next_run_at = scheduleAt;
          // Default delete_after_run for at-jobs (user can override in JSON)
          if (spec.delete_after_run === undefined) spec.delete_after_run = 1;
        }

        // If --watchdog flag is set, apply watchdog defaults
        if (isWatchdog) {
          spec.job_type = 'watchdog';
          // Watchdog jobs default to shell target with shellCommand kind
          if (!spec.session_target) spec.session_target = 'shell';
          if (!spec.payload_kind) spec.payload_kind = 'shellCommand';
          if (!spec.payload_message) spec.payload_message = spec.watchdog_check_cmd || 'true';
          if (!spec.delivery_mode) spec.delivery_mode = 'none';
          if (spec.watchdog_self_destruct === undefined) spec.watchdog_self_destruct = 1;
        }

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
        let spec;
        try { spec = JSON.parse(args[0]); } catch { fail('Invalid JSON. Usage: jobs validate \'{"name":"..."}\''); }
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
        const updateProfileIdx = args.indexOf('--profile');
        const updateProfileValue = updateProfileIdx >= 0 ? args[updateProfileIdx + 1] : undefined;
        const updateFilterArgs = new Set(['--dry-run']);
        if (updateProfileIdx >= 0) { updateFilterArgs.add(args[updateProfileIdx]); updateFilterArgs.add(args[updateProfileIdx + 1]); }
        const updateArgs = args.filter(a => !updateFilterArgs.has(a));
        const current = getJob(updateArgs[0]);
        if (!current) fail(`Job not found: ${updateArgs[0]}`);
        let patch;
        try { patch = JSON.parse(updateArgs[1]); } catch { fail('Invalid JSON. Usage: jobs update <id> \'{"key":"value"}\''); }
        if (updateProfileValue !== undefined) patch.auth_profile = updateProfileValue;
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
        if (approval.run_id) {
          finishRun(approval.run_id, 'cancelled', { error_message: reason || 'Rejected by operator' });
        }
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
        if (!args[0]) fail('Usage: runs list <job-id> [limit]');
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
      case 'get': {
        const run = getRun(args[0]);
        if (!run) fail(`Run not found: ${args[0]}`);
        emit(run);
        break;
      }
      case 'output': {
        if (!args[0]) fail('Usage: runs output <run-id> [stdout|stderr]');
        const run = getRun(args[0]);
        if (!run) fail(`Run not found: ${args[0]}`);
        const kind = (args[1] || 'stdout').toLowerCase();
        const pathField = kind === 'stderr' ? 'shell_stderr_path' : 'shell_stdout_path';
        const textField = kind === 'stderr' ? 'shell_stderr' : 'shell_stdout';
        const filePath = run[pathField];
        let payload;
        try {
          payload = filePath ? readFileSync(filePath, 'utf8') : (run[textField] || '');
        } catch (err) {
          fail(`Cannot read output file ${filePath}: ${err.message}`);
        }
        if (jsonMode) {
          emit({ ok: true, run_id: run.id, kind, file_path: filePath || null, content: payload });
        } else {
          process.stdout.write(payload);
          if (!payload.endsWith('\n')) process.stdout.write('\n');
        }
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
        if (!from || !to) fail('Usage: msg send <from> <to> <body>');
        const msg = sendMessage({ from_agent: from, to_agent: to, body: bodyParts.join(' ') });
        emit({ ok: true, message: msg }, `Sent: ${fmt(msg)}`);
        break;
      }
      case 'inbox': {
        const msgs = getInbox(args[0], { limit: parseInt(args[1] || '20', 10), includeDelivered: true });
        if (msgs.length === 0) { emit([], 'Inbox empty'); break; }
        const rows = msgs.map(m => ({
          id: m.id.slice(0, 8),
          from: m.from_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 40),
          status: m.status,
          priority: m.priority,
          created: m.created_at,
        }));
        emit(jsonMode ? msgs : rows, () => console.table(rows));
        break;
      }
      case 'team-inbox': {
        const teamId = args[0];
        if (!teamId) fail('Usage: msg team-inbox <team-id> [limit] [member-id] [task-id]');
        const limit = parseInt(args[1] || '20', 10);
        const memberId = args[2] || null;
        const taskId = args[3] || null;
        const msgs = getTeamMessages(teamId, { limit, memberId, taskId, includeRead: true });
        if (msgs.length === 0) { emit([], 'Team inbox empty'); break; }
        const rows = msgs.map(m => ({
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
        }));
        emit(jsonMode ? msgs : rows, () => console.table(rows));
        break;
      }
      case 'outbox': {
        const msgs = getOutbox(args[0], parseInt(args[1] || '20', 10));
        if (msgs.length === 0) { emit([], 'Outbox empty'); break; }
        const rows = msgs.map(m => ({
          id: m.id.slice(0, 8),
          to: m.to_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 40),
          status: m.status,
          created: m.created_at,
        }));
        emit(jsonMode ? msgs : rows, () => console.table(rows));
        break;
      }
      case 'thread': {
        const msgs = getThread(args[0]);
        emit(msgs, () => {
          for (const m of msgs) {
            console.log(`[${m.from_agent} → ${m.to_agent}] (${m.status}) ${m.created_at}`);
            console.log(`  ${(m.body || '').slice(0, 200)}`);
            console.log();
          }
        });
        break;
      }
      case 'ack': {
        if (!args[0]) fail('Usage: msg ack <message-id> [actor] [note]');
        const actor = args[1] || 'operator';
        const detail = args.slice(2).join(' ') || null;
        const msg = ackMessage(args[0], actor, detail);
        if (!msg) fail('Message not found: ' + args[0]);
        emit(
          { ok: true, id: msg.id, status: msg.status, ack_at: msg.ack_at, read_at: msg.read_at },
          `Acknowledged: ${fmt({ id: msg.id, status: msg.status, ack_at: msg.ack_at, read_at: msg.read_at })}`
        );
        break;
      }
      case 'receipts': {
        if (!args[0]) fail('Usage: msg receipts <message-id> [limit]');
        const receipts = listMessageReceipts(args[0], parseInt(args[1] || '20', 10));
        if (receipts.length === 0) { emit([], 'No receipts for message'); break; }
        const rows = receipts.map(r => ({
          id: r.id.slice(0, 8),
          type: r.event_type,
          attempt: r.attempt ?? '-',
          actor: r.actor || '-',
          detail: (r.detail || '').slice(0, 80),
          at: r.created_at,
        }));
        emit(jsonMode ? receipts : rows, () => console.table(rows));
        break;
      }
      case 'read': { if (!args[0]) fail('Usage: msg read <message-id>'); markRead(args[0]); emit({ ok: true, message_id: args[0], read: true }, 'Marked read'); break; }
      case 'readall': { const r = markAllRead(args[0]); emit({ ok: true, agent: args[0], changes: r.changes }, `Marked ${r.changes} read`); break; }
      case 'unread': { if (!args[0]) fail('Usage: msg unread <agent-id>'); const count = getUnreadCount(args[0]); emit({ agent: args[0], unread: count }, `Unread: ${count}`); break; }
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
        const delivered = msgs.filter(m => m.status === 'delivered');
        const unread = getUnreadCount(agent);
        if (msgs.length === 0) { emit({ agent, pending: unread, delivered: 0, messages: [] }, 'Queue empty'); break; }
        const rows = msgs.map(m => ({
          id: m.id.slice(0, 8),
          from: m.from_agent,
          kind: m.kind,
          subject: m.subject?.slice(0, 45),
          status: m.status,
          priority: m.priority,
          created: m.created_at,
        }));
        emit(jsonMode ? { agent, pending: unread, delivered: delivered.length, messages: msgs } : rows, () => {
          console.log(`\nQueue for agent: ${agent} | ${unread} pending | ${delivered.length} delivered (showing last ${limit})\n`);
          console.table(rows);
        });
        break;
      }
      case 'clear': {
        const r = markAllRead(args[0] || 'main');
        emit({ ok: true, agent: args[0] || 'main', changes: r.changes }, `Cleared ${r.changes} messages`);
        break;
      }
      case 'prune': {
        pruneMessages();
        emit({ ok: true, pruned: true }, 'Pruned old messages (delivered >3d, system/result >3d, read/expired/failed >30d)');
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
        if (groups.length === 0) { emit([], 'No active task groups'); break; }
        const rows = groups.map(g => {
          const status = getTaskGroupStatus(g.id);
          if (!status) return null;
          let agents;
          try { agents = JSON.parse(g.expected_agents); } catch (e) {
            process.stderr.write('Warning: failed to parse expected_agents JSON for group ' + g.id + ': ' + e.message + '\n');
            agents = [];
          }
          return {
            id: g.id.slice(0, 8) + '…',
            name: g.name,
            agents: `${status.agents.filter(a => a.status === 'completed').length}/${agents.length}`,
            status: g.status,
            elapsed: `${status.elapsed}s`,
            timeout: `${g.timeout_s}s`,
          };
        }).filter(r => r !== null);
        emit(jsonMode ? groups : rows, () => console.table(rows));
        break;
      }
      case 'status': {
        const { getTaskGroupStatus } = await import('./task-tracker.js');
        const status = getTaskGroupStatus(args[0]);
        if (!status) fail('Task group not found: ' + args[0]);
        emit(status, () => {
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
        });
        break;
      }
      case 'create': {
        const { createTaskGroup } = await import('./task-tracker.js');
        let opts;
        try { opts = JSON.parse(args[0]); } catch { fail('Invalid JSON. Usage: tasks create \'{"name":"..."}\''); }
        const group = createTaskGroup(opts);
        emit({ ok: true, group }, `Created: ${fmt(group)}`);
        break;
      }
      case 'history': {
        const limit = parseInt(args[0] || '10', 10);
        const groups = getDb().prepare(
          "SELECT * FROM task_tracker WHERE status != 'active' ORDER BY completed_at DESC LIMIT ?"
        ).all(limit);
        if (groups.length === 0) { emit([], 'No completed task groups'); break; }
        const rows = groups.map(g => ({
          id: g.id.slice(0, 8) + '…',
          name: g.name,
          status: g.status,
          completed: g.completed_at,
          created_by: g.created_by,
        }));
        emit(jsonMode ? groups : rows, () => console.table(rows));
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
          fail('Usage: tasks heartbeat <trackerId> <agentLabel> running|completed|failed [message]');
        }

        if (status === 'running') {
          agentStarted(trackerId, agentLabel);
          emit({ ok: true, tracker_id: trackerId, agent: agentLabel, status: 'running' }, `Heartbeat recorded: ${agentLabel} -> running`);
        } else if (status === 'completed') {
          agentCompleted(trackerId, agentLabel, exitMsg);
          emit({ ok: true, tracker_id: trackerId, agent: agentLabel, status: 'completed', message: exitMsg }, `Heartbeat recorded: ${agentLabel} -> completed${exitMsg ? ` (${exitMsg})` : ''}`);
        } else if (status === 'failed') {
          agentFailed(trackerId, agentLabel, exitMsg || 'failed');
          emit({ ok: true, tracker_id: trackerId, agent: agentLabel, status: 'failed', message: exitMsg }, `Heartbeat recorded: ${agentLabel} -> failed${exitMsg ? ` (${exitMsg})` : ''}`);
        } else {
          fail(`Unknown status: "${status}". Valid values: running | completed | failed`);
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
          fail('Usage: tasks register-session <trackerId> <agentLabel> <sessionKey>');
        }
        registerAgentSession(trackerId, agentLabel, sessionKey);
        emit({ ok: true, tracker_id: trackerId, agent: agentLabel, session_key: sessionKey }, `Session registered: ${agentLabel} -> ${sessionKey}`);
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
    const { listIdempotencyForJob, getIdempotencyEntry, releaseIdempotencyKey, forcePruneIdempotency } = await import('./idempotency.js');
    switch (sub) {
      case 'status': {
        if (!args[0]) fail('Usage: idem status <job-id>');
        const entries = listIdempotencyForJob(args[0]);
        if (entries.length === 0) { emit([], 'No idempotency entries for this job'); break; }
        const rows = entries.map(e => ({
          key: e.key.slice(0, 12) + '…',
          run: (e.run_id?.slice(0, 8) || '-') + '…',
          status: e.status,
          claimed: e.claimed_at,
          released: e.released_at || '-',
          expires: e.expires_at,
          hash: e.result_hash || '-',
        }));
        emit(jsonMode ? entries : rows, () => console.table(rows));
        break;
      }
      case 'check': {
        if (!args[0]) fail('Usage: idem check <key>');
        const entry = getIdempotencyEntry(args[0]);
        if (!entry) { emit({ found: false, key: args[0] }, 'Key not found in ledger'); break; }
        emit(entry);
        break;
      }
      case 'release': {
        if (!args[0]) fail('Usage: idem release <key>');
        const before = getIdempotencyEntry(args[0]);
        if (!before) fail('Key not found in ledger');
        if (before.status === 'released') { emit({ ok: true, key: args[0], already_released: true }, 'Key already released'); break; }
        releaseIdempotencyKey(args[0]);
        emit({ ok: true, key: args[0], released: true }, `Released idempotency key: ${args[0].slice(0, 12)}…`);
        break;
      }
      case 'prune': {
        const result = forcePruneIdempotency();
        emit({ ok: true, pruned: result }, `Pruned ${result} expired idempotency entries`);
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
        emit({ ok: true, mapped }, `Mapped ${mapped} team message(s)`);
        break;
      }
      case 'tasks': {
        if (!args[0]) fail('Usage: team tasks <team-id> [limit]');
        const tasks = listTeamTasks(args[0], parseInt(args[1] || '50', 10));
        if (tasks.length === 0) { emit([], 'No team tasks'); break; }
        const rows = tasks.map(t => ({
          team: t.team_id,
          task: t.id,
          member: t.member_id || '-',
          status: t.status,
          gateTracker: t.gate_tracker_id ? t.gate_tracker_id.slice(0, 8) + '…' : '-',
          gateStatus: t.gate_status || '-',
          updated: t.updated_at,
          completed: t.completed_at || '-',
        }));
        emit(jsonMode ? tasks : rows, () => console.table(rows));
        break;
      }
      case 'events': {
        if (!args[0]) fail('Usage: team events <team-id> [limit] [task-id]');
        const teamId = args[0];
        const limit = parseInt(args[1] || '50', 10);
        const taskId = args[2] || null;
        const events = listTeamMailboxEvents(teamId, { limit, taskId });
        if (events.length === 0) { emit([], 'No team events'); break; }
        const rows = events.map(e => ({
          id: e.id.slice(0, 8),
          team: e.team_id,
          member: e.member_id || '-',
          task: e.task_id || '-',
          message: e.message_id ? e.message_id.slice(0, 8) : '-',
          type: e.event_type,
          at: e.created_at,
        }));
        emit(jsonMode ? events : rows, () => console.table(rows));
        break;
      }
      case 'gate': {
        if (!args[0] || !args[1] || !args[2]) {
          fail('Usage: team gate <team-id> <task-id> <members-json> [timeout-s]\nExample: team gate core-team deploy-001 "[\\"writer\\",\\"reviewer\\"]" 900');
        }
        const teamId = args[0];
        const taskId = args[1];
        let members;
        try { members = JSON.parse(args[2]); } catch { fail('Invalid JSON for members list. Example: \'["writer","reviewer"]\''); }
        const timeoutS = parseInt(args[3] || '600', 10);
        const gate = createTeamTaskGate({ teamId, taskId, expectedMembers: members, timeoutS });
        emit({ ok: true, gate }, `Gate opened: ${fmt(gate)}`);
        break;
      }
      case 'check-gates': {
        const result = checkTeamTaskGates(parseInt(args[0] || '100', 10));
        emit(result);
        break;
      }
      case 'ack': {
        if (!args[0]) fail('Usage: team ack <message-id> [actor] [note]');
        const actor = args[1] || 'team-member';
        const detail = args.slice(2).join(' ') || null;
        const msg = ackTeamMessage(args[0], actor, detail);
        if (!msg) fail('Team message not found: ' + args[0]);
        emit(
          { ok: true, id: msg.id, status: msg.status, ack_at: msg.ack_at },
          `Team ACK: ${fmt({ id: msg.id, status: msg.status, ack_at: msg.ack_at })}`
        );
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
          fail('Usage: alias add <name> <channel> <target> [description]');
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
    const db = getDb();
    const jobs = listJobs();
    const runningRuns = getRunningRuns();
    const stale = getStaleRuns();
    const agents = listAgents();
    const budget = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM job_dispatch_queue WHERE status = 'pending') AS pending_dispatches,
        (SELECT COUNT(*) FROM job_dispatch_queue WHERE status = 'awaiting_approval') AS approval_blocked_dispatches,
        (SELECT COALESCE(SUM(queued_count), 0) FROM jobs) AS overlap_queued_dispatches,
        (SELECT COUNT(*) FROM approvals WHERE status = 'pending') AS pending_approvals,
        (SELECT COALESCE(SUM(shell_stdout_bytes + shell_stderr_bytes), 0) FROM runs) AS shell_output_bytes,
        (SELECT COUNT(*) FROM runs WHERE shell_stdout_path IS NOT NULL OR shell_stderr_path IS NOT NULL) AS offloaded_shell_runs
    `).get();
    const hotJobs = db.prepare(`
      SELECT
        j.id, j.name, j.queued_count, j.max_queued_dispatches, j.max_pending_approvals,
        (SELECT COUNT(*) FROM approvals a WHERE a.job_id = j.id AND a.status = 'pending') AS pending_approval_count,
        (SELECT COUNT(*) FROM job_dispatch_queue q WHERE q.job_id = j.id AND q.status IN ('pending', 'claimed', 'awaiting_approval')) AS dispatch_backlog
      FROM jobs j
      WHERE
        j.queued_count >= j.max_queued_dispatches
        OR (SELECT COUNT(*) FROM approvals a WHERE a.job_id = j.id AND a.status = 'pending') >= j.max_pending_approvals
      ORDER BY j.name
      LIMIT 10
    `).all();
    const nextJob = jobs
      .filter(j => j.enabled && j.next_run_at)
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0] || null;
    const payload = {
      jobs_total: jobs.length,
      jobs_enabled: jobs.filter(j => j.enabled).length,
      running_runs: runningRuns.length,
      stale_runs: stale.length,
      budgets: budget,
      budget_hotspots: hotJobs,
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
      console.log(`Dispatch: ${budget.pending_dispatches} pending, ${budget.approval_blocked_dispatches} approval-blocked, ${budget.overlap_queued_dispatches} overlap-queued`);
      console.log(`Approvals:${budget.pending_approvals} pending`);
      console.log(`Output:   ${budget.shell_output_bytes} bytes stored/offloaded across runs (${budget.offloaded_shell_runs} offloaded runs)`);
      console.log(`Agents:   ${agents.length}`);
      for (const a of agents) {
        const unread = getUnreadCount(a.id);
        console.log(`  ${a.id}: ${a.status}${unread ? ` (${unread} unread)` : ''}`);
      }
      if (hotJobs.length > 0) {
        console.log('\nBudget hotspots:');
        console.table(hotJobs.map(job => ({
          name: job.name,
          dispatchBacklog: job.dispatch_backlog,
          queuedCount: job.queued_count,
          maxQueued: job.max_queued_dispatches,
          pendingApprovals: job.pending_approval_count,
          maxApprovals: job.max_pending_approvals,
        })));
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
    if (command) {
      fail(`Unknown command: ${command}. Run without arguments for usage.`);
    }
    usage();
    process.exit(0);
}
