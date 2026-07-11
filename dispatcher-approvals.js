import {
  cancelUnavailableJobApprovals,
  recoverInterruptedApprovalDispatches,
} from './approval-state.js';

export async function checkApprovals({
  log,
  getTimedOutApprovals,
  getJob,
  resolveApproval,
  cancelUnavailableJobApprovalsFn = cancelUnavailableJobApprovals,
  recoverInterruptedApprovalDispatchesFn = recoverInterruptedApprovalDispatches,
}) {
  try {
    const recovered = recoverInterruptedApprovalDispatchesFn();
    if (recovered?.recovered > 0) {
      log('warn', `Recovered ${recovered.recovered} interrupted approval dispatch(es)`);
    }
  } catch (err) {
    log('error', `Approval dispatch recovery error: ${err.message}`);
  }

  try {
    const cancelled = cancelUnavailableJobApprovalsFn();
    if (cancelled?.changed > 0) {
      log('info', `Cancelled ${cancelled.changed} approval(s) for unavailable jobs`);
    }
  } catch (err) {
    log('error', `Unavailable-job approval cancellation error: ${err.message}`);
  }

  let timedOut;
  try {
    timedOut = getTimedOutApprovals();
  } catch (err) {
    log('error', `Approval timeout query error: ${err.message}`);
    return;
  }

  for (const approval of timedOut) {
    try {
      const job = getJob(approval.job_id);
      if (!job || job.enabled !== 1) {
        const result = resolveApproval(
          approval.id,
          'cancelled',
          'scheduler',
          !job ? 'Job deleted before approval timeout' : 'Job disabled before approval timeout'
        );
        if (result?.status === 'cancelled') {
          log('info', `Approval cancelled for unavailable job: ${approval.job_name || approval.job_id}`, {
            approvalId: approval.id,
          });
        }
        continue;
      }

      if (approval.approval_auto === 'approve' || job.approval_auto === 'approve') {
        const result = resolveApproval(
          approval.id,
          'approved',
          'timeout',
          'Approval granted by timeout auto-approve policy'
        );
        if (result?.status === 'approved') {
          log('info', `Approval auto-approved after timeout: ${approval.job_name || job.name}`, {
            approvalId: approval.id,
            dispatchId: approval.dispatch_queue_id || null,
          });
        }
      } else {
        const result = resolveApproval(
          approval.id,
          'timed_out',
          'timeout',
          'Approval timed out and was rejected by policy'
        );
        if (result?.status === 'timed_out') {
          log('info', `Approval timed out and was rejected: ${approval.job_name || job.name}`, {
            approvalId: approval.id,
            dispatchId: approval.dispatch_queue_id || null,
          });
        }
      }
    } catch (err) {
      log('error', `Approval timeout transition failed: ${err.message}`, {
        approvalId: approval.id,
        jobId: approval.job_id,
      });
    }
  }
}
