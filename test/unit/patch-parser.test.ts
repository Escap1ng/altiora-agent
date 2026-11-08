import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatch } from "../../src/tools/patch-parser.ts";

function patch(...lines: string[]): string {
  return lines.join("\n");
}

test("parses add, update, move and delete operations", () => {
  const ops = parsePatch(
    patch(
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const value = 1;",
      "+",
      "*** Update File: src/app.ts",
      "*** Move to: src/main.ts",
      "@@ export function",
      " const keep = true;",
      "-const old = 1;",
      "+const next = 2;",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ),
  );

  assert.equal(ops.length, 3);
  const add = ops[0];
  assert.ok(add && add.kind === "add");
  assert.equal(add.path, "src/new.ts");
  assert.deepEqual(add.lines, ["export const value = 1;", ""]);

  const update = ops[1];
  assert.ok(update && update.kind === "update");
  assert.equal(update.path, "src/app.ts");
  assert.equal(update.moveTo, "src/main.ts");
  assert.equal(update.hunks.length, 1);
  assert.equal(update.hunks[0]?.hint, "export function");
  assert.deepEqual(update.hunks[0]?.lines, [
    { kind: "context", text: "const keep = true;" },
    { kind: "remove", text: "const old = 1;" },
    { kind: "add", text: "const next = 2;" },
  ]);

  const del = ops[2];
  assert.ok(del && del.kind === "delete");
  assert.equal(del.path, "src/old.ts");
});

test("accepts multiple hunks and blank separators between operations", () => {
  const ops = parsePatch(
    patch(
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      " one",
      "-two",
      "+three",
      "@@ tail",
      " four",
      "-five",
      "+six",
      "",
      "*** Update File: b.ts",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** End Patch",
    ),
  );

  assert.equal(ops.length, 2);
  const first = ops[0];
  assert.ok(first && first.kind === "update");
  assert.equal(first.hunks.length, 2);
  assert.deepEqual(first.hunks[1]?.lines, [
    { kind: "context", text: "four" },
    { kind: "remove", text: "five" },
    { kind: "add", text: "six" },
  ]);
});

test("parses a pure rename without hunks", () => {
  const ops = parsePatch(
    patch("*** Begin Patch", "*** Update File: a.ts", "*** Move to: b.ts", "*** End Patch"),
  );
  const op = ops[0];
  assert.ok(op && op.kind === "update");
  assert.equal(op.moveTo, "b.ts");
  assert.deepEqual(op.hunks, []);
});

test("parses CRLF patch text", () => {
  const ops = parsePatch(
    ["*** Begin Patch", "*** Add File: a.txt", "+hello", "*** End Patch"].join("\r\n"),
  );
  const op = ops[0];
  assert.ok(op && op.kind === "add");
  assert.deepEqual(op.lines, ["hello"]);
});

test("rejects a patch without begin or end markers", () => {
  assert.throws(() => parsePatch("*** Add File: a\n+x\n*** End Patch"), /expected "\*\*\* Begin Patch"/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), /missing "\*\*\* End Patch"/);
});

test("rejects malformed operations", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Add File: a\nnot prefixed\n*** End Patch"),
    /add file a: lines must start with \+/,
  );
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: a\n*** End Patch"),
    /update file a has no hunks/,
  );
  assert.throws(
    () =>
      parsePatch("*** Begin Patch\n*** Update File: a\n@@\n x\n*** Move to: b\n*** End Patch"),
    /move to must precede hunks/,
  );
  assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /patch contains no operations/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File:\n+x\n*** End Patch"), /missing path/);
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\ntrailing"),
    /unexpected content after/,
  );
});
