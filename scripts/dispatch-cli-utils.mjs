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
 *  0) DISPATCH_CLI env override -- explicit override always wins
 *  1) openclaw-scheduler bin (in PATH) -- preferred public interface for npm consumers
 *  2) $OPENCLAW_HOME/scheduler/dispatch/index.mjs
 *  3) $OPENCLAW_HOME/dispatch/index.mjs
 *
 * @param {object} env - Environment variables (defaults to process.env).
 * @param {function} exists - File existence check (defaults to existsSync).
 * @param {function} cmdExists - Binary-in-PATH check (defaults to commandExists).
 * @returns {string} Absolute file path to the dispatch CLI entry point,
 *   or the bare binary name 'openclaw-scheduler' when found in PATH.
 */
export function resolveDispatchCliPath(env = process.env, exists = existsSync, cmdExists = commandExists) {
  const homeDir = env.HOME || '';
  const openclawHome = env.OPENCLAW_HOME
    || (homeDir ? join(homeDir, '.openclaw') : '.openclaw');

  // Explicit env override always wins
  if (env.DISPATCH_CLI && exists(env.DISPATCH_CLI)) return env.DISPATCH_CLI;

  // Prefer installed bin in PATH (canonical entry point for npm consumers)
  if (cmdExists('openclaw-scheduler')) return 'openclaw-scheduler';

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
  // Match any branded deliver job: <brand>-deliver:<label>
  const deliverMatch = jobName.match(/^.+-deliver:(.+)$/);
  if (deliverMatch) {
    const suffix = deliverMatch[1];
    if (labels[suffix]) return suffix;
  }
  return null;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Build a human-clear, machine-usable delivery surface for dispatch CLI output.
 * Distinguishes between enabled delivery, intentional disablement, and missing/legacy state.
 */
export function buildDispatchDeliverySurface(record = {}) {
  const deliverTo = normalizeOptionalString(record.deliverTo ?? record.delivery_to);
  const deliverChannel = normalizeOptionalString(record.deliverChannel ?? record.delivery_channel);
  const deliveryMode = normalizeOptionalString(record.deliveryMode ?? record.delivery_mode);
  const explicitReason = normalizeOptionalString(
    record.deliveryDisabledReason
      ?? record.delivery_opt_out_reason
      ?? record.reason
  );
  const deliveryDisabled = record.deliveryDisabled === true
    || (record.delivery_mode === 'none' && !deliverTo)
    || (record.deliveryMode === 'none' && !deliverTo);

  if (deliverTo) {
    return {
      status: 'enabled',
      mode: deliveryMode || 'announce',
      channel: deliverChannel,
      target: deliverTo,
      ...(typeof record.scheduler === 'boolean' ? { scheduler: record.scheduler } : {}),
      ...(typeof record.gateway === 'boolean' ? { gateway: record.gateway } : {}),
    };
  }

  if (deliveryDisabled || explicitReason) {
    return {
      status: 'disabled',
      mode: deliveryMode || null,
      channel: null,
      target: null,
      reason: explicitReason || 'explicit opt-out',
    };
  }

  return {
    status: 'missing',
    mode: deliveryMode || null,
    channel: null,
    target: null,
    reason: 'delivery target missing or not recorded',
  };
}
