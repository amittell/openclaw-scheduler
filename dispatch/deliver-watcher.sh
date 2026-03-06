#!/bin/bash
# deliver-watcher.sh — Poll dispatch session for a result; exit 0 when done (triggers scheduler delivery)
# Called by scheduler as a one-shot shell job. Exits non-zero while no result available,
# causing the scheduler to retry on the next cron tick. On completion, outputs the result
# and exits 0 — scheduler delivers the output and self-deletes the job.
#
# Usage: deliver-watcher.sh <label>

set -euo pipefail
LABEL="${1:?Usage: deliver-watcher.sh <label>}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
DISPATCH_CLI_CANDIDATE="${DISPATCH_CLI:-$OPENCLAW_HOME/dispatch/index.mjs}"
LEGACY_CLI_CANDIDATE="${CHILISAUS_CLI:-$OPENCLAW_HOME/chilisaus/index.mjs}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -f "$DISPATCH_CLI_CANDIDATE" ]; then
  CLI_PATH="$DISPATCH_CLI_CANDIDATE"
elif [ -f "$LEGACY_CLI_CANDIDATE" ]; then
  CLI_PATH="$LEGACY_CLI_CANDIDATE"
else
  echo "[deliver-watcher] dispatch CLI not found (checked: $DISPATCH_CLI_CANDIDATE, $LEGACY_CLI_CANDIDATE)" >&2
  exit 1
fi

# Check if the agent produced a reply (direct check, no idle threshold)
RESULT_JSON=$("$NODE_BIN" "$CLI_PATH" result --label "$LABEL" 2>/dev/null || echo '{}')
REPLY=$(echo "$RESULT_JSON" | python3 -c "
import sys, json
r = json.load(sys.stdin)
text = r.get('lastReply') or r.get('summary') or ''
print(text.strip()[:3000])
" 2>/dev/null || echo "")

if [ -n "$REPLY" ]; then
  # Mark as done in labels.json (best-effort)
  "$NODE_BIN" "$CLI_PATH" status --label "$LABEL" >/dev/null 2>&1 || true
  echo "✅ $LABEL: $REPLY"
  exit 0
fi

# No reply yet — retry later
exit 1
