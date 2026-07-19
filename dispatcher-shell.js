import { spawn, spawnSync } from 'child_process';
import { basename } from 'path';

export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

// Platform-aware shell defaults:
// - macOS: /bin/zsh
// - Linux/WSL: /bin/bash
// - Windows: cmd.exe
// Override with SCHEDULER_SHELL env var.
export const DEFAULT_SHELL = process.env.SCHEDULER_SHELL
  || (process.platform === 'darwin'
    ? '/bin/zsh'
    : process.platform === 'win32'
      ? 'cmd.exe'
      : '/bin/bash');

const MINIMAL_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
]);

function copyDefinedEnv(source, target, predicate = () => true) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value == null || !predicate(key)) continue;
    target[key] = String(value);
  }
}

export function buildShellEnvironment(env = null, policy = 'inherit') {
  if (!['minimal', 'inherit'].includes(policy)) {
    throw new Error('envPolicy must be one of: minimal, inherit');
  }
  const result = {};
  if (policy === 'inherit') {
    copyDefinedEnv(process.env, result);
  } else {
    copyDefinedEnv(
      process.env,
      result,
      key => MINIMAL_ENV_KEYS.has(key) || key.startsWith('LC_'),
    );
  }
  copyDefinedEnv(env, result);
  return result;
}

function shellArgs(shell, cmd) {
  const executable = basename(shell).toLowerCase();
  if (process.platform === 'win32' && (executable === 'cmd' || executable === 'cmd.exe')) {
    return ['/d', '/s', '/c', cmd];
  }
  if (process.platform === 'win32' && ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd];
  }
  return ['-c', cmd];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Read a process creation identity that changes when an operating-system PID is reused. */
export function inspectProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, identity: null };
  if (!processAlive(pid)) return { alive: false, identity: null };

  const command = process.platform === 'win32'
    ? {
        executable: 'powershell.exe',
        args: [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
            `'{0}|{1}' -f $p.StartTime.ToUniversalTime().ToString('o'),$p.Path`,
        ],
      }
    : {
        executable: 'ps',
        args: ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)],
      };
  const result = spawnSync(command.executable, command.args, {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) {
    return processAlive(pid) ? { alive: true, identity: null } : { alive: false, identity: null };
  }
  const identity = String(result.stdout || '').trim().replace(/\s+/g, ' ');
  if (!identity) {
    return processAlive(pid) ? { alive: true, identity: null } : { alive: false, identity: null };
  }
  return { alive: true, identity };
}

function isPosixProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function signalPosixProcessGroup(child, pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      try { return child.kill(signal); } catch { return false; }
    }
    return false;
  }
}

function taskkill(pid, force) {
  return new Promise(resolve => {
    let killer;
    try {
      killer = spawn('taskkill', [
        '/pid', String(pid),
        '/T',
        ...(force ? ['/F'] : []),
      ], { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    killer.once('error', () => resolve(false));
    killer.once('close', code => resolve(code === 0));
  });
}

/** Terminate the complete child process tree, escalating after graceMs. */
export async function terminateProcessTree(child, opts = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  const graceMs = Number.isInteger(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : 2_000;

  if (process.platform === 'win32') {
    if (!processAlive(child.pid)) return true;
    await taskkill(child.pid, false);
    if (graceMs > 0) await delay(graceMs);
    if (processAlive(child.pid)) await taskkill(child.pid, true);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && processAlive(child.pid)) await delay(25);
    return !processAlive(child.pid);
  }

  const pgid = Number.isInteger(opts.pgid) && opts.pgid > 0 ? opts.pgid : child.pid;
  if (!isPosixProcessGroupAlive(pgid)) return true;
  signalPosixProcessGroup(child, pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isPosixProcessGroupAlive(pgid)) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  if (isPosixProcessGroupAlive(pgid)) {
    signalPosixProcessGroup(child, pgid, 'SIGKILL');
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline && isPosixProcessGroupAlive(pgid)) await delay(25);
  return !isPosixProcessGroupAlive(pgid);
}

function createCapture(limit) {
  return { chunks: [], capturedBytes: 0, totalBytes: 0, truncated: false, limit };
}

function appendCapture(capture, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  capture.totalBytes += buffer.length;
  const remaining = capture.limit - capture.capturedBytes;
  if (remaining > 0) {
    const kept = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
    capture.chunks.push(kept);
    capture.capturedBytes += kept.length;
  }
  if (buffer.length > remaining) capture.truncated = true;
  return capture.truncated;
}

function captureText(capture) {
  return Buffer.concat(capture.chunks, capture.capturedBytes).toString('utf8');
}

function makeAbortError(reason) {
  const detail = reason instanceof Error ? reason.message : String(reason || 'aborted');
  const error = new Error(`Shell command aborted: ${detail}`, reason instanceof Error ? { cause: reason } : undefined);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function makeTimeoutError(timeoutMs) {
  const error = new Error(`Shell command timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = 'ETIMEDOUT';
  return error;
}

function makeMaxBufferError(maxBuffer) {
  const error = new Error(`Shell command output exceeded maxBuffer (${maxBuffer} bytes)`);
  error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return error;
}

/**
 * Run a shell command with bounded output and real process-tree cancellation.
 *
 * The first three positional arguments retain the historical API. Runtime
 * controls are passed in the fourth argument: signal, stdin, onProcess,
 * maxBuffer, killGraceMs, cwd, shell, and envPolicy.
 */
export function runShellCommand(cmd, timeoutMs = 300_000, env = null, options = {}) {
  if (!cmd || typeof cmd !== 'string') throw new Error('Shell command must be a non-empty string');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('options must be an object');
  }
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 300_000;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  if (!Number.isInteger(maxBuffer) || maxBuffer <= 0) {
    throw new Error('maxBuffer must be a positive integer');
  }
  const signal = options.signal || null;
  if (signal && typeof signal.addEventListener !== 'function') {
    throw new Error('signal must be an AbortSignal');
  }
  const stdin = options.stdin == null
    ? null
    : Buffer.isBuffer(options.stdin)
      ? options.stdin
      : options.stdin instanceof Uint8Array
        ? Buffer.from(options.stdin)
      : typeof options.stdin === 'string'
        ? Buffer.from(options.stdin, 'utf8')
        : null;
  if (options.stdin != null && stdin === null) {
    throw new Error('stdin must be a string, Uint8Array, or null');
  }
  const startedAt = new Date().toISOString();

  if (signal?.aborted) {
    const error = makeAbortError(signal.reason);
    return Promise.resolve({
      stdout: '', stderr: '', exitCode: 1, signal: null, error,
      timedOut: false, aborted: true, maxBufferExceeded: false,
      stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      pid: null, pgid: null, startedAt, finishedAt: new Date().toISOString(),
    });
  }

  return new Promise(resolve => {
    const shell = options.shell || DEFAULT_SHELL;
    const stdout = createCapture(maxBuffer);
    const stderr = createCapture(maxBuffer);
    let child;
    let timer;
    let closeSeen = false;
    let closeCode = null;
    let closeSignal = null;
    let spawnError = null;
    let terminationError = null;
    let terminationKind = null;
    let terminationPromise = null;
    let finalized = false;

    const finish = async () => {
      if (finalized || !closeSeen) return;
      finalized = true;
      if (terminationPromise) {
        try { await terminationPromise; } catch (err) { terminationError ||= err; }
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      let error = spawnError || terminationError;
      if (!error && terminationKind === 'timeout') error = makeTimeoutError(safeTimeout);
      if (!error && terminationKind === 'abort') error = makeAbortError(signal?.reason);
      if (!error && terminationKind === 'maxBuffer') error = makeMaxBufferError(maxBuffer);
      if (!error && (!Number.isInteger(closeCode) || closeCode !== 0 || closeSignal)) {
        error = new Error(closeSignal
          ? `Shell command terminated by ${closeSignal}`
          : `Shell command exited with code ${closeCode}`);
        error.code = Number.isInteger(closeCode) ? closeCode : 1;
        error.signal = closeSignal;
      }

      const result = {
        stdout: captureText(stdout),
        stderr: captureText(stderr),
        exitCode: Number.isInteger(closeCode) ? closeCode : (error ? 1 : 0),
        signal: closeSignal,
        error: error || null,
        timedOut: terminationKind === 'timeout',
        aborted: terminationKind === 'abort',
        maxBufferExceeded: terminationKind === 'maxBuffer',
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        pid: child?.pid || null,
        pgid: process.platform === 'win32' ? null : (child?.pid || null),
        startedAt,
        finishedAt: new Date().toISOString(),
      };

      if (typeof options.onProcessTerminated === 'function') {
        try { await options.onProcessTerminated(result); } catch (err) { result.metadataError = err; }
      }
      resolve(result);
    };

    const beginTermination = (kind, error = null) => {
      if (terminationKind) return;
      terminationKind = kind;
      terminationError = error;
      clearTimeout(timer);
      terminationPromise = terminateProcessTree(child, {
        graceMs: options.killGraceMs,
        pgid: process.platform === 'win32' ? null : child?.pid,
      });
      void terminationPromise.then(
        () => { void finish(); },
        () => { void finish(); },
      );
    };

    const onAbort = () => beginTermination('abort');

    try {
      child = spawn(shell, shellArgs(shell, cmd), {
        cwd: options.cwd,
        env: buildShellEnvironment(env, options.envPolicy || 'inherit'),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      closeSeen = true;
      spawnError = err;
      void finish();
      return;
    }

    child.stdout.on('data', chunk => {
      if (appendCapture(stdout, chunk)) beginTermination('maxBuffer');
    });
    child.stderr.on('data', chunk => {
      if (appendCapture(stderr, chunk)) beginTermination('maxBuffer');
    });
    if (stdin !== null) {
      child.stdin.once('error', err => {
        if (err?.code !== 'EPIPE' && err?.code !== 'ERR_STREAM_DESTROYED') {
          beginTermination('stdin', err);
        }
      });
      child.stdin.end(stdin);
    }
    child.once('error', err => { spawnError = err; });
    child.once('close', (code, childSignal) => {
      closeSeen = true;
      closeCode = code;
      closeSignal = childSignal;
      void finish();
    });

    timer = setTimeout(() => beginTermination('timeout'), safeTimeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (typeof options.onProcess === 'function') {
      try {
        const callbackResult = options.onProcess({
          pid: child.pid,
          pgid: process.platform === 'win32' ? null : child.pid,
          startedAt,
          processIdentity: inspectProcessIdentity(child.pid).identity,
          terminate: reason => beginTermination('abort', reason instanceof Error ? reason : null),
        });
        if (callbackResult && typeof callbackResult.then === 'function') {
          callbackResult.catch(err => beginTermination('abort', err));
        }
      } catch (err) {
        beginTermination('abort', err);
      }
    }
  });
}
