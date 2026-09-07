# Local publication hooks

On macOS or Linux, run `bash scripts/setup-hooks.sh` from a reviewed scheduler checkout to install
the tracked pre-push hook. Installation is an explicit local operation; npm
installation does not change Git hooks. The installer preserves the old hook
(including a file or broken symlink) in a numbered
`pre-push.before-openclaw-scheduler` backup. It never executes that backup.
Other hooks remain unchanged. A configured `core.hooksPath`, symlink hooks
directory, directory at the hook destination, or missing tracked executable
causes refusal before replacement. Staging and atomic replacement occur in
Git's common hooks directory, independent of `TMPDIR`.

The common wrapper resolves the **active worktree** at push time. Each worktree
used for publication must contain this tracked hook; old worktrees fail with an
actionable missing-hook error. Do not remove or bypass the common hook to publish
an old checkout. Integrate the reviewed hook source into the publication branch
normally. The worktree that installed the wrapper can later be removed safely.

For a push with source updates, the hook requires a clean worktree and each
pushed commit to be the checked-out commit (annotated tags may point to it).
Publish different commits from their own worktrees. Exact ref-update input drives
the union of changed paths, including removed paths and both ends of renames.
A new ref checks its whole tree; an existing ref requires its previous object
locally, so fetch missing history normally before retrying. Empty/no-op updates
and deletion-only pushes have no source to validate and return without checks.

The hook queries `wh reservation conflicts --repo alexm/openclaw-scheduler`
using the existing CLI login, for either forge remote. It validates the JSON
envelope and checks overlaps, because the CLI also exits zero when conflicts
exist. A broad empty result avoids needless per-file requests. Otherwise each
changed path is matched by the server. Missing CLI, authentication/service
failure, a request exceeding 30 seconds, malformed output, and any overlapping
hold block publication. A reservation under the same account is still a hold:
shared keys cannot identify an individual lane. Coordinate on `wh chat` and
release resolved holds normally, then retry. These are preflight observations,
not an atomic reservation or a substitute for board coordination. No retired
coord helper, secret environment file, direct API credential, or bypass switch
is used.

Once coordination is clear, the hook runs the existing project gates unchanged:

- `bash scripts/ci-gate.sh`: WritHub's dependency-free repository checks.
- `npm run verify:smoke`: lint, typecheck, tests and package dry-run through the
  existing `scripts/verify-local.mjs` command.

Any gate failure blocks publication. Install the normal project dependencies
and use a supported Node version before pushing. The hook does not install
packages or fetch refs. Full coverage and package verification remain available
through the existing `npm run verify:local`; this hook uses the current CI smoke
gate. Isolated installer and real-Git ref/coordination/failure controls run with
`node --test tests/git-hooks.test.mjs`, using fixture commands instead of live
WritHub or nested project test suites. These POSIX controls explicitly skip on
Windows and in npm packages, which do not contain repository hook sources.
