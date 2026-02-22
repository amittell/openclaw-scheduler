#!/usr/bin/env node
// Schema migration v3: Add workflow chaining (parent/child jobs)
import { initDb, getDb } from './db.js';

initDb();
const db = getDb();

const migrations = [
  `ALTER TABLE jobs ADD COLUMN parent_id TEXT REFERENCES jobs(id)`,
  `ALTER TABLE jobs ADD COLUMN trigger_on TEXT`,       // 'success' | 'failure' | 'complete' | NULL
  `ALTER TABLE jobs ADD COLUMN trigger_delay_s INTEGER DEFAULT 0`,
];

let applied = 0;
for (const sql of migrations) {
  const col = sql.match(/ADD COLUMN (\w+)/)?.[1];
  // Check if column already exists
  const exists = db.prepare(`PRAGMA table_info(jobs)`).all().some(c => c.name === col);
  if (exists) {
    console.log(`Column '${col}' already exists — skipping`);
    continue;
  }
  db.prepare(sql).run();
  console.log(`Applied: ADD COLUMN ${col}`);
  applied++;
}

// Add index for parent lookups
try {
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id) WHERE parent_id IS NOT NULL`).run();
  console.log('Index idx_jobs_parent ensured');
} catch {}

console.log(`\nMigration v3 complete: ${applied} column(s) added`);
