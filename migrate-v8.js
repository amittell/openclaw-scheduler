#!/usr/bin/env node
// Migration v8: add session_key + last_heartbeat to task_tracker_agents
// Enables dispatcher auto-correlation: match live OC sessions → tracker agents

import { getDb } from './db.js';

export default function migrateV8() {
  const db = getDb();

  const current = db.prepare("SELECT version FROM schema_migrations WHERE version = 8").get();
  if (current) return false; // already applied

  db.transaction(() => {
    // Add session_key: the OpenClaw session key for the sub-agent
    // (e.g. "agent:main:subagent:abc-123"). Used for auto-correlation.
    try {
      db.prepare('ALTER TABLE task_tracker_agents ADD COLUMN session_key TEXT').run();
    } catch { /* column may already exist */ }

    // Add last_heartbeat: updated whenever activity is detected
    // (CLI call or auto-correlation from listSessions)
    try {
      db.prepare('ALTER TABLE task_tracker_agents ADD COLUMN last_heartbeat TEXT').run();
    } catch { /* column may already exist */ }

    // Index for fast session key lookup during correlation
    try {
      db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_tta_session_key
        ON task_tracker_agents(session_key)
        WHERE session_key IS NOT NULL
      `).run();
    } catch { /* index may already exist */ }

    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (8)').run();
  })();

  return true;
}

// Allow running as standalone script: node migrate-v8.js
if (process.argv[1] && process.argv[1].endsWith('migrate-v8.js')) {
  const applied = migrateV8();
  console.log(applied ? 'Migration v8 applied: task_tracker_agents.session_key + last_heartbeat' : 'Migration v8 already applied.');
}
