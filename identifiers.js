import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_AGENT_ID_LENGTH = 128;
export const MAX_SESSION_KEY_LENGTH = 512;
export const MAX_SESSION_ID_LENGTH = 255;

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._@-]*$/i;
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const SESSION_KEY_PATH_OR_URL_PATTERN = /[\\/?#]/u;

function containsControlCharacter(value) {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function lengthError(name, maxLength) {
  return `${name} must contain between 1 and ${maxLength} characters`;
}

export function assertValidAgentId(value, name = 'agent_id') {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (value.length === 0 || value.length > MAX_AGENT_ID_LENGTH) {
    throw new Error(lengthError(name, MAX_AGENT_ID_LENGTH));
  }
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new Error(
      `${name} must start with a letter or number and contain only letters, numbers, dots, underscores, at-signs, or hyphens`,
    );
  }
  return value;
}

export function assertValidSessionKey(value, name = 'session_key') {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (value.length === 0 || value.length > MAX_SESSION_KEY_LENGTH) {
    throw new Error(lengthError(name, MAX_SESSION_KEY_LENGTH));
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`);
  }
  if (/\s/u.test(value)) {
    throw new Error(`${name} must not contain whitespace`);
  }
  if (containsControlCharacter(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  if (SESSION_KEY_PATH_OR_URL_PATTERN.test(value)) {
    throw new Error(`${name} must not contain path separators, query delimiters, or fragment delimiters`);
  }

  const segments = value.split(':');
  if (segments.some(segment => segment.length === 0)) {
    throw new Error(`${name} must not contain empty colon-delimited segments`);
  }
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`${name} must not contain dot path segments`);
  }
  if (segments.length > 1 && segments[0].toLowerCase() === 'agent' && segments[0] !== 'agent') {
    throw new Error(`${name} must use the lowercase agent: prefix`);
  }
  if (segments[0] === 'agent') {
    if (segments.length < 3) {
      throw new Error(`${name} uses a malformed agent session key`);
    }
    assertValidAgentId(segments[1], `${name} agent id`);
  }
  return value;
}

export function assertValidSessionId(value, name = 'session_id') {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) {
    throw new Error(lengthError(name, MAX_SESSION_ID_LENGTH));
  }
  if (!SESSION_ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(
      `${name} must be one filename-safe segment containing only letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return value;
}

export function assertValidSessionStore(store, name = 'sessions store') {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  for (const [sessionKey, entry] of Object.entries(store)) {
    assertValidSessionKey(sessionKey, `${name} session key`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${name} entry for ${JSON.stringify(sessionKey)} must be an object`);
    }
    if (entry.sessionId !== null && entry.sessionId !== undefined) {
      assertValidSessionId(entry.sessionId, `${name} sessionId for ${JSON.stringify(sessionKey)}`);
    }
  }
  return store;
}

export function agentIdFromSessionKey(sessionKey, fallbackAgentId = 'main', name = 'session_key') {
  const validatedKey = assertValidSessionKey(sessionKey, name);
  if (validatedKey.startsWith('agent:')) {
    return assertValidAgentId(validatedKey.split(':', 3)[1], `${name} agent id`);
  }
  return assertValidAgentId(fallbackAgentId, 'fallback agent_id');
}

export function assertSessionKeyForAgent(sessionKey, agentId, name = 'session_key') {
  const validatedAgentId = assertValidAgentId(agentId, 'agent_id');
  const validatedSessionKey = assertValidSessionKey(sessionKey, name);
  if (validatedSessionKey.startsWith('agent:')) {
    const keyAgent = agentIdFromSessionKey(validatedSessionKey, validatedAgentId, name);
    if (keyAgent !== validatedAgentId) {
      throw new Error(
        `${name} agent ${JSON.stringify(keyAgent)} does not match agent_id ${JSON.stringify(validatedAgentId)}`,
      );
    }
  }
  return validatedSessionKey;
}

function isWithinPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

function canonicalizeWithMissingTail(inputPath) {
  let cursor = resolve(inputPath);
  const missing = [];

  while (true) {
    try {
      const canonicalParent = realpathSync(cursor);
      return resolve(canonicalParent, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function assertContainedPath(root, candidate, name = 'path') {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  if (!isWithinPath(lexicalRoot, lexicalCandidate)) {
    throw new Error(`${name} escapes its allowed root`);
  }

  const canonicalRoot = canonicalizeWithMissingTail(lexicalRoot);
  const canonicalCandidate = canonicalizeWithMissingTail(lexicalCandidate);
  if (!isWithinPath(canonicalRoot, canonicalCandidate)) {
    throw new Error(`${name} escapes its allowed root through a symbolic link`);
  }
  return lexicalCandidate;
}

export function resolveAgentSessionsDirectory(homeDir, agentId = 'main') {
  const validatedAgentId = assertValidAgentId(agentId);
  const agentsRoot = resolve(homeDir, '.openclaw', 'agents');
  const sessionsDirectory = resolve(agentsRoot, validatedAgentId, 'sessions');
  return assertContainedPath(agentsRoot, sessionsDirectory, 'agent sessions directory');
}

export function resolveAgentSessionsStorePath(homeDir, agentId = 'main') {
  const sessionsDirectory = resolveAgentSessionsDirectory(homeDir, agentId);
  const sessionsPath = resolve(sessionsDirectory, 'sessions.json');
  return assertContainedPath(sessionsDirectory, sessionsPath, 'sessions store path');
}

export function resolveSessionTranscriptPath(homeDir, agentId, sessionId) {
  const sessionsDirectory = resolveAgentSessionsDirectory(homeDir, agentId);
  const validatedSessionId = assertValidSessionId(sessionId);
  const transcriptPath = resolve(sessionsDirectory, `${validatedSessionId}.jsonl`);
  return assertContainedPath(sessionsDirectory, transcriptPath, 'session transcript path');
}

export function parseGatewayBaseUrl(value, name = 'OPENCLAW_GATEWAY_URL') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value !== value.trim() || value.includes('\\') || containsControlCharacter(value)) {
    throw new Error(`${name} must not contain whitespace, control characters, or backslashes`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use the http: or https: protocol`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain a username or password`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain a query string or fragment`);
  }

  const normalizedPath = `${parsed.pathname.replace(/\/+$/, '')}/`;
  parsed.pathname = normalizedPath.replaceAll("'", '%27');
  return parsed;
}

export function buildGatewayEndpointUrl(baseUrl, endpoint) {
  const parsedBase = baseUrl instanceof URL
    ? parseGatewayBaseUrl(baseUrl.href, 'gateway base URL')
    : parseGatewayBaseUrl(baseUrl, 'gateway base URL');
  if (
    typeof endpoint !== 'string'
    || endpoint.length === 0
    || endpoint.startsWith('/')
    || Array.from(endpoint).some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 32 || codePoint === 127 || '\\?#%'.includes(character);
    })
    || endpoint.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('gateway endpoint must be a non-empty relative path');
  }
  return new URL(endpoint, parsedBase).href;
}

export function buildGatewaySessionUrl(baseUrl, sessionKey) {
  const encodedSessionKey = encodeURIComponent(assertValidSessionKey(sessionKey));
  const parsedBase = baseUrl instanceof URL
    ? parseGatewayBaseUrl(baseUrl.href, 'gateway base URL')
    : parseGatewayBaseUrl(baseUrl, 'gateway base URL');
  return new URL(`sessions/${encodedSessionKey}`, parsedBase).href;
}
