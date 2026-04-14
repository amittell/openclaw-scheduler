#!/usr/bin/env node
// Standalone test for getActiveOriginFromSessions group-preference tiebreaker
// Run: node test-origin-tiebreak.mjs

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAILED: ${label}`);
    failed++;
  }
}

const indexPath = join(__dirname, 'dispatch', 'index.mjs');

function runAutoDetect(sessions) {
  const tmpBase = mkdtempSync(join(tmpdir(), 'origin-tiebreak-'));
  const sessionsDir = join(tmpBase, '.openclaw', 'agents', 'main', 'sessions');
  const labelsPath  = join(tmpBase, 'labels.json');
  const binDir = join(tmpBase, 'bin');
  const openclawPath = join(binDir, 'openclaw');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify(sessions) + '\n');
  writeFileSync(labelsPath, JSON.stringify({}) + '\n');
  writeFileSync(openclawPath, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "const method = args[0] === 'gateway' && args[1] === 'call' ? args[2] : null;",
    "if (method === 'agent') {",
    "  process.stdout.write(JSON.stringify({ ok: true, runId: 'run-test' }));",
    '} else {',
    "  process.stdout.write('{}');",
    '}',
    '',
  ].join('\n'));
  chmodSync(openclawPath, 0o755);

  const run = spawnSync(
    process.execPath,
    [indexPath, 'enqueue',
      '--label', 'test-origin-tiebreak',
      '--message', 'ping',
      '--delivery-mode', 'none',
      '--timeout', '300',
      '--no-monitor',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmpBase,
        DISPATCH_LABELS_PATH: labelsPath,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
      timeout: 15_000,
    }
  );

  rmSync(tmpBase, { recursive: true, force: true });
  const m = /auto-detected origin from active session: ([^\n]+)/.exec(run.stderr || '');
  return m ? m[1].trim() : null;
}

const now = Date.now();
const recent1 = now - 30_000;  // 30 s ago (more recent)
const recent2 = now - 60_000;  // 60 s ago (older, but within 10 min)

console.log('\n-- getActiveOriginFromSessions: group-preference tiebreaker --');

// Test 1: only direct session active -> returns direct session
{
  const sessions = {
    'agent:main:telegram:direct:alex': {
      updatedAt: recent1,
      deliveryContext: { to: 'telegram:484946046' },
      chatType: 'direct',
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === 'telegram:484946046', 'only direct active -> returns direct');
}

// Test 2: only group session active -> returns group session
{
  const sessions = {
    'agent:main:telegram:group:-5240776892': {
      updatedAt: recent1,
      deliveryContext: { to: 'telegram:-5240776892' },
      chatType: 'group',
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === 'telegram:-5240776892', 'only group active -> returns group');
}

// Test 3: group more recent than direct -> returns group (original behavior preserved)
{
  const sessions = {
    'agent:main:telegram:group:-5240776892': {
      updatedAt: recent1,
      deliveryContext: { to: 'telegram:-5240776892' },
      chatType: 'group',
    },
    'agent:main:telegram:direct:alex': {
      updatedAt: recent2,
      deliveryContext: { to: 'telegram:484946046' },
      chatType: 'direct',
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === 'telegram:-5240776892', 'group more recent -> returns group');
}

// Test 4 (THE FIX): direct more recent than group -> still returns group
{
  const sessions = {
    'agent:main:telegram:direct:alex': {
      updatedAt: recent1,  // more recent (agent just replied in DM)
      deliveryContext: { to: 'telegram:484946046' },
      chatType: 'direct',
    },
    'agent:main:telegram:group:-5240776892': {
      updatedAt: recent2,  // older (actual triggering context)
      deliveryContext: { to: 'telegram:-5240776892' },
      chatType: 'group',
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === 'telegram:-5240776892', 'direct more recent than group -> still returns group (THE FIX)');
}

// Test 5: no chatType field, infer from session key pattern
{
  const sessions = {
    'agent:main:telegram:direct:alex': {
      updatedAt: recent1,
      deliveryContext: { to: 'telegram:484946046' },
      // no chatType field - fall back to key pattern
    },
    'agent:main:telegram:group:-5240776892': {
      updatedAt: recent2,
      deliveryContext: { to: 'telegram:-5240776892' },
      // no chatType field - fall back to key pattern
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === 'telegram:-5240776892', 'no chatType field, key-pattern fallback -> still returns group');
}

// Test 6: no active sessions -> returns null (no auto-detect line in stderr)
{
  const sessions = {};
  const origin = runAutoDetect(sessions);
  assert(origin === null, 'no active sessions -> returns null');
}

// Test 7: only stale sessions (>10 min) -> returns null
{
  const stale = now - 11 * 60 * 1000;
  const sessions = {
    'agent:main:telegram:group:-5240776892': {
      updatedAt: stale,
      deliveryContext: { to: 'telegram:-5240776892' },
      chatType: 'group',
    },
  };
  const origin = runAutoDetect(sessions);
  assert(origin === null, 'only stale sessions -> returns null');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
