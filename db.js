// Database layer — SQLite via better-sqlite3
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB_PATH = join(__dirname, 'scheduler.db');

let _db;
let _dbPath;

/**
 * Override the DB path at runtime (must be called before getDb/initDb).
 * Pass ':memory:' for in-memory test databases.
 */
export function setDbPath(path) {
  if (_db) { _db.close(); _db = null; }
  _dbPath = path;
}

export function getDb() {
  if (!_db) {
    const dbPath = _dbPath || process.env.SCHEDULER_DB || DEFAULT_DB_PATH;
    _db = new Database(dbPath);
    if (dbPath !== ':memory:') _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export async function initDb() {
  const db = getDb();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Legacy inline migrations (v2→v3 era) — kept for backwards compat
  const legacyMigrations = [
    `ALTER TABLE jobs ADD COLUMN payload_scope TEXT NOT NULL DEFAULT 'own'`,
    `ALTER TABLE jobs ADD COLUMN resource_pool TEXT DEFAULT NULL`,
    `ALTER TABLE jobs ADD COLUMN trigger_condition TEXT DEFAULT NULL`,
  ];
  for (const sql of legacyMigrations) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }

  // Run versioned migrations (v5+) — each checks its own version guard
  try {
    const { default: migrateV5 } = await import('./migrate-v5.js');
    const applied5 = migrateV5();
    if (applied5) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] Applied migration v5\n`);
    }
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] migrate-v5 error: ${err.message}\n`);
  }

  try {
    const { default: migrateV6 } = await import('./migrate-v6.js');
    const applied6 = migrateV6();
    if (applied6) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] Applied migration v6\n`);
    }
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] migrate-v6 error: ${err.message}\n`);
  }

  try {
    const { default: migrateV7 } = await import('./migrate-v7.js');
    const applied7 = migrateV7();
    if (applied7) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] Applied migration v7\n`);
    }
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] migrate-v7 error: ${err.message}\n`);
  }

  try {
    const { default: migrateV8 } = await import('./migrate-v8.js');
    const applied8 = migrateV8();
    if (applied8) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] Applied migration v8\n`);
    }
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] migrate-v8 error: ${err.message}\n`);
  }

  try {
    const { default: migrateV9 } = await import('./migrate-v9.js');
    const applied9 = migrateV9();
    if (applied9) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] Applied migration v9\n`);
    }
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] migrate-v9 error: ${err.message}\n`);
  }

  return db;
}

/**
 * Checkpoint WAL to main DB file. Call periodically to minimize
 * data loss window on crash/SIGKILL. Returns checkpoint stats.
 */
export function checkpointWal() {
  if (!_db) return null;
  try {
    const result = _db.pragma('wal_checkpoint(PASSIVE)');
    return result?.[0] || null;
  } catch (err) {
    const ts = new Date().toISOString();
    process.stderr.write(`${ts} [db] WAL checkpoint error: ${err.message}\n`);
    return null;
  }
}

export function closeDb() {
  if (_db) {
    try {
      // Checkpoint WAL to main DB before closing to prevent data loss
      const result = _db.pragma('wal_checkpoint(TRUNCATE)');
      const ts = new Date().toISOString();
      if (result && result[0]) {
        const r = result[0];
        process.stderr.write(`${ts} [db] WAL checkpoint on close: busy=${r.busy}, checkpointed=${r.checkpointed}, log=${r.log}\n`);
      } else {
        process.stderr.write(`${ts} [db] WAL checkpoint on close: ok\n`);
      }
    } catch (err) {
      const ts = new Date().toISOString();
      process.stderr.write(`${ts} [db] WAL checkpoint failed on close: ${err.message}\n`);
    }
    _db.close();
    _db = null;
  }
}
