const mockKeys = {
  full: 'sk_test_mock_full_key_123456',
  payments: 'sk_test_mock_payments_key_789',
  readonly: 'rk_test_mock_readonly_key_abc',
};

export default {
  name: 'mock-stripe',
  type: 'identity',

  validateProfile(profile, _ctx) {
    const config = profile?.auth?.provider_config || {};
    if (!config.permission_sets) return { valid: false, errors: ['missing permission_sets'] };
    return { valid: true };
  },

  resolveSession(request, _ctx) {
    const scope = request.scope || 'full';
    const key = mockKeys[scope];
    if (!key) return { ok: false, transient: false, error: `Unknown scope: ${scope}` };
    return {
      ok: true,
      session: {
        provider: 'mock-stripe',
        subject: { kind: 'service', principal: 'stripe:test' },
        trust: { declared_level: 'supervised', effective_level: 'supervised' },
        credentials: { api_key: { kind: 'bearer', value: key, scope } },
        delegation_chain: [{ kind: 'service', principal: 'stripe:test', grant: `scope:${scope}`, validated: true }],
        delegation_validation: { valid: true, depth: 1, acyclic: true, escalation_detected: false },
      },
    };
  },

  materialize(session, _presentation, _ctx) {
    const envVars = {};
    if (session.credentials?.api_key?.value) {
      envVars['STRIPE_API_KEY'] = session.credentials.api_key.value;
    }
    return { materialized: true, env_vars: envVars, cleanup_required: false };
  },

  cleanup(_materialization, _ctx) {
    return { cleaned: true };
  },

  prepareHandoff(session, handoff, _ctx) {
    const targetScope = handoff?.target_scope;
    if (!targetScope) return { prepared: false, error: 'missing target_scope' };
    const key = mockKeys[targetScope];
    if (!key) return { prepared: false, error: `Unknown scope: ${targetScope}` };
    return {
      prepared: true,
      session: {
        ...session,
        credentials: { api_key: { kind: 'bearer', value: key, scope: targetScope } },
      },
    };
  },

  describeSession(session, _ctx) {
    const described = JSON.parse(JSON.stringify(session));
    if (described.credentials?.api_key?.value) {
      described.credentials.api_key.value = '[REDACTED]';
    }
    return described;
  },
};
