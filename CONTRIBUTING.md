# Contributing

## Scope

Contributions should improve one of these areas:

- runtime reliability
- workflow and queue semantics
- installation and service management
- package/install ergonomics
- documentation and tests

## Ground Rules

- preserve durable runtime behavior
- do not remove backward-compatible CLI or schema behavior casually
- update docs when installation or runtime behavior changes
- update tests when changing scheduler semantics, payload validation, or delivery behavior

## Development

```bash
npm install
npm test
npm run lint
```

### Local Verification Gate

Before pushing or opening a PR, run the full local gate:

```bash
npm run verify:local
```

This runs, in order:

1. Lint (`eslint`)
2. Strict TypeScript declaration smoke tests
3. Full tests, documentation examples, and available agentcli contract checks
4. Coverage floor checks (statement, branch, function, line)
5. npm package-content validation (`npm pack --dry-run`)

The same gate runs automatically via `prepublishOnly` before any `npm publish`.

The default test gate uses an agentcli checkout at `../agentcli` or at the path
in `AGENTCLI_PATH` when present and reports an explicit skip when it is absent.
Hosted CI checks out exact reviewed public handoff-v3 and handoff-v2 agentcli
commits. It runs the scheduler-owned contract against both and the
compatible upstream-owned tests for both. The exact v3 pin still contains one
test that hard-codes handoff field version 2; the harness reports only that
assertion as skipped and runs the rest. Run `npm run test:agentcli` to require
scheduler-owned and compatible upstream-owned integration locally. For an intentionally scheduler-only local iteration,
`SKIP_AGENTCLI_INTEGRATION=1 npm test` records the opt-out explicitly; do not
use that opt-out for a release candidate.

If you add new features or fix bugs, add tests. The test count should only go up. Coverage expectations are enforced by the verify script -- if you drop below the floor, the gate fails.

## Branch Model

All PRs target `main`. There are no long-lived feature branches.

## Release Process

1. On the release branch, update `package.json` and `package-lock.json` without
   creating a tag: `npm version patch --no-git-tag-version` (or `minor`/`major`).
2. Update `CHANGELOG.md`, run `npm run verify:local`, and merge the reviewed PR.
3. Fast-forward a clean local `main` to the merged commit and confirm the
   package version: `node -p 'require("./package.json").version'`.
4. Create one annotated tag matching that version, then push only that tag:
   `VERSION=$(node -p 'require("./package.json").version')`,
   `git tag -a "v$VERSION" -m "v$VERSION"`, and
   `git push origin "v$VERSION"`.
5. Confirm the tag-triggered `Publish to npm` workflow succeeds and that npm
   reports provenance for the published version.

Do not run `npm publish` locally. The tag workflow verifies the package, checks
that the tag matches `package.json`, and publishes to npm with provenance.

### Agent-Facing Documentation

The following files ship in the npm package for agent adoption:

- `AGENTS.md` -- discovery flow, working rules, CLI commands
- `CONTEXT.md` -- repo positioning, design bias
- `JOB-QUICK-REF.md` -- copy-paste job patterns, field reference
- `docs/` -- gateway contract, trust architecture, ADRs

Update these when adding new features or changing the CLI API.

## Pull Requests

- explain whether the change affects runtime behavior, package/install behavior, or both
- call out migration or compatibility risk explicitly
- include verification steps
