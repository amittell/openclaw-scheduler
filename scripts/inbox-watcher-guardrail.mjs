#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { getDb } from '../db.js';
import { resolveSchedulerHome } from '../paths.js';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parsePositiveInt(value, fallback, { allowZero = false } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (allowZero ? parsed >= 0 : parsed > 0) return parsed;
  return fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function sqliteTimestampToMs(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function isoNow(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseLaunchctlPrint(text) {
  const readString = (regex) => text.match(regex)?.[1]?.trim() || '';
  const parseNumber = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    exists: true,
    state: readString(/^\s*state\s*=\s*(.+)$/m),
    pid: parseNumber(readString(/^\s*pid\s*=\s*(.+)$/m)),
    runs: parseNumber(readString(/^\s*runs\s*=\s*(.+)$/m)),
    lastExitCode: parseNumber(readString(/^\s*last exit code\s*=\s*(.+)$/m)),
    lastTerminatingSignal: readString(/^\s*last terminating signal\s*=\s*(.+)$/m),
    raw: text,
  };
}

function inspectLaunchctl(label, uid) {
  const service = `gui/${uid}/${label}`;
  try {
    const text = execFileSync('launchctl', ['print', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { service, ...parseLaunchctlPrint(text) };
  } catch (err) {
    return {
      service,
      exists: false,
      state: 'missing',
      pid: null,
      runs: null,
      lastExitCode: null,
      lastTerminatingSignal: '',
      raw: String(err.stdout || ''),
      error: firstNonEmpty(String(err.stderr || '').trim(), err.message),
      exitCode: err.status ?? 1,
    };
  }
}

function inspectPlist(plistPath) {
  if (!existsSync(plistPath)) {
    return {
      exists: false,
      plistPath,
      programArguments: [],
      scriptPath: '',
      scriptExists: false,
      error: 'plist missing',
    };
  }

  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const data = JSON.parse(json);
    const programArguments = Array.isArray(data.ProgramArguments) ? data.ProgramArguments : [];
    const scriptPath = typeof programArguments[1] === 'string' ? programArguments[1] : '';
    return {
      exists: true,
      plistPath,
      programArguments,
      scriptPath,
      scriptExists: scriptPath ? existsSync(scriptPath) : false,
      label: typeof data.Label === 'string' ? data.Label : '',
    };
  } catch (err) {
    return {
      exists: true,
      plistPath,
      programArguments: [],
      scriptPath: '',
      scriptExists: false,
      error: firstNonEmpty(String(err.stderr || '').trim(), err.message),
    };
  }
}

function inspectQueue(db, agentId, nowMs) {
  const row = db.prepare(`
    SELECT COUNT(*) AS pending_count,
           MIN(created_at) AS oldest_created_at,
           MAX(created_at) AS newest_created_at
    FROM messages
    WHERE status = 'pending'
      AND (to_agent = ? OR to_agent = 'broadcast')
  `).get(agentId);

  const pendingCount = row?.pending_count ?? 0;
  const oldestCreatedAt = row?.oldest_created_at || null;
  const newestCreatedAt = row?.newest_created_at || null;
  const oldestMs = sqliteTimestampToMs(oldestCreatedAt);
  const newestMs = sqliteTimestampToMs(newestCreatedAt);

  return {
    pendingCount,
    oldestCreatedAt,
    newestCreatedAt,
    oldestAgeSec: oldestMs ? Math.max(0, Math.floor((nowMs - oldestMs) / 1000)) : 0,
    newestAgeSec: newestMs ? Math.max(0, Math.floor((nowMs - newestMs) / 1000)) : 0,
  };
}

export function evaluateInboxWatcherHealth({
  launchctl,
  plist,
  queue,
  previousObservation = null,
  nowMs = Date.now(),
  ageThresholdSec = 600,
  countThreshold = 10,
  crashLoopWindowSec = 900,
  crashLoopRunsThreshold = 3,
}) {
  const issues = [];

  if (!plist?.exists) {
    issues.push({ code: 'plist_missing', detail: plist?.plistPath || 'LaunchAgent plist missing' });
  } else if (plist?.error) {
    issues.push({ code: 'plist_unreadable', detail: plist.error });
  } else if (!plist?.scriptPath) {
    issues.push({ code: 'plist_script_path_missing', detail: 'ProgramArguments[1] missing' });
  } else if (!plist?.scriptExists) {
    issues.push({ code: 'plist_script_missing', detail: plist.scriptPath });
  }

  if (!launchctl?.exists) {
    issues.push({ code: 'watcher_missing', detail: launchctl?.error || 'launchctl could not find service' });
  } else if (launchctl.state !== 'running' || !launchctl.pid) {
    issues.push({
      code: 'watcher_not_running',
      detail: `state=${launchctl.state || 'unknown'} pid=${launchctl.pid ?? 'none'}`,
    });
  }

  const previousRuns = previousObservation?.launchctl?.runs;
  const previousObservedAtMs = sqliteTimestampToMs(previousObservation?.observedAt) || new Date(previousObservation?.observedAt || '').getTime();
  if (
    launchctl?.exists
    && Number.isInteger(launchctl.runs)
    && Number.isInteger(previousRuns)
    && Number.isFinite(previousObservedAtMs)
  ) {
    const runsDelta = launchctl.runs - previousRuns;
    const ageSec = Math.max(0, Math.floor((nowMs - previousObservedAtMs) / 1000));
    if (runsDelta >= crashLoopRunsThreshold && ageSec <= crashLoopWindowSec) {
      issues.push({ code: 'watcher_crash_loop', detail: `runs+${runsDelta} in ${ageSec}s` });
    }
  }

  if ((queue?.pendingCount || 0) >= countThreshold) {
    issues.push({ code: 'queue_piling', detail: `pending=${queue.pendingCount}` });
  }
  if ((queue?.oldestAgeSec || 0) >= ageThresholdSec) {
    issues.push({ code: 'queue_stale', detail: `oldest=${queue.oldestAgeSec}s` });
  }

  const issueCodes = [...new Set(issues.map(issue => issue.code))];
  const shouldKickstart = launchctl?.exists
    && plist?.scriptExists
    && issueCodes.some(code => ['watcher_not_running', 'watcher_crash_loop', 'queue_piling', 'queue_stale'].includes(code));

  return {
    status: issueCodes.length > 0 ? 'ALERT' : 'OK',
    issues,
    issueCodes,
    shouldKickstart,
  };
}

function summarizeIssueCode(code) {
  switch (code) {
    case 'plist_missing': return 'LaunchAgent plist missing';
    case 'plist_unreadable': return 'LaunchAgent plist unreadable';
    case 'plist_script_path_missing': return 'LaunchAgent ProgramArguments missing script path';
    case 'plist_script_missing': return 'LaunchAgent script path does not exist';
    case 'watcher_missing': return 'launchctl cannot find com.openclaw.inbox-watcher';
    case 'watcher_not_running': return 'inbox watcher is not running';
    case 'watcher_crash_loop': return 'inbox watcher appears to be crash-looping';
    case 'queue_piling': return 'pending inbox queue is piling up';
    case 'queue_stale': return 'pending inbox messages are too old';
    default: return code;
  }
}

function buildAlertMessage({
  finalStatus,
  detectedIssueCodes,
  preSnapshot,
  postSnapshot,
  actionTaken,
  thresholds,
}) {
  const icon = finalStatus === 'ALERT' ? '🚨' : '⚠️';
  const headline = finalStatus === 'ALERT'
    ? `${icon} Inbox watcher delivery path needs attention on rh-bot.`
    : `${icon} Inbox watcher delivery path glitched on rh-bot but auto-recovered.`;

  const issues = detectedIssueCodes.map(summarizeIssueCode).join('; ');
  const preQueue = `pending=${preSnapshot.queue.pendingCount}, oldest=${formatDuration(preSnapshot.queue.oldestAgeSec)}`;
  const postQueue = `pending=${postSnapshot.queue.pendingCount}, oldest=${formatDuration(postSnapshot.queue.oldestAgeSec)}`;
  const watcherState = `state=${postSnapshot.launchctl.state || 'missing'}, pid=${postSnapshot.launchctl.pid ?? 'none'}, runs=${postSnapshot.launchctl.runs ?? 'unknown'}`;
  const kickstart = actionTaken
    ? `Self-heal: launchctl kickstart ${actionTaken.ok ? 'succeeded' : `failed (${actionTaken.error || 'unknown error'})`}.`
    : 'Self-heal: not attempted.';
  const configHint = preSnapshot.plist.scriptExists
    ? ''
    : ` LaunchAgent script path: ${preSnapshot.plist.scriptPath || 'missing'}.`;

  return [
    headline,
    `Detected: ${issues}.`,
    `Queue before check: ${preQueue}. Queue after check: ${postQueue}.`,
    `Watcher after check: ${watcherState}.`,
    kickstart,
    `Triggers: queue oldest >= ${formatDuration(thresholds.ageThresholdSec)} or pending >= ${thresholds.countThreshold}, plus watcher state / crash-loop checks.${configHint}`,
    `Action: launchctl print gui/${process.getuid()}/com.openclaw.inbox-watcher; tail -n 80 ~/.openclaw/logs/inbox-watcher.log; sqlite3 ~/.openclaw/scheduler/scheduler.db "select count(*), min(created_at) from messages where status='pending' and (to_agent='main' or to_agent='broadcast');"`,
  ].join(' ');
}

function decideNotification({ finalStatus, detectedIssueCodes, previousState, nowMs, alertCooldownSec }) {
  if (finalStatus === 'OK') {
    return { notify: false, key: 'OK', suppressed: false };
  }

  const key = `${finalStatus}:${detectedIssueCodes.slice().sort().join(',')}`;
  const lastAlertAtMs = sqliteTimestampToMs(previousState?.lastAlertAt) || new Date(previousState?.lastAlertAt || '').getTime();
  const withinCooldown = Number.isFinite(lastAlertAtMs) && (nowMs - lastAlertAtMs) < (alertCooldownSec * 1000);
  const sameKey = previousState?.lastAlertKey === key;

  if (withinCooldown && sameKey) {
    return { notify: false, key, suppressed: true };
  }
  return { notify: true, key, suppressed: false };
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram send failed (${response.status})`);
  }
  return payload.result;
}

function resolveBotToken(openclawConfigPath) {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const config = loadJson(openclawConfigPath, {});
  return config?.channels?.telegram?.botToken || '';
}

function kickstartWatcher(service) {
  try {
    execFileSync('launchctl', ['kickstart', '-k', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { attempted: true, ok: true, action: 'kickstart' };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      action: 'kickstart',
      error: firstNonEmpty(String(err.stderr || '').trim(), err.message),
      exitCode: err.status ?? 1,
    };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectSnapshot({ label, plistPath, agentId, nowMs }) {
  const db = getDb();
  return {
    observedAt: isoNow(nowMs),
    launchctl: inspectLaunchctl(label, process.getuid()),
    plist: inspectPlist(plistPath),
    queue: inspectQueue(db, agentId, nowMs),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schedulerHome = resolveSchedulerHome(process.env);
  if (!process.env.SCHEDULER_DB) {
    process.env.SCHEDULER_DB = join(schedulerHome, 'scheduler.db');
  }
  const homeDir = firstNonEmpty(process.env.HOME, homedir());
  const openclawConfigPath = join(homeDir, '.openclaw', 'openclaw.json');
  const plistPath = firstNonEmpty(args['plist-path'], join(homeDir, 'Library', 'LaunchAgents', 'com.openclaw.inbox-watcher.plist'));
  const stateFile = firstNonEmpty(args['state-file'], join(schedulerHome, 'state', 'inbox-watcher-guardrail.json'));
  const label = firstNonEmpty(args.label, 'com.openclaw.inbox-watcher');
  const agentId = firstNonEmpty(args.agent, process.env.INBOX_AGENT, 'main');
  const alertTarget = firstNonEmpty(args['alert-target'], process.env.INBOX_GUARDRAIL_ALERT_TARGET, '484946046');
  const ageThresholdSec = parsePositiveInt(args['queue-age-threshold-sec'] || process.env.INBOX_GUARDRAIL_QUEUE_AGE_THRESHOLD_SEC, 600);
  const countThreshold = parsePositiveInt(args['queue-count-threshold'] || process.env.INBOX_GUARDRAIL_QUEUE_COUNT_THRESHOLD, 10);
  const alertCooldownSec = parsePositiveInt(args['alert-cooldown-sec'] || process.env.INBOX_GUARDRAIL_ALERT_COOLDOWN_SEC, 21600);
  const crashLoopWindowSec = parsePositiveInt(args['crash-loop-window-sec'] || process.env.INBOX_GUARDRAIL_CRASH_LOOP_WINDOW_SEC, 900);
  const crashLoopRunsThreshold = parsePositiveInt(args['crash-loop-runs-threshold'] || process.env.INBOX_GUARDRAIL_CRASH_LOOP_RUNS_THRESHOLD, 3);
  const recheckDelayMs = parsePositiveInt(args['recheck-delay-ms'] || process.env.INBOX_GUARDRAIL_RECHECK_DELAY_MS, 5000, { allowZero: true });
  const dryRun = Boolean(args['dry-run']);
  const jsonMode = Boolean(args.json);

  const previousState = loadJson(stateFile, {});
  const nowMs = Date.now();
  const thresholds = { ageThresholdSec, countThreshold, crashLoopWindowSec, crashLoopRunsThreshold };

  const preSnapshot = await collectSnapshot({ label, plistPath, agentId, nowMs });
  const preEval = evaluateInboxWatcherHealth({
    launchctl: preSnapshot.launchctl,
    plist: preSnapshot.plist,
    queue: preSnapshot.queue,
    previousObservation: previousState,
    nowMs,
    ...thresholds,
  });

  let actionTaken = null;
  let postSnapshot = preSnapshot;
  let finalStatus = 'OK';
  let finalEval = preEval;
  let detectedIssueCodes = preEval.issueCodes;

  if (preEval.status === 'ALERT' && preEval.shouldKickstart && !dryRun) {
    actionTaken = kickstartWatcher(preSnapshot.launchctl.service);
    if (recheckDelayMs > 0) await sleep(recheckDelayMs);
    postSnapshot = await collectSnapshot({ label, plistPath, agentId, nowMs: Date.now() });
    finalEval = evaluateInboxWatcherHealth({
      launchctl: postSnapshot.launchctl,
      plist: postSnapshot.plist,
      queue: postSnapshot.queue,
      previousObservation: previousState,
      nowMs: Date.now(),
      ...thresholds,
    });
    detectedIssueCodes = [...new Set([...preEval.issueCodes, ...finalEval.issueCodes])];
    finalStatus = finalEval.status === 'OK' ? 'RECOVERED' : 'ALERT';
  } else if (preEval.status === 'ALERT') {
    finalStatus = 'ALERT';
  }

  const alertDecision = decideNotification({
    finalStatus,
    detectedIssueCodes,
    previousState,
    nowMs: Date.now(),
    alertCooldownSec,
  });

  let alertError = '';
  let alertSent = false;
  if (!dryRun && alertDecision.notify) {
    const botToken = resolveBotToken(openclawConfigPath);
    const text = buildAlertMessage({
      finalStatus,
      detectedIssueCodes,
      preSnapshot,
      postSnapshot,
      actionTaken,
      thresholds,
    });

    if (!botToken) {
      alertError = 'missing telegram bot token';
    } else {
      try {
        await sendTelegramMessage({ botToken, chatId: alertTarget, text });
        alertSent = true;
      } catch (err) {
        alertError = err.message;
      }
    }
  }

  const nextState = {
    observedAt: postSnapshot.observedAt,
    launchctl: {
      state: postSnapshot.launchctl.state,
      pid: postSnapshot.launchctl.pid,
      runs: postSnapshot.launchctl.runs,
      lastExitCode: postSnapshot.launchctl.lastExitCode,
      lastTerminatingSignal: postSnapshot.launchctl.lastTerminatingSignal,
    },
    queue: postSnapshot.queue,
    lastStatus: finalStatus,
    lastIssueCodes: detectedIssueCodes,
    lastAlertAt: alertSent ? isoNow() : previousState.lastAlertAt || null,
    lastAlertKey: alertSent ? alertDecision.key : previousState.lastAlertKey || null,
    lastAlertSent: alertSent,
    lastAlertError: alertError || null,
    lastActionTaken: actionTaken,
  };
  saveJson(stateFile, nextState);

  const result = {
    status: finalStatus,
    pre: preSnapshot,
    post: postSnapshot,
    evaluation: finalEval,
    detectedIssueCodes,
    thresholds,
    actionTaken,
    alert: {
      notify: alertDecision.notify,
      suppressed: alertDecision.suppressed,
      key: alertDecision.key,
      sent: alertSent,
      error: alertError || null,
      target: alertTarget,
    },
    stateFile,
    dryRun,
  };

  const queueSummary = `pending=${postSnapshot.queue.pendingCount} oldest=${formatDuration(postSnapshot.queue.oldestAgeSec)}`;
  const watcherSummary = `state=${postSnapshot.launchctl.state || 'missing'} pid=${postSnapshot.launchctl.pid ?? 'none'} runs=${postSnapshot.launchctl.runs ?? 'unknown'}`;
  process.stdout.write(`STATUS ${finalStatus} | queue ${queueSummary} | watcher ${watcherSummary} | alert ${alertSent ? 'sent' : alertDecision.suppressed ? 'suppressed' : alertDecision.notify ? `failed:${alertError || 'unknown'}` : 'not-needed'}\n`);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  if (finalStatus === 'ALERT') process.exit(1);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
