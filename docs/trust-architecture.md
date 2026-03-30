# Trust Architecture

Date: 2026-03-30
Status: Accepted

## Purpose

This document describes the trust architecture of the scheduler/sub-agent
execution model: what the boundary guarantees, what it does not, and how
operators reason about the security properties of scheduled workflows.

## The Core Design: Scheduler as Broker, Child as Bounded Actor

The scheduler is a control-plane broker. It owns the dispatch queue,
credential resolution, trust evaluation, authorization gates, and run
lifecycle. It authenticates to the gateway with a single operator-provisioned
bearer token and holds whatever master/scoped keys the operator has loaded
into its environment or provider plugins.

Child tasks are bounded execution principals. They receive only what the
scheduler gives them and cannot escalate their own authority. A child's
credentials are resolved by an identity provider, narrowed via
`prepareHandoff` when the policy requires it, and materialized as scoped
environment variables (shell tasks) or auth-profile headers (agent tasks).
The child never sees the scheduler's own bearer token or master keys.

This is the broker/orchestrator + bounded actor pattern. The scheduler
decides what to run, with what credentials, under what trust constraints.
The child executes within those constraints.

## When the Boundary Is a Real Security Boundary

The scheduler/child separation is a meaningful security boundary when the
child is narrower than the parent in at least one of these dimensions:

- **Identity** -- different principal, different subject kind, or
  provider-resolved session with narrower scope.
- **Credentials** -- downscoped key, narrower OAuth scope, shorter-lived
  token. With dynamic RAK minting, each child gets a per-task restricted
  API key that is revoked on cleanup.
- **Tools** -- different tool set, different sandbox mode, spawn depth cap.
- **State** -- isolated session with no access to parent's memory or
  conversation history.
- **Network/filesystem scope** -- different `allowed_paths`, different
  network policy (`unrestricted` / `restricted` / `none`).

When the child is meaningfully narrower, the boundary limits blast radius:
a compromised or misbehaving child cannot access the parent's full
credential set, cannot read or write the parent's session state, and
cannot escalate to the parent's trust level.

A concrete example: a workflow like
`check balance (read-only) -> process payment (payments:write) -> send receipt (email:send)`
gives each step a per-task restricted key with exactly the scope it needs.
The payments step cannot read customer PII, the receipt step cannot make
charges, and if any step is compromised, the blast radius is one
short-lived restricted key -- not the master.

## When the Boundary Is an Operational Boundary

If you cannot make the child meaningfully narrower in identity, tools,
state, or network/filesystem scope, then the sub-agent boundary is mostly
an execution/lifecycle boundary, not a strong security boundary. This
happens when:

- The child inherits the parent's full credentials
  (`child_credential_policy: inherit`) without further narrowing.
- The child runs with the same tool set and no additional sandbox
  constraints.
- The child's identity profile is identical to the parent's.

In this case the boundary still provides:

- **Lifecycle isolation.** The child can be timed out, retried, or
  cancelled independently of the parent.
- **Attribution.** Each child has its own run record, execution ID, and
  audit trail.
- **Context isolation.** The child session cannot read the parent's
  conversation history or tool state.
- **Crash containment.** A child crash does not crash the parent or
  sibling tasks.
- **Observability.** Independent run status, duration tracking, and
  delivery.

These are real operational benefits, but they are not security guarantees
in the credential-scoping or access-control sense.

## What the Model Guarantees

**Does guarantee:**

- Credential narrowing when `child_credential_policy` is `downscope` and
  the provider implements scope hierarchy. The provider mints a restricted
  key scoped to exactly the permissions the child declared, with a lifetime
  tied to the task's timeout. The key is revoked in cleanup.
- Trust level enforcement: a child cannot run if its resolved trust level
  is below the contract's `required_trust_level` (when
  `contract_trust_enforcement` is `strict` or `block`).
- Trust level ceiling: `independent` and `downscope` policies both enforce
  that the child's trust level cannot exceed the parent's. Violations
  abort dispatch.
- Fail-closed behavior: missing providers, unresolvable credentials,
  invalid delegation chains, and failed proof verification all abort the
  run rather than proceeding with degraded security.
- Session isolation: child sessions have independent memory, history, and
  tool scope from the parent.
- Audit attribution: every run is attributed to a resolved identity with
  full trust/authorization/evidence chain.
- Security aborts do not fire triggered children: a parent that fails a
  security gate (identity, trust, authorization, proof) does not dispatch
  downstream work.

**Does not guarantee:**

- Network isolation between parent and child. They run on the same host,
  same gateway, same network unless the contract's `network` policy adds
  OS-level restrictions.
- Filesystem isolation beyond what the contract declares in
  `allowed_paths`. There is no container or namespace boundary.
- That an inherited credential is narrower than the parent's. `inherit`
  passes through verbatim.
- That a child cannot observe side effects of the parent's execution
  through shared filesystem state.
- That the gateway itself enforces credential boundaries. Credential
  enforcement happens at dispatch time in the scheduler; the gateway
  trusts the auth-profile header it receives.

## Credential Flow

The complete credential flow from operator to child execution:

### 1. Operator provisions

Credentials enter the system via environment variables, Vault, managed
identity, or files. The operator controls `SCHEDULER_PROVIDER_PATH` and
the scheduler's execution environment. The operator may pre-provision
scoped keys (e.g. `STRIPE_KEY_FULL`, `STRIPE_KEY_PAYMENTS`,
`STRIPE_KEY_READONLY`) or a single master key that the provider uses to
mint restricted keys dynamically.

### 2. Scheduler loads providers at startup

Every `*.js` file in `SCHEDULER_PROVIDER_PATH` is dynamically imported
and registered by type (identity, authorization, proof-verifier). The
directory must not be world-writable. This is the root of trust for the
provider plugin system.

### 3. Scheduler resolves credentials at dispatch time

For each dispatched job, the scheduler runs the v0.2 evaluation chain:

1. `resolveIdentity()` -- provider resolves a credential session or
   structural fallback extracts identity from the job declaration.
2. Child credential policy enforcement -- `none` strips credentials,
   `inherit` forwards the parent's auth profile, `downscope` calls
   `prepareHandoff()` to create a narrower session, `independent` uses
   the child's own credentials (trust-capped at parent's level).
3. `evaluateTrust()` -- compares effective trust level against the
   contract floor. Blocks on `deny`, warns on `warn`.
4. `verifyAuthorizationProof()` -- validates proof if declared. Blocks
   if verification fails or verifier is missing.
5. `evaluateAuthorization()` -- evaluates inline policy or invokes
   authorization provider. Blocks on `deny`, aborts on `escalate`.

### 4. Provider narrows credentials

When `child_credential_policy` is `downscope`, the provider's
`prepareHandoff()` creates a derivative credential with reduced scope.
With dynamic RAK minting, this means the provider calls the credential
issuer's API (e.g. Stripe Restricted Keys API) to mint a per-task key
scoped to exactly the permissions the child declared. The key's lifetime
is tied to the task's timeout plus a cleanup buffer.

Scope hierarchy validation ensures the child's requested scope is
reachable from the parent's scope via the declared hierarchy.
Unreachable scopes abort dispatch. If the handoff session's trust level
would exceed the parent's, dispatch is aborted.

### 5. Child receives scoped credentials

For shell tasks, credentials are injected as environment variables via
`provider.materialize()`. For agent tasks, auth-profile forwarding
directs the gateway to use the appropriate profile. The child never sees
the master key.

### 6. Cleanup

On task completion (success or failure), `provider.cleanup()` revokes
dynamically minted keys and removes temporary materialization artifacts.
Cleanup runs even on error paths.

## Trust Boundary Definition

The operator controls:

- The scheduler's execution environment (host, env vars, process).
- The provider plugin directory (`SCHEDULER_PROVIDER_PATH`).
- The gateway connection (`OPENCLAW_GATEWAY_URL`,
  `OPENCLAW_GATEWAY_TOKEN`).
- The manifest content (via `agentcli compile` + `agentcli apply`).

Everything downstream of the operator's control surface narrows only:

- A child task MUST NOT receive broader credentials than its parent.
- A child task MUST NOT run at a higher trust level than its parent.
- Provider plugins MUST NOT widen scope during handoff.
- The scheduler MUST NOT auto-escalate trust on retry or timeout.

If the provider directory is compromised, the trust model is broken.
If the scheduler's environment variables are compromised, the trust model
is broken. These are root-of-trust assumptions, not runtime invariants.

## Benefits by Dimension

| Benefit | Always present | Only with narrowing |
|---------|---------------|---------------------|
| Blast radius (credential) | No | Yes (`downscope` / `independent`) |
| Blast radius (crash) | Yes | Yes |
| Attribution | Yes | Yes |
| Context isolation | Yes | Yes |
| Lifecycle independence | Yes | Yes |
| Least privilege (credentials) | No | Yes (`downscope` + dynamic RAK) |
| Least privilege (trust level) | Partial (contract floor) | Yes |
| Audit traceability | Yes | Yes |
| Independent timeout/retry | Yes | Yes |

## Credential Strategies

### Precreated keys (available now)

The operator creates restricted API keys ahead of time and stores them in
environment variables or Vault. The provider resolves the correct key by
scope name at dispatch time. No runtime API calls to the credential
issuer.

Trade-offs: simpler setup, works today, but keys are static and rotation
is operator-managed. Key count grows with the number of distinct scopes.

### Dynamic key minting (available now)

The provider uses an operator-provisioned master key to mint a per-task
restricted key via the credential issuer's API at dispatch time. The
minted key has:

- Scope limited to exactly the permissions the task declared.
- Lifetime tied to the task's timeout plus a cleanup buffer.
- Automatic revocation in the cleanup phase.

The master key itself is operator-provisioned and the minted keys are
always narrower than the master, never wider. This gives true per-task
credential lifecycle without operator-managed key inventories.

Both strategies use the same manifest syntax. The provider's
`key_strategy` configuration determines which path runs.

## Cross-References

- Execution Identity Architecture: `agentcli/docs/execution-identity.md`
- Gateway contract (session isolation, auth-profile forwarding):
  `docs/gateway-contract.md`
- Provider plugin system: `provider-registry.js`
- v0.2 runtime evaluation: `v02-runtime.js`
- ADR on schedule ownership: `docs/adr-schedule-ownership.md`
