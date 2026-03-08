const DEFAULT_STORE_LIMIT = 64 * 1024;
const DEFAULT_EXCERPT_LIMIT = 2000;
const DEFAULT_SUMMARY_LIMIT = 5000;

function toText(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function truncateText(value, limit) {
  const text = toText(value).trim();
  if (!text) return { text: '', truncated: false };
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, limit - 24))}\n...[truncated]`,
    truncated: true
  };
}

function deriveErrorMessage(result, timeoutMs) {
  if (result.status === 'ok') return null;
  if (result.timedOut) {
    return `Shell command timed out after ${timeoutMs}ms`;
  }
  if (typeof result.exitCode === 'number') {
    return `Shell exited with code ${result.exitCode}`;
  }
  if (result.signal) {
    return `Shell terminated by signal ${result.signal}`;
  }
  return result.rawError?.message || 'Shell command failed';
}

export function normalizeShellResult(
  {
    stdout = '',
    stderr = '',
    error = null,
  },
  {
    timeoutMs = 300000,
    storeLimit = DEFAULT_STORE_LIMIT,
    excerptLimit = DEFAULT_EXCERPT_LIMIT,
    summaryLimit = DEFAULT_SUMMARY_LIMIT,
  } = {}
) {
  const stdoutStored = truncateText(stdout, storeLimit);
  const stderrStored = truncateText(stderr, storeLimit);
  const stdoutExcerpt = truncateText(stdout, excerptLimit);
  const stderrExcerpt = truncateText(stderr, excerptLimit);
  const combined = [toText(stdout).trim(), toText(stderr).trim()].filter(Boolean).join('\n').trim();

  const exitCode = Number.isInteger(error?.code) ? error.code : null;
  const signal = error?.signal || null;
  const timedOut = Boolean(
    error && (
      error.code === 'ETIMEDOUT'
      || /timed out/i.test(error?.message || '')
      || (error.killed && exitCode == null && signal === 'SIGTERM')
    )
  );
  const status = timedOut ? 'timeout' : error ? 'error' : 'ok';
  const errorMessage = deriveErrorMessage({ status, timedOut, exitCode, signal, rawError: error }, timeoutMs);
  const output = combined || errorMessage || '(no output)';

  return {
    status,
    exitCode,
    signal,
    timedOut,
    stdout: stdoutStored.text,
    stderr: stderrStored.text,
    stdoutTruncated: stdoutStored.truncated,
    stderrTruncated: stderrStored.truncated,
    summary: output.slice(0, summaryLimit),
    deliveryText: output,
    errorMessage,
    contextSummary: {
      shell_result: {
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        error_message: errorMessage,
        stdout_excerpt: stdoutExcerpt.text,
        stderr_excerpt: stderrExcerpt.text,
        stdout_truncated: stdoutStored.truncated || stdoutExcerpt.truncated,
        stderr_truncated: stderrStored.truncated || stderrExcerpt.truncated,
      }
    }
  };
}

export function extractShellResultFromRun(run) {
  if (!run) return null;

  const hasDirectFields = run.shell_exit_code != null
    || run.shell_signal != null
    || run.shell_timed_out != null
    || (typeof run.shell_stdout === 'string' && run.shell_stdout.length > 0)
    || (typeof run.shell_stderr === 'string' && run.shell_stderr.length > 0);

  if (hasDirectFields) {
    return {
      exitCode: run.shell_exit_code ?? null,
      signal: run.shell_signal ?? null,
      timedOut: Boolean(run.shell_timed_out),
      stdout: run.shell_stdout || '',
      stderr: run.shell_stderr || '',
      errorMessage: run.error_message || null,
    };
  }

  if (!run.context_summary) return null;

  try {
    const parsed = JSON.parse(run.context_summary);
    const shell = parsed?.shell_result;
    if (!shell) return null;
    return {
      exitCode: shell.exit_code ?? null,
      signal: shell.signal ?? null,
      timedOut: Boolean(shell.timed_out),
      stdout: shell.stdout_excerpt || '',
      stderr: shell.stderr_excerpt || '',
      errorMessage: shell.error_message || null,
    };
  } catch {
    return null;
  }
}
