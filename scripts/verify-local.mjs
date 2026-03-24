#!/usr/bin/env node

import { execFileSync } from 'child_process';

const smokeOnly = process.argv.includes('--smoke');

const steps = smokeOnly
  ? [
      { name: 'lint', cmd: ['npm', ['run', 'lint']] },
      { name: 'typecheck', cmd: ['npm', ['run', 'typecheck']] },
      { name: 'pack', cmd: ['npm', ['pack', '--dry-run']] },
    ]
  : [
      { name: 'lint', cmd: ['npm', ['run', 'lint']] },
      { name: 'typecheck', cmd: ['npm', ['run', 'typecheck']] },
      { name: 'test', cmd: ['npm', ['test']] },
      { name: 'coverage', cmd: ['npm', ['run', 'coverage']] },
      { name: 'pack', cmd: ['npm', ['pack', '--dry-run']] },
    ];

for (const step of steps) {
  process.stdout.write(`\n==> ${step.name}\n`);
  execFileSync(step.cmd[0], step.cmd[1], { stdio: 'inherit' });
}

process.stdout.write(`\nLocal verification complete (${smokeOnly ? 'smoke' : 'full'}).\n`);
