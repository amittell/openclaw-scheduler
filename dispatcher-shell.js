import { exec as execCb } from 'child_process';

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

export function runShellCommand(cmd, timeoutMs = 300000) {
  if (!cmd || typeof cmd !== 'string') throw new Error('Shell command must be a non-empty string');
  const safeTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : 300_000;
  return new Promise((resolve) => {
    execCb(cmd, { timeout: safeTimeout, maxBuffer: 1024 * 1024, shell: DEFAULT_SHELL }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: Number.isInteger(err?.code) ? err.code : (err ? 1 : 0),
        signal: err?.signal || null,
        error: err || null,
      });
    });
  });
}
