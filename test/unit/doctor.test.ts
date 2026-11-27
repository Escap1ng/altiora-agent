import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { formatDoctor, runDoctor, type DoctorCheck } from "../../src/cli/doctor.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "altiora-doctor-"));
  cleanups.push(directory);
  return directory;
}

function envFor(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ALTIORA_CONFIG_DIR: join(cwd, ".cfg"),
    ALTIORA_DATA_DIR: join(cwd, ".data"),
    ALTIORA_API_KEY: "test-key",
  };
  delete env.ALTIORA_MODEL;
  delete env.ALTIORA_BASE_URL;
  delete env.ALTIORA_CONTEXT_WINDOW;
  delete env.ALTIORA_MAX_STEPS;
  return env;
}

function writeConfig(env: NodeJS.ProcessEnv, config: unknown): void {
  mkdirSync(env.ALTIORA_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(env.ALTIORA_CONFIG_DIR!, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

function fakeFetch(response: { status: number; body?: unknown } | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body ?? {},
    } as unknown as Response;
  }) as typeof fetch;
}

function byName(checks: DoctorCheck[]): Map<string, DoctorCheck> {
  return new Map(checks.map((check) => [check.name, check]));
}

async function doctor(cwd: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fakeFetch({ status: 200 })) {
  return runDoctor({
    cwd,
    env,
    platform: process.platform,
    nodeVersion: "v24.0.0",
    minNode: ">=22.18",
    fetchImpl,
  });
}

test("a healthy workspace passes every check", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  writeConfig(env, { model: "m", baseUrl: "https://api.example/v1" });
  const checks = byName(await doctor(cwd, env, fakeFetch({ status: 200, body: { data: [{ id: "m" }] } })));

  for (const check of checks.values()) assert.equal(check.status, "ok", `${check.name}: ${check.detail}`);
  assert.match(checks.get("provider")?.detail ?? "", /reachable/);
  assert.equal(formatDoctor([...checks.values()], "json").includes('"ok":true'), true);
});

test("an invalid user config is reported as a config error", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  writeConfig(env, "{ not json");
  const checks = byName(await doctor(cwd, env));

  assert.equal(checks.get("config")?.status, "error");
  assert.match(checks.get("config")?.detail ?? "", /invalid json/);
  assert.equal(checks.get("api-key")?.status, "warn");
  assert.match(checks.get("api-key")?.detail ?? "", /config invalid/);
});

test("an old node runtime is an error", async () => {
  const cwd = workspace();
  const checks = byName(
    await runDoctor({
      cwd,
      env: envFor(cwd),
      platform: process.platform,
      nodeVersion: "v20.11.0",
      minNode: ">=22.18",
      fetchImpl: fakeFetch({ status: 200 }),
    }),
  );
  assert.equal(checks.get("node")?.status, "error");
  assert.match(checks.get("node")?.detail ?? "", /older than/);
});

test("a missing api key env is an error and skips the provider probe", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  writeConfig(env, { model: "m", baseUrl: "https://api.example/v1", apiKeyEnv: "ALTIORA_TEST_MISSING_KEY" });
  delete env.ALTIORA_TEST_MISSING_KEY;
  let probed = false;
  const checks = byName(
    await doctor(cwd, env, (async () => {
      probed = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch),
  );

  assert.equal(checks.get("api-key")?.status, "error");
  assert.match(checks.get("api-key")?.detail ?? "", /ALTIORA_TEST_MISSING_KEY/);
  assert.equal(checks.get("provider")?.status, "warn");
  assert.equal(probed, false);
});

test("provider auth failures are errors and network failures are warnings", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  writeConfig(env, { model: "m", baseUrl: "https://api.example/v1" });

  const unauthorized = byName(await doctor(cwd, env, fakeFetch({ status: 401 })));
  assert.equal(unauthorized.get("provider")?.status, "error");
  assert.match(unauthorized.get("provider")?.detail ?? "", /authentication failed/);

  const offline = byName(await doctor(cwd, env, fakeFetch(new Error("connect ECONNREFUSED"))));
  assert.equal(offline.get("provider")?.status, "warn");
  assert.match(offline.get("provider")?.detail ?? "", /unreachable/);
});

test("a workspace that is not a directory is an error", async () => {
  const cwd = workspace();
  const file = join(cwd, "not-a-directory");
  writeFileSync(file, "x");
  const checks = byName(await doctor(file, envFor(cwd)));
  assert.equal(checks.get("workspace")?.status, "error");
  assert.match(checks.get("workspace")?.detail ?? "", /not writable|not a directory/);
});

test("a blocked session directory is an error", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  const blocked = join(cwd, "data-file");
  writeFileSync(blocked, "x");
  env.ALTIORA_DATA_DIR = blocked;
  const checks = byName(await doctor(cwd, env));
  assert.equal(checks.get("sessions")?.status, "error");
  assert.match(checks.get("sessions")?.detail ?? "", /not writable/);
});

test("project config presence and trust are reported", async () => {
  const cwd = workspace();
  const env = envFor(cwd);
  writeConfig(env, { model: "m" });
  mkdirSync(join(cwd, ".altiora"), { recursive: true });
  writeFileSync(join(cwd, ".altiora", "config.json"), JSON.stringify({ maxSteps: 5 }));

  const untrusted = byName(await doctor(cwd, env));
  assert.equal(untrusted.get("project-config")?.status, "warn");
  assert.match(untrusted.get("project-config")?.detail ?? "", /untrusted/);

  writeConfig(env, { model: "m", permissions: { trustProjectConfig: true } });
  const trusted = byName(await doctor(cwd, env));
  assert.equal(trusted.get("project-config")?.status, "ok");
  assert.match(trusted.get("project-config")?.detail ?? "", /trusted/);

  writeFileSync(join(cwd, ".altiora", "config.json"), "{ broken");
  const broken = byName(await doctor(cwd, env));
  assert.equal(broken.get("config")?.status, "error");
  assert.match(broken.get("config")?.detail ?? "", /invalid json/);
});

test("formatDoctor renders text and json summaries", () => {
  const checks: DoctorCheck[] = [
    { name: "node", status: "ok", detail: "fine" },
    { name: "provider", status: "warn", detail: "offline" },
  ];
  const text = formatDoctor(checks, "text");
  assert.match(text, /ok {4}node: fine/);
  assert.match(text, /ok: 1 checks passed, 1 warnings/);
  const json = JSON.parse(formatDoctor(checks, "json")) as { ok: boolean; checks: DoctorCheck[] };
  assert.equal(json.ok, true);
  assert.equal(json.checks.length, 2);

  const failed = formatDoctor([{ name: "config", status: "error", detail: "bad" }], "text");
  assert.match(failed, /failed: 1 errors/);
  assert.equal(JSON.parse(formatDoctor([{ name: "config", status: "error", detail: "bad" }], "json")).ok, false);
});
