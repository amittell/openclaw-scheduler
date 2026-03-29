import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identityProviders = new Map();
const authorizationProviders = new Map();
const proofVerifiers = new Map();

export async function loadProviders(dirPath) {
  if (!dirPath) return;
  const absPath = resolve(dirPath);
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
      } else {
        console.warn(`[provider-registry] Skipping ${file}: unknown type "${provider.type}"`);
      }
    } catch (err) {
      console.error(`[provider-registry] Failed to load ${file}: ${err.message}`);
    }
  }

  const total = identityProviders.size + authorizationProviders.size + proofVerifiers.size;
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

export function hasProvider(name) {
  return identityProviders.has(name) || authorizationProviders.has(name) || proofVerifiers.has(name);
}

export function listProviders() {
  const result = [];
  for (const [name, p] of identityProviders) result.push({ name, type: p.type });
  for (const [name, p] of authorizationProviders) result.push({ name, type: p.type });
  for (const [name, p] of proofVerifiers) result.push({ name, type: p.type });
  return result;
}

// For testing: reset all registries
export function _resetForTesting() {
  identityProviders.clear();
  authorizationProviders.clear();
  proofVerifiers.clear();
}
