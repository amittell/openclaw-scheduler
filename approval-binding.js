import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

const DYNAMIC_JOB_FIELDS = new Set([
  'created_at',
  'updated_at',
  'next_run_at',
  'last_run_at',
  'last_status',
  'consecutive_errors',
  'queued_count',
  'watchdog_started_at',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new Error('approval binding requires a job record');
  }
  const persisted = {};
  for (const key of Object.keys(job).sort()) {
    if (DYNAMIC_JOB_FIELDS.has(key)) continue;
    persisted[key] = job[key];
  }
  return canonicalize(persisted);
}

export function approvalBindingPayload(job, opts = {}) {
  const lineage = Array.isArray(opts.lineage) ? opts.lineage : [];
  return canonicalize({
    version: 2,
    job: stableJob(job),
    parent_lineage: lineage.map(stableJob),
  });
}

export function approvalBindingHash(job, opts = {}) {
  const canonical = JSON.stringify(approvalBindingPayload(job, opts));
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function loadApprovalBindingLineage(db, job) {
  if (!db || typeof db.prepare !== 'function') throw new Error('approval binding requires a database');
  const lineage = [];
  const seen = new Set([job.id]);
  let parentId = job.parent_id || null;
  while (parentId) {
    if (seen.has(parentId)) throw new Error('approval binding parent lineage contains a cycle');
    seen.add(parentId);
    const parent = db.prepare('SELECT * FROM jobs WHERE id = ?').get(parentId);
    if (!parent) throw new Error(`approval binding parent job is missing: ${parentId}`);
    lineage.push(parent);
    parentId = parent.parent_id || null;
    if (lineage.length > 64) throw new Error('approval binding parent lineage exceeds 64 jobs');
  }
  return lineage;
}

export function approvalBindingHashForDb(db, job) {
  return approvalBindingHash(job, { lineage: loadApprovalBindingLineage(db, job) });
}

export function getAuthenticatedApprovalActor() {
  const account = userInfo();
  const username = account.username;
  const uid = typeof process.getuid === 'function' ? process.getuid() : account.uid;
  const canonical = Number.isInteger(uid) ? `local-user:${uid}` : `local-user:${username}`;
  return Object.freeze({
    authenticated: true,
    source: 'os-user',
    canonical,
    username,
    uid: Number.isInteger(uid) ? uid : null,
    aliases: Object.freeze([
      canonical,
      username,
      `user:${username}`,
      `principal:${username}`,
      ...(Number.isInteger(uid) ? [`uid:${uid}`, `principal:local-user:${uid}`] : []),
    ]),
  });
}

export function approverMatchesScope(approver, scope) {
  if (!scope) return true;
  const aliases = approver && typeof approver === 'object' && Array.isArray(approver.aliases)
    ? new Set(approver.aliases)
    : typeof approver === 'string' && approver.trim()
      ? new Set([approver.trim()])
      : new Set();
  if (aliases.size === 0) return false;
  const separator = scope.indexOf(':');
  const kind = separator === -1 ? 'exact' : scope.slice(0, separator);
  const expected = separator === -1 ? scope : scope.slice(separator + 1);
  if (!expected) return false;
  if (kind === 'principal' || kind === 'user' || kind === 'exact') {
    return aliases.has(expected) || aliases.has(`${kind}:${expected}`);
  }
  return aliases.has(scope);
}

export function assertApprovalBinding(job, expectedHash, opts = {}) {
  if (!expectedHash) return approvalBindingHash(job, opts);
  const actualHash = approvalBindingHash(job, opts);
  if (actualHash !== expectedHash) {
    const error = new Error('Job execution contract changed after approval was requested');
    error.code = 'APPROVAL_BINDING_MISMATCH';
    error.expectedHash = expectedHash;
    error.actualHash = actualHash;
    throw error;
  }
  return actualHash;
}
