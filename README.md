# Altiora

*ad altiora* - toward higher things.

A headless-first coding agent harness.

Altiora runs a model against a real working directory: it streams a turn, executes tools, enforces permissions, and records everything in an append-only session log that can be resumed, forked, or replayed.

Status: **M6 complete**. `altiora chat` runs an interactive session with streaming output, inline tool activity and y/N approval for `ask` rules. All planned milestones are shipped.

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

Writing files and running commands requires an explicit rule:

```sh
altiora run "fix the failing test" --model deepseek-chat \
  --allow read --allow glob --allow grep \
  --allow "edit(src/**)" --allow "bash(node --test *)"
```

Rules use `tool(pattern)` syntax and are evaluated deny first, then ask, then allow. Read-only tools are allowed by default; `--permission-mode unattended` turns every unmatched `ask` into `deny`, and `--permission-mode plan` blocks all writes. Paths are resolved and rejected when they leave the workspace.

`task` runs a subagent with a fresh context and a tool set without `task` itself, so subagents cannot nest. `webfetch` only accepts public http(s) URLs: loopback, private, link-local and metadata addresses are rejected, redirects are re-checked, and responses are capped at 5 MB.

`altiora init` writes `.altiora/config.json` and an `AGENTS.md` stub for a new project.

For an interactive session, run `altiora chat --model deepseek-chat`. It keeps one session across turns, streams the answer, prints tool activity, and asks y/N whenever a rule resolves to `ask`; `/new` starts a fresh session and `/exit` quits. Ctrl+C during a turn aborts it without ending the session.

Configuration resolves from CLI flags over `ALTIORA_*` environment variables over the project config in `.altiora/config.json` (only when trusted) over the user config printed by `altiora config path`.

Sessions are append-only JSONL files in the user data directory. Every turn, attempt, tool call, permission decision and tool result is recorded; model context is projected from that log, so interrupted tool calls are settled on resume.

```sh
altiora sessions list
altiora sessions show <id>
altiora run "keep going" --resume <id>
altiora run "try another approach" --fork <id>
```

For scripts, `--output-format json` prints one result object and `--output-format stream-json` prints NDJSON events (`system`, `assistant`, `user`, `result`) with a stable `session_id`.

## Project instructions and context

`AGENTS.md` files are loaded from the repository root down to the working directory, plus a global file in the config directory. A line that is just `@path` imports another file, up to four levels deep and only inside the repository; the combined text is capped at 48k characters.

Before each step the harness estimates the request size, calibrates the estimate against the provider's reported input tokens, and once the context passes 85% of the usable window it summarizes the older part into a fixed template, keeps the most recent tail verbatim, and records the compaction in the session log. The summary survives replay, so `sessions show` and resume see the same context the model saw.

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

Releasing is documented in [RELEASING.md](RELEASING.md).
