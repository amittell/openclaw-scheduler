#!/bin/bash
# Wrapper for stuck-run-detector.mjs that ensures proper PATH

# Ensure common Node.js install locations are in PATH
case "$(uname -s)" in
  Darwin) export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" ;;
  *)      export PATH="/usr/local/bin:$PATH" ;;
esac

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null)}"
if [ -z "$NODE_BIN" ]; then
  echo "[stuck-detector] node not found in PATH" >&2
  exit 1
fi
THRESHOLD_MIN="${STUCK_THRESHOLD_MIN:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec "$NODE_BIN" "$SCRIPT_DIR/stuck-run-detector.mjs" --threshold-min "$THRESHOLD_MIN"
