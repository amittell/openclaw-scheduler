import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Check if a binary is available in PATH.
 */
function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the dispatch CLI path with backward-compatible fallbacks.
 * Priority:
 *  0) openclaw-scheduler bin (in PATH) — preferred public interface
 *  1) DISPATCH_CLI env override
 *  2) CHILISAUS_CLI (legacy override)
 *  3) $OPENCLAW_HOME/scheduler/dispatch/index.mjs
 *  4) $OPENCLAW_HOME/dispatch/index.mjs
 *  5) $OPENCLAW_HOME/chilisaus/index.mjs (legacy fallback)
 *
 * Returns { path, useBin } where useBin=true means call via `openclaw-scheduler`
 * directly rather than `node <path>`.
 */
export function resolveDispatchCliPath(env = process.env, exists = existsSync) {
  const homeDir = env.HOME || '';
  const openclawHome = env.OPENCLAW_HOME
    || (homeDir ? join(homeDir, '.openclaw') : '.openclaw');

  // Explicit env overrides always win
  if (env.DISPATCH_CLI && exists(env.DISPATCH_CLI)) return env.DISPATCH_CLI;
  if (env.CHILISAUS_CLI && exists(env.CHILISAUS_CLI)) return env.CHILISAUS_CLI;

  // Well-known paths in priority order
  const candidates = [
    join(openclawHome, 'scheduler', 'dispatch', 'index.mjs'),
    join(openclawHome, 'dispatch', 'index.mjs'),
    join(openclawHome, 'chilisaus', 'index.mjs'),
  ];
  const found = candidates.find(p => exists(p));
  if (found) return found;

  // Fall back to bin in PATH — only when no explicit env or file candidates match
  if (commandExists('openclaw-scheduler')) return 'openclaw-scheduler';

  return candidates[0] || 'dispatch/index.mjs';
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
