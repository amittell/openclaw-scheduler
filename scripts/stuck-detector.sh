#!/bin/bash
# Wrapper for stuck-detector that ensures proper PATH
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/alexm"
exec /opt/homebrew/bin/node /Users/alexm/.openclaw/chilisaus/index.mjs stuck --threshold-min 30
