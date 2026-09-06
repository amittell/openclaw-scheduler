import { enqueueDelivery, enqueueMultipartDelivery } from './delivery-outbox.js';

/** Failure alerts require an operator-selected Telegram chat, never a default. */
export function createTransientFailureAlertHandler({ target, deliverMessageFn }) {
  const normalized = typeof target === 'string' ? target.trim() : '';
  const valid = /^-?[1-9]\d*$/.test(normalized)
    && Number.isSafeInteger(Number(normalized));
  return async ({ jobName, runId, errorMessage, consecutiveErrors }) => {
    if (!valid) return { sent: false, reason: normalized ? 'invalid_operator_target' : 'operator_target_unconfigured' };
    const text = [
      `\u26a0\ufe0f Scheduled job failing repeatedly: ${jobName}`,
      `Consecutive failures: ${consecutiveErrors}`,
      `Run: ${runId}`,
      errorMessage ? `Last error: ${errorMessage}` : null,
    ].filter(Boolean).join('\n');
    await deliverMessageFn('telegram', normalized, text);
    return { sent: true };
  };
}

export function createDeliveryHelpers({
  log,
  resolveDeliveryAlias,
  enqueueDeliveryFn = enqueueDelivery,
  enqueueMultipartDeliveryFn = null,
}) {
  function resolveAlias(target) {
    if (!target) return null;
    return resolveDeliveryAlias(target);
  }

  /**
   * A target that is only digits or a leading-minus integer (optionally with
   * spaces) is a bare chat id on Telegram: Telegram user and group ids are
   * signed integers (groups/supergroups start with '-100' / '-5', DMs are
   * plain numbers), and on this deployment Telegram is the only message
   * channel the scheduler delivers to. When the channel column was left
   * empty (NULL) at job-creation time, the target still identifies a unique
   * route, so resolving the channel here is safe and preserves the
   * operator-configured target. Non-numeric targets (aliases, usernames,
   * prefixed strings that already carry their own channel) must not be
   * touched: a prefix like 'discord:123' is resolved by the prefixed-target
   * branch below, and a bare alias resolves through resolveAlias first.
   */
  const isBareNumericTarget = (value) => /^[+-]?\d[\d\s]*$/.test(String(value ?? '').trim());

  function normalizeRoute(channel, target) {
    let normalizedChannel = typeof channel === 'string' ? channel.trim() : '';
    let normalizedTarget = typeof target === 'string' ? target.trim() : '';
    if (!normalizedChannel && normalizedTarget) {
      const prefixed = normalizedTarget.match(/^([a-z0-9_-]+)[:/](.+)$/i);
      if (prefixed) {
        normalizedChannel = prefixed[1];
        normalizedTarget = prefixed[2];
      }
    }
    if (normalizedChannel && normalizedTarget.startsWith(`${normalizedChannel}:`)) {
      normalizedTarget = normalizedTarget.slice(normalizedChannel.length + 1);
    } else if (normalizedChannel && normalizedTarget.startsWith(`${normalizedChannel}/`)) {
      normalizedTarget = normalizedTarget.slice(normalizedChannel.length + 1);
    }
    return { channel: normalizedChannel, target: normalizedTarget };
  }

  function handleDelivery(job, content, opts = {}) {
    if (!['announce', 'announce-always'].includes(job.delivery_mode)) return null;
    if (!job.delivery_channel && !job.delivery_to) return null;

    let channel = job.delivery_channel;
    let target = job.delivery_to;

    if (target) {
      const resolved = resolveAlias(target);
      if (resolved) {
        channel = resolved.channel;
        target = resolved.target;
        log('info', `Resolved alias '${job.delivery_to}' -> ${channel}/${target}`);
      }
    }

    ({ channel, target } = normalizeRoute(channel, target));
    if (!channel && target && isBareNumericTarget(target)) {
      channel = 'telegram';
      log('info', `Delivery channel auto-resolved to telegram for ${job.name || job.id || 'job'}`, { to: target });
    }
    if (!channel && !target) {
      // Fully unrouted (no channel, no target): nothing to deliver. Announce
      // jobs with no configured route are a no-op, matching the pre-existing
      // behavior -- a hard failure is reserved for partially-routed jobs whose
      // target cannot be resolved.
      return null;
    }
    if (!channel || !target) {
      log('error', `Delivery route is incomplete: ${job.name || job.id || 'job'}`, { channel: channel || null, to: target || null });
      throw new Error(`Delivery route for '${job.name || job.id || 'job'}' requires both channel and target`);
    }

    try {
      const idempotencyKey = opts.idempotencyKey
        || (opts.runId ? `run:${opts.runId}:delivery:${channel}:${target}` : null)
        || (opts.eventId ? `event:${opts.eventId}:delivery:${channel}:${target}` : null);
      const attachments = opts.imageAttachments || opts.attachments || [];
      const multipartEnqueue = enqueueMultipartDeliveryFn
        || (enqueueDeliveryFn === enqueueDelivery ? enqueueMultipartDelivery : null);
      const delivery = (attachments.length === 0 && multipartEnqueue
        ? multipartEnqueue
        : enqueueDeliveryFn)({
        db: opts.db,
        messageId: opts.messageId || null,
        jobId: job.id || null,
        runId: opts.runId || null,
        channel,
        target,
        body: String(content ?? ''),
        attachments,
        idempotencyKey,
        maxAttempts: opts.maxAttempts,
      });
      log('info', `Delivery enqueued: ${job.name}`, {
        deliveryId: delivery.id,
        deduped: delivery.deduped,
        channel,
        to: target,
        attachments: delivery.attachments?.length || 0,
        parts: delivery.partCount || 1,
      });
      return delivery;
    } catch (err) {
      log('error', `Delivery enqueue failed: ${job.name}: ${err.message}`);
      throw err;
    }
  }

  return { handleDelivery };
}
