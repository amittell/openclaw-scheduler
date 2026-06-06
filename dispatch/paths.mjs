import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve as pathResolve } from 'path';
import { homedir } from 'os';

function schedulerHome() {
  return process.env.OPENCLAW_SCHEDULER_HOME ||
    join(process.env.HOME || homedir(), '.openclaw', 'scheduler');
}

export function resolveDispatchStateDir() {
  return process.env.DISPATCH_STATE_DIR ||
    join(schedulerHome(), 'dispatch');
}

export function resolveLabelsPath({ legacyCandidates = [] } = {}) {
  if (process.env.DISPATCH_LABELS_PATH) {
    mkdirSync(dirname(process.env.DISPATCH_LABELS_PATH), { recursive: true });
    return process.env.DISPATCH_LABELS_PATH;
  }

  const labelsPath = join(resolveDispatchStateDir(), 'labels.json');
  mkdirSync(dirname(labelsPath), { recursive: true });

  if (!existsSync(labelsPath)) {
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
