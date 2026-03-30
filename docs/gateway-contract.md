# OpenClaw Gateway Contract

Date: 2026-03-28

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
   `~/.openclaw/credentials/.gateway-token`. The file contents are read once
   and cached for the process lifetime.

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
- `gateway.js` lines 15-34 (`getGatewayToken`, `authHeaders`)
- `dispatch/index.mjs` lines 86-96 (`getGatewayToken`, `GATEWAY_TOKEN`)

---

## Gateway Base URL

Resolved from `OPENCLAW_GATEWAY_URL`, defaulting to `http://127.0.0.1:18789`.

Reference:
- `gateway.js` line 8
- `dispatch/index.mjs` line 39

---

## Endpoints

### POST /v1/chat/completions

**Purpose**: Primary dispatch mechanism for isolated scheduler jobs. Sends a
single user message to an agent and receives the complete assistant response.

**Callers**:
- `gateway.js` `runAgentTurn()` (line 59)
- `gateway.js` `runAgentTurnWithActivityTimeout()` (line 183)

**Request headers**:

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | Always `application/json` |
| `Authorization` | Conditional | `Bearer <token>` when token is available |
| `x-openclaw-scopes` | Conditional | `operator.write` when a bearer token is sent. This scope header is specific to chat-completions dispatch. |
| `x-openclaw-agent-id` | Conditional | Agent ID string (e.g. `main`). Omitted when falsy. |
| `x-openclaw-session-key` | Conditional | Session key for continuity. Omitted when not provided. |
| `x-openclaw-auth-profile` | Conditional | Auth profile override. Omitted when null. See "Auth-Profile Forwarding" below. |

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

The `model` field defaults to `openclaw:<agentId>` but can be overridden via
`job.payload_model`.

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

**Caller**: `gateway.js` `invokeGatewayTool()` (line 266)

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
  "sessionKey": "<session_key>"
}
```

**Timeout**: 30 seconds via `AbortSignal.timeout(30_000)`.

**Error semantics**: Non-2xx throws `Gateway <tool> failed (<status>): <body
first 500 chars>`.

#### Tool: `sessions_list`

**Caller**: `gateway.js` `listSessions()` (line 291)

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
  (line 144)
- `getAllSubAgentSessions` -- fetches all active subagent sessions (line 305)
- `dispatcher-strategies.js` -- resolves `auth_profile: 'inherit'` by finding
  the main session's auth profile (line 582)
- `dispatcher-maintenance.js` via `checkTaskTrackers` -- correlates subagent
  sessions with task group agents

#### Tool: `message`

**Caller**: `gateway.js` `deliverMessage()` (line 385)

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

**Also used directly in dispatch/index.mjs** (line 782-799) via raw `fetch` to
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
  "sessionKey": "main"
}
```

---

### GET /health

**Purpose**: Determine whether the gateway is reachable and responsive.

**Callers**:
- `gateway.js` `checkGatewayHealth()` (line 402)
- `gateway.js` `waitForGateway()` (line 423)

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
- Shell and main-session jobs continue regardless.
- Health is re-checked every 60 seconds (`dispatcher.js` line 490).

---

### GET /sessions/:sessionKey

**Purpose**: Retrieve session metadata including message count for activity
validation.

**Caller**: `dispatch/index.mjs` `cmdDone()` (line 1529)

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

**Purpose**: Inject a system event into the main session. Used for jobs with
`session_target: 'main'` that communicate via the primary conversation thread
rather than isolated sessions.

**Caller**: `gateway.js` `sendSystemEvent()` (line 243)

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

**Used by**: `dispatcher-strategies.js` for main-session dispatch strategy, and
`dispatcher.js` via `buildDispatchDeps()` (line 293).

---

### CLI: openclaw gateway call

**Purpose**: Invoke gateway RPC methods via the openclaw CLI. Used by
`dispatch/index.mjs` for session management operations that are not exposed as
direct HTTP endpoints.

**Caller**: `dispatch/index.mjs` `gatewayCall()` (line 210)

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
parseable JSON before throwing.

#### Methods called:

**`sessions.patch`** -- Configure session properties before agent dispatch.

Called in `cmdEnqueue()` (lines 644-666) for fresh sessions:

```json
// Set spawn depth
{ "key": "<sessionKey>", "spawnDepth": 1 }

// Set model override (when --model is provided)
{ "key": "<sessionKey>", "model": "<model>" }

// Set thinking level (when --thinking is provided)
{ "key": "<sessionKey>", "thinkingLevel": "low" | "high" | "xhigh" | null }
```

**`agent`** -- Dispatch a message to an agent session.

Called in `cmdEnqueue()` (line 735) and `cmdSend()` (line 1638):

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

For `cmdSend` (mid-session steering), the call uses `lane: 'nested'` and
`deliver: false`.

**`chat.history`** -- Retrieve session transcript.

Called in `cmdResult()` (line 1335):

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

Called in `checkSessionDone()` (line 442) when a session is not found in the
local sessions.json store:

```json
{ "activeMinutes": 1440 }
```

Used to confirm whether a session is still active in the gateway before
auto-resolving it as done. This handles the case where subagent sessions
(openclaw 2026.3.13+) are tracked via SessionBindingService and are NOT
written to sessions.json.

---

## Session Lifecycle

### Creation

Sessions are created implicitly. The scheduler generates a session key in the
format `agent:<agentId>:subagent:<uuid>` (dispatch/index.mjs `makeSessionKey`,
line 524). No explicit "create session" API exists -- the gateway creates the
session when it first receives a request with that key.

### Configuration (Pre-dispatch)

Before dispatching work, `cmdEnqueue` patches the session via
`openclaw gateway call sessions.patch` to set:
- `spawnDepth: 1` (always, for fresh sessions)
- `model` (if `--model` flag was provided)
- `thinkingLevel` (if `--thinking` flag was provided)

### Dispatch

The scheduler dispatches work via two paths:

1. **Isolated agent turns** (`dispatcher.js` -> `dispatcher-strategies.js`):
   Uses `runAgentTurnWithActivityTimeout()` which calls
   `POST /v1/chat/completions`. The response session key is stored in the run
   record via `updateRunSession()`.

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

1. **Local sessions store**: Reads
   `~/.openclaw/agents/<agent>/sessions/sessions.json` directly from disk
   (`readSessionsStore`, line 321). This is treated as ground truth for
   sessions that appear there.

2. **Gateway API fallback**: When a session is not found in the local store
   (common for subagent sessions in openclaw 2026.3.13+),
   `checkSessionDone()` falls back to `openclaw gateway call sessions.list`
   (line 442) to confirm whether the session is still active.

### Completion Detection

A session is considered done when:
- It is not found in either the sessions store or the gateway API (and is not
  within the 5-minute young session grace period).
- It is found but has been idle past the threshold (default: max of job timeout
  or 10 minutes).
- The agent explicitly calls the `done` subcommand, which sets the label status
  in labels.json.

### Patching (Post-completion)

No explicit session close/delete API is called. Sessions remain in the store
after completion. Label status is updated in labels.json to `done`,
`interrupted`, or `error`.

---

## Activity Timeout Pattern

`runAgentTurnWithActivityTimeout()` in `gateway.js` (line 119) implements a
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

Jobs can specify an `auth_profile` field with three modes:

### null (default)
No `x-openclaw-auth-profile` header is sent. The gateway uses its default
authentication profile.

### "inherit"
The scheduler resolves the main session's active auth profile at dispatch time.
It calls `listSessions({ kinds: ['main'], activeMinutes: 120, limit: 10 })` via
the `sessions_list` tool, finds the main session, and reads its
`authProfileOverride`, `authProfile`, or `profile` field (in that priority
order).

If a profile is found, it replaces `'inherit'` with the resolved profile ID
string. If no main session profile is found, `'inherit'` is passed through
as-is to the gateway.

Reference: `dispatcher-strategies.js` lines 578-601.

### "provider:label" (explicit)
A specific provider and label string (e.g. `anthropic:production`) is passed
directly as the `x-openclaw-auth-profile` header value without resolution.

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

### Precedence when both headers are present

A request may include both `x-openclaw-auth-profile` and
`x-openclaw-env-inject`. These are complementary, not competing:

- `x-openclaw-auth-profile` selects which credential profile the gateway
  uses for upstream API calls (model provider routing).
- `x-openclaw-env-inject` injects task-scoped environment variables into
  the child session's process environment (credential materialization).

If the gateway receives both, it should apply both: select the auth profile
for provider routing, and merge the env vars into the child environment.
Neither header overrides the other.

### Header size limits

Materialized env maps should be kept small (a handful of API keys and
scope tokens). The scheduler does not enforce a size limit, but HTTP
proxies and gateways typically cap individual header values at 8 KB.
Gateway implementations should reject `x-openclaw-env-inject` values
that exceed a reasonable threshold (suggested: 8192 bytes) and return
`431 Request Header Fields Too Large`.

### Receiver-side implementation notes

When the gateway parses `x-openclaw-env-inject`, it must use a safe
merge strategy. Specifically:

- Parse the header value with `JSON.parse`.
- Validate the result is a plain object (not an array, not a prototype
  chain exploit).
- Merge only string-valued entries into the child process environment.
- Do not use recursive merge or spread into `Object.prototype` --
  naive merge enables prototype pollution.

This path requires matching receiver-side support in the gateway. Until that
support is available, `auth_profile` forwarding remains the compatibility path
for agent-side credential selection.

Reference: `gateway.js` (`buildEnvInjectHeader()`, `runAgentTurn()`,
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
- **Credential materialization:** for shell tasks, credentials are injected as
  environment variables by the identity provider. For agent tasks, the
  scheduler can now forward a materialized env map via
  `x-openclaw-env-inject`; `auth_profile` forwarding remains the profile-based
  compatibility path when the gateway does not yet apply env injection.

---

## Local Provider Plugins

### Dispatch-Time Authorization Evaluation

The scheduler evaluates **inline** `authorization` JSON at dispatch time. When
the authorization blob names a provider (`authorization.provider` or
`authorization.authorization_provider`), that provider is invoked and must
return one of `permit`, `deny`, or `escalate`; unsupported or missing decisions
fail closed as `deny`.

`authorization_ref` by itself is **not** an external-policy lookup mechanism
today. If `authorization_ref` is set and `authorization` is empty, dispatch-time
evaluation fails closed with `deny` because external policy resolution is not
implemented yet. Jobs that need a dispatch-time authorization gate must provide
an inline authorization blob (optionally provider-backed), or remove the ref.

The scheduler can load local identity, authorization, and proof-verifier
plugins from `SCHEDULER_PROVIDER_PATH` at startup. Every `*.js` file in that
directory is imported and registered by `provider-registry.js`.

This is a high-trust boundary:

- `SCHEDULER_PROVIDER_PATH` should point only to operator-controlled code.
- The directory should not be writable by untrusted users or automation.
- If a job explicitly references a provider or verifier and that plugin is not
  loaded, the v0.2 runtime fails closed instead of falling back to structural
  checks.
- Credential handoff materialization is currently shell-only. Jobs that declare
  `identity.presentation` or `credential_handoff` must use
  `session_target: "shell"`; non-shell jobs fail closed at validation/dispatch
  time.

For the broader trust architecture that frames this provider trust boundary
within the scheduler/child execution model, see `docs/trust-architecture.md`.

Reference:
- `dispatcher.js` lines 818-819
- `provider-registry.js` lines 8-35
- `v02-runtime.js` lines 50-122, 250-324, 338-414

---

## Cancellation and Interruption

### Current State

There is no explicit cancel API. Cancellation is achieved exclusively through
timeout-based abort:

- **`runAgentTurn`**: Hard `AbortController` timeout on the fetch request.
- **`runAgentTurnWithActivityTimeout`**: Two-tier abort (idle + absolute).
- **Watchdog jobs**: `dispatch/index.mjs` registers watchdog cron jobs that run
  the `stuck` subcommand. Stuck sessions are reported but not actively
  cancelled -- they are auto-resolved as `interrupted` in the labels ledger
  when the sessions store confirms they are idle.

When a session is auto-resolved (via `cmdStatus`, `cmdStuck`, or `cmdSync`),
the label is marked `interrupted` with a summary noting that work may be
incomplete. The associated watchdog job is disarmed via the scheduler CLI
(`jobs disable`).

### Proposed: Explicit Cancel API

A `sessions.cancel` method or `sessions.patch` with a cancel flag would allow
the scheduler to actively terminate a session rather than waiting for the
timeout to expire. This would reduce resource waste from abandoned sessions and
provide faster feedback to delivery targets.

---

## Version and Capability Discovery

### Current State

The scheduler performs no version or capability checking against the gateway.
The `/health` endpoint is used only as a binary reachability check (2xx = up,
anything else = down). There is no mechanism to detect whether the gateway
supports specific tools, API versions, or features.

This creates a fragile coupling: if the gateway removes or changes a tool (e.g.
`sessions_list` response shape), the scheduler will fail at runtime with
opaque errors rather than a clear incompatibility signal.

### Proposed: Version and Capability Endpoint

The `/health` response should include version and capability metadata:

```json
{
  "ok": true,
  "version": "2026.3.15",
  "capabilities": [
    "sessions_list",
    "sessions.patch",
    "chat.history",
    "agent",
    "message"
  ]
}
```

Alternatively, a dedicated `GET /v1/info` endpoint could serve this purpose,
keeping `/health` lightweight for load balancer probes.

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
| `POST /v1/chat/completions` | HTTP | `gateway.js` | Agent turn dispatch |
| `POST /tools/invoke` (sessions_list) | HTTP | `gateway.js` | Session activity polling, auth profile resolution |
| `POST /tools/invoke` (message) | HTTP | `gateway.js`, `dispatch/index.mjs` | Message delivery, notifications |
| `GET /health` | HTTP | `gateway.js` | Gateway reachability check |
| `GET /sessions/:key` | HTTP | `dispatch/index.mjs` | Session activity validation (done guard) |
| `openclaw system event` | CLI | `gateway.js` | Main-session event injection |
| `openclaw gateway call sessions.patch` | CLI | `dispatch/index.mjs` | Session configuration (model, thinking, spawnDepth) |
| `openclaw gateway call agent` | CLI | `dispatch/index.mjs` | Subagent session dispatch |
| `openclaw gateway call chat.history` | CLI | `dispatch/index.mjs` | Session transcript retrieval |
| `openclaw gateway call sessions.list` | CLI | `dispatch/index.mjs` | Session existence verification (fallback) |
| `x-openclaw-agent-id` | Header | `gateway.js` | Route request to correct agent |
| `x-openclaw-session-key` | Header (req) | `gateway.js` | Session continuity |
| `x-openclaw-session-key` | Header (resp) | `gateway.js` | Session key propagation |
| `x-openclaw-auth-profile` | Header | `gateway.js` | Auth profile override |
| `~/.openclaw/agents/<agent>/sessions/sessions.json` | File | `dispatch/index.mjs` | Local session state (ground truth) |
