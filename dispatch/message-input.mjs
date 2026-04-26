import { readFileSync } from 'fs';
import { isatty } from 'node:tty';

function normalizeFlagValue(value, flagName) {
  if (value === undefined || value === null) return null;
  if (value === true) throw new Error(`${flagName} requires a value`);
  return String(value);
}

export async function resolveMessageInput({
  message = null,
  messageFile = null,
  messageEnv = null,
  messageStdin = false,
  stdinIsTTY = isatty(0),
  env = process.env,
  readFile = (path) => readFileSync(path, 'utf8'),
  readStdin = () => readFileSync(0, 'utf8'),
} = {}) {
  const directMessage = normalizeFlagValue(message, '--message');
  const filePath = normalizeFlagValue(messageFile, '--message-file');
  const envVar = normalizeFlagValue(messageEnv, '--message-env');
  const wantsStdin = messageStdin === true || messageStdin === 'true';

  const explicitSources = [];
  if (directMessage !== null) explicitSources.push('--message');
  if (filePath !== null) explicitSources.push('--message-file');
  if (envVar !== null) explicitSources.push('--message-env');
  if (wantsStdin) explicitSources.push('--message-stdin');

  if (explicitSources.length > 1) {
    throw new Error(`choose only one of ${explicitSources.join(', ')} for the prompt source`);
  }

  if (directMessage !== null) return directMessage;

  if (filePath !== null) {
    if (filePath === '-') {
      if (stdinIsTTY === true) throw new Error('--message-file - requires piped stdin');
      return readStdin();
    }
    try {
      return readFile(filePath);
    } catch (err) {
      throw new Error(`--message-file: could not read file: ${err.message}`, { cause: err });
    }
  }

  if (envVar !== null) {
    if (!Object.prototype.hasOwnProperty.call(env, envVar)) {
      throw new Error(`--message-env: environment variable ${envVar} is not set`);
    }
    return String(env[envVar] ?? '');
  }

  if (wantsStdin) {
    if (stdinIsTTY === true) throw new Error('--message-stdin requires piped stdin');
    return readStdin();
  }

  if (stdinIsTTY !== true) {
    const pipedText = readStdin();
    return pipedText.length > 0 ? pipedText : null;
  }

  return null;
}
