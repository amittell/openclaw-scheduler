import { existsSync, readFileSync } from 'fs';
import { join, resolve as pathResolve } from 'path';

// No static model fallback: OpenClaw's configured agent default is the only
// safe fallback because the gateway's allowlist can change independently.
export const STATIC_DISPATCH_DEFAULT_MODEL = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveModelPrimary(value) {
  const direct = normalizeString(value);
  if (direct) return direct;
  if (!isRecord(value)) return null;
  return normalizeString(value.primary);
}

function resolveHomeRelativePath(input, homeDir) {
  const trimmed = normalizeString(input);
  if (!trimmed) return null;
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
  return pathResolve(trimmed);
}

function resolveOpenClawStateDir({ env, homeDir }) {
  return resolveHomeRelativePath(env.OPENCLAW_STATE_DIR, homeDir) || join(homeDir, '.openclaw');
}

export function resolveOpenClawConfigPath({ env = process.env, homeDir } = {}) {
  const effectiveHome = homeDir || env.HOME || process.env.HOME;
  if (!effectiveHome) return null;
  return (
    resolveHomeRelativePath(env.OPENCLAW_CONFIG_PATH, effectiveHome) ||
    join(resolveOpenClawStateDir({ env, homeDir: effectiveHome }), 'openclaw.json')
  );
}

export function readOpenClawConfig({
  env = process.env,
  homeDir,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  const configPath = resolveOpenClawConfigPath({ env, homeDir });
  if (!configPath || !exists(configPath)) return {};
  try {
    return JSON.parse(readFile(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function resolveOpenClawDispatchDefaultModel(config) {
  const defaults = isRecord(config?.agents?.defaults) ? config.agents.defaults : {};
  return (
    resolveModelPrimary(defaults.dispatch?.model) ||
    resolveModelPrimary(defaults.model) ||
    null
  );
}

export function resolveDefaultDispatchModel({
  dispatchConfig = {},
  openClawConfig,
  env = process.env,
  homeDir,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  return (
    normalizeString(dispatchConfig.defaultModel) ||
    resolveModelPrimary(dispatchConfig.dispatch?.model) ||
    normalizeString(env.DISPATCH_DEFAULT_MODEL) ||
    resolveOpenClawDispatchDefaultModel(
      openClawConfig ?? readOpenClawConfig({ env, homeDir, exists, readFile }),
    ) ||
    STATIC_DISPATCH_DEFAULT_MODEL
  );
}
