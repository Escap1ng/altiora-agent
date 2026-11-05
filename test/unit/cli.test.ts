import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("--help exits 0 and prints usage", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: altiora <command> \[options\]/);
  assert.equal(result.stderr, "");
});

test("--version exits 0 and prints name and version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "altiora 0.1.0");
});

test("no arguments prints help and exits 0", () => {
  const result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: altiora/);
});

test("unknown command exits 2 with a diagnostic on stderr", () => {
  const result = run(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command: frobnicate/);
  assert.equal(result.stdout, "");
});

test("config path prints resolved locations and exits 0", () => {
  const result = run(["config", "path"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^config {3}.+config\.json$/m);
  assert.match(result.stdout, /^sessions .+sessions$/m);
  assert.match(result.stdout, /^project .+\.altiora.+config\.json$/m);
});

test("run without a model reports a configuration problem", () => {
  const result = run(["run", "hello"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing model/);
});
