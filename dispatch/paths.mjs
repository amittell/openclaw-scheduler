import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve as pathResolve, sep } from 'path';
import { homedir } from 'os';
import { assertContainedPath } from '../identifiers.js';

function schedulerHome(env) {
  return env.OPENCLAW_SCHEDULER_HOME ||
    join(env.HOME || homedir(), '.openclaw', 'scheduler');
}

export function resolveDispatchStateDir({ env = process.env } = {}) {
  return pathResolve(
    env.DISPATCH_STATE_DIR || join(schedulerHome(env), 'dispatch'),
  );
}

function resolveContainedLabelsPath(stateDir, configuredPath) {
  const candidate = pathResolve(stateDir, configuredPath);
  const statePrefix = stateDir.endsWith(sep) ? stateDir : `${stateDir}${sep}`;
  if (candidate === stateDir) {
    throw new Error('DISPATCH_LABELS_PATH must name a file beneath DISPATCH_STATE_DIR');
  }
  if (!candidate.startsWith(statePrefix)) {
    throw new Error('DISPATCH_LABELS_PATH escapes DISPATCH_STATE_DIR');
  }
  return assertContainedPath(stateDir, candidate, 'DISPATCH_LABELS_PATH');
}

export function resolveLabelsPath({ legacyCandidates = [], env = process.env } = {}) {
  const stateDir = resolveDispatchStateDir({ env });
  const labelsPath = resolveContainedLabelsPath(
    stateDir,
    env.DISPATCH_LABELS_PATH || 'labels.json',
  );
  mkdirSync(dirname(labelsPath), { recursive: true });
  assertContainedPath(stateDir, labelsPath, 'DISPATCH_LABELS_PATH');

  if (!env.DISPATCH_LABELS_PATH && !existsSync(labelsPath)) {
    const normalizedTarget = pathResolve(labelsPath);
    const legacyPath = legacyCandidates
      .filter(Boolean)
      .map((candidate) => pathResolve(candidate))
      .find((candidate) => candidate !== normalizedTarget && existsSync(candidate));
    if (legacyPath) {
      copyFileSync(legacyPath, labelsPath);
    }
  }

  return labelsPath;
}
