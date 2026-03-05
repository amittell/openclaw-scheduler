# Implementation Spec — Scheduler v5 Features

## New Schema (consolidated into schema baseline)

### Jobs table — new columns:
```sql
ALTER TABLE jobs ADD COLUMN delivery_guarantee TEXT DEFAULT 'at-most-once';  -- 'at-most-once'|'at-least-once'
ALTER TABLE jobs ADD COLUMN job_class TEXT DEFAULT 'standard';               -- 'standard'|'pre_compaction_flush'
ALTER TABLE jobs ADD COLUMN approval_required INTEGER DEFAULT 0;             -- HITL gate
ALTER TABLE jobs ADD COLUMN approval_timeout_s INTEGER DEFAULT 3600;
ALTER TABLE jobs ADD COLUMN approval_auto TEXT DEFAULT 'reject';             -- 'approve'|'reject'
ALTER TABLE jobs ADD COLUMN context_retrieval TEXT DEFAULT 'none';           -- 'none'|'recent'|'hybrid'
ALTER TABLE jobs ADD COLUMN context_retrieval_limit INTEGER DEFAULT 5;
```

### Runs table — new columns:
```sql
ALTER TABLE runs ADD COLUMN context_summary TEXT;   -- JSON: {messages_injected,scope,aliases_resolved,...}
ALTER TABLE runs ADD COLUMN replay_of TEXT;          -- run id if this is a crash replay
```

### Messages table — new column:
```sql
ALTER TABLE messages ADD COLUMN owner TEXT;          -- originator of typed message
```
(kind enum extends to include: 'decision','constraint','fact','preference' alongside existing)

### New table: approvals
```sql
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|rejected|timed_out
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     TEXT,                               -- 'operator'|'timeout'|'api'
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals(job_id);
```

### schema_migrations: baseline includes these fields/tables

---

## Function Signatures (contracts between modules)

### approval.js (NEW FILE) exports:
```js
export function createApproval(jobId, runId)           // returns approval record
export function getApproval(id)                         // by approval id
export function getPendingApproval(jobId)               // latest pending for a job
export function listPendingApprovals()                  // all pending
export function resolveApproval(id, status, resolvedBy, notes)  // approve/reject/timed_out
export function getTimedOutApprovals()                  // pending approvals past timeout
export function pruneApprovals(retentionDays)           // clean old resolved approvals
```

### retrieval.js (NEW FILE) exports:
```js
export function getRecentRunSummaries(jobId, limit)     // last N run summaries (non-null)
export function searchRunSummaries(jobId, query, limit) // hybrid: substring + TF-IDF scoring
export function buildRetrievalContext(job)               // returns string to inject into prompt (or '')
```

### jobs.js — add to createJob/updateJob allowed fields:
delivery_guarantee, job_class, approval_required, approval_timeout_s, approval_auto, context_retrieval, context_retrieval_limit

### runs.js — new export:
```js
export function updateContextSummary(runId, summaryObj) // store JSON context_summary
```

### messages.js — update:
- sendMessage: accept `owner` field
- getInbox: sort by typed priority (constraint > decision > fact > task > preference > text/other)
- New kinds accepted: 'decision','constraint','fact','preference'

### dispatcher.js — new functions:
```js
async function replayOrphanedRuns()        // called from main() after initDb, before tick loop
async function checkApprovals()            // called from tick(), checks timeouts + approved gates
function buildContextSummary(job, inbox)   // returns {messages_injected, scope, ...}
```

### cli.js — new commands:
- `jobs approve <job-id>` — resolve pending approval as approved
- `jobs reject <job-id> [reason]` — resolve as rejected
- `approvals list` — list pending
- `approvals pending` — alias

---

## Feature Details

### F1: Delivery Semantics Contract
- New field `delivery_guarantee` on jobs ('at-most-once' default | 'at-least-once')
- at-most-once: current behavior. On crash, orphaned runs marked 'crashed'.
- at-least-once: on startup, orphaned runs are replayed (new run with replay_of set).
- Document in job creation. Expose in CLI `jobs list` table.

### F2: Flush-Before-Compaction Hook
- New field `job_class` on jobs ('standard' default | 'pre_compaction_flush')
- In buildJobPrompt: if job_class === 'pre_compaction_flush', prepend:
  ```
  [SYSTEM: Pre-compaction flush required]
  Write a structured summary of: active decisions, constraints, task owners, open questions.
  Format as labeled sections. If nothing needs flushing, respond with exactly: NO_FLUSH
  [END SYSTEM]
  ```
- In dispatch result handling: if content.trim() === 'NO_FLUSH', skip delivery and log 'Flush: nothing to flush'

### F3: Context Summary / Memory Observability
- New field `context_summary` on runs (TEXT, stores JSON)
- In buildJobPrompt: collect metadata into an object: { messages_injected: N, scope: 'own'|'global', aliases_resolved: [...], job_class, delivery_guarantee, context_retrieval, retrieval_results: N }
- After creating the run, store the summary via updateContextSummary()
- Expose in `runs list` and `runs get` CLI output

### F4: Typed Message Contract
- New message kinds: 'decision', 'constraint', 'fact', 'preference'
- New field `owner` on messages
- In sendMessage: validate kind against full enum, accept owner
- In getInbox: sort results by typed priority order:
  1. constraint (highest)
  2. decision
  3. fact
  4. task
  5. preference
  6. text, result, status, system, spawn (lowest)
- In buildJobPrompt: display kind and owner for typed messages:
  ```
  [constraint] (owner: ops-agent) Never deploy during business hours
  ```

### F5: HITL Approval Gates
- New fields on jobs: approval_required (int 0/1), approval_timeout_s (int), approval_auto (text)
- New run status: 'awaiting_approval'
- New table: approvals
- Flow:
  1. In dispatchJob: if job.approval_required AND job is chain-triggered (has parent_id):
     - Create run with status 'awaiting_approval'
     - Create approval record
     - Send notification: "⚠️ Job '{name}' requires approval. Approve: `node cli.js jobs approve {job_id}`"
     - Return (don't dispatch yet)
  2. In tick: call checkApprovals():
     - For each pending approval: check if resolved or timed out
     - If approved: change run status to 'pending', dispatch the job
     - If timed_out: apply approval_auto policy
     - If rejected: mark run as 'cancelled'
- CLI: approve/reject commands resolve the approval record

### F6: Run Replay on Startup
- New field `replay_of` on runs
- In main(), after initDb(), before starting tick loop:
  - Query: SELECT r.*, j.delivery_guarantee, j.name FROM runs r JOIN jobs j ON r.job_id = j.id WHERE r.status = 'running'
  - For each orphaned run:
    - If delivery_guarantee = 'at-least-once': create new run with replay_of = old run id, set old run status = 'crashed', queue for dispatch
    - If delivery_guarantee = 'at-most-once': set old run status = 'crashed', advance job schedule
  - Log all actions

### F7: Hybrid Retrieval for Job Context
- New fields on jobs: context_retrieval ('none'|'recent'|'hybrid'), context_retrieval_limit (int)
- In buildJobPrompt: if context_retrieval !== 'none', call buildRetrievalContext(job) and append to prompt
- retrieval.js implements:
  - getRecentRunSummaries: SELECT summary FROM runs WHERE job_id=? AND summary IS NOT NULL ORDER BY started_at DESC LIMIT ?
  - searchRunSummaries: combine substring matching + simple TF-IDF scoring
  - TF-IDF: tokenize query and summaries, compute term frequency * inverse document frequency, rank by score
  - buildRetrievalContext: format results as "--- Prior Run Context ---\n[date] summary\n..."
