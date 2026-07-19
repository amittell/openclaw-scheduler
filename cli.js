#!/usr/bin/env node
// Scheduler CLI -- manage jobs, runs, messages, agents
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb, getResolvedDbPath } from './db.js';
import { createJob, getJob, listJobs, updateJob, deleteJob, cancelJob, runJobNow, validateJobSpec, parseInDuration, AT_JOB_CRON_SENTINEL } from './jobs.js';
import { getRun, getRunsForJob, getRunningRuns, getStaleRuns, getEvidenceRecord } from './runs.js';
import { verifyPersistedArtifactBoundEvidence } from './evidence-runtime.js';
import {
  sendMessage, getInbox, getOutbox, getThread, markRead, markAllRead, getUnreadCount, pruneMessages,
  ackMessage, getMessage, listMessageReceipts, getTeamMessages,
} from './messages.js';
import { upsertAgent, getAgent, listAgents } from './agents.js';
import { resolveSchedulerHome } from './paths.js';
import {
  SCHEDULER_PRODUCT_SCHEMA_LABEL,
  SCHEDULER_SCHEMAS,
  SCHEDULER_SCHEMA_VERSION,
} from './scheduler-schema.js';
import { HANDOFF_V4_RUNTIME_CONTRACT } from './handoff-artifact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);
const jsonFlagIndex = cliArgs.indexOf('--json');
const jsonMode = jsonFlagIndex >= 0;
if (jsonFlagIndex >= 0) cliArgs.splice(jsonFlagIndex, 1);
const [command, sub, ...args] = cliArgs;

function firstNonEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

function isNodeModulesInstall(moduleDir) {
  return /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?openclaw-scheduler(?:[\\/]|$)/.test(moduleDir);
}

function isValidationOnlyCommand(cmd, subcommand, rest) {
  return cmd === 'jobs' && (
    subcommand === 'validate'
    || (subcommand === 'add' && rest.includes('--dry-run'))
  );
}

function commandRequiresDb(cmd, subcommand, rest) {
  if (!cmd || ['help', '--help', '-h', 'version', '--version', '-v'].includes(cmd)) return false;
  if (cmd === 'schema' || cmd === 'capabilities') return false;
  if (isValidationOnlyCommand(cmd, subcommand, rest)) return false;
  return true;
}

function getDbPathMismatchNotice(env = process.env) {
  if (firstNonEmpty(env.SCHEDULER_DB)) return null;
  if (isNodeModulesInstall(__dirname)) return null;

  const repoDbPath = join(__dirname, 'scheduler.db');
  const resolvedDbPath = getResolvedDbPath();
  if (resolvedDbPath !== repoDbPath) return null;

  const runtimeDbPath = join(resolveSchedulerHome(env), 'scheduler.db');
  if (runtimeDbPath === resolvedDbPath) return null;
  if (!existsSync(runtimeDbPath)) return null;

  return { resolvedDbPath, runtimeDbPath };
}

function formatDbPathMismatchNotice({ resolvedDbPath, runtimeDbPath }, { validation = false } = {}) {
  const prefix = validation ? 'Refusing to run validation.' : 'Warning: source checkout CLI is using a repo-local DB.';
  return `${prefix} repo-local=${resolvedDbPath} runtime=${runtimeDbPath}. Re-run via the installed package CLI or set SCHEDULER_DB explicitly.`;
}

function usage() {
  console.log(`
Usage: openclaw-scheduler <command> [subcommand] [options]

Global:
  --json                             Emit machine-readable JSON

Jobs:
  jobs list [--type watchdog] [--include-handoff-artifacts]
                                     List jobs; opt in to validated v4 artifact payloads
  jobs tree                          Show jobs as parent/child tree
  jobs get <id>                      Get job details
  jobs add <json>|--file <path>|--stdin [--watchdog] [--at <datetime>] [--in <duration>] [--profile <id>]
                                     Add a job (--watchdog sets defaults for watchdog type)
                                     run_timeout_ms is REQUIRED (no default -- prevents indefinite runs)
                                     --at: one-shot schedule, e.g. '2026-03-10T16:47:00-04:00'
                                     --in: one-shot sugar, e.g. '15m', '2h', '30s', '1d'
                                     --profile: auth profile override (null, 'inherit', or 'provider:label')
  jobs validate <json>|--file <path>|--stdin
                                     Validate a job spec without writing it
  jobs enable <id>                   Enable a job
  jobs disable <id>                  Disable a job
  jobs delete <id>                   Delete a job
  jobs cancel <id> [--no-cascade]   Cancel a job (+ children by default)
  jobs update <id> <json>|--file <path>|--stdin [--profile <id>]
                                     Update job fields
                                     --profile: auth profile override (null, 'inherit', or 'provider:label')
  jobs run <id>                      Trigger immediate run (sets next_run_at to now)
  jobs approve <id> [--reason <text>]
                                     Approve the latest pending gate as the authenticated local OS user
  jobs reject <id> [reason]          Reject with optional reason

Runs:
  runs list <job-id> [limit]         List runs for a job
  runs get <run-id>                  Get a run by id
  runs output <run-id> [stdout|stderr]  Print offloaded or stored shell output
  runs evidence <run-id>             Read and verify persisted content-addressed evidence
  runs running                       Currently running runs
  runs stale [threshold-s]           Stale runs

Queue:
  queue list [agent] [limit]         Show pending + delivered messages (default: main)
  queue clear [agent]                Mark all messages read
  queue prune                        Prune old messages now

Messages:
  messages send --from <label> [--to <agent>] [--kind <kind>] [--channel <channel>] [--delivery-to <target>] --body "<text>"
                                     Send a checkpoint/status message (kind defaults to 'status', to defaults to 'main'; channel/delivery-to override inbox-consumer defaults)
  msg send <from> <to> <body>        Send a message (positional form)
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
  approvals approve <approval-id> [--reason <text>]
                                     Approve one exact gate as the authenticated local OS user
  approvals reject <approval-id> [--reason <text>]
                                     Reject one exact gate as the authenticated local OS user

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
  doctor [--deep]                    Validate DB/schema/runtime health; --deep verifies every evidence record

Schema:
  schema [jobs|runs|messages|approvals|dispatches|dispatcher_leases|delivery_outbox|delivery_attachments|evidence_records|all]

Capabilities:
  capabilities                       Report runtime feature support without opening the DB
`);
}

const requiresDb = commandRequiresDb(command, sub, args);
const shouldCheckDbPath = requiresDb || isValidationOnlyCommand(command, sub, args);
const dbPathMismatchNotice = shouldCheckDbPath ? getDbPathMismatchNotice(process.env) : null;
if (dbPathMismatchNotice) {
  if (isValidationOnlyCommand(command, sub, args)) {
    fail(formatDbPathMismatchNotice(dbPathMismatchNotice, { validation: true }));
  }
  process.stderr.write(`${formatDbPathMismatchNotice(dbPathMismatchNotice)}\n`);
}

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

function fail(message, code = 1, errorCode = 'CLI_ERROR', details = null) {
  if (jsonMode) {
    console.log(fmt({ ok: false, error: message, code: errorCode, ...(details ? { details } : {}) }));
  } else {
    console.error(message);
  }
  process.exit(code);
}

function commandPositionals(argv, { valueFlags = [], booleanFlags = [] } = {}) {
  const values = new Set([...valueFlags, '--file']);
  const booleans = new Set([...booleanFlags, '--stdin']);
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (values.has(arg)) {
      i++;
      continue;
    }
    if (booleans.has(arg)) continue;
    if (arg.startsWith('--')) continue;
    positionals.push(arg);
  }
  return positionals;
}

function readJsonPayload(argv, {
  skipPositionals = 0,
  valueFlags = [],
  booleanFlags = [],
  usage: commandUsage,
} = {}) {
  const fileIndexes = argv.reduce((indexes, arg, index) => {
    if (arg === '--file') indexes.push(index);
    return indexes;
  }, []);
  if (fileIndexes.length > 1) fail(`Only one --file payload may be provided. ${commandUsage}`, 1, 'INVALID_ARGUMENT');
  const fileIndex = fileIndexes[0] ?? -1;
  const filePath = fileIndex >= 0 ? argv[fileIndex + 1] : null;
  if (fileIndex >= 0 && (!filePath || filePath.startsWith('--'))) {
    fail(`--file requires a path. ${commandUsage}`, 1, 'INVALID_ARGUMENT');
  }
  const stdinRequested = argv.includes('--stdin') || filePath === '-';
  const positionals = commandPositionals(argv, { valueFlags, booleanFlags });
  const inline = positionals.slice(skipPositionals);
  const sourceCount = Number(fileIndex >= 0 && filePath !== '-') + Number(stdinRequested) + Number(inline.length > 0);
  if (sourceCount !== 1 || inline.length > 1) {
    fail(`Provide exactly one JSON payload using an inline value, --file <path>, or --stdin. ${commandUsage}`, 1, 'INVALID_ARGUMENT');
  }

  let raw;
  let source;
  try {
    if (stdinRequested) {
      source = 'stdin';
      raw = readFileSync(0, 'utf8');
    } else if (fileIndex >= 0) {
      source = filePath;
      raw = readFileSync(filePath, 'utf8');
    } else {
      source = 'inline JSON';
      raw = inline[0];
    }
  } catch (err) {
    fail(`Unable to read JSON payload from ${source || filePath}: ${err.message}`, 1, 'PAYLOAD_READ_FAILED');
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`JSON payload from ${source} must be an object`, 1, 'INVALID_JSON');
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'INVALID_JSON') throw err;
    fail(`Invalid JSON from ${source}: ${err.message}`, 1, 'INVALID_JSON');
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(name));
}

function countByStatus(db, table) {
  if (!tableExists(db, table)) return {};
  return Object.fromEntries(db.prepare(
    `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status ORDER BY status`
  ).all().map(row => [row.status, row.count]));
}

async function getOperationalDiagnostics(db, opts = {}) {
  const lease = tableExists(db, 'dispatcher_leases')
    ? db.prepare(`
        SELECT *, CASE WHEN julianday(expires_at) > julianday('now') THEN 1 ELSE 0 END AS active
        FROM dispatcher_leases WHERE name = 'scheduler-dispatcher'
      `).get() || null
    : null;
  const queue = tableExists(db, 'job_dispatch_queue')
    ? {
        statuses: countByStatus(db, 'job_dispatch_queue'),
        expired_claims: db.prepare(`
          SELECT COUNT(*) AS count FROM job_dispatch_queue
          WHERE status = 'claimed' AND claim_expires_at IS NOT NULL
            AND julianday(claim_expires_at) <= julianday('now')
        `).get().count,
      }
    : { statuses: {}, expired_claims: null };
  const outbox = tableExists(db, 'delivery_outbox')
    ? {
        statuses: countByStatus(db, 'delivery_outbox'),
        due: db.prepare(`
          SELECT COUNT(*) AS count FROM delivery_outbox
          WHERE status = 'pending' AND julianday(next_attempt_at) <= julianday('now')
        `).get().count,
        expired_claims: db.prepare(`
          SELECT COUNT(*) AS count FROM delivery_outbox
          WHERE status = 'claimed' AND claim_expires_at IS NOT NULL
            AND julianday(claim_expires_at) <= julianday('now')
        `).get().count,
      }
    : { statuses: {}, due: null, expired_claims: null };
  const approvals = tableExists(db, 'approvals')
    ? {
        statuses: countByStatus(db, 'approvals'),
        expired_pending: db.prepare(`
          SELECT COUNT(*) AS count FROM approvals
          WHERE status = 'pending' AND expires_at IS NOT NULL
            AND julianday(expires_at) <= julianday('now')
        `).get().count,
      }
    : { statuses: {}, expired_pending: null };
  const cancellation = tableExists(db, 'runs')
    ? db.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE cancel_requested_at IS NOT NULL
          AND status IN ('pending', 'running', 'awaiting_approval', 'approved')
      `).get().count
    : null;
  const recoveryBlocked = tableExists(db, 'runs')
    ? db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'recovery_blocked'").get().count
    : null;
  const cleanupFailures = tableExists(db, 'runs')
    ? db.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE json_valid(context_summary) = 1
          AND json_extract(context_summary, '$.credential_cleanup.status') = 'failed'
      `).get().count
    : null;
  const evidence = tableExists(db, 'evidence_records')
    ? await (async () => {
      const total = db.prepare('SELECT COUNT(*) AS count FROM evidence_records').get().count;
      const deep = opts.deepEvidence === true;
      const evidenceLimit = Number.isInteger(opts.evidenceLimit) && opts.evidenceLimit > 0
        ? opts.evidenceLimit
        : 500;
      const rowStatement = deep
        ? db.prepare('SELECT run_id, handoff_artifact_digest FROM evidence_records ORDER BY created_at DESC, run_id DESC')
        : db.prepare('SELECT run_id, handoff_artifact_digest FROM evidence_records ORDER BY created_at DESC, run_id DESC LIMIT ?');
      const rows = deep ? rowStatement.all() : rowStatement.all(evidenceLimit);
      let checked = 0;
      let invalidCount = 0;
      const invalidSamples = [];
      for (const row of rows) {
        checked += 1;
        const record = row.handoff_artifact_digest
          ? await verifyPersistedArtifactBoundEvidence(row.run_id, { db })
          : getEvidenceRecord(row.run_id, { db });
        if (record?.integrity?.valid !== true) {
          invalidCount += 1;
          if (invalidSamples.length < 20) {
            invalidSamples.push({
              run_id: row.run_id,
              error: record?.integrity?.error || 'record unavailable',
            });
          }
        }
      }
      const missingWhere = `
          FROM runs r
          WHERE r.status IN ('ok', 'error', 'timeout', 'skipped', 'cancelled', 'crashed', 'recovery_blocked')
            AND r.evidence_required = 1
            AND NOT EXISTS (SELECT 1 FROM evidence_records e WHERE e.run_id = r.id)
            AND NOT (
              COALESCE(json_valid(r.evidence_record), 0) = 1
              AND json_extract(r.evidence_record, '$.pruned') = 1
              AND json_extract(r.evidence_record, '$.reason') = 'retention_expired'
            )
      `;
      const missingCount = tableExists(db, 'runs') && tableExists(db, 'jobs')
        ? db.prepare(`SELECT COUNT(*) AS count ${missingWhere}`).get().count
        : 0;
      const missingSamples = missingCount > 0
        ? db.prepare(`SELECT r.id AS run_id, r.job_id ${missingWhere} ORDER BY r.started_at ASC LIMIT 20`).all()
        : [];
      return {
        total,
        checked,
        unchecked: Math.max(0, total - checked),
        verification_complete: checked === total,
        invalid: invalidCount,
        invalid_samples: invalidSamples,
        missing: missingCount,
        missing_samples: missingSamples,
      };
    })()
    : {
        total: null,
        checked: null,
        unchecked: null,
        verification_complete: null,
        invalid: null,
        invalid_samples: [],
        missing: null,
        missing_samples: [],
      };
  return {
    dispatcher_lease: lease,
    dispatch_queue: queue,
    delivery_outbox: outbox,
    approvals,
    cancellation_pending_runs: cancellation,
    recovery_blocked_runs: recoveryBlocked,
    credential_cleanup_failures: cleanupFailures,
    evidence_records: evidence,
  };
}

function getSchemaVersion(db) {
  if (!tableExists(db, 'schema_migrations')) return null;
  return db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null;
}

async function main() {
  if (requiresDb) await initDb();

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;

  case 'version':
  case '--version':
  case '-v': {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    emit({ name: pkg.name, version: pkg.version }, `${pkg.name} ${pkg.version}`);
    break;
  }

  // -- Jobs ------------------------------------------------
  case 'jobs':
    switch (sub) {
      case 'list': {
        let jobs = listJobs({
          includeHandoffArtifacts: args.includes('--include-handoff-artifacts'),
        });
        // Filter by --type if provided (e.g. --type watchdog)
        const typeFilterIdx = args.indexOf('--type');
        if (typeFilterIdx >= 0 && args[typeFilterIdx + 1]) {
          const typeFilter = args[typeFilterIdx + 1];
          jobs = jobs.filter(j => (j.job_type || 'standard') === typeFilter);
        }
        const rows = jobs.map(j => ({
          id: j.id.slice(0, 8) + '..',
          name: j.name,
          type: j.job_type || 'standard',
          kind: j.schedule_kind || 'cron',
          enabled: !!j.enabled,
          schedule: j.schedule_kind === 'at' ? `at:${(j.schedule_at || '').slice(0, 16)}` : j.schedule_cron,
          agent: j.agent_id || 'main',
          target: j.session_target,
          guarantee: j.delivery_guarantee || 'at-most-once',
          parent: j.parent_id ? j.parent_id.slice(0, 8) + '..' : '-',
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
          const status = job.enabled ? '[on]' : '[ ]';
          const trigger = job.trigger_on ? ` [on:${job.trigger_on}]` : '';
          const delay = job.trigger_delay_s ? ` (+${job.trigger_delay_s}s)` : '';
          console.log(`${indent}${status} ${job.name} (${job.agent_id || 'main'})${trigger}${delay}`);
          const children = childMap[job.id] || [];
          for (const child of children) {
            printTree(child, indent + '  |- ');
          }
        }
        emit(roots.map(treeNode), () => {
          for (const root of roots) printTree(root);
        });
        break;
      }
      case 'get': {
        if (!args[0]) fail('Usage: jobs get <id>', 1, 'INVALID_ARGUMENT');
        const job = getJob(args[0]);
        if (!job) fail(`Job not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit(job);
        break;
      }
      case 'add': {
        const dryRun = args.includes('--dry-run');
        const isWatchdog = args.includes('--watchdog');
        const profileIdx = args.indexOf('--profile');
        const profileValue = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
        const fallbackProfileIdx = args.indexOf('--fallback-profile');
        const fallbackProfileValue = fallbackProfileIdx >= 0 ? args[fallbackProfileIdx + 1] : undefined;
        const atIdx = args.indexOf('--at');
        const atValue = atIdx >= 0 ? args[atIdx + 1] : undefined;
        const inIdx = args.indexOf('--in');
        const inValue = inIdx >= 0 ? args[inIdx + 1] : undefined;
        const addUsage = 'Usage: jobs add <json>|--file <path>|--stdin [--dry-run] [--watchdog] [--at <datetime>] [--in <duration>] [--profile <id>] [--fallback-profile <id>]';
        const spec = readJsonPayload(args, {
          valueFlags: ['--profile', '--fallback-profile', '--at', '--in'],
          booleanFlags: ['--dry-run', '--watchdog'],
          usage: addUsage,
        });
        if (profileValue !== undefined) spec.auth_profile = profileValue;
        if (fallbackProfileValue !== undefined) spec.auth_profile_fallback = fallbackProfileValue;

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
        const spec = readJsonPayload(args, { usage: 'Usage: jobs validate <json>|--file <path>|--stdin' });
        const normalized = validateJobSpec(spec, null, 'create');
        emit({ ok: true, valid: true, normalized });
        break;
      }
      case 'enable': {
        if (!args[0]) fail('Usage: jobs enable <id>', 1, 'INVALID_ARGUMENT');
        const job = updateJob(args[0], { enabled: 1 });
        if (!job) fail(`Job not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit({ ok: true, job_id: args[0], enabled: true }, 'Enabled');
        break;
      }
      case 'disable': {
        if (!args[0]) fail('Usage: jobs disable <id>', 1, 'INVALID_ARGUMENT');
        const job = updateJob(args[0], { enabled: 0 });
        if (!job) fail(`Job not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit({ ok: true, job_id: args[0], enabled: false }, 'Disabled');
        break;
      }
      case 'delete': {
        if (!args[0]) fail('Usage: jobs delete <id>', 1, 'INVALID_ARGUMENT');
        if (!getJob(args[0])) fail(`Job not found: ${args[0]}`, 1, 'NOT_FOUND');
        deleteJob(args[0]);
        emit({ ok: true, job_id: args[0], deleted: true }, 'Deleted');
        break;
      }
      case 'cancel': {
        const noCascade = args.includes('--no-cascade');
        const id = args.find(a => !a.startsWith('--'));
        if (!id) fail('Usage: jobs cancel <id> [--no-cascade]');
        if (!getJob(id)) fail(`Job not found: ${id}`, 1, 'NOT_FOUND');
        const cancelled = cancelJob(id, { cascade: !noCascade });
        emit({ ok: true, cancelled }, `Cancelled ${cancelled.length} job(s): ${cancelled.map(c => c.slice(0, 8) + '..').join(', ')}`);
        break;
      }
      case 'update': {
        const dryRun = args.includes('--dry-run');
        const updateProfileIdx = args.indexOf('--profile');
        const updateProfileValue = updateProfileIdx >= 0 ? args[updateProfileIdx + 1] : undefined;
        const updateFallbackProfileIdx = args.indexOf('--fallback-profile');
        const updateFallbackProfileValue = updateFallbackProfileIdx >= 0 ? args[updateFallbackProfileIdx + 1] : undefined;
        const updatePositionals = commandPositionals(args, {
          valueFlags: ['--profile', '--fallback-profile'],
          booleanFlags: ['--dry-run'],
        });
        const jobId = updatePositionals[0];
        if (!jobId) fail('Usage: jobs update <id> <json>|--file <path>|--stdin [--dry-run] [--profile <id>] [--fallback-profile <id>]', 1, 'INVALID_ARGUMENT');
        const current = getJob(jobId);
        if (!current) fail(`Job not found: ${jobId}`, 1, 'NOT_FOUND');
        const patch = readJsonPayload(args, {
          skipPositionals: 1,
          valueFlags: ['--profile', '--fallback-profile'],
          booleanFlags: ['--dry-run'],
          usage: 'Usage: jobs update <id> <json>|--file <path>|--stdin [--dry-run] [--profile <id>] [--fallback-profile <id>]',
        });
        if (updateProfileValue !== undefined) patch.auth_profile = updateProfileValue;
        if (updateFallbackProfileValue !== undefined) patch.auth_profile_fallback = updateFallbackProfileValue;
        const normalized = validateJobSpec(patch, current, 'update');
        if (dryRun) {
          emit({ ok: true, dry_run: true, valid: true, normalized });
          break;
        }
        const job = updateJob(jobId, patch);
        emit({ ok: true, job }, `Updated: ${fmt(job)}`);
        break;
      }
      case 'run': {
        const job = runJobNow(args[0]);
        if (!job) fail(`Job not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit(
          { ok: true, job_id: job.id, name: job.name, dispatch_id: job.dispatch_id, dispatch_kind: job.dispatch_kind },
          `Scheduled for immediate run: ${job.name} (dispatch: ${job.dispatch_id})`
        );
        break;
      }
      case 'approve': {
        const approvePositionals = commandPositionals(args, {
          valueFlags: ['--reason'],
        });
        const jobId = approvePositionals[0];
        if (!jobId) fail('Usage: jobs approve <job-id> [--reason <text>]');
        const reasonIdx = args.indexOf('--reason');
        const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : (approvePositionals.slice(1).join(' ') || null);
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(jobId);
        if (!approval) fail(`No pending approval for job: ${jobId}`, 1, 'NOT_FOUND');
        const resolved = resolveApproval(approval.id, 'approved', null, reason);
        if (!resolved || resolved.status !== 'approved') {
          fail(`Approval could not be granted; current status is ${resolved?.status || 'unknown'}`, 1, 'APPROVAL_CONFLICT');
        }
        emit({
          ok: true,
          approval_id: approval.id,
          job_id: approval.job_id,
          status: 'approved',
          approver: resolved.resolved_by,
          risk_level: approval.risk_level || null,
          approver_scope: approval.approver_scope || null,
        }, `Approved: ${approval.job_id}`);
        break;
      }
      case 'reject': {
        if (!args[0]) fail('Usage: jobs reject <job-id> [reason]');
        const { getPendingApproval, resolveApproval } = await import('./approval.js');
        const approval = getPendingApproval(args[0]);
        if (!approval) fail(`No pending approval for job: ${args[0]}`, 1, 'NOT_FOUND');
        const reason = args.slice(1).join(' ') || null;
        const resolved = resolveApproval(approval.id, 'rejected', null, reason);
        if (!resolved || resolved.status !== 'rejected') {
          fail(`Approval could not be rejected; current status is ${resolved?.status || 'unknown'}`, 1, 'APPROVAL_CONFLICT');
        }
        emit(
          { ok: true, approval_id: approval.id, job_id: approval.job_id, status: 'rejected', reason },
          `Rejected: ${approval.job_id}${reason ? ' -- ' + reason : ''}`
        );
        break;
      }
      default: usage();
    }
    break;

  // -- Runs ------------------------------------------------
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
        if (!run) fail(`Run not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit(run);
        break;
      }
      case 'output': {
        if (!args[0]) fail('Usage: runs output <run-id> [stdout|stderr]');
        const run = getRun(args[0]);
        if (!run) fail(`Run not found: ${args[0]}`, 1, 'NOT_FOUND');
        const kind = (args[1] || 'stdout').toLowerCase();
        if (kind !== 'stdout' && kind !== 'stderr') fail('Usage: runs output <run-id> [stdout|stderr]');
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
      case 'evidence': {
        if (!args[0]) fail('Usage: runs evidence <run-id>');
        const evidenceRow = getDb().prepare(
          'SELECT handoff_artifact_digest, evidence_verified FROM evidence_records WHERE run_id = ?',
        ).get(args[0]);
        const evidence = evidenceRow?.handoff_artifact_digest && evidenceRow.evidence_verified === 1
          ? await verifyPersistedArtifactBoundEvidence(args[0])
          : getEvidenceRecord(args[0]);
        if (!evidence) fail(`Evidence not found for run: ${args[0]}`, 1, 'NOT_FOUND');
        emit({ ok: evidence.integrity?.valid === true, evidence });
        if (evidence.integrity?.valid !== true) process.exitCode = 1;
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

  // -- Messages --------------------------------------------
  case 'msg':
    switch (sub) {
      case 'send': {
        const [from, to, ...bodyParts] = args;
        if (!from || !to || !bodyParts.length) fail('Usage: msg send <from> <to> <body>');
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
            console.log(`[${m.from_agent} -> ${m.to_agent}] (${m.status}) ${m.created_at}`);
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
        if (!msg) fail('Message not found: ' + args[0], 1, 'NOT_FOUND');
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
      case 'read': {
        if (!args[0]) fail('Usage: msg read <message-id>');
        if (!getMessage(args[0])) fail(`Message not found: ${args[0]}`, 1, 'NOT_FOUND');
        markRead(args[0]);
        emit({ ok: true, message_id: args[0], read: true }, 'Marked read');
        break;
      }
      case 'readall': { if (!args[0]) fail('Usage: msg readall <agent-id>'); const r = markAllRead(args[0]); emit({ ok: true, agent: args[0], changes: r.changes }, `Marked ${r.changes} read`); break; }
      case 'unread': { if (!args[0]) fail('Usage: msg unread <agent-id>'); const count = getUnreadCount(args[0]); emit({ agent: args[0], unread: count }, `Unread: ${count}`); break; }
      default: usage();
    }
    break;

  // -- Messages (named-flag interface) --------------------------
  case 'messages':
    switch (sub) {
      case 'send': {
        // Parse named flags from args: --from, --to, --kind, --body
        const mFlags = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
              mFlags[key] = args[i + 1];
              i++;
            } else {
              mFlags[key] = true;
            }
          }
        }
        const mFrom = mFlags.from;
        const mTo   = mFlags.to   || 'main';
        const mKind = mFlags.kind || 'status';
        const mBody = mFlags.body;
        const mChannel = mFlags.channel || null;
        const mDeliveryTo = mFlags['delivery-to'] || null;
        if (!mFrom || !mBody) {
          fail('Usage: messages send --from <label> [--to <agent>] [--kind <kind>] [--channel <channel>] [--delivery-to <target>] --body "<text>"');
        }
        const msg = sendMessage({
          from_agent: mFrom,
          to_agent: mTo,
          kind: mKind,
          body: mBody,
          channel: mChannel,
          delivery_to: mDeliveryTo,
        });
        emit({ ok: true, message: msg }, `Sent: ${fmt(msg)}`);
        break;
      }
      default: usage();
    }
    break;

  // -- Queue ------------------------------------------------
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

  // -- Agents ----------------------------------------------
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
      case 'get': {
        if (!args[0]) fail('Usage: agents get <id>', 1, 'INVALID_ARGUMENT');
        const agent = getAgent(args[0]);
        if (!agent) fail(`Agent not found: ${args[0]}`, 1, 'NOT_FOUND');
        emit(agent);
        break;
      }
      case 'register': {
        if (!args[0]) fail('Usage: agents register <agent-id> [name]');
        const a = upsertAgent(args[0], { name: args[1] || args[0] });
        emit({ ok: true, agent: a }, `Registered: ${fmt(a)}`);
        break;
      }
      default: usage();
    }
    break;

  // -- Tasks ------------------------------------------------
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
            id: g.id.slice(0, 8) + '..',
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
        if (!status) fail('Task group not found: ' + args[0], 1, 'NOT_FOUND');
        emit(status, () => {
          console.log(`\nTask Group: ${status.name}`);
          console.log(`Status:     ${status.status}`);
          console.log(`Elapsed:    ${status.elapsed}s / ${status.remaining_timeout + status.elapsed}s timeout`);
          console.log(`\nAgents:`);
          for (const a of status.agents) {
            const icon = a.status === 'completed' ? '[ok]' : a.status === 'failed' ? '[FAIL]' : a.status === 'dead' ? '[DEAD]' : a.status === 'running' ? '[..]' : '[ ]';
            const dur = a.duration != null ? ` (${a.duration}s)` : '';
            const detail = a.exit_message || a.error || '';
            console.log(`  ${icon} ${a.label}: ${a.status}${dur}${detail ? ' -- ' + detail : ''}`);
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
          id: g.id.slice(0, 8) + '..',
          name: g.name,
          status: g.status,
          completed: g.completed_at,
          created_by: g.created_by,
        }));
        emit(jsonMode ? groups : rows, () => console.table(rows));
        break;
      }

      // -- tasks heartbeat ----------------------------------
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

      // -- tasks register-session ----------------------------
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

  // -- Approvals ----------------------------------------------
  case 'approvals':
    switch (sub) {
      case 'list':
      case 'pending': {
        const { listPendingApprovals } = await import('./approval.js');
        const approvals = listPendingApprovals();
        if (approvals.length === 0) { emit([], 'No pending approvals'); break; }
        const rows = approvals.map(a => ({
          id: a.id,
          job: a.job_id,
          job_name: a.job_name || '-',
          run: a.run_id || '-',
          gate: a.gate_kind || 'job',
          status: a.status,
          requested: a.requested_at,
        }));
        emit(jsonMode ? approvals : rows, () => console.table(rows));
        break;
      }
      case 'approve':
      case 'reject': {
        const positionals = commandPositionals(args, { valueFlags: ['--reason'] });
        const approvalId = positionals[0];
        if (!approvalId) fail(`Usage: approvals ${sub} <approval-id> [--reason <text>]`);
        const reasonIdx = args.indexOf('--reason');
        const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : (positionals.slice(1).join(' ') || null);
        const { getApproval, resolveApproval } = await import('./approval.js');
        const approval = getApproval(approvalId);
        if (!approval) fail(`Approval not found: ${approvalId}`, 1, 'NOT_FOUND');
        if (approval.status !== 'pending') {
          fail(`Approval is already ${approval.status}: ${approvalId}`, 1, 'APPROVAL_CONFLICT');
        }
        const requestedStatus = sub === 'approve' ? 'approved' : 'rejected';
        const resolved = resolveApproval(approval.id, requestedStatus, null, reason);
        if (!resolved || resolved.status !== requestedStatus) {
          fail(`Approval could not be ${sub}d; current status is ${resolved?.status || 'unknown'}`, 1, 'APPROVAL_CONFLICT');
        }
        emit({
          ok: true,
          approval_id: resolved.id,
          job_id: resolved.job_id,
          run_id: resolved.run_id || null,
          gate_kind: resolved.gate_kind || 'job',
          status: resolved.status,
          resolved_by: resolved.resolved_by,
          reason,
        }, `${sub === 'approve' ? 'Approved' : 'Rejected'} approval: ${resolved.id}`);
        break;
      }
      default: usage();
    }
    break;

  // -- Idempotency ----------------------------------------
  case 'idem': {
    const { listIdempotencyForJob, getIdempotencyEntry, releaseIdempotencyKey, forcePruneIdempotency } = await import('./idempotency.js');
    switch (sub) {
      case 'status': {
        if (!args[0]) fail('Usage: idem status <job-id>');
        const entries = listIdempotencyForJob(args[0]);
        if (entries.length === 0) { emit([], 'No idempotency entries for this job'); break; }
        const rows = entries.map(e => ({
          key: e.key.slice(0, 12) + '..',
          run: (e.run_id?.slice(0, 8) || '-') + '..',
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
        if (!before) fail('Key not found in ledger', 1, 'NOT_FOUND');
        if (before.status === 'released') { emit({ ok: true, key: args[0], already_released: true }, 'Key already released'); break; }
        releaseIdempotencyKey(args[0]);
        emit({ ok: true, key: args[0], released: true }, `Released idempotency key: ${args[0].slice(0, 12)}..`);
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

  // -- Team Adapter ---------------------------------------
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
          gateTracker: t.gate_tracker_id ? t.gate_tracker_id.slice(0, 8) + '..' : '-',
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
        if (!msg) fail('Team message not found: ' + args[0], 1, 'NOT_FOUND');
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

  // -- Aliases ---------------------------------------------
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
        emit({ ok: true, alias: name, channel, target, description }, `Added alias: ${name} -> ${channel}/${target}`);
        break;
      }
      case 'remove': {
        if (!args[0]) fail('Usage: alias remove <name>');
        const result = db.prepare('DELETE FROM delivery_aliases WHERE alias = ?').run(args[0]);
        if (result.changes > 0) emit({ ok: true, alias: args[0], removed: true }, `Removed alias: ${args[0]}`);
        else fail(`Alias not found: ${args[0]}`, 1, 'NOT_FOUND');
        break;
      }
      default: usage();
    }
    break;
  }

  // -- Status ----------------------------------------------
  case 'status': {
    const db = getDb();
    const dbPath = getResolvedDbPath();
    const schemaVersion = getSchemaVersion(db);
    const operational = await getOperationalDiagnostics(db);
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
      db_path: dbPath,
      db_init_ok: true,
      schema_version: schemaVersion,
      latest_schema_version: SCHEDULER_SCHEMA_VERSION,
      product_schema: SCHEDULER_PRODUCT_SCHEMA_LABEL,
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
      diagnostics: operational,
    };
    emit(payload, () => {
      console.log('=== OpenClaw Scheduler Status ===');
      console.log(`DB:       ${dbPath}`);
      console.log(`Schema:   ${schemaVersion ?? 'unknown'} / ${SCHEDULER_SCHEMA_VERSION}`);
      console.log(`Jobs:     ${jobs.length} total, ${jobs.filter(j => j.enabled).length} enabled`);
      console.log(`Running:  ${runningRuns.length}`);
      console.log(`Stale:    ${stale.length}`);
      console.log(`Dispatch: ${budget.pending_dispatches} pending, ${budget.approval_blocked_dispatches} approval-blocked, ${budget.overlap_queued_dispatches} overlap-queued`);
      console.log(`Approvals:${budget.pending_approvals} pending`);
      console.log(`Output:   ${budget.shell_output_bytes} bytes stored/offloaded across runs (${budget.offloaded_shell_runs} offloaded runs)`);
      console.log(`Agents:   ${agents.length}`);
      const lease = operational.dispatcher_lease;
      console.log(`Lease:    ${lease ? `${lease.active ? 'active' : 'expired'} owner=${lease.owner_id} fence=${lease.fencing_token}` : 'not held'}`);
      console.log(`Queue:    ${fmt(operational.dispatch_queue.statuses)} (${operational.dispatch_queue.expired_claims ?? 0} expired claims)`);
      console.log(`Outbox:   ${fmt(operational.delivery_outbox.statuses)} (${operational.delivery_outbox.due ?? 0} due, ${operational.delivery_outbox.expired_claims ?? 0} expired claims)`);
      console.log(`Approval: ${fmt(operational.approvals.statuses)} (${operational.approvals.expired_pending ?? 0} expired pending)`);
      console.log(`Cancel:   ${operational.cancellation_pending_runs ?? 0} active runs with cancellation requested`);
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

  case 'doctor': {
    const db = getDb();
    const dbPath = getResolvedDbPath();
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    const requiredTables = [
      'jobs', 'runs', 'messages', 'approvals', 'job_dispatch_queue',
      'dispatcher_leases', 'delivery_outbox', 'delivery_attachments', 'evidence_records', 'schema_migrations',
    ];
    const missingTables = requiredTables.filter(name => !tableExists(db, name));
    const schemaVersion = getSchemaVersion(db);
    const dbParent = dbPath === ':memory:' ? null : dirname(dbPath);
    let dbParentWritable = dbPath === ':memory:';
    if (dbParent) {
      try {
        accessSync(dbParent, fsConstants.W_OK);
        dbParentWritable = true;
      } catch {
        dbParentWritable = false;
      }
    }
    const doctorArgs = [sub, ...args].filter(Boolean);
    const unknownDoctorArgs = doctorArgs.filter(arg => arg !== '--deep');
    if (unknownDoctorArgs.length > 0) fail(`Unknown doctor option: ${unknownDoctorArgs[0]}`, 1, 'INVALID_ARGUMENT');
    const diagnostics = await getOperationalDiagnostics(db, { deepEvidence: doctorArgs.includes('--deep') });
    const integrityRows = db.pragma('quick_check');
    const integrityMessages = integrityRows.map(row => String(Object.values(row)[0]));
    const integrityOk = integrityMessages.length === 1 && integrityMessages[0].toLowerCase() === 'ok';
    const foreignKeyViolations = db.pragma('foreign_key_check');
    const warnings = [];
    if (!diagnostics.dispatcher_lease?.active) warnings.push('No active scheduler-dispatcher lease; the dispatcher may be stopped.');
    if ((diagnostics.dispatch_queue.expired_claims || 0) > 0) warnings.push('Expired dispatch claims are awaiting recovery.');
    if ((diagnostics.delivery_outbox.expired_claims || 0) > 0) warnings.push('Expired delivery claims are awaiting recovery.');
    if ((diagnostics.approvals.expired_pending || 0) > 0) warnings.push('Expired pending approvals are awaiting resolution.');
    if ((diagnostics.cancellation_pending_runs || 0) > 0) warnings.push('Active runs have pending cancellation requests.');
    if ((diagnostics.recovery_blocked_runs || 0) > 0) warnings.push('One or more runs are recovery-blocked; affected jobs were disabled for operator review.');
    if ((diagnostics.credential_cleanup_failures || 0) > 0) warnings.push('Credential cleanup failures require operator remediation; affected jobs were disabled.');
    if ((diagnostics.evidence_records.invalid || 0) > 0) warnings.push('One or more evidence records failed checksum or execution-binding verification.');
    if ((diagnostics.evidence_records.missing || 0) > 0) warnings.push('One or more terminal runs are missing declared evidence records.');
    if (diagnostics.evidence_records.verification_complete === false) {
      warnings.push('Evidence verification was sampled; run doctor --deep to verify every evidence record.');
    }
    if (!integrityOk) warnings.push('SQLite quick_check reported database integrity errors.');
    if (foreignKeyViolations.length > 0) warnings.push('SQLite foreign-key violations require repair before safe operation.');
    const healthy = missingTables.length === 0
      && schemaVersion === SCHEDULER_SCHEMA_VERSION
      && dbParentWritable
      && integrityOk
      && foreignKeyViolations.length === 0
      && (diagnostics.recovery_blocked_runs || 0) === 0
      && (diagnostics.credential_cleanup_failures || 0) === 0
      && (diagnostics.evidence_records.invalid || 0) === 0
      && (diagnostics.evidence_records.missing || 0) === 0;
    const result = {
      ok: healthy,
      package: { name: pkg.name, version: pkg.version, node: process.version },
      paths: {
        scheduler_home: resolveSchedulerHome(process.env),
        db_path: dbPath,
        db_exists: dbPath === ':memory:' || existsSync(dbPath),
        db_parent: dbParent,
        db_parent_exists: dbParent === null || existsSync(dbParent),
        db_parent_writable: dbParentWritable,
        db_path_mismatch: getDbPathMismatchNotice(process.env),
      },
      database: {
        init_ok: true,
        schema_version: schemaVersion,
        latest_schema_version: SCHEDULER_SCHEMA_VERSION,
        product_schema: SCHEDULER_PRODUCT_SCHEMA_LABEL,
        required_tables: requiredTables,
        missing_tables: missingTables,
        integrity_check: integrityMessages,
        foreign_key_violations: foreignKeyViolations.length,
        foreign_key_violation_samples: foreignKeyViolations.slice(0, 20),
      },
      diagnostics,
      warnings,
    };
    emit(result, () => {
      console.log(`Scheduler doctor: ${healthy ? 'healthy' : 'unhealthy'}`);
      console.log(`Package: ${pkg.name} ${pkg.version} on ${process.version}`);
      console.log(`Database: ${dbPath}`);
      console.log(`Schema: ${schemaVersion ?? 'unknown'} / ${SCHEDULER_SCHEMA_VERSION}`);
      console.log(`Required tables: ${missingTables.length === 0 ? 'present' : `missing ${missingTables.join(', ')}`}`);
      console.log(`Integrity: ${integrityOk ? 'ok' : integrityMessages.join('; ')}`);
      console.log(`Foreign keys: ${foreignKeyViolations.length === 0 ? 'ok' : `${foreignKeyViolations.length} violation(s)`}`);
      for (const warning of warnings) console.log(`Warning: ${warning}`);
    });
    if (!healthy) process.exitCode = 1;
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

  // -- Capabilities ----------------------------------------
  case 'capabilities': {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    const capabilities = {
      scheduler_version: pkg.version,
      schema_version: SCHEDULER_SCHEMA_VERSION,
      latest_schema_version: SCHEDULER_SCHEMA_VERSION,
      product_schema: SCHEDULER_PRODUCT_SCHEMA_LABEL,
      schema_version_source: 'package',
      schema_version_note: 'Run status or doctor to inspect the initialized database schema.',
      handoff_version: '4',
      handoff_contract: HANDOFF_V4_RUNTIME_CONTRACT,
      features: {
        approvals: 'runtime',
        model_policy: 'model+thinking',
        execution_intent: 'runtime',
        output_hints: 'runtime',
        timeout_support: 'runtime',
        context_retrieval: 'runtime',
        runtime_execution: true,
        identity_declaration: true,
        runtime_identity_resolution: true,
        trust_evaluation: true,
        authorization_proof_verification: true,
        authorization_hook: true,
        evidence_generation: true,
        checksum_evidence_generation: true,
        evidence_integrity: 'artifact-bound-signed-or-provider-verified-v4',
        evidence_contract: 'agentcli-handoff-v4',
        authorization_ref_resolution: true,
        delegation_validation: true,
        root_approval_gate: true,
        // AgentCLI handoff v3 negotiates scopes through one coarse boolean and can
        // emit domain: scopes. This local runtime cannot authenticate domains,
        // so advertise false and reject every scoped manifest during capability
        // negotiation rather than accepting it and failing late.
        approval_scope_enforcement: false,
        structured_output_format: true,
        credential_handoff: true,
        gateway_capability_discovery: true,
        gateway_env_injection_negotiation: true,
        audit_export: true,
        dispatcher_fencing: true,
        process_tree_cancellation: true,
        leased_dispatch_recovery: true,
        transactional_delivery_outbox: true,
        multipart_delivery_checkpoints: true,
        completion_delivery_scope: 'run',
        durable_delivery_attachments: true,
        atomic_approval_state: true,
        governance_enforcement: true,
        handoff_v4_artifact: true,
        artifact_bound_proofs: true,
        signed_or_provider_verified_evidence: true,
        provider_session_cache: true,
        credential_presentation: true,
        source_run_bound_delegation: true,
        immutable_runtime_events: true,
      },
    };
    emit(capabilities);
    break;
  }

  default:
    if (command) {
      fail(`Unknown command: ${command}. Run without arguments for usage.`);
    }
    usage();
    process.exit(0);
}
}

main().catch(err => {
  const errorCode = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code)
    ? err.code
    : 'COMMAND_FAILED';
  const details = {
    ...(err?.phase ? { phase: err.phase } : {}),
    ...(err?.dbPath ? { db_path: err.dbPath } : {}),
  };
  fail(err?.message || String(err), 1, errorCode, Object.keys(details).length ? details : null);
});
