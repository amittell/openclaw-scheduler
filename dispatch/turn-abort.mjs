/**
 * Shared turn-abort detection for OpenClaw session transcripts.
 *
 * Both dispatch/watcher.mjs (stall vs. abort classification) and
 * dispatch/index.mjs (status/sync auto-resolution) read the session
 * transcript tail and must agree on what counts as a turn abort. Keeping the
 * detector in one place ensures the provider-abort signature (assistant
 * stopReason="aborted" / openclaw:prompt-error "This operation was aborted")
 * is recognized on every path, so a direct `status` poll reports the
 * interruption immediately instead of waiting for the watcher's idle probe.
 *
 * Regression context: the 2026-06-27 fleet-wide kebab-rtx6000/qwen3.6-27b
 * provider-abort incident. Surviving worker transcripts end with a successful
 * tool write, then an assistant entry with content=[] / stopReason="aborted" /
 * errorMessage="Request was aborted", plus an openclaw:prompt-error custom
 * entry "This operation was aborted".
 */

export function contentHasTurnAbortMarker(content) {
  if (!content) return false;
  if (typeof content === 'string') return content.includes('<turn_aborted>');
  if (!Array.isArray(content)) return false;
  return content.some(part => {
    const text = part?.text || part?.input_text || part?.content || '';
    return typeof text === 'string' && text.includes('<turn_aborted>');
  });
}

export function entryRole(entry) {
  return entry?.role
    || entry?.message?.role
    || entry?.payload?.role
    || entry?.payload?.message?.role
    || null;
}

export function entryHasProviderAbort(entry) {
  if (!entry || typeof entry !== 'object') return false;

  // (1) Assistant entry that ended with stopReason/stop_reason === "aborted":
  //     the provider aborted the in-flight model request (e.g. the fleet-wide
  //     kebab-rtx6000/qwen3.6-27b outage on 2026-06-27). Such an entry
  //     typically has empty content and an errorMessage like "Request was
  //     aborted". Recognizing it as a turn abort routes the session to the
  //     interrupted (redispatchable) path instead of the stall path.
  const role = entryRole(entry);
  if (role === 'assistant') {
    const stopReason = entry?.stopReason ?? entry?.stop_reason
      ?? entry?.message?.stopReason ?? entry?.message?.stop_reason
      ?? entry?.payload?.stopReason ?? entry?.payload?.stop_reason
      ?? entry?.payload?.message?.stopReason ?? entry?.payload?.message?.stop_reason
      ?? null;
    if (stopReason === 'aborted') return true;
  }

  // (2) openclaw:prompt-error custom entry carrying the abort message ("This
  //     operation was aborted"). OpenClaw persists this right after a provider
  //     abort so the transcript tail is unambiguous.
  const isPromptError = entry?.customType === 'openclaw:prompt-error'
    || entry?.type === 'openclaw:prompt-error'
    || entry?.payload?.type === 'openclaw:prompt-error'
    || entry?.payload?.customType === 'openclaw:prompt-error';
  if (isPromptError) {
    const errMsg = entry?.data?.error
      ?? entry?.error
      ?? entry?.payload?.data?.error
      ?? entry?.payload?.error
      ?? '';
    if (typeof errMsg === 'string' && /operation was aborted|was aborted/i.test(errMsg)) {
      return true;
    }
  }

  return false;
}

export function entryHasTurnAborted(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'turn_aborted') return true;
  if (entry.payload?.type === 'turn_aborted') return true;
  if (entryHasProviderAbort(entry)) return true;

  const role = entryRole(entry);
  if (role !== 'user') return false;
  return contentHasTurnAbortMarker(entry.content)
    || contentHasTurnAbortMarker(entry.message?.content)
    || contentHasTurnAbortMarker(entry.payload?.content)
    || contentHasTurnAbortMarker(entry.payload?.message?.content);
}

export function entryStartsPostAbortActivity(entry) {
  if (!entry || typeof entry !== 'object' || entryHasTurnAborted(entry)) return false;
  const role = entryRole(entry);
  if (role === 'assistant' || role === 'user') return true;

  const payloadType = entry.payload?.type || null;
  return entry.type === 'response_item' && [
    'message',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
  ].includes(payloadType);
}

export function getJsonlTurnAbortReason(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entryHasTurnAborted(entry)) {
      const reason = entry?.payload?.reason || entry?.reason || 'interrupted';
      return `turn_aborted observed in session JSONL (${reason})`;
    }
    if (entryStartsPostAbortActivity(entry)) return null;
  }

  return null;
}
