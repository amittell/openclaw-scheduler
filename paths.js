import { accessSync, constants, existsSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function firstNonEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

function ensureWritableDir(dirPath) {
  try {
    mkdirSync(dirPath, { recursive: true });
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeModulesInstall(moduleDir) {
  return /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?openclaw-scheduler(?:[\\/]|$)/.test(moduleDir);
}

function isUsableWorkingDirectory(dirPath) {
  const candidate = firstNonEmpty(dirPath);
  if (!candidate) return false;
  try {
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveSchedulerHome(env = process.env) {
  const explicitHome = firstNonEmpty(env.SCHEDULER_HOME);
  if (explicitHome) return explicitHome;
  const home = firstNonEmpty(env.HOME) || homedir();
  return join(home, '.openclaw', 'scheduler');
}

export function resolveSchedulerDbPath(params = {}) {
  const env = params.env || process.env;
  const explicitPath = firstNonEmpty(params.explicitPath);
  if (explicitPath) return explicitPath;

  const envDbPath = firstNonEmpty(env.SCHEDULER_DB);
  if (envDbPath) return envDbPath;

  const moduleDir = firstNonEmpty(params.moduleDir) || __dirname;
  const moduleDbPath = join(moduleDir, 'scheduler.db');
  const moduleDirWritable = !isNodeModulesInstall(moduleDir) && ensureWritableDir(moduleDir);
  if (!isNodeModulesInstall(moduleDir) && (existsSync(moduleDbPath) || moduleDirWritable)) {
    return moduleDbPath;
  }

  return join(resolveSchedulerHome(env), 'scheduler.db');
}

export function ensureSchedulerDbParent(dbPath) {
  const parent = dirname(dbPath);
  mkdirSync(parent, { recursive: true });
  return parent;
}

export function resolveBackupStagingDir(env = process.env) {
  const explicit = firstNonEmpty(env.SCHEDULER_BACKUP_STAGING_DIR);
  if (explicit) return explicit;
  return join(resolveSchedulerHome(env), '.backup-staging');
}

export function resolveServiceWorkingDirectory(params = {}) {
  const env = params.env || process.env;
  const explicitPath = firstNonEmpty(params.explicitPath);
  if (explicitPath) {
    try {
      mkdirSync(explicitPath, { recursive: true });
      if (isUsableWorkingDirectory(explicitPath)) return explicitPath;
    } catch {
      // Fall through to install-root/scheduler-home heuristics.
    }
  }

  const moduleDir = firstNonEmpty(params.moduleDir) || __dirname;
  if (!isNodeModulesInstall(moduleDir) && isUsableWorkingDirectory(moduleDir)) {
    return moduleDir;
  }

  const schedulerHome = resolveSchedulerHome(env);
  try {
    mkdirSync(schedulerHome, { recursive: true });
    if (isUsableWorkingDirectory(schedulerHome)) return schedulerHome;
  } catch {
    // Fall through to other safe directories.
  }

  const home = firstNonEmpty(env.HOME) || homedir();
  if (isUsableWorkingDirectory(home)) return home;

  return tmpdir();
}

export function resolveArtifactsDir(params = {}) {
  const env = params.env || process.env;
  const explicit = firstNonEmpty(params.explicitPath) || firstNonEmpty(env.SCHEDULER_ARTIFACTS_DIR);
  if (explicit) return explicit;
  const dbPath = firstNonEmpty(params.dbPath);
  if (dbPath && dbPath !== ':memory:') {
    return join(dirname(dbPath), 'artifacts');
  }
  return join(resolveSchedulerHome(env), 'artifacts');
}

export function ensureArtifactsDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}
