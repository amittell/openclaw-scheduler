# Security Policy

## Reporting

Report security issues privately to the maintainers instead of opening a public issue.

Preferred channel:

- GitHub private vulnerability reporting: https://github.com/amittell/openclaw-scheduler/security/advisories/new

Include:

- affected version
- deployment mode
- reproduction steps
- impact
- suggested mitigation if known

## Scope

Security-sensitive areas include:

- shell job execution
- dispatcher lease and run fencing
- process-group timeout and cancellation
- gateway credential handling
- transactional delivery outbox and attachment storage
- atomic approval decisions
- governance policy evaluation and credential cleanup
- installation and service configuration

Please report unsafe defaults, credential leaks, or privilege boundary issues.

## Runtime Boundary

Version 0.3.0 fails closed when a job requests sandbox, filesystem, network, or
agent cost controls that the selected executor cannot enforce. The default host
executor does not claim container, namespace, firewall, filesystem, or cost
metering isolation. A restrictive contract is denied rather than simulated.
Unknown sandbox or network object keys are also treated as restrictive so a
misspelled or newer policy shape cannot silently become unrestricted.

Fresh shell jobs receive a minimal environment. `shell_env_policy: "inherit"`
exposes the dispatcher environment and should be limited to reviewed legacy
jobs. Materialized task credentials are cleared during cleanup paths.
Provider cleanup is retried before terminal bookkeeping. Exhausted cleanup is
recorded as an operator-visible run error and disables the job without
re-executing its user command.

Cancellation fencing prevents a stale dispatcher from committing scheduler
state after cancellation, but it cannot reverse an external side effect that
already completed. Destructive commands still need their own idempotency and
precondition checks.

Crash recovery verifies the persisted operating-system process creation
identity before signaling a process group. Replay occurs only after process or
agent termination is confirmed and after an atomic run transition. If either
condition cannot be proved, the run becomes `recovery_blocked` and the job is
disabled for operator review.

## Response Timeline

- **Acknowledgment:** within 7 days of receipt.
- **Resolution:** within 30--90 days depending on severity and complexity.
