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

export function initDb() {
  const db = getDb();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
