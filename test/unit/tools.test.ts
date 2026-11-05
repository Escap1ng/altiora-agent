import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultTools } from "../../src/tools/index.ts";
import { createRegistry, type ToolContext } from "../../src/tools/registry.ts";

const cleanups: string[] = [];

after(async () => {
  await Promise.all(cleanups.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "altiora-tools-"));
  cleanups.push(directory);
  return directory;
}

function context(cwd: string): ToolContext {
  return {
    cwd,
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 4000,
    bash: { shell: "auto", timeoutMs: 20000 },
    todos: [],
  };
}

const registry = createRegistry(defaultTools());

async function call(cwd: string, name: string, input: unknown) {
  const tool = registry.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  const parsed = tool.parse(input);
  return tool.execute(parsed, context(cwd));
}

test("write then read round-trips content", async () => {
  const cwd = await workspace();
  const written = await call(cwd, "write", { path: "src/a.txt", content: "hello\n" });
  assert.equal(written.isError, false);
  assert.match(written.output, /wrote 6 bytes to src\/a\.txt/);

  const read = await call(cwd, "read", { path: "src/a.txt" });
  assert.equal(read.output, "hello\n");
});

test("edit replaces a unique match and rejects ambiguous ones", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n", "utf8");

  const ok = await call(cwd, "edit", { path: "a.txt", old_string: "beta", new_string: "gamma" });
  assert.equal(ok.isError, false);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "alpha\ngamma\n");

  await writeFile(join(cwd, "b.txt"), "x\nx\n", "utf8");
  const ambiguous = await call(cwd, "edit", { path: "b.txt", old_string: "x", new_string: "y" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.output, /appears 2 times/);

  const replaced = await call(cwd, "edit", { path: "b.txt", old_string: "x", new_string: "y", replace_all: true });
  assert.equal(replaced.isError, false);
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "y\ny\n");
});

test("edit retries with normalized line endings", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "crlf.txt"), "one\r\ntwo\r\n", "utf8");
  const result = await call(cwd, "edit", { path: "crlf.txt", old_string: "one\ntwo", new_string: "three" });
  assert.equal(result.isError, false);
  assert.equal(await readFile(join(cwd, "crlf.txt"), "utf8"), "three\r\n");
});

test("path escapes are rejected", async () => {
  const cwd = await workspace();
  const tool = registry.get("write");
  assert.ok(tool);
  const parsed = tool.parse({ path: "../escape.txt", content: "x" });
  assert.throws(() => tool.resources?.(parsed, context(cwd)), /path escapes/);
});

test("glob finds nested files and respects the directory boundary", async () => {
  const cwd = await workspace();
  await call(cwd, "write", { path: "src/a.ts", content: "export const a = 1;\n" });
  await call(cwd, "write", { path: "src/deep/b.ts", content: "export const b = 2;\n" });
  await call(cwd, "write", { path: "README.md", content: "# hi\n" });

  const matches = await call(cwd, "glob", { pattern: "**/*.ts" });
  assert.equal(matches.isError, false);
  assert.deepEqual(matches.output.split("\n").sort(), ["src/a.ts", "src/deep/b.ts"]);

  const shallow = await call(cwd, "glob", { pattern: "src/*.ts" });
  assert.deepEqual(shallow.output.split("\n"), ["src/a.ts"]);
});

test("grep returns file and line numbers", async () => {
  const cwd = await workspace();
  await call(cwd, "write", { path: "a.ts", content: "const one = 1;\nconst two = 2;\n" });
  const result = await call(cwd, "grep", { pattern: "two" });
  assert.equal(result.isError, false);
  assert.equal(result.output, "a.ts:2: const two = 2;");
});

test("ls lists entries", async () => {
  const cwd = await workspace();
  await call(cwd, "write", { path: "a.txt", content: "x" });
  const result = await call(cwd, "ls", {});
  assert.match(result.output, /file a\.txt/);
});

test("bash captures output and exit codes", async () => {
  const cwd = await workspace();
  const ok = await call(cwd, "bash", { command: 'node -e "console.log(41 + 1)"' });
  assert.equal(ok.isError, false);
  assert.match(ok.output, /42/);

  const failed = await call(cwd, "bash", { command: 'node -e "process.exit(3)"' });
  assert.equal(failed.isError, true);
  assert.match(failed.output, /\[exit 3\]/);
});

test("todo_write stores the task list on the context", async () => {
  const cwd = await workspace();
  const ctx = context(cwd);
  const tool = registry.get("todo_write");
  assert.ok(tool);
  const result = await tool.execute(
    tool.parse({ todos: [{ content: "write tests", status: "in_progress" }] }),
    ctx,
  );
  assert.equal(result.output, "[~] 1. write tests");
  assert.equal(ctx.todos.length, 1);
});

test("large reads are truncated", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "big.txt"), "x".repeat(10000), "utf8");
  const ctx = context(cwd);
  ctx.maxOutputChars = 100;
  const tool = registry.get("read");
  assert.ok(tool);
  const result = await tool.execute(tool.parse({ path: "big.txt" }), ctx);
  assert.equal(result.truncated, true);
  assert.match(result.output, /\[truncated 9900 chars\]/);
});
