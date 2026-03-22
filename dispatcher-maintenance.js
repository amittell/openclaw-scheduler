export async function checkRunHealth({
  log,
  getRunningRuns,
  getStaleRuns,
  getTimedOutRuns,
  finishRun,
  getJob,
  updateJobAfterRun,
  handleDelivery,
  dequeueJob,
  staleThresholdSeconds,
}) {
  const runningRuns = getRunningRuns();
  if (runningRuns.length === 0) return;

  log('debug', `Checking ${runningRuns.length} running run(s)`);

  const staleRuns = getStaleRuns(staleThresholdSeconds);
  for (const run of staleRuns) {
    log('warn', `Stale run: ${run.job_name}`, { runId: run.id });
    finishRun(run.id, 'timeout', {
      error_message: `No activity for ${staleThresholdSeconds}s`,
    });
    const job = getJob(run.job_id);
    if (!job) continue;
    updateJobAfterRun(job, 'timeout');
    if (['announce', 'announce-always'].includes(job.delivery_mode)) {
      await handleDelivery(job, `⏱ Job timed out (stale): ${job.name}\n\nNo activity for ${staleThresholdSeconds}s`);
    }
    if (dequeueJob(job.id)) {
      log('info', `Dequeued pending dispatch for ${job.name} (after stale timeout)`);
    }
  }

  const timedOut = getTimedOutRuns();
  for (const run of timedOut) {
    log('warn', `Timed out: ${run.job_name}`, { runId: run.id, timeoutMs: run.run_timeout_ms });
    finishRun(run.id, 'timeout', {
      error_message: `Exceeded ${run.run_timeout_ms}ms timeout`,
    });
    const job = getJob(run.job_id);
    if (!job) continue;
    updateJobAfterRun(job, 'timeout');
    if (['announce', 'announce-always'].includes(job.delivery_mode)) {
      await handleDelivery(job, `⏱ Job timed out: ${job.name}\n\nExceeded ${run.run_timeout_ms}ms timeout`);
    }
    if (dequeueJob(job.id)) {
      log('info', `Dequeued pending dispatch for ${job.name} (after absolute timeout)`);
    }
  }
}

export async function checkTaskTrackers({
  log,
  getDb,
  getAllSubAgentSessions,
  touchAgentHeartbeat,
  checkDeadAgents,
  listActiveTaskGroups,
  checkGroupCompletion,
  getTaskGroupStatus,
  resolveDeliveryAlias,
  deliverMessage,
}) {
  try {
    try {
      const db = getDb();
      const activeSessions = await getAllSubAgentSessions(10);
      if (activeSessions.length > 0) {
        for (const session of activeSessions) {
          const sessionKey = session.key || session.sessionKey;
          if (!sessionKey) continue;

          const agent = db.prepare(`
            SELECT a.tracker_id, a.agent_label
            FROM task_tracker_agents a
            JOIN task_tracker t ON a.tracker_id = t.id
            WHERE a.session_key = ? AND a.status IN ('pending', 'running') AND t.status = 'active'
          `).get(sessionKey);

          if (agent) {
            touchAgentHeartbeat(agent.tracker_id, agent.agent_label);
            log('debug', `Auto-heartbeat: ${agent.agent_label} (session active)`);
          }
        }
      }
    } catch (corrErr) {
      log('debug', `Session auto-correlation skipped: ${corrErr.message}`);
    }

    const deadAgents = checkDeadAgents();
    if (deadAgents.length > 0) {
      log('warn', `Marked ${deadAgents.length} dead agent(s)`, {
        agents: deadAgents.map(d => `${d.tracker_id.slice(0, 8)}/${d.agent_label}`),
      });
    }

    const activeGroups = listActiveTaskGroups();
    for (const group of activeGroups) {
      const result = checkGroupCompletion(group.id);
      if (!result) continue;
      const status = getTaskGroupStatus(group.id);
      const emoji = result.status === 'completed' ? '✅' : '❌';
      const msg = `${emoji} Task group "${group.name}" ${result.status}\n\n${result.summary || ''}`;
      log('info', `Task group ${result.status}: ${group.name}`, {
        trackerId: group.id,
        status: status?.status || result.status,
      });

      if (group.delivery_channel && group.delivery_to) {
        try {
          let channel = group.delivery_channel;
          let target = group.delivery_to;
          const resolved = resolveDeliveryAlias(target);
          if (resolved) {
            channel = resolved.channel;
            target = resolved.target;
          }
          await deliverMessage(channel, target, msg);
          log('info', `Task tracker summary delivered`, { channel, target, trackerId: group.id });
        } catch (err) {
          log('error', `Task tracker delivery failed: ${err.message}`, { trackerId: group.id });
        }
      }
    }
  } catch (err) {
    log('error', `Task tracker check error: ${err.message}`);
  }
}

export function deliverPendingMessages({ expireMessages }) {
  expireMessages();
}

export function ensureAgentInboxJobs({ log, getDb, createJob, schedulerDir }) {
  try {
    const db = getDb();

    // Find agents with delivery config
    const agents = db.prepare(`
      SELECT id, delivery_channel, delivery_to, brand_name
      FROM agents
      WHERE delivery_channel IS NOT NULL AND delivery_to IS NOT NULL
    `).all();

    if (agents.length === 0) return;

    for (const agent of agents) {
      const jobName = `inbox-consumer:${agent.id}`;

      // Check if job already exists
      const existing = db.prepare('SELECT id FROM jobs WHERE name = ?').get(jobName);
      if (existing) continue;

      // Create the inbox consumer job
      const consumerCmd = `node ${schedulerDir}/scripts/inbox-consumer.mjs --agent ${agent.id} --to ${agent.delivery_to} --channel ${agent.delivery_channel}`;

      createJob({
        name:             jobName,
        schedule_cron:    '*/5 * * * *',
        session_target:   'shell',
        payload_kind:     'shellCommand',
        payload_message:  consumerCmd,
        delivery_mode:    'none',
        overlap_policy:   'skip',
        enabled:          1,
        run_timeout_ms:   120_000,  // 2 min: inbox consumer shell script should be fast
        origin:           'system',
      });

      log('info', `Created inbox consumer job: ${jobName} → ${agent.delivery_channel}:${agent.delivery_to}`);
    }
  } catch (err) {
    log('error', `ensureAgentInboxJobs error: ${err.message}`);
  }
}

