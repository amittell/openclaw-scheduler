#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const documents = [
  'README.md',
  'QUICK-START.md',
  'JOB-QUICK-REF.md',
  'BEST-PRACTICES.md',
  'INSTALL.md',
  'INSTALL-LINUX.md',
  'INSTALL-WINDOWS.md',
  'INSTALL-ADDITIONAL-HOST.md',
  'UPGRADING.md',
  'UNINSTALL.md',
  'SECURITY.md',
  'CONTEXT.md',
  'IMPLEMENTATION_SPEC.md',
  'AGENTS.md',
  'docs/adr-schedule-ownership.md',
  'docs/gateway-contract.md',
  'docs/trust-architecture.md',
  'skills/durable-scheduler/SKILL.md',
];

const forbiddenCommands = [
  [/\bopenclaw-scheduler\s+init\b/g, 'Use setup, not the nonexistent init command.'],
  [/\bopenclaw-scheduler\s+workflows\b/g, 'Workflow chains are authored with jobs add or @amittell/agentcli.'],
  [/\bopenclaw-scheduler\s+jobs\s+runs\b/g, 'Run history is under runs list.'],
  [/\bopenclaw-scheduler\s+jobs\s+(?:pause|unpause)\b/g, 'Use jobs disable or jobs enable.'],
  [/\bnpm\s+install\s+-g\s+agentcli\b/g, 'Use the published package name @amittell/agentcli.'],
];

const knownTopLevel = new Set([
  'setup', 'start', 'dispatcher', 'migrate', 'status', 'doctor', 'webhook-check',
  'help', 'version', 'jobs', 'runs', 'queue', 'messages', 'msg', 'team', 'agents',
  'tasks', 'approvals', 'idem', 'alias', 'schema', 'capabilities', 'dispatch',
  'enqueue', 'stuck', 'result', 'sync', 'done', 'send', 'steer', 'heartbeat', 'list',
]);

const knownSubcommands = new Map([
  ['jobs', new Set(['list', 'tree', 'get', 'add', 'validate', 'enable', 'disable', 'delete', 'cancel', 'update', 'run', 'approve', 'reject'])],
  ['runs', new Set(['list', 'get', 'output', 'evidence', 'running', 'stale'])],
  ['queue', new Set(['list', 'clear', 'prune'])],
  ['messages', new Set(['send'])],
  ['msg', new Set(['send', 'inbox', 'team-inbox', 'outbox', 'thread', 'ack', 'receipts', 'read', 'readall', 'unread'])],
  ['agents', new Set(['list', 'get', 'register'])],
  ['tasks', new Set(['list', 'status', 'create', 'history', 'heartbeat', 'register-session'])],
  ['approvals', new Set(['list', 'pending', 'approve', 'reject'])],
  ['idem', new Set(['status', 'check', 'release', 'prune'])],
  ['alias', new Set(['list', 'add', 'remove'])],
]);

// Keep this packaging check dependency-free so it can run against an unpacked
// tarball before npm installs production dependencies. A focused test runs the
// same examples through validateJobSpec during the normal test suite.
const documentedPayloadsByTarget = new Map([
  ['isolated', new Set(['systemEvent', 'agentTurn'])],
  ['main', new Set(['systemEvent'])],
  ['shell', new Set(['shellCommand'])],
]);
const documentedExecutionIntents = new Set(['execute', 'plan', 'fire-and-forget']);

const errors = [];
let jsonBlocks = 0;
let commandExamples = 0;

function error(file, message) {
  errors.push(`${file}: ${message}`);
}

function validateJobExample(file, value) {
  if (Array.isArray(value)) {
    for (const entry of value) validateJobExample(file, entry);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (!('name' in value) || !('payload_message' in value)) return;
  if (!Number.isInteger(value.run_timeout_ms) || value.run_timeout_ms <= 0) {
    error(file, 'job JSON example must include a positive integer run_timeout_ms');
  }

  const target = value.session_target || 'isolated';
  const payloadKind = value.payload_kind || 'agentTurn';
  const allowedPayloads = documentedPayloadsByTarget.get(target);
  if (!allowedPayloads) {
    error(file, `job JSON example "${value.name}" has unknown session_target "${target}"`);
  } else if (!allowedPayloads.has(payloadKind)) {
    error(file, `job JSON example "${value.name}" cannot use payload_kind "${payloadKind}" with session_target "${target}"`);
  }

  const executionIntent = value.execution_intent || 'execute';
  if (!documentedExecutionIntents.has(executionIntent)) {
    error(file, `job JSON example "${value.name}" has invalid execution_intent "${executionIntent}"`);
  }
  if (executionIntent === 'fire-and-forget') {
    if (target !== 'main') {
      error(file, `job JSON example "${value.name}" uses fire-and-forget outside the main session`);
    }
    if (value.output_format != null || value.verify_shell != null || value.evidence != null) {
      error(file, `job JSON example "${value.name}" requests synchronous output controls for fire-and-forget work`);
    }
  }

  if (value.parent_id == null && value.schedule_cron == null && value.schedule_kind !== 'at') {
    error(file, `root job JSON example "${value.name}" must include schedule_cron or an at schedule`);
  }
}

function tokenizeCommand(line) {
  let normalized = line.trim().replace(/^\$\s*/, '');
  if (normalized.startsWith('env ')) normalized = normalized.slice(4).trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(normalized)) {
    normalized = normalized.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '');
  }
  if (!normalized.startsWith('openclaw-scheduler ') && normalized !== 'openclaw-scheduler') return null;
  const tokens = normalized.slice('openclaw-scheduler'.length).trim().split(/\s+/).filter(Boolean);
  while (tokens[0] === '--json') tokens.shift();
  return tokens;
}

for (const file of documents) {
  const text = readFileSync(resolve(root, file), 'utf8');
  for (const [pattern, message] of forbiddenCommands) {
    if (pattern.test(text)) error(file, message);
    pattern.lastIndex = 0;
  }

  const fencePattern = /```([^\n]*)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fencePattern)) {
    const info = match[1].trim().toLowerCase();
    const language = info.split(/\s+/)[0];
    const body = match[2];
    if (language === 'json') {
      try {
        const parsed = JSON.parse(body);
        jsonBlocks++;
        validateJobExample(file, parsed);
      } catch (err) {
        if (info.split(/\s+/).includes('strict')) error(file, `invalid strict JSON fence: ${err.message}`);
      }
    }
    if (!['bash', 'sh', 'shell', 'zsh', 'console', ''].includes(language)) continue;
    for (const line of body.split('\n')) {
      const tokens = tokenizeCommand(line);
      if (!tokens || tokens.length === 0 || tokens[0].startsWith('$')) continue;
      commandExamples++;
      const top = tokens[0].replace(/[;|]$/, '');
      if (!knownTopLevel.has(top)) {
        error(file, `unknown openclaw-scheduler command in example: ${top}`);
        continue;
      }
      const allowedSubs = knownSubcommands.get(top);
      if (allowedSubs && tokens[1] && !tokens[1].startsWith('-') && !tokens[1].startsWith('<')) {
        const sub = tokens[1].replace(/[;|]$/, '');
        if (!allowedSubs.has(sub)) error(file, `unknown ${top} subcommand in example: ${sub}`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.length} documentation validation error(s):\n`);
  for (const item of errors) process.stderr.write(`  - ${item}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${documents.length} documents, ${jsonBlocks} JSON fences, and ${commandExamples} scheduler command examples.\n`);
}
