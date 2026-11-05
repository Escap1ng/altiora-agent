# Altiora

*ad altiora* - toward higher things.

A headless-first coding agent harness.

Altiora runs a model against a real working directory: it streams a turn, executes tools, enforces permissions, and records everything in an append-only session log that can be resumed, forked, or replayed.

Status: **M1 complete**. `altiora run` streams a single-turn request to any OpenAI-compatible endpoint. Tools, sessions, and permissions land next.

## Why another harness

- **The session log is the source of truth.** Model context is projected from it, so resume, fork, replay, and crash recovery all come from the same data. Interrupted tool calls are settled on resume instead of being silently dropped.
- **Permissions are enforced by the harness, not requested in the prompt.** Rules use `deny -> ask -> allow` with first-match semantics. Headless runs have an explicit `unattended` policy where `ask` becomes `deny`.
- **Provider differences stay at the edge.** The core speaks semantic messages; OpenAI-compatible wire formats, `reasoning_content` round-tripping, and tool-call chunk assembly live in one adapter.
- **Small dependency surface.** Runtime dependencies are added only when they pay for themselves; tests use `node:test`; the CLI parses arguments with `node:util`.

## Requirements

Node.js 22.18 or newer. Development runs TypeScript directly through Node's type stripping, so no build step is needed to try the CLI.

## Usage

```sh
export ALTIORA_API_KEY=...
altiora run "summarize this repository" --model deepseek-chat --base-url https://api.deepseek.com/v1
```

Configuration resolves from CLI flags over `ALTIORA_*` environment variables over the project config in `.altiora/config.json` (only when trusted) over the user config printed by `altiora config path`.

## Development

```sh
npm install
node src/cli/main.ts --help
node src/cli/main.ts config path
npm test
npm run typecheck
npm run build
```

## Layout

```
src/cli         command entry points and output renderers
src/core        agent loop, context assembly, compaction, run events
src/providers   model adapters (OpenAI-compatible first)
src/tools       tool definitions and execution
src/permissions permission rules and workspace containment
src/session     append-only JSONL log, projection, resume
src/config      schema, path resolution, AGENTS.md discovery
```

## Roadmap

| Milestone | Scope |
|---|---|
| M0 | Repository scaffold, config schema, CLI shell, CI |
| M1 | OpenAI-compatible provider, SSE streaming, retries |
| M2 | Multi-step loop, eight tools, permission engine |
| M3 | JSONL sessions, resume/fork, `stream-json` output |
| M4 | Token accounting, AGENTS.md memory, compaction |
| M5 | Subagents, web fetch, docs, npm release |
| M6 | Interactive TUI |

Published as `altiora-agent`; the command is `altiora`.

## License

Apache-2.0
