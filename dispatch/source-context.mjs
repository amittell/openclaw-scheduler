const SOURCE_CONTEXT_KEYS = new Set(['channel', 'target', 'messageId', 'threadId']);
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function identifier(value, name, { required = true, maxLength = 256 } = {}) {
  if (value == null) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${name} numeric values must be safe integers; use a JSON string for larger IDs`);
    }
    value = String(value);
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string identifier`);

  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  if (/\s/u.test(normalized)) throw new Error(`${name} must not contain whitespace`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${name} must not contain control characters`);
  return normalized;
}

export function normalizeRoute(channel, target, label = 'route') {
  const normalizedChannel = identifier(channel, `${label}.channel`, { maxLength: 64 }).toLowerCase();
  if (!CHANNEL_PATTERN.test(normalizedChannel)) {
    throw new Error(`${label}.channel must use lowercase letters, numbers, dot, underscore, or hyphen`);
  }
  return {
    channel: normalizedChannel,
    target: identifier(target, `${label}.target`),
  };
}

export function parseSourceContext(value, label = '--source-context') {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} must be valid JSON: ${error.message}`, { cause: error });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const unknownKeys = Object.keys(parsed).filter(key => !SOURCE_CONTEXT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} contains unsupported field(s): ${unknownKeys.join(', ')}; ` +
      'only channel, target, messageId, and threadId identifiers are allowed',
    );
  }

  const route = normalizeRoute(parsed.channel, parsed.target, label);
  return {
    ...route,
    messageId: identifier(parsed.messageId, `${label}.messageId`),
    threadId: identifier(parsed.threadId, `${label}.threadId`, { required: false }),
  };
}

export function parseOriginRoute(origin, label = '--origin') {
  if (origin == null) return null;
  const value = identifier(origin, label);
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return normalizeRoute(value.slice(0, separator), value.slice(separator + 1), label);
}

export function sourceContextToOrigin(sourceContext) {
  const source = parseSourceContext(sourceContext, 'sourceContext');
  return `${source.channel}:${source.target}`;
}

export function sourceContextToSchedulerFields(sourceContext) {
  if (!sourceContext) {
    return {
      source_channel: null,
      source_target: null,
      source_message_id: null,
      source_thread_id: null,
    };
  }
  const source = parseSourceContext(sourceContext, 'sourceContext');
  return {
    source_channel: source.channel,
    source_target: source.target,
    source_message_id: source.messageId,
    source_thread_id: source.threadId,
  };
}

export function assertRouteMatchesSource(sourceContext, channel, target, label = 'delivery route') {
  const source = parseSourceContext(sourceContext, 'sourceContext');
  const route = normalizeRoute(channel, target, label);
  if (route.channel !== source.channel || route.target !== source.target) {
    throw new Error(
      `${label} ${route.channel}:${route.target} does not match authoritative source ` +
      `${source.channel}:${source.target}`,
    );
  }
  return route;
}

export function sameSourceContext(left, right) {
  const a = parseSourceContext(left, 'left sourceContext');
  const b = parseSourceContext(right, 'right sourceContext');
  return a.channel === b.channel
    && a.target === b.target
    && a.messageId === b.messageId
    && a.threadId === b.threadId;
}
