# Altiora project plan

Updated: 2026-11-14 (second revision; first revision 2026-08-30). This document records the verified project state, the kernel design optimizations, the expanded roadmap (M9-M13) and the desktop frontend redesign. It replaces the roadmap table formerly kept only in the README.

## 1. Verified state (2026-08-30)

All checks below were run locally on Windows with Node v24.18.1.

| Check | Result |
|---|---|
| `npm test` (CLI, unit + e2e against mock server) | 138/138 pass |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| desktop `npm run typecheck` | pass |
| desktop `npm test` | 5/5 pass |
| `npm view altiora-agent version` | 0.1.0 |
| Working tree | clean |
| Git tags | none |

Milestones M0-M8 are implemented: agent loop, tools, permission engine, JSONL sessions with resume/fork, AGENTS.md memory, compaction, subagents, webfetch, apply_patch, interactive chat, and the Electron desktop shell with NSIS packaging.

M9 has a head start: the `mcpServers` config schema, cross-layer merge and validation are implemented and tested (`src/config/schema.ts`, `test/unit/config.test.ts`). No MCP runtime exists yet.

### Findings

1. **AGENTS.md status is stale.** It says "M6 complete ... all planned milestones are shipped", contradicting the README and the code (M7/M8 shipped, M9-M11 open). Must be corrected before it misleads contributors or agents.
2. **Version jump.** Current version is 0.1.0, but the old roadmap targeted M9 at 0.3.0 with no purpose for 0.2.0. Renumbered: M9 -> 0.2.0, M10 -> 0.3.0, M11 -> 0.4.0.
3. **Release hygiene gap.** RELEASING.md requires tagging the release commit, but no tags exist. The 0.1.0 release commit needs a retroactive `v0.1.0` tag.
4. **CI coverage gap.** CI runs lint/typecheck/test for the root package only. Desktop typecheck/tests and the root build are not gated.
5. **Installer unsigned.** Known limit; code signing needs a certificate decision and budget, so it stays a backlog item with an explicit trigger.
6. **M10 was overloaded.** "Harness spec and library, skills, hooks, doctor, pointer-based compaction, input fingerprints" bundled six loosely related items in one milestone. Split into 10a (observability + skills) and 10b (spec, hooks, fingerprints), with pointer-based compaction deferred behind a measured need.

### Implemented in the 2026-11-14 revision

- Session titles are derived from the first non-empty `turn/start` input line (`sessionTitle` in `src/session/store.ts`), exposed on `SessionSummary`, shown by `altiora sessions list` and used by the desktop sidebar. The log stays the only source of truth; no new write path. Covered by `test/unit/store.test.ts`.
- Desktop renderer rebuilt in the Qianwen-app visual language (section 5): activity timeline with collapsible thinking and tool rows, live run timer, task panel fed by `todo_write`, project-scoped session sidebar, pill composer with model and permission chips, light/dark themes. No IPC channel added or removed; the preload bridge is unchanged.
- Verification: root gates and desktop tests pass, including a new assertion that session titles reach the desktop data contract. Automated in-renderer UI checks were attempted (CDP page sessions, preload-injected driver, GPU/sandbox/occlusion variants) but this execution environment never runs renderer JavaScript; visual verification therefore requires one manual run of `cd desktop && npm run start` on an interactive desktop. `scripts/ui-smoke.mjs` keeps the mock-provider harness for that purpose.
- Second-pass detail work (same day), driven by the Qianwen reference screenshots: the right panel is a docked progress column (per user constraint it must NOT float) with collapsible Plan / Working files / Skills & connections cards; opening it auto-collapses the left sidebar and closing restores it, and the main content reflows rather than being overlaid; result files are collected from write/edit/apply_patch calls only after the tool result succeeds (live and on replay) with type-colored icons and a folder-open action; the sidebar gained a real Default/Plan/Auto segmented control backed by a new runtime `PermissionEngine.setMode` and `altiora:set-mode` IPC, plus a collapsible project group. Esc prioritizes the approval modal over the panel. History replay rebuilds the plan, result files and used-tool chips.

## 2. Roadmap

Order stays MCP -> harness introspection -> checkpointing, but each milestone is smaller, has explicit acceptance criteria, and 10b depends on 10a rather than on all of M10.

### M9 - MCP stdio client (CLI 0.2.0)

Scope:

- Zero-dependency JSON-RPC client over newline-delimited stdio frames: initialize handshake, `tools/list`, `tools/call`. No resources, prompts or sampling in this milestone.
- One child process per configured server, spawned with argument arrays (never `shell: true`); `env`, `cwd`, `timeoutMs`, `enabled` honored from config.
- Servers start only when the project config is trusted; untrusted configs keep MCP disabled, matching the existing trust gate.
- Tool names exposed as `mcp_<server>_<tool>`; schemas mapped into the tool registry; results mapped to tool results with truncation limits applied.
- Permission rules apply to MCP tools like built-ins; unmatched MCP calls default to `ask`, and `unattended` turns them into `deny`.
- Server failure is isolated: a crashed or timed-out server marks its tools unavailable with a clear error, and never fails the whole run.
- Clean shutdown on run end and on abort; no orphan processes on Windows.

Acceptance criteria:

- Unit tests for frame parsing, handshake, tool mapping and name collisions.
- E2e test against a mock stdio MCP server: discovery, call, permission ask/deny, crash isolation, timeout.
- `npm test`, lint, typecheck, build all green; README documents configuration and trust behavior.

Out of scope: HTTP/SSE transports, resources, prompts, OAuth.

### M10a - doctor and skills (part of CLI 0.3.0)

Scope:

- `altiora doctor`: checks Node version, config validity and locations, API key env presence, provider `/models` reachability, workspace writability, session directory health. Machine-readable output with `--output-format json`.
- Skills: markdown skill files discovered from the user config directory and `.altiora/skills/`, listed by name and description, injected into context on demand; no code execution in this milestone.

Acceptance criteria: doctor detects each seeded fault in tests; skills load, cap and import rules mirror the AGENTS.md loader conventions; e2e shows a skill reaching model context.

### M10b - harness spec, hooks, fingerprints (CLI 0.3.0)

Scope:

- Versioned harness spec recorded per session (tool set, config fingerprint, harness version) so sessions can be compared against the harness that produced them.
- Library surface: document and stabilize the `runAgent` entry for embedding (the desktop app is the first consumer).
- Hooks: pre/post tool-call hooks declared in trusted config, executed as argument-array commands with timeout, output captured into the session log; hooks cannot bypass permissions.
- Input fingerprints on user turns for dedupe and replay comparison.

Acceptance criteria: spec round-trips through resume/fork/replay; hook failure modes (timeout, non-zero exit) are tested and logged; fingerprints stable across replay.

### M11 - checkpointing and /rewind (CLI 0.4.0)

Scope:

- Tools declare the resources they mutate; before a mutating call the harness snapshots those resources (copy-on-write into the session directory).
- `/rewind` in chat and `altiora sessions rewind` restore a chosen checkpoint and truncate the session log consistently; resume after rewind sees the restored state.
- Checkpoint storage is bounded (per-session cap, pruned oldest-first) and never leaves the user data directory.

Acceptance criteria: e2e covers write/edit/apply_patch/bash-declared resources, rewind across multiple checkpoints, and crash between snapshot and tool execution.

### M12 - provider breadth and model switching (CLI 0.5.0)

Scope:

- Native Anthropic adapter behind the same `Provider` interface; capability matrix from section 3 drives reasoning and tool-call handling. Gemini stays deferred until a concrete need.
- `altiora models` lists provider models with context windows; `/model` in chat and a model chip in the desktop composer switch models mid-session and re-discover limits.
- Per-model defaults (temperature, max output) resolved from config with CLI/env overrides.

Acceptance criteria: adapter contract tests run against recorded wire fixtures for both providers; switching models mid-session keeps the log replayable; desktop chip reflects the active model without restart.

### M13 - desktop experience parity (desktop 0.3.0)

Scope:

- Session management: rename (metadata record), pin, delete with confirmation, search across titles; workspace history with one-click switch (the sidebar project section).
- Skills and connections panels backed by M10a skills and M9 MCP config; read-only status first, editing later.
- Usage view from session stats (`/stats` parity): tokens per turn, tool counts, compaction history.
- Theme and density settings persisted per user; keyboard map documented; installer signing tracked separately.

Acceptance criteria: every panel action round-trips through the existing IPC bridge or a newly reviewed channel; no HTTP listener; desktop tests cover rename/pin/delete and workspace switch; screenshots refreshed.

### Deferred, with triggers

- **Pointer-based compaction**: revisit only when summary-based compaction shows measured context loss in real sessions (track via `/stats` and replay diffs).
- **Native Anthropic/Gemini adapters**: when the OpenAI-compatible adapter stops being enough for a target provider.
- **Installer code signing**: when a certificate budget is approved; until then the SmartScreen warning stays documented.
- **Browser UI, OS sandboxes, LSP, agent teams**: remain non-goals.

## 3. Kernel design optimization

Invariants (never traded away):

- The append-only JSONL log is the only source of truth; model context, titles, stats and checkpoints are projections of it.
- `src/core` emits `RunEvent` and never writes to stdout or imports providers/cli; wire formats stay in adapters.
- Permissions are enforced by the harness with `deny -> ask -> allow` first-match; `unattended` maps ask to deny; hooks and MCP can never bypass the engine.
- Zero runtime dependencies unless a change removes more code than it adds; Windows first-class (argument arrays, `path.relative` containment, no `shell: true`).

Optimizations, ordered by payoff:

1. **Additive event enrichment (M9).** `tool-call` carries declared resources and a start timestamp; `tool-result` carries `durationMs`; a `usage` event surfaces per-step token usage. Events stay a discriminated union; old logs replay unchanged because enrichment lives on events, not on stored records. Renderers (CLI and desktop) consume the same enriched stream.
2. **Session metadata as projection (done).** Titles derive from `turn/start`; future rename/pin metadata goes into a `notice`-style record so resume/fork/replay keep one code path. No sidecar databases.
3. **Provider capability matrix (M12).** One declared table per adapter: reasoning round-trip, tool-call chunk assembly, usage reporting, model listing. The core branches on capabilities, never on provider names.
4. **Compaction pointer mode (deferred, trigger-gated).** Keep summaries as the default; add pointer-based compaction only with measured context-loss evidence, and record both forms in the log so replay can compare them.
5. **Checkpoint resource declarations (M11).** Tools declare mutated resources once; the same declaration feeds permission patterns, checkpoint snapshots and the approval dialog, removing three parallel lists.
6. **Runtime as a library (M10b).** `buildRuntime`/`runAgent` become the documented embedding surface; the desktop service is the reference consumer and must not grow private core forks.

## 4. Cross-cutting work (before or alongside M9)

1. Fix the stale status section in AGENTS.md (owner: next commit).
2. Add root `npm run build`, desktop typecheck and desktop tests to CI; keep the OS/Node matrix.
3. Tag the existing 0.1.0 release commit `v0.1.0`; tag every future release per RELEASING.md.
4. Keep the zero-runtime-dependency rule: MCP client, skills and hooks must not add runtime deps without removing more code than they add.

## 5. Desktop frontend design (Qianwen-app language)

Reference: the Qianwen desktop app screenshot supplied by the user (2026-11-14). The redesign borrows its layout grammar and restraint, not its brand: a quiet warm-gray canvas, one narrow sidebar, a centered reading column, and a floating pill composer.

Layout:

- Left sidebar (264px, collapsible): brand row; "New task" primary row; navigation rows for Skills and Connections (status panels, read-only until M13); a Projects section listing the active workspace with its sessions grouped beneath (title from the log, relative time, active highlight); a Tasks section live-fed by `todo_write` with pending/in-progress/completed markers; footer with version and theme toggle.
- Main column: minimal top bar (sidebar toggle, session title, workspace chip, status dot, files-panel toggle); a centered 760px activity stream; floating composer pinned to the bottom with a soft shadow and 16px radius.
- Right files panel: unchanged tree + read-only preview, restyled to the same tokens.

Activity stream (the core surface):

- Each run opens with a live status line: spinner + "Running m s" while busy, settling to "Completed in m s" or the stop reason; the line is a collapse toggle for the whole run.
- Thinking renders as a gray collapsible row ("Thinking" / "Thought for N chars") with the reasoning text inside; it auto-collapses when the answer starts unless the user touched it.
- Tool calls render as compact rows: verb-first label derived from the tool name and input ("Read src/core/loop.ts", "Ran npm test", "Edited 2 files"), a status dot (running/ok/error/denied), and an expandable output pane. Consecutive rows group visually; errors use the danger tone, denials the warning tone.
- Assistant answers are plain reading text with lightweight Markdown (headings, lists, code blocks, inline code, links rendered as text-only for CSP safety); user messages are right-aligned soft bubbles.
- Compaction and system notices are centered hairline chips.

Composer:

- Auto-growing textarea (1-8 rows), Enter sends, Shift+Enter newline.
- Bottom row inside the pill: attach-style "+" opens the workspace picker; permission-mode chip cycles default/plan/unattended with a tooltip; model chip shows the active model (switching arrives with M12); right side holds the send button, which becomes a square stop button while running.
- Below the pill: a one-line hint "Enter to send - Shift+Enter for a new line" and the session's token estimate when available.

Visual tokens:

- Light: canvas #f7f7f8, sidebar #f2f2f3, surface #ffffff, ink #1a1c1e, muted #8a8f98, hairline #e6e7ea; accent electric blue #2f6bff; success #16a34a; warning #d97706; danger #dc2626; thinking gray #9aa0a6.
- Dark: canvas #17181a, sidebar #1e2023, surface #232529, ink #edeef0, muted #9ba1a8, hairline #33363b; same accents lifted for contrast.
- Type: system UI stack, 13px base, 15px answers, tabular numerals for timers; radius 10-16px; shadows only on the composer and modals; scrollbars styled to the palette in both themes.
- Motion: 120-160ms ease-out for collapses and hovers; spinner is a rotating arc; no sound (a work tool stays silent).

Behavioral guarantees:

- All existing IPC channels keep their payloads; the redesign is renderer-only plus the additive `title` field on session summaries.
- Approval modal, preview modal, keyboard map (Ctrl+B sidebar, Ctrl+Shift+B files, Esc/Enter in modal) and localStorage persistence are preserved.
- The empty state shows the brand mark, a one-line prompt and three suggestion chips that fill the composer (real prompts, not placeholders).

## 6. Release checklist (per milestone)

1. All local gates green, including desktop.
2. Version bump in `package.json` (and desktop when its behavior changes).
3. README status and roadmap updated.
4. `npm pack --dry-run` contents inspected.
5. Publish, then `npm view altiora-agent version` and a clean-directory `npx` smoke test.
6. Tag the release commit.