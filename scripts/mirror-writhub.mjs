#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result;
}

function parseRefs(output) {
  return new Map(output.trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/))
    .map(([oid, ref]) => [ref, oid]));
}

// Push events synchronize only their named ref's current source tip. This also
// prevents a queued older event from rewinding a branch. Deletions are retained.
// Manual full sync attempts every current source ref, preserves conflicts and
// destination-only refs, and returns failure AFTER reporting all results.
export function mirrorRefs({ cwd, source = 'origin', target = 'writhub', eventName, eventRef, deleted = false, fullSync = false }) {
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported mirror event');
  if (fullSync && eventName !== 'workflow_dispatch') throw new Error('Full sync requires workflow_dispatch');
  if (!fullSync && (!/^refs\/(heads|tags)\//.test(eventRef || '')
    || git(cwd, ['check-ref-format', eventRef], true).status !== 0)) {
    throw new Error('Expected a valid branch or tag event ref');
  }
  if (!fullSync && deleted) return { ok: true, mode: 'event-ref', refs: [{ ref: eventRef, status: 'preserved-deletion' }] };

  const sourcePrefix = 'refs/mirror-source/';
  const refspecs = fullSync
    ? ['heads', 'tags'].map(kind => `+refs/${kind}/*:${sourcePrefix}${kind}/*`)
    : [`+${eventRef}:${sourcePrefix}${eventRef.slice(5)}`];
  git(cwd, ['fetch', '--no-tags', '--prune', source, ...refspecs]);
  const sourceRefs = parseRefs(git(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', sourcePrefix]).stdout);
  const targetRefs = parseRefs(git(cwd, ['ls-remote', '--refs', target, 'refs/heads/*', 'refs/tags/*']).stdout);
  const results = [];
  for (const [localRef, oid] of sourceRefs) {
    const ref = `refs/${localRef.slice(sourcePrefix.length)}`;
    if (!fullSync && ref !== eventRef) continue;
    let targetOid = targetRefs.get(ref);
    if (targetOid === oid) {
      results.push({ ref, status: 'unchanged', oid });
      continue;
    }
    if (targetOid && ref.startsWith('refs/tags/')) {
      // Compare the tag object, not its peeled commit: annotations are history.
      results.push({ ref, status: 'conflict', reason: 'tag-object-differs', sourceOid: oid, targetOid });
      continue;
    }
    if (targetOid) {
      const localTarget = `refs/mirror-target/${ref.slice(5)}`;
      git(cwd, ['fetch', '--no-tags', target, `+${ref}:${localTarget}`]);
      targetOid = git(cwd, ['rev-parse', localTarget]).stdout.trim();
      const ancestry = git(cwd, ['merge-base', '--is-ancestor', targetOid, oid], true);
      if (ancestry.status !== 0) {
        if (ancestry.status !== 1) throw new Error(`Unable to compare ancestry of ${ref}`);
        results.push({ ref, status: 'conflict', reason: 'not-fast-forward', sourceOid: oid, targetOid });
        continue;
      }
    }
    // No force, deletion, mirror flag or wildcard push. A concurrent destination
    // change is still protected by Git's normal fast-forward/tag checks.
    const push = git(cwd, ['push', '--porcelain', target, `${localRef}:${ref}`], true);
    if (push.status !== 0) {
      // Never retry an uncertain remote result (e.g. a WritHub HTTP 524).
      results.push({ ref, status: 'push-failed', sourceOid: oid, detail: push.stderr.trim() });
    } else {
      results.push({ ref, status: 'updated', oid });
    }
  }
  return { ok: results.every(row => !['conflict', 'push-failed'].includes(row.status)), mode: fullSync ? 'full-sync' : 'event-ref', refs: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const result = mirrorRefs({ cwd: process.cwd(), eventName: process.env.GITHUB_EVENT_NAME, eventRef: process.env.GITHUB_REF, deleted: event.deleted === true, fullSync: process.env.MIRROR_FULL_SYNC === 'true' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
