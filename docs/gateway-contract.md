# OpenClaw Gateway Contract

Date: 2026-03-28

Updated: 2026-08-15 for scheduler 0.5.0 and schema 30

## Purpose

This document defines the gateway API surface that openclaw-scheduler depends on.
The scheduler relies on these endpoints and behaviors for session management,
agent execution, system event injection, and health monitoring. Changes to these
surfaces should be coordinated to avoid breaking the scheduler.

---

## Authentication

The scheduler resolves a bearer token using the following fallback chain:

1. **Environment variable**: `OPENCLAW_GATEWAY_TOKEN` (checked first).
2. **Token file**: Path from `OPENCLAW_GATEWAY_TOKEN_PATH`, or the default
   `~/.openclaw/credentials/.gateway-token`. The file is read for every request,
   so an atomic token-file replacement takes effect without restarting the
   scheduler. The canonical file must remain under `~/.openclaw/credentials`,
   `/run/secrets`, or `/var/run/secrets`; symlinks that escape those roots are
   rejected.

When a token is available, every HTTP request includes:

```
Authorization: Bearer <token>
```

If neither source provides a token, requests are sent without an
`Authorization` header.

Scope headers are endpoint-specific. When the scheduler needs a scoped gateway
operation, the per-endpoint contract below defines the additional
`x-openclaw-scopes` header.

**dispatch/index.mjs** uses a slightly different resolution path for the CLI
context: it checks `OPENCLAW_GATEWAY_TOKEN` first, then falls back to reading
`~/.openclaw/openclaw.json` at `gateway.auth.token`.

Reference:
- `gateway.js` (`getGatewayToken`, `authHeaders`)
- `dispatch/index.mjs` (`getGatewayToken`, `GATEWAY_TOKEN`)

---

## Gateway Base URL

Resolved from `OPENCLAW_GATEWAY_URL`, defaulting to `http://127.0.0.1:18789`.

Reference:
- `gateway.js` (`GATEWAY_URL`)
- `dispatch/index.mjs` (`GATEWAY_URL`)

---

## Endpoints

### POST /v1/chat/completions

**Purpose**: Primary dispatch mechanism for isolated scheduler jobs. Sends a
single user message to an agent and receives the complete assistant response.

**Callers**:
- `gateway.js` `runAgentTurn()`
- `gateway.js` `runAgentTurnWithActivityTimeout()`

**Request headers**:

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | Always `application/json` |
| `Authorization` | Conditional | `Bearer <token>` when token is available |
| `x-openclaw-scopes` | Conditional | `operator.write` when a bearer token is sent. This scope header is specific to chat-completions dispatch. |
| `x-openclaw-agent-id` | Conditional | Agent ID string (e.g. `main`). Omitted when falsy. |
| `x-openclaw-session-key` | Conditional | Session key for continuity. Omitted when not provided. |
| `x-openclaw-model` | Conditional | Model ref override (e.g. `example/gpt-4o`) for non-routing model refs. Omitted when `payload_model` is empty or is itself a routing id. See "Model Forwarding" below. |

**Request body**:

```json
{
  "model": "openclaw:<agentId>",
  "messages": [
    { "role": "user", "content": "<prompt text>" }
  ],
  "stream": false
}
```

The `model` field defaults to `openclaw:<agentId>`; see "Model Forwarding" below for
how `job.payload_model` values are routed.

### Model Forwarding

The gateway's `/v1/chat/completions` endpoint accepts only **routing model ids** in
the request body (`openclaw`, `openclaw/default`, `openclaw/<agentId>`,
`agent:<agentId>`); concrete `provider/model` refs (e.g. `example/gpt-4o`)
are rejected there. The scheduler therefore splits the requested model before
dispatch (`splitModelOverride` in `gateway.js`):

- **Routing id** (or empty) → sent in the body's `model` field as before.
- **Provider/model ref** → body carries `openclaw:<agentId>` and the ref is
  forwarded in the `x-openclaw-model` header, which the gateway resolves via
  `parseModelRef` with its model visibility-policy check. This requires
  owner-equivalent HTTP auth (the shared-secret gateway token qualifies).

The scheduler never writes local session overrides. Model-only dispatch adds no
preparation RPC. Gateway routing IDs use `[a-z0-9][a-z0-9_-]{0,63}`,
case-insensitively. Incompatible routing syntax, a routing owner different from
`agentId`, or an incompatible default agent route is rejected locally. General
scheduler identity validation remains separate.

An explicit profile requires separate preparation; see "Auth-Profile Forwarding"
and "Fallback Model / Auth Selection" for failure and uncertainty handling.

**Response body** (expected):

```json
{
  "choices": [
    {
      "message": {
        "content": "<assistant reply>"
      }
    }
  ],
  "usage": { ... }
}
```

The scheduler reads `data.choices[0].message.content` and `data.usage`.

**Response headers read**:

| Header | Description |
|---|---|
| `x-openclaw-session-key` | Returned session key. Used to update the caller's session tracking. |

**Error semantics**:
- Any non-2xx status throws: `Chat completions failed (<status>): <body first 500 chars>`
- `AbortError` / `TimeoutError` from the fetch signal is translated into a
  descriptive timeout message (see "Activity Timeout" below).

**Timeout behavior**:
- `runAgentTurn`: Hard wall-clock abort via `AbortController` at `timeoutMs`
  (default 300000ms / 5 min).
- `runAgentTurnWithActivityTimeout`: Two-tier timeout -- see "Activity Timeout
  Pattern" below.

---

### POST /tools/invoke

**Purpose**: Invoke gateway-side tools for session listing, message delivery,
and session management.

**Caller**: `gateway.js` `invokeGatewayTool()`

**Request headers**:

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | Always `application/json` |
| `Authorization` | Conditional | `Bearer <token>` when available |

**Request body**:

```json
{
  "tool": "<tool_name>",
  "args": { ... },
  "sessionKey": "<session_key>",
  "agentId": "<owner_id>"
}
```

`agentId` is always included: it is the owner pinned for the session key
(`agentIdFromSessionKey`), so bare keys like `"main"` resolve on multi-agent
gateways instead of 400ing with `session key "main" has no explicit owner`.

**Timeout**: 30 seconds via `AbortSignal.timeout(30_000)`.

**Error semantics**: Non-2xx throws `Gateway <tool> failed (<status>): <body
first 500 chars>`.

#### Tool: `sessions_list`

**Caller**: `gateway.js` `listSessions()`

**Args**:

```json
{
  "activeMinutes": 60,
  "limit": 200,
  "kinds": ["subagent"],
  "messageLimit": 0
}
```

All fields are optional. `messageLimit: 0` is always sent to suppress message
history and return only session metadata.

**Response**: The scheduler normalizes across several possible response shapes:

```
result.result.details.sessions
result.result.sessions
result.sessions
result (raw array)
```

Each session object is expected to have at minimum: `key` (or `sessionKey`),
`updatedAt`.

**Used by**:
- `runAgentTurnWithActivityTimeout` -- polls session activity during long runs
- `getAllSubAgentSessions` -- fetches all active subagent sessions
- `dispatcher-strategies.js` `executeAgent()` -- resolves `auth_profile: 'inherit'` by finding
  the main session's auth profile
- `dispatcher-maintenance.js` via `checkTaskTrackers` -- correlates subagent
  sessions with task group agents

#### Tool: `message`

**Caller**: `gateway.js` `deliverMessage()`

**Args**:

```json
{
  "action": "send",
  "message": "<text>",
  "channel": "telegram",
  "target": "<chat_id>"
}
```

Used for delivering job results, check-in updates, and notifications to
Telegram or other channels. Messages exceeding `TELEGRAM_MAX_MESSAGE_LENGTH`
(4096 chars) are split into numbered chunks by `splitMessageForChannel`.

Scheduler run delivery is not stored in the agent prompt inbox. Completion
commits an entry in `delivery_outbox` and optional `delivery_attachments` rows.
A claimed outbox row carries an owner, token, and expiry; expired claims are
recovered before retry. Only the outbox consumer invokes the gateway `message`
tool for that row. This separation prevents externally addressed output from
being injected into a later agent prompt.

Dispatch completion has the same boundary. Both `dispatch done` and routed
watchers acquire a label/session/run-scoped completion claim and enqueue only
through `delivery_outbox`. A routed watcher emits
`WATCHER_ALREADY_DELIVERED` on stderr and leaves stdout empty after durable
enqueue. The marker tells the scheduler wrapper not to enqueue a duplicate; it
does not assert that the Gateway or destination accepted the message. The
completion debt remains open until every outbox part is delivered. A watcher
without a delivery route preserves stdout compatibility only after acquiring
its claim. Completion claim storage failures are explicit and fail closed as
`COMPLETION_CLAIM_UNAVAILABLE`.

Multipart messages are split before enqueue. Each part is an independently
retryable outbox row with a deterministic `:part:i/N` idempotency suffix, so
the delivery checkpoint records partial progress without resending completed
parts. `delivery_group_id`, `part_index`, and `part_count` persist the group
coordinates, with uniqueness enforced per group and part index.

**Also used directly in dispatch/index.mjs** `cmdEnqueue()` via raw `fetch` to
`POST /tools/invoke` for the "Starting..." notification when spawning a
subagent session:

```json
{
  "tool": "message",
  "args": {
    "action": "send",
    "channel": "<deliverChannel>",
    "target": "<deliverTo>",
    "message": "<brand> [<label>] starting..."
  },
  "sessionKey": "main",
  "agentId": "main"
}
```

---

### GET /health

**Purpose**: Determine whether the gateway is reachable and responsive.

**Callers**:
- `gateway.js` `checkGatewayHealth()`
- `gateway.js` `waitForGateway()`

**Request headers**: `Authorization: Bearer <token>` when available.

**Timeout**: 5 seconds for `checkGatewayHealth`, variable for `waitForGateway`
(capped at 5 seconds per attempt).

**Response semantics**:
- `checkGatewayHealth()` returns `true` if `resp.ok` (2xx), `false` otherwise
  or on any error.
- `waitForGateway()` treats **any HTTP response** (even non-200) as "gateway is
  up" -- it only needs TCP connectivity. It polls at `intervalMs` (default
  2000ms) up to `timeoutMs` (default 30000ms).

**Scheduler behavior when unhealthy**:
- Isolated jobs are deferred (next_run_at pushed forward by 60s).
- Shell jobs continue independently.
- Main-session jobs may still be attempted, but they require the Gateway.
  Default, `execute`, or `plan` jobs use synchronous agent execution and defer
  for 60 seconds when the health check fails. `fire-and-forget` jobs use
  `openclaw system event`; request failures use configured retry behavior.
  Handoff v4 requires the synchronous route because the system-event CLI
  cannot carry an artifact-bound capability contract; v4 fire-and-forget jobs
  fail validation.
- Health is re-checked every 60 seconds (`dispatcher.js` `tick()`).

---

### GET /sessions/:sessionKey

**Purpose**: Retrieve session metadata including message count for activity
validation.

**Caller**: `dispatch/index.mjs` `cmdDone()`

**Request headers**: `Authorization: Bearer <GATEWAY_TOKEN>`

**Timeout**: 5 seconds via `AbortSignal.timeout(5000)`.

**Response body** (expected):

```json
{
  "messageCount": 15,
  "messages": [ ... ]
}
```

The scheduler reads `sessionInfo.messageCount` or falls back to
`sessionInfo.messages.length`. If the count is 2 or fewer, the done signal is
rejected as the session likely did not perform real work.

**Error handling**: Non-2xx responses or fetch failures are treated as
non-fatal -- the activity check is skipped with a stderr warning.

---

### CLI: openclaw system event

**Purpose**: Inject a system event into the main session. Used only for jobs
with `session_target: 'main'` and
`execution_intent: 'fire-and-forget'`. Default, `execute`, or `plan`
main-session jobs use synchronous agent execution through
`POST /v1/chat/completions`.

**Caller**: `gateway.js` `sendSystemEvent()`

**Invocation**:

```
openclaw system event --text <text> --mode <now|queue> --json
```

**Arguments**:
- `--text`: The event text to inject.
- `--mode`: Either `now` (immediate injection) or `queue` (buffered delivery).
  Validated against `VALID_MODES` set.
- `--json`: Request JSON output.

**Timeout**: 30 seconds (`execFileSync` timeout).

**Response parsing**: stdout is parsed as JSON. Any non-JSON prefix (e.g.
openclaw doctor output) is stripped by finding the first `{` character.

**Error semantics**: Throws `system event failed: <message>`.

**Used by**: `dispatcher-strategies.js` for the fire-and-forget branch of the
main-session dispatch strategy, and `dispatcher.js` via `buildDispatchDeps()`.

---

### CLI: openclaw gateway call

**Purpose**: Invoke gateway RPC methods via the openclaw CLI. Used by
`dispatch/index.mjs` for session management operations that are not exposed as
direct HTTP endpoints.

**Caller**: `dispatch/index.mjs` `gatewayCall()`

**Invocation**:

```
openclaw gateway call <method> --json --params '<json>' --timeout <ms> [--expect-final]
```

**Environment**: If `GATEWAY_TOKEN` is available, it is passed as
`OPENCLAW_GATEWAY_TOKEN` in the child process environment.

**Timeout**: `opts.timeout` (default 15000ms) passed to the CLI, plus a 5000ms
buffer on the `execFileSync` call.

**Response parsing**: stdout is parsed as JSON. Non-JSON prefix lines (e.g.
plugin init logs) are stripped. On error, stderr and stdout are both checked for
parseable JSON before throwing. A parsed RPC error envelope such as
`{"ok":false,"error":{...}}` is an error even when the CLI exits zero.

#### Methods called:

**`sessions.patch`** -- Configure session properties before agent dispatch.

Called in `cmdEnqueue()` for fresh sessions:

```json
// Set model override (when --model is provided)
{ "key": "<sessionKey>", "model": "<model>" }

// Set thinking level (when --thinking is provided)
{ "key": "<sessionKey>", "thinkingLevel": "low" | "high" | "xhigh" | null }
```

**`agent`** -- Dispatch a message to an agent session.

Called in `cmdEnqueue()` and `cmdSend()`:

```json
{
  "message": "<task message>",
  "sessionKey": "<session key>",
  "idempotencyKey": "<uuid>",
  "deliver": true,
  "lane": "subagent",
  "timeout": 300,
  "label": "<label>",
  "thinking": "high",
  "channel": "telegram",
  "replyTo": "<chat_id>",
  "replyChannel": "telegram"
}
```

OpenClaw's current `sessions.patch` schema does not accept `spawnDepth`.
Native session creation and sub-agent runtime policy derive and enforce the
depth, so dispatch does not patch that field. Rejection of an explicitly
requested model or thinking override aborts enqueue before the agent call.

For `cmdSend` (mid-session steering), the call uses `lane: 'nested'` and
`deliver: false`.

**`chat.history`** -- Retrieve session transcript.

Called in `cmdResult()`:

```json
{ "sessionKey": "<session key>" }
```

Response expected:

```json
{
  "messages": [
    { "role": "assistant", "content": "..." },
    ...
  ]
}
```

The scheduler scans backwards to find the last assistant message.

**`sessions.list`** -- List active sessions (gateway API fallback).

Called in `checkSessionDone()` when a session is not found in the
local SQLite-first compatibility store:

```json
{ "activeMinutes": 1440 }
```

Used as an additional liveness signal. Tree visibility can hide an externally
spawned child, so an absent result is never the only reason to declare an
accepted dispatch failed.

---

## Session Lifecycle

### Creation

Sessions are created implicitly. Scheduled isolated jobs use the stable key
`agent:<agentId>:scheduler:<jobId>` so later runs reuse the same warm per-job
session. The dispatch CLI uses `agent:<agentId>:subagent:<uuid>`
(`dispatch/index.mjs` `makeSessionKey()`) for each newly enqueued sub-agent.
Main-session jobs use `agent:<agentId>:main`. No explicit "create session" API
exists; the Gateway creates a session when it first receives a request with
that key.

### Configuration (Pre-dispatch)

Before dispatching a new CLI sub-agent, `cmdEnqueue` patches the session via
`openclaw gateway call sessions.patch` to set:
- `model` (if `--model` flag was provided)
- `thinkingLevel` (if `--thinking` flag was provided)

Spawn depth is owned by OpenClaw's native session/runtime policy. The current
Gateway rejects `spawnDepth` on `sessions.patch`, so dispatch does not send it.

### Dispatch

The scheduler dispatches work via two paths:

1. **Isolated agent turns** (`dispatcher.js` -> `dispatcher-strategies.js`):
   Uses `runAgentTurnWithActivityTimeout()` which calls
   `POST /v1/chat/completions` with a stable per-job session key. The response
   session key is stored in the run record via `updateRunSession()`.

2. **Sub-agent dispatch** (`dispatch/index.mjs`): Uses
   `openclaw gateway call agent` which is the CLI-based equivalent. Session key
   and idempotency key are tracked in the labels.json ledger.

### Polling

The `runAgentTurnWithActivityTimeout` function polls session activity during
long-running turns by calling `listSessions()` (which invokes
`sessions_list` via `/tools/invoke`) at `pollIntervalMs` intervals (default
60s). It checks `updatedAt` on the matched session to determine whether the
agent is still active.

### Status Checking

`dispatch/index.mjs` checks session state through two mechanisms:

1. **Local sessions store**: Opens
   `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` read-only and maps
   `session_nodes` plus the current `session_windows` row. Transcript fallback
   reads a bounded `transcript_events` tail. SQLite is authoritative when the
   current tables are present; older installs fall back to
   `sessions/sessions.json` and JSONL transcripts.

2. **Gateway API fallback**: `sessions.list` and `chat.history` supplement local
   state when visibility permits. They cannot be authoritative for children
   outside the caller's configured session tree.

### Completion Detection

A session is considered done when:
- SQLite/legacy lifecycle state carries a supported terminal signal, including
  current SQLite `status=done`.
- A terminal assistant transcript or explicit completion payload is observed.
- The agent explicitly calls the `done` subcommand, which sets the label status
  in labels.json.

After an accepted `agent` RPC, delayed persistence or API invisibility leaves
the label running; the watcher and configured job timeout own eventual failure.
Only an explicit gateway lane error fails post-spawn verification immediately.

### Patching (Post-completion)

No explicit session close/delete API is called. Sessions remain in the store
after completion. Label status is updated in labels.json to `done`,
`interrupted`, or `error`.

---

## Multi-Agent Gateway Routing

A single OpenClaw gateway instance serves multiple agents. The scheduler
dispatches to specific agents by setting the `x-openclaw-agent-id` header
(or encoding the agent ID in the model string as `openclaw:<agentId>`).
No pre-registration step is required -- the gateway creates agent-scoped
state on first request.

### Agent ID resolution

The gateway resolves the target agent ID from each inbound request using
two sources, in priority order:

1. **Header**: `x-openclaw-agent-id` (or `x-openclaw-agent`). Highest
   priority. This is what the scheduler sets.
2. **Model string**: `openclaw:<agentId>` or `agent:<agentId>` patterns
   parsed from the `model` field in the request body.

If neither is present, the gateway defaults to `"main"`. Agent IDs are
normalized to lowercase and must match `[a-z0-9][a-z0-9_-]{0,63}`.

Reference: `openclaw/src/gateway/http-utils.ts`
(`resolveAgentIdFromHeader`, `resolveAgentIdFromModel`,
`resolveAgentIdForRequest`).

### Agent-scoped session keys

Sessions are namespaced by agent ID. The session key format is:

```
agent:<agentId>:<prefix>:<identifier>
```

Examples:
- `agent:main:subagent:a1b2c3d4-...` -- main agent, scheduler-dispatched
  isolated session
- `agent:beta:openai:e5f6g7h8-...` -- beta, OpenAI-compat chat session
- `agent:main:telegram:webhook:123456789` -- main agent, Telegram peer

This namespacing provides session isolation between agents. Agent beta's
sessions cannot read main's conversation history or tool state, and
vice versa, even though both run on the same gateway.

Reference: `openclaw/src/routing/session-key.ts`
(`buildAgentMainSessionKey`, `DEFAULT_AGENT_ID`).

### Per-agent configuration

Each agent has its own configuration directory at
`~/.openclaw/agents/<agentId>/agent/`, containing:

- `models.json` -- provider endpoints and model definitions for this
  agent. Different agents can use different model providers (e.g. main
  uses Anthropic, beta uses OpenAI Codex via a different base URL).
- `openclaw-agent.sqlite` -- current Gateway-managed agent state, including
  the auth-profile store. Legacy Gateway versions may instead use
  `auth-profiles.json` in this directory.

Current session lifecycle and ConvMem transcript events are stored in that same
per-agent `openclaw-agent.sqlite` database (`session_nodes`, `session_windows`,
and `transcript_events`). Older Gateway versions may instead use the sibling
`sessions/` directory with `sessions.json` and JSONL transcripts.

The Gateway resolves effective model and auth state for the selected agent.
Depending on Gateway version and configuration, that effective state may use
read-through inheritance from the main agent. Agent IDs provide routing and
session isolation, but the scheduler does not claim strict credential
separation when Gateway inheritance is enabled.

### Scheduler dispatch to non-default agents

The scheduler targets a specific agent by setting `agent_id` on the job:

```json
{
  "name": "Beta Agent Daily Task",
  "schedule_cron": "0 8 * * *",
  "agent_id": "beta",
  "session_target": "isolated",
  "payload_kind": "agentTurn",
  "payload_message": "perform daily check",
  "run_timeout_ms": 300000,
  "delivery_mode": "none",
  "delivery_opt_out_reason": "gateway contract example",
  "origin": "system"
}
```

At dispatch time, `gateway.js` sets `x-openclaw-agent-id: beta` on the
outbound `/v1/chat/completions` request. The gateway routes the request
to beta's agent scope, creates a session under `agent:beta:...`, and
uses beta's model and auth profile configuration.

Jobs without an explicit `agent_id` default to `"main"`.

### Multi-agent trust considerations

When multiple agents share a gateway, each agent is a separate routing and
session principal with a Gateway-resolved effective credential scope:

- Auth state is owned and resolved by the running Gateway. The scheduler sends
  the target agent and profile selection but never copies credential files
  between agents. A job dispatched to beta therefore uses the Gateway's beta
  scope, including any Gateway-supported read-through inheritance, without
  cloning main-agent OAuth refresh material.
- The scheduler's `child_credential_policy` applies within a single
  agent's dispatch chain. Cross-agent credential scoping (e.g. a main
  job triggering a beta child with downscoped credentials) is not
  currently supported. The scheduler cannot prove that effective credential
  scopes remain distinct when Gateway inheritance applies.
- The `x-openclaw-env-inject` header is agent-agnostic: materialized
  env vars are forwarded to whichever agent the job targets.
- Session isolation between agents is enforced by the session key
  namespace. Agent A cannot access agent B's sessions or conversation
  history through the gateway.

For the broader trust architecture, see `docs/trust-architecture.md`.

---

## Activity Timeout Pattern

`runAgentTurnWithActivityTimeout()` in `gateway.js` implements a
two-tier timeout for the `/v1/chat/completions` call:

### Absolute Timeout
A hard ceiling (`absoluteTimeoutMs`, default 300000ms / 5 min) fires
regardless of activity. Maps to `job.run_timeout_ms`.

### Idle Timeout
Polls session activity via `listSessions()` at `pollIntervalMs` (default
60000ms / 1 min). Tracks `lastSeenActivity` timestamp. If the session has been
idle for `2 * idleTimeoutMs` (default `2 * 120000ms = 240s`), the request is
aborted. The idle threshold maps to `job.payload_timeout_seconds`.

### Abort Reasons
On abort, the error message distinguishes the cause:
- `idle_timeout`: "Session idle for Ns -- aborted (activity-based timeout)"
- `absolute_timeout`: "Exceeded absolute timeout of Ns"

### Parameters

| Parameter | Default | Source |
|---|---|---|
| `idleTimeoutMs` | 120000 | `job.payload_timeout_seconds * 1000` |
| `pollIntervalMs` | 60000 | Hardcoded |
| `absoluteTimeoutMs` | 300000 | `job.run_timeout_ms` |

---

## Auth-Profile Forwarding

Current Gateway supports **session-pin metadata**, not a strict execution
credential guarantee. The scheduler does not send `x-openclaw-auth-profile`:
that header has no handler in the inspected Gateway. Low-level HTTP runners
reject an unprepared `authProfile` argument instead of silently ignoring it.

### null (default)

No profile preparation RPC occurs. The Gateway retains its existing session and
default auth behavior. Omission does not clear a warm session's previous pin.
Concrete model forwarding remains through `x-openclaw-model`.

### "inherit"

Each attempt resolves exactly `agent:<job.agent_id>:main` through the existing
`sessions_list` tool, reading only `authProfileOverride`. A missing, unavailable
or unresolved same-agent profile is a definite selection failure. Neither a
main session owned by another agent nor a bare ambiguous main key is used, and
the literal `inherit` is never sent as a profile ID. The lookup is bounded by
the remaining run deadline and cancellation.

### Explicit profile with a concrete model

`prepareAgentSelection` is a separate preparation helper, outside the HTTP-only
isolated-turn primitive. It requires a concrete normalized `provider/model`
reference. It calls the reviewed absolute `OPENCLAW_CLI_PATH` executable with:

```text
openclaw gateway call sessions.patch --json --params <key/agentId/model JSON> --url <bound ws/wss URL> --timeout <remaining bounded milliseconds>
```

The patch contains exactly `key`, `agentId`, and `model: provider/model@profile`.
An inline profile suffix is also an explicit selection; a conflicting separate
profile is rejected. Date and quantization suffixes remain part of the model.
Profile-only, unresolved inherit, ambiguous suffixes and routing-ID/profile
combinations are rejected before RPC. No model/default is guessed.

`OPENCLAW_CLI_PATH` must identify the reviewed current CLI by an absolute path;
there is no PATH lookup fallback. The explicit WebSocket URL derives from the
same validated HTTP Gateway URL, and its token comes from the existing token
mechanism through the subprocess environment, never argv or diagnostics.
Activation must bind that CLI version/path separately. The inspected current
CLI requests only `operator.write` for this exact patch shape; an arbitrary
admin RPC connection is not equivalent and can update persistent model defaults.

Preparation has a ten-second ceiling bounded further by the remaining run
deadline, with cancellation and process termination. Only a successful process
exit and matching canonical session key, model and user profile pin receipt
permit HTTP dispatch. The selected concrete model stays in the existing HTTP
header after preparation. Local session or provider-auth stores are never used for this step.

A receipt proves accepted metadata only. Gateway auth resolution can clear a
missing or wrong-provider profile and continue normal auth selection. The
scheduler neither promises which credential was used nor reads auth stores to
simulate such a guarantee. Strict credential identity requires a stronger
Gateway execution contract.

## Fallback Model / Auth Selection

A job may configure `payload_model_fallback` and `auth_profile_fallback`.
The primary and at most one distinct fallback share the same run deadline.

| Primary outcome | Scheduler behavior |
| --- | --- |
| Definite local selection error or structured INVALID_REQUEST/FORBIDDEN Gateway rejection | May validate/prepare one different configured fallback; primary HTTP is not sent. |
| Process timeout/nonzero exit, transport failure, unclassified Gateway error, malformed or mismatched receipt | Mutation outcome is uncertain; no primary HTTP or fallback is launched. |
| Cancellation, expired deadline or Gateway capability failure | No extra attempt. |
| Model-only HTTP failure | Existing distinct configured model fallback remains available without an added preparation RPC. |
| Pin accepted, then HTTP failure | An explicitly prepared fallback pin can replace it. An omitted/clear profile fallback is refused because the interface cannot reliably clear the accepted pin. |
| Missing, identical or failed fallback | Run fails; no further retry. |

An unset fallback dimension retains the primary selection. An explicit empty
fallback profile does not mean a Gateway pin was cleared. Model-only or null
model patches can preserve compatible pins, so the scheduler never sends a
speculative null patch as a reset. Selection errors remain visible; no legacy
file absence is treated as successful application.

---

## Env-Inject Forwarding

When credential materialization for an agent task produces a non-empty plain
object of string environment variables, the scheduler JSON-encodes that map
and sends it as the `x-openclaw-env-inject` header on
`POST /v1/chat/completions`.

Validation rules:

- Arrays, non-plain objects, and null/undefined values are rejected.
- Empty objects are omitted.
- All values must be strings.
- Serialization uses `Object.fromEntries` on validated entries so hidden
  `toJSON` hooks on the original object cannot alter the payload.

### Profile preparation and environment injection

Session-profile preparation and `x-openclaw-env-inject` are separate operations.
The former records Gateway session metadata; the latter retains its existing
capability-gated task environment contract. No profile header is sent, and a
profile receipt does not establish environment-injection support or credential
identity. Capability failures still prevent fallback from bypassing that gate.

### Header size limits

Materialized env maps are bounded before capability discovery or dispatch. The
scheduler accepts at most 64 entries, 128 UTF-8 bytes per key, 4,096 UTF-8 bytes
per value, and 7,168 UTF-8 bytes for the serialized header. Unsafe environment
names, accessors, symbol keys, non-string values, NUL bytes, arrays, and
prototype-pollution keys fail closed with `GATEWAY_ENV_INJECT_INVALID`.

### Receiver-side implementation notes

When the gateway parses `x-openclaw-env-inject`, it must use a safe
merge strategy. Specifically:

- Parse the header value with `JSON.parse`.
- Validate the result is a plain object (not an array, not a prototype
  chain exploit).
- Merge only string-valued entries into the child process environment.
- Do not use recursive merge or spread into `Object.prototype` --
  naive merge enables prototype pollution.

This path requires matching receiver-side support in the Gateway. Before an
isolated agent request containing materialized credentials is sent, the
scheduler discovers Gateway metadata and requires the explicit
`chat-completions-env-inject-v1` capability. A legacy or current Gateway that
does not advertise that capability fails closed with
`GATEWAY_ENV_INJECT_UNSUPPORTED`; the scheduler never silently drops the
credentials or sends them to an unconfirmed receiver. Auth-profile-only
isolated turns do not require environment injection and remain compatible.

Credential materialization is supported for shell and isolated agent jobs.
Shell jobs receive the scoped environment locally. Isolated agent jobs use the
negotiated header path above. Main-session jobs reject
`identity.presentation` and `credential_handoff` because a main-session
dispatch cannot enforce a task-scoped environment boundary.

Handoff v4 synchronous main-session requests still force-refresh Gateway
capabilities and require `capability-binding-v1`, even when they carry no
credential material. The request binds the artifact digest, runtime instance,
and fresh nonce. A Gateway that cannot enforce those headers is rejected before
the main-session turn begins.

Reference: `gateway.js` (`runAgentTurn()`,
`runAgentTurnWithActivityTimeout()`) and `dispatcher-strategies.js`
(`executeAgent()`).

---

## Trust Architecture

For the full trust architecture -- including what the scheduler/child
boundary guarantees vs. what it does not, the credential flow from operator
to child, and the distinction between security boundaries and operational
boundaries -- see `docs/trust-architecture.md`.

The gateway contract intersects with the trust architecture at these points:

- **Session isolation:** isolated sessions cannot access the main session's
  memory or history. This provides context isolation between parent and child
  tasks.
- **Auth-profile forwarding:** the scheduler can direct the gateway to use a
  specific credential profile for agent tasks (see "Auth-Profile Forwarding"
  above).
- **Credential materialization:** shell tasks receive provider-materialized
  environment variables locally. Isolated agent tasks require the Gateway to
  advertise `chat-completions-env-inject-v1` before the scheduler sends the
  scoped `x-openclaw-env-inject` header. Main-session materialization is
  rejected. Auth-profile-only isolated turns remain the compatibility path for
  Gateways without environment injection.

---

## Local Provider Plugins

### Dispatch-Time Authorization Evaluation

The scheduler evaluates **inline** `authorization` JSON at dispatch time. When
the authorization blob names a provider (`authorization.provider` or
`authorization.authorization_provider`), that provider is invoked and must
return one of `permit`, `deny`, or `escalate`; unsupported or missing decisions
fail closed as `deny`.

When `authorization_ref` is set without an inline `authorization` blob, handoff
v3 resolves it through a named authorization provider. References use either
`provider:policy-ref` or `provider://provider/policy-ref`. The provider must be
loaded and implement `resolvePolicy()` or `resolveAuthorization()`. A missing
provider, unsupported resolver, missing policy, thrown error, or non-object
policy fails closed as `deny`; the scheduler never treats the reference string
itself as a permit.

Resolver output is evaluated structurally unless the returned policy explicitly
names an authorization provider. A resolver that also requires a second
`authorize()` call must set that provider field and implement `authorize()`;
the scheduler never adds it implicitly.

The scheduler can load local identity, authorization, and proof-verifier
plugins from `SCHEDULER_PROVIDER_PATH` at startup. Every `*.js` file in that
directory is imported and registered by `provider-registry.js`.

This is a high-trust boundary:

- `SCHEDULER_PROVIDER_PATH` should point only to operator-controlled code.
- The directory should not be writable by untrusted users or automation.
- If a job explicitly references a provider or verifier and that plugin is not
  loaded, the v0.2 runtime fails closed instead of falling back to structural
  checks. This includes provider-qualified `authorization_ref` policy
  resolution.
- Credential handoff materialization supports `session_target: "shell"` and
  `session_target: "isolated"`. Isolated jobs negotiate
  `chat-completions-env-inject-v1` before dispatch. Main-session jobs fail
  closed because their event-injection path cannot enforce task-scoped env
  materialization.

For the broader trust architecture that frames this provider trust boundary
within the scheduler/child execution model, see `docs/trust-architecture.md`.

Reference:
- `dispatcher.js` `main()` (provider loading at startup)
- `provider-registry.js` `loadProviders()`
- `provider-registry.js` `resolveAuthorizationRef()`
- `v02-runtime.js` (`resolveIdentity()`, `verifyAuthorizationProof()`, `evaluateAuthorization()`)

---

## Cancellation and Interruption

### Current State

Run cancellation is durable and fenced in scheduler state. A cancellation
request records the requester and reason. Only the run's dispatcher owner and
fencing token can commit its terminal transition.

- `runAgentTurn` and `runAgentTurnWithActivityTimeout` link their local abort
  signal to the active request.
- When a session key exists, `gateway.js` calls
  `openclaw gateway call chat.abort --params <json> --json` as a best-effort
  active-session cancellation request.
- The run records `agent_cancel_requested_at` for audit even when the Gateway
  is unavailable or rejects the abort.
- Completion checks cancellation state before delivery or child creation, so a
  stale agent response cannot win after cancellation.
- Watchdog status remains observational. Operators confirm the authoritative
  outcome through scheduler run state, not a chat notification.

The Gateway abort call is best effort because network failure can prevent
confirmation. Scheduler fencing still prevents the abandoned result from
committing side effects inside the scheduler, but it cannot reverse an
external side effect already performed by the agent.

---

## Version and Capability Discovery

### Current State

Version 0.5 discovers explicit Gateway version, protocol, and capability
metadata before using a capability-gated credential surface. Discovery tries,
in order:

1. `GET /v1/info` with a bounded JSON response.
2. Structured capability metadata in `GET /health`.

Only an explicit JSON capability declaration from one of those HTTP responses
is authoritative. The first authoritative response is normalized and cached
per Gateway base URL for 60 seconds during ordinary discovery. Before every
credential-bearing isolated request, the scheduler bypasses that cache and
force-refreshes capability metadata so a Gateway restart or downgrade cannot
reuse stale positive support. Metadata with invalid types, excessive size, too
many capabilities, or oversized values is rejected. Plain-text health and JSON
health without an explicit capability declaration remain valid liveness
evidence but advertise no capabilities. Current OpenClaw Gateway 2026.6.11
advertises no capabilities, so task-scoped environment injection fails closed.

`openclaw-scheduler capabilities --json` advertises this scheduler support as
`features.gateway_capability_discovery: true` and
`features.gateway_env_injection_negotiation: true`.

An HTTP discovery response may use this shape:

```json
{
  "ok": true,
  "version": "2026.7.11",
  "protocol": 4,
  "capabilities": [
    "chat-completions-env-inject-v1"
  ]
}
```

Capability discovery is lazy. Ordinary health checks and model-only agent
turns retain the bounded discovery cache. Explicit profile selections first
require the separate preparation contract above. A non-empty materialized env map force-refreshes discovery and
requires `chat-completions-env-inject-v1`; absence produces
`GATEWAY_ENV_INJECT_UNSUPPORTED` before `POST /v1/chat/completions`.

---

## Scheduler-vs-Native-Cron Distinction

### Current State

There is no mechanism to distinguish scheduler-dispatched sessions from
sessions created by other sources (native openclaw cron, direct user
interaction, other subagent spawns). The scheduler generates unique session
keys with the format `agent:<id>:subagent:<uuid>`, but this is
indistinguishable from subagent sessions spawned by other means.

### Proposed: x-openclaw-scheduler-run-id Header

Add a custom header to all scheduler-dispatched requests:

```
x-openclaw-scheduler-run-id: <run_id>
```

This would allow the gateway to tag session metadata with the originating
scheduler run, enabling:
- Filtering sessions by origin in the gateway UI or API
- Correlating gateway logs with scheduler run records
- Preventing duplicate dispatch if both the scheduler and native cron target
  the same agent

### Proposed: Session Source Metadata

Sessions should carry a `source` field in their metadata:

| Value | Description |
|---|---|
| `native-cron` | Created by openclaw's built-in cron system |
| `scheduler` | Created by openclaw-scheduler |
| `user` | Created by direct user interaction |
| `subagent` | Created by another agent session |

This could be set via `sessions.patch` at creation time or inferred from the
request headers.

---

## Summary of Gateway Dependencies

| Surface | Method | Source File | Purpose |
|---|---|---|---|
| `POST /v1/chat/completions` | HTTP | `gateway.js` | Isolated and synchronous main-session agent dispatch |
| `GET /v1/info` | HTTP | `gateway-capabilities.js` | Preferred Gateway version and capability discovery |
| `POST /tools/invoke` (sessions_list) | HTTP | `gateway.js` | Session activity polling, auth profile resolution |
| `POST /tools/invoke` (message) | HTTP | `gateway.js`, `dispatch/index.mjs` | Message delivery, notifications |
| `GET /health` | HTTP | `gateway.js` | Gateway reachability check |
| `GET /sessions/:key` | HTTP | `dispatch/index.mjs` | Session activity validation (done guard) |
| `openclaw system event` | CLI | `gateway.js` | Fire-and-forget main-session event injection |
| `openclaw gateway call sessions.patch` | CLI | `dispatch/index.mjs` | Supported session overrides (model, thinking) |
| `openclaw gateway call agent` | CLI | `dispatch/index.mjs` | Subagent session dispatch |
| `openclaw gateway call chat.history` | CLI | `dispatch/index.mjs` | Session transcript retrieval |
| `openclaw gateway call sessions.list` | CLI | `dispatch/index.mjs` | Session existence verification (fallback) |
| `openclaw gateway call chat.abort` | CLI | `gateway.js` | Best-effort active agent-session cancellation |
| `x-openclaw-agent-id` | Header | `gateway.js` | Route request to correct agent |
| `x-openclaw-session-key` | Header (req) | `gateway.js` | Session continuity |
| `x-openclaw-session-key` | Header (resp) | `gateway.js` | Session key propagation |
| `sessions.patch` | Bounded CLI RPC | `gateway.js` / `dispatch/gateway-rpc.mjs` | Explicit session-profile metadata preparation |
| `x-openclaw-env-inject` | Header | `gateway.js`, `gateway-capabilities.js` | Capability-gated task-scoped env materialization for isolated turns |
| `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` | SQLite (read-only) | `dispatch/session-store.mjs` | Current session lifecycle and transcript state |
| `~/.openclaw/agents/<agent>/sessions/` | Legacy file fallback | `dispatch/session-store.mjs` | Older `sessions.json` and JSONL session state |
