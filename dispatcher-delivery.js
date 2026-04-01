import { sendMessage } from './messages.js';

export function createDeliveryHelpers({ log, resolveDeliveryAlias }) {
  function resolveAlias(target) {
    if (!target) return null;
    return resolveDeliveryAlias(target);
  }

  async function handleDelivery(job, content, opts = {}) {
    if (!['announce', 'announce-always'].includes(job.delivery_mode)) return;
    if (!job.delivery_channel && !job.delivery_to) return;

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

    try {
      const subject = (job.name || '').slice(0, 100);
      const msg = {
        from_agent: 'scheduler',
        to_agent:   'main',
        kind:       'result',
        subject,
        body:       content,
        channel,
        delivery_to: target,
      };
      // Pass image attachment paths so the message consumer can deliver them
      // as photo/file attachments instead of plain text. Scripts signal this
      // by writing [IMAGE:/path/to/file] markers to stdout.
      if (opts.imageAttachments?.length > 0) {
        msg.attachments = opts.imageAttachments;
      }
      sendMessage(msg);
      log('info', `Enqueued: ${job.name}`, { channel, to: target, attachments: opts.imageAttachments?.length || 0 });
    } catch (err) {
      log('error', `Delivery enqueue failed: ${job.name}: ${err.message}`);
    }
  }

  return { handleDelivery };
}
