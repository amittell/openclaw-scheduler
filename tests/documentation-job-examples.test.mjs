import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateJobSpec } from '../jobs.js';

const documents = [
  'README.md',
  'QUICK-START.md',
  'JOB-QUICK-REF.md',
  'BEST-PRACTICES.md',
  'INSTALL.md',
  'INSTALL-LINUX.md',
  'INSTALL-WINDOWS.md',
  'INSTALL-ADDITIONAL-HOST.md',
  'UPGRADING.md',
  'UNINSTALL.md',
  'SECURITY.md',
  'CONTEXT.md',
  'IMPLEMENTATION_SPEC.md',
  'AGENTS.md',
  'docs/adr-schedule-ownership.md',
  'docs/gateway-contract.md',
  'docs/trust-architecture.md',
  'skills/durable-scheduler/SKILL.md',
];

function collectJobExamples(value) {
  if (Array.isArray(value)) return value.flatMap(collectJobExamples);
  if (!value || typeof value !== 'object') return [];
  if (!('name' in value) || !('payload_message' in value)) return [];
  return [value];
}

test('documented job JSON examples satisfy the production job validator', () => {
  let validated = 0;
  for (const file of documents) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/```json(?:\s+strict)?\n([\s\S]*?)```/g)) {
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        continue;
      }
      for (const job of collectJobExamples(parsed)) {
        assert.doesNotThrow(
          () => validateJobSpec(job, null, 'create'),
          `${file}: documented job "${job.name}" must pass validateJobSpec`,
        );
        validated++;
      }
    }
  }
  assert.ok(validated >= 17, `expected at least 17 documented jobs, validated ${validated}`);
});
