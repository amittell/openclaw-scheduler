import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { initDb, closeDb, getDb, setDbPath } from '../db.js';
import { createJob, deleteJob, getJob } from '../jobs.js';
import { createRun, getRun } from '../runs.js';
import { claimDispatch, enqueueDispatch, getDispatch } from '../dispatch-queue.js';
import {
  createApproval,
  getApproval,
  getTimedOutApprovals,
  resolveApproval,
} from '../approval.js';
import {
  beginApprovalDispatch,
  cancelApprovalsForJob,
  cancelUnavailableJobApprovals,
  deferApprovalDispatch,
  markApprovalDispatched,
  recoverInterruptedApprovalDispatches,
  transitionPendingApproval,
} from '../approval-state.js';
import {
  cancelDelivery,
  claimDelivery,
  claimDueDeliveries,
  enqueueDelivery,
  getDelivery,
  markDeliveryDelivered,
  recoverExpiredDeliveryClaims,
  pruneTerminalDeliveries,
  retryDelivery,
  retryFailedDelivery,
} from '../delivery-outbox.js';
import {
  materializeDeliveryAttachment,
  verifyDeliveryAttachment,
} from '../attachment-store.js';
import { createDeliveryHelpers } from '../dispatcher-delivery.js';
import {
  ackClaimedInboxForRun,
  claimInboxForRun,
  getInbox,
  getUnreadCount,
  recoverStaleInboxClaims,
  releaseClaimedInboxForRun,
  sendMessage,
} from '../messages.js';
import {
  drainDeliveryOutbox,
  drainLegacyMessages,
  selectPendingMessages,
} from '../scripts/inbox-consumer.mjs';
import { checkApprovals } from '../dispatcher-approvals.js';
import { checkRunHealth, pruneDeliveryHistory } from '../dispatcher-maintenance.js';
import { getAuthenticatedApprovalActor } from '../approval-binding.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'scheduler-hardening-'));
const dbPath = join(tempRoot, 'scheduler.db');
const artifactsDir = join(tempRoot, 'artifacts');

function jobSpec(name, extra = {}) {
  return {
    name,
    schedule_cron: '0 * * * *',
    session_target: 'shell',
    payload_kind: 'shellCommand',
    payload_message: 'printf test',
    run_timeout_ms: 60_000,
    delivery_mode: 'none',
    origin: 'system',
    ...extra,
  };
}

function createApprovalFixture(name, extra = {}) {
  const job = createJob(jobSpec(name, {
    approval_required: 1,
    approval_timeout_s: 60,
    approval_auto: 'reject',
    ...extra,
  }));
  const dispatch = enqueueDispatch(job.id, { kind: 'chain' });
  assert.ok(claimDispatch(dispatch.id));
  const run = createRun(job.id, {
    status: 'awaiting_approval',
    dispatch_queue_id: dispatch.id,
  });
  const approval = createApproval(job.id, run.id, dispatch.id);
  return { job, dispatch: getDispatch(dispatch.id), run, approval };
}

before(async () => {
  process.env.SCHEDULER_ARTIFACTS_DIR = artifactsDir;
  setDbPath(dbPath);
  await initDb();
});

beforeEach(() => {
  const db = getDb();
  db.exec(`
    DELETE FROM delivery_outbox;
    DELETE FROM messages;
    DELETE FROM jobs;
  `);
});

after(() => {
  closeDb();
  rmSync(tempRoot, { recursive: true, force: true });
});

test('external routes stay out of agent inboxes and dispatcher delivery uses the outbox', () => {
  const internal = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'internal context',
  });
  const external = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'legacy external delivery',
    channel: 'telegram',
    delivery_to: '12345',
  });

  assert.deepEqual(getInbox('main').map(row => row.id), [internal.id]);
  assert.equal(getUnreadCount('main'), 1);
  assert.deepEqual(selectPendingMessages(getDb(), 'main', 10).map(row => row.id), [external.id]);

  const job = createJob(jobSpec('outbox-producer', {
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: '67890',
  }));
  const run = createRun(job.id);
  const { handleDelivery } = createDeliveryHelpers({
    log() {},
    resolveDeliveryAlias() { return null; },
  });
  const first = handleDelivery(job, 'durable result', { runId: run.id });
  const second = handleDelivery(job, 'durable result', { runId: run.id });

  assert.equal(first.id, second.id);
  assert.equal(second.deduped, true);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
});

test('delivery enqueue participates in an existing completion transaction', () => {
  const job = createJob(jobSpec('transactional-delivery', {
    delivery_mode: 'announce',
    delivery_channel: 'telegram',
    delivery_to: 'transaction-target',
  }));
  const run = createRun(job.id);
  const { handleDelivery } = createDeliveryHelpers({
    log() {},
    resolveDeliveryAlias() { return null; },
  });
  const db = getDb();

  db.transaction(() => {
    const delivery = handleDelivery(job, 'committed body', { db, runId: run.id });
    assert.equal(delivery.status, 'pending');
  })();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);

  assert.throws(() => db.transaction(() => {
    handleDelivery(job, 'rolled back body', { db, eventId: 'rollback-event' });
    throw new Error('force rollback');
  })(), /force rollback/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);

  db.transaction(() => {
    assert.throws(() => handleDelivery(job, 'invalid attachment', {
      db,
      eventId: 'invalid-attachment-event',
      imageAttachments: ['not-an-absolute-path'],
    }), /must be absolute/);
  })();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);
});

test('attachment staging is rollback-safe inside an enclosing transaction', () => {
  const db = getDb();
  const sourcePath = join(tempRoot, 'transaction-attachment.txt');
  writeFileSync(sourcePath, Buffer.from('transaction attachment'));
  let rolledBackArtifactPath = null;

  assert.throws(() => db.transaction(() => {
    const delivery = enqueueDelivery({
      id: 'rollback-attachment-delivery',
      db,
      channel: 'telegram',
      target: 'rollback-target',
      body: 'must roll back',
      attachments: [sourcePath],
    });
    rolledBackArtifactPath = delivery.attachments[0].source_path;
    assert.equal(existsSync(rolledBackArtifactPath), false);
    throw new Error('roll back attachment delivery');
  })(), /roll back attachment delivery/);

  assert.equal(getDelivery('rollback-attachment-delivery'), null);
  assert.equal(existsSync(rolledBackArtifactPath), false);
  assert.equal(existsSync(dirname(rolledBackArtifactPath)), false);

  let committedDelivery;
  db.transaction(() => {
    committedDelivery = enqueueDelivery({
      id: 'committed-attachment-delivery',
      db,
      channel: 'telegram',
      target: 'commit-target',
      body: 'committed for later delivery',
      attachments: [sourcePath],
    });
  })();
  const committedAttachment = committedDelivery.attachments[0];
  assert.equal(existsSync(committedAttachment.source_path), false);
  assert.equal(
    materializeDeliveryAttachment(committedAttachment, { db }),
    committedAttachment.source_path
  );
  assert.equal(readFileSync(committedAttachment.source_path).toString(), 'transaction attachment');
  assert.equal(verifyDeliveryAttachment(committedAttachment), true);
});

test('idempotency keys deduplicate only semantically equivalent deliveries', () => {
  const job = createJob(jobSpec('idempotency-association-job'));
  const run = createRun(job.id);
  const message = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'association record',
  });
  const sourcePath = join(tempRoot, 'idempotency-payload.txt');
  const changedPath = join(tempRoot, 'idempotency-payload-changed.txt');
  writeFileSync(sourcePath, Buffer.from('stable payload'));
  writeFileSync(changedPath, Buffer.from('changed payload'));
  const base = {
    channel: 'telegram',
    target: 'semantic-target',
    body: 'semantic body',
    messageId: message.id,
    jobId: job.id,
    runId: run.id,
    attachments: [{ path: sourcePath, name: 'payload.txt', mimeType: 'text/plain' }],
    idempotencyKey: 'semantic-idempotency-key',
  };

  const first = enqueueDelivery(base);
  const duplicate = enqueueDelivery({ ...base });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.deduped, true);

  const collisionCases = [
    ['channel', { channel: 'discord' }],
    ['target', { target: 'different-target' }],
    ['body', { body: 'different body' }],
    ['message_id', { messageId: null }],
    ['job_id', { jobId: null }],
    ['run_id', { runId: null }],
    ['attachments', {
      attachments: [{ path: changedPath, name: 'payload.txt', mimeType: 'text/plain' }],
    }],
  ];
  for (const [field, override] of collisionCases) {
    assert.throws(
      () => enqueueDelivery({ ...base, ...override }),
      err => {
        assert.equal(err.code, 'DELIVERY_IDEMPOTENCY_COLLISION');
        assert.equal(err.existingDeliveryId, first.id);
        assert.ok(err.differingFields.includes(field));
        return true;
      }
    );
  }
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM delivery_outbox').get().count, 1);
});

test('internal inbox claims are CAS-protected and acknowledged only by their run', () => {
  const internal = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'claim me',
    metadata: [1, 2],
  });
  const external = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'deliver me externally',
    channel: 'telegram',
    delivery_to: '12345',
  });

  const first = claimInboxForRun('main', 'run-a', { limit: 5 });
  assert.deepEqual(first.map(message => message.id), [internal.id]);
  assert.equal(first[0].status, 'prompt_claimed');
  assert.equal(first[0].metadata._scheduler_prompt_claim.run_id, 'run-a');
  assert.deepEqual(first[0].metadata._scheduler_prompt_original_metadata, [1, 2]);
  assert.equal(claimInboxForRun('main', 'run-a', { limit: 5 })[0].id, internal.id);
  assert.equal(claimInboxForRun('main', 'run-b', { limit: 5 }).length, 0);
  assert.equal(getInbox('main').length, 0);
  assert.equal(ackClaimedInboxForRun('run-b', [internal.id]).acked, 0);

  assert.equal(releaseClaimedInboxForRun('run-a', [internal.id], { reason: 'turn failed' }).released, 1);
  assert.equal(getInbox('main')[0].id, internal.id);
  assert.deepEqual(getInbox('main')[0].metadata, [1, 2]);
  assert.equal(claimInboxForRun('main', 'run-b', { limit: 5 })[0].id, internal.id);
  assert.equal(ackClaimedInboxForRun('run-b', [internal.id]).acked, 1);
  assert.equal(getDb().prepare('SELECT status FROM messages WHERE id = ?').get(internal.id).status, 'delivered');
  assert.equal(selectPendingMessages(getDb(), 'main', 5)[0].id, external.id);
});

test('stale inbox recovery waits for an active owning run and excludes external routes', () => {
  const job = createJob(jobSpec('prompt-claim-owner'));
  const run = createRun(job.id);
  const internal = sendMessage({ from_agent: 'scheduler', to_agent: 'main', body: 'recover me' });
  const external = sendMessage({
    from_agent: 'scheduler',
    to_agent: 'main',
    body: 'external claim sentinel',
    channel: 'telegram',
    delivery_to: '12345',
  });
  claimInboxForRun('main', run.id, { limit: 5 });
  getDb().prepare(`
    UPDATE messages
    SET metadata = json_set(
      metadata,
      '$._scheduler_prompt_claim.claimed_at',
      datetime('now', '-1 hour')
    )
    WHERE id = ?
  `).run(internal.id);
  getDb().prepare("UPDATE messages SET status = 'prompt_claimed' WHERE id = ?").run(external.id);

  assert.equal(recoverStaleInboxClaims({ olderThanSeconds: 0 }).recovered, 0);
  getDb().prepare("UPDATE runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(run.id);
  const recovered = recoverStaleInboxClaims({ olderThanSeconds: 0 });
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.messages[0].id, internal.id);
  assert.equal(getDb().prepare('SELECT status FROM messages WHERE id = ?').get(internal.id).status, 'pending');
  assert.equal(getDb().prepare('SELECT status FROM messages WHERE id = ?').get(external.id).status, 'prompt_claimed');
});

test('attachments are copied, hashed, persisted, and idempotently associated', () => {
  const sourcePath = join(tempRoot, 'chart.png');
  const bytes = Buffer.from('not-a-real-png-but-stable-test-content');
  writeFileSync(sourcePath, bytes);
  const delivery = enqueueDelivery({
    channel: 'telegram',
    target: '12345',
    body: 'chart attached',
    attachments: [sourcePath],
    idempotencyKey: 'attachment-test',
  });

  assert.equal(delivery.attachments.length, 1);
  const attachment = delivery.attachments[0];
  assert.notEqual(attachment.source_path, sourcePath);
  assert.equal(readFileSync(attachment.source_path).toString(), bytes.toString());
  assert.equal(attachment.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(Buffer.from(attachment.content_blob).toString(), bytes.toString());
  assert.equal(verifyDeliveryAttachment(attachment), true);

  const duplicate = enqueueDelivery({
    channel: 'telegram',
    target: '12345',
    body: 'chart attached',
    attachments: [sourcePath],
    idempotencyKey: 'attachment-test',
  });
  assert.equal(duplicate.id, delivery.id);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.attachments.length, 1);

  unlinkSync(sourcePath);
  assert.equal(existsSync(attachment.source_path), true);

  assert.throws(() => enqueueDelivery({
    channel: 'telegram',
    target: '12345',
    body: 'invalid',
    attachments: ['relative-file.png'],
  }), /must be absolute/);

  const linkPath = join(tempRoot, 'attachment-link.png');
  symlinkSync(attachment.source_path, linkPath);
  assert.throws(() => enqueueDelivery({
    channel: 'telegram',
    target: '12345',
    body: 'invalid link',
    attachments: [linkPath],
  }), /symbolic link/);
});

test('outbox claims are exclusive and retry transitions are bounded', () => {
  const delivery = enqueueDelivery({
    channel: 'telegram',
    target: '12345',
    body: 'retry me',
    maxAttempts: 2,
  });
  const firstClaim = claimDueDeliveries({ owner: 'consumer-a', limit: 10 });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].attempt_count, 1);
  assert.equal(claimDueDeliveries({ owner: 'consumer-b', limit: 10 }).length, 0);

  const firstRetry = retryDelivery(delivery.id, firstClaim[0].claim_token, 'temporary', { delayMs: 0 });
  assert.equal(firstRetry.status, 'pending');
  assert.equal(firstRetry.retryScheduled, true);
  const secondClaim = claimDueDeliveries({ owner: 'consumer-b', limit: 10 });
  assert.equal(secondClaim.length, 1);
  assert.equal(secondClaim[0].attempt_count, 2);
  const exhausted = retryDelivery(delivery.id, secondClaim[0].claim_token, 'still broken', { delayMs: 0 });
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.retryScheduled, false);

  assert.equal(retryFailedDelivery(delivery.id, { maxAttempts: 1 }).status, 'pending');
  const finalClaim = claimDueDeliveries({ owner: 'consumer-c', limit: 10 })[0];
  const completed = markDeliveryDelivered(delivery.id, finalClaim.claim_token);
  assert.equal(completed.transitioned, true);
  assert.equal(completed.status, 'delivered');
  assert.equal(markDeliveryDelivered(delivery.id, finalClaim.claim_token).transitioned, false);
});

test('expired outbox claims recover to pending or terminal failure', () => {
  const retryable = enqueueDelivery({
    channel: 'telegram', target: 'one', body: 'retryable', maxAttempts: 2,
  });
  const terminal = enqueueDelivery({
    channel: 'telegram', target: 'two', body: 'terminal', maxAttempts: 1,
  });
  claimDueDeliveries({ owner: 'expired-owner', limit: 10, leaseMs: 1000 });
  getDb().prepare(
    "UPDATE delivery_outbox SET claim_expires_at = datetime('now', '-1 second') WHERE id IN (?, ?)"
  ).run(retryable.id, terminal.id);

  const result = recoverExpiredDeliveryClaims();
  assert.deepEqual(result, { recovered: 2, pending: 1, failed: 1 });
  assert.equal(getDelivery(retryable.id).status, 'pending');
  assert.equal(getDelivery(terminal.id).status, 'failed');
});

test('consumer heartbeats its delivery claim throughout slow text and attachment sends', async () => {
  const sourcePath = join(tempRoot, 'slow-consumer-file.txt');
  writeFileSync(sourcePath, Buffer.from('slow attachment'));
  const delivery = enqueueDelivery({
    channel: 'telegram',
    target: 'slow-target',
    body: 'slow body',
    attachments: [sourcePath],
  });

  let signalTextStarted;
  let releaseText;
  let signalMediaStarted;
  let releaseMedia;
  const textStarted = new Promise(resolvePromise => { signalTextStarted = resolvePromise; });
  const textGate = new Promise(resolvePromise => { releaseText = resolvePromise; });
  const mediaStarted = new Promise(resolvePromise => { signalMediaStarted = resolvePromise; });
  const mediaGate = new Promise(resolvePromise => { releaseMedia = resolvePromise; });

  const drainPromise = drainDeliveryOutbox(getDb(), {
    limit: 1,
    brand: 'Scheduler',
    leaseMs: 2000,
    heartbeatIntervalMs: 200,
    interDeliveryDelayMs: 0,
    async deliverText() {
      signalTextStarted();
      await textGate;
    },
    async invokeTool() {
      signalMediaStarted();
      await mediaGate;
      return { ok: true, result: { isError: false } };
    },
  });

  await textStarted;
  const initialExpiry = getDb().prepare(
    'SELECT claim_expires_at FROM delivery_outbox WHERE id = ?'
  ).get(delivery.id).claim_expires_at;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200));
  const expiryDuringText = getDb().prepare(
    'SELECT claim_expires_at FROM delivery_outbox WHERE id = ?'
  ).get(delivery.id).claim_expires_at;
  assert.ok(expiryDuringText > initialExpiry);
  releaseText();

  await mediaStarted;
  const expiryAtMediaStart = getDb().prepare(
    'SELECT claim_expires_at FROM delivery_outbox WHERE id = ?'
  ).get(delivery.id).claim_expires_at;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200));
  const expiryDuringMedia = getDb().prepare(
    'SELECT claim_expires_at FROM delivery_outbox WHERE id = ?'
  ).get(delivery.id).claim_expires_at;
  assert.ok(expiryDuringMedia > expiryAtMediaStart);
  releaseMedia();

  const outcome = await drainPromise;
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.errors.length, 0);
  assert.equal(getDelivery(delivery.id).status, 'delivered');
});

test('terminal outbox pruning is bounded and removes rows, blobs, and artifact files', () => {
  const sourcePath = join(tempRoot, 'prune-attachment.txt');
  const bytes = Buffer.from('prune attachment bytes');
  writeFileSync(sourcePath, bytes);
  const makeDelivery = name => enqueueDelivery({
    channel: 'telegram',
    target: `prune-${name}`,
    body: `prune ${name}`,
    attachments: [{ path: sourcePath, name: `${name}.txt` }],
  });

  const delivered = makeDelivery('delivered');
  const deliveredClaim = claimDelivery(delivered.id, { owner: 'prune-delivered' });
  assert.equal(markDeliveryDelivered(delivered.id, deliveredClaim.claim_token).transitioned, true);

  const failed = enqueueDelivery({
    channel: 'telegram',
    target: 'prune-failed',
    body: 'prune failed',
    attachments: [{ path: sourcePath, name: 'failed.txt' }],
    maxAttempts: 1,
  });
  const failedClaim = claimDelivery(failed.id, { owner: 'prune-failed' });
  assert.equal(retryDelivery(failed.id, failedClaim.claim_token, 'terminal failure').status, 'failed');

  const cancelled = makeDelivery('cancelled');
  assert.equal(cancelDelivery(cancelled.id).status, 'cancelled');

  const pending = makeDelivery('pending');
  const recent = makeDelivery('recent');
  const recentClaim = claimDelivery(recent.id, { owner: 'prune-recent' });
  assert.equal(markDeliveryDelivered(recent.id, recentClaim.claim_token).transitioned, true);
  const recentlyCancelled = makeDelivery('recently-cancelled');
  getDb().prepare(
    "UPDATE delivery_outbox SET created_at = datetime('now', '-40 days') WHERE id = ?"
  ).run(recentlyCancelled.id);
  assert.equal(cancelDelivery(recentlyCancelled.id).status, 'cancelled');

  const oldDeliveries = [delivered, failed, cancelled];
  const oldIds = oldDeliveries.map(item => item.id);
  const placeholders = oldIds.map(() => '?').join(', ');
  getDb().prepare(`
    UPDATE delivery_outbox
    SET created_at = datetime('now', '-40 days'),
        next_attempt_at = datetime('now', '-40 days'),
        delivered_at = CASE
          WHEN status = 'delivered' THEN datetime('now', '-40 days')
          ELSE delivered_at
        END
    WHERE id IN (${placeholders})
  `).run(...oldIds);

  const first = pruneTerminalDeliveries({ retentionDays: 30, limit: 2 });
  assert.equal(first.pruned, 2);
  assert.equal(first.attachmentRowsPruned, 2);
  assert.equal(first.attachmentBytesPruned, bytes.length * 2);
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM delivery_outbox
    WHERE id IN (${placeholders})
  `).get(...oldIds).count, 1);

  const logs = [];
  const second = pruneDeliveryHistory({
    getDb,
    log(level, message, data) { logs.push({ level, message, data }); },
    retentionDays: 30,
    limit: 10,
  });
  assert.equal(second.pruned, 1);
  assert.equal(logs.some(entry => entry.level === 'info' && /terminal delivery/.test(entry.message)), true);

  for (const delivery of oldDeliveries) {
    assert.equal(getDelivery(delivery.id), null);
    assert.equal(existsSync(delivery.attachments[0].source_path), false);
    assert.equal(existsSync(dirname(delivery.attachments[0].source_path)), false);
  }
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM delivery_attachments
    WHERE outbox_id IN (${placeholders})
  `).get(...oldIds).count, 0);
  assert.equal(getDelivery(pending.id).status, 'pending');
  assert.equal(getDelivery(recent.id).status, 'delivered');
  assert.equal(getDelivery(recentlyCancelled.id).status, 'cancelled');
  assert.equal(existsSync(pending.attachments[0].source_path), true);
  assert.equal(existsSync(recent.attachments[0].source_path), true);
  assert.equal(existsSync(recentlyCancelled.attachments[0].source_path), true);
  assert.equal(getDb().prepare(
    'SELECT length(content_blob) AS size FROM delivery_attachments WHERE outbox_id = ?'
  ).get(pending.id).size, bytes.length);
});

test('consumer delivers outbox text and persisted media, then supports legacy routed rows', async () => {
  const sourcePath = join(tempRoot, 'consumer-file.pdf');
  writeFileSync(sourcePath, Buffer.from('%PDF-test'));
  const delivery = enqueueDelivery({
    channel: 'telegram',
    target: 'outbox-target',
    body: 'outbox body',
    attachments: [sourcePath],
  });
  const textCalls = [];
  const mediaCalls = [];
  const outcome = await drainDeliveryOutbox(getDb(), {
    limit: 10,
    brand: 'Scheduler',
    interDeliveryDelayMs: 0,
    async deliverText(channel, target, text) { textCalls.push({ channel, target, text }); },
    async invokeTool(tool, args) {
      mediaCalls.push({ tool, args });
      return { ok: true, result: { isError: false } };
    },
  });
  assert.equal(outcome.delivered, 1);
  assert.equal(textCalls.length, 1);
  assert.match(textCalls[0].text, /outbox body/);
  assert.equal(mediaCalls.length, 1);
  assert.equal(mediaCalls[0].args.media, delivery.attachments[0].source_path);
  assert.equal(getDelivery(delivery.id).status, 'delivered');

  const internal = sendMessage({ from_agent: 'a', to_agent: 'main', body: 'agent-only' });
  const legacy = sendMessage({
    from_agent: 'a',
    to_agent: 'main',
    body: 'legacy body',
    channel: 'telegram',
    delivery_to: 'legacy-target',
  });
  const legacyCalls = [];
  const legacyOutcome = await drainLegacyMessages(getDb(), {
    to: 'fallback',
    channel: 'telegram',
    agentId: 'main',
    limit: 10,
    brand: 'Scheduler',
    interDeliveryDelayMs: 0,
    async deliverText(channel, target, text) { legacyCalls.push({ channel, target, text }); },
  });
  assert.equal(legacyOutcome.delivered, 1);
  assert.equal(legacyCalls[0].target, 'legacy-target');
  assert.equal(getDb().prepare('SELECT status FROM messages WHERE id = ?').get(legacy.id).status, 'read');
  assert.equal(getDb().prepare('SELECT status FROM messages WHERE id = ?').get(internal.id).status, 'pending');
});

test('approval rejection atomically cancels its gate run and dispatch', () => {
  const fixture = createApprovalFixture('approval-reject', {
    verify_shell: 'true',
    verify_timeout_s: 5,
    verify_on_failure: 'error',
  });
  const resolved = resolveApproval(fixture.approval.id, 'rejected', 'operator', 'unsafe request');
  assert.equal(resolved.status, 'rejected');
  assert.equal(getRun(fixture.run.id).status, 'cancelled');
  assert.equal(getRun(fixture.run.id).verification_result, null);
  assert.equal(getDispatch(fixture.dispatch.id).status, 'cancelled');
  assert.match(getDispatch(fixture.dispatch.id).last_error, /unsafe request/);
});

test('approved dispatch survives deferral without requesting approval twice', () => {
  const fixture = createApprovalFixture('approval-deferral');
  assert.equal(resolveApproval(fixture.approval.id, 'approved', 'operator').status, 'approved');
  assert.equal(getRun(fixture.run.id).status, 'approved');
  assert.equal(getDispatch(fixture.dispatch.id).status, 'pending');

  assert.ok(claimDispatch(fixture.dispatch.id));
  assert.equal(beginApprovalDispatch(fixture.dispatch.id).changed, true);
  assert.equal(deferApprovalDispatch(fixture.dispatch.id, 'resource pool busy').changed, true);
  assert.equal(getApproval(fixture.approval.id).status, 'approved');
  assert.equal(getDispatch(fixture.dispatch.id).status, 'pending');

  const duplicate = createApproval(fixture.job.id, fixture.run.id, fixture.dispatch.id);
  assert.equal(duplicate.id, fixture.approval.id);
  assert.equal(duplicate.deduped, true);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 1);

  assert.ok(claimDispatch(fixture.dispatch.id));
  assert.equal(beginApprovalDispatch(fixture.dispatch.id).changed, true);
  assert.equal(markApprovalDispatched(fixture.dispatch.id).changed, true);
  assert.equal(getApproval(fixture.approval.id).status, 'dispatched');
  assert.equal(getRun(fixture.run.id).status, 'skipped');
  assert.equal(markApprovalDispatched(fixture.dispatch.id).changed, false);
  assert.equal(deleteJob(fixture.job.id), true, 'terminal approval gate must not block self-destruct cleanup');
  assert.equal(getJob(fixture.job.id), undefined);
});

test('public cancellation closes approved and dispatching approval gates', () => {
  const approved = createApprovalFixture('approval-cancel-approved');
  assert.equal(resolveApproval(approved.approval.id, 'approved', null).status, 'approved');
  assert.equal(resolveApproval(approved.approval.id, 'cancelled', null, 'operator cancelled').status, 'cancelled');
  assert.equal(getRun(approved.run.id).status, 'cancelled');
  assert.equal(getDispatch(approved.dispatch.id).status, 'cancelled');

  const dispatching = createApprovalFixture('approval-cancel-dispatching');
  assert.equal(resolveApproval(dispatching.approval.id, 'approved', null).status, 'approved');
  assert.ok(claimDispatch(dispatching.dispatch.id));
  assert.equal(beginApprovalDispatch(dispatching.dispatch.id).changed, true);
  assert.equal(resolveApproval(dispatching.approval.id, 'cancelled', null, 'operator cancelled').status, 'cancelled');
  assert.equal(getRun(dispatching.run.id).status, 'cancelled');
  assert.equal(getDispatch(dispatching.dispatch.id).status, 'cancelled');
});

test('only one concurrent approval decision wins', async () => {
  const fixture = createApprovalFixture('approval-race');
  const [approved, rejected] = await Promise.all([
    Promise.resolve().then(() => transitionPendingApproval(fixture.approval.id, 'approved', {
      resolvedBy: 'operator-a',
    })),
    Promise.resolve().then(() => transitionPendingApproval(fixture.approval.id, 'rejected', {
      resolvedBy: 'operator-b',
    })),
  ]);
  assert.equal(Number(approved.changed) + Number(rejected.changed), 1);
  const final = getApproval(fixture.approval.id);
  assert.ok(['approved', 'rejected'].includes(final.status));
  assert.equal(final.decision_version, 1);
  assert.equal(getDispatch(fixture.dispatch.id).status, final.status === 'approved' ? 'pending' : 'cancelled');
});

test('approval bindings cover immutable identity for every dispatch kind', () => {
  for (const kind of ['schedule', 'at', 'manual', 'chain', 'retry']) {
    const job = createJob(jobSpec(`approval-binding-${kind}`, { approval_required: 1 }));
    const dispatch = enqueueDispatch(job.id, { kind });
    const run = createRun(job.id, { status: 'awaiting_approval', dispatch_queue_id: dispatch.id });
    const approval = createApproval(job.id, run.id, dispatch.id);
    getDb().prepare(`
      UPDATE job_dispatch_queue
      SET binding_scheduled_for = datetime(binding_scheduled_for, '+1 second')
      WHERE id = ?
    `).run(dispatch.id);
    const resolved = resolveApproval(approval.id, 'approved', 'operator');
    assert.equal(resolved.status, 'cancelled', `${kind} dispatch binding must reject mutation`);
    assert.match(resolved.cancelled_reason, /execution contract changed/);
  }
});

test('approval creation rejects cross-job and cross-dispatch associations before mutation', () => {
  const firstJob = createJob(jobSpec('approval-association-first', { approval_required: 1 }));
  const secondJob = createJob(jobSpec('approval-association-second', { approval_required: 1 }));
  const firstDispatch = enqueueDispatch(firstJob.id, { kind: 'manual' });
  const alternateDispatch = enqueueDispatch(firstJob.id, { kind: 'retry' });
  const secondDispatch = enqueueDispatch(secondJob.id, { kind: 'manual' });
  const firstRun = createRun(firstJob.id, {
    status: 'pending',
    dispatch_queue_id: alternateDispatch.id,
  });
  const secondRun = createRun(secondJob.id, {
    status: 'pending',
    dispatch_queue_id: secondDispatch.id,
  });

  assert.throws(
    () => createApproval(firstJob.id, null, secondDispatch.id),
    error => error.code === 'APPROVAL_ASSOCIATION_MISMATCH'
      && /different job/.test(error.message),
  );
  assert.throws(
    () => createApproval(firstJob.id, secondRun.id, null),
    error => error.code === 'APPROVAL_ASSOCIATION_MISMATCH'
      && /different job/.test(error.message),
  );
  assert.throws(
    () => createApproval(firstJob.id, firstRun.id, firstDispatch.id),
    error => error.code === 'APPROVAL_ASSOCIATION_MISMATCH'
      && /different dispatch/.test(error.message),
  );

  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 0);
  assert.equal(getRun(firstRun.id).status, 'pending');
  assert.equal(getRun(secondRun.id).status, 'pending');
  for (const dispatch of [firstDispatch, alternateDispatch, secondDispatch]) {
    assert.equal(getDispatch(dispatch.id).status, 'pending');
  }
});

test('approval deduplication rejects a corrupted active association before mutation', () => {
  const firstJob = createJob(jobSpec('approval-dedupe-corrupt-first', { approval_required: 1 }));
  const secondJob = createJob(jobSpec('approval-dedupe-corrupt-second', { approval_required: 1 }));
  const firstDispatch = enqueueDispatch(firstJob.id, { kind: 'manual' });
  const secondDispatch = enqueueDispatch(secondJob.id, { kind: 'manual' });
  const firstRun = createRun(firstJob.id, {
    status: 'awaiting_approval',
    dispatch_queue_id: firstDispatch.id,
  });
  const secondRun = createRun(secondJob.id, {
    status: 'pending',
    dispatch_queue_id: secondDispatch.id,
  });
  const existing = createApproval(firstJob.id, firstRun.id, firstDispatch.id);
  getDb().prepare('UPDATE approvals SET dispatch_queue_id = ? WHERE id = ?')
    .run(secondDispatch.id, existing.id);

  assert.throws(
    () => createApproval(secondJob.id, secondRun.id, secondDispatch.id),
    error => error.code === 'APPROVAL_ASSOCIATION_MISMATCH'
      && /Existing approval/.test(error.message),
  );
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 1);
  assert.equal(getRun(secondRun.id).status, 'pending');
  assert.equal(getDispatch(secondDispatch.id).status, 'pending');
  assert.equal(getApproval(existing.id).job_id, firstJob.id);
  assert.equal(getApproval(existing.id).run_id, firstRun.id);
});

test('approval consumption cancels a corrupted cross-job dispatch association without touching its gate run', () => {
  const fixture = createApprovalFixture('approval-consume-cross-job-dispatch');
  assert.equal(resolveApproval(fixture.approval.id, 'approved', 'operator').status, 'approved');
  const otherJob = createJob(jobSpec('approval-consume-cross-job-target'));
  const otherDispatch = enqueueDispatch(otherJob.id, { kind: 'manual' });
  assert.ok(claimDispatch(otherDispatch.id));
  getDb().prepare('UPDATE approvals SET dispatch_queue_id = ? WHERE id = ?')
    .run(otherDispatch.id, fixture.approval.id);

  const rejected = beginApprovalDispatch(otherDispatch.id);
  assert.equal(rejected.changed, true);
  assert.equal(rejected.reason, 'association_mismatch');
  assert.equal(getApproval(fixture.approval.id).status, 'cancelled');
  assert.equal(getRun(fixture.run.id).status, 'approved');
  assert.equal(getDispatch(fixture.dispatch.id).status, 'pending');
  assert.equal(getDispatch(otherDispatch.id).status, 'cancelled');
});

test('approval consumption cancels corrupted gate-run job and dispatch associations', () => {
  const crossJob = createApprovalFixture('approval-consume-cross-job-run');
  assert.equal(resolveApproval(crossJob.approval.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(crossJob.dispatch.id));
  const otherJob = createJob(jobSpec('approval-consume-cross-run-owner'));
  const otherRun = createRun(otherJob.id, { status: 'pending' });
  getDb().prepare('UPDATE approvals SET run_id = ? WHERE id = ?')
    .run(otherRun.id, crossJob.approval.id);
  const crossJobRejected = beginApprovalDispatch(crossJob.dispatch.id);
  assert.equal(crossJobRejected.reason, 'association_mismatch');
  assert.equal(getApproval(crossJob.approval.id).status, 'cancelled');
  assert.equal(getRun(otherRun.id).status, 'pending');

  const crossDispatch = createApprovalFixture('approval-consume-cross-dispatch-run');
  assert.equal(resolveApproval(crossDispatch.approval.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(crossDispatch.dispatch.id));
  const alternateDispatch = enqueueDispatch(crossDispatch.job.id, { kind: 'retry' });
  const alternateRun = createRun(crossDispatch.job.id, {
    status: 'pending',
    dispatch_queue_id: alternateDispatch.id,
  });
  getDb().prepare('UPDATE approvals SET run_id = ? WHERE id = ?')
    .run(alternateRun.id, crossDispatch.approval.id);
  const crossDispatchRejected = beginApprovalDispatch(crossDispatch.dispatch.id);
  assert.equal(crossDispatchRejected.reason, 'association_mismatch');
  assert.equal(getApproval(crossDispatch.approval.id).status, 'cancelled');
  assert.equal(getRun(alternateRun.id).status, 'pending');
  assert.equal(getDispatch(alternateDispatch.id).status, 'pending');
});

test('approval consumption is single-winner and rechecks authenticated scope', async () => {
  const fixture = createApprovalFixture('approval-consume-scope', {
    approval_approver_scope: `user:${getAuthenticatedApprovalActor().username}`,
  });
  assert.equal(resolveApproval(fixture.approval.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(fixture.dispatch.id));
  const mismatchedActor = {
    authenticated: true,
    canonical: 'local-user:mismatch',
    aliases: ['local-user:mismatch', 'user:mismatch'],
  };
  const rejected = beginApprovalDispatch(fixture.dispatch.id, { authenticatedActor: mismatchedActor });
  assert.equal(rejected.changed, true);
  assert.equal(rejected.reason, 'scope_mismatch');
  assert.equal(getApproval(fixture.approval.id).status, 'cancelled');

  const race = createApprovalFixture('approval-consume-race');
  assert.equal(resolveApproval(race.approval.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(race.dispatch.id));
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => beginApprovalDispatch(race.dispatch.id)),
    Promise.resolve().then(() => beginApprovalDispatch(race.dispatch.id)),
  ]);
  assert.equal(Number(first.changed) + Number(second.changed), 1);
  assert.ok([first.reason, second.reason].includes('already_dispatching'));
});

test('approval dispatch recovery distinguishes started work from an expired claim', () => {
  const started = createApprovalFixture('approval-recovery-started');
  resolveApproval(started.approval.id, 'approved', 'operator');
  assert.ok(claimDispatch(started.dispatch.id));
  assert.equal(beginApprovalDispatch(started.dispatch.id).changed, true);
  createRun(started.job.id, {
    status: 'running',
    dispatch_queue_id: started.dispatch.id,
    approval_used: { approval_id: started.approval.id },
  });

  const expired = createApprovalFixture('approval-recovery-expired');
  resolveApproval(expired.approval.id, 'approved', 'operator');
  assert.ok(claimDispatch(expired.dispatch.id));
  assert.equal(beginApprovalDispatch(expired.dispatch.id).changed, true);
  getDb().prepare(`
    UPDATE job_dispatch_queue
    SET claim_expires_at = datetime('now', '-1 second')
    WHERE id = ?
  `).run(expired.dispatch.id);

  const recovered = recoverInterruptedApprovalDispatches();
  assert.equal(recovered.recovered, 2);
  assert.equal(getApproval(started.approval.id).status, 'dispatched');
  assert.equal(getRun(started.run.id).status, 'skipped');
  assert.equal(getApproval(expired.approval.id).status, 'approved');
  assert.equal(getDispatch(expired.dispatch.id).status, 'pending');
});

test('approval recovery requires an execution run bound to the exact active gate', () => {
  const root = createApprovalFixture('approval-recovery-multiple-gates');
  assert.equal(resolveApproval(root.approval.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(root.dispatch.id));
  assert.equal(beginApprovalDispatch(root.dispatch.id).changed, true);
  assert.equal(markApprovalDispatched(root.dispatch.id).changed, true);

  createRun(root.job.id, {
    status: 'running',
    dispatch_queue_id: root.dispatch.id,
    approval_used: { approval_id: root.approval.id },
  });
  createRun(root.job.id, {
    status: 'running',
    dispatch_queue_id: root.dispatch.id,
    approval_used: 'not-json',
  });

  const authorizationRun = createRun(root.job.id, {
    status: 'awaiting_approval',
    dispatch_queue_id: root.dispatch.id,
  });
  const authorization = createApproval(
    root.job.id,
    authorizationRun.id,
    root.dispatch.id,
    { gateKind: 'authorization' },
  );
  assert.equal(resolveApproval(authorization.id, 'approved', 'operator').status, 'approved');
  assert.ok(claimDispatch(root.dispatch.id));
  assert.equal(beginApprovalDispatch(root.dispatch.id).changed, true);
  getDb().prepare(`
    UPDATE job_dispatch_queue
    SET claim_expires_at = datetime('now', '-1 second')
    WHERE id = ?
  `).run(root.dispatch.id);

  const deferred = recoverInterruptedApprovalDispatches();
  assert.equal(deferred.recovered, 1);
  assert.equal(getApproval(authorization.id).status, 'approved');
  assert.equal(getDispatch(root.dispatch.id).status, 'pending');

  assert.ok(claimDispatch(root.dispatch.id));
  assert.equal(beginApprovalDispatch(root.dispatch.id).changed, true);
  createRun(root.job.id, {
    status: 'running',
    dispatch_queue_id: root.dispatch.id,
    approval_used: { approval_id: authorization.id },
  });
  const completed = recoverInterruptedApprovalDispatches();
  assert.equal(completed.recovered, 1);
  assert.equal(getApproval(authorization.id).status, 'dispatched');
  assert.equal(getRun(authorizationRun.id).status, 'skipped');
});

test('approval recovery terminalizes historical dispatched gate runs', () => {
  const legacy = createApprovalFixture('approval-recovery-legacy-dispatched');
  resolveApproval(legacy.approval.id, 'approved', 'operator');
  getDb().prepare(`
    UPDATE approvals
    SET status = 'dispatched', dispatched_at = datetime('now')
    WHERE id = ?
  `).run(legacy.approval.id);
  getDb().prepare(`
    UPDATE runs
    SET evidence_required = 1
    WHERE id = ?
  `).run(legacy.run.id);

  const recovered = recoverInterruptedApprovalDispatches();
  assert.equal(recovered.recovered, 1);
  assert.equal(getApproval(legacy.approval.id).status, 'dispatched');
  assert.equal(getRun(legacy.run.id).status, 'skipped');
  assert.equal(getRun(legacy.run.id).evidence_required, 0);
  assert.equal(deleteJob(legacy.job.id), true);
});

test('disabled jobs and explicit pre-delete cancellation close active approvals', () => {
  const disabled = createApprovalFixture('approval-disabled');
  resolveApproval(disabled.approval.id, 'approved', 'operator');
  getDb().prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(disabled.job.id);
  const sweep = cancelUnavailableJobApprovals();
  assert.equal(sweep.changed, 1);
  assert.equal(getApproval(disabled.approval.id).status, 'cancelled');
  assert.equal(getRun(disabled.run.id).status, 'cancelled');
  assert.equal(getDispatch(disabled.dispatch.id).status, 'cancelled');

  const deleting = createApprovalFixture('approval-delete');
  const cancelled = cancelApprovalsForJob(deleting.job.id, 'Job deletion requested');
  assert.equal(cancelled.changed, 1);
  assert.equal(getApproval(deleting.approval.id).status, 'cancelled');
  assert.equal(getDispatch(deleting.dispatch.id).status, 'cancelled');
});

test('approval timeout policy releases auto-approved work and cancels rejected work without direct dispatch', async () => {
  const approved = createApprovalFixture('approval-timeout-approve', { approval_auto: 'approve' });
  const rejected = createApprovalFixture('approval-timeout-reject', { approval_auto: 'reject' });
  getDb().prepare(
    "UPDATE approvals SET expires_at = datetime('now', '-1 second') WHERE id IN (?, ?)"
  ).run(approved.approval.id, rejected.approval.id);
  let directDispatchCalls = 0;

  await checkApprovals({
    log() {},
    getTimedOutApprovals,
    getJob(jobId) { return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId); },
    resolveApproval,
    dispatchJob() { directDispatchCalls += 1; },
  });

  assert.equal(directDispatchCalls, 0);
  assert.equal(getApproval(approved.approval.id).status, 'approved');
  assert.equal(getDispatch(approved.dispatch.id).status, 'pending');
  assert.equal(getApproval(rejected.approval.id).status, 'timed_out');
  assert.equal(getDispatch(rejected.dispatch.id).status, 'cancelled');
});

test('maintenance performs no timeout side effects after losing the terminal transition', async () => {
  const job = createJob(jobSpec('maintenance-race'));
  const run = createRun(job.id);
  let deliveries = 0;
  let retries = 0;
  let updates = 0;

  await checkRunHealth({
    log() {},
    getDb,
    getRunningRuns: () => [run],
    getStaleRuns: () => [{ ...run, job_name: job.name }],
    getTimedOutRuns: () => [],
    getJob: () => job,
    updateJobAfterRun() { updates += 1; },
    handleDelivery() { deliveries += 1; },
    dequeueJob() { return false; },
    shouldRetry() { retries += 1; return true; },
    scheduleRetry() { throw new Error('must not schedule'); },
    staleThresholdSeconds: 90,
    transitionRunTerminalFn() {
      return { changed: false, run: { ...run, status: 'cancelled' } };
    },
  });

  assert.equal(deliveries, 0);
  assert.equal(retries, 0);
  assert.equal(updates, 0);
});

test('maintenance leaves active executions to persist their own terminal metadata', async () => {
  const job = createJob(jobSpec('maintenance-active-execution'));
  const run = createRun(job.id);
  let transitions = 0;

  await checkRunHealth({
    log() {},
    getDb,
    getRunningRuns: () => [run],
    getStaleRuns: () => [{ ...run, job_name: job.name }],
    getTimedOutRuns: () => [{ ...run, job_name: job.name }],
    getJob: () => job,
    updateJobAfterRun() { throw new Error('must not update'); },
    handleDelivery() { throw new Error('must not deliver'); },
    dequeueJob() { throw new Error('must not dequeue'); },
    shouldRetry() { throw new Error('must not retry'); },
    scheduleRetry() { throw new Error('must not schedule'); },
    staleThresholdSeconds: 90,
    activeRunIds: new Set([run.id]),
    transitionRunTerminalFn() { transitions += 1; throw new Error('must not transition'); },
  });

  assert.equal(transitions, 0);
  assert.equal(getRun(run.id).status, 'running');
});
