// dispatcher-strategies.js
// Strategy pattern for dispatchJob: each execution target returns a DispatchResult,
// and finalizeDispatch processes it uniformly.

import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import {
  assertValidAgentId,
  assertValidSessionKey,
  assertSessionKeyForAgent,
} from './identifiers.js';
import { assertArtifactMatchesJob } from './handoff-artifact.js';
import { validateArtifactBoundDelegation } from './delegation-runtime.js';
import { verifyArtifactBoundProof } from './proof-runtime.js';
import { resolveArtifactBoundIdentity } from './identity-runtime.js';
import {
  cleanupCredentialMaterialization,
  materializeCredentials,
} from './credential-runtime.js';
import { getProviderSession } from './provider-session-store.js';
import { negotiateCredentialCapabilities } from './capability-negotiation.js';
import { appendRuntimeEvent } from './runtime-events.js';
import {
  prepareArtifactBoundEvidence,
  persistPreparedArtifactBoundEvidence,
} from './evidence-runtime.js';

/**
 * DispatchResult shape (returned by every strategy):
 * {
 *   status: 'ok' | 'error' | 'skipped',
 *   summary: string,
 *   content: string,              // for delivery + trigger condition eval
 *   errorMessage: string | null,
 *   runFinishFields: object,      // extra fields for finishRun (shell_exit_code, etc.)
 *   deliveryOverride: string | null, // override delivery content (null = use content)
 *   skipDelivery: boolean,        // suppress delivery entirely
 *   skipJobUpdate: boolean,       // strategy handled job state itself
 *   skipChildren: boolean,        // don't fire triggered children
 *   skipDequeue: boolean,         // don't drain overlap queue
 *   idemAction: 'keep' | 'release' | 'noop', // what to do with idempotency key
 *   retryFiresChildren: boolean,  // whether retry path fires triggered children
 *   earlyReturn: boolean,         // finalize should skip everything (strategy fully handled it)
 * }
 */

export function makeDefaultResult() {
  return {
    status: 'ok',
    summary: '',
    content: '',
    errorMessage: null,
    runFinishFields: {},
    deliveryOverride: null,
    skipDelivery: false,
    skipJobUpdate: false,
    skipChildren: false,
    skipDequeue: false,
    skipAgentCleanup: true,
    idemAction: 'noop',
    retryFiresChildren: false,
    earlyReturn: false,
  };
}

/** Safely parse a JSON string. Returns parsed value or null on failure. */
function safeParse(str) {
  if (str == null || str === '') return null;
  try {
    return JSON.parse(str);
  } catch (_e) {
    return null;
  }
}

function approvalExecutionSummary(job, approval, extra = {}) {
  const payload = String(job.payload_message || '');
  const payloadHash = createHash('sha256').update(payload, 'utf8').digest('hex');
  return [
    `Approval ID: ${approval.id}`,
    `Gate: ${approval.gate_kind || 'job'}`,
    `Job: ${job.name} (${job.id})`,
    `Execution: ${job.session_target}/${job.payload_kind}; payload ${Buffer.byteLength(payload, 'utf8')} bytes; sha256:${payloadHash}`,
    `Origin: ${job.origin || 'unspecified'}`,
    `Schedule: ${job.schedule_kind || 'cron'}${job.schedule_cron ? ` ${job.schedule_cron} ${job.schedule_tz || 'UTC'}` : ''}`,
    `Parent: ${job.parent_id || 'none'}; child credential policy: ${job.child_credential_policy || 'none'}`,
    `Risk: ${approval.risk_level || 'unspecified'}; approver scope: ${approval.approver_scope || 'authenticated local OS user'}`,
    `Binding: ${approval.binding_hash || 'missing'}`,
    extra.reason ? `Decision context: ${extra.reason}` : null,
    `Approve: openclaw-scheduler approvals approve ${approval.id}`,
    `Reject: openclaw-scheduler approvals reject ${approval.id}`,
  ].filter(Boolean).join('\n');
}

function approvalUseSnapshot(approval) {
  if (!approval) return null;
  const decisionReason = approval.status === 'cancelled' || approval.status === 'timed_out'
    ? approval.cancelled_reason || approval.notes || null
    : approval.notes || (approval.status === 'approved' ? 'Approval granted' : null);
  return canonicalizeForHash({
    approval_id: approval.id,
    status: approval.status || null,
    decision_status: ['approved', 'dispatching', 'dispatched'].includes(approval.status)
      ? 'approved'
      : approval.status || null,
    gate_kind: approval.gate_kind || 'job',
    dispatch_queue_id: approval.dispatch_queue_id || null,
    approver: approval.resolved_by || null,
    resolved_by: approval.resolved_by || null,
    reason: decisionReason,
    notes: approval.notes || null,
    risk_level: approval.risk_level || null,
    approver_scope: approval.approver_scope || null,
    binding_hash: approval.binding_hash || null,
    requested_at: approval.requested_at || null,
    expires_at: approval.expires_at || null,
    resolved_at: approval.resolved_at || null,
    approved_at: approval.approved_at || null,
  });
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalizeForHash(value[key])]),
    );
  }
  return value;
}

function authorizationEscalationContext(job, outcomes, deps) {
  const persisted = redactOutcomesForPersistence(outcomes, deps);
  const identity = persisted.identity_resolved || null;
  const context = canonicalizeForHash({
    version: 1,
    authorization_ref: job.authorization_ref || null,
    authorization: persisted.authorization_decision || null,
    identity: identity
      ? {
        provider: identity.provider || null,
        subject_kind: identity.subject_kind || identity.session?.subject?.kind || null,
        principal: identity.principal || identity.session?.subject?.principal || null,
        trust_level: identity.trust_level || identity.session?.trust?.effective_level || null,
        delegation_mode: identity.delegation_mode || null,
      }
      : null,
    trust: persisted.trust_evaluation || null,
    delegation: persisted.delegation_validation || null,
    proof: persisted.authorization_proof_verification || null,
  });
  const canonical = JSON.stringify(context);
  return {
    version: 1,
    context_hash: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
    context,
  };
}

function interruptedEvidenceOutcomes(job) {
  const declaration = safeParse(job?.evidence);
  const bindings = new Set(
    Array.isArray(declaration?.payload?.bind) ? declaration.payload.bind : [],
  );
  const reason = 'Runtime evaluation did not complete before the terminal transition';
  const outcomes = {};
  if (bindings.has('identity')) {
    outcomes.identity_resolved = { source: 'runtime-interrupted', error: reason };
  }
  if (bindings.has('trust')) {
    outcomes.trust_evaluation = {
      decision: 'deny',
      enforcement: 'runtime-interrupted',
      reason,
    };
  }
  if (bindings.has('authorization')) {
    outcomes.authorization_decision = {
      decision: 'deny',
      source: 'runtime-interrupted',
      reason,
    };
  }
  if (bindings.has('authorization_proof')) {
    outcomes.authorization_proof_verification = {
      verified: false,
      source: 'runtime-interrupted',
      error: reason,
    };
  }
  if (bindings.has('delegation')) {
    outcomes.delegation_validation = {
      valid: false,
      acyclic: null,
      no_duplicate_hops: null,
      errors: [reason],
    };
  }
  if (bindings.has('credential_handoff')) {
    outcomes.credential_handoff_summary = {
      mode: null,
      bindings_count: 0,
      cleanup_required: false,
      error: reason,
    };
  }
  return outcomes;
}

async function sendApprovalNotification(job, approval, deps, extra = {}) {
  const { getDb, handleDelivery } = deps;
  const notification = getDb().transaction(() => {
    const current = getDb().prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id);
    if (current?.status !== 'pending') return null;
    return handleDelivery(
      { ...job, delivery_mode: 'announce-always' },
      approvalExecutionSummary(job, approval, extra),
      { db: getDb(), eventId: `approval:${approval.id}` },
    );
  }).immediate();
  await notification;
}

function shellSingleQuote(value) {
  return "'" + String(value ?? '').replaceAll("'", "'\\''") + "'";
}

function parseStructuredWatchdogPayload(text) {
  const direct = safeParse(text);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = text.slice(firstBrace, lastBrace + 1);
  const parsed = safeParse(candidate);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

const TERMINAL_WATCHDOG_STATUSES = new Set(['done', 'error', 'interrupted', 'spawn-warning']);

function normalizeWatchdogText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstWatchdogText(...values) {
  for (const value of values) {
    const text = normalizeWatchdogText(value);
    if (text) return text;
  }
  return null;
}

function resolveWatchdogTerminalPayload(stdout) {
  const text = normalizeWatchdogText(stdout);
  if (!text) return null;

  const parsed = parseStructuredWatchdogPayload(text);
  if (!parsed) return null;

  const status = typeof parsed.status === 'string' ? parsed.status : null;
  const terminal = parsed.terminal === true || (status ? TERMINAL_WATCHDOG_STATUSES.has(status) : false);
  if (!terminal) return null;

  const detail = firstWatchdogText(
    parsed.deliveryText,
    parsed.lastReply,
    parsed.error,
    parsed.summary,
    parsed.completion?.deliveryText,
    parsed.completion?.summary,
  );

  if (status && status !== 'done') {
    return {
      kind: 'failed',
      detail: detail || `Task ended with status ${status}.`,
    };
  }

  return {
    kind: 'completed',
    detail: detail || `Task reported terminal status ${status || 'done'}.`,
  };
}

function buildFireAndForgetDeliveryInstruction(job) {
  if (!job.delivery_mode || job.delivery_mode === 'none' || !job.delivery_channel || !job.delivery_to) {
    return '';
  }

  const schedulerCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const fromLabel = `scheduler-fire-and-forget:${job.id || job.name || 'job'}`;
  const baseCmd = [
    'node',
    shellSingleQuote(schedulerCliPath),
    'messages',
    'send',
    '--from', shellSingleQuote(fromLabel),
    '--to', 'main',
    '--channel', shellSingleQuote(job.delivery_channel),
    '--delivery-to', shellSingleQuote(job.delivery_to),
  ].join(' ');

  return [
    '\n[SYSTEM NOTE -- delivery]',
    'When you have completed this task, queue the result through the scheduler post office.',
    `Final result: ${baseCmd} --kind result --body "<final result>"`,
    `Progress update: ${baseCmd} --kind status --body "<brief progress update>"`,
    'Do NOT use the message tool, sessions_send, or any direct chat delivery.',
    'The inbox consumer will deliver queued messages durably to the configured target.',
    'Keep queued updates concise and actionable.',
    'If there is nothing noteworthy to report, do not queue a message.',
    '[END SYSTEM NOTE]\n',
  ].join('\n');
}

function getIdentityTrustLevel(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return identity.trust_level
    || identity.trust?.effective_level
    || identity.trust?.level
    || identity.session?.trust?.effective_level
    || identity.session?.trust?.level
    || identity.raw?.trust_level
    || identity.raw?.trust?.effective_level
    || identity.raw?.trust?.level
    || null;
}

function getJobTrustLevel(job, parsedIdentity = null) {
  const identityBlob = parsedIdentity || safeParse(job?.identity);
  return getIdentityTrustLevel(identityBlob) || job?.identity_trust_level || null;
}

function hasIdentityDeclaration(job) {
  if (!job) return false;
  return job.identity != null
    || job.identity_ref != null
    || job.identity_principal != null
    || job.identity_run_as != null
    || job.identity_attestation != null
    || job.identity_subject_kind != null
    || job.identity_subject_principal != null
    || job.identity_trust_level != null
    || job.identity_delegation_mode != null;
}

/**
 * Redact session credentials from v02Outcomes before DB persistence.
 * Uses the provider's describeSession() for redaction when available,
 * otherwise strips the credentials key directly.
 */
export function redactOutcomesForPersistence(outcomes, deps) {
  const resolved = outcomes?.identity_resolved;
  if (resolved?.provider_session_id && resolved.session) {
    const redacted = { ...outcomes };
    const ir = { ...resolved };
    const provider = ir.provider && deps?.getIdentityProvider?.(ir.provider);
    if (provider && typeof provider.describeSession === 'function') {
      const described = provider.describeSession(ir.session);
      ir.session = described && typeof described === 'object' && !Array.isArray(described)
        ? described
        : {};
    } else {
      ir.session = Object.fromEntries(
        ['id', 'subject', 'principal', 'scope', 'audience', 'resource', 'issuer',
          'trust', 'trust_level', 'expires_at', 'refresh_after', 'rotation_id',
          'delegation_chain']
          .filter(key => ir.session[key] != null)
          .map(key => [key, ir.session[key]]),
      );
    }
    ir.session = ir.session_summary && typeof ir.session_summary === 'object'
      ? ir.session_summary
      : ir.session;
    delete ir.session_summary;
    delete ir.raw;
    redacted.identity_resolved = ir;
    return redacted;
  }
  if (!resolved?.session?.credentials) return outcomes;
  const redacted = { ...outcomes };
  const ir = { ...redacted.identity_resolved };
  const session = { ...ir.session };

  const providerName = ir.provider;
  const provider = providerName && deps?.getIdentityProvider?.(providerName);
  if (provider && typeof provider.describeSession === 'function') {
    try {
      const described = provider.describeSession(session);
      ir.session = described && typeof described === 'object' && !Array.isArray(described)
        ? { ...described }
        : {};
      delete ir.session.credentials;
    } catch (_err) {
      delete session.credentials;
      ir.session = session;
    }
  } else {
    delete session.credentials;
    ir.session = session;
  }

  redacted.identity_resolved = ir;
  return redacted;
}

export async function cleanupDispatchMaterialization(job, ctx, deps = {}) {
  if (!ctx) return true;
  if (ctx.materializationCleanupResult) return ctx.materializationCleanupResult.cleaned;
  if (ctx.materializationCleanupInProgress) return false;
  ctx.materializationCleanupInProgress = true;

  const configuredRetryDelays = Array.isArray(deps.materializationCleanupRetryDelaysMs)
    ? deps.materializationCleanupRetryDelaysMs
    : [0, 250, 1000];
  const retryDelays = configuredRetryDelays.length > 0 ? configuredRetryDelays : [0];
  let attempts = 0;
  let lastError = null;
  try {
    if (ctx.v4CredentialMaterialization) {
      attempts += 1;
      try {
        await (deps.cleanupCredentialMaterialization || cleanupCredentialMaterialization)(
          ctx.v4CredentialMaterialization,
          {
            jobId: job.id,
            runId: ctx.run?.id,
            artifactDigest: job.handoff_artifact_digest,
          },
          { db: deps.getDb?.() },
        );
      } catch (error) {
        lastError = error;
        deps.log?.('error', `Credential cleanup failed for ${job.name}: ${error.message}`, {
          jobId: job.id,
          runId: ctx.run?.id || null,
        });
      }
    }
    if (!lastError && ctx.materializationCleanup) {
      const { provider, cleanupState } = ctx.materializationCleanup;
      if (typeof provider.cleanup === 'function') {
        for (const retryDelay of retryDelays) {
          if (retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
          attempts += 1;
          try {
            const outcome = await provider.cleanup(cleanupState, {
              env: process.env,
              cwd: process.cwd(),
            });
            if (outcome?.cleaned === false) {
              throw new Error(outcome.error || 'provider reported cleaned=false');
            }
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            deps.log?.('error', `Provider cleanup attempt ${attempts} failed for ${job.name}: ${error.message}`, {
              jobId: job.id,
              runId: ctx.run?.id || null,
              attempts,
            });
          }
        }
      } else {
        lastError = new Error('provider requires cleanup but does not implement cleanup()');
      }
    }
  } finally {
    deps.clearMaterializedEnvironment?.(ctx.materializedEnv);
    deps.clearMaterializedEnvironment?.(ctx.executionEnv);
    ctx.materializationCleanupInProgress = false;
  }

  if (ctx.credentialCleanupTracked && typeof deps.recordRunCredentialCleanupState === 'function') {
    const fence = ctx.dispatcherFence || deps.dispatcherFence || null;
    if (fence) {
      const status = lastError
        ? 'failed'
        : (ctx.materializationCleanup || ctx.v4CredentialMaterialization)
          ? 'cleaned'
          : 'not_required';
      try {
        const recorded = deps.recordRunCredentialCleanupState(ctx.run.id, {
          status,
          attempts,
          error: lastError?.message || null,
        }, {
          ...fence,
          allowAfterLeaseLoss: true,
        });
        if (!recorded) {
          deps.log?.('warn', `Credential cleanup state was not recorded for ${job.name}`, {
            jobId: job.id,
            runId: ctx.run.id,
            status,
          });
        }
      } catch (error) {
        deps.log?.('error', `Credential cleanup state persistence failed for ${job.name}: ${error.message}`, {
          jobId: job.id,
          runId: ctx.run.id,
          status,
        });
      }
    }
  }

  ctx.materializationCleanupResult = {
    cleaned: lastError == null,
    attempts,
    error: lastError?.message || null,
  };
  return ctx.materializationCleanupResult.cleaned;
}

function abortPreparedRun(job, run, summary, outcomes, state, deps, opts = {}) {
  const {
    finishRun, persistV02Outcomes, releaseIdempotencyKey, updateJobAfterRun,
    setDispatchStatus, handleTriggeredChildren, dequeueJob, log, getDb, updateJob,
    transitionRunTerminal, completeRunFenced, commitCompletionBookkeeping,
    shouldRunPostCompletionEffects,
  } = deps;
  const requestedStatus = opts.status || 'error';

  const applyAbort = () => {
    const fence = deps.dispatcherFence || null;
    const completion = completeRunFenced && transitionRunTerminal
      ? completeRunFenced({
        runId: run.id,
        status: requestedStatus,
        fields: { summary, error_message: summary },
        ownerId: fence?.ownerId || null,
        fencingToken: fence?.fencingToken || null,
        transitionRunTerminal,
      })
      : (() => {
        const finished = finishRun(run.id, requestedStatus, { summary, error_message: summary });
        return {
          changed: true,
          run: finished,
          status: finished?.status || requestedStatus,
          cancelled: finished?.status === 'cancelled',
          fenced: false,
        };
      })();
    const allowEffects = shouldRunPostCompletionEffects
      ? shouldRunPostCompletionEffects(completion)
      : completion.changed && !completion.cancelled;
    if (state.idemKey && !completion.fenced) releaseIdempotencyKey(state.idemKey);
    if (completion.changed && !completion.fenced) {
      const persistedOutcomes = {
        ...interruptedEvidenceOutcomes(job),
        ...redactOutcomesForPersistence(outcomes || {}, deps),
      };
      if (Number(job.handoff_version) !== 4
        && run.evidence_required === 1
        && (job.evidence || job.evidence_ref)) {
        const emptyHash = `sha256:${createHash('sha256').update('', 'utf8').digest('hex')}`;
        const evidence = deps.generateEvidence({
          ...job,
          evidence: run.evidence_declaration_snapshot,
          evidence_ref: run.evidence_ref_snapshot,
        }, {
          id: run.id,
          status: completion.status || 'error',
          execution_snapshot: JSON.parse(run.evidence_execution_snapshot),
          summary,
          stdout_sha256: emptyHash,
          stderr_sha256: emptyHash,
          stdout_bytes: 0,
          stderr_bytes: 0,
          exit_code: null,
          signal: null,
          timed_out: false,
          structured_output: null,
          structured_output_valid: null,
        }, persistedOutcomes);
        persistedOutcomes.evidence_record = evidence;
      }
      persistV02Outcomes(run.id, persistedOutcomes);
    }
    if (!allowEffects) {
      if (state.dispatchRecord) {
        setDispatchStatus(state.dispatchRecord.id, completion.cancelled ? 'cancelled' : 'failed');
      }
      return { completion, dequeued: false };
    }
    if (!opts.skipJobUpdate) updateJobAfterRun(job, requestedStatus);
    if (opts.disableJob && Number(job.handoff_version) === 4) {
      appendRuntimeEvent('job.quarantine.required', {
        jobId: job.id,
        runId: run.id,
        handoffArtifactDigest: job.handoff_artifact_digest,
        payload: {
          reason: summary,
          job_disabled: false,
          operator_action_required: true,
        },
      }, { db: getDb() });
      log(
        'warn',
        `Handoff v4 job ${job.name} requires operator quarantine; its artifact-bound enabled state was not mutated`,
        { jobId: job.id, runId: run.id },
      );
    } else if (opts.disableJob && typeof updateJob === 'function') {
      updateJob(job.id, { enabled: 0 });
    }
    if (state.dispatchRecord) setDispatchStatus(state.dispatchRecord.id, 'done');
    if (!opts.skipChildren) handleTriggeredChildren(job.id, requestedStatus, summary, run.id);
    return { completion, dequeued: dequeueJob(job.id) };
  };
  const outcome = commitCompletionBookkeeping
    ? commitCompletionBookkeeping(getDb(), applyAbort)
    : applyAbort();
  if (outcome.dequeued) log('info', `Dequeued pending dispatch for ${job.name}`);
  return null;
}

export function applyStructuredOutputContract(job, result, opts = {}) {
  const format = job.output_format || null;
  const { structuredOutputSource, ...publicResult } = result;
  if (!format) return publicResult;
  const rawOutput = String(structuredOutputSource ?? result.runFinishFields?.shell_stdout ?? result.content ?? '');
  const rawBytes = Buffer.byteLength(rawOutput, 'utf8');
  const rawSha256 = `sha256:${createHash('sha256').update(rawOutput, 'utf8').digest('hex')}`;
  const runFinishFields = {
    ...result.runFinishFields,
    output_format: format,
    structured_output_bytes: rawBytes,
    structured_output_sha256: rawSha256,
    structured_output_path: null,
  };
  if (result.status !== 'ok') {
    return {
      ...publicResult,
      runFinishFields: {
        ...runFinishFields,
        structured_output: null,
        structured_output_valid: null,
        structured_output_warning: null,
      },
    };
  }

  let structuredOutput;
  try {
    if ((format === 'json' || format === 'ndjson') && String(rawOutput).trim() === '') {
      structuredOutput = null;
    } else if (format === 'json') {
      try {
        structuredOutput = JSON.stringify(JSON.parse(String(rawOutput)));
      } catch (error) {
        throw new Error('invalid JSON', { cause: error });
      }
    } else if (format === 'ndjson') {
      const lines = String(rawOutput).split(/\r?\n/).filter(line => line.trim().length > 0);
      structuredOutput = JSON.stringify(lines.map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid JSON on line ${index + 1}`, { cause: error });
        }
      }));
    } else if (format === 'text') {
      structuredOutput = String(rawOutput);
    } else {
      throw new Error(`unsupported output format ${format}`);
    }
  } catch (error) {
    const message = `Output format validation failed for ${format}: ${error.message}`;
    return {
      ...publicResult,
      runFinishFields: {
        ...runFinishFields,
        structured_output: null,
        structured_output_valid: 0,
        structured_output_warning: message,
      },
    };
  }

  const structuredBytes = structuredOutput == null ? 0 : Buffer.byteLength(structuredOutput, 'utf8');
  let structuredOutputPath = null;
  let persistedStructuredOutput = structuredOutput;
  if (structuredBytes > (job.output_store_limit_bytes || 65536)) {
    try {
      structuredOutputPath = opts.storeRunArtifact?.('structured-output', opts.runId, rawOutput) || null;
    } catch (error) {
      const storageError = new Error('Structured output artifact storage failed', { cause: error });
      return {
        ...publicResult,
        status: 'error',
        summary: storageError.message,
        content: storageError.message,
        errorMessage: storageError.message,
        skipChildren: true,
        idemAction: 'release',
        runFinishFields: {
          ...runFinishFields,
          structured_output: null,
          structured_output_valid: 1,
          structured_output_warning: storageError.message,
          structured_output_path: null,
        },
      };
    }
    if (!structuredOutputPath) {
      const storageError = 'Structured output artifact storage returned no reference';
      return {
        ...publicResult,
        status: 'error',
        summary: storageError,
        content: storageError,
        errorMessage: storageError,
        skipChildren: true,
        idemAction: 'release',
        runFinishFields: {
          ...runFinishFields,
          structured_output: null,
          structured_output_valid: 1,
          structured_output_warning: storageError,
          structured_output_path: null,
        },
      };
    }
    persistedStructuredOutput = null;
  }
  return {
    ...publicResult,
    runFinishFields: {
      ...runFinishFields,
      structured_output: persistedStructuredOutput,
      structured_output_valid: 1,
      structured_output_warning: null,
      structured_output_path: structuredOutputPath,
    },
  };
}

/** Execute an agentcli post-success verification contract before terminal effects. */
export async function applyVerificationContract(job, ctx, result, deps) {
  if (result.status !== 'ok' || !job.verify_shell) return result;
  const startedAt = Date.now();
  const timeoutMs = (job.verify_timeout_s ?? 30) * 1000;
  deps.onVerificationStart?.(ctx.run.id, timeoutMs);
  let shellExec;
  try {
    shellExec = await deps.runShellCommand(
      job.verify_shell,
      timeoutMs,
      ctx.executionEnv || null,
      {
        signal: ctx.abortSignal || null,
        envPolicy: job.shell_env_policy || 'minimal',
        maxBuffer: 1024 * 1024,
        onProcess: processInfo => {
          if (!deps.recordRunProcess) return;
          const recorded = deps.recordRunProcess(ctx.run.id, processInfo, ctx.dispatcherFence || {});
          if (!recorded) throw new Error('Run ownership or cancellation changed before verification process start');
        },
        onProcessTerminated: () => deps.recordRunProcessTerminated?.(
          ctx.run.id,
          ctx.dispatcherFence || {},
        ),
      },
    );
  } finally {
    deps.onVerificationEnd?.(ctx.run.id);
  }
  const stdout = String(shellExec.stdout || '');
  const stderr = String(shellExec.stderr || '');
  const verification = {
    passed: shellExec.exitCode === 0 && !shellExec.timedOut && !shellExec.aborted && !shellExec.error,
    status: shellExec.aborted
      ? 'cancelled'
      : shellExec.timedOut
        ? 'timed_out'
        : shellExec.exitCode === 0 && !shellExec.error
          ? 'passed'
          : 'failed',
    on_failure: job.verify_on_failure || 'error',
    exit_code: shellExec.exitCode ?? null,
    signal: shellExec.signal || null,
    timed_out: Boolean(shellExec.timedOut),
    duration_ms: Math.max(0, Date.now() - startedAt),
    stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
    stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
    stdout_sha256: `sha256:${createHash('sha256').update(stdout, 'utf8').digest('hex')}`,
    stderr_sha256: `sha256:${createHash('sha256').update(stderr, 'utf8').digest('hex')}`,
    error: shellExec.error?.message || null,
  };
  const runFinishFields = {
    ...result.runFinishFields,
    verification_result: verification,
  };
  if (verification.passed) return { ...result, runFinishFields };
  if (verification.status === 'cancelled') {
    if (!deps.isRunCancellationRequested?.(ctx.run.id)) {
      return {
        ...result,
        preserveForRecovery: true,
        runFinishFields: {
          ...runFinishFields,
          verification_result: {
            ...verification,
            status: 'interrupted',
            error: ctx.abortKind
              ? `Verification interrupted by dispatcher lifecycle (${ctx.abortKind})`
              : 'Verification interrupted by dispatcher lifecycle',
          },
        },
      };
    }
    return {
      ...result,
      status: 'cancelled',
      summary: 'Run cancelled during post-execution verification',
      content: 'Run cancelled during post-execution verification',
      errorMessage: 'Run cancelled during post-execution verification',
      skipDelivery: true,
      skipChildren: true,
      idemAction: 'release',
      runFinishFields,
    };
  }
  const failure = verification.timed_out
    ? `Verification timed out after ${timeoutMs}ms`
    : `Verification failed${verification.exit_code == null ? '' : ` with exit code ${verification.exit_code}`}`;
  if ((job.verify_on_failure || 'error') === 'warn') {
    const existingContext = result.runFinishFields?.context_summary;
    return {
      ...result,
      runFinishFields: {
        ...runFinishFields,
        context_summary: {
          ...(existingContext && typeof existingContext === 'object' && !Array.isArray(existingContext)
            ? existingContext
            : {}),
          verification_warning: failure,
        },
      },
    };
  }
  return {
    ...result,
    status: 'error',
    summary: failure,
    content: failure,
    errorMessage: failure,
    skipChildren: true,
    idemAction: 'release',
    runFinishFields,
  };
}

/**
 * Uniform post-execution ceremony. Processes the DispatchResult from any strategy.
 *
 * @param {object} job - The job record
 * @param {object} ctx - DispatchContext from prepareDispatch
 * @param {object} result - DispatchResult from the strategy
 * @param {object} deps - Injected dependencies
 */
export async function finalizeDispatch(job, ctx, result, deps) {
  const {
    finishRun, updateIdempotencyResultHash, releaseIdempotencyKey,
    setAgentStatus, handleDelivery, shouldRetry, scheduleRetry,
    getDb, updateJobAfterRun, setDispatchStatus, handleTriggeredChildren,
    dequeueJob, log, transitionRunTerminal, completeRunFenced,
    commitCompletionBookkeeping, shouldRunPostCompletionEffects,
    enqueueDispatch, getJob, getDispatchBacklogCount, sqliteNow,
    releaseDispatch, updateJob, deleteJob,
  } = deps;

  if (result.earlyReturn) {
    await cleanupDispatchMaterialization(job, ctx, deps);
    return;
  }

  result = applyStructuredOutputContract(job, result, {
    runId: ctx.run.id,
    storeRunArtifact: deps.storeRunArtifact,
  });
  result = await applyVerificationContract(job, ctx, result, deps);
  if (result.preserveForRecovery) {
    ctx.preserveForRecovery = true;
    await cleanupDispatchMaterialization(job, ctx, deps);
    return;
  }

  const materializationCleaned = await cleanupDispatchMaterialization(job, ctx, deps);
  if (!materializationCleaned) {
    const attempts = ctx.materializationCleanupResult?.attempts || 1;
    const cleanupSummary = `Credential cleanup failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
    const existingContext = result.runFinishFields?.context_summary;
    result = {
      ...result,
      status: 'error',
      summary: cleanupSummary,
      content: cleanupSummary,
      errorMessage: cleanupSummary,
      cleanupFailed: true,
      skipChildren: true,
      idemAction: 'release',
      runFinishFields: {
        ...result.runFinishFields,
        context_summary: {
          ...(existingContext && typeof existingContext === 'object' && !Array.isArray(existingContext)
            ? existingContext
            : {}),
          credential_cleanup: {
            status: 'failed',
            attempts,
            operator_action_required: true,
          },
        },
      },
    };
  }

  const currentRunContext = getDb
    ? safeParse(getDb().prepare('SELECT context_summary FROM runs WHERE id = ?').get(ctx.run.id)?.context_summary)
    : null;
  const resultRunContext = typeof result.runFinishFields?.context_summary === 'string'
    ? safeParse(result.runFinishFields.context_summary)
    : result.runFinishFields?.context_summary;
  const mergedRunContext = {
    ...(currentRunContext && typeof currentRunContext === 'object' && !Array.isArray(currentRunContext)
      ? currentRunContext
      : {}),
    ...(resultRunContext && typeof resultRunContext === 'object' && !Array.isArray(resultRunContext)
      ? resultRunContext
      : {}),
    ...(currentRunContext?.credential_cleanup
      ? { credential_cleanup: currentRunContext.credential_cleanup }
      : {}),
  };
  let finishFields = {
    summary: result.summary,
    error_message: result.errorMessage,
    ...result.runFinishFields,
    ...(Object.keys(mergedRunContext).length > 0 ? { context_summary: mergedRunContext } : {}),
  };
  let preparedV4Evidence = null;
  if (Number(job.handoff_version) === 4 && ctx.v4Artifact) {
    try {
      const evidenceTimestamp = new Date().toISOString();
      const currentRun = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(ctx.run.id);
      const startedAt = currentRun.started_at
        ? Date.parse(currentRun.started_at.includes('T')
          ? currentRun.started_at
          : `${currentRun.started_at.replace(' ', 'T')}Z`)
        : Date.now();
      const evidenceDurationMs = Number.isInteger(finishFields.duration_ms)
        && finishFields.duration_ms >= 0
        ? finishFields.duration_ms
        : Math.max(0, Date.parse(evidenceTimestamp) - (
            Number.isFinite(startedAt) ? startedAt : Date.parse(evidenceTimestamp)
          ));
      finishFields = { ...finishFields, duration_ms: evidenceDurationMs };
      preparedV4Evidence = await (
        deps.prepareArtifactBoundEvidence || prepareArtifactBoundEvidence
      )(job, ctx.v4Artifact, {
        ...currentRun,
        ...finishFields,
        status: result.status,
        finished_at: evidenceTimestamp,
        terminal_transition_at: evidenceTimestamp,
      }, {
        db: getDb(),
        env: process.env,
        cwd: process.cwd(),
        timestamp: evidenceTimestamp,
        evidenceOutput: result.evidenceOutput || null,
        agentcli: deps.agentcliEvidenceRuntime,
        allowedSignersPath: deps.allowedSignersPath,
      });
    } catch (error) {
      const evidenceRequired = ctx.v4Artifact.payload.evidence?.verify_required === true;
      const evidenceFailure = String(error.message || 'evidence provider failed').slice(0, 500);
      appendRuntimeEvent('evidence.failed', {
        jobId: job.id,
        runId: ctx.run.id,
        handoffArtifactDigest: job.handoff_artifact_digest,
        sourceRunId: ctx.run.source_run_id,
        sourceRunHandoffArtifactDigest: ctx.run.source_run_handoff_artifact_digest,
        payload: {
          required: evidenceRequired,
          code: error.code || 'EVIDENCE_VERIFICATION_FAILED',
          reason: evidenceFailure,
        },
      }, { db: getDb() });
      if (evidenceRequired) {
        const reason = `Required handoff v4 evidence failed: ${evidenceFailure}`;
        result = {
          ...result,
          status: 'recovery_blocked',
          summary: reason,
          content: reason,
          errorMessage: reason,
          skipDelivery: true,
          skipJobUpdate: true,
          skipChildren: true,
          skipDequeue: true,
          disableJob: true,
          idemAction: 'release',
        };
        finishFields = {
          ...finishFields,
          summary: reason,
          error_message: reason,
          context_summary: {
            ...mergedRunContext,
            evidence: {
              status: 'failed',
              error: evidenceFailure,
              operator_action_required: true,
            },
          },
        };
      } else {
        finishFields = {
          ...finishFields,
          context_summary: {
            ...mergedRunContext,
            evidence: {
              status: 'warning',
              error: evidenceFailure,
              operator_action_required: false,
            },
          },
        };
      }
    }
  }

  const fence = ctx.dispatcherFence || deps.dispatcherFence || null;
  const enqueueCompletionDelivery = (retryScheduled) => {
    if (result.skipDelivery) return null;
    const deliveryContent = result.deliveryOverride ?? result.content;
    const shouldAnnounce = ['announce', 'announce-always'].includes(job.delivery_mode)
      && deliveryContent?.trim();
    if (!shouldAnnounce) return null;
    const jobWillBeDeleted = result.status === 'ok' && Boolean(job.delete_after_run);
    const deliveryJob = jobWillBeDeleted ? { ...job, id: null } : job;
    const deliveryOpts = {
      ...(jobWillBeDeleted ? { eventId: `run:${ctx.run.id}` } : { runId: ctx.run.id }),
      ...(result.imageAttachments?.length > 0
        ? { imageAttachments: result.imageAttachments }
        : {}),
    };
    if (result.deliveryOverride) {
      return handleDelivery(deliveryJob, result.deliveryOverride, deliveryOpts);
    }
    if (result.status === 'error') {
      const retryLabel = retryScheduled ? 'will retry' : 'no retry scheduled';
      return handleDelivery(
        deliveryJob,
        `\u26a0\ufe0f Job soft-failed (${retryLabel}): ${job.name}\n\n${deliveryContent}`,
        deliveryOpts,
      );
    }
    return handleDelivery(deliveryJob, deliveryContent, deliveryOpts);
  };

  const performBookkeeping = () => {
    const completion = completeRunFenced && transitionRunTerminal
      ? completeRunFenced({
        runId: ctx.run.id,
        status: result.status,
        fields: finishFields,
        ownerId: fence?.ownerId || null,
        fencingToken: fence?.fencingToken || null,
        transitionRunTerminal,
      })
      : (() => {
        const run = finishRun(ctx.run.id, result.status, finishFields);
        return { changed: true, run, status: run?.status || result.status, cancelled: false, fenced: false };
      })();
    const runPostCompletionEffects = shouldRunPostCompletionEffects
      ? shouldRunPostCompletionEffects(completion)
      : completion.changed && !completion.cancelled;

    if (completion.changed && !completion.fenced && preparedV4Evidence) {
      (deps.persistPreparedArtifactBoundEvidence || persistPreparedArtifactBoundEvidence)(
        preparedV4Evidence,
        { db: getDb() },
      );
    }

    if (completion.changed && !completion.fenced && ctx.v02Outcomes) {
      const { generateEvidence, persistV02Outcomes } = deps;
      const persistedOutcomes = redactOutcomesForPersistence(ctx.v02Outcomes, deps);
      if (Number(job.handoff_version) !== 4
        && ctx.run.evidence_required === 1
        && (job.evidence || job.evidence_ref)) {
        const runMetadata = {
          id: ctx.run.id,
          status: completion.status,
          execution_snapshot: JSON.parse(ctx.run.evidence_execution_snapshot),
          summary: result.summary || null,
          output: result.content ?? null,
          stdout_sha256: result.evidenceOutput?.stdout_sha256 || null,
          stderr_sha256: result.evidenceOutput?.stderr_sha256 || null,
          stdout_bytes: result.evidenceOutput?.stdout_bytes
            ?? result.runFinishFields?.shell_stdout_bytes
            ?? (result.content == null ? null : Buffer.byteLength(String(result.content), 'utf8')),
          stderr_bytes: result.evidenceOutput?.stderr_bytes ?? result.runFinishFields?.shell_stderr_bytes ?? null,
          exit_code: result.runFinishFields?.shell_exit_code ?? null,
          signal: result.runFinishFields?.shell_signal ?? null,
          timed_out: result.runFinishFields?.shell_timed_out === 1 || completion.status === 'timeout',
          structured_output: result.runFinishFields?.structured_output ?? null,
          structured_output_valid: result.runFinishFields?.structured_output_valid ?? null,
          structured_output_warning: result.runFinishFields?.structured_output_warning ?? null,
          structured_output_bytes: result.runFinishFields?.structured_output_bytes ?? null,
          structured_output_sha256: result.runFinishFields?.structured_output_sha256 ?? null,
          structured_output_path: result.runFinishFields?.structured_output_path ?? null,
          verification_result: result.runFinishFields?.verification_result ?? null,
        };
        const evidence = generateEvidence({
          ...job,
          evidence: ctx.run.evidence_declaration_snapshot,
          evidence_ref: ctx.run.evidence_ref_snapshot,
        }, runMetadata, persistedOutcomes);
        if (evidence) {
          ctx.v02Outcomes.evidence_record = evidence;
          persistedOutcomes.evidence_record = evidence;
        }
      }
      persistV02Outcomes(ctx.run.id, persistedOutcomes);
    }

    if (!runPostCompletionEffects) {
      if (ctx.idemKey && !completion.fenced) releaseIdempotencyKey(ctx.idemKey);
      if (!completion.fenced && !result.skipAgentCleanup && job.agent_id) {
        setAgentStatus(job.agent_id, 'idle', null);
      }
      if (ctx.dispatchRecord) {
        setDispatchStatus(ctx.dispatchRecord.id, completion.cancelled ? 'cancelled' : 'failed', {
          lastError: completion.cancelled ? 'Run cancelled' : 'Run completion lost dispatcher fence',
        });
      }
      return { completion, suppressed: true, retry: null, drainDispatch: null, dequeued: false };
    }

    if (ctx.idemKey) {
      if (result.idemAction === 'keep') updateIdempotencyResultHash(ctx.idemKey, result.content);
      else if (result.idemAction === 'release') releaseIdempotencyKey(ctx.idemKey);
    }
    if (!result.skipAgentCleanup && job.agent_id) setAgentStatus(job.agent_id, 'idle', null);

    if (result.deferUntil) {
      if (ctx.dispatchRecord) releaseDispatch(ctx.dispatchRecord.id, result.deferUntil);
      else updateJob(job.id, { next_run_at: result.deferUntil });
      return {
        completion,
        suppressed: false,
        retry: null,
        drainDispatch: null,
        dequeued: false,
        delivery: null,
        deferred: true,
      };
    }

    if (result.drainRetry) {
      const freshJob = getJob(job.id);
      const canDrainRetry = freshJob && freshJob.enabled
        && (ctx.run.retry_count || 0) < 1
        && !(freshJob.overlap_policy === 'skip' && getDispatchBacklogCount(job.id) > 0);
      let drainDispatch = null;
      if (canDrainRetry) {
        drainDispatch = enqueueDispatch(job.id, {
          kind: 'retry',
          scheduled_for: sqliteNow(90000),
          source_run_id: ctx.run.id,
          retry_of_run_id: ctx.run.id,
        });
        getDb().prepare('UPDATE runs SET retry_count = 1 WHERE id = ?').run(ctx.run.id);
      }
      if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
      return {
        completion,
        suppressed: false,
        retry: null,
        drainDispatch,
        dequeued: !result.skipDequeue && dequeueJob(job.id),
        delivery: null,
      };
    }

    if (result.status === 'error' && !result.cleanupFailed && shouldRetry(job, ctx.run.id)) {
      const retry = scheduleRetry(job, ctx.run.id);
      if (retry.dispatch) {
        getDb().prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(retry.retryCount, ctx.run.id);
        if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
        const dequeued = !result.skipDequeue && dequeueJob(job.id);
        if (result.retryFiresChildren && !result.skipChildren) {
          handleTriggeredChildren(job.id, 'error', result.content, ctx.run.id, ' on soft failure');
        }
        const delivery = enqueueCompletionDelivery(true);
        return { completion, suppressed: false, retry, drainDispatch: null, dequeued, delivery };
      }
    }

    if (!result.skipJobUpdate) updateJobAfterRun(job, result.status);
    if (result.cleanupFailed || result.disableJob) {
      updateJob(job.id, { enabled: 0 });
    }
    if (ctx.dispatchRecord) setDispatchStatus(ctx.dispatchRecord.id, 'done');
    if (!result.skipChildren) {
      handleTriggeredChildren(job.id, result.status, result.content, ctx.run.id);
    }
    if (result.selfDestructJob) {
      updateJob(job.id, { enabled: 0 });
      deleteJob(job.id);
      log('info', `Watchdog self-destructed after durable completion: ${job.name}`, { jobId: job.id });
      return {
        completion,
        suppressed: false,
        retry: null,
        drainDispatch: null,
        dequeued: false,
        delivery: null,
      };
    }
    const dequeued = !result.skipDequeue && dequeueJob(job.id);
    const delivery = enqueueCompletionDelivery(false);
    return { completion, suppressed: false, retry: null, drainDispatch: null, dequeued, delivery };
  };

  const bookkeeping = commitCompletionBookkeeping
    ? commitCompletionBookkeeping(getDb(), performBookkeeping)
    : performBookkeeping();

  if (bookkeeping.suppressed) {
    log(bookkeeping.completion.cancelled ? 'info' : 'warn',
      bookkeeping.completion.cancelled
        ? `Suppressed post-run effects for cancelled job: ${job.name}`
        : `Suppressed post-run effects after completion fence loss: ${job.name}`,
      { runId: ctx.run.id, jobId: job.id });
    await cleanupDispatchMaterialization(job, ctx, deps);
    return;
  }

  if (bookkeeping.dequeued) log('info', `Dequeued pending dispatch for ${job.name}`);
  if (bookkeeping.drainDispatch) {
    log('info', `[drain-retry] scheduling retry for ${job.name} in 90s`, {
      jobId: job.id,
      runId: ctx.run.id,
      dispatchId: bookkeeping.drainDispatch.id,
    });
  } else if (result.drainRetry) {
    log('info', `[drain-retry] retry not scheduled for ${job.name}`, {
      jobId: job.id,
      runId: ctx.run.id,
    });
  } else if (bookkeeping.retry) {
    log('info', `Scheduling retry ${bookkeeping.retry.retryCount}/${job.max_retries} in ${bookkeeping.retry.delaySec}s`, {
      jobId: job.id, runId: ctx.run.id,
    });
    log('info', `Failed: ${job.name} (retry scheduled)`, { runId: ctx.run.id });
  } else if (result.status === 'error' && !result.cleanupFailed && shouldRetry(job, ctx.run.id)) {
    log('warn', `Retry skipped for ${job.name} -- dispatch backlog limit reached`, {
      jobId: job.id, runId: ctx.run.id,
      maxQueuedDispatches: job.max_queued_dispatches || 25,
    });
  }
  await cleanupDispatchMaterialization(job, ctx, deps);
}

// -- Phase 1: Guards + run creation --------------------------

/**
 * DispatchContext shape (returned by prepareDispatch):
 * {
 *   dispatchRecord: object | null,
 *   idemKey: string | null,
 *   run: object,               // the created run record
 *   retryCount: number,
 *   dispatchKind: string | null,
 *   isChainDispatch: boolean,
 * }
 */

/**
 * Phase 1: Guards + run creation. Returns DispatchContext or null (guard rejected).
 *
 * @param {object} job
 * @param {object} opts - { approvalBypass, dispatchRecord }
 * @param {object} deps - Injected dependencies
 * @returns {object|null}
 */
export async function prepareDispatch(job, opts, deps) {
  const {
    claimDispatch, releaseDispatch, setDispatchStatus,
    countPendingApprovalsForJob, getPendingApproval,
    createApproval, getApprovalForDispatch, beginApprovalDispatch,
    markApprovalDispatched, cancelApprovalForDispatch,
    createRun, getRun,
    hasRunningRunForPool, hasRunningRun,
    enqueueJob, getDispatchBacklogCount,
    generateIdempotencyKey, generateChainIdempotencyKey,
    generateRunNowIdempotencyKey, claimIdempotencyKey,
    getDb,
    sqliteNow, adaptiveDeferralMs,
    handleDelivery, advanceNextRun,
    updateJobAfterRun,
    TICK_INTERVAL_MS,
    log,
    evaluateGovernance = () => ({ allowed: true, violations: [], warnings: [] }),
    buildShellEnvironment = (_job, materializedEnv) => materializedEnv || null,
    summarizeGovernance = () => null,
  } = deps;

  let approvalBypass = opts.approvalBypass === true;
  let dispatchRecord = opts.dispatchRecord || null;
  let approvedGate = null;

  // Claim pending dispatch
  if (dispatchRecord && dispatchRecord.status === 'pending') {
    dispatchRecord = claimDispatch(dispatchRecord.id);
    if (!dispatchRecord) {
      log('debug', `Skipping claimed dispatch for ${job.name}`, { dispatchId: opts.dispatchRecord.id });
      return null;
    }
  }

  if (dispatchRecord && getApprovalForDispatch) {
    approvedGate = getApprovalForDispatch(dispatchRecord.id);
    if (approvedGate?.status === 'approved') approvalBypass = true;
  }

  const completeCurrentDispatch = (status = 'done') => {
    if (!dispatchRecord) return null;
    return setDispatchStatus(dispatchRecord.id, status);
  };

  const hasCurrentDispatchClaim = () => {
    if (!dispatchRecord) return true;
    const current = getDb().prepare(`
      SELECT status, claim_owner, claim_token
      FROM job_dispatch_queue
      WHERE id = ?
    `).get(dispatchRecord.id);
    if (!current || current.status !== 'claimed') return false;
    return (current.claim_owner ?? null) === (dispatchRecord.claim_owner ?? null)
      && (current.claim_token ?? null) === (dispatchRecord.claim_token ?? null);
  };

  const dispatchKind = dispatchRecord?.dispatch_kind || null;
  const isChainDispatch = dispatchKind === 'chain';
  const dispatchBacklogDepth = getDispatchBacklogCount(job.id);

  // HITL approval gate
  if (job.approval_required && !approvalBypass) {
    if (!dispatchRecord) {
      const error = new Error(`Approval-gated job ${job.name} requires a durable dispatch record`);
      error.code = 'APPROVAL_DISPATCH_REQUIRED';
      throw error;
    }
    const pendingApprovalCount = countPendingApprovalsForJob(job.id);
    if (pendingApprovalCount >= (job.max_pending_approvals || 10)) {
      completeCurrentDispatch('cancelled');
      log('warn', `Approval backlog limit reached for ${job.name}`, {
        jobId: job.id,
        pendingApprovals: pendingApprovalCount,
        maxPendingApprovals: job.max_pending_approvals || 10,
      });
      return null;
    }
    const existing = getPendingApproval(job.id);
    if (existing) {
      releaseDispatch(dispatchRecord.id, sqliteNow(adaptiveDeferralMs(dispatchBacklogDepth)));
      log('debug', `Skipping ${job.name} -- approval already pending`, {
        approvalId: existing.id,
        dispatchId: dispatchRecord?.id || null,
        deferredMs: adaptiveDeferralMs(dispatchBacklogDepth),
      });
      return null;
    }
    const pendingGate = getDb().transaction(() => {
      if (!hasCurrentDispatchClaim()) return null;
      const run = createRun(job.id, {
        run_timeout_ms: job.run_timeout_ms,
        status: 'awaiting_approval',
        evidence_required: false,
        dispatch_queue_id: dispatchRecord?.id || null,
        triggered_by_run: dispatchRecord?.source_run_id || null,
        retry_of: dispatchRecord?.retry_of_run_id || null,
      });
      const approval = createApproval(job.id, run.id, dispatchRecord?.id || null);
      if (dispatchRecord && !setDispatchStatus(dispatchRecord.id, 'awaiting_approval')) {
        throw new Error('Dispatch claim changed before approval gate creation');
      }
      return { run, approval };
    }).immediate();
    if (!pendingGate) {
      log('info', `Skipping ${job.name} -- dispatch was cancelled before approval gate creation`, {
        jobId: job.id,
        dispatchId: dispatchRecord?.id || null,
      });
      return null;
    }
    const { run, approval } = pendingGate;
    log('info', `Approval required for ${job.name} -- awaiting operator`, { approvalId: approval.id, runId: run.id });
    await sendApprovalNotification(job, approval, { getDb, handleDelivery });
    return null;
  }

  // Resource pool concurrency
  if (job.resource_pool && hasRunningRunForPool(job.resource_pool)) {
    log('info', `Skipping ${job.name} -- resource pool '${job.resource_pool}' busy`, { jobId: job.id, pool: job.resource_pool });
    if (dispatchRecord) {
      releaseDispatch(dispatchRecord.id, sqliteNow(TICK_INTERVAL_MS));
    } else {
      advanceNextRun(job);
    }
    return null;
  }

  // Overlap control
  if (hasRunningRun(job.id)) {
    if (job.overlap_policy === 'skip') {
      log('info', `Skipping ${job.name} -- previous run still active`, { jobId: job.id });
      if (dispatchRecord) {
        if (approvedGate && cancelApprovalForDispatch) {
          cancelApprovalForDispatch(dispatchRecord.id, 'Approved dispatch skipped because a previous run is still active');
        } else {
          completeCurrentDispatch('cancelled');
        }
        if (dispatchKind === 'schedule') advanceNextRun(job);
        if (dispatchKind === 'at') updateJobAfterRun(job, 'skipped');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
    if (job.overlap_policy === 'queue') {
      if (dispatchRecord) {
        releaseDispatch(dispatchRecord.id, sqliteNow(adaptiveDeferralMs(dispatchBacklogDepth)));
        log('info', `Deferring durable dispatch for ${job.name} until the active run completes`, {
          jobId: job.id,
          dispatchId: dispatchRecord.id,
        });
        return null;
      }
      const queueResult = enqueueJob(job.id);
      if (!queueResult.queued) {
        log('warn', `Queue limit reached for ${job.name} -- dropping overlap dispatch`, {
          jobId: job.id,
          queuedCount: queueResult.queued_count,
          maxQueuedDispatches: job.max_queued_dispatches || 25,
        });
        if (dispatchRecord) {
          completeCurrentDispatch('cancelled');
        } else {
          advanceNextRun(job);
        }
        return null;
      }
      log('info', `Queueing ${job.name} -- previous run still active`, {
        jobId: job.id,
        queuedCount: queueResult.queued_count,
      });
      if (dispatchRecord) {
        completeCurrentDispatch('done');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
    // 'allow' falls through
  }

  // Idempotency key generation
  const scheduledTime = dispatchRecord?.scheduled_for || job.schedule_at || job.next_run_at;
  let idemKey;
  if (dispatchKind === 'chain') {
    idemKey = generateChainIdempotencyKey(dispatchRecord.source_run_id || dispatchRecord.id, job.id);
  } else if (dispatchKind === 'manual') {
    idemKey = generateRunNowIdempotencyKey(job.id, dispatchRecord?.id || null);
  } else if (dispatchKind === 'retry') {
    idemKey = generateChainIdempotencyKey(dispatchRecord.retry_of_run_id || dispatchRecord.id, job.id);
  } else {
    idemKey = generateIdempotencyKey(job.id, scheduledTime);
  }

  // Idempotency dedup
  if (idemKey) {
    const existing = getDb().prepare("SELECT * FROM idempotency_ledger WHERE key = ? AND status = 'claimed'").get(idemKey);
    if (existing) {
      log('info', `Idempotency skip: ${job.name} (key ${idemKey.slice(0,8)}... already claimed by run ${existing.run_id.slice(0,8)}...)`);
      if (dispatchRecord) {
        if (approvedGate && beginApprovalDispatch && markApprovalDispatched) {
          const begun = beginApprovalDispatch(dispatchRecord.id);
          if (begun.changed) {
            markApprovalDispatched(dispatchRecord.id, { notes: 'Dispatch deduplicated by idempotency key' });
          } else if (cancelApprovalForDispatch) {
            cancelApprovalForDispatch(dispatchRecord.id, 'Approved dispatch deduplicated by idempotency key');
          }
        }
        completeCurrentDispatch('done');
        if (dispatchKind === 'schedule') advanceNextRun(job);
        if (dispatchKind === 'at') updateJobAfterRun(job, 'skipped');
      } else {
        advanceNextRun(job);
      }
      return null;
    }
  }

  log('info', `Dispatching: ${job.name}`, { jobId: job.id, target: job.session_target });

  const retryCount = dispatchKind === 'retry' && dispatchRecord?.retry_of_run_id
    ? (getRun(dispatchRecord.retry_of_run_id)?.retry_count || 0)
    : 0;

  let run;
  const createExecutionRun = (approvalUsed = null) => {
    const created = createRun(job.id, {
      run_timeout_ms: job.run_timeout_ms,
      idempotency_key: idemKey,
      retry_count: retryCount,
      dispatch_queue_id: dispatchRecord?.id || null,
      triggered_by_run: dispatchRecord?.source_run_id || null,
      retry_of: dispatchRecord?.retry_of_run_id || null,
      approval_used: approvalUseSnapshot(approvalUsed),
    });
    const interruptedOutcomes = interruptedEvidenceOutcomes(job);
    if (Object.keys(interruptedOutcomes).length > 0) {
      deps.persistV02Outcomes(created.id, interruptedOutcomes);
    }
    return getRun(created.id);
  };

  if (approvedGate && dispatchRecord) {
    try {
      run = getDb().transaction(() => {
        if (!hasCurrentDispatchClaim()) {
          throw new Error('Approved dispatch claim changed before execution run creation');
        }
        const begin = beginApprovalDispatch(dispatchRecord.id, { db: getDb() });
        if (begin.approval?.status === 'cancelled') {
          return null;
        }
        if (!begin.changed) {
          throw new Error(`Approval dispatch could not begin: ${begin.reason}`);
        }
        if (begin.approval?.status !== 'dispatching') {
          throw new Error(`Approval dispatch entered unexpected status: ${begin.approval?.status || 'missing'}`);
        }
        const currentJob = getDb().prepare('SELECT enabled FROM jobs WHERE id = ?').get(job.id);
        if (!currentJob || currentJob.enabled !== 1) {
          throw new Error('Approved job became unavailable before execution run creation');
        }
        const created = createExecutionRun(begin.approval);
        const marked = markApprovalDispatched(dispatchRecord.id, {
          db: getDb(),
          notes: `Execution run ${created.id} created`,
        });
        if (!marked.changed && marked.reason !== 'already_dispatched') {
          throw new Error(`Approval dispatch could not be finalized: ${marked.reason}`);
        }
        return created;
      }).immediate();
    } catch (err) {
      releaseDispatch(
        dispatchRecord.id,
        sqliteNow(adaptiveDeferralMs(dispatchBacklogDepth)),
        { lastError: err.message },
      );
      log('warn', `Approved dispatch deferred for ${job.name}: ${err.message}`, {
        jobId: job.id,
        dispatchId: dispatchRecord.id,
      });
      return null;
    }
  } else if (dispatchRecord) {
    run = getDb().transaction(() => {
      if (!hasCurrentDispatchClaim()) return null;
      const currentJob = getDb().prepare('SELECT enabled FROM jobs WHERE id = ?').get(job.id);
      if (!currentJob || currentJob.enabled !== 1) {
        getDb().prepare(`
          UPDATE job_dispatch_queue
          SET status = 'cancelled', processed_at = datetime('now'),
              claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
              last_error = 'Job disabled before execution run creation'
          WHERE id = ? AND status = 'claimed'
        `).run(dispatchRecord.id);
        return null;
      }
      return createExecutionRun();
    }).immediate();
  } else {
    const currentJob = getDb().prepare('SELECT enabled FROM jobs WHERE id = ?').get(job.id);
    if (!currentJob || currentJob.enabled !== 1) {
      log('info', `Skipping ${job.name} -- job is disabled before execution run creation`, {
        jobId: job.id,
      });
      return null;
    }
    run = createExecutionRun();
  }

  if (!run) {
    log('info', `Skipping ${job.name} -- dispatch was cancelled before execution run creation`, {
      jobId: job.id,
      dispatchId: dispatchRecord?.id || null,
    });
    return null;
  }

  if (deps.dispatcherFence) {
    const ownedRun = deps.claimRunForDispatch(run.id, deps.dispatcherFence);
    if (!ownedRun) {
      log('warn', `Run ownership claim failed for ${job.name}`, { runId: run.id, jobId: job.id });
      return abortPreparedRun(
        job,
        run,
        'Run ownership claim failed',
        {},
        { dispatchRecord, idemKey: null },
        deps,
        { skipChildren: true },
      );
    }
    run = ownedRun;
  }
  deps.onRunPrepared?.(run);

  // Claim idempotency key
  if (idemKey) {
    const expiresAt = job.delete_after_run
      ? sqliteNow(24 * 60 * 60 * 1000)
      : sqliteNow(7 * 24 * 60 * 60 * 1000);
    const claimed = claimIdempotencyKey(idemKey, job.id, run.id, expiresAt);
    if (!claimed) {
      log('warn', `Idempotency race: ${job.name} key ${idemKey.slice(0,8)}... claimed by concurrent dispatch`);
      return abortPreparedRun(
        job,
        run,
        'Idempotency key already claimed (race)',
        {},
        { dispatchRecord, idemKey: null },
        deps,
        { status: 'skipped', skipChildren: true },
      );
    }
  }

  const abortPreparationIfCancelled = (outcomes = {}) => {
    if (!deps.isRunCancellationRequested?.(run.id)) return false;
    const currentRun = getRun(run.id);
    const reason = currentRun?.cancel_reason || 'Run cancelled during preparation';
    abortPreparedRun(
      job,
      run,
      reason,
      outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
    return true;
  };

  if (abortPreparationIfCancelled()) return null;

  // Governance fields are execution contracts, not annotations. Reject any
  // policy the runtime cannot enforce before credentials or user code run.
  const governanceDecision = evaluateGovernance(job);
  if (!governanceDecision.allowed) {
    return abortPreparedRun(
      job,
      run,
      `Governance policy denied execution: ${governanceDecision.violations.join('; ')}`,
      { governance_evaluation: summarizeGovernance(governanceDecision) },
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }
  for (const warning of governanceDecision.warnings) {
    log('warn', `Governance warning for ${job.name}: ${warning}`, { jobId: job.id, runId: run.id });
  }

  // v0.2 runtime evaluation
  const {
    resolveIdentity, evaluateTrust, verifyAuthorizationProof,
    evaluateAuthorization, summarizeCredentialHandoff, validateDelegation,
  } = deps;

  // Build provider context for v0.2 runtime calls
  const providerCtx = {
    getIdentityProvider: deps.getIdentityProvider,
    getAuthorizationProvider: deps.getAuthorizationProvider,
    getProofVerifier: deps.getProofVerifier,
    resolveAuthorizationRef: deps.resolveAuthorizationRef,
    env: process.env,
    cwd: process.cwd(),
  };

  const v02Outcomes = {};
  const handoffV4 = Number(job.handoff_version) === 4;
  let v4Artifact = null;
  if (handoffV4) {
    try {
      v4Artifact = (deps.assertArtifactMatchesJob || assertArtifactMatchesJob)(job, {
        db: getDb(),
      });
      v02Outcomes.delegation_validation = (
        deps.validateArtifactBoundDelegation || validateArtifactBoundDelegation
      )(job, v4Artifact, dispatchRecord, {
        runId: run.id,
        sourceArtifactDigest: run.source_run_handoff_artifact_digest,
      }, { db: getDb() });
      v02Outcomes.authorization_proof_verification = await (
        deps.verifyArtifactBoundProof || verifyArtifactBoundProof
      )(job, v4Artifact, run, {
        db: getDb(),
        env: process.env,
        cwd: process.cwd(),
        agentcli: deps.agentcliProofRuntime,
      });
      v02Outcomes.identity_resolved = await (
        deps.resolveArtifactBoundIdentity || resolveArtifactBoundIdentity
      )(job, v4Artifact, run, {
        db: getDb(),
        env: process.env,
        cwd: process.cwd(),
        getIdentityProvider: deps.getIdentityProvider,
      });
    } catch (error) {
      return abortPreparedRun(
        job,
        run,
        `Handoff v4 preparation failed: ${error.message}`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true, disableJob: error.transient !== true },
      );
    }
    if (abortPreparationIfCancelled(v02Outcomes)) return null;
  }

  const hasV02Identity = hasIdentityDeclaration(job);
  const hasV02Contract = job.contract_required_trust_level;
  const needsAuthorization = job.authorization || job.authorization_ref;
  const shouldResolveIdentity = !handoffV4
    && (hasV02Identity || hasV02Contract || needsAuthorization);

  if (shouldResolveIdentity) {
    v02Outcomes.identity_resolved = await resolveIdentity(job, providerCtx);
    if (abortPreparationIfCancelled(v02Outcomes)) return null;
  }

  if (hasV02Identity) {
    const handoff = summarizeCredentialHandoff(job);
    if (handoff) v02Outcomes.credential_handoff_summary = handoff;
  }

  const hasDeclaredCredentialHandoff = v02Outcomes.credential_handoff_summary
    && (v02Outcomes.credential_handoff_summary.mode != null
      || v02Outcomes.credential_handoff_summary.bindings_count > 0);
  if (hasDeclaredCredentialHandoff && job.session_target === 'main') {
    return abortPreparedRun(
      job,
      run,
      'Credential handoff presentation is not supported for main-session jobs; use shell or isolated execution',
      v02Outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }

  // Child credential policy enforcement.
  // Apply this BEFORE trust/auth evaluation so later gates see the effective
  // identity that will actually be materialized for the run. The policy can
  // narrow (downscope) or remove (none) credentials, and it may also inherit
  // the parent's auth_profile for downstream gateway calls.
  if (job.parent_id && !handoffV4) {
    const { getDb: getDatabase } = deps;
    const parentJob = getDatabase().prepare(
      'SELECT id, child_credential_policy, identity, identity_trust_level, auth_profile FROM jobs WHERE id = ?'
    ).get(job.parent_id);

    if (parentJob) {
      const effectivePolicy = job.child_credential_policy
        || parentJob.child_credential_policy
        || 'none';
      const parentIdentityBlob = safeParse(parentJob.identity);
      const lastSuccessfulParentRun = (effectivePolicy === 'downscope' || effectivePolicy === 'independent')
        ? getDatabase().prepare(
          'SELECT identity_resolved FROM runs WHERE job_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1'
        ).get(parentJob.id, 'ok')
        : null;
      const parentResolvedIdentity = lastSuccessfulParentRun?.identity_resolved
        ? safeParse(lastSuccessfulParentRun.identity_resolved)
        : null;

      if (effectivePolicy === 'none') {
        // No credentials from parent; suppress any identity the child resolved on its own
        v02Outcomes.identity_resolved = null;
      } else if (effectivePolicy === 'inherit' && parentJob.auth_profile) {
        // Inherit parent's auth profile. Store in v02Outcomes rather than
        // mutating the job DB record, which could leak to downstream writes.
        v02Outcomes.effective_auth_profile = parentJob.auth_profile;
      } else if (effectivePolicy === 'downscope') {
        // Downscope: resolve narrower credentials via provider.
        // Fail closed on every path -- if downscope is declared, we must
        // either produce a downscoped session or abort dispatch.
        const providerName = parentIdentityBlob?.provider || parentIdentityBlob?.auth?.provider;
        const provider = deps.getIdentityProvider?.(providerName);
        let downscopeApplied = false;

        if (provider && typeof provider.prepareHandoff === 'function') {
          // Get parent session from last run or re-resolve
          let parentSession = parentResolvedIdentity?.session || null;

          if (!parentSession && provider.resolveSession) {
            // Fallback: re-resolve parent identity
            try {
              const parentScope = parentIdentityBlob?.scope || parentIdentityBlob?.auth?.scopes?.[0] || null;
              const reResolved = await provider.resolveSession(
                { profile: parentIdentityBlob, instanceId: parentJob.id, scope: parentScope },
                { env: process.env, cwd: process.cwd() }
              );
              if (reResolved.ok) parentSession = reResolved.session;
            } catch (resolveErr) {
              log('warn', `Downscope parent re-resolve failed for ${job.name}: ${resolveErr.message}`, { jobId: job.id });
            }
          }

          if (parentSession) {
            const childIdentityBlob = safeParse(job.identity) || {};
            const childScope = childIdentityBlob?.scope || childIdentityBlob?.auth?.scopes?.[0] || null;

            try {
              const handoffResult = await provider.prepareHandoff(
                parentSession,
                { target_scope: childScope, parent_profile: parentIdentityBlob },
                { env: process.env, cwd: process.cwd() }
              );

              if (handoffResult.prepared) {
                // Verify handoff actually downscoped: child trust must not
                // exceed parent. A provider that returns an elevated session
                // violates the downscope contract.
                const parentTrustLevel = getIdentityTrustLevel(parentResolvedIdentity)
                  || getIdentityTrustLevel({ session: parentSession })
                  || getJobTrustLevel(parentJob, parentIdentityBlob);
                const childTrustLevel = getIdentityTrustLevel({ session: handoffResult.session });
                const { compareTrustLevels } = deps;
                if (parentTrustLevel && childTrustLevel && compareTrustLevels(childTrustLevel, parentTrustLevel) > 0) {
                  log('warn', `Downscope handoff elevated trust from "${parentTrustLevel}" to "${childTrustLevel}" for ${job.name}`, { jobId: job.id });
                  // Do not set downscopeApplied -- will abort below
                } else {
                  // Override the identity resolution with the handoff session
                  v02Outcomes.identity_resolved = {
                    provider: providerName,
                    session: handoffResult.session,
                    source: 'provider',
                    subject_kind: handoffResult.session?.subject?.kind || 'unknown',
                    principal: handoffResult.session?.subject?.principal || null,
                    trust_level: childTrustLevel,
                    delegation_mode: null,
                    raw: childIdentityBlob,
                  };
                  downscopeApplied = true;
                }
              }
            } catch (err) {
              log('warn', `Downscope handoff error for ${job.name}: ${err.message}`, { jobId: job.id });
            }
          }
        }

        if (!downscopeApplied) {
          const reason = !provider
            ? `identity provider ${providerName || '(none)'} not loaded`
            : typeof provider.prepareHandoff !== 'function'
              ? `provider ${providerName} does not support prepareHandoff`
              : 'parent session unavailable or handoff did not produce a downscoped session';
          return abortPreparedRun(
            job,
            run,
            `Downscope credential policy failed: ${reason}`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
      } else if (effectivePolicy === 'independent') {
        // Child uses its own resolved identity, but cannot exceed the parent's
        // trust level. Without this cap, a child could declare a higher trust
        // level than the parent and bypass the parent's authorization scope.
        const parentTrustLevel = getIdentityTrustLevel(parentResolvedIdentity)
          || getJobTrustLevel(parentJob, parentIdentityBlob);
        const childTrustLevel = v02Outcomes.identity_resolved?.trust_level || null;
        if (parentTrustLevel && childTrustLevel) {
          const { compareTrustLevels } = deps;
          if (compareTrustLevels(childTrustLevel, parentTrustLevel) > 0) {
            return abortPreparedRun(
              job,
              run,
              `Independent child trust level "${childTrustLevel}" exceeds parent trust level "${parentTrustLevel}"`,
              v02Outcomes,
              { dispatchRecord, idemKey },
              deps,
              { skipChildren: true },
            );
          }
        }
      }
    }
  }

  if (v02Outcomes.identity_resolved?.source === 'provider-error') {
    return abortPreparedRun(
      job,
      run,
      'Identity resolution failed: ' + (v02Outcomes.identity_resolved.error || 'provider error'),
      v02Outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }

  if (!handoffV4 && v02Outcomes.identity_resolved && typeof validateDelegation === 'function') {
    v02Outcomes.delegation_validation = validateDelegation(job, v02Outcomes.identity_resolved);
    if (v02Outcomes.delegation_validation?.valid === false) {
      return abortPreparedRun(
        job,
        run,
        `Delegation validation failed: ${v02Outcomes.delegation_validation.errors.join('; ')}`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  if (abortPreparationIfCancelled(v02Outcomes)) return null;

  if (hasV02Identity || hasV02Contract || v02Outcomes.identity_resolved != null) {
    v02Outcomes.trust_evaluation = evaluateTrust(job, v02Outcomes.identity_resolved);
    if (v02Outcomes.trust_evaluation?.decision === 'warn') {
      log('warn', `Trust evaluation warning for ${job.name}: ${v02Outcomes.trust_evaluation.reason}`, {
        jobId: job.id,
        runId: run.id,
      });
    }
    if (v02Outcomes.trust_evaluation?.decision === 'deny') {
      return abortPreparedRun(
        job,
        run,
        'Trust enforcement blocked dispatch: ' + v02Outcomes.trust_evaluation.reason,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  if (!handoffV4 && (job.authorization_proof || job.authorization_proof_ref)) {
    v02Outcomes.authorization_proof_verification = await verifyAuthorizationProof(job, providerCtx);
    if (abortPreparationIfCancelled(v02Outcomes)) return null;
    if (v02Outcomes.authorization_proof_verification?.verified === false) {
      const proofError = v02Outcomes.authorization_proof_verification.error || 'verification returned false';
      // Proof verification failure is blocking: the job declared a proof
      // requirement, so proceeding without a valid proof violates policy.
      return abortPreparedRun(
        job,
        run,
        'Authorization proof verification failed: ' + proofError,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  if (needsAuthorization) {
    v02Outcomes.authorization_decision = await evaluateAuthorization(
      job, v02Outcomes.identity_resolved, v02Outcomes.trust_evaluation, providerCtx
    );
    if (abortPreparationIfCancelled(v02Outcomes)) return null;

    if (v02Outcomes.authorization_decision?.decision === 'deny') {
      return abortPreparedRun(
        job,
        run,
        'Authorization denied: ' + v02Outcomes.authorization_decision.reason,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
    if (v02Outcomes.authorization_decision?.decision === 'escalate') {
      const reason = v02Outcomes.authorization_decision.reason || 'provider requested escalation';
      const escalationContext = authorizationEscalationContext(job, v02Outcomes, deps);
      const approvedContext = safeParse(approvedGate?.decision_context);
      const exactApprovedContext = approvedGate?.gate_kind === 'authorization'
        && approvedContext?.context_hash === escalationContext.context_hash;
      if (exactApprovedContext) {
        v02Outcomes.authorization_decision = {
          ...v02Outcomes.authorization_decision,
          decision: 'permit',
          provider_decision: 'escalate',
          human_override: true,
          approval_id: approvedGate.id,
          approved_by: approvedGate.resolved_by || null,
          reason: `Human approval satisfied authorization escalation: ${reason}`,
        };
      } else {
        if (!dispatchRecord) {
          return abortPreparedRun(
            job,
            run,
            `Authorization requires escalation but no durable dispatch is available: ${reason}`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
        const approval = getDb().transaction(() => {
          deps.persistV02Outcomes(run.id, redactOutcomesForPersistence(v02Outcomes, deps));
          return createApproval(job.id, run.id, dispatchRecord.id, {
            db: getDb(),
            gateKind: 'authorization',
            riskLevel: job.approval_risk_level || 'high',
            decisionContext: {
            decision: 'escalate',
            reason,
            authorization_ref: job.authorization_ref || null,
            context_hash: escalationContext.context_hash,
            context: escalationContext.context,
          },
            releaseIdempotencyKey: idemKey,
          });
        }).immediate();
        log('info', `Authorization escalation for ${job.name} is awaiting operator approval`, {
          approvalId: approval.id,
          runId: run.id,
          dispatchId: dispatchRecord.id,
          replacedApprovalId: approvedGate?.gate_kind === 'authorization' ? approvedGate.id : null,
        });
        await sendApprovalNotification(job, approval, { getDb, handleDelivery }, { reason });
        return null;
      }
    }
    if (v02Outcomes.authorization_decision?.advisory) {
      log('warn', `Authorization advisory for ${job.name}: ${v02Outcomes.authorization_decision.reason}`, { jobId: job.id });
    }
  }

  if (abortPreparationIfCancelled(v02Outcomes)) return null;

  // Persist every completed identity/trust/proof/authorization decision before
  // credential materialization begins. Startup recovery must be able to create
  // truthful terminal evidence even if the process dies while a provider is
  // materializing or cleaning up credentials.
  try {
    deps.persistV02Outcomes(
      run.id,
      redactOutcomesForPersistence(v02Outcomes, deps),
      deps.dispatcherFence
        ? { requireRunningFence: true, dispatcherFence: deps.dispatcherFence }
        : {},
    );
  } catch (error) {
    return abortPreparedRun(
      job,
      run,
      `Runtime outcome persistence failed: ${error.message}`,
      v02Outcomes,
      { dispatchRecord, idemKey },
      deps,
      { skipChildren: true },
    );
  }

  // Materialization phase
  let materializedEnv = null;
  let materializationCleanup = null;
  let credentialCleanupTracked = false;
  let v4CredentialMaterialization = null;
  let gatewayCapabilityBinding = null;

  if (handoffV4) {
    try {
      const presentation = v4Artifact.payload.identity?.presentation || { handoff: 'none' };
      const presentationRequired = presentation.handoff !== 'none';
      const capabilityContext = {
        jobId: job.id,
        runId: run.id,
        artifactDigest: job.handoff_artifact_digest,
        runtimeInstanceId: run.runtime_instance_id,
        sessionTarget: job.session_target,
        presentationRequired,
      };
      const capabilityOptions = {
        db: getDb(),
        gateway: deps.gatewayCapabilityOptions,
        localCapabilityResolver: deps.localCapabilityResolver,
      };
      const negotiate = deps.negotiateCredentialCapabilities || negotiateCredentialCapabilities;

      // Prove the receiver can enforce the declared presentation before asking
      // a provider to release any credential material.
      let negotiation = await negotiate(null, capabilityContext, capabilityOptions);
      if (presentationRequired) {
        const resolvedIdentity = v02Outcomes.identity_resolved;
        if (!resolvedIdentity?.provider_session_id || !resolvedIdentity?.session) {
          throw new Error('Artifact credential presentation requires a resolved provider session');
        }
        const provider = deps.getIdentityProvider?.(resolvedIdentity.provider);
        if (!provider) throw new Error(`Identity provider not loaded: ${resolvedIdentity.provider}`);
        if (typeof deps.recordRunCredentialCleanupState === 'function' && deps.dispatcherFence) {
          const tracked = deps.recordRunCredentialCleanupState(run.id, {
            status: 'pending',
            attempts: 0,
          }, deps.dispatcherFence);
          if (!tracked) throw new Error('Dispatcher ownership changed before credential materialization');
          credentialCleanupTracked = true;
        }
        v4CredentialMaterialization = await (
          deps.materializeCredentials || materializeCredentials
        )(
          provider,
          {
            row: getProviderSession(resolvedIdentity.provider_session_id, { db: getDb() }),
            session: resolvedIdentity.session,
          },
          presentation,
          {
            jobId: job.id,
            runId: run.id,
            artifactDigest: job.handoff_artifact_digest,
            sessionTarget: job.session_target,
            runtimeInstanceId: run.runtime_instance_id,
          },
          { db: getDb(), env: process.env },
        );
        materializedEnv = job.session_target === 'isolated'
          ? v4CredentialMaterialization.gatewayEnv
          : v4CredentialMaterialization.env;

        // Revalidate immediately after materialization. The isolated Gateway
        // performs one final forced refresh at the request boundary as well.
        negotiation = await negotiate(
          v4CredentialMaterialization,
          capabilityContext,
          capabilityOptions,
        );
      }
      if (job.session_target === 'isolated') {
        gatewayCapabilityBinding = {
          artifactDigest: job.handoff_artifact_digest,
          runtimeInstanceId: run.runtime_instance_id,
          nonce: negotiation.nonce,
        };
      }
    } catch (error) {
      if (v4CredentialMaterialization) {
        try {
          await (deps.cleanupCredentialMaterialization || cleanupCredentialMaterialization)(
            v4CredentialMaterialization,
            {
              jobId: job.id,
              runId: run.id,
              artifactDigest: job.handoff_artifact_digest,
            },
            { db: getDb() },
          );
        } catch (cleanupError) {
          error.message += `; credential cleanup failed: ${cleanupError.message}`;
        }
      }
      return abortPreparedRun(
        job,
        run,
        `Handoff v4 credential preparation failed: ${error.message}`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true, disableJob: error.transient !== true },
      );
    }
  } else if (v02Outcomes.identity_resolved?.source === 'provider' && v02Outcomes.identity_resolved.session) {
    const providerName = v02Outcomes.identity_resolved.provider;
    const provider = deps.getIdentityProvider?.(providerName);
    const identityBlob = safeParse(job.identity) || {};
    const presentation = identityBlob.presentation || identityBlob.credential_handoff || {};
    const hasPresentation = presentation && Object.keys(presentation).length > 0;

    if (provider && typeof provider.materialize === 'function') {
      if (typeof deps.recordRunCredentialCleanupState === 'function' && deps.dispatcherFence) {
        const tracked = deps.recordRunCredentialCleanupState(run.id, {
          status: 'pending',
          attempts: 0,
        }, deps.dispatcherFence);
        if (!tracked) {
          return abortPreparedRun(
            job,
            run,
            'Dispatcher ownership changed before credential materialization',
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true },
          );
        }
        credentialCleanupTracked = true;
      }
      try {
        const matResult = await provider.materialize(
          v02Outcomes.identity_resolved.session,
          presentation,
          { env: process.env, cwd: process.cwd() }
        );
        if (matResult?.materialized) {
          materializedEnv = matResult.env_vars || null;
          if (matResult.cleanup_required) {
            materializationCleanup = {
              provider,
              cleanupState: {
                session: v02Outcomes.identity_resolved.session,
                ...matResult,
              },
            };
          }
        } else if (hasPresentation) {
          // Materialization returned false but credentials were declared required
          await cleanupDispatchMaterialization(job, {
            run,
            materializedEnv,
            materializationCleanup,
            credentialCleanupTracked,
            dispatcherFence: deps.dispatcherFence || null,
          }, deps);
          return abortPreparedRun(
            job,
            run,
            `Credential materialization failed for provider ${providerName}: provider returned materialized=false`,
            v02Outcomes,
            { dispatchRecord, idemKey },
            deps,
            { skipChildren: true, disableJob: true },
          );
        }
      } catch (err) {
        if (credentialCleanupTracked) {
          try {
            deps.recordRunCredentialCleanupState(run.id, {
              status: 'failed',
              attempts: 1,
              error: err.message,
            }, {
              ...deps.dispatcherFence,
              allowAfterLeaseLoss: true,
            });
          } catch (recordError) {
            log('error', `Credential materialization failure state could not be persisted for ${job.name}: ${recordError.message}`, {
              jobId: job.id,
              runId: run.id,
            });
          }
        }
        return abortPreparedRun(
          job,
          run,
          `Credential materialization error for provider ${providerName}: ${err.message}`,
          v02Outcomes,
          { dispatchRecord, idemKey },
          deps,
          { skipChildren: true, disableJob: true },
        );
      }
    } else if (hasPresentation) {
      // Job declared credential presentation but provider has no materialize method
      return abortPreparedRun(
        job,
        run,
        `Job declares credential presentation but provider ${providerName || '(none)'} does not support materialization`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true },
      );
    }
  }

  let executionEnv = null;
  if (job.session_target === 'shell' || job.job_type === 'watchdog') {
    try {
      executionEnv = buildShellEnvironment(job, materializedEnv);
    } catch (error) {
      const cleanupContext = {
        run,
        materializedEnv,
        materializationCleanup,
        credentialCleanupTracked,
        dispatcherFence: deps.dispatcherFence || null,
        executionEnv: null,
      };
      const cleaned = await cleanupDispatchMaterialization(job, cleanupContext, deps);
      return abortPreparedRun(
        job,
        run,
        `Credential environment validation failed${cleaned ? '' : ' and provider cleanup could not be confirmed'}: ${error.message}`,
        v02Outcomes,
        { dispatchRecord, idemKey },
        deps,
        { skipChildren: true, disableJob: true },
      );
    }
  }

  return {
    dispatchRecord,
    idemKey,
    run,
    retryCount,
    dispatchKind,
    isChainDispatch,
    v02Outcomes,
    materializedEnv,
    materializationCleanup,
    v4CredentialMaterialization,
    gatewayCapabilityBinding,
    v4Artifact,
    credentialCleanupTracked,
    executionEnv,
    governanceDecision,
    dispatcherFence: deps.dispatcherFence || null,
  };
}

// -- Strategy: Watchdog --------------------------------------

export async function executeWatchdog(job, ctx, deps) {
  const {
    runShellCommand, handleDelivery, log,
    summarizeGovernance = () => null,
    recordRunProcess, recordRunProcessTerminated, isRunCancellationRequested,
  } = deps;
  const result = makeDefaultResult();
  result.skipChildren = true;
  result.skipDequeue = true;
  result.runFinishFields = {
    context_summary: { governance: summarizeGovernance(ctx.governanceDecision) },
  };

  const checkCmd = job.watchdog_check_cmd;
  if (!checkCmd) {
    result.status = 'error';
    result.errorMessage = 'Watchdog job missing watchdog_check_cmd';
    result.skipJobUpdate = false;
    return result;
  }

  if (isRunCancellationRequested?.(ctx.run.id)) {
    throw new Error('Run cancelled before watchdog process start');
  }
  const shellExec = await runShellCommand(
    checkCmd,
    Math.min(job.run_timeout_ms || 300000, 60000),
    ctx.executionEnv || null,
    {
      signal: ctx.abortSignal || null,
      envPolicy: job.shell_env_policy || 'minimal',
      onProcess: processInfo => {
        if (!recordRunProcess) return;
        const recorded = recordRunProcess(ctx.run.id, processInfo, ctx.dispatcherFence || {});
        if (!recorded) throw new Error('Run ownership or cancellation changed before watchdog process start');
      },
      onProcessTerminated: () => recordRunProcessTerminated?.(
        ctx.run.id,
        ctx.dispatcherFence || {},
      ),
    },
  );
  const exitCode = shellExec.exitCode;
  const stdout = (shellExec.stdout || '').trim();
  const stderr = (shellExec.stderr || '').trim();

  let timedOut = false;
  let elapsedMin = 0;
  if (job.watchdog_started_at && job.watchdog_timeout_min) {
    const startedAt = new Date(job.watchdog_started_at).getTime();
    elapsedMin = Math.round((Date.now() - startedAt) / 60000);
    if (elapsedMin >= job.watchdog_timeout_min) timedOut = true;
  }

  const terminalPayload = resolveWatchdogTerminalPayload(stdout);

  if (exitCode === 2) {
    result.summary = `Watchdog check failed (transient): ${stderr || stdout}`;
    result.skipDelivery = true;
    log('debug', `Watchdog check transient failure: ${job.name}`, { exitCode, stderr: stderr.slice(0, 200) });

  } else if (exitCode === 0 && terminalPayload) {
    const completionMsg = terminalPayload.kind === 'failed'
      ? [
        `⚠️ [watchdog] Task "${job.watchdog_target_label}" ended with failure -- watchdog disarmed`,
        terminalPayload.detail ? `Details: ${terminalPayload.detail}` : null,
      ].filter(Boolean).join('\n')
      : [
        `\u2705 [watchdog] Task "${job.watchdog_target_label}" completed -- watchdog disarmed`,
        terminalPayload.detail || null,
      ].filter(Boolean).join('\n\n');
    result.summary = completionMsg;
    result.content = completionMsg;
    log(terminalPayload.kind === 'failed' ? 'warn' : 'info', `Watchdog: target terminal: ${job.watchdog_target_label}`, {
      jobId: job.id,
      terminalKind: terminalPayload.kind,
    });

    if (job.watchdog_alert_channel && job.watchdog_alert_target) {
      await handleDelivery({
        ...job,
        ...(job.watchdog_self_destruct ? { id: null } : {}),
        delivery_mode: 'announce-always',
        delivery_channel: job.watchdog_alert_channel,
        delivery_to: job.watchdog_alert_target,
      }, completionMsg, ctx.run?.id ? { runId: ctx.run.id } : {});
    }
    result.skipDelivery = true;

    if (job.watchdog_self_destruct) {
      result.skipJobUpdate = true;
      result.selfDestructJob = true;
    }

  } else if (exitCode === 1 || timedOut) {
    const reason = timedOut
      ? `running for ${elapsedMin}min (threshold: ${job.watchdog_timeout_min}min)`
      : `check command reported stuck`;
    const alertMsg = [
      `\ud83d\udea8 [watchdog] Task "${job.watchdog_target_label}" appears stuck`,
      `- Dispatched: ${job.watchdog_started_at || 'unknown'}`,
      `- Running for: ${elapsedMin} minutes (threshold: ${job.watchdog_timeout_min || '?'} min)`,
      `- Reason: ${reason}`,
      `- Check: ${checkCmd.split(/\s/)[0]}${checkCmd.length > 80 ? ' [...]' : ''}`,
      stderr ? `- Error: ${stderr.slice(0, 500)}` : null,
      stdout ? `- Output: ${stdout.slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');
    result.summary = `Watchdog alert fired: ${reason}`;
    result.content = alertMsg;

    log('warn', `Watchdog alert: ${job.watchdog_target_label} stuck`, {
      jobId: job.id, elapsedMin, timedOut, exitCode,
    });

    if (job.watchdog_alert_channel && job.watchdog_alert_target) {
      await handleDelivery({
        ...job,
        delivery_mode: 'announce-always',
        delivery_channel: job.watchdog_alert_channel,
        delivery_to: job.watchdog_alert_target,
      }, alertMsg, ctx.run?.id ? { runId: ctx.run.id } : {});
    }
    result.skipDelivery = true;

  } else if (exitCode === 0) {
    result.summary = stdout
      ? `Watchdog check returned non-terminal output; target still running (${elapsedMin}min elapsed)`
      : `Watchdog check: target still running (${elapsedMin}min elapsed)`;
    result.skipDelivery = true;
    log('debug', `Watchdog: target still running: ${job.watchdog_target_label}`, {
      jobId: job.id, elapsedMin, sawStdout: Boolean(stdout),
    });
  } else {
    result.summary = `Watchdog check command returned unexpected exit code ${exitCode}`;
    result.status = 'error';
    log('warn', `Watchdog: unexpected exit code for ${job.watchdog_target_label}`, {
      jobId: job.id, exitCode, stderr: stderr.slice(0, 200),
    });
  }

  return result;
}

// -- Strategy: Main session ----------------------------------

export async function executeMain(job, ctx, deps) {
  // Main session dispatch mode:
  // - execution_intent 'execute', 'plan', or missing: use executeAgent (sync,
  //   waits for response, captures content for delivery). Best for quick tasks
  //   where a few seconds of session latency is acceptable.
  // - execution_intent 'fire-and-forget': inject a system event and return
  //   immediately. The agent processes asynchronously and the session stays
  //   unblocked for interactive DMs. No response capture -- if delivery is
  //   configured, the prompt includes a reply-to instruction so the agent
  //   can send results via the message tool when done.
  //
  // Choose based on expected duration:
  //   Quick tasks (< 10s): sync is simpler and captures output
  //   Long tasks (> 30s): fire-and-forget avoids blocking interactive chat

  const isFireAndForget = job.execution_intent === 'fire-and-forget';

  if (!isFireAndForget) {
    // Sync path: reuse executeAgent with the main session key.
    // The job's preferred_session_key defaults to 'main' for main-session jobs.
    const originalSessionKey = job.preferred_session_key;
    job.preferred_session_key = job.preferred_session_key ?? 'main';
    try {
      return await executeAgent(job, ctx, deps);
    } finally {
      job.preferred_session_key = originalSessionKey;
    }
  }

  // Fire-and-forget path: inject system event, return immediately.
  const { sendSystemEvent, buildExecutionIntentNote, log } = deps;
  const result = makeDefaultResult();

  const executionNote = buildExecutionIntentNote(job);
  const modelNote = job.payload_thinking
    ? `[SYSTEM NOTE -- model policy]\nPrefer reasoning depth: ${job.payload_thinking}.\n[END SYSTEM NOTE]\n\n`
    : '';

  const deliveryInstruction = buildFireAndForgetDeliveryInstruction(job);

  const prompt = `${executionNote ? `${executionNote}\n\n` : ''}${modelNote}${deliveryInstruction}${job.payload_message}`;
  await sendSystemEvent(prompt, 'now');

  result.summary = 'System event dispatched (fire-and-forget)';
  result.content = job.payload_message;
  result.skipDelivery = true; // Async completion is queued through the scheduler post office
  result.skipChildren = true;
  result.skipDequeue = true;

  log('info', `Dispatched (main/fire-and-forget): ${job.name}`, { runId: ctx.run.id });

  return result;
}

// -- Strategy: Shell -----------------------------------------

function isCompletionDeliveryWatcherJob(job) {
  return /^(?:dispatch|chilisaus)-deliver:/.test(String(job?.name || ''));
}

function isCompletionWatcherPendingTick(shellResult) {
  return !(shellResult.stdout || '').trim()
    && /\bWATCHER_PENDING\b/.test(shellResult.stderr || '');
}

function isCompletionWatcherAlreadyDelivered(shellResult) {
  return !(shellResult.stdout || '').trim()
    && /\bWATCHER_ALREADY_DELIVERED\b/.test(shellResult.stderr || '');
}

function buildCompletionWatcherNoPayloadMessage(job, shellResult) {
  const statusLabel = shellResult.status === 'ok'
    ? 'completed without a deliverable result'
    : `failed before producing a deliverable result${shellResult.errorMessage ? ` (${shellResult.errorMessage})` : ''}`;
  return [
    `⚠️ Completion delivery watcher for ${job.name} ${statusLabel}.`,
    'No internal diagnostics were delivered as the completion message; check the scheduler run logs for stderr/details.',
  ].join('\n');
}

export async function executeShell(job, ctx, deps) {
  const {
    runShellCommand, normalizeShellResult, log, summarizeGovernance = () => null,
    recordRunProcess, recordRunProcessTerminated, isRunCancellationRequested,
  } = deps;
  const result = makeDefaultResult();

  if (isRunCancellationRequested?.(ctx.run.id)) {
    throw new Error('Run cancelled before shell process start');
  }
  const shellExec = await runShellCommand(
    job.payload_message,
    job.run_timeout_ms,
    ctx.executionEnv || null,
    {
      signal: ctx.abortSignal || null,
      envPolicy: job.shell_env_policy || 'minimal',
      stdin: ctx.v4CredentialMaterialization?.stdin ?? null,
      onProcess: processInfo => {
        if (!recordRunProcess) return;
        const recorded = recordRunProcess(ctx.run.id, processInfo, ctx.dispatcherFence || {});
        if (!recorded) throw new Error('Run ownership or cancellation changed before shell process start');
      },
      onProcessTerminated: () => recordRunProcessTerminated?.(
        ctx.run.id,
        ctx.dispatcherFence || {},
      ),
    },
  );
  const shellResult = normalizeShellResult(shellExec, {
    runId: ctx.run.id,
    timeoutMs: job.run_timeout_ms,
    storeLimit: job.output_store_limit_bytes || undefined,
    excerptLimit: job.output_excerpt_limit_bytes || undefined,
    summaryLimit: job.output_summary_limit_bytes || undefined,
    offloadThreshold: job.output_offload_threshold_bytes || undefined,
  });

  result.status = shellResult.status;
  result.summary = shellResult.summary;
  result.errorMessage = shellResult.errorMessage;
  result.content = shellResult.deliveryText;
  result.structuredOutputSource = String(shellExec.stdout ?? '');
  const rawStdout = String(shellExec.stdout ?? '');
  const rawStderr = String(shellExec.stderr ?? '');
  result.evidenceOutput = {
    stdout_sha256: `sha256:${createHash('sha256').update(rawStdout, 'utf8').digest('hex')}`,
    stderr_sha256: `sha256:${createHash('sha256').update(rawStderr, 'utf8').digest('hex')}`,
    stdout_bytes: Buffer.byteLength(rawStdout, 'utf8'),
    stderr_bytes: Buffer.byteLength(rawStderr, 'utf8'),
  };
  if (shellResult.imageAttachments?.length > 0) {
    result.imageAttachments = shellResult.imageAttachments;
  }
  result.runFinishFields = {
    context_summary: {
      ...shellResult.contextSummary,
      governance: summarizeGovernance(ctx.governanceDecision),
    },
    shell_exit_code: shellResult.exitCode,
    shell_signal: shellResult.signal,
    shell_timed_out: shellResult.timedOut,
    shell_stdout: shellResult.stdout,
    shell_stderr: shellResult.stderr,
    shell_stdout_path: shellResult.stdoutPath,
    shell_stderr_path: shellResult.stderrPath,
    shell_stdout_bytes: shellResult.stdoutBytes,
    shell_stderr_bytes: shellResult.stderrBytes,
    shell_stdout_sha256: result.evidenceOutput.stdout_sha256,
    shell_stderr_sha256: result.evidenceOutput.stderr_sha256,
  };

  if (isCompletionDeliveryWatcherJob(job)) {
    const watcherStdout = (shellResult.stdout || '').trim();
    const watcherStderr = (shellResult.stderr || '').trim();

    if (isCompletionWatcherPendingTick(shellResult)) {
      result.status = 'skipped';
      result.summary = 'Completion delivery watcher pending; target session is still running';
      result.content = '';
      result.errorMessage = null;
      result.idemAction = 'release';
      result.skipDelivery = true;
    } else if (isCompletionWatcherAlreadyDelivered(shellResult)) {
      result.status = 'ok';
      result.summary = 'Completion already delivered via authoritative done path';
      result.content = '';
      result.errorMessage = null;
      result.skipDelivery = true;
    } else if (watcherStdout) {
      // Completion watcher stdout is the only user-facing contract.  Stderr is
      // diagnostics-only and must never be repackaged as a "successful" final
      // completion if the watcher suppressed the real payload.
      result.summary = watcherStdout;
      result.content = watcherStdout;
      if (['announce', 'announce-always'].includes(job.delivery_mode)) {
        result.deliveryOverride = watcherStdout;
      } else {
        result.skipDelivery = true;
      }
    } else {
      const noPayloadMessage = buildCompletionWatcherNoPayloadMessage(job, shellResult);
      result.status = 'error';
      result.summary = noPayloadMessage;
      result.errorMessage = 'Completion delivery watcher produced no user-facing stdout payload';
      result.content = noPayloadMessage;
      if (['announce', 'announce-always'].includes(job.delivery_mode)) {
        result.deliveryOverride = noPayloadMessage;
      } else {
        result.skipDelivery = true;
      }
      log('warn', `Completion watcher produced no deliverable stdout: ${job.name}`, {
        runId: ctx.run.id,
        shellStatus: shellResult.status,
        exitCode: shellResult.exitCode,
        stderrExcerpt: watcherStderr.slice(0, 500),
        skippedOrDisabled: /\b(?:skipped|disabled)\b/i.test(watcherStderr),
      });
    }
  } else {
    // Shell delivery logic: announce-always sends on all results, announce sends on error only
    const announcePayload = shellResult.deliveryText.trim() ? shellResult.deliveryText : shellResult.errorMessage;
    if (job.delivery_mode === 'announce-always' && announcePayload) {
      const prefix = shellResult.status === 'ok' ? '' : `\u26a0\ufe0f Shell job failed: ${job.name}\n\n`;
      result.deliveryOverride = `${prefix}${announcePayload}`;
    } else if (job.delivery_mode === 'announce' && shellResult.status !== 'ok' && announcePayload) {
      result.deliveryOverride = announcePayload;
    } else {
      result.skipDelivery = true;
    }
  }

  log('info', `Shell ${result.status}: ${job.name}`, {
    runId: ctx.run.id,
    exitCode: shellResult.exitCode,
    signal: shellResult.signal,
    timedOut: shellResult.timedOut,
  });

  return result;
}

// -- Strategy: Agent (isolated session) ----------------------

function describeAgentSelection(selection) {
  return {
    model: selection?.model || null,
    auth_profile: selection?.authProfile || null,
  };
}

function sameAgentSelection(left, right) {
  return (left?.model || undefined) === (right?.model || undefined)
    && (left?.authProfile || undefined) === (right?.authProfile || undefined);
}

function isGatewayCompatibilityFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return code.startsWith('GATEWAY_ENV_INJECT_')
    || code.startsWith('GATEWAY_CAPABILITY_DISCOVERY_')
    || error?.name === 'GatewayCompatibilityError';
}

async function resolveConfiguredAuthProfile(authProfile, deps, jobId, fieldName = 'auth_profile') {
  const { listSessions, log } = deps;
  let resolvedAuthProfile = authProfile || undefined;
  if (resolvedAuthProfile !== 'inherit') return resolvedAuthProfile;

  try {
    const sessions = await listSessions({ kinds: ['main'], activeMinutes: 120, limit: 10 });
    const sessionList = sessions?.result?.details?.sessions || sessions?.result?.sessions || sessions?.sessions || sessions || [];
    const mainSession = Array.isArray(sessionList)
      ? sessionList.find(s => {
          const key = s.key || s.sessionKey || '';
          return key.includes(':main:') || key.endsWith(':main') || key === 'main';
        })
      : null;
    const profileId = mainSession?.authProfileOverride || mainSession?.authProfile || mainSession?.profile;
    if (profileId) {
      resolvedAuthProfile = profileId;
      log('debug', `Resolved ${fieldName} 'inherit' -> '${profileId}'`, { jobId });
    } else {
      log('debug', `${fieldName} 'inherit' -- no main session profile found, passing 'inherit' as-is`, { jobId });
    }
  } catch (err) {
    log('warn', `Failed to resolve ${fieldName} 'inherit': ${err.message}`, { jobId });
    // Fall through with 'inherit' -- gateway may handle it.
  }

  return resolvedAuthProfile;
}

async function runAgentTurnForSelection(
  job,
  deps,
  prompt,
  sessionKey,
  selection,
  dispatchAgentTurn,
  materializedEnv = null,
  capabilityBinding = null,
  signal = null,
) {
  const { log } = deps;
  const { applySessionOverridesToSessionStore: applySessionOverrides } = deps;
  const agentId = assertValidAgentId(job.agent_id ?? 'main', 'job agent_id');
  const validatedSessionKey = assertSessionKeyForAgent(sessionKey, agentId, 'job session_key');

  if (typeof applySessionOverrides === 'function') {
    const applyResult = applySessionOverrides(
      validatedSessionKey,
      {
        authProfile: selection.authProfile,
        modelRef: selection.model || null,
      },
      agentId,
    );
    if (applyResult.ok) {
      log('debug', `Applied session overrides for ${validatedSessionKey}`, {
        jobId: job.id,
        authProfile: selection.authProfile || null,
        modelRef: selection.model || null,
      });
    } else {
      log('warn', `Failed to apply session overrides: ${applyResult.error}`, {
        jobId: job.id,
        sessionKey: validatedSessionKey,
      });
    }
  }

  return dispatchAgentTurn({
    message: prompt,
    agentId,
    sessionKey: validatedSessionKey,
    authProfile: selection.authProfile,
    materializedEnv: materializedEnv || undefined,
    capabilityBinding: capabilityBinding || undefined,
    idleTimeoutMs: (job.payload_timeout_seconds || 120) * 1000,
    pollIntervalMs: 60000,
    absoluteTimeoutMs: job.run_timeout_ms || 300000,
    signal,
    cancelOnAbort: false,
  });
}

export async function executeAgent(job, ctx, deps) {
  const {
    waitForGateway, updateRunSession, setAgentStatus,
    buildJobPrompt,
    ackClaimedInboxForRun = (_runId, ids) => ({ acked: ids.length, messages: [] }),
    runAgentTurnWithActivityTimeout,
    // Sanctioned isolated dispatch primitive. Falls back to the activity-aware
    // runner when callers (e.g. tests) wire only the older name -- both helpers
    // share the same HTTP-only contract, no subprocess spawn.
    runIsolatedAgentTurn,
    updateContextSummary, matchesSentinel, detectTransientError,
    sqliteNow, log, summarizeGovernance = () => null,
    isRunCancellationRequested,
  } = deps;
  const dispatchAgentTurn = runIsolatedAgentTurn || runAgentTurnWithActivityTimeout;
  const result = makeDefaultResult();

  if (isRunCancellationRequested?.(ctx.run.id)) {
    throw new Error('Run cancelled before agent dispatch');
  }

  const agentId = assertValidAgentId(job.agent_id ?? 'main', 'job agent_id');
  const requestedSessionKey = assertValidSessionKey(
    job.preferred_session_key ?? `scheduler:${job.id}`,
    'job preferred_session_key',
  );
  const sessionKey = requestedSessionKey.startsWith('agent:')
    ? requestedSessionKey
    : `agent:${agentId}:${requestedSessionKey}`;
  assertSessionKeyForAgent(sessionKey, agentId, 'job session_key');

  // Gateway health check
  const gatewayReady = await waitForGateway(30000, 2000);
  if (!gatewayReady) {
    log('warn', `Gateway unavailable after 30s -- deferring: ${job.name}`, { jobId: job.id });
    result.status = 'error';
    result.summary = 'Gateway unavailable -- deferred';
    result.errorMessage = 'Gateway unavailable -- deferred';
    result.idemAction = 'release';
    result.skipDelivery = true;
    result.skipJobUpdate = true;
    result.skipChildren = true;
    result.deferUntil = sqliteNow(60000);
    return result;
  }

  // Use a stable session key per job (not per run) so subsequent runs reuse
  // the warm session. This avoids full agent bootstrap on every dispatch --
  // memory search, plugin init, and context loading only happen on the first
  // run. Later runs get a pre-warmed session with context already loaded.
  updateRunSession(ctx.run.id, sessionKey, null);

  // Mark agent as busy
  if (job.agent_id) setAgentStatus(agentId, 'busy', sessionKey);

  // Build prompt and collect context metadata
  const { prompt, contextMeta, injectedMessageIds = [] } = buildJobPrompt(job, ctx.run);
  ctx.promptClaimedMessageIds = injectedMessageIds;
  contextMeta.governance = summarizeGovernance(ctx.governanceDecision);
  try { updateContextSummary(ctx.run.id, contextMeta); } catch (_e) { /* column may not exist yet */ }

  const primarySelection = {
    model: job.payload_model || undefined,
    authProfile: await resolveConfiguredAuthProfile(
      ctx.v02Outcomes?.effective_auth_profile || job.auth_profile || undefined,
      deps,
      job.id,
      ctx.v02Outcomes?.effective_auth_profile ? 'effective_auth_profile' : 'auth_profile'
    ),
  };
  const hasConfiguredFallback = job.payload_model_fallback != null || job.auth_profile_fallback != null;
  const fallbackSelection = hasConfiguredFallback ? {
    model: job.payload_model_fallback || primarySelection.model || undefined,
    authProfile: job.auth_profile_fallback != null
      ? await resolveConfiguredAuthProfile(job.auth_profile_fallback, deps, job.id, 'auth_profile_fallback')
      : primarySelection.authProfile,
  } : null;

  let turnResult;
  try {
    if (isRunCancellationRequested?.(ctx.run.id)) {
      throw new Error('Run cancelled before agent turn start');
    }
    turnResult = await runAgentTurnForSelection(
      job,
      deps,
      prompt,
      sessionKey,
      primarySelection,
      dispatchAgentTurn,
      ctx.materializedEnv || null,
      ctx.gatewayCapabilityBinding || null,
      ctx.abortSignal || null,
    );
  } catch (primaryError) {
    const canTryConfiguredFallback = fallbackSelection
      && !sameAgentSelection(primarySelection, fallbackSelection)
      && !isGatewayCompatibilityFailure(primaryError);
    if (!canTryConfiguredFallback) throw primaryError;

    log('warn', 'Primary agent selection failed; retrying with configured fallback', {
      jobId: job.id,
      primary: describeAgentSelection(primarySelection),
      fallback: describeAgentSelection(fallbackSelection),
      error: primaryError.message,
    });

    try {
      turnResult = await runAgentTurnForSelection(
        job,
        deps,
        prompt,
        sessionKey,
        fallbackSelection,
        dispatchAgentTurn,
        ctx.materializedEnv || null,
        ctx.gatewayCapabilityBinding || null,
        ctx.abortSignal || null,
      );
      log('info', 'Configured agent fallback succeeded', { jobId: job.id, fallback: describeAgentSelection(fallbackSelection) });
    } catch (fallbackError) {
      throw new Error(`Primary agent selection failed: ${primaryError.message}; configured fallback also failed: ${fallbackError.message}`, { cause: fallbackError });
    }
  }

  // Acknowledge inbox messages only after the gateway accepted and completed
  // the turn. Failed turns leave them pending for a later retry.
  if (injectedMessageIds.length > 0) {
    const acknowledged = ackClaimedInboxForRun(ctx.run.id, injectedMessageIds);
    if (acknowledged.acked !== injectedMessageIds.length) {
      throw new Error(
        `Inbox claim acknowledgement mismatch: expected ${injectedMessageIds.length}, acknowledged ${acknowledged.acked}`,
      );
    }
    ctx.promptClaimedMessageIds = [];
  }

  const content = turnResult.content || '';
  const trimmed = content.trim();

  const isHeartbeatOk = matchesSentinel(trimmed, 'HEARTBEAT_OK');
  const isNoFlush = matchesSentinel(trimmed, 'NO_FLUSH');
  const isIdempotentSkip = matchesSentinel(trimmed, 'IDEMPOTENT_SKIP');
  const isTaskFailed = matchesSentinel(trimmed, 'TASK_FAILED');
  const isTransientError = detectTransientError(content);

  if (isNoFlush) log('info', `Flush: nothing to flush for ${job.name}`);
  if (isIdempotentSkip) log('info', `Idempotent skip (agent): ${job.name}`);
  if (isTaskFailed) log('warn', `Agent signalled TASK_FAILED: ${job.name}`, { runId: ctx.run.id });
  if (isTransientError) log('warn', `Transient error detected in agent reply: ${job.name}`, { runId: ctx.run.id, snippet: content.slice(0, 200) });

  const effectiveStatus = (isTaskFailed || isTransientError) ? 'error' : 'ok';

  result.status = effectiveStatus;
  result.summary = content.slice(0, 5000);
  result.content = content;
  result.evidenceOutput = {
    stdout_sha256: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
    stderr_sha256: null,
    stdout_bytes: Buffer.byteLength(content, 'utf8'),
    stderr_bytes: 0,
  };
  result.runFinishFields = {
    ...(result.runFinishFields || {}),
    shell_stdout_bytes: result.evidenceOutput.stdout_bytes,
    shell_stderr_bytes: result.evidenceOutput.stderr_bytes,
    shell_stdout_sha256: result.evidenceOutput.stdout_sha256,
    shell_stderr_sha256: result.evidenceOutput.stderr_sha256,
  };
  result.errorMessage = effectiveStatus === 'error'
    ? (isTaskFailed ? 'Agent signalled TASK_FAILED' : 'Transient error in agent reply')
    : null;
  result.idemAction = effectiveStatus === 'ok' ? 'keep' : 'release';
  result.skipAgentCleanup = false;
  result.retryFiresChildren = true;

  // Suppress delivery for sentinel responses
  if (isHeartbeatOk || isNoFlush || isIdempotentSkip) {
    result.skipDelivery = true;
  }

  // Announce mode: only deliver on error (consistent with shell job behavior)
  if (job.delivery_mode === 'announce' && effectiveStatus === 'ok') {
    result.skipDelivery = true;
  }

  log('info', `Completed: ${job.name} (${turnResult.usage?.total_tokens || '?'} tokens)`, {
    runId: ctx.run.id,
    durationMs: ctx.run.started_at
      ? Date.now() - new Date(ctx.run.started_at.replace(' ', 'T') + (ctx.run.started_at.endsWith('Z') ? '' : 'Z')).getTime()
      : null,
  });

  return result;
}

// -- Strategy dispatcher with error-catch wrapper ------------

export async function executeStrategy(job, ctx, deps) {
  const { log } = deps;
  try {
    if (deps.isRunCancellationRequested?.(ctx.run.id)) {
      throw new Error('Run cancelled before execution');
    }
    if (job.job_type === 'watchdog') return await executeWatchdog(job, ctx, deps);
    if (job.session_target === 'main')  return await executeMain(job, ctx, deps);
    if (job.session_target === 'shell') return await executeShell(job, ctx, deps);
    return await executeAgent(job, ctx, deps);
  } catch (err) {
    log('error', `Failed: ${job.name}: ${err.message}`, { jobId: job.id });
    const isIsolatedAgent = job.session_target !== 'main' && job.session_target !== 'shell' && job.job_type !== 'watchdog';
    const drainRetry = isIsolatedAgent && deps.isDrainError(err.message);
    return {
      ...makeDefaultResult(),
      status: 'error',
      summary: err.message,
      content: err.message,
      errorMessage: err.message,
      idemAction: 'release',
      skipAgentCleanup: !isIsolatedAgent,
      skipDelivery: drainRetry,
      skipJobUpdate: drainRetry,
      skipChildren: drainRetry,
      drainRetry,
    };
  }
}
