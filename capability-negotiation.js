import { createHash, randomBytes } from 'node:crypto';
import { negotiateGatewayEnvironmentInjection } from './gateway-capabilities.js';
import { appendRuntimeEvent } from './runtime-events.js';

export const LOCAL_ARTIFACT_BINDING_CAPABILITY = 'artifact-bound-runtime-v1';
export const LOCAL_SHELL_CREDENTIAL_CAPABILITY = 'shell-credential-presentation-v1';

function negotiationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}
function assertContext(ctx) {
  if (typeof ctx?.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ctx.artifactDigest)) {
    throw new TypeError('artifactDigest must be a lowercase SHA-256 digest');
  }
  if (typeof ctx?.runtimeInstanceId !== 'string' || ctx.runtimeInstanceId.length === 0) {
    throw new TypeError('runtimeInstanceId is required');
  }
  if (!['shell', 'isolated'].includes(ctx.sessionTarget)) {
    throw negotiationError(
      'CAPABILITY_NEGOTIATION_UNSUPPORTED_TARGET',
      `Artifact-bound credential negotiation is not supported for ${ctx.sessionTarget || 'unknown'} jobs`,
    );
  }
}

function localCapabilities(opts) {
  if (typeof opts.localCapabilityResolver === 'function') {
    const resolved = opts.localCapabilityResolver();
    if (!Array.isArray(resolved)) {
      throw negotiationError(
        'CAPABILITY_NEGOTIATION_INVALID',
        'Local capability resolver must return an array',
      );
    }
    return [...new Set(resolved)];
  }
  return [LOCAL_ARTIFACT_BINDING_CAPABILITY, LOCAL_SHELL_CREDENTIAL_CAPABILITY];
}

/**
 * Force-refresh and bind the receiver capability decision to the exact artifact
 * and runtime instance immediately before credentials are presented.
 */
export async function negotiateCredentialCapabilities(materialized, ctx, opts = {}) {
  assertContext(ctx);
  const db = opts.db;
  const observedAt = Date.now();
  const nonce = randomBytes(24).toString('base64url');
  let result;

  if (ctx.sessionTarget === 'isolated') {
    result = await negotiateGatewayEnvironmentInjection(materialized?.gatewayEnv ?? {}, {
      ...(opts.gateway || {}),
      requireEnvInjection: ctx.presentationRequired === true,
      binding: {
        artifactDigest: ctx.artifactDigest,
        runtimeInstanceId: ctx.runtimeInstanceId,
        nonce,
      },
    });
    if (!result.gateway) {
      throw negotiationError(
        'CAPABILITY_NEGOTIATION_MISSING',
        'Gateway capability discovery did not produce an artifact-bound result',
      );
    }
  } else {
    const capabilities = localCapabilities(opts);
    const required = [
      LOCAL_ARTIFACT_BINDING_CAPABILITY,
      ...(ctx.presentationRequired === true || materialized
        ? [LOCAL_SHELL_CREDENTIAL_CAPABILITY]
        : []),
    ];
    const missing = required.filter(capability => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw negotiationError(
        'CAPABILITY_NEGOTIATION_DOWNGRADE',
        `Local runtime no longer advertises required capabilities: ${missing.join(', ')}`,
        { capabilities, required, missing },
      );
    }
    result = Object.freeze({
      headers: Object.freeze({}),
      gateway: null,
      local: Object.freeze({ capabilities: Object.freeze(capabilities) }),
    });
  }

  const completedAt = Date.now();
  const maxAgeMs = Number.isInteger(opts.maxAgeMs) && opts.maxAgeMs > 0 ? opts.maxAgeMs : 5_000;
  if (completedAt - observedAt > maxAgeMs) {
    throw negotiationError(
      'CAPABILITY_NEGOTIATION_STALE',
      `Capability negotiation exceeded its ${maxAgeMs}ms freshness window`,
      { observedAt, completedAt, maxAgeMs },
    );
  }

  appendRuntimeEvent('capability.negotiated', {
    jobId: ctx.jobId,
    runId: ctx.runId,
    handoffArtifactDigest: ctx.artifactDigest,
    payload: {
      target: ctx.sessionTarget,
      runtime_instance_id: ctx.runtimeInstanceId,
      nonce_sha256: createHash('sha256').update(nonce, 'utf8').digest('hex'),
      observed_at: new Date(observedAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      gateway_version: result.gateway?.version ?? null,
      gateway_capabilities: result.gateway ? [...result.gateway.capabilities] : null,
      local_capabilities: result.local ? [...result.local.capabilities] : null,
    },
  }, { ...(db ? { db } : {}) });

  return Object.freeze({
    ...result,
    nonce,
    observedAt,
    completedAt,
  });
}
