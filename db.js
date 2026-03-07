// Database layer — SQLite via better-sqlite3
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureSchedulerDbParent, resolveSchedulerDbPath } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const dbPath = _dbPath || resolveSchedulerDbPath({ env: process.env });
    if (dbPath !== ':memory:') ensureSchedulerDbParent(dbPath);
    _db = new Database(dbPath);
    if (dbPath !== ':memory:') _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function getResolvedDbPath() {
  return _dbPath || resolveSchedulerDbPath({ env: process.env });
}

export async function initDb() {
  const db = getDb();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

  // Apply schema once first (best effort). This is enough for net-new installs.
  try {
    db.exec(schema);
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} [db] Initial schema apply warning: ${err.message}\n`);
  }

  // Bring existing DBs to the consolidated schema version.
  try {
    const { default: consolidate } = await import('./migrate-consolidate.js');
    const applied = consolidate();
    if (applied) {
      process.stderr.write(`${new Date().toISOString()} [db] Consolidation migration applied\n`);
    }
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} [db] migrate-consolidate error: ${err.message}\n`);
  }

  // Re-apply schema so indexes/table defs are fully aligned after consolidation.
  try {
    db.exec(schema);
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} [db] Schema re-apply warning: ${err.message}\n`);
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
