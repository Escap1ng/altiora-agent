# AGENTS.md

Repository conventions for agents working in this codebase.

Project: Altiora. Package `altiora-agent`, binary `altiora`.

## Stack

- Node.js 22.18+, ESM only, TypeScript executed directly by Node in development.
- Build with `tsc -p tsconfig.build.json`; output in `dist/`.
- No runtime dependencies at M0. Add one only when it removes more code than it adds.
- Tests use `node:test` and `node:assert/strict`. No test framework.

## TypeScript constraints

- `erasableSyntaxOnly` is on: no enums, no namespaces, no parameter properties.
- Relative imports include the `.ts` extension (`../config/paths.ts`); the build rewrites them to `.js`.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are enabled. Do not weaken them.

## Layout rules

- `src/core` must not import from `src/providers` or `src/cli`. Provider wire formats stay in adapters and are converted at the boundary.
- Loop code emits `RunEvent` objects; renderers consume them. Never write to stdout from `src/core`.
- All filesystem paths go through `path.resolve`/`path.join`. Permission containment compares paths with `path.relative` on case-insensitive platforms.

## Style

- No emojis anywhere in files, tests, or output.
- Comments only for non-obvious constraints; do not narrate what the code does.
- Error messages are lowercase, specific, and name the offending value.
- Windows is a first-class platform: never use `shell: true`, never inline a script into a command string.

## Commands

```sh
node src/cli/main.ts --help
npm test
npm run lint
npm run typecheck
npm run build
```

## Status

M4 complete: token estimation with usage calibration, hierarchical AGENTS.md memory with `@imports`, and automatic compaction recorded as a session event with a verbatim tail. Subagents, web fetch and release tooling are not implemented yet.
