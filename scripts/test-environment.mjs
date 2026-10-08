import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Records which HOME a process was isolated into, so a test file started by
// test-all.mjs keeps the runner's environment instead of isolating twice.
const ISOLATED_HOME = 'OPENCLAW_SCHEDULER_TEST_HOME';

// Shadows an installed openclaw CLI. Given no Gateway URL, it connects to the
// operator's live Gateway on 127.0.0.1:18789 with whatever token it is handed.
// Fixtures that need a CLI put their own stub ahead of this one on PATH.
const OPENCLAW_GUARD = `#!/bin/sh
echo "openclaw-scheduler tests must not run an installed openclaw CLI; put a fixture stub ahead of it on PATH" >&2
exit 127
`;

// Git hooks export repository selectors, and runtime paths take precedence over
// HOME in subprocess fixtures. Neither belongs in a verification process.
export function createTestEnvironment(home, { env = process.env, dbPath = join(home, 'scheduler.db') } = {}) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(GIT_|SCHEDULER_|OPENCLAW_|DISPATCH_)/i.test(name),
  ));
  const guardBin = join(home, '.test-bin');
  mkdirSync(guardBin, { recursive: true });
  writeFileSync(join(guardBin, 'openclaw'), OPENCLAW_GUARD, { mode: 0o755 });
  return {
    ...isolated,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    SCHEDULER_DB: dbPath,
    // Fixtures explicitly opt into their stub Gateway; never discover a live one.
    OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9',
    PATH: env.PATH ? `${guardBin}${delimiter}${env.PATH}` : guardBin,
    [ISOLATED_HOME]: home,
  };
}

// Applies createTestEnvironment to this process. Every test entry point imports
// tests/isolate-environment.mjs first, before any scheduler module reads HOME,
// the Gateway target or credentials, so `node test.js` and `node --test
// tests/<file>` are as isolated as `npm test`. An in-memory database is kept;
// any database path is replaced, since it may be the operator's live one.
export function isolateTestProcess(env = process.env) {
  if (env[ISOLATED_HOME] && env[ISOLATED_HOME] === env.HOME) return;
  const home = mkdtempSync(join(tmpdir(), 'openclaw-scheduler-test-'));
  const isolated = createTestEnvironment(home, {
    env,
    dbPath: env.SCHEDULER_DB === ':memory:' ? ':memory:' : join(home, 'scheduler.db'),
  });
  for (const name of Object.keys(env)) {
    if (!Object.hasOwn(isolated, name)) delete env[name];
  }
  Object.assign(env, isolated);
  process.once('exit', () => rmSync(home, { recursive: true, force: true }));
}
