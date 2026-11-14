import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { DEFAULT_CONFIG, validateConfig } from "../../src/config/schema.ts";

function isolatedEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "altiora-config-unit-"));
  const env: NodeJS.ProcessEnv = { ...process.env, ALTIORA_CONFIG_DIR: dir, ALTIORA_DATA_DIR: dir };
  delete env.ALTIORA_CONTEXT_WINDOW;
  delete env.ALTIORA_MAX_STEPS;
  return env;
}

test("contextWindow defaults to auto", () => {
  assert.equal(DEFAULT_CONFIG.contextWindow, "auto");
});

test("validateConfig accepts auto and positive integers", () => {
  assert.deepEqual(validateConfig({ contextWindow: "auto" }), []);
  assert.deepEqual(validateConfig({ contextWindow: 256000 }), []);
});

test("validateConfig rejects other contextWindow values", () => {
  assert.match(validateConfig({ contextWindow: 0 })[0] ?? "", /positive integer or "auto"/);
  assert.match(validateConfig({ contextWindow: -1 })[0] ?? "", /positive integer or "auto"/);
  assert.match(validateConfig({ contextWindow: "bogus" })[0] ?? "", /positive integer or "auto"/);
  assert.match(validateConfig({ contextWindow: 1.5 })[0] ?? "", /positive integer or "auto"/);
});

test("ALTIORA_CONTEXT_WINDOW overrides the default", () => {
  const env = isolatedEnv();
  env.ALTIORA_CONTEXT_WINDOW = "200000";
  assert.equal(loadConfig({ cwd: tmpdir(), env }).config.contextWindow, 200000);
});

test("ALTIORA_CONTEXT_WINDOW accepts auto", () => {
  const env = isolatedEnv();
  env.ALTIORA_CONTEXT_WINDOW = "auto";
  assert.equal(loadConfig({ cwd: tmpdir(), env }).config.contextWindow, "auto");
});

test("ALTIORA_CONTEXT_WINDOW rejects invalid values", () => {
  const env = isolatedEnv();
  env.ALTIORA_CONTEXT_WINDOW = "many";
  assert.throws(() => loadConfig({ cwd: tmpdir(), env }), /ALTIORA_CONTEXT_WINDOW must be a positive integer or auto/);
});

test("explicit overrides beat the environment", () => {
  const env = isolatedEnv();
  env.ALTIORA_CONTEXT_WINDOW = "200000";
  const config = loadConfig({ cwd: tmpdir(), env, overrides: { contextWindow: 9000 } }).config;
  assert.equal(config.contextWindow, 9000);
});

test("mcpServers defaults to an empty record", () => {
  assert.deepEqual(DEFAULT_CONFIG.mcpServers, {});
  assert.deepEqual(loadConfig({ cwd: tmpdir(), env: isolatedEnv() }).config.mcpServers, {});
});

test("validateConfig accepts a complete mcpServers entry", () => {
  const problems = validateConfig({
    mcpServers: {
      deepseek: {
        command: "node",
        args: ["server.ts"],
        env: { TOKEN: "x" },
        cwd: "/tmp",
        timeoutMs: 5000,
        enabled: true,
      },
    },
  });
  assert.deepEqual(problems, []);
});

test("validateConfig rejects invalid mcpServers entries", () => {
  const cases: unknown[] = [
    "nope",
    { "bad name": { command: "node" } },
    { good: "nope" },
    { good: { command: "" } },
    { good: {} },
    { good: { command: "node", args: [3] } },
    { good: { command: "node", args: "x" } },
    { good: { command: "node", env: { A: 1 } } },
    { good: { command: "node", env: ["a"] } },
    { good: { command: "node", cwd: "" } },
    { good: { command: "node", timeoutMs: 0 } },
    { good: { command: "node", enabled: "yes" } },
  ];
  for (const invalid of cases) {
    assert.notDeepEqual(validateConfig({ mcpServers: invalid }), [], JSON.stringify(invalid));
  }
});

test("mcpServers merge per name across config layers", () => {
  const env = isolatedEnv();
  mkdirSync(env.ALTIORA_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(env.ALTIORA_CONFIG_DIR!, "config.json"), JSON.stringify({
    mcpServers: { userServer: { command: "node" } },
  }));
  const config = loadConfig({
    cwd: tmpdir(),
    env,
    overrides: { mcpServers: { cliServer: { command: "python" } } },
  }).config;
  assert.deepEqual(config.mcpServers, {
    userServer: { command: "node" },
    cliServer: { command: "python" },
  });
});
