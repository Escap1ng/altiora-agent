import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HookConfig } from "../../src/config/schema.ts";
import { runTool } from "../../src/core/tool-runner.ts";
import { matchingHooks, runHooks } from "../../src/hooks/runner.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { openSession } from "../../src/session/log.ts";
import { createRegistry, type ToolContext, type ToolDefinition } from "../../src/tools/registry.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "altiora-hooks-"));
  cleanups.push(directory);
  return directory;
}

function node(code: string): string[] {
  return [process.execPath, "-e", code];
}

function context(cwd: string): ToolContext {
  return {
    cwd,
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 10000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
  };
}

function probeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: "probe",
    description: "probe",
    parameters: { type: "object" },
    parse: (input) => input,
    resources: () => [],
    readOnly: true,
    execute: async () => ({ output: "ran", isError: false, truncated: false }),
    ...overrides,
  };
}

const invocation = (cwd: string) => ({ tool: "probe", callId: "call_1", cwd });

test("matchingHooks filters by event, matcher and enabled", () => {
  const hooks: HookConfig[] = [
    { event: "pre_tool_use", command: ["a"] },
    { event: "pre_tool_use", command: ["b"], matcher: "write" },
    { event: "pre_tool_use", command: ["c"], matcher: "probe" },
    { event: "pre_tool_use", command: ["d"], enabled: false },
    { event: "post_tool_use", command: ["e"] },
  ];
  assert.deepEqual(
    matchingHooks(hooks, "pre_tool_use", "probe").map((hook) => hook.command),
    [["a"], ["c"]],
  );
  assert.deepEqual(
    matchingHooks(hooks, "post_tool_use", "probe").map((hook) => hook.command),
    [["e"]],
  );
});

test("a hook runs without a shell and sees the invocation in its environment", async () => {
  const outcomes = await runHooks(
    [{ event: "pre_tool_use", command: node("console.log(`${process.env.ALTIORA_TOOL}:${process.env.ALTIORA_HOOK_EVENT}`)") }],
    "pre_tool_use",
    invocation(workspace()),
    new AbortController().signal,
  );
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /probe:pre_tool_use/);
  assert.ok(outcome.durationMs >= 0);
});

test("a non-zero exit is reported as an error with its code", async () => {
  const outcomes = await runHooks(
    [{ event: "pre_tool_use", command: node("process.exit(3)") }],
    "pre_tool_use",
    invocation(workspace()),
    new AbortController().signal,
  );
  assert.equal(outcomes[0]?.status, "error");
  assert.equal(outcomes[0]?.exitCode, 3);
});

test("a hook that exceeds its timeout is killed and reported", async () => {
  const started = Date.now();
  const outcomes = await runHooks(
    [{ event: "pre_tool_use", command: node("setTimeout(() => {}, 60000)"), timeoutMs: 100 }],
    "pre_tool_use",
    invocation(workspace()),
    new AbortController().signal,
  );
  assert.equal(outcomes[0]?.status, "timeout");
  assert.ok(Date.now() - started < 5000);
});

test("an aborted signal skips the hook instead of spawning it", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcomes = await runHooks(
    [{ event: "pre_tool_use", command: ["altiora-binary-that-does-not-exist"] }],
    "pre_tool_use",
    invocation(workspace()),
    controller.signal,
  );
  assert.equal(outcomes[0]?.status, "aborted");
});

test("runTool logs pre and post hook outcomes around an allowed call", async () => {
  const directory = workspace();
  const log = openSession(directory, "s_hooks");
  const hooks: HookConfig[] = [
    { event: "pre_tool_use", command: node("console.log('pre')") },
    { event: "post_tool_use", command: node("console.error('post')") },
  ];
  const outcome = await runTool(
    { id: "call_1", name: "probe", input: {} },
    context(directory),
    {
      registry: createRegistry([probeTool()]),
      permissions: createPermissionEngine({ mode: "unattended", rules: [], cwd: directory, platform: process.platform }),
      hooks,
      log,
    },
    0,
  );

  assert.equal(outcome.isError, false);
  assert.equal(outcome.output, "ran");
  const records = log.records().filter((record) => record.t === "hook");
  assert.equal(records.length, 2);
  const first = records[0];
  const second = records[1];
  assert.ok(first !== undefined && first.t === "hook");
  assert.ok(second !== undefined && second.t === "hook");
  assert.equal(first.event, "pre_tool_use");
  assert.equal(first.status, "ok");
  assert.match(first.output, /pre/);
  assert.equal(second.event, "post_tool_use");
  assert.match(second.output, /post/);
});

test("hooks never run for a denied call", async () => {
  const directory = workspace();
  const log = openSession(directory, "s_denied");
  const hooks: HookConfig[] = [{ event: "pre_tool_use", command: node("console.log('should not run')") }];
  const outcome = await runTool(
    { id: "call_1", name: "probe", input: {} },
    context(directory),
    {
      registry: createRegistry([probeTool({ readOnly: false })]),
      permissions: createPermissionEngine({ mode: "unattended", rules: [], cwd: directory, platform: process.platform }),
      hooks,
      log,
    },
    0,
  );

  assert.equal(outcome.denied, true);
  assert.equal(log.records().filter((record) => record.t === "hook").length, 0);
});

test("a failing hook is logged but does not block the tool", async () => {
  const directory = workspace();
  const log = openSession(directory, "s_failing");
  const outcome = await runTool(
    { id: "call_1", name: "probe", input: {} },
    context(directory),
    {
      registry: createRegistry([probeTool()]),
      permissions: createPermissionEngine({ mode: "unattended", rules: [], cwd: directory, platform: process.platform }),
      hooks: [{ event: "pre_tool_use", command: node("process.exit(3)") }],
      log,
    },
    0,
  );

  assert.equal(outcome.isError, false);
  const records = log.records().filter((record) => record.t === "hook");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.t === "hook" ? records[0].status : "", "error");
});
