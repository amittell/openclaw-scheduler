export async function checkApprovals({
  log,
  getDb,
  getTimedOutApprovals,
  getJob,
  resolveApproval,
  dispatchJob,
  getDispatch,
  setDispatchStatus,
}) {
  try {
    const timedOut = getTimedOutApprovals();
    for (const approval of timedOut) {
      const job = getJob(approval.job_id);
      if (!job) continue;

      if (approval.approval_auto === 'approve' || job.approval_auto === 'approve') {
        resolveApproval(approval.id, 'approved', 'timeout');
        log('info', `Approval auto-approved (timeout): ${approval.job_name || job.name}`, { approvalId: approval.id });
        if (approval.run_id) {
          getDb().prepare(`
            UPDATE runs
            SET status = 'approved',
                finished_at = datetime('now'),
                summary = COALESCE(summary, 'Approval granted (timeout auto-approve)')
            WHERE id = ? AND status IN ('awaiting_approval', 'pending')
          `).run(approval.run_id);
        }
        await dispatchJob(job, {
          approvalBypass: true,
          dispatchRecord: approval.dispatch_queue_id ? getDispatch(approval.dispatch_queue_id) : null,
        });
        getDb().prepare(`
          UPDATE approvals
          SET status = 'dispatched',
              notes = COALESCE(notes, 'Auto-approved and dispatched by scheduler')
          WHERE id = ? AND status = 'approved'
        `).run(approval.id);
      } else {
        resolveApproval(approval.id, 'timed_out', 'timeout');
        if (approval.dispatch_queue_id) setDispatchStatus(approval.dispatch_queue_id, 'cancelled');
        if (approval.run_id) {
          getDb().prepare(`
            UPDATE runs
            SET status = 'cancelled', finished_at = datetime('now')
            WHERE id = ? AND status = 'awaiting_approval'
          `).run(approval.run_id);
        }
        log('info', `Approval timed out (rejected): ${approval.job_name || job.name}`, { approvalId: approval.id });
      }
    }
  } catch (err) {
    log('error', `Approval timeout check error: ${err.message}`);
  }

  try {
    const db = getDb();
    const approved = db.prepare(`
      SELECT a.*, j.name as job_name
      FROM approvals a
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN runs r ON a.run_id = r.id
      WHERE a.status = 'approved'
        AND (a.run_id IS NULL OR r.status IN ('awaiting_approval', 'pending'))
    `).all();

    for (const approval of approved) {
      const job = getJob(approval.job_id);
      if (!job) continue;
      if (approval.run_id) {
        db.prepare(`
          UPDATE runs
          SET status = 'approved',
              finished_at = datetime('now'),
              summary = COALESCE(summary, 'Approved by operator')
          WHERE id = ? AND status IN ('awaiting_approval', 'pending')
        `).run(approval.run_id);
      }
      log('info', `Dispatching approved job: ${approval.job_name}`, { approvalId: approval.id });
      await dispatchJob(job, {
        approvalBypass: true,
        dispatchRecord: approval.dispatch_queue_id ? getDispatch(approval.dispatch_queue_id) : null,
      });
      db.prepare(`
        UPDATE approvals
        SET status = 'dispatched',
            notes = COALESCE(notes, 'Approved and dispatched by scheduler')
        WHERE id = ? AND status = 'approved'
      `).run(approval.id);
    }
  } catch (err) {
    log('error', `Approval dispatch error: ${err.message}`);
  }
}
