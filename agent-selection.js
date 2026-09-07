// Pure model/profile compatibility shared by validation and Gateway preparation.
import { assertValidAgentId } from './identifiers.js';
import { GatewayPreparationError } from './dispatch/gateway-rpc.mjs';

// Installed Gateway routing syntax; keep general scheduler identity validation separate.
const ROUTING_AGENT_ID = '[a-z0-9][a-z0-9_-]{0,63}';
const ROUTING_MODEL_ID_PATTERN = new RegExp(
  `^(?:openclaw|openclaw\\/default|openclaw[:/]${ROUTING_AGENT_ID}|agent:${ROUTING_AGENT_ID})$`, 'i',
);

export function splitModelOverride(model, agentId) {
  const bodyModel = `openclaw:${agentId}`;
  if (!ROUTING_MODEL_ID_PATTERN.test(bodyModel)) {
    throw new GatewayPreparationError('Agent ID is incompatible with the Gateway routing model syntax');
  }
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return { bodyModel, overrideHeader: undefined };
  if (ROUTING_MODEL_ID_PATTERN.test(trimmed)) {
    const routeAgent = /^(?:openclaw[:/]|agent:)(.+)$/i.exec(trimmed)?.[1];
    if (routeAgent && trimmed.toLowerCase() !== 'openclaw/default' && routeAgent.toLowerCase() !== agentId.toLowerCase()) {
      throw new GatewayPreparationError('Routing model owner does not match the requested agent');
    }
    return { bodyModel: trimmed, overrideHeader: undefined };
  }
  if (/^(?:openclaw[:/]|agent:)/i.test(trimmed)) {
    throw new GatewayPreparationError('Routing model is incompatible with the Gateway routing syntax');
  }
  if (splitProfileSuffix(trimmed).profile) {
    throw new GatewayPreparationError('Inline profile requires separate prepareAgentSelection before HTTP dispatch');
  }
  return { bodyModel, overrideHeader: trimmed };
}

/** Split the current Gateway's profile suffix grammar, preserving date/quant model versions. */
function splitProfileSuffix(raw) {
  const trimmed = raw.trim();
  let delimiter = trimmed.indexOf('@', trimmed.lastIndexOf('/') + 1);
  if (delimiter <= 0) return { model: trimmed };
  if (/^\d{8}(?:@|$)/.test(trimmed.slice(delimiter + 1))) {
    delimiter = trimmed.indexOf('@', delimiter + 9);
    if (delimiter < 0) return { model: trimmed };
  }
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(trimmed.slice(delimiter + 1))) {
    delimiter = trimmed.indexOf('@', delimiter + 1);
    if (delimiter < 0) return { model: trimmed };
  }
  const model = trimmed.slice(0, delimiter).trim();
  const profile = trimmed.slice(delimiter + 1).trim();
  return model && profile ? { model, profile } : { model: trimmed };
}

/** Normalize the effective model/profile once for preparation and fallback identity. */
export function normalizeAgentSelection(overrides = {}, agentId = 'main') {
  const owner = assertValidAgentId(agentId, 'agentId');
  if (['modelRef', 'authProfile'].some(name => overrides[name] != null && typeof overrides[name] !== 'string')) {
    throw new GatewayPreparationError('Model and profile selections must be strings or null');
  }
  const rawModel = typeof overrides.modelRef === 'string' ? overrides.modelRef.trim() : '';
  const separateProfile = typeof overrides.authProfile === 'string' ? overrides.authProfile.trim() : '';
  const split = splitProfileSuffix(rawModel);
  if (separateProfile && split.profile && separateProfile !== split.profile) {
    throw new GatewayPreparationError('Conflicting model suffix and authProfile selections');
  }
  const profile = separateProfile || split.profile;
  const route = splitModelOverride(split.model, owner);
  const normalized = { model: split.model || undefined, authProfile: profile || undefined,
    identity: JSON.stringify([route.overrideHeader || `openclaw:${owner.toLowerCase()}`, profile || null]) };
  if (!profile) return normalized;
  if (profile === 'inherit' || /[\s/]/.test(profile)) {
    throw new GatewayPreparationError('Profile must be a resolved explicit ID without whitespace or slash');
  }
  const slash = split.model.indexOf('/');
  if (!route.overrideHeader || slash <= 0 || slash === split.model.length - 1) {
    throw new GatewayPreparationError('Explicit profile preparation requires a concrete provider/model reference');
  }
  // Reject suffixes that would be parsed into a different pair after concatenation.
  const modelWithProfile = `${split.model}@${profile}`;
  const verified = splitProfileSuffix(modelWithProfile);
  if (verified.model !== split.model || verified.profile !== profile) {
    throw new GatewayPreparationError('Ambiguous model/profile suffix combination');
  }
  return normalized;
}
