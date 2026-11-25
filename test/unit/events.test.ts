import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { runAgent, type RunEvent } from "../../src/core/loop.ts";
import { runTool } from "../../src/core/tool-runner.ts";
import type { Provider, ProviderEvent } from "../../src/core/types.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { createRegistry, type ToolContext, type ToolDefinition } from "../../src/tools/registry.ts";

function context(): ToolContext {
  return {
    cwd: process.cwd(),
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
    resources: () => [path.join(process.cwd(), "touched.txt")],
    execute: async () => ({ output: "ok", isError: false, truncated: false }),
    ...overrides,
  };
}

function capture(): { events: RunEvent[]; onEvent: (event: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

test("tool-call carries declared resources and a start timestamp", async () => {
  const { events, onEvent } = capture();
  const before = Date.now();
  await runTool(
    { id: "c1", name: "probe", input: {} },
    context(),
    {
      registry: createRegistry([probeTool()]),
      permissions: createPermissionEngine({ mode: "default", rules: [], cwd: process.cwd(), platform: process.platform }),
      onEvent,
    },
    0,
  );
  const call = events[0];
  assert.ok(call !== undefined && call.type === "tool-call");
  assert.deepEqual(call.resources, [path.join(process.cwd(), "touched.txt")]);
  assert.ok(call.startedAt >= before && call.startedAt <= Date.now());
  const result = events[1];
  assert.ok(result !== undefined && result.type === "tool-result");
  assert.ok(result.durationMs >= 0);
});

test("denied and failed calls keep the tool-call/tool-result pairing with duration", async () => {
  const { events, onEvent } = capture();
  const permissions = createPermissionEngine({ mode: "unattended", rules: [], cwd: process.cwd(), platform: process.platform });
  const registry = createRegistry([probeTool()]);
  await runTool({ id: "c1", name: "probe", input: {} }, context(), { registry, permissions, onEvent }, 0);
  await runTool({ id: "c2", name: "missing", input: {} }, context(), { registry, permissions, onEvent }, 0);
  assert.deepEqual(events.map((event) => event.type), ["tool-call", "tool-result", "tool-call", "tool-result"]);
  const denied = events[1];
  const unknown = events[3];
  assert.ok(denied !== undefined && denied.type === "tool-result" && denied.denied && denied.durationMs >= 0);
  assert.ok(unknown !== undefined && unknown.type === "tool-result" && unknown.isError && unknown.durationMs >= 0);
  const unknownCall = events[2];
  assert.ok(unknownCall !== undefined && unknownCall.type === "tool-call");
  assert.deepEqual(unknownCall.resources, []);
});

test("a parse failure still emits a paired tool-call before the error result", async () => {
  const { events, onEvent } = capture();
  const tool = probeTool({
    parse: () => {
      throw new Error("bad input");
    },
  });
  await runTool(
    { id: "c1", name: "probe", input: {} },
    context(),
    {
      registry: createRegistry([tool]),
      permissions: createPermissionEngine({ mode: "default", rules: [], cwd: process.cwd(), platform: process.platform }),
      onEvent,
    },
    0,
  );
  assert.deepEqual(events.map((event) => event.type), ["tool-call", "tool-result"]);
  const result = events[1];
  assert.ok(result !== undefined && result.type === "tool-result" && result.output === "bad input");
});

test("runAgent emits a usage event per step", async () => {
  let calls = 0;
  const provider: Provider = {
    id: "fake",
    async *stream(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      if (calls === 1) {
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "tool-call-delta", index: 0, id: "call_1", name: "probe", argsDelta: "{}" };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "usage", usage: { inputTokens: 20, outputTokens: 7 } };
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const { events, onEvent } = capture();
  const result = await runAgent("go", {
    provider,
    registry: createRegistry([probeTool({ readOnly: true })]),
    permissions: createPermissionEngine({ mode: "default", rules: [], cwd: process.cwd(), platform: process.platform }),
    model: "m",
    cwd: process.cwd(),
    platform: process.platform,
    signal: new AbortController().signal,
    maxSteps: 5,
    maxToolCallsPerStep: 4,
    maxOutputChars: 4000,
    bash: { shell: "auto", timeoutMs: 1000 },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    onEvent,
  });
  assert.equal(result.stopReason, "completed");
  const usageEvents = events.filter((event) => event.type === "usage");
  assert.deepEqual(usageEvents, [
    { type: "usage", step: 0, usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "usage", step: 1, usage: { inputTokens: 20, outputTokens: 7 } },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12 });
});