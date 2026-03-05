import { spawnSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Report } = require('c8');

const rootDir = resolve(process.cwd());
const reportsDir = resolve(rootDir, 'coverage');
const tempDir = resolve(reportsDir, 'tmp');

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
  reporter: ['text-summary', 'lcov'],
  reportsDirectory: reportsDir,
  resolve: rootDir,
  src: [rootDir],
  tempDirectory: tempDir,
});

await report.run();
