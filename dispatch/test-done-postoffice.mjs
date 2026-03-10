#!/usr/bin/env node
/**
 * test-done-postoffice.mjs — Unit/integration tests for the 'done' completion
 * signal post-office delivery path.
 *
 * Tests:
 *   1. Unregistered label → marked done, no delivery (no deliverTo in config)
 *   2. Unregistered label + config.deliverTo set → onFinished called with fallback target
 *   3. Registered label → normal done path (no spurious gateway call)
 *
 * Run:
 *   node dispatch/test-done-postoffice.mjs
 *   node dispatch/test-done-postoffice.mjs -v    (verbose)
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCH_INDEX = join(__dirname, 'index.mjs');

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    if (verbose) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗  ${msg}`);
  }
}

/**
 * Run dispatch done CLI and return { stdout, stderr, exitCode }.
 * Uses spawnSync so stderr is always captured (even on success).
 */
function runDone(flags, envOverrides = {}) {
  const args = [DISPATCH_INDEX, 'done', ...flags];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout:  10000,
    env:      { ...process.env, ...envOverrides },
  });
  return {
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

/** Alias — spawnSync already captures both streams. */
const runDoneFull = runDone;

// ── Helpers ──────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'dispatch-test-'));
}

function writeLabels(dir, data = {}) {
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(data, null, 2));
}

function readLabels(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(dir, data = {}) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(data, null, 2));
}

// ── Mock Gateway Server ──────────────────────────────────────

/**
 * Start a lightweight mock HTTP server that records /tools/invoke requests.
 * Returns { server, port, calls, close }.
 */
async function startMockGateway() {
  const calls = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { calls.push({ url: req.url, body: JSON.parse(body), headers: req.headers }); } catch { calls.push({ url: req.url, body, headers: req.headers }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        calls,
        close: () => new Promise(r => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

console.log('\ndispatch done — post-office delivery tests\n');

// ── Test 1: Unregistered label, no deliverTo in config ───────
{
  const tmpDir = makeTempDir();
  try {
    writeLabels(tmpDir, {});
    writeConfig(tmpDir, { name: 'test-dispatch' }); // no deliverTo

    const { stdout, stderr, exitCode } = runDoneFull(
      ['--label', 'unregistered-no-deliver', '--summary', 'test complete'],
      {
        DISPATCH_LABELS_PATH: join(tmpDir, 'labels.json'),
        DISPATCH_CONFIG_DIR:  tmpDir,
        OPENCLAW_GATEWAY_TOKEN: 'fake-token',
      }
    );

    const result = JSON.parse(stdout.trim());
    assert(exitCode === 0,         'Test 1: exits 0 for unregistered label');
    assert(result.ok === true,     'Test 1: ok=true');
    assert(result.status === 'done', 'Test 1: status=done');

    const labels = readLabels(tmpDir);
    assert(labels['unregistered-no-deliver']?.status === 'done', 'Test 1: label written as done in labels.json');

    // Should warn about no deliverTo
    assert(stderr.includes('no deliverTo'), 'Test 1: warns no deliverTo in config');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Test 2: Unregistered label + config.deliverTo set → onFinished with fallback ──
{
  const tmpDir = makeTempDir();
  let gw = null;
  try {
    writeLabels(tmpDir, {});
    writeConfig(tmpDir, {
      name: 'test-dispatch',
      deliverTo: '484946046',
      deliveryChannel: 'telegram',
    });

    // Start a mock gateway to intercept the /tools/invoke call
    gw = await startMockGateway();
    const mockGatewayUrl = `http://127.0.0.1:${gw.port}`;

    const { stdout, stderr, exitCode } = runDoneFull(
      ['--label', 'unregistered-with-deliver', '--summary', 'agent finished work'],
      {
        DISPATCH_LABELS_PATH:   join(tmpDir, 'labels.json'),
        DISPATCH_CONFIG_DIR:    tmpDir,
        OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
        OPENCLAW_GATEWAY_URL:   mockGatewayUrl,
      }
    );

    let result = {};
    try { result = JSON.parse(stdout.trim()); } catch { /* parse error handled below */ }

    assert(exitCode === 0,           'Test 2: exits 0');
    assert(result.ok === true,       'Test 2: ok=true');
    assert(result.status === 'done', 'Test 2: status=done');

    const labels = readLabels(tmpDir);
    assert(labels['unregistered-with-deliver']?.status === 'done', 'Test 2: label written as done');

    // onFinished should NOT warn about missing deliverTo
    assert(!stderr.includes('no deliverTo'), 'Test 2: no "no deliverTo" warning when deliverTo is set');

    // Verify gateway was called with the correct delivery target
    // (give a small window for async delivery to complete)
    await new Promise(r => setTimeout(r, 500));

    const invokeCalls = gw.calls.filter(c => c.url === '/tools/invoke');
    assert(invokeCalls.length >= 1, 'Test 2: gateway /tools/invoke called at least once');

    if (invokeCalls.length >= 1) {
      const call = invokeCalls[0];
      assert(call.body?.tool === 'message',          'Test 2: tool=message in gateway call');
      assert(call.body?.args?.action === 'send',     'Test 2: action=send');
      assert(call.body?.args?.channel === 'telegram','Test 2: channel=telegram from config');
      assert(call.body?.args?.target === '484946046','Test 2: target=deliverTo from config');
      assert(
        typeof call.body?.args?.message === 'string' &&
        call.body.args.message.includes('unregistered-with-deliver'),
        'Test 2: message includes label name'
      );
      assert(
        call.body.args.message.includes('agent finished work'),
        'Test 2: message includes summary'
      );
      assert(
        call.headers?.authorization === 'Bearer test-gateway-token',
        'Test 2: Authorization header sent'
      );
    }
  } finally {
    if (gw) await gw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Test 3: Registered label → normal path, no spurious gateway notify ───────
{
  const tmpDir = makeTempDir();
  let gw = null;
  try {
    // Pre-register a label so it hits the existing path (not unregistered)
    writeLabels(tmpDir, {
      'registered-label': {
        sessionKey:  'agent:main:subagent:test-uuid',
        runId:       'test-run-id',
        agent:       'main',
        status:      'running',
        spawnedAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      }
    });
    writeConfig(tmpDir, {
      name: 'test-dispatch',
      deliverTo: '484946046',
      deliveryChannel: 'telegram',
    });

    gw = await startMockGateway();
    const mockGatewayUrl = `http://127.0.0.1:${gw.port}`;

    const { stdout, stderr, exitCode } = runDoneFull(
      ['--label', 'registered-label', '--summary', 'registered completed'],
      {
        DISPATCH_LABELS_PATH:   join(tmpDir, 'labels.json'),
        DISPATCH_CONFIG_DIR:    tmpDir,
        OPENCLAW_GATEWAY_TOKEN: 'test-gateway-token',
        OPENCLAW_GATEWAY_URL:   mockGatewayUrl,
      }
    );

    let result = {};
    try { result = JSON.parse(stdout.trim()); } catch {}

    assert(exitCode === 0,           'Test 3: exits 0 for registered label');
    assert(result.ok === true,       'Test 3: ok=true');
    assert(result.status === 'done', 'Test 3: status=done');

    const labels = readLabels(tmpDir);
    assert(labels['registered-label']?.status === 'done', 'Test 3: label updated to done');

    // Registered labels go through onFinished WITHOUT deliverTo (no config fallback needed)
    // so gateway should NOT be called for delivery from the unregistered path
    await new Promise(r => setTimeout(r, 300));
    const invokeCalls = gw.calls.filter(c => c.url === '/tools/invoke');
    // The registered path calls onFinished WITHOUT deliverTo — gateway shouldn't be called
    assert(invokeCalls.length === 0, 'Test 3: gateway NOT called for registered label (uses watcher)');

    // No warn about unregistered
    assert(!stderr.includes('no session found for label'), 'Test 3: no unregistered warning for registered label');
  } finally {
    if (gw) await gw.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Test 4: Missing label flag ────────────────────────────────
{
  const tmpDir = makeTempDir();
  try {
    writeLabels(tmpDir, {});
    writeConfig(tmpDir, {});

    const { exitCode } = runDone(
      ['--summary', 'no label provided'],
      {
        DISPATCH_LABELS_PATH: join(tmpDir, 'labels.json'),
        DISPATCH_CONFIG_DIR:  tmpDir,
      }
    );

    assert(exitCode !== 0, 'Test 4: exits non-zero when --label missing');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Results ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
