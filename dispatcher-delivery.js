import { enqueueDelivery, enqueueMultipartDelivery } from './delivery-outbox.js';

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
    if (!channel || !target) {
      log('error', `Delivery route is incomplete: ${job.name}`, { channel: channel || null, to: target || null });
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
