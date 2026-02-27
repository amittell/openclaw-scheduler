#!/usr/bin/env node
// Migration v9: add preferred_session_key to jobs
// Enables chilisaus --mode reuse: dispatcher passes this session key to
// the gateway so the isolated run continues an existing conversation context.
//
// If NULL (default), dispatcher generates a fresh scheduler:job:run key.
// If set, dispatcher uses it as the x-openclaw-session-key header — gateway
// continues the existing session (or creates a fresh one with that key if expired).

import { getDb } from './db.js';

export default function migrateV9() {
  const db = getDb();

  const current = db.prepare("SELECT version FROM schema_migrations WHERE version = 9").get();
  if (current) return false; // already applied

  db.transaction(() => {
    try {
      db.prepare('ALTER TABLE jobs ADD COLUMN preferred_session_key TEXT DEFAULT NULL').run();
    } catch { /* column already exists */ }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (9)').run();
  })();

  return true;
}

// Allow running as standalone script: node migrate-v9.js
// Note: uses getDb() directly (not initDb()) to avoid circular imports.
if (process.argv[1] && process.argv[1].endsWith('migrate-v9.js')) {
  const applied = migrateV9();
  console.log(applied ? 'Migration v9 applied: jobs.preferred_session_key' : 'Migration v9 already applied.');
}
