import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { projectConfigFile, resolveAppPaths, sessionBucket } from "../../src/config/paths.ts";

test("win32 paths come from APPDATA and LOCALAPPDATA", () => {
  const paths = resolveAppPaths(
    {
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    },
    "win32",
  );
  assert.equal(paths.configDir, join("C:\\Users\\u\\AppData\\Roaming", "altiora"));
  assert.equal(paths.configFile, join(paths.configDir, "config.json"));
  assert.equal(paths.dataDir, join("C:\\Users\\u\\AppData\\Local", "altiora"));
  assert.equal(paths.sessionsDir, join(paths.dataDir, "sessions"));
  assert.equal(paths.memoryFile, join(paths.configDir, "AGENTS.md"));
});

test("posix paths follow XDG with fallbacks", () => {
  const custom = resolveAppPaths(
    { HOME: "/home/u", XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/data" },
    "linux",
  );
  assert.equal(custom.configFile, join("/cfg", "altiora", "config.json"));
  assert.equal(custom.sessionsDir, join("/data", "altiora", "sessions"));

  const fallback = resolveAppPaths({ HOME: "/home/u" }, "linux");
  assert.equal(fallback.configFile, join("/home/u", ".config", "altiora", "config.json"));
  assert.equal(fallback.dataDir, join("/home/u", ".local", "share", "altiora"));
});

test("explicit directory overrides win on both platforms", () => {
  const paths = resolveAppPaths(
    { APPDATA: "C:\\roaming", LOCALAPPDATA: "C:\\local", ALTIORA_CONFIG_DIR: "D:\\cfg", ALTIORA_DATA_DIR: "D:\\data" },
    "win32",
  );
  assert.equal(paths.configDir, "D:\\cfg");
  assert.equal(paths.dataDir, "D:\\data");
});

test("project config file lives under .altiora in the given cwd", () => {
  assert.equal(projectConfigFile("D:\\proj"), join("D:\\proj", ".altiora", "config.json"));
});

test("session buckets are stable, short and case-insensitive on win32", () => {
  const a = sessionBucket("D:\\Proj", "win32");
  const b = sessionBucket("d:\\proj", "win32");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(sessionBucket("/a/B", "linux"), sessionBucket("/a/b", "linux"));
});
