import { existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

/**
 * Check if a binary is available in PATH.
 */
function commandExists(cmd) {
  try {
    const isWin = process.platform === 'win32';
    execFileSync(isWin ? 'where' : 'which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the dispatch CLI path with backward-compatible fallbacks.
 * Priority:
 *  0) openclaw-scheduler bin (in PATH) -- preferred public interface
 *  1) DISPATCH_CLI env override
 *  2) $OPENCLAW_HOME/scheduler/dispatch/index.mjs
 *  3) $OPENCLAW_HOME/dispatch/index.mjs
 *
 * @param {object} env - Environment variables (defaults to process.env).
 * @param {function} exists - File existence check (defaults to existsSync).
 * @returns {string} Absolute file path to the dispatch CLI entry point,
 *   or the bare binary name 'openclaw-scheduler' when found in PATH.
 */
export function resolveDispatchCliPath(env = process.env, exists = existsSync) {
  const homeDir = env.HOME || '';
  const openclawHome = env.OPENCLAW_HOME
    || (homeDir ? join(homeDir, '.openclaw') : '.openclaw');

  // Explicit env override always wins
  if (env.DISPATCH_CLI && exists(env.DISPATCH_CLI)) return env.DISPATCH_CLI;

  // Prefer installed bin in PATH (canonical entry point for npm consumers)
  if (commandExists('openclaw-scheduler')) return 'openclaw-scheduler';

  // Fall back to well-known file paths for dev/manual installs
  const candidates = [
    join(openclawHome, 'scheduler', 'dispatch', 'index.mjs'),
    join(openclawHome, 'dispatch', 'index.mjs'),
  ];

  return candidates.find(p => exists(p)) || candidates[0] || 'dispatch/index.mjs';
}

/**
 * Resolve a scheduler job name to a dispatch label in labels.json.
 * Supports current and legacy watcher prefixes.
 */
export function resolveDispatchLabel(jobName, labels = {}) {
  if (labels[jobName]) return jobName;
  for (const prefix of ['dispatch-deliver:']) {
    if (jobName.startsWith(prefix)) {
      const suffix = jobName.slice(prefix.length);
      if (labels[suffix]) return suffix;
    }
  }
  return null;
}
