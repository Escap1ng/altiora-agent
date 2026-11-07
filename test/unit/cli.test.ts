import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { afterEach } from "node:test";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "altiora-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
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

test("--help does not mention stale milestone status", () => {
  const result = run(["--help"]);
  assert.doesNotMatch(result.stdout, /scaffold/);
});

test("config get prints defaults when no user config exists", () => {
  const dir = tempConfigDir();
  const result = run(["config", "get"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed["model"], "");
  assert.equal(parsed["apiKeyEnv"], "ALTIORA_API_KEY");
  assert.equal(existsSync(join(dir, "config.json")), false, "read-only get must not create the file");
});

test("config get with a key prints a scalar without quotes", () => {
  const result = run(["config", "get", "apiKeyEnv"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ALTIORA_API_KEY\n");
});

test("config get reports optional keys that are absent", () => {
  const result = run(["config", "get", "temperature"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "not set\n");
});

test("config set writes the user config and survives nesting", () => {
  const dir = tempConfigDir();
  const setResult = run(["config", "set", "model", "deepseek-chat"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(setResult.status, 0);
  const nestedSet = run(["config", "set", "tools.bash.shell", "pwsh"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(nestedSet.status, 0);
  const getResult = run(["config", "get", "tools.bash.shell"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(getResult.stdout, "pwsh\n");
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["model"], "deepseek-chat");
  const tools = raw["tools"] as { bash: { shell: string; timeoutMs: number } };
  assert.equal(tools.bash.shell, "pwsh");
  assert.equal(tools.bash.timeoutMs, undefined, "siblings from defaults must not leak into the file");
});

test("config set accepts json values such as arrays", () => {
  const dir = tempConfigDir();
  const result = run(
    ["config", "set", "trustedProjects", "[\"D:/work\"]"],
    { ALTIORA_CONFIG_DIR: dir },
  );
  assert.equal(result.status, 0);
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { trustedProjects: string[] };
  assert.deepEqual(raw.trustedProjects, ["D:/work"]);
});

test("config set rejects unknown keys", () => {
  const dir = tempConfigDir();
  const result = run(["config", "set", "frobnicate", "1"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown config key: frobnicate/);
  assert.equal(existsSync(join(dir, "config.json")), false);
});

test("config set rejects values that fail validation and writes nothing", () => {
  const dir = tempConfigDir();
  const first = run(["config", "set", "model", "deepseek-chat"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(first.status, 0);
  const result = run(["config", "set", "maxSteps", "-1"], { ALTIORA_CONFIG_DIR: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /positive integer/);
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["model"], "deepseek-chat");
  assert.equal("maxSteps" in raw, false);
});

test("run without a model reports a configuration problem", () => {
  const result = run(["run", "hello"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing model/);
});
