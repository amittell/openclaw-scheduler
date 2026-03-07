import { getRun } from './runs.js';
import { getJob } from './jobs.js';

export function buildTriggeredRunContext(run, deps = {}) {
  if (!run?.triggered_by_run) {
    return { text: '', meta: {} };
  }

  const getRunById = deps.getRunById || getRun;
  const getJobById = deps.getJobById || getJob;
  const parentRun = getRunById(run.triggered_by_run);

  if (!parentRun) {
    return {
      text: '',
      meta: {
        triggered_by_run: run.triggered_by_run,
        parent_run_missing: true
      }
    };
  }

  const parentJob = getJobById(parentRun.job_id);
  const lines = [
    '',
    '--- Trigger Context ---',
    `Triggered by: ${parentJob?.name || parentRun.job_id}`,
    `Parent run status: ${parentRun.status}`
  ];

  if (parentRun.summary?.trim()) {
    lines.push('Parent run output:');
    lines.push(parentRun.summary.slice(0, 5000));
  } else if (parentRun.error_message?.trim()) {
    lines.push('Parent run error:');
    lines.push(parentRun.error_message.slice(0, 2000));
  }

  lines.push('---');

  return {
    text: lines.join('\n'),
    meta: {
      triggered_by_run: parentRun.id,
      parent_job_id: parentRun.job_id,
      parent_job_name: parentJob?.name || null,
      parent_run_status: parentRun.status
    }
  };
}
