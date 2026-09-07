import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zero = '0'.repeat(40);
// npm ships the test directory, but repository hook sources are intentionally
// not installed into packages. These POSIX installer controls need a source checkout.
const skip = process.platform === 'win32' ? 'POSIX Git hook fixture'
  : !existsSync(join(source, 'scripts/setup-hooks.sh')) ? 'Repository hook sources are not packaged' : false;
const hookTest = (name, fn) => test(name, { skip }, fn);

function executable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'scheduler-hooks-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  const log = join(base, 'calls.jsonl');
  for (const path of [repo, bin, join(base, 'home'), join(base, 'empty-template')]) mkdirSync(path);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: join(base, 'home'), TMPDIR: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    FIXTURE_LOG: log, SCHEDULER_DB: ':memory:', OPENCLAW_SCHEDULER_HOME: join(base, 'home'),
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  };
  const run = (command, args, extra = {}) => spawnSync(command, args, {
    cwd: repo, env, encoding: 'utf8', timeout: 15000, ...extra,
  });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', `--template=${join(base, 'empty-template')}`);
  git('config', 'user.name', 'Hook Fixture');
  git('config', 'user.email', 'hook-fixture@example.invalid');
  mkdirSync(join(repo, 'scripts/git-hooks'), { recursive: true });
  for (const path of ['scripts/setup-hooks.sh', 'scripts/git-hooks/pre-push.mjs']) {
    copyFileSync(join(source, path), join(repo, path));
    chmodSync(join(repo, path), 0o755);
  }
  executable(join(repo, 'scripts/ci-gate.sh'), '#!/bin/sh\nprintf \'{"command":"ci"}\\n\' >> "$FIXTURE_LOG"\nexit "${FIXTURE_CI_EXIT:-0}"\n');
  executable(join(bin, 'npm'), `#!${process.execPath}\nimport('node:fs').then(fs => {
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({command:'npm',args:process.argv.slice(2)})+'\\n');
    if(process.env.FIXTURE_NPM_DIRTY) fs.writeFileSync('a.txt','changed by quality fixture');
    process.exit(Number(process.env.FIXTURE_NPM_EXIT || 0));
  });\n`);
  executable(join(bin, 'wh'), `#!${process.execPath}\nimport('node:fs').then(fs => {
    const args=process.argv.slice(2), scope=args[args.indexOf('--scope')+1];
    fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({command:'wh',args,scope})+'\\n');
    const mode=process.env.FIXTURE_WH_MODE;
    if(mode==='offline') process.exit(17);
    if(mode==='malformed') return console.log('{');
    if(mode==='wrong-envelope') return console.log(JSON.stringify({collection:'reservations',scope:'v1:'+scope,conflicts:[]}));
    if(mode==='wrong-scope') return console.log(JSON.stringify({collection:'conflicts',scope:'v1:other',conflicts:[]}));
    if(mode==='wrong-array') return console.log(JSON.stringify({collection:'conflicts',scope:'v1:'+scope,conflicts:null}));
    const overlap=mode==='conflict' || (mode==='scoped' && scope===process.env.FIXTURE_CONFLICT_PATH);
    const rows=(scope==='**' && ['scoped','unrelated'].includes(mode)) || overlap ? [{reservation_id:'shared-hold',holder_username:'alexm'}] : [];
    console.log(JSON.stringify({collection:'conflicts',scope:'v1:'+scope,conflicts:rows}));
  });\n`);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'fixture change');
  const head = git('rev-parse', 'HEAD');
  const input = `refs/heads/fixture ${head} refs/heads/fixture ${first}\n`;
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const invoke = (stdin = input, overrides = {}) => run(process.execPath, ['scripts/git-hooks/pre-push.mjs', 'origin', 'https://example.invalid/repo.git'], {
    input: stdin, env: { ...env, ...overrides },
  });
  const install = (overrides = {}) => run('bash', ['scripts/setup-hooks.sh'], { env: { ...env, ...overrides } });
  return { base, repo, bin, log, env, run, git, first, head, input, calls, invoke, install, hook: join(repo, '.git/hooks/pre-push') };
}

hookTest('installer preserves executable predecessor, is idempotent, and routes linked worktrees', t => {
  const f = fixture(t);
  mkdirSync(dirname(f.hook));
  executable(f.hook, '#!/bin/sh\nexit 91\n');
  const before = readFileSync(f.hook);
  assert.equal(f.install().status, 0);
  assert.deepEqual(readFileSync(`${f.hook}.before-openclaw-scheduler`), before);
  assert.equal(lstatSync(`${f.hook}.before-openclaw-scheduler`).mode & 0o777, 0o755);
  const installed = lstatSync(f.hook);
  assert.match(f.install().stdout, /Unchanged/);
  assert.equal(lstatSync(f.hook).ino, installed.ino);
  assert.equal(readdirSync(dirname(f.hook)).filter(p => p.includes('before-')).length, 1);
  const linked = join(f.base, 'linked');
  f.git('worktree', 'add', '--detach', linked, 'HEAD');
  executable(join(linked, 'scripts/git-hooks/pre-push.mjs'), '#!/bin/sh\nprintf "linked:%s:%s\\n" "$1" "$2"\n');
  const result = f.run(f.hook, ['origin', 'fixture-url'], { cwd: linked, input: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'linked:origin:fixture-url');
  rmSync(join(linked, 'scripts/git-hooks/pre-push.mjs'));
  assert.equal(f.run(f.hook, [], { cwd: linked, input: '' }).status, 1);
});

for (const kind of ['directory', 'directory-symlink', 'hooks-directory-symlink', 'core-hooks-path', 'source-missing']) {
  hookTest(`installer refuses ${kind} without replacement`, t => {
    const f = fixture(t);
    const target = join(f.base, 'target');
    mkdirSync(target);
    if (kind !== 'hooks-directory-symlink') mkdirSync(dirname(f.hook));
    if (kind === 'directory') mkdirSync(f.hook);
    else if (kind === 'directory-symlink') symlinkSync(target, f.hook);
    else if (kind === 'hooks-directory-symlink') symlinkSync(target, dirname(f.hook));
    else executable(f.hook, '#!/bin/sh\nexit 91\n');
    if (kind === 'core-hooks-path') f.git('config', 'core.hooksPath', target);
    if (kind === 'source-missing') rmSync(join(f.repo, 'scripts/git-hooks/pre-push.mjs'));
    const before = lstatSync(kind === 'hooks-directory-symlink' ? dirname(f.hook) : f.hook);
    assert.equal(f.install().status, 1);
    assert.equal(lstatSync(kind === 'hooks-directory-symlink' ? dirname(f.hook) : f.hook).ino, before.ino);
    assert.deepEqual(readdirSync(target), []);
  });
}

for (const broken of [false, true]) {
  hookTest(`installer preserves ${broken ? 'broken' : 'file'} symlink identity and older backup`, t => {
    const f = fixture(t);
    mkdirSync(dirname(f.hook));
    const target = join(f.base, 'old-hook');
    if (!broken) executable(target, '#!/bin/sh\nexit 91\n');
    symlinkSync(target, f.hook);
    writeFileSync(`${f.hook}.before-openclaw-scheduler`, 'older backup');
    assert.equal(f.install().status, 0);
    assert.equal(readlinkSync(`${f.hook}.before-openclaw-scheduler.1`), target);
    assert.equal(readFileSync(`${f.hook}.before-openclaw-scheduler`, 'utf8'), 'older backup');
    assert.equal(lstatSync(f.hook).isSymbolicLink(), false);
    if (!broken) assert.match(readFileSync(target, 'utf8'), /exit 91/);
  });
}

hookTest('failed atomic replacement preserves original and cleans same-directory staging', t => {
  const f = fixture(t);
  mkdirSync(dirname(f.hook));
  executable(f.hook, '#!/bin/sh\nexit 91\n');
  const before = readFileSync(f.hook);
  executable(join(f.bin, 'mv'), '#!/bin/sh\nprintf "%s\\n" "$2" > "$TMPDIR/staging-path"\nexit 42\n');
  assert.equal(f.install().status, 42);
  assert.deepEqual(readFileSync(f.hook), before);
  assert.deepEqual(readFileSync(`${f.hook}.before-openclaw-scheduler`), before);
  const staging = readFileSync(join(f.base, 'staging-path'), 'utf8').trim();
  const hooksDir = realpathSync(dirname(f.hook));
  assert.equal(dirname(staging), hooksDir);
  assert.match(basename(staging), /^\.pre-push\.[^/\\]+$/);
  // Inspect only the owned directory; command output is comparison data, not a path to access.
  const remaining = readdirSync(hooksDir);
  assert.equal(remaining.includes(basename(staging)), false);
  assert.equal(remaining.some(p => p.startsWith('.pre-push.')), false);
});

hookTest('clear coordination invokes both existing gate commands in order', t => {
  const f = fixture(t);
  const result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().map(c => c.command), ['wh', 'ci', 'npm']);
  assert.deepEqual(f.calls()[0].args, ['reservation', 'conflicts', '--repo', 'alexm/openclaw-scheduler', '--scope', '**', '--json']);
  assert.deepEqual(f.calls()[2].args, ['run', 'verify:smoke']);
});

for (const mode of ['offline', 'malformed', 'wrong-envelope', 'wrong-scope', 'wrong-array', 'conflict']) {
  hookTest(`coordination ${mode} blocks before quality, even with CLI success`, t => {
    const f = fixture(t);
    assert.equal(f.invoke(f.input, { FIXTURE_WH_MODE: mode }).status, 1);
    assert.ok(f.calls().length >= 1);
    assert.ok(f.calls().every(c => c.command === 'wh'));
  });
}

hookTest('missing CLI fails closed', t => {
  const f = fixture(t);
  // A deliberately minimal PATH contains Git but no system/live wh.
  const only = join(f.base, 'only');
  mkdirSync(only);
  const gitPath = f.run('which', ['git']).stdout.trim();
  symlinkSync(gitPath, join(only, 'git'));
  assert.equal(f.invoke(f.input, { PATH: only }).status, 1);
  assert.deepEqual(f.calls(), []);
});

hookTest('unrelated reservation checks exact union of changed, removed and renamed paths', t => {
  const f = fixture(t);
  f.git('mv', 'a.txt', 'renamed file.txt');
  f.git('commit', '-qm', 'rename');
  const head = f.git('rev-parse', 'HEAD');
  const stream = `refs/heads/one ${head} refs/heads/one ${f.first}\nrefs/heads/two ${head} refs/heads/two ${f.head}\n`;
  assert.equal(f.invoke(stream, { FIXTURE_WH_MODE: 'unrelated' }).status, 0);
  assert.deepEqual(f.calls().filter(c => c.command === 'wh').map(c => c.scope), ['**', 'a.txt', 'renamed file.txt']);
  assert.equal(f.calls().filter(c => c.command === 'npm').length, 1);
});

hookTest('a scoped overlap on a removed path blocks', t => {
  const f = fixture(t);
  f.git('rm', 'a.txt');
  f.git('commit', '-qm', 'remove');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.invoke(`refs/heads/main ${head} refs/heads/main ${f.head}\n`, { FIXTURE_WH_MODE: 'scoped', FIXTURE_CONFLICT_PATH: 'a.txt' }).status, 1);
  assert.ok(f.calls().every(c => c.command === 'wh'));
});

hookTest('new branch checks whole tree and annotated tag resolves to checked-out commit', t => {
  const f = fixture(t);
  f.git('tag', '-am', 'fixture tag', 'fixture-tag');
  const tag = f.git('rev-parse', 'fixture-tag');
  const result = f.invoke(`refs/tags/fixture-tag ${tag} refs/tags/fixture-tag ${zero}\n`, { FIXTURE_WH_MODE: 'unrelated' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().filter(c => c.command === 'wh').map(c => c.scope).sort(), ['**', 'a.txt', 'scripts/ci-gate.sh', 'scripts/git-hooks/pre-push.mjs', 'scripts/setup-hooks.sh'].sort());
});

hookTest('empty, no-op and deletion-only updates need no source gates', t => {
  const f = fixture(t);
  for (const input of ['', `refs/heads/main ${f.head} refs/heads/main ${f.head}\n`, `(delete) ${zero} refs/heads/old ${f.first}\n`]) {
    assert.equal(f.invoke(input).status, 0);
  }
  assert.deepEqual(f.calls(), []);
});

hookTest('non-HEAD, malformed, missing-object and dirty-tree inputs refuse before coordination', t => {
  const f = fixture(t);
  for (const input of ['garbage\n', `refs/heads/old ${f.first} refs/heads/old ${zero}\n`, `refs/heads/main ${f.head} refs/heads/main ${'f'.repeat(40)}\n`]) {
    assert.equal(f.invoke(input).status, 1);
  }
  writeFileSync(join(f.repo, 'uncommitted'), 'dirty');
  assert.equal(f.invoke().status, 1);
  assert.deepEqual(f.calls(), []);
});

for (const gate of ['CI', 'NPM']) {
  hookTest(`${gate} failure blocks publication`, t => {
    const f = fixture(t);
    assert.equal(f.invoke(f.input, { [`FIXTURE_${gate}_EXIT`]: '23' }).status, 1);
    assert.deepEqual(f.calls().map(c => c.command), gate === 'CI' ? ['wh', 'ci'] : ['wh', 'ci', 'npm']);
  });
}

hookTest('source mutation during successful quality commands blocks publication', t => {
  const f = fixture(t);
  const result = f.invoke(f.input, { FIXTURE_NPM_DIRTY: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Source changed while quality gates ran/);
  assert.deepEqual(f.calls().map(c => c.command), ['wh', 'ci', 'npm']);
});

hookTest('normal push to owned bare remote invokes installed hook, no-op push runs no gates', t => {
  const f = fixture(t);
  const remote = join(f.base, 'remote.git');
  f.git('init', '--bare', '-q', `--template=${join(f.base, 'empty-template')}`, remote);
  assert.equal(f.install().status, 0);
  f.git('remote', 'add', 'fixture', remote);
  f.git('push', 'fixture', 'HEAD:refs/heads/main');
  assert.deepEqual(f.calls().map(c => c.command), ['wh', 'ci', 'npm']);
  assert.equal(f.git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), f.head);
  f.git('push', 'fixture', 'HEAD:refs/heads/main');
  assert.equal(f.calls().length, 3);
});
