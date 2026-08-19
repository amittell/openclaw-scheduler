# Review notes — 0.5.2 sessions.json → SQLite fix line

Branch: `fix/dispatch-sqlite-session-store-review` @ `178c1de` (parent `8870717` = main, 0.5.1 line).
Verified against the 4 evidenced dispatch failures (2026-08-15…18, recurred 4× on the 0.2.17 live install).

## Core layer

`dispatch/session-store.mjs` (new, 409 lines): read-only `better-sqlite3` (WAL-safe) over `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`; maps `session_key → current_session_id` via `session_nodes`; transcript tail from `transcript_events` (event_json carries role/content/created_at); `dispatch/gateway-rpc.mjs` parses gateway CLI/RPC envelopes. Legacy `sessions.json`/JSONL is kept as a fallback fast-path, never the sole source. Tests evidence the fallbacks: `legacy sessions.json and JSONL remain a fallback when SQLite is absent`, `corrupt SQLite fails safely and uses a valid legacy fallback`, `missing or unreadable current and legacy stores report unavailable without throwing`.

## The 4 broken paths — verdict

1. **Spawn canary (cmdEnqueue)** — COVERED. Spawn-failure emission (`dispatch/index.mjs:667, 1912`) now resolves liveness through the SQLite store first; a missing/degraded file store no longer false-negatives a healthy session, and `getGatewayLaneTaskError` remains the hard failure signal. Regression: T1 — `status/result recover a false spawn failure from SQLite despite gateway visibility denial` + `watcher recovers a false spawn failure from SQLite and suppresses duplicate completion` (tests/dispatch-session-store.test.mjs). Pass.
2. **Completion detection (checkSessionDone, `dispatch/index.mjs:1060`)** — COVERED. Null/absent store no longer means "stay running forever"; terminal state resolves via SQLite/gateway, done → completion summary extracted from the SQLite transcript tail. Regression: T2 in the same suite. Pass.
3. **Stuck detector (cmdStuck, `dispatch/index.mjs:2163`; `getSessionsStoreForEntry:2174`)** — COVERED. Uses SQLite `transcript_events` MAX(created_at) recency instead of label `lastPing` alone (fresh write < threshold → not stuck; stale > threshold → still flags, guardrail preserved). This is exactly the class that produced the false "silent N min" alert on an active long-turn cherry-pick session (observed 2026-08-18 20:00 and 2026-08-19 early). Regression: T3. Pass.
4. **Terminal reply (watcher, `dispatch/watcher.mjs:801` getSessionTerminalReply)** — COVERED. SQLite-based with legacy JSONL fallback; `agents/<agent>/sessions/<id>.jsonl` absence (the 2026.8.1 deprecation) no longer makes completion text unrecoverable. Regression: T4. Pass.

## Gaps found and closed

All four paths were covered at the base fix commit; no residual gaps found during review. The review pass = full 28-step verification run (npm test with `SCHEDULER_DB=:memory:`, focused suites incl. dispatch-session-store/gateway-rpc/source-routing, documentation examples) — all green, EXIT=0 (log: /tmp/052-review-test-20260819.log, 2026-08-19 00:13 EDT). Lint/typecheck green in the same run.

## Deployment question (owner decides; NOT deployed)

Live install is npm `0.2.17` (`~/.openclaw/packages/openclaw-scheduler`), 76+ commits behind main. Deploying this line = upgrade the packages install to this 0.5.2 code + restart the dispatcher (`launchctl kickstart gui/$UID/ai.openclaw.scheduler`). Timing is the owner's call; do not deploy while jobs are in flight.
