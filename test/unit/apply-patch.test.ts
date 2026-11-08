import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  const directory = await mkdtemp(join(tmpdir(), "altiora-patch-"));
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

const applyTool = createRegistry(defaultTools()).get("apply_patch")!;
assert.ok(applyTool, "apply_patch is registered");

async function apply(cwd: string, text: string) {
  return applyTool.execute(applyTool.parse({ patch: text }), context(cwd));
}

test("applies add, update, move and delete in one patch", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n", "utf8");
  await writeFile(join(cwd, "move.txt"), "keep\n", "utf8");
  await writeFile(join(cwd, "del.txt"), "gone\n", "utf8");

  const result = await apply(
    cwd,
    [
      "*** Begin Patch",
      "*** Add File: nested/new.txt",
      "+hello",
      "*** Update File: a.txt",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** Update File: move.txt",
      "*** Move to: renamed.txt",
      "*** Delete File: del.txt",
      "*** End Patch",
    ].join("\n"),
  );

  assert.equal(result.isError, false);
  assert.equal(result.output, "applied patch: added nested/new.txt, updated a.txt, moved move.txt -> renamed.txt, deleted del.txt");
  assert.equal(await readFile(join(cwd, "nested", "new.txt"), "utf8"), "hello\n");
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "alpha\ngamma\n");
  assert.equal(existsSync(join(cwd, "move.txt")), false);
  assert.equal(await readFile(join(cwd, "renamed.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(join(cwd, "del.txt")), false);
});

test("writes nothing when any operation fails validation", async () => {
  const cwd = await workspace();
  const result = await apply(
    cwd,
    [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+created",
      "*** Update File: missing.txt",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"),
  );

  assert.equal(result.isError, true);
  assert.match(result.output, /cannot read missing\.txt/);
  assert.equal(existsSync(join(cwd, "a.txt")), false);
});

test("rejects an ambiguous hunk", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "b.txt"), "x\nx\n", "utf8");
  const result = await apply(
    cwd,
    ["*** Begin Patch", "*** Update File: b.txt", "@@", "-x", "+y", "*** End Patch"].join("\n"),
  );

  assert.equal(result.isError, true);
  assert.match(result.output, /hunk matches 2 locations in b\.txt/);
  assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "x\nx\n");
});

test("tolerates trailing whitespace while preserving context lines", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "ws.txt"), "alpha  \nbeta\n", "utf8");
  const result = await apply(
    cwd,
    [
      "*** Begin Patch",
      "*** Update File: ws.txt",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** End Patch",
    ].join("\n"),
  );

  assert.equal(result.isError, false);
  assert.equal(await readFile(join(cwd, "ws.txt"), "utf8"), "alpha  \ngamma\n");
});

test("preserves crlf line endings", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "crlf.txt"), "one\r\ntwo\r\n", "utf8");
  const result = await apply(
    cwd,
    [
      "*** Begin Patch",
      "*** Update File: crlf.txt",
      "@@",
      " one",
      "-two",
      "+three",
      "*** End Patch",
    ].join("\n"),
  );

  assert.equal(result.isError, false);
  assert.equal(await readFile(join(cwd, "crlf.txt"), "utf8"), "one\r\nthree\r\n");
});

test("rejects conflicting file states", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "a.txt"), "existing\n", "utf8");
  await writeFile(join(cwd, "dst.txt"), "taken\n", "utf8");
  await writeFile(join(cwd, "src.txt"), "content\n", "utf8");

  const add = await apply(cwd, ["*** Begin Patch", "*** Add File: a.txt", "+x", "*** End Patch"].join("\n"));
  assert.equal(add.isError, true);
  assert.match(add.output, /add file a\.txt already exists/);

  const del = await apply(cwd, ["*** Begin Patch", "*** Delete File: nope.txt", "*** End Patch"].join("\n"));
  assert.equal(del.isError, true);
  assert.match(del.output, /delete file nope\.txt does not exist/);

  const move = await apply(
    cwd,
    ["*** Begin Patch", "*** Update File: src.txt", "*** Move to: dst.txt", "*** End Patch"].join("\n"),
  );
  assert.equal(move.isError, true);
  assert.match(move.output, /move target dst\.txt already exists/);
  assert.equal(await readFile(join(cwd, "src.txt"), "utf8"), "content\n");
});

test("rejects duplicate paths and workspace escapes", async () => {
  const cwd = await workspace();
  const duplicate = await apply(
    cwd,
    [
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+one",
      "*** Update File: a.txt",
      "@@",
      " x",
      "-y",
      "+z",
      "*** End Patch",
    ].join("\n"),
  );
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.output, /patch touches a\.txt more than once/);

  const escape = applyTool.parse({ patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch" });
  assert.throws(() => applyTool.resources?.(escape, context(cwd)), /path escapes the workspace/);
});

test("applies additions to an empty file", async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, "empty.txt"), "", "utf8");
  const result = await apply(
    cwd,
    ["*** Begin Patch", "*** Update File: empty.txt", "@@", "+first", "+second", "*** End Patch"].join("\n"),
  );

  assert.equal(result.isError, false);
  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "first\nsecond\n");
});
