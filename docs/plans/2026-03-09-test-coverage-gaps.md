**Status: Completed**

# Test Coverage Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close 6 identified testable coverage gaps in test.js without changing any source code.

**Architecture:** Add test sections to the existing test.js using the custom assert harness. All tests use in-memory SQLite.

**Tech Stack:** Node.js ESM, better-sqlite3, custom test harness (assert/passed/failed counters).

---

### Task 1: Import dispatcher-utils.js and replace inline re-implementations

**Files:**
- Modify: `test.js` (imports at top, transient error section around line 1859)

**Changes:**
1. Add import: `import { matchesSentinel, detectTransientError, adaptiveDeferralMs, buildExecutionIntentNote, getBackoffMs, sqliteNow } from './dispatcher-utils.js';`
2. In the "Transient Error Detection" section (~line 1859), delete the inline `TRANSIENT_ERROR_PATTERNS` array, `detectTransientError` function, and `matchesSentinel` function
3. Add new test section "Dispatcher Utils" testing:
   - `adaptiveDeferralMs`: depth 0 returns baseMs, depth 11 caps at 12x, result caps at 300000
   - `buildExecutionIntentNote`: returns '' for normal jobs, returns plan note for plan intent, returns read-only note for read_only, includes both when both set
   - `getBackoffMs`: n=1 returns 30000, n=5 returns 3600000, n=99 caps at 3600000
   - `sqliteNow`: returns valid datetime string format

### Task 2: Test dispatch-queue claim/release/setStatus

**Files:**
- Modify: `test.js`

**Changes:**
Add new test section "Dispatch Queue Lifecycle" after existing dispatch tests:
- `claimDispatch`: create pending dispatch, claim it, verify status='claimed' and claimed_at set; claim again returns null
- `releaseDispatch`: claim a dispatch, release it, verify status='pending' and claimed_at cleared; release with new scheduledFor
- `setDispatchStatus`: set to 'done', verify processed_at set; set to 'cancelled', verify processed_at set; set to 'pending', verify processed_at unchanged

### Task 3: Test approval timeout/prune/count

**Files:**
- Modify: `test.js`

**Changes:**
Add to existing "v5: Approval Gates" section or new section after it:
- `countPendingApprovalsForJob`: create 2 pending approvals, count returns 2; resolve one, count returns 1
- `getTimedOutApprovals`: create approval, backdate requested_at past timeout, verify it appears in results with job_name/approval_timeout_s/approval_auto
- `pruneApprovals`: create resolved approval, backdate resolved_at past retention, prune, verify deleted

### Task 4: Test runs updateRunSession and updateContextSummary

**Files:**
- Modify: `test.js` (imports + new section)

**Changes:**
1. Add `updateRunSession` and `updateContextSummary` to runs.js import
2. Add tests:
   - `updateRunSession`: create run, call with session key/id, verify both stored on run
   - `updateContextSummary`: create run, call with object, verify JSON stored; call with string, verify stored as-is

### Task 5: Test prompt-context.js missing branches

**Files:**
- Modify: `test.js`

**Changes:**
Add to existing "Prompt Context" section:
- Null parent run: pass `{ triggered_by_run: 'nonexistent' }` with getRunById returning undefined; verify text='', meta.parent_run_missing=true
- No trigger: pass `{}` (no triggered_by_run); verify text='', meta is empty
- Non-shell parent: pass parent run with status='ok', summary='Agent completed task', session_target='isolated' (no shell fields); verify text includes summary, no shell exit code

### Task 6: Test migrate.js cronFromSchedule

**Files:**
- Modify: `test.js`

**Changes:**
Since `cronFromSchedule` is not exported, test it indirectly via dynamic import or extract its logic. Since we cannot modify source files, we re-implement the pure function in tests (same pattern as the original matchesSentinel approach, but documented).

Actually: `cronFromSchedule` is a local function in migrate.js, not exported. We cannot test it without modifying the source. Skip this task or note it as requiring a source change.

**Alternative:** Add a note that this gap requires exporting cronFromSchedule from migrate.js in a future change.
