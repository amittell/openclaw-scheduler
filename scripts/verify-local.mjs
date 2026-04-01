#!/usr/bin/env node

import { execFileSync } from 'child_process';

const smokeOnly = process.argv.includes('--smoke');
// On Windows, npm is a batch file (npm.cmd) -- execFileSync cannot run .cmd
// files directly without shell: true.
const isWindows = process.platform === 'win32';
const npmExec = 'npm';

const steps = smokeOnly
  ? [
      { name: 'lint', cmd: [npmExec, ['run', 'lint']] },
      { name: 'typecheck', cmd: [npmExec, ['run', 'typecheck']] },
      { name: 'pack', cmd: [npmExec, ['pack', '--dry-run']] },
    ]
  : [
      { name: 'lint', cmd: [npmExec, ['run', 'lint']] },
      { name: 'typecheck', cmd: [npmExec, ['run', 'typecheck']] },
      { name: 'test', cmd: [npmExec, ['test']] },
      { name: 'coverage', cmd: [npmExec, ['run', 'coverage']] },
      { name: 'pack', cmd: [npmExec, ['pack', '--dry-run']] },
    ];

for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  execFileSync(step.cmd[0], step.cmd[1], { stdio: 'inherit', shell: isWindows });
}

process.stdout.write(`\nLocal verification complete (${smokeOnly ? 'smoke' : 'full'}).\n`);
