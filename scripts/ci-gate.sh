#!/usr/bin/env bash
#
# openclaw-scheduler repository gate.
#
# RUNNING THIS SCRIPT BY HAND IS THE GATE. `.writhub/workflows/ci.yml` checks
# the tree out and runs this file and nothing else, so `bash scripts/ci-gate.sh`
# on a laptop reproduces the WritHub checks-lane verdict exactly.
#
# It is deliberately restricted to what the WritHub checks-lane container can
# actually do: system `node` and `bash` only -- no `npm ci`, no node_modules,
# no network egress, no `actions/setup-node`. That lane runs jobs with
# `--cap-drop=ALL --security-opt=no-new-privileges`, which is why the tool-cache
# `tar -x` inside `actions/setup-node` cannot chown and dies (writhub #2068),
# and this package's `better-sqlite3` native dependency cannot be installed
# there at all.
#
# WHAT THIS GATE DOES NOT COVER, and where that coverage still runs: the real
# test suite (`npm test`), `npm run lint`, `npm run typecheck`, the agentcli
# contract jobs and the packaging jobs all need node_modules. They are
# UNCHANGED and still run in full on GitHub Actions via
# `.github/workflows/ci.yml` (2 OS x 4 Node versions). Nothing was deleted to
# make CI green.
#
# Every section reports how many inputs it examined, because a gate that
# silently examines nothing is indistinguishable from a gate that passed.
# Section 0 exists because that failure mode was MEASURED here, not imagined:
# plain `node --check <file>` returns 0 for an ES module with a real syntax
# error, so the obvious spelling of section 2 would have passed every broken
# file forever.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
FAILURES=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

section() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# Parse an ES module and report only whether it is syntactically valid.
#
# `node --check <path>` is NOT usable for this: when the file's first statement
# is an `import`, node detects module syntax and exits 0 even when the rest of
# the file is unparseable. Feeding the source on stdin with an explicit
# `--input-type=module` is the spelling that actually rejects. Section 0 proves
# that on every run.
esm_syntax_ok() { node --input-type=module --check < "$1" >/dev/null 2>&1; }

# Source files this gate owns: repository JavaScript, excluding anything
# installed or generated.
list_sources() {
  find . \
    -path ./node_modules -prune -o \
    -path ./.git -prune -o \
    -path ./coverage -prune -o \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print
}

# Node helpers are written as `.cjs` so they parse as CommonJS regardless of
# this package's `"type": "module"`; a heredoc piped to `node -` would be
# subject to module detection instead.

# ---------------------------------------------------------------------------
section "0. environment and instrument self-test"

printf 'bash    %s\n' "${BASH_VERSION:-unknown}"
printf 'node    %s\n' "$(node --version)"
printf 'cwd     %s\n' "$ROOT"

printf '#!/usr/bin/env node\nimport fs from "node:fs";\nexport const ok = 1;\n' \
  > "$WORK/control-good.js"
printf '#!/usr/bin/env node\nimport fs from "node:fs";\nconst broken = ;\n' \
  > "$WORK/control-bad.js"

if ! esm_syntax_ok "$WORK/control-good.js"; then
  printf 'INSTRUMENT BROKEN: the syntax checker rejects a valid module.\n'
  exit 2
fi
if esm_syntax_ok "$WORK/control-bad.js"; then
  printf 'INSTRUMENT BROKEN: the syntax checker ACCEPTS a module with a syntax\n'
  printf 'error, so section 2 would pass every file regardless of content.\n'
  exit 2
fi
printf 'syntax checker rejects bad and accepts good -- instrument verified\n'

# ---------------------------------------------------------------------------
section "1. node satisfies package.json engines"

cat > "$WORK/engines.cjs" <<'NODE'
const { readFileSync } = require('node:fs');
const pkg = JSON.parse(readFileSync(process.argv[2] + '/package.json', 'utf8'));
const declared = (pkg.engines && pkg.engines.node) || '';
if (!declared) {
  console.error('FAIL: package.json declares no engines.node');
  process.exit(1);
}
// engines.node here is a `||`-separated list of `NN.x` majors. A running major
// outside it is a lane/image mismatch that must be loud, not silently tested on
// an unsupported runtime.
const majors = declared.split('||').map((s) => s.trim().replace(/\.x$/, ''));
const running = String(process.versions.node).split('.')[0];
console.log(`engines.node  = ${declared}`);
console.log(`running major = ${running}`);
if (!majors.includes(running)) {
  console.error(`FAIL: node ${process.versions.node} is not covered by ${declared}`);
  process.exit(1);
}
NODE
if ! node "$WORK/engines.cjs" "$ROOT"; then
  fail "the running node is not one this package declares support for"
fi

# ---------------------------------------------------------------------------
section "2. every JavaScript source parses as an ES module"

list_sources > "$WORK/sources.txt"
SOURCE_COUNT=$(grep -c . "$WORK/sources.txt" || true)
if [ "${SOURCE_COUNT:-0}" -eq 0 ]; then
  fail "found 0 JavaScript sources -- the file discovery is broken, not the tree"
fi
SYNTAX_BAD=0
while IFS= read -r src; do
  [ -n "$src" ] || continue
  if ! esm_syntax_ok "$src"; then
    fail "syntax error: $src"
    node --input-type=module --check < "$src" 2>&1 | sed -n '1,6p' | sed 's/^/    /' || true
    SYNTAX_BAD=$((SYNTAX_BAD + 1))
  fi
done < "$WORK/sources.txt"
printf 'parsed %s files, %s rejected\n' "$SOURCE_COUNT" "$SYNTAX_BAD"

# ---------------------------------------------------------------------------
section "3. every JSON file parses"

find . -path ./node_modules -prune -o -path ./.git -prune -o -name '*.json' -print \
  > "$WORK/json.txt"
cat > "$WORK/json.cjs" <<'NODE'
const { readFileSync } = require('node:fs');
const files = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
let bad = 0;
for (const file of files) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`FAIL: invalid JSON: ${file}: ${error.message}`);
    bad += 1;
  }
}
console.log(`parsed ${files.length} JSON files, ${bad} rejected`);
if (files.length === 0) {
  console.error('FAIL: 0 JSON files examined -- the file discovery is broken');
  process.exit(1);
}
process.exit(bad === 0 ? 0 : 1);
NODE
if ! node "$WORK/json.cjs" "$WORK/json.txt"; then
  fail "one or more JSON files do not parse"
fi

# ---------------------------------------------------------------------------
section "4. every static relative import resolves to a file that exists"

cat > "$WORK/imports.cjs" <<'NODE'
const { readFileSync, existsSync, statSync } = require('node:fs');
const path = require('node:path');
const files = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);

// Only STATIC, LITERAL, RELATIVE specifiers, on a line that begins with the
// import/export keyword. Lines opening with a comment marker are skipped, so a
// specifier quoted in documentation cannot turn CI red for a non-defect.
const FROM = /^\s*(?:import|export)\b[^'"]*\bfrom\s*['"](\.[^'"]*)['"]/;
const BARE = /^\s*import\s*['"](\.[^'"]*)['"]/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

let checked = 0;
let broken = 0;
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (COMMENT.test(line)) continue;
    const match = FROM.exec(line) || BARE.exec(line);
    if (!match) continue;
    checked += 1;
    const target = path.resolve(path.dirname(file), match[1]);
    if (!existsSync(target) || !statSync(target).isFile()) {
      console.error(`FAIL: ${file} imports '${match[1]}', which is not a file`);
      broken += 1;
    }
  }
}
console.log(`resolved ${checked} relative import specifiers, ${broken} broken`);
if (checked === 0) {
  console.error('FAIL: 0 specifiers examined -- the scanner is broken, not the tree');
  process.exit(1);
}
process.exit(broken === 0 ? 0 : 1);
NODE
if ! node "$WORK/imports.cjs" "$WORK/sources.txt"; then
  fail "one or more relative imports do not resolve"
fi

# ---------------------------------------------------------------------------
section "5. package.json publish manifest points at paths that exist"

cat > "$WORK/manifest.cjs" <<'NODE'
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// `files` entries are npm globs. Only a wildcard in the LAST path segment is
// evaluated (that is the only shape this manifest uses, e.g. `INSTALL*.md`);
// a wildcard earlier in the path is reported as unevaluated rather than
// silently treated as a pass.
const unevaluated = [];
function present(spec) {
  const segments = spec.split('/');
  const last = segments.pop();
  const dir = path.join(root, ...segments);
  if (segments.some((s) => /[*?[]/.test(s))) {
    unevaluated.push(spec);
    return true;
  }
  if (!/[*?[]/.test(last)) return existsSync(path.join(dir, last));
  if (!existsSync(dir)) return false;
  const rx = new RegExp('^' + last.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return readdirSync(dir).some((entry) => rx.test(entry));
}

let checked = 0;
let missing = 0;
function report(label, spec) {
  checked += 1;
  if (!present(spec)) {
    console.error(`FAIL: ${label} -> '${spec}' matches nothing in the tree`);
    missing += 1;
  }
}

for (const spec of pkg.files || []) report('files[]', spec);
for (const [name, spec] of Object.entries(pkg.bin || {})) report(`bin.${name}`, spec);
if (pkg.main) report('main', pkg.main);

console.log(`checked ${checked} manifest entries, ${missing} missing`);
if (unevaluated.length) {
  console.log(`note: ${unevaluated.length} entr(y|ies) had a wildcard directory and were not evaluated: ${unevaluated.join(', ')}`);
}
if (checked === 0) {
  console.error('FAIL: 0 manifest entries examined -- the reader is broken');
  process.exit(1);
}
process.exit(missing === 0 ? 0 : 1);
NODE
if ! node "$WORK/manifest.cjs" "$ROOT"; then
  fail "package.json names paths that are not in the tree"
fi

# ---------------------------------------------------------------------------
printf '\n== summary\n'
if [ "$FAILURES" -ne 0 ]; then
  printf 'GATE FAILED (%s failing section(s))\n' "$FAILURES"
  exit 1
fi
printf 'GATE PASSED\n'
