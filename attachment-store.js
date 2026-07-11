import { createHash, randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { getDb, getResolvedDbPath } from './db.js';
import { ensureArtifactsDir, resolveArtifactsDir } from './paths.js';

const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_COUNT = 20;
const DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.csv', 'text/csv'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.zip', 'application/zip'],
]);

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function maxAttachmentBytes(opts = {}) {
  return positiveInteger(
    opts.maxBytes ?? process.env.SCHEDULER_ATTACHMENT_MAX_BYTES,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    'maxBytes'
  );
}

function assertSafeOutboxId(outboxId) {
  if (typeof outboxId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(outboxId)) {
    throw new Error('outboxId must contain only letters, numbers, periods, underscores, or hyphens');
  }
}

function safeName(value, fallback) {
  const raw = basename(String(value || fallback || 'attachment'));
  const printable = [...raw.normalize('NFKC')]
    .filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join('');
  const sanitized = printable
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (sanitized || fallback || 'attachment').slice(0, 180);
}

function inferMimeType(name) {
  return MIME_TYPES.get(extname(name).toLowerCase()) || 'application/octet-stream';
}

function normalizeAttachment(input, ordinal) {
  if (typeof input === 'string') {
    return { path: input, name: basename(input), mimeType: null, ordinal };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`attachment ${ordinal} must be an absolute path or attachment object`);
  }
  return {
    path: input.path || input.sourcePath || input.source_path,
    name: input.name || null,
    mimeType: input.mimeType || input.mime_type || null,
    ordinal,
  };
}

function readValidatedSource(sourcePath, maxBytes) {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
    throw new Error('attachment path must be absolute');
  }
  const normalized = resolve(sourcePath);
  const initialStat = lstatSync(normalized);
  if (initialStat.isSymbolicLink()) {
    throw new Error(`attachment path may not be a symbolic link: ${normalized}`);
  }
  if (!initialStat.isFile()) {
    throw new Error(`attachment path is not a regular file: ${normalized}`);
  }
  if (initialStat.size > maxBytes) {
    throw new Error(`attachment exceeds ${maxBytes} byte limit: ${normalized}`);
  }

  const noFollow = constants.O_NOFOLLOW || 0;
  const fd = openSync(normalized, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`attachment changed before it could be read: ${normalized}`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`attachment exceeds ${maxBytes} byte limit: ${normalized}`);
    }
    const content = readFileSync(fd);
    if (content.length !== stat.size) {
      throw new Error(`attachment changed while it was being read: ${normalized}`);
    }
    return { normalized, content };
  } finally {
    closeSync(fd);
  }
}

function artifactsRoot(opts = {}) {
  return resolve(
    opts.artifactsDir
      || resolveArtifactsDir({
        dbPath: opts.dbPath || opts.db?.name || getResolvedDbPath(),
        env: process.env,
      })
  );
}

function isWithinRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function writeAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, content, { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (err) {
    try { unlinkSync(tempPath); } catch {}
    throw err;
  }
}

export function stageDeliveryAttachments(outboxId, attachmentInputs = [], opts = {}) {
  assertSafeOutboxId(outboxId);
  if (!Array.isArray(attachmentInputs)) {
    throw new Error('attachments must be an array');
  }
  if (attachmentInputs.length === 0) return [];

  const maxBytes = maxAttachmentBytes(opts);
  const maxCount = positiveInteger(
    opts.maxCount ?? process.env.SCHEDULER_ATTACHMENT_MAX_COUNT,
    DEFAULT_MAX_ATTACHMENT_COUNT,
    'maxCount'
  );
  const maxTotalBytes = positiveInteger(
    opts.maxTotalBytes ?? process.env.SCHEDULER_ATTACHMENT_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
    'maxTotalBytes'
  );
  if (attachmentInputs.length > maxCount) {
    throw new Error(`attachment count exceeds ${maxCount} file limit`);
  }
  const root = artifactsRoot(opts);
  const deliveryDir = resolve(root, 'deliveries', outboxId);
  if (!isWithinRoot(root, deliveryDir) || deliveryDir === root) {
    throw new Error('delivery artifact directory escapes the configured artifacts root');
  }
  const staged = [];
  let totalBytes = 0;

  for (const [ordinal, rawInput] of attachmentInputs.entries()) {
    const input = normalizeAttachment(rawInput, ordinal);
    const { normalized, content } = readValidatedSource(input.path, maxBytes);
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`attachments exceed ${maxTotalBytes} byte combined limit`);
    }
    const hash = createHash('sha256').update(content).digest('hex');
    const name = safeName(input.name, basename(normalized));
    const fileName = `${String(ordinal).padStart(3, '0')}-${hash.slice(0, 12)}-${name}`;
    const artifactPath = resolve(deliveryDir, fileName);
    if (!isWithinRoot(deliveryDir, artifactPath)) {
      throw new Error(`attachment name escapes delivery artifact directory: ${name}`);
    }
    staged.push({
      id: randomUUID(),
      outbox_id: outboxId,
      ordinal,
      name,
      mime_type: input.mimeType || inferMimeType(name),
      source_path: artifactPath,
      content_blob: content,
      size_bytes: content.length,
      sha256: hash,
    });
  }
  if (opts.persistFiles !== false) persistStagedAttachments(staged, opts);
  return staged;
}

export function persistStagedAttachments(staged = [], opts = {}) {
  if (!Array.isArray(staged)) throw new Error('staged attachments must be an array');
  if (staged.length === 0) return [];
  const root = artifactsRoot(opts);
  const deliveriesRoot = resolve(root, 'deliveries');
  const persisted = [];

  try {
    for (const attachment of staged) {
      if (!attachment?.source_path || !isAbsolute(attachment.source_path)) {
        throw new Error('staged attachment source_path must be absolute');
      }
      const targetPath = resolve(attachment.source_path);
      assertSafeOutboxId(attachment.outbox_id);
      const expectedDeliveryDir = resolve(deliveriesRoot, attachment.outbox_id);
      if (
        !isWithinRoot(expectedDeliveryDir, targetPath)
        || targetPath === expectedDeliveryDir
        || !isWithinRoot(root, targetPath)
      ) {
        throw new Error('staged attachment path escapes the configured artifacts root');
      }
      const content = Buffer.isBuffer(attachment.content_blob)
        ? attachment.content_blob
        : Buffer.from(attachment.content_blob || []);
      if (content.length !== attachment.size_bytes) {
        throw new Error(`staged attachment ${attachment.name || attachment.id || 'unknown'} size check failed`);
      }
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== attachment.sha256) {
        throw new Error(`staged attachment ${attachment.name || attachment.id || 'unknown'} hash check failed`);
      }
      const deliveryDir = ensureArtifactsDir(dirname(targetPath));
      chmodSync(deliveryDir, 0o700);
      writeAtomic(targetPath, content);
      persisted.push(attachment);
    }
    return persisted;
  } catch (err) {
    cleanupStagedAttachments(persisted, opts);
    throw err;
  }
}

export function insertStagedAttachments(db, outboxId, messageId, staged = []) {
  if (!db || typeof db.prepare !== 'function') throw new Error('db is required');
  assertSafeOutboxId(outboxId);
  const insert = db.prepare(`
    INSERT INTO delivery_attachments (
      id, outbox_id, message_id, ordinal, name, mime_type,
      source_path, content_blob, size_bytes, sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const attachment of staged) {
    insert.run(
      attachment.id,
      outboxId,
      messageId || null,
      attachment.ordinal,
      attachment.name,
      attachment.mime_type,
      attachment.source_path,
      attachment.content_blob,
      attachment.size_bytes,
      attachment.sha256
    );
  }
}

export function cleanupStagedAttachments(staged = [], opts = {}) {
  const root = artifactsRoot(opts);
  const deliveriesRoot = resolve(root, 'deliveries');
  const parentDirs = new Set();
  for (const attachment of staged) {
    if (!attachment?.source_path || !isAbsolute(attachment.source_path)) continue;
    try {
      assertSafeOutboxId(attachment.outbox_id);
      const expectedDeliveryDir = resolve(deliveriesRoot, attachment.outbox_id);
      const sourcePath = resolve(attachment.source_path);
      if (!isWithinRoot(expectedDeliveryDir, sourcePath) || sourcePath === expectedDeliveryDir) continue;
      try { unlinkSync(sourcePath); } catch {}
      parentDirs.add(dirname(sourcePath));
    } catch {}
  }
  for (const dir of parentDirs) {
    try { rmdirSync(dir); } catch {}
  }
}

export function cleanupDeliveryAttachmentMaterial(outboxIds = [], attachments = [], opts = {}) {
  if (!Array.isArray(outboxIds)) throw new Error('outboxIds must be an array');
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  const root = artifactsRoot(opts);
  const deliveriesRoot = resolve(root, 'deliveries');
  let filesRemoved = 0;
  let directoriesRemoved = 0;
  let skippedUnsafePaths = 0;

  for (const attachment of attachments) {
    if (!attachment?.source_path || !isAbsolute(attachment.source_path)) continue;
    try {
      assertSafeOutboxId(attachment.outbox_id);
    } catch {
      skippedUnsafePaths += 1;
      continue;
    }
    const sourcePath = resolve(attachment.source_path);
    const expectedDeliveryDir = resolve(deliveriesRoot, attachment.outbox_id);
    if (
      !isWithinRoot(expectedDeliveryDir, sourcePath)
      || sourcePath === expectedDeliveryDir
      || !isWithinRoot(root, sourcePath)
    ) {
      skippedUnsafePaths += 1;
      continue;
    }
    try {
      const stat = lstatSync(sourcePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(`refusing to remove attachment directory as a file: ${sourcePath}`);
      }
      unlinkSync(sourcePath);
      filesRemoved += 1;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  for (const outboxId of new Set(outboxIds)) {
    assertSafeOutboxId(outboxId);
    const deliveryDir = resolve(deliveriesRoot, outboxId);
    if (!isWithinRoot(deliveriesRoot, deliveryDir) || deliveryDir === deliveriesRoot) {
      throw new Error('delivery cleanup path escapes the delivery artifacts root');
    }
    try {
      lstatSync(deliveryDir);
      rmSync(deliveryDir, { recursive: true, force: true });
      directoriesRemoved += 1;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  try { rmdirSync(deliveriesRoot); } catch {}
  return { filesRemoved, directoriesRemoved, skippedUnsafePaths };
}

export function listDeliveryAttachments(outboxId, opts = {}) {
  const db = opts.db || getDb();
  const columns = opts.includeContent
    ? '*'
    : `id, outbox_id, message_id, ordinal, name, mime_type,
       source_path, size_bytes, sha256, created_at`;
  return db.prepare(`
    SELECT ${columns}
    FROM delivery_attachments
    WHERE outbox_id = ?
    ORDER BY ordinal ASC
  `).all(outboxId);
}

export function verifyDeliveryAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('attachment record is required');
  }
  if (!attachment.source_path || !isAbsolute(attachment.source_path)) return false;
  try {
    const stat = lstatSync(attachment.source_path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== attachment.size_bytes) return false;
    const content = readFileSync(attachment.source_path);
    const hash = createHash('sha256').update(content).digest('hex');
    return hash === attachment.sha256;
  } catch {
    return false;
  }
}

export function materializeDeliveryAttachment(attachment, opts = {}) {
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('attachment record is required');
  }
  if (verifyDeliveryAttachment(attachment)) return attachment.source_path;

  const storedContent = attachment.content_blob ?? (
    attachment.id
      ? (opts.db || getDb()).prepare(
        'SELECT content_blob FROM delivery_attachments WHERE id = ?'
      ).get(attachment.id)?.content_blob
      : null
  );
  const content = Buffer.isBuffer(storedContent)
    ? storedContent
    : storedContent == null
      ? null
      : Buffer.from(storedContent);
  if (!content) {
    throw new Error(`attachment ${attachment.id || attachment.name || 'unknown'} has no recoverable content`);
  }
  if (content.length !== attachment.size_bytes) {
    throw new Error(`attachment ${attachment.id || attachment.name || 'unknown'} size check failed`);
  }
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== attachment.sha256) {
    throw new Error(`attachment ${attachment.id || attachment.name || 'unknown'} hash check failed`);
  }

  const root = artifactsRoot(opts);
  const outboxId = String(attachment.outbox_id || 'recovered').replace(/[^A-Za-z0-9._-]/g, '_');
  const deliveryDir = ensureArtifactsDir(join(root, 'deliveries', outboxId));
  chmodSync(deliveryDir, 0o700);
  const preferredPath = attachment.source_path ? resolve(attachment.source_path) : null;
  const fallbackName = `${String(attachment.ordinal ?? 0).padStart(3, '0')}-${hash.slice(0, 12)}-${safeName(attachment.name, 'attachment')}`;
  const targetPath = preferredPath && isWithinRoot(deliveryDir, preferredPath)
    ? preferredPath
    : resolve(deliveryDir, fallbackName);
  writeAtomic(targetPath, content);
  return targetPath;
}

export {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_ATTACHMENT_COUNT,
  DEFAULT_MAX_TOTAL_ATTACHMENT_BYTES,
};
