import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { getDb } from './db.js';
import { resolveSchedulerHome } from './paths.js';
import { sha256 } from './handoff-artifact.js';

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}
import { appendRuntimeEvent } from './runtime-events.js';

const SUPPORTED_MEDIA = new Set(['env', 'temp-file', 'stdin', 'gateway-env-header']);

function credentialError(code, message, details = null) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function ensurePrivateDirectory(path) {
  // SCHEDULER_HOME is an operator-owned local process setting. The directory
  // remains intentionally configurable and is checked for type, symlinks, and
  // private permissions immediately after creation.
  // lgtm[js/path-injection]
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // lgtm[js/path-injection]
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw credentialError('CREDENTIAL_DIRECTORY_UNSAFE', 'Credential runtime path must be a directory');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw credentialError(
      'CREDENTIAL_DIRECTORY_UNSAFE',
      `Credential runtime directory permissions must be 0700, got 0${(stat.mode & 0o777).toString(8)}`,
    );
  }
  return realpathSync(path);
}

function controlledPath(root, candidate) {
  const resolved = resolve(candidate);
  return resolved.startsWith(`${root}${sep}`) && basename(resolved) !== '';
}

function allocateCredentialPath(root, name) {
  const safeName = String(name || 'credential').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const path = join(root, `${safeName}-${randomUUID()}`);
  if (!controlledPath(root, path)) {
    throw credentialError('CREDENTIAL_PATH_UNSAFE', 'Credential file escaped runtime directory');
  }
  return path;
}

function writeCredentialFile(root, path, value) {
  if (!controlledPath(root, path)) {
    throw credentialError('CREDENTIAL_PATH_UNSAFE', 'Credential file escaped runtime directory');
  }
  let fd;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, value);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    try { unlinkSync(path); } catch { /* best effort after failed validation */ }
    throw credentialError('CREDENTIAL_FILE_UNSAFE', 'Credential file is not a regular file');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    try { unlinkSync(path); } catch { /* best effort after failed validation */ }
    throw credentialError('CREDENTIAL_FILE_UNSAFE', 'Credential file permissions must be 0600');
  }
  return path;
}

function validateMedium(medium, sessionTarget) {
  if (!SUPPORTED_MEDIA.has(medium)) {
    throw credentialError('CREDENTIAL_MEDIUM_UNSUPPORTED', `Unsupported credential medium: ${medium}`);
  }
  if (sessionTarget === 'main') {
    throw credentialError(
      'CREDENTIAL_MAIN_SESSION_REFUSED',
      'Credential materialization is not allowed for main-session jobs',
    );
  }
  if (sessionTarget === 'isolated' && medium !== 'gateway-env-header') {
    throw credentialError(
      'CREDENTIAL_MEDIUM_UNSUPPORTED',
      'Isolated jobs require gateway-env-header credential presentation',
    );
  }
  if (sessionTarget === 'shell' && medium === 'gateway-env-header') {
    throw credentialError(
      'CREDENTIAL_MEDIUM_UNSUPPORTED',
      'Shell jobs cannot use gateway-env-header credential presentation',
    );
  }
}

function normalizedDeclaredBindings(presentation, medium) {
  if (!Array.isArray(presentation?.bindings)) {
    throw credentialError(
      'CREDENTIAL_BINDING_INVALID',
      'Artifact credential presentation must declare an exact bindings array',
    );
  }
  const declared = new Map();
  const declaredEnvKeys = new Set();
  for (const [index, binding] of presentation.bindings.entries()) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Declared credential binding ${index} must be an object`,
      );
    }
    const name = binding.name;
    if (typeof name !== 'string' || name.length === 0 || declared.has(name)) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Declared credential binding ${index} must have a unique non-empty name`,
      );
    }
    const bindingMedium = binding.medium ?? medium;
    if (bindingMedium !== 'none' && bindingMedium !== medium) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Declared credential binding ${name} medium does not match the negotiated presentation`,
      );
    }
    const envKey = binding.env_key ?? null;
    if (bindingMedium !== 'none' && envKey != null) {
      if (declaredEnvKeys.has(envKey)) {
        throw credentialError(
          'CREDENTIAL_BINDING_INVALID',
          `Declared credential binding ${name} collides on environment key ${envKey}`,
        );
      }
      declaredEnvKeys.add(envKey);
    }
    declared.set(name, {
      name,
      medium: bindingMedium,
      envKey,
      fileName: binding.file_name ?? null,
      required: binding.required !== false,
    });
  }
  return declared;
}

function validateProviderBindings(bindings, presentation, medium) {
  const declared = normalizedDeclaredBindings(presentation, medium);
  const returned = new Set();
  for (const [index, binding] of bindings.entries()) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw credentialError('CREDENTIAL_BINDING_INVALID', `Binding ${index} must be an object`);
    }
    const name = binding.name;
    if (typeof name !== 'string' || name.length === 0 || returned.has(name)) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider binding ${index} must have a unique non-empty declared name`,
      );
    }
    returned.add(name);
    const expected = declared.get(name);
    if (!expected || expected.medium === 'none') {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider returned undeclared credential binding ${name}`,
      );
    }
    const bindingMedium = binding.medium ?? medium;
    const envKey = binding.key ?? binding.env_key ?? null;
    const fileName = binding.file_name ?? null;
    if (bindingMedium !== expected.medium) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider binding ${name} medium does not match the artifact declaration`,
      );
    }
    if (envKey !== expected.envKey) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider binding ${name} environment key does not match the artifact declaration`,
      );
    }
    if (fileName !== expected.fileName) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider binding ${name} file name does not match the artifact declaration`,
      );
    }
  }
  for (const expected of declared.values()) {
    if (expected.medium !== 'none' && expected.required && !returned.has(expected.name)) {
      throw credentialError(
        'CREDENTIAL_BINDING_INVALID',
        `Provider omitted required credential binding ${expected.name}`,
      );
    }
  }
}

function insertPresentation(db, values) {
  db.prepare(`
    INSERT INTO credential_presentations (
      id, run_id, handoff_artifact_digest, provider_session_id,
      binding_name, medium, env_key, temp_path, stdin_sha256,
      value_sha256, file_mode, status, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'materialized', ?)
  `).run(
    values.id,
    values.runId,
    values.artifactDigest,
    values.providerSessionId ?? null,
    values.name,
    values.medium,
    values.envKey ?? null,
    values.tempPath ?? null,
    values.stdinSha256 ?? null,
    values.valueSha256,
    values.fileMode ?? null,
    values.expiresAt ?? null,
  );
}

export async function materializeCredentials(
  provider,
  providerSession,
  presentation,
  ctx = {},
  opts = {},
) {
  if (typeof provider?.materializeCredentials !== 'function') {
    throw credentialError(
      'CREDENTIAL_MATERIALIZATION_UNSUPPORTED',
      `Provider ${provider?.name || '(unknown)'} does not implement materializeCredentials()`,
    );
  }
  if (!ctx.runId || !ctx.artifactDigest) {
    throw new TypeError('runId and artifactDigest are required for credential materialization');
  }
  const db = opts.db || getDb();
  const medium = presentation?.handoff;
  validateMedium(medium, ctx.sessionTarget);
  normalizedDeclaredBindings(presentation, medium);
  let response;
  try {
    response = await provider.materializeCredentials(
      providerSession.session ?? providerSession,
      presentation,
      ctx,
    );
  } catch (error) {
    throw credentialError(
      'CREDENTIAL_MATERIALIZATION_FAILED',
      `Provider ${provider.name} credential materialization failed: ${error.message}`,
      { transient: error.transient === true },
    );
  }
  if (response?.ok === false) {
    throw credentialError(
      response.code || 'CREDENTIAL_MATERIALIZATION_FAILED',
      response.error || response.reason || 'Credential provider refused materialization',
      { transient: response.transient === true },
    );
  }
  const bindings = response?.bindings;
  if (!Array.isArray(bindings)) {
    throw credentialError(
      'CREDENTIAL_MATERIALIZATION_FAILED',
      'Credential provider returned an invalid bindings result',
    );
  }
  validateProviderBindings(bindings, presentation, medium);

  const runtimeRoot = ensurePrivateDirectory(
    join(resolveSchedulerHome(), 'credentials'),
  );
  const materialization = {
    env: {},
    gatewayEnv: {},
    stdin: null,
    presentationIds: [],
    tempPaths: [],
    runtimeRoot,
  };

  try {
    for (const [index, binding] of bindings.entries()) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
        throw credentialError('CREDENTIAL_BINDING_INVALID', `Binding ${index} must be an object`);
      }
      const bindingMedium = binding.medium ?? medium;
      validateMedium(bindingMedium, ctx.sessionTarget);
      if (bindingMedium !== medium) {
        throw credentialError(
          'CREDENTIAL_BINDING_INVALID',
          `Binding ${index} medium does not match negotiated presentation`,
        );
      }
      const name = binding.name;
      const valueBuffer = Buffer.isBuffer(binding.value)
        ? Buffer.from(binding.value)
        : Buffer.from(String(binding.value ?? ''), 'utf8');
      if (valueBuffer.length === 0) {
        throw credentialError('CREDENTIAL_BINDING_INVALID', `Binding ${name} has no value`);
      }
      const id = randomUUID();
      const valueHash = sha256Bytes(valueBuffer);
      const envKey = binding.key ?? binding.env_key ?? null;
      let tempPath = null;
      let stdinSha256 = null;
      let presentationInserted = false;

      if (bindingMedium === 'env' || bindingMedium === 'gateway-env-header') {
        if (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
          throw credentialError('CREDENTIAL_BINDING_INVALID', `Binding ${name} has invalid env key`);
        }
        const value = valueBuffer.toString('utf8');
        if (bindingMedium === 'env') materialization.env[envKey] = value;
        else materialization.gatewayEnv[envKey] = value;
      } else if (bindingMedium === 'temp-file') {
        if (typeof envKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
          throw credentialError(
            'CREDENTIAL_BINDING_INVALID',
            `Temp-file binding ${name} requires an env key for its path`,
          );
        }
        tempPath = allocateCredentialPath(runtimeRoot, binding.file_name || name);
        insertPresentation(db, {
          id,
          runId: ctx.runId,
          artifactDigest: ctx.artifactDigest,
          providerSessionId: providerSession.row?.id ?? providerSession.id ?? null,
          name,
          medium: bindingMedium,
          envKey,
          tempPath,
          stdinSha256,
          valueSha256: valueHash,
          fileMode: '0600',
          expiresAt: binding.expires_at ?? response.expires_at ?? null,
        });
        materialization.presentationIds.push(id);
        presentationInserted = true;
        if (typeof opts.onPresentationPersisted === 'function') {
          opts.onPresentationPersisted({ id, tempPath, valueSha256: valueHash });
        }
        writeCredentialFile(runtimeRoot, tempPath, valueBuffer);
        if (typeof opts.onCredentialFileWritten === 'function') {
          opts.onCredentialFileWritten({ id, tempPath, valueSha256: valueHash });
        }
        materialization.tempPaths.push(tempPath);
        materialization.env[envKey] = tempPath;
      } else if (bindingMedium === 'stdin') {
        if (materialization.stdin !== null) {
          throw credentialError(
            'CREDENTIAL_BINDING_INVALID',
            'Only one stdin credential binding is allowed',
          );
        }
        materialization.stdin = valueBuffer;
        stdinSha256 = valueHash;
      }

      if (!presentationInserted) {
        insertPresentation(db, {
          id,
          runId: ctx.runId,
          artifactDigest: ctx.artifactDigest,
          providerSessionId: providerSession.row?.id ?? providerSession.id ?? null,
          name,
          medium: bindingMedium,
          envKey,
          tempPath,
          stdinSha256,
          valueSha256: valueHash,
          fileMode: tempPath ? '0600' : null,
          expiresAt: binding.expires_at ?? response.expires_at ?? null,
        });
        materialization.presentationIds.push(id);
      }
      if (bindingMedium !== 'stdin') valueBuffer.fill(0);
    }

    appendRuntimeEvent('credential.materialized', {
      jobId: ctx.jobId,
      runId: ctx.runId,
      handoffArtifactDigest: ctx.artifactDigest,
      payload: {
        provider: provider.name,
        presentation_ids: materialization.presentationIds,
        media: bindings.map(binding => binding.medium ?? medium),
      },
    }, { db });
    return materialization;
  } catch (error) {
    try {
      await cleanupCredentialMaterialization(materialization, ctx, { db });
    } catch (cleanupError) {
      if (error && typeof error === 'object') {
        Object.defineProperty(error, 'cleanupError', {
          value: cleanupError,
          configurable: true,
          enumerable: false,
        });
      } else {
        throw new AggregateError(
          [error, cleanupError],
          'Credential materialization failed and cleanup did not complete',
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

export async function cleanupCredentialMaterialization(materialization, ctx = {}, opts = {}) {
  const db = opts.db || getDb();
  const root = materialization?.runtimeRoot
    ? resolve(materialization.runtimeRoot)
    : ensurePrivateDirectory(
        join(resolveSchedulerHome(), 'credentials'),
      );
  const ids = new Set(materialization?.presentationIds ?? []);
  if (ctx.runId) {
    for (const row of db.prepare(`
      SELECT id FROM credential_presentations
      WHERE run_id = ? AND status IN ('materialized', 'failed')
    `).all(ctx.runId)) ids.add(row.id);
  }

  const failures = [];
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM credential_presentations WHERE id = ?').get(id);
    if (!row || !['materialized', 'failed'].includes(row.status)) continue;
    try {
      if (row.temp_path) {
        if (!controlledPath(root, row.temp_path)) {
          throw credentialError(
            'CREDENTIAL_PATH_UNSAFE',
            'Refusing to clean credential path outside runtime directory',
          );
        }
        if (existsSync(row.temp_path)) unlinkSync(row.temp_path);
      }
      db.prepare(`
        UPDATE credential_presentations
        SET status = 'cleaned', cleaned_at = datetime('now'), last_error = NULL
        WHERE id = ? AND status IN ('materialized', 'failed')
      `).run(id);
    } catch (error) {
      failures.push({ id, error: error.message });
      db.prepare(`
        UPDATE credential_presentations SET status = 'failed', last_error = ?
        WHERE id = ? AND status IN ('materialized', 'failed')
      `).run(error.message, id);
    }
  }

  for (const tempPath of materialization?.tempPaths ?? []) {
    try {
      if (!controlledPath(root, tempPath)) {
        throw credentialError('CREDENTIAL_PATH_UNSAFE', 'Refusing untracked cleanup outside runtime directory');
      }
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch (error) {
      failures.push({ id: null, error: error.message });
    }
  }

  if (Buffer.isBuffer(materialization?.stdin)) materialization.stdin.fill(0);
  if (materialization) {
    materialization.stdin = null;
    materialization.env = {};
    materialization.gatewayEnv = {};
    materialization.tempPaths = [];
  }

  appendRuntimeEvent('credential.cleaned', {
    jobId: ctx.jobId,
    runId: ctx.runId,
    handoffArtifactDigest: ctx.artifactDigest,
    payload: { presentation_ids: [...ids], failures },
  }, { db });
  if (failures.length) {
    throw credentialError(
      'CREDENTIAL_CLEANUP_FAILED',
      `Credential cleanup failed for ${failures.length} binding(s)`,
      { failures },
    );
  }
  return { ok: true, cleaned: ids.size };
}

export function recoverCredentialPresentations(opts = {}) {
  const db = opts.db || getDb();
  const root = ensurePrivateDirectory(
    join(resolveSchedulerHome(), 'credentials'),
  );
  const rows = db.prepare(`
    SELECT * FROM credential_presentations WHERE status IN ('materialized', 'failed')
  `).all();
  const recovered = [];
  const failed = [];

  for (const row of rows) {
    try {
      if (row.temp_path) {
        if (!controlledPath(root, row.temp_path)) {
          throw credentialError(
            'CREDENTIAL_PATH_UNSAFE',
            'Refusing recovery cleanup outside credential runtime directory',
          );
        }
        if (existsSync(row.temp_path)) unlinkSync(row.temp_path);
      }
      db.prepare(`
        UPDATE credential_presentations
        SET status = 'recovery_cleaned', cleaned_at = datetime('now'), last_error = NULL
        WHERE id = ? AND status IN ('materialized', 'failed')
      `).run(row.id);
      recovered.push(row.id);
      appendRuntimeEvent('credential.recovery_cleaned', {
        runId: row.run_id,
        handoffArtifactDigest: row.handoff_artifact_digest,
        payload: { presentation_id: row.id },
      }, { db });
    } catch (error) {
      failed.push({ id: row.id, error: error.message });
      db.prepare(`
        UPDATE credential_presentations SET status = 'failed', last_error = ?
        WHERE id = ? AND status IN ('materialized', 'failed')
      `).run(error.message, row.id);
    }
  }
  return { recovered, failed };
}

export function listCredentialPresentations(filter = {}, opts = {}) {
  const db = opts.db || getDb();
  const rows = filter.runId
    ? db.prepare(`
        SELECT * FROM credential_presentations WHERE run_id = ? ORDER BY created_at, id
      `).all(filter.runId)
    : db.prepare(`
        SELECT * FROM credential_presentations ORDER BY created_at DESC, id DESC
      `).all();
  return rows.map(row => ({
    ...row,
    temp_path: row.temp_path
      ? { basename: basename(row.temp_path), sha256: sha256(row.temp_path) }
      : null,
  }));
}
