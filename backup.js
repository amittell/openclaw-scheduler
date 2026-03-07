#!/usr/bin/env node
/**
 * Scheduler DB Backup — Ship SQLite snapshots to MinIO
 * 
 * Modes:
 *   snapshot  — Full DB copy to MinIO (5-min granularity)
 *   rollup    — Tagged hourly snapshot + prune old 5-min snapshots
 *   restore   — Pull latest snapshot from MinIO and restore
 *   status    — Show backup status (latest snapshot, count, size)
 *   prune     — Remove snapshots older than retention policy
 * 
 * Storage layout on MinIO:
 *   scheduler-backups/scheduler/snapshots/YYYY-MM-DD/HH-MM.db
 *   scheduler-backups/scheduler/rollups/YYYY-MM-DD/HH.db
 * 
 * Retention:
 *   snapshots: 24 hours (288 files max at 5-min intervals)
 *   rollups:   7 days (168 files max)
 * 
 * Usage:
 *   node backup.js snapshot     # Ship current DB
 *   node backup.js rollup       # Hourly rollup + prune old snapshots
 *   node backup.js restore      # Restore from latest
 *   node backup.js status       # Show backup stats
 */

import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveBackupStagingDir, resolveSchedulerDbPath } from './paths.js';

const DB_PATH = resolveSchedulerDbPath({ env: process.env });
const STAGING_DIR = resolveBackupStagingDir(process.env);
const MC_ALIAS = 'backupstore';
const BUCKET = 'scheduler-backups';
const PREFIX = 'scheduler';

// Find mc binary — may be in ~/bin on some hosts
const MC_BIN = existsSync(join(homedir(), 'bin', 'mc'))
  ? join(homedir(), 'bin', 'mc')
  : 'mc';

// Retention
const SNAPSHOT_RETENTION_HOURS = 24;
const ROLLUP_RETENTION_DAYS = 7;

const LOG_PREFIX = '[backup]';

function log(level, msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${LOG_PREFIX} [${level}] ${msg}\n`);
}

function now() {
  return new Date();
}

function mcPath(subpath) {
  return `${MC_ALIAS}/${BUCKET}/${PREFIX}/${subpath}`;
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30000, ...opts }).trim();
  } catch (err) {
    if (!opts.ignoreError) {
      log('error', `Command failed: ${cmd}\n${err.stderr || err.message}`);
    }
    return null;
  }
}

// ── Snapshot (5-min) ────────────────────────────────────────
function snapshot() {
  if (!existsSync(DB_PATH)) {
    log('error', `DB not found: ${DB_PATH}`);
    process.exit(1);
  }

  // Stage: checkpoint WAL then copy
  mkdirSync(STAGING_DIR, { recursive: true });
  const stagingFile = join(STAGING_DIR, 'scheduler-snapshot.db');

  // Use sqlite3 .backup for a consistent copy (handles WAL correctly)
  const backupCmd = `sqlite3 "${DB_PATH}" ".backup '${stagingFile}'"`;
  const result = run(backupCmd);
  if (result === null && !existsSync(stagingFile)) {
    // Fallback: direct copy after WAL checkpoint
    log('warn', 'sqlite3 .backup failed, falling back to file copy');
    copyFileSync(DB_PATH, stagingFile);
  }

  const size = statSync(stagingFile).size;
  const d = now();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
  const remotePath = mcPath(`snapshots/${dateStr}/${timeStr}.db`);

  const uploadResult = run(`${MC_BIN} cp "${stagingFile}" "${remotePath}"`);
  if (uploadResult !== null) {
    log('info', `Snapshot shipped: ${remotePath} (${(size / 1024).toFixed(1)}KB)`);
  } else {
    log('error', `Failed to upload snapshot to ${remotePath}`);
  }

  // Cleanup staging
  try { unlinkSync(stagingFile); } catch {}

  return { remotePath, size };
}

// ── Rollup (hourly) ─────────────────────────────────────────
function rollup() {
  // First, take a snapshot and save it as a rollup
  if (!existsSync(DB_PATH)) {
    log('error', `DB not found: ${DB_PATH}`);
    process.exit(1);
  }

  mkdirSync(STAGING_DIR, { recursive: true });
  const stagingFile = join(STAGING_DIR, 'scheduler-rollup.db');
  run(`sqlite3 "${DB_PATH}" ".backup '${stagingFile}'"`) ||
    copyFileSync(DB_PATH, stagingFile);

  const size = statSync(stagingFile).size;
  const d = now();
  const dateStr = d.toISOString().slice(0, 10);
  const hourStr = String(d.getHours()).padStart(2, '0');
  const remotePath = mcPath(`rollups/${dateStr}/${hourStr}.db`);

  run(`${MC_BIN} cp "${stagingFile}" "${remotePath}"`);
  log('info', `Rollup shipped: ${remotePath} (${(size / 1024).toFixed(1)}KB)`);

  try { unlinkSync(stagingFile); } catch {}

  // Prune old snapshots (>24h)
  pruneSnapshots();
  // Prune old rollups (>7d)
  pruneRollups();
}

// ── Prune ───────────────────────────────────────────────────
function pruneSnapshots() {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_HOURS * 3600 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // List snapshot date directories
  const listing = run(`${MC_BIN} ls "${mcPath('snapshots/')}" --json`, { ignoreError: true });
  if (!listing) return;

  let pruned = 0;
  for (const line of listing.split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      const dirName = obj.key?.replace(/\/$/, '');
      if (dirName && dirName < cutoffDate) {
        run(`${MC_BIN} rm --recursive --force "${mcPath(`snapshots/${dirName}/`)}"`, { ignoreError: true });
        pruned++;
        log('info', `Pruned snapshot dir: ${dirName}`);
      }
    } catch {}
  }
  if (pruned > 0) log('info', `Pruned ${pruned} old snapshot dir(s)`);
}

function pruneRollups() {
  const cutoff = new Date(Date.now() - ROLLUP_RETENTION_DAYS * 86400 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const listing = run(`${MC_BIN} ls "${mcPath('rollups/')}" --json`, { ignoreError: true });
  if (!listing) return;

  let pruned = 0;
  for (const line of listing.split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      const dirName = obj.key?.replace(/\/$/, '');
      if (dirName && dirName < cutoffDate) {
        run(`${MC_BIN} rm --recursive --force "${mcPath(`rollups/${dirName}/`)}"`, { ignoreError: true });
        pruned++;
        log('info', `Pruned rollup dir: ${dirName}`);
      }
    } catch {}
  }
  if (pruned > 0) log('info', `Pruned ${pruned} old rollup dir(s)`);
}

// ── Restore ─────────────────────────────────────────────────
function restore() {
  // Find latest rollup first, then latest snapshot
  let latest = null;

  // Try rollups first (more reliable)
  const rollupDirs = run(`${MC_BIN} ls "${mcPath('rollups/')}" --json`, { ignoreError: true });
  if (rollupDirs) {
    const dirs = rollupDirs.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l).key?.replace(/\/$/, ''); } catch { return null; }
    }).filter(Boolean).sort().reverse();

    for (const dir of dirs) {
      const files = run(`${MC_BIN} ls "${mcPath(`rollups/${dir}/`)}" --json`, { ignoreError: true });
      if (files) {
        const fList = files.split('\n').filter(Boolean).map(l => {
          try { return JSON.parse(l).key; } catch { return null; }
        }).filter(Boolean).sort().reverse();
        if (fList.length > 0) {
          latest = { type: 'rollup', path: mcPath(`rollups/${dir}/${fList[0]}`) };
          break;
        }
      }
    }
  }

  // Try snapshots if no rollup found
  if (!latest) {
    const snapDirs = run(`${MC_BIN} ls "${mcPath('snapshots/')}" --json`, { ignoreError: true });
    if (snapDirs) {
      const dirs = snapDirs.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l).key?.replace(/\/$/, ''); } catch { return null; }
      }).filter(Boolean).sort().reverse();

      for (const dir of dirs) {
        const files = run(`${MC_BIN} ls "${mcPath(`snapshots/${dir}/`)}" --json`, { ignoreError: true });
        if (files) {
          const fList = files.split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l).key; } catch { return null; }
          }).filter(Boolean).sort().reverse();
          if (fList.length > 0) {
            latest = { type: 'snapshot', path: mcPath(`snapshots/${dir}/${fList[0]}`) };
            break;
          }
        }
      }
    }
  }

  if (!latest) {
    log('error', 'No backups found to restore from');
    process.exit(1);
  }

  log('info', `Restoring from ${latest.type}: ${latest.path}`);

  // Backup current DB
  if (existsSync(DB_PATH)) {
    const backupPath = `${DB_PATH}.pre-restore.${Date.now()}`;
    copyFileSync(DB_PATH, backupPath);
    log('info', `Current DB backed up to ${backupPath}`);
  }

  // Download and replace
  mkdirSync(STAGING_DIR, { recursive: true });
  const downloadPath = join(STAGING_DIR, 'restore.db');
  const dlResult = run(`${MC_BIN} cp "${latest.path}" "${downloadPath}"`);
  if (dlResult === null) {
    log('error', 'Download failed');
    process.exit(1);
  }

  // Verify the downloaded DB
  const verify = run(`sqlite3 "${downloadPath}" "SELECT count(*) FROM jobs"`);
  if (verify === null) {
    log('error', 'Downloaded DB is corrupt');
    process.exit(1);
  }

  // Remove WAL/SHM files from current DB
  try { unlinkSync(`${DB_PATH}-wal`); } catch {}
  try { unlinkSync(`${DB_PATH}-shm`); } catch {}

  // Replace
  copyFileSync(downloadPath, DB_PATH);
  try { unlinkSync(downloadPath); } catch {}

  log('info', `Restored: ${verify} jobs from ${latest.type}`);
  console.log(`Restored ${verify} jobs from ${latest.path}`);
}

// ── Status ──────────────────────────────────────────────────
function status() {
  console.log('=== Scheduler Backup Status ===\n');

  // Current DB
  if (existsSync(DB_PATH)) {
    const st = statSync(DB_PATH);
    console.log(`Local DB: ${(st.size / 1024).toFixed(1)}KB, modified ${st.mtime.toISOString()}`);
    const jobCount = run(`sqlite3 "${DB_PATH}" "SELECT count(*) FROM jobs"`) || '?';
    console.log(`Jobs: ${jobCount}`);
  }

  // Snapshots
  console.log('\nSnapshots (last 24h):');
  const snapDirs = run(`${MC_BIN} ls "${mcPath('snapshots/')}"`, { ignoreError: true });
  if (snapDirs) {
    console.log(snapDirs);
  } else {
    console.log('  (none)');
  }

  // Rollups
  console.log('\nRollups (last 7d):');
  const rollupDirs = run(`${MC_BIN} ls "${mcPath('rollups/')}"`, { ignoreError: true });
  if (rollupDirs) {
    console.log(rollupDirs);
  } else {
    console.log('  (none)');
  }

  // Total size
  const du = run(`${MC_BIN} du "${mcPath('')}"`, { ignoreError: true });
  if (du) console.log(`\nTotal backup size: ${du}`);
}

// ── Main ────────────────────────────────────────────────────
const command = process.argv[2] || 'status';

switch (command) {
  case 'snapshot': snapshot(); break;
  case 'rollup': rollup(); break;
  case 'restore': restore(); break;
  case 'status': status(); break;
  case 'prune': pruneSnapshots(); pruneRollups(); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: node backup.js [snapshot|rollup|restore|status|prune]');
    process.exit(1);
}
