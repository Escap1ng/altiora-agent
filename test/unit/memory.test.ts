import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadMemory } from "../../src/config/memory.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "altiora-memory-"));
  cleanups.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

test("loads AGENTS.md from the repo root down to the working directory", () => {
  const root = repo();
  const nested = join(root, "packages", "core");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root rules\n", "utf8");
  writeFileSync(join(nested, "AGENTS.md"), "nested rules\n", "utf8");

  const result = loadMemory({ cwd: nested });

  assert.deepEqual(result.files, [join(root, "AGENTS.md"), join(nested, "AGENTS.md")]);
  const rootIndex = result.text.indexOf("root rules");
  const nestedIndex = result.text.indexOf("nested rules");
  assert.ok(rootIndex >= 0 && nestedIndex > rootIndex, result.text);
  assert.match(result.text, /## packages\/core\/AGENTS\.md/);
});

test("expands @imports and refuses paths outside the repo", () => {
  const root = repo();
  writeFileSync(join(root, "AGENTS.md"), "@shared.md\n@../outside.md\n", "utf8");
  writeFileSync(join(root, "shared.md"), "shared content\n", "utf8");

  const result = loadMemory({ cwd: root });

  assert.match(result.text, /shared content/);
  assert.match(result.text, /skipped import outside the repository: \.\.\/outside\.md/);
});

test("includes the global memory file first", () => {
  const root = repo();
  const global = join(root, "global.md");
  writeFileSync(join(root, "AGENTS.md"), "local\n", "utf8");
  writeFileSync(global, "global rules\n", "utf8");

  const result = loadMemory({ cwd: root, globalFile: global });

  assert.ok(result.text.startsWith("## global"));
  assert.ok(result.text.indexOf("global rules") < result.text.indexOf("local"));
});

test("truncates beyond the character budget", () => {
  const root = repo();
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(500), "utf8");

  const result = loadMemory({ cwd: root, maxChars: 100 });

  assert.equal(result.truncated, true);
  assert.match(result.text, /\[memory truncated\]/);
});

test("returns an empty string when no memory files exist", () => {
  const root = repo();
  const result = loadMemory({ cwd: root });
  assert.equal(result.text, "");
  assert.deepEqual(result.files, []);
});
