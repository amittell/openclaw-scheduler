# Fix TypeScript Type Definitions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make index.d.ts accurately reflect every exported JS function, parameter, and return type.

**Architecture:** Single-file rewrite of index.d.ts plus expanded types-smoke.ts. No JS changes.

**Tech Stack:** TypeScript declarations, tsc --noEmit for validation.

---

### Task 1: Rewrite index.d.ts record interfaces

**Files:**
- Modify: `index.d.ts`

**Step 1:** Rewrite all record interfaces to include every column from schema.sql:
- `JobSpec`: add 17 missing fields (payload_scope, payload_model, payload_thinking, delivery_guarantee, job_class, preferred_session_key, job_type, watchdog_*, consecutive_errors, queued_count, run_now)
- `JobRecord`: add created_at, updated_at, last_run_at
- `RunRecord`: add started_at, finished_at, duration_ms, last_heartbeat, session_key, session_id, dispatched_at, run_timeout_ms, context_summary, replay_of, idempotency_key
- `MessageRecord`: add all 16 missing columns (team_id through owner)
- `ApprovalRecord`: add dispatch_queue_id, requested_at, resolved_at, resolved_by, notes
- `AgentRecord`: add last_seen_at, created_at
- Add new `DispatchRecord` interface with all job_dispatch_queue columns
- Fix `ShellResult` to add stdoutTruncated, stderrTruncated fields
- Add `PartialShellResult` (return type of extractShellResultFromRun)
- Type `SCHEDULER_SCHEMAS` with its actual structure

**Step 2:** Run `npm run typecheck` -- expect failure (smoke test uses old shapes)

### Task 2: Rewrite index.d.ts function declarations

**Files:**
- Modify: `index.d.ts`

**Step 1:** Add all 26 missing function declarations:
- jobs: pruneExpiredJobs, detectCycle, getChainDepth, getDispatchBacklogCount, canEnqueueDispatch, cancelJob, hasRunningRunForPool, hasRunningRun
- messages: getTeamMessages, ackMessage, expireMessages, pruneMessages, recordMessageAttempt, listMessageReceipts
- gateway: runAgentTurn, runAgentTurnWithActivityTimeout, sendSystemEvent, invokeGatewayTool, listSessions, getAllSubAgentSessions
- approval: countPendingApprovalsForJob, getTimedOutApprovals, pruneApprovals
- runs: updateHeartbeat, getRunningRunsByPool
- paths: resolveBackupStagingDir
- dispatch-queue: listDispatchesForJob

**Step 2:** Fix 4 wrong return types:
- runJobNow: returns JobRecord & { dispatch_id, dispatch_kind } | null
- resolveApproval: returns ApprovalRecord
- deliverMessage: returns Promise<{ ok: true; parts: number; lastResponse: unknown }>
- extractShellResultFromRun: returns PartialShellResult | null

**Step 3:** Replace Record<string, unknown> params with named fields:
- sendMessage opts
- createRun opts
- finishRun opts
- normalizeShellResult params
- buildTriggeredRunContext params
- listJobs opts
- resolveSchedulerDbPath params
- resolveArtifactsDir params
- upsertAgent opts

**Step 4:** Run `npm run typecheck` -- expect failure (smoke test)

### Task 3: Expand types-smoke.ts

**Files:**
- Modify: `types-smoke.ts`

**Step 1:** Add smoke tests exercising:
- All 26 newly typed functions (at type level, not runtime)
- Watchdog JobSpec fields
- DispatchRecord interface
- Gateway function signatures
- Message ack and team functions
- Approval timeout/prune functions
- PartialShellResult from extractShellResultFromRun
- RunRecord time fields (started_at, finished_at)

**Step 2:** Run `npm run typecheck` -- must pass

**Step 3:** Run `npm test` -- must still pass (581 tests, no JS changes)

### Task 4: Commit

```bash
git add index.d.ts types-smoke.ts
git commit -m "Complete TypeScript type coverage for all exported APIs"
```
