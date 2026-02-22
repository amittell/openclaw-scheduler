#!/usr/bin/env node
// Schema migration v3b: Retry logic, cancellation
import { initDb, getDb } from './db.js';

initDb();
const db = getDb();

const migrations = [
  [`max_retries`, `ALTER TABLE jobs ADD COLUMN max_retries INTEGER DEFAULT 0`],
  [`retry_count`, `ALTER TABLE runs ADD COLUMN retry_count INTEGER DEFAULT 0`],
  [`retry_of`, `ALTER TABLE runs ADD COLUMN retry_of TEXT`],  // points to original run id
];

let applied = 0;
for (const [col, sql] of migrations) {
  const table = sql.match(/ALTER TABLE (\w+)/)?.[1];
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (exists) {
    console.log(`Column '${col}' on ${table} already exists — skipping`);
    continue;
  }
  db.prepare(sql).run();
  console.log(`Applied: ${table}.${col}`);
  applied++;
}

console.log(`\nMigration v3b complete: ${applied} column(s) added`);
