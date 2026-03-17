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
NODE_BIN="${NODE_BIN:-$(command -v node)}"

# Resolution order:
#  1) openclaw-scheduler bin (preferred, if in PATH)
#  2) DISPATCH_CLI env override
#  3) dispatch/index.mjs directly

CLI_PATH=""
USE_BIN=false

if command -v openclaw-scheduler >/dev/null 2>&1; then
  USE_BIN=true
elif [ -n "${DISPATCH_CLI:-}" ] && [ -f "$DISPATCH_CLI" ]; then
  CLI_PATH="$DISPATCH_CLI"
elif [ -f "$OPENCLAW_HOME/scheduler/dispatch/index.mjs" ]; then
  CLI_PATH="$OPENCLAW_HOME/scheduler/dispatch/index.mjs"
else
  echo "[deliver-watcher] dispatch CLI not found" >&2
  exit 1
fi

run_dispatch() {
  if [ "$USE_BIN" = true ]; then
    openclaw-scheduler "$@"
  else
    "$NODE_BIN" "$CLI_PATH" "$@"
  fi
}

# Check if the agent produced a reply (direct check, no idle threshold)
RESULT_JSON=$(run_dispatch result --label "$LABEL" 2>/dev/null || echo '{}')
REPLY=$(echo "$RESULT_JSON" | python3 -c "
import sys, json
r = json.load(sys.stdin)
text = r.get('lastReply') or r.get('summary') or ''
print(text.strip()[:3000])
" 2>/dev/null || echo "")

if [ -n "$REPLY" ]; then
  # Mark as done in labels.json (best-effort)
  run_dispatch status --label "$LABEL" >/dev/null 2>&1 || true
  echo "✅ $LABEL: $REPLY"
  exit 0
fi

# No reply yet — retry later
exit 1
