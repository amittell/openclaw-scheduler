#!/usr/bin/env node

import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveSchedulerDbPath } from '../paths.js';

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

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickEnvValue(args, key, env, fallback = '') {
  if (args[key]) return args[key];
  const envName = args[`${key}-env`];
  if (envName) return env[envName] || '';
  return fallback;
}

async function fetchTelegram(endpoint, { botToken, method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram API request failed (${response.status})`);
  }
  return data.result;
}

async function fetchGatewayHealth(gatewayUrl) {
  if (!gatewayUrl) return null;
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, '')}/health`);
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function readRecentTelegramFailures(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE last_error IS NOT NULL
        AND created_at >= datetime('now', '-24 hours')
    `).get();
    return row?.count ?? 0;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function chooseRepairWebhookUrl(webhookInfo, expectedWebhookUrl = '') {
  const currentUrl = webhookInfo?.url || '';
  return firstNonEmpty(currentUrl, expectedWebhookUrl);
}

export function evaluateWebhookHealth({
  label,
  webhookInfo,
  pendingThreshold = 1,
  requireWebhook = true,
  expectedWebhookUrl = '',
  gatewayHealth = null,
  recentTelegramFailures = null,
  botError = null
}) {
  const issues = [];
  const warnings = [];

  if (botError) {
    issues.push(`telegram_api_error=${botError}`);
  }

  if (!botError) {
    if (requireWebhook && !webhookInfo?.url) {
      issues.push('webhook_missing');
    }
    if (expectedWebhookUrl && webhookInfo?.url && webhookInfo.url !== expectedWebhookUrl) {
      issues.push('webhook_url_mismatch');
    }
    if ((webhookInfo?.pending_update_count || 0) >= pendingThreshold && pendingThreshold > 0) {
      issues.push(`pending_update_count=${webhookInfo.pending_update_count}`);
    }
    if (webhookInfo?.last_error_message) {
      issues.push(`last_error_message=${webhookInfo.last_error_message}`);
    }
    if (webhookInfo?.last_error_date) {
      warnings.push(`last_error_date=${webhookInfo.last_error_date}`);
    }
  }

  if (gatewayHealth && gatewayHealth.ok === false) {
    warnings.push(`gateway_unreachable=${gatewayHealth.error || gatewayHealth.status || 'unknown'}`);
  }

  if (typeof recentTelegramFailures === 'number' && recentTelegramFailures > 0) {
    warnings.push(`recent_scheduler_delivery_failures=${recentTelegramFailures}`);
  }

  const status = issues.length > 0 ? 'ALERT' : warnings.length > 0 ? 'WARN' : 'OK';
  const recommendation = issues.some(issue =>
    issue.startsWith('pending_update_count=') || issue.startsWith('last_error_message=')
  )
    ? 'Consider refreshing the webhook with drop_pending_updates=true if the queue appears stuck.'
    : status === 'OK'
      ? 'No action required.'
      : 'Inspect current webhook and gateway state before taking action.';

  return {
    label,
    status,
    issues,
    warnings,
    recommendation,
    webhook: webhookInfo ? {
      url: webhookInfo.url || '',
      has_custom_certificate: Boolean(webhookInfo.has_custom_certificate),
      pending_update_count: webhookInfo.pending_update_count || 0,
      last_error_date: webhookInfo.last_error_date || null,
      last_error_message: webhookInfo.last_error_message || null,
      max_connections: webhookInfo.max_connections ?? null,
      ip_address: webhookInfo.ip_address || null
    } : null,
    gateway: gatewayHealth,
    recent_scheduler_delivery_failures: recentTelegramFailures
  };
}

function printResult(result) {
  const issueSummary = result.issues?.length ? ` issues=${result.issues.join(',')}` : '';
  const warningSummary = result.warnings?.length ? ` warnings=${result.warnings.join(',')}` : '';
  process.stdout.write(`STATUS: ${result.status} bot=${result.label}${issueSummary}${warningSummary}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || 'telegram-bot';
  const botToken = firstNonEmpty(
    pickEnvValue(args, 'bot-token', process.env),
    process.env.TELEGRAM_BOT_TOKEN
  );

  if (!botToken) {
    process.stderr.write('[telegram-webhook-check] missing bot token; pass --bot-token, --bot-token-env, or TELEGRAM_BOT_TOKEN\n');
    process.exit(2);
  }

  const gatewayUrl = firstNonEmpty(args['gateway-url'], process.env.OPENCLAW_GATEWAY_URL);
  const expectedWebhookUrl = firstNonEmpty(
    pickEnvValue(args, 'expected-webhook-url', process.env),
    process.env.TELEGRAM_WEBHOOK_URL
  );
  const schedulerDb = firstNonEmpty(args['scheduler-db'], resolveSchedulerDbPath({ env: process.env }));
  const pendingThreshold = parsePositiveInt(args['pending-threshold'], 1);
  const requireWebhook = args['require-webhook'] !== 'false';

  if (args.repair === 'drop-pending') {
    const webhookInfo = await fetchTelegram('getWebhookInfo', { botToken });
    const repairUrl = chooseRepairWebhookUrl(webhookInfo, expectedWebhookUrl);
    if (!repairUrl) {
      process.stderr.write('[telegram-webhook-check] cannot repair webhook queue without a current or expected webhook URL\n');
      process.exit(2);
    }
    const repaired = await fetchTelegram('setWebhook', {
      botToken,
      method: 'POST',
      body: {
        url: repairUrl,
        drop_pending_updates: true
      }
    });
    printResult({
      label,
      status: 'REPAIRED',
      issues: [],
      warnings: [],
      action: 'drop-pending',
      webhook_url: repairUrl,
      telegram_response: repaired
    });
    return;
  }

  let webhookInfo = null;
  let botError = null;
  try {
    webhookInfo = await fetchTelegram('getWebhookInfo', { botToken });
  } catch (err) {
    botError = err.message;
  }

  const gatewayHealth = await fetchGatewayHealth(gatewayUrl);
  const recentFailures = readRecentTelegramFailures(schedulerDb);
  const result = evaluateWebhookHealth({
    label,
    webhookInfo,
    pendingThreshold,
    requireWebhook,
    expectedWebhookUrl,
    gatewayHealth,
    recentTelegramFailures: recentFailures,
    botError
  });
  printResult(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
