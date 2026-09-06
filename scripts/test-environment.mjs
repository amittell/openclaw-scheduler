import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Git hooks export repository selectors, and runtime paths take precedence over
// HOME in subprocess fixtures. Neither belongs in a verification process.
export function createTestEnvironment(home, { env = process.env, dbPath = join(home, 'scheduler.db') } = {}) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(GIT_|SCHEDULER_|OPENCLAW_|DISPATCH_)/i.test(name),
  ));
  mkdirSync(home, { recursive: true });
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
  };
}
