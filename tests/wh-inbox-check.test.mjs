import './isolate-environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../scripts/wh-inbox-check.py', import.meta.url));
// The inbox checker is a repository utility, not part of the npm package.
const skip = !existsSync(source) ? 'Repository inbox checker is not packaged' : false;
const inboxTest = (name, fn) => test(name, { skip }, fn);
const python = process.platform === 'win32' ? 'python' : 'python3';
const harness = String.raw`
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("inbox_check", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = json.load(sys.stdin)
module.SEATS = {name: "/synthetic/" + name for name in scenario}
module.ENV = {"HOME": "/synthetic/home", "PATH": "/synthetic/bin"}
calls = []

def fake_run(args, *, env, capture_output, text):
    assert capture_output is True and text is True
    seat = env["WH_CONFIG_DIR"].removeprefix("/synthetic/")
    assert env == {**module.ENV, "WH_CONFIG_DIR": module.SEATS[seat]}
    calls.append({"seat": seat, "args": args, "env": env})
    if args == ["wh", "auth", "status", "--json"]:
        response = scenario[seat].get("auth", {"key_id": seat + "-synthetic-key"})
        kind = "auth"
    elif args == ["wh", "inbox", "--chat", "--self-handle", "kebablebot-" + seat, "--json"]:
        response = scenario[seat].get("inbox", {"active_repos": 3, "addressed": [], "errors": []})
        kind = "inbox"
    elif args == ["wh", "obligations", "list", "--handle", "kebablebot-" + seat, "--json"]:
        response = scenario[seat]["obligations"]
        kind = "obligations"
    else:
        raise AssertionError("unexpected command")
    if kind + "_raw" in scenario[seat]:
        output = scenario[seat][kind + "_raw"]
    else:
        output = json.dumps(response)
    return subprocess.CompletedProcess(args, scenario[seat].get(kind + "_exit", 0), output, "synthetic failure")

output = io.StringIO()
with patch.dict(os.environ, {"WH_SEATS": ",".join(scenario)}, clear=True), \
        patch.object(subprocess, "run", fake_run), contextlib.redirect_stdout(output):
    status = module.main()
print(json.dumps({"status": status, "stdout": output.getvalue(), "calls": calls}))
`;

function check(scenario) {
  const child = spawnSync(python, ['-I', '-B', '-c', harness, source], {
    input: JSON.stringify(scenario),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

const pending = { id: 'pending-one', status: 'pending' };
const handled = { id: 'handled-one', status: 'HANDLED' };

for (const [shape, obligations] of [['list', [pending, handled]], ['items object', { items: [pending, handled] }]]) {
  inboxTest(`reports pending obligations from a valid ${shape}`, () => {
    const result = check({ openclaw: { obligations } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /obligations: total=2 pending=1/);
    assert.match(result.stdout, /PEND: .*pending-one/);
    assert.doesNotMatch(result.stdout, /handled-one|PARSE_FAIL/);
    assert.deepEqual(result.calls.map(call => call.args[1]), ['auth', 'inbox', 'obligations']);
  });
}

for (const [shape, obligations] of [['list', []], ['items object', { items: [] }]]) {
  inboxTest(`accepts an empty ${shape}`, () => {
    const result = check({ openclaw: { obligations } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /obligations: total=0 pending=0/);
    assert.doesNotMatch(result.stdout, /PEND:|PARSE_FAIL/);
  });
}

inboxTest('keeps both seats, handles, and response shapes isolated', () => {
  const result = check({
    openclaw: { obligations: [pending], inbox: { active_repos: 3 } },
    agent: { obligations: { items: [handled] }, inbox: { active_repos: ['a', 'b'] } },
  });
  assert.equal(result.status, 0);
  const [first, second] = result.stdout.split('=== agent inbox ===');
  assert.match(first, /active_repos=3/);
  assert.match(first, /obligations: total=1 pending=1/);
  assert.match(second, /active_repos=2/);
  assert.match(second, /obligations: total=1 pending=0/);
  assert.doesNotMatch(second, /pending-one|PARSE_FAIL/);
  assert.deepEqual(result.calls.map(call => call.seat), ['openclaw', 'openclaw', 'openclaw', 'agent', 'agent', 'agent']);
});

for (const [kind, broken] of [
  ['invalid JSON', { obligations: [], obligations_raw: '{' }],
  ['non-object entry', { obligations: ['malformed'] }],
  ['non-container response', { obligations: 42 }],
]) {
  inboxTest(`reports ${kind} without masking the next seat`, () => {
    const result = check({ openclaw: broken, agent: { obligations: { items: [pending] } } });
    assert.equal(result.status, 1);
    assert.equal((result.stdout.match(/PARSE_FAIL/g) || []).length, 1);
    const second = result.stdout.split('=== agent inbox ===')[1];
    assert.match(second, /obligations: total=1 pending=1/);
    assert.match(second, /PEND: .*pending-one/);
    assert.match(second, /INBOX_CHECK_DONE/);
    assert.deepEqual(result.calls.map(call => call.seat), ['openclaw', 'openclaw', 'openclaw', 'agent', 'agent', 'agent']);
  });
}

inboxTest('continues with the other seat after an auth failure', () => {
  const result = check({ openclaw: { auth_exit: 1, obligations: [] }, agent: { obligations: [pending] } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AUTH FAIL synthetic failure/);
  assert.match(result.stdout, /obligations: total=1 pending=1/);
  assert.doesNotMatch(result.stdout, /PARSE_FAIL/);
  assert.deepEqual(result.calls.map(call => call.seat), ['openclaw', 'agent', 'agent', 'agent']);
});

inboxTest('counts every pending obligation while printing at most ten', () => {
  const result = check({ openclaw: { obligations: Array.from({ length: 12 }, (_, id) => ({ id, status: 'pending' })) } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /obligations: total=12 pending=12/);
  assert.equal((result.stdout.match(/^PEND:/gm) || []).length, 10);
});
