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

## Pull Requests

- explain whether the change affects runtime behavior, package/install behavior, or both
- call out migration or compatibility risk explicitly
- include verification steps
