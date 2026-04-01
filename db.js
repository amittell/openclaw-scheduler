// Database layer -- SQLite via better-sqlite3
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
    _db.pragma('busy_timeout = 5000');
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
  const hasUserTables = (db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).get()?.cnt ?? 0) > 0;
  const applySchema = (label) => {
    try {
      db.exec(schema);
      return true;
    } catch (err) {
      process.stderr.write(`${new Date().toISOString()} [db] ${label}: ${err.message}\n`);
      return false;
    }
  };
  const runConsolidate = async () => {
    try {
      const { default: consolidate } = await import('./migrate-consolidate.js');
      const applied = consolidate();
      if (applied) {
        process.stderr.write(`${new Date().toISOString()} [db] Consolidation migration applied\n`);
      }
    } catch (err) {
      process.stderr.write(`${new Date().toISOString()} [db] migrate-consolidate error: ${err.message}\n`);
    }
  };

  if (hasUserTables) {
    // Existing installs: normalize via migration first so schema re-apply doesn't
    // trip over legacy partial tables/indexes.
    await runConsolidate();
    applySchema('Schema apply warning');
    return db;
  }

  // Net-new installs: create the baseline schema, then run consolidation in case
  // a package upgrade adds idempotent backfills the base schema doesn't need.
  applySchema('Initial schema apply warning');
  await runConsolidate();

  // Re-apply schema so indexes/table defs are fully aligned after consolidation.
  applySchema('Schema re-apply warning');

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
