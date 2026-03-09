export function createDeliveryHelpers({ log, deliverMessage, resolveDeliveryAlias }) {
  function resolveAlias(target) {
    if (!target) return null;
    return resolveDeliveryAlias(target);
  }

  async function handleDelivery(job, content) {
    if (!['announce', 'announce-always'].includes(job.delivery_mode)) return;
    if (!job.delivery_channel && !job.delivery_to) return;

    let channel = job.delivery_channel;
    let target = job.delivery_to;

    if (target) {
      const resolved = resolveAlias(target);
      if (resolved) {
        channel = resolved.channel;
        target = resolved.target;
        log('info', `Resolved alias '${job.delivery_to}' → ${channel}/${target}`);
      }
    }

    try {
      await deliverMessage(channel, target, content);
      log('info', `Delivered: ${job.name}`, { channel, to: target });
    } catch (err) {
      log('error', `Delivery failed: ${job.name}: ${err.message}`);
    }
  }

  return { resolveAlias, handleDelivery };
}
