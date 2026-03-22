// Team adapter — map scheduler queue messages to team mailbox/task events.
import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import { ackMessage } from './messages.js';
import { createTaskGroup, getTaskGroup, checkGroupCompletion } from './task-tracker.js';

function sqliteNow() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function taskKeyFromMessage(msg) {
  if (msg.task_id) return msg.task_id;
  if (msg.kind === 'task') return msg.id;
  return null;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

export function mapTeamMessages(limit = 100) {
  const db = getDb();
  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE team_id IS NOT NULL
      AND team_mapped_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);

  if (msgs.length === 0) return 0;
  const now = sqliteNow();

  const mapOne = db.transaction((msg) => {
    const taskId = taskKeyFromMessage(msg);
    let eventType = 'mailbox';

    if (taskId) {
      const existing = db.prepare(`
        SELECT team_id, id
        FROM team_tasks
        WHERE team_id = ? AND id = ?
      `).get(msg.team_id, taskId);

      if (!existing) {
        db.prepare(`
          INSERT INTO team_tasks (
            team_id, id, member_id, source_message_id, title, status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
        `).run(
          msg.team_id,
          taskId,
          msg.member_id || null,
          msg.id,
          msg.subject || (msg.body || '').slice(0, 120) || 'Team task',
          now,
          now
        );
        eventType = 'task_created';
      } else {
        db.prepare(`
          UPDATE team_tasks
          SET member_id = COALESCE(member_id, ?),
              source_message_id = COALESCE(source_message_id, ?),
              updated_at = ?
          WHERE team_id = ? AND id = ?
        `).run(msg.member_id || null, msg.id, now, msg.team_id, taskId);
        eventType = 'task_message';
      }
    }

    db.prepare(`
      INSERT INTO team_mailbox_events (id, team_id, member_id, task_id, message_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      msg.team_id,
      msg.member_id || null,
      taskId,
      msg.id,
      eventType,
      safeJson({
        kind: msg.kind,
        from_agent: msg.from_agent,
        to_agent: msg.to_agent,
        subject: msg.subject,
        status: msg.status,
        priority: msg.priority,
        ack_required: !!msg.ack_required,
      }),
      now
    );

    db.prepare(`
      UPDATE messages
      SET team_mapped_at = COALESCE(team_mapped_at, ?)
      WHERE id = ?
    `).run(now, msg.id);
  });

  let mapped = 0;
  for (const msg of msgs) {
    try {
      mapOne(msg);
      mapped++;
    } catch (err) {
      process.stderr.write(`[team-adapter] mapOne error for msg ${msg.id}: ${err?.message || String(err)}
`);
    }
  }

  return mapped;
}

export function listTeamTasks(teamId, limit = 50) {
  return getDb().prepare(`
    SELECT *
    FROM team_tasks
    WHERE team_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(teamId, limit);
}

export function listTeamMailboxEvents(teamId, opts = {}) {
  const limit = opts.limit || 50;
  const taskId = opts.taskId || null;
  if (taskId) {
    return getDb().prepare(`
      SELECT *
      FROM team_mailbox_events
      WHERE team_id = ? AND task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(teamId, taskId, limit);
  }
  return getDb().prepare(`
    SELECT *
    FROM team_mailbox_events
    WHERE team_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(teamId, limit);
}

export function createTeamTaskGate({
  teamId,
  taskId,
  expectedMembers,
  timeoutS = 600,
  createdBy = 'main',
  deliveryChannel,
  deliveryTo,
}) {
  if (!teamId) throw new Error('teamId is required');
  if (!taskId) throw new Error('taskId is required');
  if (!Array.isArray(expectedMembers) || expectedMembers.length === 0) {
    throw new Error('expectedMembers must be a non-empty array');
  }

  const db = getDb();
  const now = sqliteNow();
  const group = createTaskGroup({
    name: `team:${teamId}:task:${taskId}`,
    expectedAgents: expectedMembers,
    timeoutS,
    createdBy,
    deliveryChannel,
    deliveryTo,
  });

  const upsert = db.prepare(`
    INSERT INTO team_tasks (
      team_id, id, title, status, gate_tracker_id, gate_status, created_at, updated_at
    )
    VALUES (?, ?, ?, 'blocked', ?, 'waiting', ?, ?)
    ON CONFLICT(team_id, id) DO UPDATE SET
      status = 'blocked',
      gate_tracker_id = excluded.gate_tracker_id,
      gate_status = 'waiting',
      updated_at = excluded.updated_at
  `);
  upsert.run(
    teamId,
    taskId,
    `Team task ${taskId}`,
    group.id,
    now,
    now
  );

  db.prepare(`
    INSERT INTO team_mailbox_events (id, team_id, task_id, event_type, payload, created_at)
    VALUES (?, ?, ?, 'gate_open', ?, ?)
  `).run(
    randomUUID(),
    teamId,
    taskId,
    safeJson({ tracker_id: group.id, expected_members: expectedMembers, timeout_s: timeoutS }),
    now
  );

  return {
    team_id: teamId,
    task_id: taskId,
    gate_status: 'waiting',
    tracker_id: group.id,
    expected_members: expectedMembers,
  };
}

export function checkTeamTaskGates(limit = 100) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT team_id, id as task_id, gate_tracker_id
    FROM team_tasks
    WHERE gate_status = 'waiting'
      AND gate_tracker_id IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(limit);

  if (rows.length === 0) return { passed: 0, failed: 0, pending: 0 };
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const now = sqliteNow();

  for (const row of rows) {
    // Ensure tracker terminal state is evaluated before reading status.
    checkGroupCompletion(row.gate_tracker_id);
    const tracker = getTaskGroup(row.gate_tracker_id);
    if (!tracker) {
      failed += 1;
      db.prepare(`
        UPDATE team_tasks
        SET gate_status = 'failed',
            status = 'failed',
            last_error = 'Missing tracker',
            updated_at = ?,
            completed_at = COALESCE(completed_at, ?)
        WHERE team_id = ? AND id = ?
      `).run(now, now, row.team_id, row.task_id);
      db.prepare(`
        INSERT INTO team_mailbox_events (id, team_id, task_id, event_type, payload, created_at)
        VALUES (?, ?, ?, 'gate_failed', ?, ?)
      `).run(randomUUID(), row.team_id, row.task_id, safeJson({ tracker_id: row.gate_tracker_id, reason: 'missing_tracker' }), now);
      continue;
    }

    if (tracker.status === 'active') {
      pending += 1;
      continue;
    }

    if (tracker.status === 'completed') {
      passed += 1;
      db.prepare(`
        UPDATE team_tasks
        SET gate_status = 'passed',
            status = 'open',
            updated_at = ?
        WHERE team_id = ? AND id = ?
      `).run(now, row.team_id, row.task_id);
      db.prepare(`
        INSERT INTO team_mailbox_events (id, team_id, task_id, event_type, payload, created_at)
        VALUES (?, ?, ?, 'gate_passed', ?, ?)
      `).run(
        randomUUID(),
        row.team_id,
        row.task_id,
        safeJson({ tracker_id: row.gate_tracker_id, summary: tracker.summary || null }),
        now
      );
      continue;
    }

    failed += 1;
    db.prepare(`
      UPDATE team_tasks
      SET gate_status = 'failed',
          status = 'failed',
          last_error = ?,
          updated_at = ?,
          completed_at = COALESCE(completed_at, ?)
      WHERE team_id = ? AND id = ?
    `).run(
      tracker.summary || `Gate ${tracker.status}`,
      now,
      now,
      row.team_id,
      row.task_id
    );
    db.prepare(`
      INSERT INTO team_mailbox_events (id, team_id, task_id, event_type, payload, created_at)
      VALUES (?, ?, ?, 'gate_failed', ?, ?)
    `).run(
      randomUUID(),
      row.team_id,
      row.task_id,
      safeJson({ tracker_id: row.gate_tracker_id, summary: tracker.summary || null, status: tracker.status }),
      now
    );
  }

  return { passed, failed, pending };
}

export function ackTeamMessage(messageId, actor = 'team-member', detail = null) {
  const db = getDb();
  const msg = db.prepare(`
    SELECT *
    FROM messages
    WHERE id = ? AND team_id IS NOT NULL
  `).get(messageId);
  if (!msg) return null;

  const updated = ackMessage(messageId, actor, detail);
  const taskId = taskKeyFromMessage(msg);
  db.prepare(`
    INSERT INTO team_mailbox_events (id, team_id, member_id, task_id, message_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, 'ack', ?, ?)
  `).run(
    randomUUID(),
    msg.team_id,
    msg.member_id || null,
    taskId,
    msg.id,
    safeJson({ actor, detail }),
    sqliteNow()
  );
  return updated;
}
