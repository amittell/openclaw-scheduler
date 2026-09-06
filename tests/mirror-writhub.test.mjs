import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mirrorRefs } from '../scripts/mirror-writhub.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-mirror-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  function git(...args) {
    const result = spawnSync('git', args, { cwd: args[0] === 'init' ? root : cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--initial-branch=main', cwd);
  git('config', 'user.name', 'Synthetic mirror test');
  git('config', 'user.email', 'mirror@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const remote of ['origin', 'writhub']) {
    git('init', '--bare', join(root, `${remote}.git`));
    git('remote', 'add', remote, join(root, `${remote}.git`));
    git('push', remote, 'main');
  }
  git('tag', '-a', 'v0.5.2', '-m', 'target annotation');
  git('push', 'writhub', 'refs/tags/v0.5.2');
  const targetTag = git('rev-parse', 'refs/tags/v0.5.2');
  git('tag', '-a', 'source-v0.5.2', base, '-m', 'source annotation');
  git('push', 'origin', 'refs/tags/source-v0.5.2:refs/tags/v0.5.2');
  git('checkout', '-b', 'target-main');
  git('commit', '--allow-empty', '-m', 'target main');
  const targetMain = git('rev-parse', 'HEAD');
  git('push', 'writhub', 'HEAD:refs/heads/main', 'HEAD:refs/heads/target-only');
  git('checkout', 'main');
  git('commit', '--allow-empty', '-m', 'source main');
  git('push', 'origin', 'main');
  git('checkout', '-b', 'candidate');
  git('commit', '--allow-empty', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  git('push', 'origin', 'candidate');
  const refs = () => new Map(git('ls-remote', '--refs', 'writhub').split('\n').map(line => line.split(/\s+/)).map(([oid, ref]) => [ref, oid]));
  const run = (options = {}) => mirrorRefs({ cwd, eventName: 'push', eventRef: 'refs/heads/candidate', ...options });
  return { root, cwd, git, base, targetTag, targetMain, candidate, refs, run };
}

test('an event branch is delivered despite divergent main and same-commit tag annotations', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.refs, [{ ref: 'refs/heads/candidate', status: 'updated', oid: f.candidate }]);
  assert.equal(f.refs().get('refs/heads/candidate'), f.candidate);
  assert.equal(f.refs().get('refs/heads/main'), f.targetMain);
  assert.equal(f.refs().get('refs/tags/v0.5.2'), f.targetTag);
  assert.equal(f.refs().get('refs/heads/target-only'), f.targetMain);
});

test('manual full sync delivers independent refs, reports both conflicts and preserves destination-only history', t => {
  const f = fixture(t);
  const result = f.run({ eventName: 'workflow_dispatch', fullSync: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refs.filter(row => row.status === 'conflict').map(row => [row.ref, row.reason]), [
    ['refs/heads/main', 'not-fast-forward'], ['refs/tags/v0.5.2', 'tag-object-differs'],
  ]);
  assert.equal(f.refs().get('refs/heads/candidate'), f.candidate);
  assert.equal(f.refs().get('refs/heads/main'), f.targetMain);
  assert.equal(f.refs().get('refs/tags/v0.5.2'), f.targetTag);
  assert.equal(f.refs().get('refs/heads/target-only'), f.targetMain);
});

test('branch convergence permits a normal fast-forward after preserving both histories', t => {
  const f = fixture(t);
  f.git('checkout', 'main');
  f.git('merge', '--no-ff', 'target-main', '-m', 'integrate both mains');
  const merged = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'main');
  assert.equal(f.run({ eventRef: 'refs/heads/main' }).ok, true);
  assert.equal(f.refs().get('refs/heads/main'), merged);
});

test('a conflicting event ref fails without changing it or delivering unrelated refs', t => {
  const f = fixture(t);
  const before = f.refs();
  const result = f.run({ eventRef: 'refs/heads/main' });
  assert.equal(result.ok, false);
  assert.equal(result.refs[0].reason, 'not-fast-forward');
  assert.deepEqual(f.refs(), before);
});

test('new annotated tags preserve their exact object and identical events are no-ops', t => {
  const f = fixture(t);
  f.git('tag', '-a', 'v-test', '-m', 'new annotation');
  const tag = f.git('rev-parse', 'refs/tags/v-test');
  f.git('push', 'origin', 'refs/tags/v-test');
  assert.equal(f.run({ eventRef: 'refs/tags/v-test' }).ok, true);
  assert.equal(f.refs().get('refs/tags/v-test'), tag);
  assert.equal(f.run({ eventRef: 'refs/tags/v-test' }).refs[0].status, 'unchanged');
});

test('source deletions are preserved without attempting to fetch a missing event ref', t => {
  const f = fixture(t);
  const before = f.refs();
  assert.equal(f.run({ eventRef: 'refs/heads/no-longer-present', deleted: true }).refs[0].status, 'preserved-deletion');
  assert.deepEqual(f.refs(), before);
});

test('queued events mirror the current source tip and manual defaults stay scoped', t => {
  const f = fixture(t);
  f.run();
  f.git('commit', '--allow-empty', '-m', 'newer candidate');
  const newer = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'candidate');
  const result = f.run({ eventName: 'workflow_dispatch' });
  assert.equal(result.ok, true);
  assert.equal(result.refs.length, 1);
  assert.equal(f.refs().get('refs/heads/candidate'), newer);
});

test('untrusted event inputs cannot select full sync or invalid refspecs', t => {
  const f = fixture(t);
  const before = f.refs();
  assert.throws(() => f.run({ fullSync: true }), /requires workflow_dispatch/);
  for (const eventRef of ['--mirror', 'refs/heads/*', 'refs/heads/main:refs/heads/other', 'refs/pull/39/head']) {
    assert.throws(() => f.run({ eventRef }), /valid branch or tag/);
  }
  assert.deepEqual(f.refs(), before);
});

test('a rejected push is reported as failure and is never retried', t => {
  const f = fixture(t);
  const target = join(f.root, 'writhub.git');
  writeFileSync(join(target, 'hooks/pre-receive'), '#!/bin/sh\nprintf "attempt\\n" >> mirror-attempts\nexit 1\n', { mode: 0o700 });
  const before = f.refs();
  const result = f.run();
  assert.equal(result.ok, false);
  assert.equal(result.refs[0].status, 'push-failed');
  assert.equal(readFileSync(join(target, 'mirror-attempts'), 'utf8'), 'attempt\n');
  assert.deepEqual(f.refs(), before);
});

test('Git subprocess credentials are available only to destination operations', t => {
  const f = fixture(t);
  // Exercise destination fetch as well as ls-remote and push.
  f.git('push', 'writhub', `${f.base}:refs/heads/candidate`);
  const realGit = process.env.PATH.split(delimiter).map(path => join(path, 'git')).find(path => existsSync(path));
  assert.ok(realGit);
  const gitWrapper = join(f.root, 'git');
  const observations = join(f.root, 'git-environment.jsonl');
  const askpass = fileURLToPath(new URL('../scripts/writhub-askpass.sh', import.meta.url));
  writeFileSync(gitWrapper, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const keys = ['WRITHUB_TOKEN', 'WRITHUB_USERNAME', 'WRITHUB_REPOSITORY', 'WRITHUB_ASKPASS', 'WRITHUB_EXTRA_TEST', 'GIT_ASKPASS', 'SSH_ASKPASS'];
appendFileSync(process.env.MIRROR_OBSERVATIONS, JSON.stringify({ args, present: Object.fromEntries(keys.map(key => [key, Object.hasOwn(process.env, key)])), intendedAskpass: process.env.GIT_ASKPASS === ${JSON.stringify(askpass)} }) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/mirror-writhub.mjs', import.meta.url))], {
    cwd: f.cwd,
    env: { ...process.env, PATH: `${f.root}${delimiter}${process.env.PATH}`, MIRROR_OBSERVATIONS: observations, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/candidate', GITHUB_EVENT_PATH: '', MIRROR_FULL_SYNC: 'false', WRITHUB_TOKEN: 'synthetic-only-token', WRITHUB_USERNAME: 'fixture', WRITHUB_REPOSITORY: 'fixture/scheduler', WRITHUB_ASKPASS: askpass, WRITHUB_EXTRA_TEST: 'synthetic-extra', GIT_ASKPASS: 'must-not-inherit', SSH_ASKPASS: 'must-not-inherit', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.refs().get('refs/heads/candidate'), f.candidate);
  const rows = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const sourceAndLocal = rows.filter(row => !row.args.includes('writhub'));
  const destination = rows.filter(row => row.args.includes('writhub'));
  assert.ok(sourceAndLocal.some(row => row.args.includes('origin')));
  assert.equal(destination.length, 3, 'destination ls-remote, fetch and push were exercised');
  for (const row of sourceAndLocal) assert.ok(Object.values(row.present).every(present => !present), 'source/local Git must receive no WritHub credential variables or askpass');
  for (const row of destination) {
    assert.equal(row.present.WRITHUB_TOKEN, true);
    assert.equal(row.present.WRITHUB_USERNAME, true);
    assert.equal(row.present.WRITHUB_REPOSITORY, true);
    assert.equal(row.intendedAskpass, true);
    assert.equal(row.present.SSH_ASKPASS, false);
    assert.deepEqual(row.args.slice(0, 2), ['-c', 'credential.useHttpPath=true']);
  }
});

test('askpass serves only the intended HTTPS WritHub repository and configured username', t => {
  const f = fixture(t);
  const askpass = fileURLToPath(new URL('../scripts/writhub-askpass.sh', import.meta.url));
  const env = { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', WRITHUB_USERNAME: 'fixture', WRITHUB_REPOSITORY: 'fixture/scheduler', WRITHUB_TOKEN: 'synthetic-only-token' };
  // credential fill invokes the actual Git askpass protocol; empty helpers
  // prevent access to any credential store. It performs no network operation.
  for (const [protocol, host, path, username, allowed] of [
    ['https', 'writhub.io', 'fixture/scheduler.git', null, true],
    ['https', 'writhub.io', 'fixture/scheduler.git', 'fixture', true],
    ['https', 'github.com', 'fixture/scheduler.git', null, false],
    ['https', 'unrelated.invalid', 'fixture/scheduler.git', null, false],
    ['https', 'writhub.io.unrelated.invalid', 'fixture/scheduler.git', null, false],
    ['http', 'writhub.io', 'fixture/scheduler.git', null, false],
    ['https', 'writhub.io', 'fixture/other.git', null, false],
    ['https', 'writhub.io', '', null, false],
    ['https', 'writhub.io', 'fixture/scheduler.git', 'other-user', false],
  ]) {
    const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true', 'credential', 'fill'], {
      cwd: f.cwd, env, input: `protocol=${protocol}\nhost=${host}\npath=${path}\n${username ? `username=${username}\n` : ''}\n`, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.status === 0, allowed, `${protocol}://${host}/${path} credential decision`);
    assert.equal(result.stdout.includes('password=synthetic-only-token'), allowed);
    if (!allowed) assert.equal(result.stdout, '', 'denied prompts return no credentials');
  }
});
