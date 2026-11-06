import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "../../src/tools/registry.ts";
import { taskTool } from "../../src/tools/task.ts";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 4000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
    ...overrides,
  };
}

test("returns the subagent result", async () => {
  const result = await taskTool.execute(
    taskTool.parse({ description: "lookup", prompt: "find the answer" }),
    context({ runSubagent: async (prompt) => ({ text: `done:${prompt}`, isError: false }) }),
  );
  assert.equal(result.output, "done:find the answer");
  assert.equal(result.isError, false);
});

test("fails cleanly when subagents are unavailable", async () => {
  const result = await taskTool.execute(taskTool.parse({ description: "x", prompt: "y" }), context());
  assert.equal(result.isError, true);
  assert.match(result.output, /subagents are not available/);
});

test("propagates a failed subagent run", async () => {
  const result = await taskTool.execute(
    taskTool.parse({ description: "x", prompt: "y" }),
    context({ runSubagent: async () => ({ text: "", isError: true }) }),
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /produced no output/);
});
