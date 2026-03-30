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
2. TypeScript declaration smoke tests
3. Full test suite (in-memory SQLite) -- must end with **0 failed**
4. Coverage floor checks (statement, branch, function, line)

The same gate runs automatically via `prepublishOnly` before any `npm publish`.

If you add new features or fix bugs, add tests. The test count should only go up. Coverage expectations are enforced by the verify script -- if you drop below the floor, the gate fails.

## Branch Model

All PRs target `main`. There are no long-lived feature branches.

## Release Process

1. `npm run verify:local` -- must pass completely
2. `npm version <patch|minor|major>`
3. `npm publish` -- `prepublishOnly` re-runs the verification gate
4. Push the version commit and tag: `git push && git push --tags`

## Pull Requests

- explain whether the change affects runtime behavior, package/install behavior, or both
- call out migration or compatibility risk explicitly
- include verification steps
