import { isAbsolute, normalize, resolve } from 'node:path';

const MINIMAL_ENV_KEYS = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TZ',
  'USER',
]);

const HOST_SANDBOX_VALUES = new Set(['', 'none', 'off', 'host', 'inherit']);
const OPEN_NETWORK_VALUES = new Set(['', 'allow', 'full', 'host', 'inherit', 'unrestricted']);
const AUDIT_VALUES = new Set(['', 'none', 'off', 'basic', 'minimal', 'full', 'always']);
const RESERVED_CREDENTIAL_ENV_KEYS = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'TMPDIR', 'IFS',
  'ENV', 'BASH_ENV', 'ZDOTDIR', 'SHELLOPTS', 'CDPATH',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'PERL5OPT',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK',
]);
const RESERVED_CREDENTIAL_ENV_PREFIXES = [
  'DYLD_', 'OPENCLAW_', 'SCHEDULER_', 'DISPATCH_', 'COORD_',
  'NPM_CONFIG_', 'GIT_CONFIG_',
];
const INHERITED_SECRET_KEYS = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'VAULT_TOKEN',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS',
]);

export function isReservedCredentialEnvironmentKey(key) {
  if (typeof key !== 'string') return true;
  const normalized = key.toUpperCase();
  return RESERVED_CREDENTIAL_ENV_KEYS.has(normalized)
    || RESERVED_CREDENTIAL_ENV_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

export function assertCredentialEnvironmentKeyAllowed(key) {
  if (isReservedCredentialEnvironmentKey(key)) {
    const error = new Error(`Credential presentation cannot override reserved runtime environment key ${JSON.stringify(key)}`);
    error.code = 'CREDENTIAL_ENV_KEY_RESERVED';
    throw error;
  }
}

function shouldStripInheritedEnvironmentKey(key) {
  const normalized = key.toUpperCase();
  return INHERITED_SECRET_KEYS.has(normalized)
    || ['OPENCLAW_', 'SCHEDULER_', 'DISPATCH_', 'COORD_'].some(prefix => normalized.startsWith(prefix));
}

function parseJsonField(name, value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a JSON value or string`);
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${name} contains invalid JSON: ${err.message}`, { cause: err });
  }
}

function normalizePolicyName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function normalizeAllowedPaths(raw, cwd) {
  const parsed = parseJsonField('contract_allowed_paths', raw, []);
  if (!Array.isArray(parsed)) {
    throw new Error('contract_allowed_paths must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`contract_allowed_paths[${index}] must be a non-empty string`);
    }
    const resolved = normalize(isAbsolute(entry) ? entry : resolve(cwd, entry));
    if (!isAbsolute(resolved)) {
      throw new Error(`contract_allowed_paths[${index}] must resolve to an absolute path`);
    }
    return resolved;
  });
}

function requiresSandbox(policy) {
  if (policy == null) return false;
  const normalized = normalizePolicyName(policy);
  if (typeof normalized === 'string') return !HOST_SANDBOX_VALUES.has(normalized);
  if (typeof normalized !== 'object' || Array.isArray(normalized)) return true;
  const keys = Object.keys(normalized);
  if (keys.length === 0) return false;
  const supportedKeys = new Set(['isolation', 'mode', 'kind']);
  if (keys.some(key => !supportedKeys.has(key))) return true;
  return keys.some(key => {
    const value = normalizePolicyName(normalized[key]);
    return typeof value !== 'string' || !HOST_SANDBOX_VALUES.has(value);
  });
}

function restrictsNetwork(policy) {
  if (policy == null) return false;
  const normalized = normalizePolicyName(policy);
  if (typeof normalized === 'string') return !OPEN_NETWORK_VALUES.has(normalized);
  if (typeof normalized !== 'object' || Array.isArray(normalized)) return true;
  const keys = Object.keys(normalized);
  if (keys.length === 0) return false;
  const supportedKeys = new Set(['egress', 'mode', 'access']);
  if (keys.some(key => !supportedKeys.has(key))) return true;
  return keys.some(key => {
    const value = normalizePolicyName(normalized[key]);
    return typeof value !== 'string' || !OPEN_NETWORK_VALUES.has(value);
  });
}

function normalizeAuditPolicy(value) {
  const parsed = parseJsonField('contract_audit', value, null);
  if (parsed == null) return null;
  if (typeof parsed === 'string') {
    const normalized = normalizePolicyName(parsed);
    if (!AUDIT_VALUES.has(normalized)) {
      throw new Error(`Unsupported contract_audit policy "${parsed}"`);
    }
    return normalized;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('contract_audit must be a string or JSON object');
  }
  return parsed;
}

/**
 * Evaluate governance fields before executing a job. Policies that this
 * runtime cannot enforce are rejected instead of being treated as advisory.
 */
export function evaluateGovernance(job, {
  cwd = process.cwd(),
  sandboxEnforced = false,
  networkEnforced = false,
  pathEnforced = false,
  costMetered = false,
} = {}) {
  const violations = [];
  const warnings = [];
  let sandbox = null;
  let network = null;
  let allowedPaths = [];
  let audit = null;

  try {
    sandbox = parseJsonField('contract_sandbox', job.contract_sandbox, null);
    network = parseJsonField('contract_network', job.contract_network, null);
    allowedPaths = normalizeAllowedPaths(job.contract_allowed_paths, cwd);
    audit = normalizeAuditPolicy(job.contract_audit);
  } catch (err) {
    violations.push(err.message);
  }

  if (requiresSandbox(sandbox) && !sandboxEnforced) {
    violations.push('contract_sandbox requests isolation, but no enforceable sandbox is configured');
  }
  if (restrictsNetwork(network) && !networkEnforced) {
    violations.push('contract_network restricts network access, but no enforceable network sandbox is configured');
  }
  if (allowedPaths.length > 0 && !pathEnforced) {
    violations.push('contract_allowed_paths is set, but filesystem path isolation is not configured');
  }

  const maxCost = job.contract_max_cost_usd;
  if (maxCost != null && !costMetered) {
    violations.push('contract_max_cost_usd is set, but the selected runtime does not expose enforceable cost metering');
  }

  const shellEnvPolicy = job.shell_env_policy || 'minimal';
  if (!['minimal', 'inherit'].includes(shellEnvPolicy)) {
    violations.push(`Unsupported shell_env_policy "${shellEnvPolicy}"`);
  }
  if (shellEnvPolicy === 'inherit') {
    warnings.push('shell_env_policy=inherit exposes the dispatcher environment to the shell job');
  }

  const evaluatedAt = new Date().toISOString();
  return {
    allowed: violations.length === 0,
    violations,
    warnings,
    policy: {
      sandbox,
      network,
      allowed_paths: allowedPaths,
      max_cost_usd: maxCost ?? null,
      audit,
      shell_env_policy: shellEnvPolicy,
    },
    enforcement: {
      sandbox: sandboxEnforced,
      network: networkEnforced,
      paths: pathEnforced,
      cost: costMetered,
    },
    evaluated_at: evaluatedAt,
  };
}

export function assertGovernance(job, options = {}) {
  const decision = evaluateGovernance(job, options);
  if (!decision.allowed) {
    const err = new Error(`Governance policy denied execution: ${decision.violations.join('; ')}`);
    err.code = 'SCHEDULER_GOVERNANCE_DENIED';
    err.decision = decision;
    throw err;
  }
  return decision;
}

/**
 * Build a shell environment without mutating process.env. Fresh jobs default
 * to a minimal allowlist; migrated jobs explicitly retain legacy inheritance.
 */
export function buildShellEnvironment(job, materializedEnv = null, baseEnv = process.env) {
  const policy = job.shell_env_policy || 'minimal';
  const env = {};
  if (policy === 'inherit') {
    Object.assign(env, baseEnv);
  } else if (policy === 'minimal') {
    for (const key of MINIMAL_ENV_KEYS) {
      if (baseEnv[key] != null) env[key] = baseEnv[key];
    }
  } else {
    throw new Error(`Unsupported shell_env_policy "${policy}"`);
  }
  for (const key of Object.keys(env)) {
    if (shouldStripInheritedEnvironmentKey(key)) delete env[key];
  }
  if (materializedEnv && typeof materializedEnv === 'object') {
    for (const [key, value] of Object.entries(materializedEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid materialized environment key ${JSON.stringify(key)}`);
      }
      assertCredentialEnvironmentKeyAllowed(key);
      if (value == null) throw new Error(`Materialized environment value for ${JSON.stringify(key)} is required`);
      env[key] = String(value);
    }
  }
  return env;
}

/** Clear materialized credential values from mutable in-memory objects. */
export function clearMaterializedEnvironment(materializedEnv) {
  if (!materializedEnv || typeof materializedEnv !== 'object') return;
  for (const key of Object.keys(materializedEnv)) {
    materializedEnv[key] = '';
    delete materializedEnv[key];
  }
}

export function summarizeGovernance(decision) {
  if (!decision) return null;
  return {
    allowed: Boolean(decision.allowed),
    violations: [...(decision.violations || [])],
    warnings: [...(decision.warnings || [])],
    policy: decision.policy || null,
    enforcement: decision.enforcement || null,
    evaluated_at: decision.evaluated_at || null,
  };
}
