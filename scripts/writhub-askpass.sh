#!/bin/sh
set -eu

# The workflow validates these values. Git destination operations enable
# credential.useHttpPath and LC_ALL=C so prompts identify the complete route.
case "${1:-}" in
  "Username for 'https://writhub.io/${WRITHUB_REPOSITORY}.git': ")
    printf '%s\n' "$WRITHUB_USERNAME" ;;
  "Password for 'https://${WRITHUB_USERNAME}@writhub.io/${WRITHUB_REPOSITORY}.git': ")
    printf '%s\n' "$WRITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
