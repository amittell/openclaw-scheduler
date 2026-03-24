import { writeFileSync } from 'fs';
import { join } from 'path';
import { getResolvedDbPath } from './db.js';
import { ensureArtifactsDir, resolveArtifactsDir } from './paths.js';

export const DEFAULT_STORE_LIMIT = 64 * 1024;
export const DEFAULT_EXCERPT_LIMIT = 2000;
export const DEFAULT_SUMMARY_LIMIT = 5000;
export const DEFAULT_OFFLOAD_THRESHOLD = 64 * 1024;

function toText(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function textBytes(value) {
  return Buffer.byteLength(toText(value), 'utf8');
}

// Note: limits are enforced by character count (UTF-16 code units), not byte count.
// For ASCII shell output (the common case) these are equivalent.
function truncateText(value, limit) {
  const text = toText(value).trim();
  if (!text) return { text: '', truncated: false, bytes: 0 };
  const bytes = textBytes(text);
  if (text.length <= limit) return { text, truncated: false, bytes };
  return {
    text: `${text.slice(0, Math.max(0, limit - 24))}\n...[truncated]`,
    truncated: true,
    bytes,
  };
}

function deriveErrorMessage(result, timeoutMs) {
  if (result.status === 'ok') return null;
  if (result.timedOut) return `Shell command timed out after ${timeoutMs}ms`;
  if (typeof result.exitCode === 'number') return `Shell exited with code ${result.exitCode}`;
  if (result.signal) return `Shell terminated by signal ${result.signal}`;
  return result.rawError?.message || 'Shell command failed';
}

function writeOutputArtifact(kind, runId, text, artifactsDir) {
  if (!artifactsDir || !runId || !text.trim()) return null;
  const baseDir = ensureArtifactsDir(join(artifactsDir, 'runs', runId));
  const filePath = join(baseDir, `${kind}.txt`);
  writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function formatOutputBlock(label, excerpt, artifactPath, bytes) {
  const parts = [];
  if (excerpt.text) {
    parts.push(`${label}:`);
    parts.push(excerpt.text);
  }
  if (artifactPath) {
    parts.push(`[${label} offloaded: ${artifactPath} (${bytes} bytes)]`);
  }
  return parts.join('\n');
}

export function normalizeShellResult(
  {
    stdout = '',
    stderr = '',
    error = null,
  },
  {
    runId = null,
    timeoutMs = 300000,
    storeLimit = DEFAULT_STORE_LIMIT,
    excerptLimit = DEFAULT_EXCERPT_LIMIT,
    summaryLimit = DEFAULT_SUMMARY_LIMIT,
    offloadThreshold = DEFAULT_OFFLOAD_THRESHOLD,
    artifactsDir = resolveArtifactsDir({ dbPath: getResolvedDbPath() }),
  } = {}
) {
  const stdoutText = toText(stdout);
  const stderrText = toText(stderr);
  const stdoutBytes = textBytes(stdoutText);
  const stderrBytes = textBytes(stderrText);
  const stdoutOffloaded = stdoutBytes > offloadThreshold
    ? writeOutputArtifact('stdout', runId, stdoutText, artifactsDir)
    : null;
  const stderrOffloaded = stderrBytes > offloadThreshold
    ? writeOutputArtifact('stderr', runId, stderrText, artifactsDir)
    : null;

  const stdoutStored = truncateText(stdoutText, Math.min(storeLimit, stdoutOffloaded ? excerptLimit : storeLimit));
  const stderrStored = truncateText(stderrText, Math.min(storeLimit, stderrOffloaded ? excerptLimit : storeLimit));
  const stdoutExcerpt = truncateText(stdoutText, excerptLimit);
  const stderrExcerpt = truncateText(stderrText, excerptLimit);

  const exitCode = Number.isInteger(error?.code) ? error.code : null;
  const signal = error?.signal || null;
  const timedOut = Boolean(
    error && (
      error.code === 'ETIMEDOUT'
      || error.killed === true
      || /timed out/i.test(error?.message || '')
      || /exceeded absolute timeout/i.test(error?.message || '')
      || /idle.*timeout/i.test(error?.message || '')
    )
  );
  const status = timedOut ? 'timeout' : error ? 'error' : 'ok';
  const errorMessage = deriveErrorMessage({ status, timedOut, exitCode, signal, rawError: error }, timeoutMs);

  const blocks = [
    formatOutputBlock('stdout', stdoutExcerpt, stdoutOffloaded, stdoutBytes),
    formatOutputBlock('stderr', stderrExcerpt, stderrOffloaded, stderrBytes),
  ].filter(Boolean);
  if (blocks.length === 0 && errorMessage) blocks.push(errorMessage);
  const previewText = blocks.join('\n\n').trim() || '(no output)';

  return {
    status,
    exitCode,
    signal,
    timedOut,
    stdout: stdoutStored.text,
    stderr: stderrStored.text,
    stdoutPath: stdoutOffloaded,
    stderrPath: stderrOffloaded,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutStored.truncated,
    stderrTruncated: stderrStored.truncated,
    summary: truncateText(previewText, summaryLimit).text,
    deliveryText: previewText,
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
        stdout_path: stdoutOffloaded,
        stderr_path: stderrOffloaded,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
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
    || (typeof run.shell_stderr === 'string' && run.shell_stderr.length > 0)
    || typeof run.shell_stdout_path === 'string'
    || typeof run.shell_stderr_path === 'string';

  if (hasDirectFields) {
    return {
      exitCode: run.shell_exit_code ?? null,
      signal: run.shell_signal ?? null,
      timedOut: Boolean(run.shell_timed_out),
      stdout: run.shell_stdout || '',
      stderr: run.shell_stderr || '',
      stdoutPath: run.shell_stdout_path || null,
      stderrPath: run.shell_stderr_path || null,
      stdoutBytes: run.shell_stdout_bytes ?? textBytes(run.shell_stdout || ''),
      stderrBytes: run.shell_stderr_bytes ?? textBytes(run.shell_stderr || ''),
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
      stdoutPath: shell.stdout_path || null,
      stderrPath: shell.stderr_path || null,
      stdoutBytes: shell.stdout_bytes ?? 0,
      stderrBytes: shell.stderr_bytes ?? 0,
      errorMessage: shell.error_message || null,
    };
  } catch {
    return null;
  }
}
