# CLAUDE.md

This file is read automatically by Claude Code. See [AGENTS.md](AGENTS.md) for
full agent instructions for working in this repository.

Key points:

- Always poll job status via CLI before reporting it — never infer from
  conversation messages (see AGENTS.md "Checking Job Status" section)
- `run_timeout_ms` is required on every job — no default
- Use `jobs validate` before `jobs add`
- Shell jobs run without the gateway; agent jobs require a running gateway
- See [BEST-PRACTICES.md](BEST-PRACTICES.md) for job type guidance and
  prompt-writing patterns
