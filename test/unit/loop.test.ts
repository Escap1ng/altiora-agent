import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runAgent } from "../../src/core/loop.ts";
import type { Provider, ProviderEvent } from "../../src/core/types.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { openSession } from "../../src/session/log.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { createRegistry } from "../../src/tools/registry.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "altiora-loop-"));
  cleanups.push(directory);
  return directory;
}

function scriptedProvider(): Provider {
  let calls = 0;
  return {
    id: "fake",
    async *stream(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call_1",
          name: "write",
          argsDelta: JSON.stringify({ path: "out.txt", content: "x" }),
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

function options(cwd: string, confirm?: (request: { tool: string }) => Promise<boolean>) {
  return {
    provider: scriptedProvider(),
    registry: createRegistry(defaultTools()),
    permissions: createPermissionEngine({ mode: "default" as const, rules: [], cwd, platform: process.platform }),
    model: "m",
    cwd,
    platform: process.platform,
    signal: new AbortController().signal,
    maxSteps: 5,
    maxToolCallsPerStep: 4,
    maxOutputChars: 4000,
    bash: { shell: "auto" as const, timeoutMs: 5000 },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    ...(confirm === undefined ? {} : { confirm }),
  };
}

test("asks for approval before running a write", async () => {
  const cwd = workspace();
  const asked: string[] = [];
  const result = await runAgent("write a file", options(cwd, async (request) => {
    asked.push(request.tool);
    return true;
  }));

  assert.deepEqual(asked, ["write"]);
  assert.equal(existsSync(join(cwd, "out.txt")), true);
  assert.equal(result.text, "done");
  assert.equal(result.stopReason, "completed");
});

test("treats an unapproved ask as a denial", async () => {
  const cwd = workspace();
  const result = await runAgent("write a file", options(cwd, async () => false));

  assert.equal(existsSync(join(cwd, "out.txt")), false);
  assert.equal(result.text, "done");
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool" && toolMessage.isError);
});

test("denies an ask when no confirmation hook exists", async () => {
  const cwd = workspace();
  const result = await runAgent("write a file", options(cwd));
  assert.equal(existsSync(join(cwd, "out.txt")), false);
  assert.equal(result.stopReason, "completed");
});

test("stops on a repeated tool call", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "seed.txt"), "seed", "utf8");
  let calls = 0;
  const provider: Provider = {
    id: "loop",
    async *stream(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      yield {
        type: "tool-call-delta",
        index: 0,
        id: `call_${calls}`,
        name: "read",
        argsDelta: JSON.stringify({ path: "seed.txt" }),
      };
      yield { type: "finish", reason: "tool_calls" };
    },
  };
  const result = await runAgent(
    "read it",
    { ...options(cwd), provider, permissions: createPermissionEngine({ mode: "unattended", rules: [], cwd, platform: process.platform }) },
  );
  assert.equal(result.stopReason, "loop_detected");
});

test("returns aborted without calling the provider when the signal is already aborted", async () => {
  const cwd = workspace();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const provider: Provider = {
    id: "never",
    async *stream(): AsyncGenerator<ProviderEvent> {
      called = true;
      yield { type: "finish", reason: "stop" };
    },
  };

  const result = await runAgent("anything", { ...options(cwd), provider, signal: controller.signal });

  assert.equal(result.stopReason, "aborted");
  assert.equal(called, false);
});

test("skips the rest of a tool batch when aborted during approval", async () => {
  const cwd = workspace();
  const controller = new AbortController();
  const provider: Provider = {
    id: "batch",
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call_a",
        name: "write",
        argsDelta: JSON.stringify({ path: "a.txt", content: "a" }),
      };
      yield {
        type: "tool-call-delta",
        index: 1,
        id: "call_b",
        name: "write",
        argsDelta: JSON.stringify({ path: "b.txt", content: "b" }),
      };
      yield { type: "finish", reason: "tool_calls" };
    },
  };

  const result = await runAgent("two writes", {
    ...options(cwd),
    provider,
    signal: controller.signal,
    confirm: async () => {
      controller.abort();
      return true;
    },
  });

  assert.equal(result.stopReason, "aborted");
  assert.equal(existsSync(join(cwd, "a.txt")), false);
  assert.equal(existsSync(join(cwd, "b.txt")), false);
  const toolMessages = result.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 2);
  for (const message of toolMessages) {
    assert.ok(message.role === "tool");
    assert.equal(message.isError, true);
    assert.match(message.output, /not executed: run aborted/);
  }
});

test("records an aborted turn in the session log", async () => {
  const cwd = workspace();
  const log = openSession(cwd, "s_abort");
  const controller = new AbortController();
  controller.abort();

  const result = await runAgent("anything", { ...options(cwd), signal: controller.signal, log });

  assert.equal(result.stopReason, "aborted");
  const turnEnd = log.records().find((record) => record.t === "turn/end");
  assert.ok(turnEnd !== undefined);
  assert.equal(turnEnd.t === "turn/end" ? turnEnd.stopReason : "", "aborted");
});
