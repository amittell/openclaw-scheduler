#!/usr/bin/env bash
# Install the tracked scheduler pre-push hook from a main or linked worktree.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(git rev-parse --git-common-dir)"
HOOKS_DIR="$(cd "$COMMON_DIR" && pwd)/hooks"
SOURCE="$REPO_ROOT/scripts/git-hooks/pre-push.mjs"
DESTINATION="$HOOKS_DIR/pre-push"

if git config --get core.hooksPath >/dev/null; then
    echo "core.hooksPath is configured; review that location before installing common hooks." >&2
    exit 1
fi
if [[ ! -f "$SOURCE" || ! -x "$SOURCE" || -L "$SOURCE" ]]; then
    echo "Tracked pre-push hook must be a regular executable file: $SOURCE" >&2
    exit 1
fi
if [[ -L "$HOOKS_DIR" || ( -e "$HOOKS_DIR" && ! -d "$HOOKS_DIR" ) ]]; then
    echo "Refusing a symlink or non-directory hooks location: $HOOKS_DIR" >&2
    exit 1
fi
if [[ -d "$DESTINATION" || ( -e "$DESTINATION" && ! -f "$DESTINATION" && ! -L "$DESTINATION" ) ]]; then
    echo "Refusing to replace a non-file hook: $DESTINATION" >&2
    exit 1
fi

# A shared hook must survive removal of the worktree that installed it.
WRAPPER=$(cat <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
hook="$repo_root/scripts/git-hooks/pre-push.mjs"
if [[ ! -f "$hook" || ! -x "$hook" || -L "$hook" ]]; then
    echo "Required tracked pre-push hook is missing or not a regular executable: $hook" >&2
    exit 1
fi
exec "$hook" "$@"
HOOK
)

mkdir -p "$HOOKS_DIR"
if [[ -f "$DESTINATION" && ! -L "$DESTINATION" && -x "$DESTINATION" ]] \
    && cmp -s "$DESTINATION" <(printf '%s\n' "$WRAPPER"); then
    echo "Unchanged: pre-push"
    exit 0
fi

if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
    backup="$DESTINATION.before-openclaw-scheduler"
    suffix=0
    while [[ -e "$backup" || -L "$backup" ]]; do
        suffix=$((suffix + 1))
        backup="$DESTINATION.before-openclaw-scheduler.$suffix"
    done
    cp -pP "$DESTINATION" "$backup"
    echo "Preserved: $backup"
fi

TEMP_HOOK=""
trap 'if [[ -n "$TEMP_HOOK" ]]; then rm -f "$TEMP_HOOK"; fi' EXIT
# Same-directory staging keeps replacement atomic across TMPDIR filesystems.
TEMP_HOOK="$(mktemp "$HOOKS_DIR/.pre-push.XXXXXX")"
printf '%s\n' "$WRAPPER" > "$TEMP_HOOK"
chmod 755 "$TEMP_HOOK"
mv -f "$TEMP_HOOK" "$DESTINATION"
TEMP_HOOK=""
echo "Installed: pre-push (active-worktree wrapper)"
echo "Checks: native WritHub reservations, scripts/ci-gate.sh, npm run verify:smoke"
