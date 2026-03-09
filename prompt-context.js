import { getRun } from './runs.js';
import { getJob } from './jobs.js';
import { extractShellResultFromRun } from './shell-result.js';

function truncate(text, limit) {
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 16))}\n...[truncated]`;
}

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

  const shellResult = extractShellResultFromRun(parentRun);
  if (shellResult) {
    lines.push('Parent shell result:');
    if (shellResult.timedOut) {
      lines.push('Timed out: true');
    }
    if (typeof shellResult.exitCode === 'number') {
      lines.push(`Exit code: ${shellResult.exitCode}`);
    }
    if (shellResult.signal) {
      lines.push(`Signal: ${shellResult.signal}`);
    }
    if (shellResult.errorMessage) {
      lines.push(`Error: ${shellResult.errorMessage}`);
    }
    if (shellResult.stdout?.trim()) {
      lines.push('stdout:');
      lines.push(truncate(shellResult.stdout, 3000));
    }
    if (shellResult.stdoutPath) {
      lines.push(`stdout file: ${shellResult.stdoutPath} (${shellResult.stdoutBytes || 0} bytes)`);
    }
    if (shellResult.stderr?.trim()) {
      lines.push('stderr:');
      lines.push(truncate(shellResult.stderr, 3000));
    }
    if (shellResult.stderrPath) {
      lines.push(`stderr file: ${shellResult.stderrPath} (${shellResult.stderrBytes || 0} bytes)`);
    }
  } else if (parentRun.summary?.trim()) {
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
      parent_run_status: parentRun.status,
      ...(shellResult
        ? {
            parent_shell_exit_code: shellResult.exitCode,
            parent_shell_signal: shellResult.signal,
            parent_shell_timed_out: shellResult.timedOut,
            parent_shell_stdout_path: shellResult.stdoutPath || null,
            parent_shell_stderr_path: shellResult.stderrPath || null,
          }
        : {})
    }
  };
}
