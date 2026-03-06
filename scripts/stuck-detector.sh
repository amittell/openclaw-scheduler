#!/bin/bash
# Wrapper for stuck-detector that ensures proper PATH
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
DISPATCH_CLI_CANDIDATE="${DISPATCH_CLI:-$OPENCLAW_HOME/dispatch/index.mjs}"
LEGACY_CLI_CANDIDATE="${CHILISAUS_CLI:-$OPENCLAW_HOME/chilisaus/index.mjs}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
THRESHOLD_MIN="${STUCK_THRESHOLD_MIN:-30}"

if [ -f "$DISPATCH_CLI_CANDIDATE" ]; then
  CLI_PATH="$DISPATCH_CLI_CANDIDATE"
elif [ -f "$LEGACY_CLI_CANDIDATE" ]; then
  CLI_PATH="$LEGACY_CLI_CANDIDATE"
else
  echo "[stuck-detector] dispatch CLI not found (checked: $DISPATCH_CLI_CANDIDATE, $LEGACY_CLI_CANDIDATE)" >&2
  exit 1
fi

exec "$NODE_BIN" "$CLI_PATH" stuck --threshold-min "$THRESHOLD_MIN"
