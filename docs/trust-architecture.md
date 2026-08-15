# Trust Architecture

Date: 2026-03-30
Status: Accepted

Updated: 2026-08-15 for scheduler 0.5.0 and schema 30

## Purpose

This document describes the trust architecture of the scheduler/sub-agent
execution model: what the boundary guarantees, what it does not, and how
operators reason about the security properties of scheduled workflows.

## Version 0.5.0 Enforcement Status

Governance fields are no longer treated as prompt-only metadata. Every dispatch
evaluates the stored policy before execution. The runtime currently enforces a
minimal or inherited shell environment directly. A job that requests sandbox
isolation, restricted network access, allowed-path isolation, or agent cost
limits is denied unless the selected executor reports that control as actually
enforced. The default host executor does not claim those controls.

This is deliberate fail-closed behavior, not an assertion that the host process
has container, namespace, firewall, filesystem, or cost-metering isolation.
`contract_audit` is parsed and recorded, while identity, trust, authorization
proof, and credential handoff retain their provider-specific runtime
enforcement. Handoff v4 evidence declared for a run is reduced to a redacted
canonical payload, bound to the immutable execution artifact, signed or
externally verified, and stored immutably by the scheduler. Earlier handoff
versions retain the separate checksum evidence path.

Fresh shell jobs use `shell_env_policy: "minimal"`, which passes only a small
operating-system allowlist plus explicitly materialized task credentials.
Migrated jobs use `inherit` to preserve legacy behavior and emit a warning. An
`inherit` shell receives the scheduler service's complete process environment,
which can include Gateway bearer tokens or provider/master keys. It is not a
credential-isolation boundary. Materialized credential objects are cleared
during cleanup, including error and cancellation paths, but cleanup does not
remove variables inherited from the scheduler service environment.

Handoff v3 also enforces approval state and OS-derived scope matching,
structured output, delegation, external authorization references, and evidence
integrity. Approval-gated work cannot execute without a durable dispatch row.
The scheduler derives approver identity from the invoking local operating-system
account; caller-provided flags or environment variables cannot substitute
another identity. JSON and NDJSON output contracts fail the run when parsing
fails. Delegation and authorization reference failures deny before execution.
Evidence is content-addressed with SHA-256 and verified when retrieved.

## The Core Design: Scheduler as Broker, Child as Bounded Actor

The scheduler is a control-plane broker. It owns the dispatch queue,
credential resolution, trust evaluation, authorization gates, and run
lifecycle. It authenticates to the gateway with a single operator-provisioned
bearer token and holds whatever master/scoped keys the operator has loaded
into its environment or provider plugins.

Child tasks can be bounded execution principals when the selected target and
environment policy create a narrower boundary. A child's credentials are
resolved by an identity provider, narrowed via `prepareHandoff` when the policy
requires it, and materialized as scoped environment variables for minimal shell
tasks or capability-negotiated isolated agent turns. Auth-profile-only isolated
turns may instead use the existing profile header. Main-session jobs cannot
receive a task-scoped materialized environment. An `inherit` shell is the
important exception: it receives the full scheduler environment and can see
any bearer token or master key present there.

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
- **Tools** -- different tool set, an executor that enforces the declared
  sandbox mode, or a spawn depth cap.
- **State** -- isolated session with no access to parent's memory or
  conversation history.
- **Network/filesystem scope** -- an executor that actually enforces different
  `allowed_paths` or network policy. The default host executor rejects these
  restrictions because it cannot enforce them.

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
- Audit attribution: declared runs persist the resolved identity and redacted
  trust, authorization, delegation, and credential-handoff summaries. Evidence
  records bind those summaries and an output hash to one run with canonical
  SHA-256 integrity.
- Security aborts do not fire triggered children: a parent that fails a
  security gate (identity, trust, authorization, proof) does not dispatch
  downstream work.

**Does not guarantee:**

- Network isolation between parent and child under the default host executor.
  A restrictive `contract_network` is denied instead of being simulated.
- Filesystem isolation under the default host executor. A non-empty
  `contract_allowed_paths` is denied unless a path-isolating executor is
  configured. There is no implicit container or namespace boundary.
- That an inherited credential is narrower than the parent's. `inherit`
  passes through verbatim.
- That a child cannot observe side effects of the parent's execution
  through shared filesystem state.
- That a Gateway capability advertisement proves the Gateway implementation is
  trustworthy. The scheduler requires `chat-completions-env-inject-v1` before
  sending a materialized env map, but the operator still controls and trusts
  the connected Gateway. Auth-profile routing remains a separate Gateway trust
  surface.
- That a SHA-256 evidence record is a digital signature or third-party
  attestation. It detects payload changes after generation; authenticity still
  depends on the scheduler and any configured proof provider. Raw credentials
  are never stored as evidence.

## Approval Boundary

Every dispatch for a job with `approval_required` enters the durable approval
gate, including scheduled, one-shot, manual, chain-triggered, and retry work.
The approval record snapshots the optional `low`, `medium`, or `high` risk
level, approver scope, and a canonical SHA-256 binding of the persisted job
execution contract.

An approver scope may be an unprefixed exact identity or use `exact:`, `user:`,
`uid:`, or `principal:` for a normalized local identity. Domain scopes are not
supported. The decision command derives username, UID, and local principal from
the invoking operating-system account. Approving a scoped gate requires that
derived identity to match, and scoped gates cannot use timeout auto-approval.
If the job changes, is disabled, or is deleted before execution, the approval
is cancelled rather than transferred to different work.

Operators should decide by immutable approval ID with `approvals approve` or
`approvals reject`. Legacy job-ID commands locate only the current pending gate
for that job and do not accept an identity override. This boundary authenticates
the local OS caller; remote approval services still need their own authenticated
mapping to a restricted local account. Use `approvals list --json` when copying
the complete approval UUID.

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
3. `validateDelegation()` -- enforces the declared mode, maximum chain depth
   (16 by default), allowed delegators, per-hop grants, cycle detection, and
   any provider denial.
4. `evaluateTrust()` -- compares effective trust level against the
   contract floor. Blocks on `deny`, warns on `warn`.
5. `verifyAuthorizationProof()` -- validates proof if declared. Blocks
   if verification fails or verifier is missing.
6. `evaluateAuthorization()` -- evaluates inline policy, or resolves
   `authorization_ref` through the named provider's `resolvePolicy()` or
   `resolveAuthorization()` method. Missing, unresolved, or failing resolvers
   deny. Resolved policies are structural unless they explicitly name a provider
   that implements `authorize()`. Provider decisions block on `deny` and abort
   on `escalate`.

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
`provider.materialize()`. A shell using `shell_env_policy: "inherit"` also
receives the scheduler's full service environment, including any bearer or
master credentials stored there; use `minimal` for task-scoped isolation. For
isolated agent tasks, a non-empty materialized env map triggers Gateway
capability discovery. The scheduler sends
`x-openclaw-env-inject` only when the Gateway advertises
`chat-completions-env-inject-v1`; otherwise dispatch fails closed with
`GATEWAY_ENV_INJECT_UNSUPPORTED` before credentials leave the scheduler.
Auth-profile-only isolated turns remain compatible without that capability.
Main-session tasks reject materialized credential handoff because their event
path cannot enforce a task-scoped environment. Minimal shell and isolated
handoff paths do not intentionally forward the provider's master key, but an
inherited shell can observe it when it exists in the service environment.

### 6. Cleanup

On task completion (success or failure), `provider.cleanup()` revokes
dynamically minted keys and removes temporary materialization artifacts.
Cleanup runs even on error paths.

## Evidence Integrity

Handoff versions 1 through 3 may omit a provider for legacy checksum behavior
or select `sha256`/`checksum` with only the `sha256` method and without required
external verification. The scheduler advertises this path separately as
`checksum_evidence_generation: true`.

Handoff v4 implements AgentCLI's complete evidence payload and verification
envelope. The canonical payload binds the immutable artifact, runtime instance,
exact lineage, identity, proof, authorization, command result, structured
output, postcondition, and terminal status. The selected provider must sign or
externally verify the payload when verification is required. SSH evidence uses
`ssh-keygen -Y sign` and `ssh-keygen -Y verify` with the declared principal and
allowed signers. Required evidence is never silently downgraded to the checksum
backend.

`openclaw-scheduler runs evidence RUN_ID --json` reconstructs the persisted
execution input and re-verifies the cryptographic envelope. Payload, signature,
artifact, or execution transplant tampering exits nonzero. Evidence never
includes raw materialized credentials, bearer tokens, proof values, private
keys, or provider secrets.

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
