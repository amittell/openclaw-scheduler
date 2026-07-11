#!/usr/bin/env node
// Import OpenClaw cron jobs into the durable scheduler.
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { createJob, listJobs, validateJobSpec } from './jobs.js';

const DEFAULT_LEGACY_JSON = process.env.OPENCLAW_JOBS_JSON
  || join(process.env.HOME || homedir(), '.openclaw', 'cron', 'jobs.json');

function migrationError(message, code = 'MIGRATION_ERROR') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sqliteUtc(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw migrationError(`Invalid ${label}: ${String(value)}`, 'INVALID_SCHEDULE');
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function anchorForSchedule(schedule) {
  const raw = schedule.anchorMs ?? schedule.anchor ?? 0;
  const anchor = typeof raw === 'number' ? new Date(raw) : new Date(raw);
  if (Number.isNaN(anchor.getTime())) {
    throw migrationError(`Invalid every schedule anchor: ${String(raw)}`, 'INVALID_SCHEDULE');
  }
  return anchor;
}

function cronMinuteField(step, offset) {
  if (step === 1) return '*';
  const minutes = [];
  for (let minute = offset; minute < 60; minute += step) minutes.push(minute);
  return minutes.join(',');
}

function cronHourField(step, offset) {
  if (step === 1) return '*';
  const hours = [];
  for (let hour = offset; hour < 24; hour += step) hours.push(hour);
  return hours.join(',');
}

function exactEveryCron(schedule) {
  const everyMs = Number(schedule.everyMs ?? schedule.every_ms);
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) {
    throw migrationError('every schedule requires a positive integer everyMs', 'INVALID_SCHEDULE');
  }
  if (everyMs % 60_000 !== 0) return null;

  const everyMinutes = everyMs / 60_000;
  const anchor = anchorForSchedule(schedule);
  if (anchor.getUTCSeconds() !== 0 || anchor.getUTCMilliseconds() !== 0) return null;

  if (everyMinutes <= 60 && 60 % everyMinutes === 0) {
    const offset = anchor.getUTCMinutes() % everyMinutes;
    return `${cronMinuteField(everyMinutes, offset)} * * * *`;
  }

  if (everyMinutes % 60 === 0) {
    const everyHours = everyMinutes / 60;
    if (everyHours <= 24 && 24 % everyHours === 0) {
      const hourOffset = anchor.getUTCHours() % everyHours;
      return `${anchor.getUTCMinutes()} ${cronHourField(everyHours, hourOffset)} * * *`;
    }
  }

  return null;
}

function approximateEveryCron(schedule) {
  const everyMs = Number(schedule.everyMs ?? schedule.every_ms);
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw migrationError('every schedule requires a positive everyMs', 'INVALID_SCHEDULE');
  }
  const roundedMinutes = Math.max(1, Math.round(everyMs / 60_000));
  if (roundedMinutes < 60) return `*/${roundedMinutes} * * * *`;
  const roundedHours = Math.min(23, Math.max(1, Math.round(roundedMinutes / 60)));
  return `0 */${roundedHours} * * *`;
}

export function cronFromSchedule(schedule, { allowInexactEvery = false } = {}) {
  if (!schedule || typeof schedule !== 'object') {
    throw migrationError('Job has no schedule object', 'INVALID_SCHEDULE');
  }
  if (schedule.kind === 'cron') {
    const expr = schedule.expr ?? schedule.cron;
    if (typeof expr !== 'string' || !expr.trim()) {
      throw migrationError('cron schedule requires a non-empty expr', 'INVALID_SCHEDULE');
    }
    return {
      fields: {
        schedule_kind: 'cron',
        schedule_cron: expr,
        schedule_tz: schedule.tz || schedule.timezone || 'UTC',
      },
      warnings: [],
      exact: true,
    };
  }
  if (schedule.kind === 'at') {
    const at = schedule.at ?? schedule.atMs ?? schedule.at_ms;
    return {
      fields: {
        schedule_kind: 'at',
        schedule_at: sqliteUtc(at, 'at schedule'),
        schedule_tz: 'UTC',
        delete_after_run: 1,
      },
      warnings: [],
      exact: true,
    };
  }
  if (schedule.kind === 'every') {
    const exactCron = exactEveryCron(schedule);
    if (exactCron) {
      return {
        fields: { schedule_kind: 'cron', schedule_cron: exactCron, schedule_tz: 'UTC' },
        warnings: [],
        exact: true,
      };
    }
    if (!allowInexactEvery) {
      throw migrationError(
        'every schedule cannot be represented exactly as five-field cron; rerun with --allow-inexact-every to accept an approximation',
        'INEXACT_EVERY',
      );
    }
    const cron = approximateEveryCron(schedule);
    return {
      fields: { schedule_kind: 'cron', schedule_cron: cron, schedule_tz: 'UTC' },
      warnings: [`Approximated everyMs=${schedule.everyMs ?? schedule.every_ms} as cron "${cron}".`],
      exact: false,
    };
  }
  throw migrationError(`Unknown schedule kind: ${String(schedule.kind)}`, 'INVALID_SCHEDULE');
}

function shellQuote(value) {
  const string = String(value);
  return `'${string.replaceAll("'", `'"'"'`)}'`;
}

function normalizeCommandEnvironment(env) {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env.map(entry => {
      const index = String(entry).indexOf('=');
      if (index <= 0) throw migrationError(`Invalid command environment entry: ${entry}`, 'UNSUPPORTED_PAYLOAD');
      return [String(entry).slice(0, index), String(entry).slice(index + 1)];
    });
  }
  if (typeof env === 'object') return Object.entries(env);
  throw migrationError('Command environment must be an object or KEY=VALUE array', 'UNSUPPORTED_PAYLOAD');
}

function commandFromPayload(payload) {
  let command;
  if (typeof payload.command === 'string' && payload.command.trim()) {
    command = payload.command;
  } else if (Array.isArray(payload.argv) && payload.argv.length > 0) {
    const argv = payload.argv.map(String);
    if (argv.length === 3 && ['sh', 'bash', 'zsh'].includes(argv[0]) && argv[1] === '-lc') {
      command = argv[2];
    } else {
      command = argv.map(shellQuote).join(' ');
    }
  } else {
    throw migrationError('Command payload requires command or a non-empty argv array', 'UNSUPPORTED_PAYLOAD');
  }

  const env = normalizeCommandEnvironment(payload.env ?? payload.environment);
  if (env.length > 0) {
    const assignments = env.map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw migrationError(`Invalid command environment name: ${key}`, 'UNSUPPORTED_PAYLOAD');
      }
      return `${key}=${shellQuote(value)}`;
    });
    command = `env ${assignments.join(' ')} ${command}`;
  }
  if (payload.cwd) command = `cd ${shellQuote(payload.cwd)} && ${command}`;
  const input = payload.stdin ?? payload.input;
  if (input != null && String(input).length > 0) {
    command = `printf %s ${shellQuote(input)} | ${command}`;
  }
  return command;
}

function normalizeDelivery(job, sessionTarget, payloadKind) {
  const delivery = job.delivery && typeof job.delivery === 'object' ? job.delivery : {};
  const mode = delivery.mode ?? job.deliveryMode ?? (sessionTarget === 'main' ? 'none' : 'announce');
  if (mode === 'webhook') {
    throw migrationError('Webhook delivery cannot be represented by the scheduler delivery contract', 'UNSUPPORTED_DELIVERY');
  }
  if (!['announce', 'announce-always', 'none'].includes(mode)) {
    throw migrationError(`Unsupported delivery mode: ${String(mode)}`, 'UNSUPPORTED_DELIVERY');
  }
  const warnings = [];
  const target = delivery.to ?? delivery.target ?? job.deliveryTo ?? null;
  const channel = delivery.channel ?? job.deliveryChannel ?? null;
  let schedulerMode = mode;
  let optOutReason = null;
  if (schedulerMode !== 'none' && !target) {
    schedulerMode = 'none';
    optOutReason = 'migrated: OpenClaw announce route had no concrete target';
    warnings.push('Delivery was changed to none because the source job had no concrete target.');
  } else if (schedulerMode === 'none' && payloadKind === 'agentTurn') {
    optOutReason = 'migrated: source OpenClaw job disabled fallback delivery';
  }
  return {
    fields: {
      delivery_mode: schedulerMode,
      delivery_channel: schedulerMode === 'none' ? null : channel,
      delivery_to: schedulerMode === 'none' ? null : target,
      ...(optOutReason ? { delivery_opt_out_reason: optOutReason } : {}),
    },
    warnings,
  };
}

export function normalizeOpenClawJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw migrationError('OpenClaw cron get returned a non-object job', 'INVALID_SOURCE');
  }
  const job = value.job && typeof value.job === 'object' ? value.job : value;
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw migrationError('OpenClaw cron get returned an invalid job wrapper', 'INVALID_SOURCE');
  }
  return job;
}

export function convertOpenClawJob(source, { allowInexactEvery = false } = {}) {
  const job = normalizeOpenClawJob(source);
  const id = job.id ?? job.jobId;
  if (typeof id !== 'string' || !id.trim()) throw migrationError('Source job has no stable id', 'INVALID_SOURCE');
  if (typeof job.name !== 'string' || !job.name.trim()) throw migrationError(`Source job ${id} has no name`, 'INVALID_SOURCE');

  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const sourcePayloadKind = payload.kind ?? job.payloadKind;
  const isCommand = sourcePayloadKind === 'command'
    || sourcePayloadKind === 'shellCommand'
    || payload.command != null
    || Array.isArray(payload.argv);
  let sessionTarget;
  let payloadKind;
  let payloadMessage;
  const warnings = [];
  if (isCommand) {
    sessionTarget = 'shell';
    payloadKind = 'shellCommand';
    payloadMessage = commandFromPayload(payload);
  } else {
    const sourceSession = job.sessionTarget ?? job.session_target ?? job.session ?? 'isolated';
    if (sourceSession === 'isolated') sessionTarget = 'isolated';
    else if (sourceSession === 'main') sessionTarget = 'main';
    else if (typeof sourceSession === 'string' && sourceSession.startsWith('session:')) {
      sessionTarget = 'main';
      warnings.push(`Pinned session ${sourceSession} was retained as preferred_session_key.`);
    } else if (sourceSession === 'current') {
      sessionTarget = 'main';
      warnings.push('Session target current was mapped to main because migration has no active creation session.');
    } else {
      throw migrationError(`Unsupported session target: ${String(sourceSession)}`, 'UNSUPPORTED_SESSION');
    }
    payloadKind = sourcePayloadKind === 'systemEvent' || sessionTarget === 'main' ? 'systemEvent' : 'agentTurn';
    payloadMessage = payload.message ?? payload.text ?? job.message;
    if (typeof payloadMessage !== 'string' || !payloadMessage.trim()) {
      throw migrationError(`Source job ${id} has no agent/system payload message`, 'UNSUPPORTED_PAYLOAD');
    }
  }

  const schedule = cronFromSchedule(job.schedule, { allowInexactEvery });
  if (schedule.fields.schedule_kind === 'at') {
    const sourceDeleteAfterRun = job.deleteAfterRun ?? job.delete_after_run;
    if (sourceDeleteAfterRun !== undefined) {
      schedule.fields.delete_after_run = sourceDeleteAfterRun ? 1 : 0;
    }
  }
  warnings.push(...schedule.warnings);
  const delivery = normalizeDelivery(job, sessionTarget, payloadKind);
  warnings.push(...delivery.warnings);
  const payloadTimeoutSeconds = Number(payload.timeoutSeconds ?? payload.timeout_seconds ?? 120);
  const runTimeoutMs = Number(job.runTimeoutMs ?? job.run_timeout_ms
    ?? (Number.isFinite(payloadTimeoutSeconds) ? payloadTimeoutSeconds * 1000 : 300_000));
  if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0) {
    throw migrationError(`Source job ${id} has an invalid timeout`, 'INVALID_SOURCE');
  }

  const sourceSession = job.sessionTarget ?? job.session_target ?? job.session;
  const spec = {
    id,
    name: job.name,
    enabled: job.enabled !== false,
    ...schedule.fields,
    session_target: sessionTarget,
    agent_id: job.agentId ?? job.agent_id ?? job.agent ?? 'main',
    payload_kind: payloadKind,
    payload_message: payloadMessage,
    payload_model: payload.model ?? null,
    payload_thinking: payload.thinking ?? null,
    payload_timeout_seconds: Number.isSafeInteger(payloadTimeoutSeconds) && payloadTimeoutSeconds > 0
      ? payloadTimeoutSeconds
      : 120,
    shell_env_policy: 'inherit',
    overlap_policy: 'skip',
    run_timeout_ms: runTimeoutMs,
    ...delivery.fields,
    origin: job.origin || `openclaw-cron:${id}`,
    ...(typeof sourceSession === 'string' && sourceSession.startsWith('session:')
      ? { preferred_session_key: sourceSession.slice('session:'.length) }
      : {}),
  };
  return { spec, warnings, exact_schedule: schedule.exact };
}

export function extractListedJobIds(value) {
  const rows = Array.isArray(value) ? value : value?.jobs;
  if (!Array.isArray(rows)) {
    throw migrationError('openclaw cron list --json must return an array or { jobs: [] }', 'INVALID_SOURCE');
  }
  const ids = rows.map(row => typeof row === 'string' ? row : row?.id ?? row?.jobId);
  if (ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw migrationError('openclaw cron list --json returned a job without an id', 'INVALID_SOURCE');
  }
  return [...new Set(ids)];
}

export function runOpenClawJson(binary, args, { spawn = spawnSync } = {}) {
  const result = spawn(binary, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw migrationError(`Unable to run ${binary}: ${result.error.message}`, 'OPENCLAW_COMMAND_FAILED');
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw migrationError(
      `${binary} ${args.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`,
      'OPENCLAW_COMMAND_FAILED',
    );
  }
  try {
    return JSON.parse(String(result.stdout || '').trim());
  } catch (err) {
    throw migrationError(`${binary} ${args.join(' ')} returned invalid JSON: ${err.message}`, 'INVALID_SOURCE');
  }
}

export function loadCurrentOpenClawJobs(binary, opts = {}) {
  const listed = runOpenClawJson(binary, ['cron', 'list', '--json'], opts);
  const ids = extractListedJobIds(listed);
  const jobs = [];
  const results = [];
  for (const id of ids) {
    try {
      const fetched = runOpenClawJson(binary, ['cron', 'get', id, '--json'], opts);
      jobs.push(normalizeOpenClawJob(fetched));
    } catch (err) {
      results.push({ id, name: null, status: 'error', code: err.code || 'OPENCLAW_COMMAND_FAILED', error: err.message, warnings: [] });
    }
  }
  return { jobs, results };
}

export function loadLegacyJobs(path) {
  if (!existsSync(path)) throw migrationError(`Legacy jobs JSON not found: ${path}`, 'SOURCE_NOT_FOUND');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw migrationError(`Failed to parse ${path}: ${err.message}`, 'INVALID_SOURCE');
  }
  const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
  if (!Array.isArray(jobs)) throw migrationError(`${path} must contain an array or { jobs: [] }`, 'INVALID_SOURCE');
  return jobs.map(normalizeOpenClawJob);
}

export function parseMigrationArgs(argv) {
  const options = {
    allowInexactEvery: false,
    dryRun: false,
    json: false,
    legacyJson: null,
    openclawBin: process.env.OPENCLAW_BIN || 'openclaw',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-inexact-every') options.allowInexactEvery = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--legacy-json') {
      const next = argv[i + 1];
      options.legacyJson = next && !next.startsWith('--') ? resolve(next) : DEFAULT_LEGACY_JSON;
      if (next && !next.startsWith('--')) i++;
    } else if (arg.startsWith('--legacy-json=')) {
      options.legacyJson = resolve(arg.slice('--legacy-json='.length));
    } else if (arg === '--openclaw-bin') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw migrationError('--openclaw-bin requires a path or executable name', 'INVALID_ARGUMENT');
      options.openclawBin = next;
    } else if (arg.startsWith('--openclaw-bin=')) {
      options.openclawBin = arg.slice('--openclaw-bin='.length);
    } else {
      throw migrationError(`Unknown migrate option: ${arg}`, 'INVALID_ARGUMENT');
    }
  }
  return options;
}

function printMigrationUsage() {
  process.stdout.write(`Usage: openclaw-scheduler migrate [options]\n\nOptions:\n  --dry-run                 Validate and report without creating jobs\n  --json                    Emit one machine-readable report\n  --openclaw-bin <path>     OpenClaw executable (default: openclaw)\n  --legacy-json [path]      Explicitly import a pre-SQLite jobs.json export\n  --allow-inexact-every     Opt in to approximating intervals cron cannot express\n  --help                    Show this help\n`);
}

export async function migrateJobs(jobs, {
  allowInexactEvery = false,
  dryRun = false,
  initialResults = [],
} = {}) {
  const existingIds = new Set();
  if (!dryRun) {
    await initDb();
    for (const job of listJobs()) existingIds.add(job.id);
  }
  const results = [...initialResults];

  for (const source of jobs) {
    const sourceId = source?.id ?? source?.jobId ?? null;
    const sourceName = source?.name ?? null;
    if (sourceId && existingIds.has(sourceId)) {
      results.push({ id: sourceId, name: sourceName, status: 'skipped', reason: 'already_exists', warnings: [] });
      continue;
    }
    try {
      const converted = convertOpenClawJob(source, { allowInexactEvery });
      validateJobSpec(converted.spec, null, 'create');
      if (dryRun) {
        results.push({
          id: converted.spec.id,
          name: converted.spec.name,
          status: 'would_import',
          exact_schedule: converted.exact_schedule,
          warnings: converted.warnings,
        });
      } else {
        const job = createJob(converted.spec);
        existingIds.add(job.id);
        results.push({
          id: job.id,
          name: job.name,
          status: 'imported',
          exact_schedule: converted.exact_schedule,
          warnings: converted.warnings,
        });
      }
    } catch (err) {
      results.push({
        id: sourceId,
        name: sourceName,
        status: 'error',
        code: err.code || 'MIGRATION_ERROR',
        error: err.message,
        warnings: [],
      });
    }
  }
  return results;
}

function summarizeResults(results) {
  const count = status => results.filter(result => result.status === status).length;
  return {
    total: results.length,
    imported: count('imported'),
    would_import: count('would_import'),
    skipped: count('skipped'),
    failed: count('error'),
    warnings: results.reduce((sum, result) => sum + (result.warnings?.length || 0), 0),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseMigrationArgs(argv);
  if (options.help) {
    printMigrationUsage();
    return 0;
  }

  const source = options.legacyJson
    ? { kind: 'legacy-json', location: options.legacyJson }
    : { kind: 'openclaw-cli', location: options.openclawBin };
  let jobs;
  let initialResults = [];
  if (options.legacyJson) {
    jobs = loadLegacyJobs(options.legacyJson);
  } else {
    const loaded = loadCurrentOpenClawJobs(options.openclawBin);
    jobs = loaded.jobs;
    initialResults = loaded.results;
  }
  const results = await migrateJobs(jobs, {
    allowInexactEvery: options.allowInexactEvery,
    dryRun: options.dryRun,
    initialResults,
  });
  const summary = summarizeResults(results);
  const report = {
    ok: summary.failed === 0,
    source,
    dry_run: options.dryRun,
    allow_inexact_every: options.allowInexactEvery,
    summary,
    results,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Migration source: ${source.kind} (${source.location})\n`);
    for (const result of results) {
      const label = result.name || result.id || 'unknown job';
      if (result.status === 'error') process.stdout.write(`ERROR ${label}: ${result.error}\n`);
      else process.stdout.write(`${result.status.toUpperCase()} ${label}\n`);
      for (const warning of result.warnings || []) process.stdout.write(`  Warning: ${warning}\n`);
    }
    process.stdout.write(`Summary: ${JSON.stringify(summary)}\n`);
  }
  return report.ok ? 0 : 1;
}

const isEntrypoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().then(code => {
    process.exitCode = code;
  }).catch(err => {
    const jsonMode = process.argv.includes('--json');
    const report = { ok: false, error: err.message, code: err.code || 'MIGRATION_ERROR' };
    if (jsonMode) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
