#!/usr/bin/env node
// Read Git's actual ref-update stream once; never infer push scope from HEAD alone.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = 'alexm/openclaw-scheduler';
const MAX_OUTPUT = 16 * 1024 * 1024;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
}

function conflicts(scope) {
  let result;
  try {
    const output = execFileSync('wh', ['reservation', 'conflicts', '--repo', REPO, '--scope', scope, '--json'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = JSON.parse(output);
  } catch {
    throw new Error('WritHub conflict check failed. Restore CLI authentication/service access, then retry normally.');
  }
  if (result?.collection !== 'conflicts' || result.scope !== `v1:${scope}` || !Array.isArray(result.conflicts)) {
    throw new Error('WritHub returned an invalid conflict response; publication is blocked.');
  }
  return result.conflicts;
}

function main() {
  const input = readFileSync(0, 'utf8');
  // Git supplies no updates for an already-up-to-date push.
  if (!input.trim()) return;
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const oid = new RegExp(`^[0-9a-f]{${head.length}}$`, 'i');
  const zero = '0'.repeat(head.length);
  const paths = new Set();
  let writes = 0;
  for (const line of input.trimEnd().split('\n')) {
    const fields = line.split(' ');
    if (fields.length !== 4 || !oid.test(fields[1]) || !oid.test(fields[3])) {
      throw new Error('Invalid Git pre-push ref stream; publication is blocked.');
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    git(['check-ref-format', remoteRef]);
    if (localSha === zero) {
      if (localRef !== '(delete)' || remoteSha === zero) throw new Error('Invalid ref deletion.');
      continue;
    }
    // Git preserves source spellings such as HEAD or a raw object ID here;
    // the supplied object (validated below), not that spelling, is authoritative.
    const commit = git(['rev-parse', '--verify', `${localSha}^{commit}`]).trim();
    if (commit !== head) throw new Error('Push each commit from its own checked-out worktree so quality checks cover the published source.');
    if (localSha === remoteSha) continue;
    writes += 1;
    // A new ref introduces its whole tree. No remote fetch or guessed base.
    const names = remoteSha === zero
      ? git(['ls-tree', '-r', '--name-only', '-z', localSha])
      : git(['diff', '--no-renames', '--name-only', '-z', remoteSha, localSha, '--']);
    for (const name of names.split('\0')) if (name) paths.add(name);
  }
  if (!writes) return;
  if (git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('Commit or remove worktree changes before pushing; checks require the exact clean pushed tree.');
  }
  // The broad query is only an empty-set optimization. When any hold exists,
  // the server performs its own scope matching for every actual changed path.
  if (paths.size && conflicts('**').length) {
    for (const path of [...paths].sort()) {
      if (conflicts(path).length) {
        throw new Error(`WritHub reservation overlaps ${JSON.stringify(path)}. Resolve it on wh chat and release the hold before retrying; shared-account holds are not excluded.`);
      }
    }
  }
  console.log('[pre-push] WritHub coordination clear; running tracked project quality gates.');
  execFileSync('bash', ['scripts/ci-gate.sh'], { stdio: ['ignore', 'inherit', 'inherit'] });
  execFileSync('npm', ['run', 'verify:smoke'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== head || git(['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('Source changed while quality gates ran; review and commit it before retrying.');
  }
  console.log('[pre-push] Project quality gates passed.');
}

try {
  main();
} catch (error) {
  // Do not print captured CLI output: authentication failures can contain data
  // unrelated to this public source gate. Quality commands already inherit logs.
  console.error(`[pre-push] ${error instanceof Error ? error.message.split('\n')[0] : 'Check failed.'}`);
  process.exitCode = 1;
}
