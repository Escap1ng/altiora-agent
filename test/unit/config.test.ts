import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadConfig } from "../../src/config/load.ts";
import { DEFAULT_CONFIG, validateConfig } from "../../src/config/schema.ts";

function isolatedEnv(): NodeJS.ProcessEnv {
  const dir = join(tmpdir(), "altiora-config-unit");
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
