#!/usr/bin/env node
// Integration tests: validate that job specs compiled by agentcli can
// round-trip through the scheduler's validation and storage layer.

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setDbPath, initDb, getDb } from './db.js';
import { validateJobSpec, createJob, getJob } from './jobs.js';

// -- Resolve agentcli paths ------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AGENTCLI_PATH = process.env.AGENTCLI_PATH || resolve(__dirname, '../agentcli');
const agentcliBin = resolve(AGENTCLI_PATH, 'bin/agentcli.js');
const agentcliExamples = resolve(AGENTCLI_PATH, 'examples');
const agentcliAvailable = existsSync(agentcliBin);

// -- Test harness (matches test.js pattern) --------------------

let passed = 0;
let failed = 0;

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
function assert(cond, msg) {
  if (cond) { passed++; if (verbose) console.log(`  OK ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg}`); }
}

// -- Helper: compile a manifest via agentcli CLI ---------------

function compileManifest(manifestPath) {
  try {
    const result = execFileSync('node', [agentcliBin, 'compile', manifestPath, '--target', 'openclaw-scheduler'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const parsed = JSON.parse(result);
    if (!parsed.ok || !parsed.output || !Array.isArray(parsed.output.jobs)) {
      return null;
    }
    return parsed.output;
  } catch {
    return null;
  }
}

/**
 * Convert a compiled job (from agentcli compiler output) into the shape
 * that the scheduler's validateJobSpec/createJob expects.  The compiler
 * emits v0.2 blob fields (identity, authorization_proof, authorization,
 * evidence) as objects; the scheduler expects them as JSON strings.
 * Also strips non-column fields like `source`.
 */
function toSchedulerSpec(compiledJob) {
  const spec = { ...compiledJob };
  delete spec.source;

  for (const key of ['identity', 'authorization_proof', 'authorization', 'evidence']) {
    if (spec[key] != null && typeof spec[key] === 'object') {
      spec[key] = JSON.stringify(spec[key]);
    }
  }

  return spec;
}

// -- In-memory DB ----------------------------------------------

setDbPath(':memory:');
await initDb();
const _db = getDb();

console.log('agentcli integration tests\n');

// ===============================================================
// (a) Compiled hello-world validates and creates
// ===============================================================

console.log('Compiled v1 job spec validates and creates:');

const HELLO_WORLD_PATH = resolve(agentcliExamples, 'hello-world.json');

// Try dynamic compilation first; fall back to hardcoded fixture
let helloWorldOutput = agentcliAvailable ? compileManifest(HELLO_WORLD_PATH) : null;

const HELLO_WORLD_FALLBACK_JOBS = [
  {
    id: 'hw-parent-fallback',
    name: 'Daily Report: Collect Metrics',
    enabled: 1,
    schedule_cron: '0 9 * * *',
    schedule_tz: 'America/New_York',
    session_target: 'isolated',
    agent_id: 'main',
    payload_kind: 'agentTurn',
    payload_message: 'Collect the daily operating metrics and summarize the notable changes.',
    payload_model: null,
    payload_thinking: null,
    execution_intent: 'execute',
    execution_read_only: 0,
    run_timeout_ms: 300000,
    overlap_policy: 'skip',
    max_retries: 2,
    max_queued_dispatches: 25,
    max_pending_approvals: 10,
    max_trigger_fanout: 25,
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: '@owner_dm',
    delivery_opt_out_reason: null,
    delivery_guarantee: 'at-least-once',
    origin: 'system',
    parent_id: null,
    trigger_on: null,
    trigger_delay_s: 0,
    trigger_condition: null,
    approval_required: 0,
    approval_timeout_s: 3600,
    approval_auto: 'reject',
    context_retrieval: 'recent',
    context_retrieval_limit: 5,
    output_store_limit_bytes: 65536,
    output_excerpt_limit_bytes: 2000,
    output_summary_limit_bytes: 5000,
    output_offload_threshold_bytes: 65536,
    preferred_session_key: null,
    identity_principal: null,
    identity_run_as: null,
    identity_attestation: null,
    contract_sandbox: null,
    contract_allowed_paths: null,
    contract_network: null,
    contract_max_cost_usd: null,
    contract_audit: null,
    identity_ref: null,
    identity_subject_kind: null,
    identity_subject_principal: null,
    identity_trust_level: null,
    identity_delegation_mode: null,
    identity: null,
    authorization_proof_ref: null,
    authorization_proof: null,
    authorization_ref: null,
    authorization: null,
    evidence_ref: null,
    evidence: null,
    contract_required_trust_level: null,
    contract_trust_enforcement: null,
    delete_after_run: 0,
  },
  {
    id: 'hw-child-fallback',
    name: 'Daily Report: Alert Followup',
    enabled: 1,
    schedule_cron: '0 0 31 2 *',
    schedule_tz: 'UTC',
    session_target: 'isolated',
    agent_id: 'main',
    payload_kind: 'agentTurn',
    payload_message: 'Investigate the alert condition and propose remediation steps.',
    payload_model: null,
    payload_thinking: null,
    execution_intent: 'execute',
    execution_read_only: 0,
    run_timeout_ms: 300000,
    overlap_policy: 'skip',
    max_retries: 0,
    max_queued_dispatches: 25,
    max_pending_approvals: 10,
    max_trigger_fanout: 25,
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: '@owner_dm',
    delivery_opt_out_reason: null,
    delivery_guarantee: 'at-most-once',
    origin: 'system',
    parent_id: 'hw-parent-fallback',
    trigger_on: 'success',
    trigger_delay_s: 0,
    trigger_condition: 'contains:ALERT',
    approval_required: 1,
    approval_timeout_s: 1800,
    approval_auto: 'reject',
    context_retrieval: 'none',
    context_retrieval_limit: 5,
    output_store_limit_bytes: 65536,
    output_excerpt_limit_bytes: 2000,
    output_summary_limit_bytes: 5000,
    output_offload_threshold_bytes: 65536,
    preferred_session_key: null,
    identity_principal: null,
    identity_run_as: null,
    identity_attestation: null,
    contract_sandbox: null,
    contract_allowed_paths: null,
    contract_network: null,
    contract_max_cost_usd: null,
    contract_audit: null,
    identity_ref: null,
    identity_subject_kind: null,
    identity_subject_principal: null,
    identity_trust_level: null,
    identity_delegation_mode: null,
    identity: null,
    authorization_proof_ref: null,
    authorization_proof: null,
    authorization_ref: null,
    authorization: null,
    evidence_ref: null,
    evidence: null,
    contract_required_trust_level: null,
    contract_trust_enforcement: null,
    delete_after_run: 0,
  },
];

const helloWorldJobs = helloWorldOutput
  ? helloWorldOutput.jobs.map(toSchedulerSpec)
  : HELLO_WORLD_FALLBACK_JOBS;

// When using fallback, fix parent_id reference on child to match parent's id
if (!helloWorldOutput) {
  helloWorldJobs[1].parent_id = helloWorldJobs[0].id;
}

const usedSource = helloWorldOutput ? 'agentcli compile' : 'hardcoded fixture';
assert(helloWorldJobs.length >= 2, `hello-world has >= 2 jobs (via ${usedSource})`);

for (const jobSpec of helloWorldJobs) {
  let validated;
  let threw = false;
  try {
    validated = validateJobSpec(jobSpec, null, 'create');
  } catch (err) {
    threw = true;
    console.error(`    validateJobSpec threw for ${jobSpec.name}: ${err.message}`);
  }
  assert(!threw, `validateJobSpec succeeds for "${jobSpec.name}"`);

  if (!threw) {
    const created = createJob(validated);
    assert(created != null, `createJob succeeds for "${jobSpec.name}"`);

    const fetched = getJob(created.id);
    assert(fetched != null, `getJob returns job for "${jobSpec.name}"`);
    assert(fetched.name === jobSpec.name, `name round-trips for "${jobSpec.name}"`);
    assert(fetched.payload_message === jobSpec.payload_message, `payload_message round-trips for "${jobSpec.name}"`);
    assert(fetched.run_timeout_ms === (jobSpec.run_timeout_ms ?? 300000), `run_timeout_ms round-trips for "${jobSpec.name}"`);
    assert(fetched.origin === jobSpec.origin, `origin round-trips for "${jobSpec.name}"`);
    assert(fetched.session_target === (jobSpec.session_target || 'isolated'), `session_target round-trips for "${jobSpec.name}"`);
  }
}

// ===============================================================
// (b) Compiled triggered child validates with parent
// ===============================================================

console.log('\nTriggered child validates with parent:');

// The hello-world compile produces a parent (collect) and a triggered child (alert-followup).
// We already created them above; verify the child's trigger fields.

const parentSpec = helloWorldJobs[0];
const childSpec = helloWorldJobs[1];

const parentJob = getJob(parentSpec.id);
const childJob = getJob(childSpec.id);

assert(parentJob != null, 'parent job exists');
assert(childJob != null, 'child job exists');
if (childJob) {
  assert(childJob.parent_id === parentJob.id, 'child parent_id matches parent id');
  assert(childJob.trigger_on === 'success', 'child trigger_on is "success"');
  assert(childJob.trigger_condition === 'contains:ALERT', 'child trigger_condition is "contains:ALERT"');
  assert(childJob.schedule_cron === '0 0 31 2 *', 'child uses sentinel cron for triggered jobs');
}

// ===============================================================
// (c) v0.2 job spec validates and round-trips
// ===============================================================

console.log('\nv0.2 job spec validates and round-trips:');

const v02Spec = {
  id: 'test-v02-job',
  name: 'v02 test job',
  schedule_cron: '0 9 * * *',
  schedule_tz: 'UTC',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  payload_message: 'echo hello',
  run_timeout_ms: 30000,
  delivery_mode: 'none',
  origin: 'test',
  identity_ref: 'aws-role',
  identity_trust_level: 'supervised',
  identity_subject_kind: 'service',
  identity_subject_principal: 'arn:aws:iam::123:role/test',
  identity: JSON.stringify({ ref: 'aws-role', subject: { kind: 'service', principal: 'arn:aws:iam::123:role/test' }, trust: { level: 'supervised' } }),
  authorization_proof_ref: 'jwt-proof',
  authorization_proof: JSON.stringify({ method: 'signed-jwt', claims: { iss: 'test' } }),
  authorization_ref: 'opa-policy',
  authorization: JSON.stringify({ provider: 'opa', request: { action: 'execute' } }),
  evidence_ref: 'ssh-evidence',
  evidence: JSON.stringify({ provider: 'ssh', methods: ['payload-signature'] }),
  contract_required_trust_level: 'supervised',
  contract_trust_enforcement: 'block',
  contract_sandbox: 'strict',
  contract_allowed_paths: JSON.stringify(['/tmp', '/home']),
  contract_network: 'restricted',
  contract_max_cost_usd: 1.50,
  contract_audit: 'always',
};

let v02Validated;
let v02Threw = false;
try {
  v02Validated = validateJobSpec(v02Spec, null, 'create');
} catch (err) {
  v02Threw = true;
  console.error(`    validateJobSpec threw for v0.2 spec: ${err.message}`);
}
assert(!v02Threw, 'v0.2 spec validates without error');

if (!v02Threw) {
  const v02Created = createJob(v02Validated);
  assert(v02Created != null, 'v0.2 job created');

  const v02Fetched = getJob(v02Created.id);
  assert(v02Fetched != null, 'v0.2 job fetched');

  // Verify all v0.2 fields stored correctly
  assert(v02Fetched.identity_ref === 'aws-role', 'identity_ref round-trips');
  assert(v02Fetched.identity_trust_level === 'supervised', 'identity_trust_level round-trips');
  assert(v02Fetched.identity_subject_kind === 'service', 'identity_subject_kind round-trips');
  assert(v02Fetched.identity_subject_principal === 'arn:aws:iam::123:role/test', 'identity_subject_principal round-trips');

  // identity JSON blob
  const identityParsed = JSON.parse(v02Fetched.identity);
  assert(identityParsed.ref === 'aws-role', 'identity blob ref round-trips');
  assert(identityParsed.subject.kind === 'service', 'identity blob subject.kind round-trips');

  // authorization proof
  assert(v02Fetched.authorization_proof_ref === 'jwt-proof', 'authorization_proof_ref round-trips');
  const authProofParsed = JSON.parse(v02Fetched.authorization_proof);
  assert(authProofParsed.method === 'signed-jwt', 'authorization_proof blob round-trips');

  // authorization
  assert(v02Fetched.authorization_ref === 'opa-policy', 'authorization_ref round-trips');
  const authParsed = JSON.parse(v02Fetched.authorization);
  assert(authParsed.provider === 'opa', 'authorization blob round-trips');

  // evidence
  assert(v02Fetched.evidence_ref === 'ssh-evidence', 'evidence_ref round-trips');
  const evidenceParsed = JSON.parse(v02Fetched.evidence);
  assert(evidenceParsed.provider === 'ssh', 'evidence blob round-trips');

  // contract fields
  assert(v02Fetched.contract_required_trust_level === 'supervised', 'contract_required_trust_level round-trips');
  assert(v02Fetched.contract_trust_enforcement === 'block', 'contract_trust_enforcement round-trips');
  assert(v02Fetched.contract_sandbox === 'strict', 'contract_sandbox round-trips');
  const allowedPathsParsed = JSON.parse(v02Fetched.contract_allowed_paths);
  assert(Array.isArray(allowedPathsParsed) && allowedPathsParsed.includes('/tmp'), 'contract_allowed_paths round-trips');
  assert(v02Fetched.contract_network === 'restricted', 'contract_network round-trips');
  assert(v02Fetched.contract_max_cost_usd === 1.5, 'contract_max_cost_usd round-trips');
  assert(v02Fetched.contract_audit === 'always', 'contract_audit round-trips');
}

// ===============================================================
// (d) All agentcli examples compile and validate (if available)
// ===============================================================

console.log('\nAll agentcli examples compile and validate:');

if (agentcliAvailable && existsSync(agentcliExamples)) {
  const exampleFiles = readdirSync(agentcliExamples)
    .filter(f => f.endsWith('.json'))
    .sort();

  let examplesCompiled = 0;
  let examplesFailed = 0;

  for (const file of exampleFiles) {
    const manifestPath = resolve(agentcliExamples, file);
    const compiled = compileManifest(manifestPath);
    if (!compiled) {
      examplesFailed++;
      console.error(`    compile failed for ${file}`);
      continue;
    }
    examplesCompiled++;

    for (const compiledJob of compiled.jobs) {
      const spec = toSchedulerSpec(compiledJob);
      // Use a unique id to avoid collisions from reused stable IDs across examples
      spec.id = `example-${file}-${spec.id}`;
      let threw = false;
      try {
        // Validate only (skip createJob to avoid parent_id conflicts across examples)
        validateJobSpec(spec, null, 'create');
      } catch (err) {
        threw = true;
        console.error(`    validateJobSpec threw for ${file} / ${compiledJob.name}: ${err.message}`);
      }
      assert(!threw, `${file}: "${compiledJob.name}" validates`);
    }
  }

  assert(examplesCompiled > 0, `compiled at least one example (${examplesCompiled}/${exampleFiles.length})`);
  assert(examplesFailed === 0, `no examples failed to compile (${examplesFailed} failures)`);
} else {
  console.log('  (skipped: agentcli not available)');
}

// ===============================================================
// (e) Backward compat: v1-only spec still works on v0.2 schema
// ===============================================================

console.log('\nBackward compat -- v1-only spec works on v0.2 schema:');

const v1OnlySpec = {
  id: 'test-v1-only-job',
  name: 'v1 only test',
  schedule_cron: '*/15 * * * *',
  schedule_tz: 'UTC',
  session_target: 'shell',
  payload_kind: 'shellCommand',
  payload_message: 'uptime',
  run_timeout_ms: 60000,
  delivery_mode: 'none',
  origin: 'test',
};

let v1Validated;
let v1Threw = false;
try {
  v1Validated = validateJobSpec(v1OnlySpec, null, 'create');
} catch (err) {
  v1Threw = true;
  console.error(`    validateJobSpec threw for v1-only spec: ${err.message}`);
}
assert(!v1Threw, 'v1-only spec validates without error');

if (!v1Threw) {
  const v1Created = createJob(v1Validated);
  assert(v1Created != null, 'v1-only job created');

  const v1Fetched = getJob(v1Created.id);
  assert(v1Fetched != null, 'v1-only job fetched');

  // All v0.2 fields should be null
  assert(v1Fetched.identity_ref === null, 'identity_ref is null for v1-only job');
  assert(v1Fetched.identity_trust_level === null, 'identity_trust_level is null for v1-only job');
  assert(v1Fetched.identity_subject_kind === null, 'identity_subject_kind is null for v1-only job');
  assert(v1Fetched.identity_subject_principal === null, 'identity_subject_principal is null for v1-only job');
  assert(v1Fetched.identity_delegation_mode === null, 'identity_delegation_mode is null for v1-only job');
  assert(v1Fetched.identity === null, 'identity blob is null for v1-only job');
  assert(v1Fetched.authorization_proof_ref === null, 'authorization_proof_ref is null for v1-only job');
  assert(v1Fetched.authorization_proof === null, 'authorization_proof is null for v1-only job');
  assert(v1Fetched.authorization_ref === null, 'authorization_ref is null for v1-only job');
  assert(v1Fetched.authorization === null, 'authorization is null for v1-only job');
  assert(v1Fetched.evidence_ref === null, 'evidence_ref is null for v1-only job');
  assert(v1Fetched.evidence === null, 'evidence is null for v1-only job');
  assert(v1Fetched.contract_required_trust_level === null, 'contract_required_trust_level is null for v1-only job');
  assert(v1Fetched.contract_trust_enforcement === null, 'contract_trust_enforcement is null for v1-only job');

  // Core v1 fields should be present
  assert(v1Fetched.name === 'v1 only test', 'v1 name persists');
  assert(v1Fetched.schedule_cron === '*/15 * * * *', 'v1 schedule_cron persists');
  assert(v1Fetched.payload_message === 'uptime', 'v1 payload_message persists');
}

// ===============================================================
// (f) child_credential_policy field stored in scheduler
// ===============================================================

console.log('\nchild_credential_policy field stored in scheduler:');

{
  const ccpSpec = {
    id: 'test-ccp-stored',
    name: 'ccp storage test',
    schedule_cron: '0 9 * * *',
    schedule_tz: 'UTC',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'echo ccp',
    run_timeout_ms: 30000,
    delivery_mode: 'none',
    origin: 'test',
    child_credential_policy: 'downscope',
  };

  let ccpValidated;
  let ccpThrew = false;
  try {
    ccpValidated = validateJobSpec(ccpSpec, null, 'create');
  } catch (err) {
    ccpThrew = true;
    console.error(`    validateJobSpec threw for ccp spec: ${err.message}`);
  }
  assert(!ccpThrew, 'child_credential_policy spec validates without error');

  if (!ccpThrew) {
    const ccpCreated = createJob(ccpValidated);
    assert(ccpCreated != null, 'child_credential_policy job created');

    const ccpFetched = getJob(ccpCreated.id);
    assert(ccpFetched != null, 'child_credential_policy job fetched');
    assert(ccpFetched.child_credential_policy === 'downscope', 'child_credential_policy round-trips as downscope');
  }
}

// -- Summary ---------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (!agentcliAvailable) {
  console.log('(agentcli was not available -- dynamic compilation tests were skipped or used fallback fixtures)');
}
process.exit(failed > 0 ? 1 : 0);
