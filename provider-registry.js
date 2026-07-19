import { readdir, stat as fsStat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identityProviders = new Map();
const authorizationProviders = new Map();
const proofVerifiers = new Map();
const evidenceProviders = new Map();

/**
 * Load provider plugins from a directory. Every *.js file is imported and
 * its default export registered by type (identity / authorization / proof-verifier).
 *
 * TRUST BOUNDARY: This directory is dynamically imported at startup. Only
 * point SCHEDULER_PROVIDER_PATH at operator-controlled directories. The loader
 * refuses world-writable directories as a minimal safety net, but the
 * primary defense is correct deployment configuration.
 */
export async function loadProviders(dirPath) {
  if (!dirPath) return;
  const absPath = resolve(dirPath);

  // Trust boundary: provider plugins run arbitrary code in the scheduler process.
  // Refuse to load from world-writable directories to prevent code injection.
  try {
    const dirStat = await fsStat(absPath);
    if ((dirStat.mode & 0o002) !== 0) {
      console.error(`[provider-registry] REFUSING to load providers: ${absPath} is world-writable (mode 0${(dirStat.mode & 0o777).toString(8)}). Fix permissions or use a trusted directory.`);
      return;
    }
  } catch (err) {
    console.error(`[provider-registry] Cannot stat provider directory ${absPath}: ${err.message}`);
    return;
  }

  const files = await readdir(absPath);
  const jsFiles = files.filter(f => f.endsWith('.js'));

  for (const file of jsFiles) {
    const filePath = join(absPath, file);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const provider = mod.default;
      if (!provider || !provider.name || !provider.type) {
        console.warn(`[provider-registry] Skipping ${file}: missing name or type`);
        continue;
      }
      if (provider.type === 'identity') {
        identityProviders.set(provider.name, provider);
      } else if (provider.type === 'authorization') {
        authorizationProviders.set(provider.name, provider);
      } else if (provider.type === 'proof-verifier') {
        proofVerifiers.set(provider.name, provider);
      } else if (provider.type === 'evidence') {
        evidenceProviders.set(provider.name, provider);
      } else {
        console.warn(`[provider-registry] Skipping ${file}: unknown type "${provider.type}"`);
      }
    } catch (err) {
      console.error(`[provider-registry] Failed to load ${file}: ${err.message}`);
    }
  }

  const total = identityProviders.size
    + authorizationProviders.size
    + proofVerifiers.size
    + evidenceProviders.size;
  console.log(`[provider-registry] Loaded ${total} provider(s) from ${absPath}`);
}

export function getIdentityProvider(name) {
  return identityProviders.get(name) || null;
}

export function getAuthorizationProvider(name) {
  return authorizationProviders.get(name) || null;
}

export function getProofVerifier(name) {
  return proofVerifiers.get(name) || null;
}

export function getEvidenceProvider(name) {
  return evidenceProviders.get(name) || null;
}

export function registerProvider(provider) {
  if (!provider || typeof provider.name !== 'string' || !provider.name
    || typeof provider.type !== 'string') {
    throw new TypeError('provider must declare non-empty name and type');
  }
  const registries = {
    identity: identityProviders,
    authorization: authorizationProviders,
    'proof-verifier': proofVerifiers,
    evidence: evidenceProviders,
  };
  const registry = registries[provider.type];
  if (!registry) throw new TypeError(`unsupported provider type: ${provider.type}`);
  registry.set(provider.name, provider);
  return provider;
}

export function describeProviderLifecycle(provider) {
  if (!provider) return null;
  return {
    resolve_session: typeof provider.resolveSession === 'function',
    refresh_session: typeof provider.refreshSession === 'function',
    check_revocation: typeof provider.checkRevocation === 'function',
    materialize_credentials: typeof provider.materializeCredentials === 'function',
    cleanup_session: typeof provider.cleanupSession === 'function',
  };
}

function parseAuthorizationReference(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    const error = new Error('authorization_ref must be a non-empty string');
    error.code = 'AUTHORIZATION_REF_INVALID';
    throw error;
  }
  const normalized = ref.trim();
  if (normalized.length > 2048) {
    const error = new Error('authorization_ref exceeds 2048 characters');
    error.code = 'AUTHORIZATION_REF_INVALID';
    throw error;
  }
  if (normalized.startsWith('provider://')) {
    const match = /^provider:\/\/([^/]+)\/(.+)$/.exec(normalized);
    if (!match) {
      const error = new Error('authorization_ref must use provider://<provider>/<policy-ref>');
      error.code = 'AUTHORIZATION_REF_INVALID';
      throw error;
    }
    return { providerName: decodeURIComponent(match[1]), policyRef: decodeURIComponent(match[2]) };
  }
  const separator = normalized.indexOf(':');
  if (separator <= 0 || separator === normalized.length - 1) {
    const error = new Error('authorization_ref must identify a provider as <provider>:<policy-ref> or provider://<provider>/<policy-ref>');
    error.code = 'AUTHORIZATION_REF_INVALID';
    throw error;
  }
  return {
    providerName: normalized.slice(0, separator),
    policyRef: normalized.slice(separator + 1),
  };
}

export async function resolveAuthorizationRef(ref, ctx = {}) {
  const { providerName, policyRef } = parseAuthorizationReference(ref);
  const provider = getAuthorizationProvider(providerName);
  if (!provider) {
    const error = new Error(`authorization provider not loaded: ${providerName}`);
    error.code = 'AUTHORIZATION_PROVIDER_NOT_LOADED';
    throw error;
  }
  const resolver = typeof provider.resolvePolicy === 'function'
    ? provider.resolvePolicy.bind(provider)
    : typeof provider.resolveAuthorization === 'function'
      ? provider.resolveAuthorization.bind(provider)
      : null;
  if (!resolver) {
    const error = new Error(`authorization provider ${providerName} does not implement resolvePolicy()`);
    error.code = 'AUTHORIZATION_REF_UNSUPPORTED';
    throw error;
  }
  const resolved = await resolver(policyRef, {
    ...ctx,
    ref,
    provider: providerName,
    env: ctx.env || process.env,
    cwd: ctx.cwd || process.cwd(),
  });
  const policy = resolved?.policy || resolved;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    const error = new Error(`authorization provider ${providerName} returned no policy for ${policyRef}`);
    error.code = 'AUTHORIZATION_REF_NOT_FOUND';
    throw error;
  }
  return {
    policy: {
      ...policy,
      ref: policy.ref || ref,
    },
    provider: providerName,
    ref,
  };
}

export function hasProvider(name) {
  return identityProviders.has(name)
    || authorizationProviders.has(name)
    || proofVerifiers.has(name)
    || evidenceProviders.has(name);
}

export function listProviders() {
  const result = [];
  for (const [name, p] of identityProviders) result.push({ name, type: p.type });
  for (const [name, p] of authorizationProviders) {
    result.push({
      name,
      type: p.type,
      policy_resolution: typeof p.resolvePolicy === 'function' || typeof p.resolveAuthorization === 'function',
    });
  }
  for (const [name, p] of proofVerifiers) result.push({ name, type: p.type });
  for (const [name, p] of evidenceProviders) result.push({
    name,
    type: p.type,
    lifecycle: describeProviderLifecycle(p),
  });
  return result;
}

// For testing: reset all registries
export function _resetForTesting() {
  identityProviders.clear();
  authorizationProviders.clear();
  proofVerifiers.clear();
  evidenceProviders.clear();
}
