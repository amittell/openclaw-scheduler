import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Resolve the dispatch CLI path with backward-compatible fallbacks.
 * Priority:
 *  1) DISPATCH_CLI
 *  2) CHILISAUS_CLI (legacy override)
 *  3) $OPENCLAW_HOME/dispatch/index.mjs
 *  4) $OPENCLAW_HOME/chilisaus/index.mjs (legacy path)
 */
export function resolveDispatchCliPath(env = process.env, exists = existsSync) {
  const homeDir = env.HOME || '';
  const openclawHome = env.OPENCLAW_HOME
    || (homeDir ? join(homeDir, '.openclaw') : '.openclaw');
  const candidates = [
    env.DISPATCH_CLI,
    env.CHILISAUS_CLI,
    join(openclawHome, 'dispatch', 'index.mjs'),
    join(openclawHome, 'chilisaus', 'index.mjs'),
  ].filter(Boolean);
  return candidates.find(p => exists(p)) || candidates[0] || 'dispatch/index.mjs';
}

/**
 * Resolve a scheduler job name to a dispatch label in labels.json.
 * Supports current and legacy watcher prefixes.
 */
export function resolveDispatchLabel(jobName, labels = {}) {
  if (labels[jobName]) return jobName;
  for (const prefix of ['dispatch-deliver:', 'chilisaus-deliver:']) {
    if (jobName.startsWith(prefix)) {
      const suffix = jobName.slice(prefix.length);
      if (labels[suffix]) return suffix;
    }
  }
  return null;
}
