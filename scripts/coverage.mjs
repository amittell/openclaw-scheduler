import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Report } = require('c8');

const rootDir = resolve(process.cwd());
const reportsDir = resolve(rootDir, 'coverage');
const tempDir = resolve(reportsDir, 'tmp');
const summaryPath = resolve(reportsDir, 'coverage-summary.json');

rmSync(reportsDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

const env = {
  ...process.env,
  NODE_V8_COVERAGE: tempDir,
};

const run = spawnSync(process.execPath, ['test.js'], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
});

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const report = Report({
  all: true,
  allowExternal: false,
  excludeAfterRemap: true,
  excludeNodeModules: true,
  extension: ['.js', '.mjs'],
  include: ['**/*.js', '**/*.mjs'],
  exclude: [
    'node_modules/**',
    'coverage/**',
    '**/test.js',
  ],
  reporter: ['text-summary', 'lcov', 'json-summary'],
  reportsDirectory: reportsDir,
  resolve: rootDir,
  src: [rootDir],
  tempDirectory: tempDir,
});

await report.run();

const lcovPath = resolve(reportsDir, 'lcov.info');
const GLOBAL_THRESHOLDS = {
  statements: 42,
  branches: 63,   // dispatch/ watcher + index watchdog paths are only partly integration-tested
  functions: 73,  // _gatewayToolInvoke and several watcher internals are untested — raise as coverage grows
  lines: 42,
};
const CRITICAL_THRESHOLDS = {
  'jobs.js': { lines: 90, functions: 95 },
  'messages.js': { lines: 85, functions: 90 },
  'runs.js': { lines: 85, functions: 70 },
  'team-adapter.js': { lines: 80, functions: 90 },
};

function parseLcovByFile(content) {
  const byFile = new Map();
  let current = null;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = {
        path: line.slice(3),
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
      };
      byFile.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('LF:')) current.lf = Number.parseInt(line.slice(3), 10) || 0;
    else if (line.startsWith('LH:')) current.lh = Number.parseInt(line.slice(3), 10) || 0;
    else if (line.startsWith('FNF:')) current.fnf = Number.parseInt(line.slice(4), 10) || 0;
    else if (line.startsWith('FNH:')) current.fnh = Number.parseInt(line.slice(4), 10) || 0;
    else if (line === 'end_of_record') current = null;
  }
  return byFile;
}

function pct(hit, found) {
  if (found <= 0) return 100;
  return (hit / found) * 100;
}

function findCoverageRecord(byFile, suffix) {
  for (const record of byFile.values()) {
    if (record.path === suffix || record.path.endsWith(`/${suffix}`)) return record;
  }
  return null;
}

const lcovContent = readFileSync(lcovPath, 'utf-8');
const coverageByFile = parseLcovByFile(lcovContent);
const coverageSummary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
const failures = [];
const missing = [];

for (const [metric, minPct] of Object.entries(GLOBAL_THRESHOLDS)) {
  const actual = coverageSummary.total?.[metric]?.pct;
  if (typeof actual !== 'number') {
    failures.push(`missing global coverage metric: ${metric}`);
    continue;
  }
  if (actual < minPct) {
    failures.push(`global ${metric} ${actual.toFixed(2)}% < ${minPct}%`);
  }
}

for (const [suffix, threshold] of Object.entries(CRITICAL_THRESHOLDS)) {
  const rec = findCoverageRecord(coverageByFile, suffix);
  if (!rec) {
    missing.push(suffix);
    continue;
  }
  const linePct = pct(rec.lh, rec.lf);
  const fnPct = pct(rec.fnh, rec.fnf);

  if (linePct < threshold.lines) {
    failures.push(
      `${suffix}: lines ${linePct.toFixed(2)}% < ${threshold.lines}%`
    );
  }
  if (fnPct < threshold.functions) {
    failures.push(
      `${suffix}: functions ${fnPct.toFixed(2)}% < ${threshold.functions}%`
    );
  }
}

if (missing.length > 0 || failures.length > 0) {
  for (const file of missing) {
    process.stderr.write(`[coverage] missing critical file in lcov: ${file}\n`);
  }
  for (const failure of failures) {
    process.stderr.write(`[coverage] threshold failed: ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write('[coverage] critical module thresholds passed.\n');
