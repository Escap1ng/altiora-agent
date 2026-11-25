import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "../../src/config/schema.ts";
import { createMcpManager, type McpManager } from "../../src/mcp/manager.ts";
import type { ToolContext, ToolDefinition } from "../../src/tools/registry.ts";

const fixture = fileURLToPath(new URL("../mock/mcp-server.ts", import.meta.url));

function server(mode?: string, extra?: Partial<McpServerConfig>): McpServerConfig {
  return { command: process.execPath, args: mode === undefined ? [fixture] : [fixture, mode], ...extra };
}

function context(overrides?: { maxOutputChars?: number; signal?: AbortSignal }): ToolContext {
  return {
    cwd: process.cwd(),
    platform: process.platform,
    signal: overrides?.signal ?? new AbortController().signal,
    maxOutputChars: overrides?.maxOutputChars ?? 10000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
  };
}

async function withManager(
  servers: Record<string, McpServerConfig>,
  fn: (manager: McpManager, tools: ToolDefinition[]) => Promise<void>,
  options?: { cwd?: string; reservedNames?: string[] },
): Promise<void> {
  const manager = createMcpManager({
    servers,
    cwd: options?.cwd ?? process.cwd(),
    ...(options?.reservedNames === undefined ? {} : { reservedNames: options.reservedNames }),
  });
  try {
    const { tools } = await manager.discover();
    await fn(manager, tools);
  } finally {
    manager.close();
  }
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `missing tool ${name}`);
  return tool;
}

test("discovery wraps tools with mcp names, schemas and readOnly hints", async () => {
  await withManager({ mock: server() }, async (_manager, tools) => {
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp_mock_echo", "mcp_mock_peek"]);
    const echo = byName(tools, "mcp_mock_echo");
    assert.deepEqual(echo.parameters, {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    assert.match(echo.description, /^\[mcp:mock\] echo arguments/);
    assert.equal(echo.readOnly, false);
    assert.equal(byName(tools, "mcp_mock_peek").readOnly, true);
  });
});

test("execute round-trips a call and applies truncation limits", async () => {
  await withManager({ mock: server() }, async (_manager, tools) => {
    const echo = byName(tools, "mcp_mock_echo");
    const result = await echo.execute(echo.parse({ text: "hi" }), context());
    assert.deepEqual(result, { output: "echo:hi", isError: false, truncated: false });
    const long = await echo.execute(echo.parse({ text: "x".repeat(50) }), context({ maxOutputChars: 20 }));
    assert.equal(long.truncated, true);
    assert.match(long.output, /\[truncated \d+ chars\]/);
  });
});

test("parse enforces required fields and primitive types", async () => {
  await withManager({ mock: server() }, async (_manager, tools) => {
    const echo = byName(tools, "mcp_mock_echo");
    assert.throws(() => echo.parse({}), /missing required field: text/);
    assert.throws(() => echo.parse({ text: 5 }), /text must be of type string/);
    assert.throws(() => echo.parse("nope"), /tool input must be an object/);
  });
});

test("a failing server is isolated and the healthy one still provides tools", async () => {
  const manager = createMcpManager({
    servers: {
      good: server(),
      silent: server("hang", { timeoutMs: 100 }),
      missing: { command: "altiora-no-such-command-9f3k2" },
    },
    cwd: process.cwd(),
  });
  try {
    const { tools, failures } = await manager.discover();
    assert.deepEqual(tools.map((tool) => tool.name), ["mcp_good_echo", "mcp_good_peek"]);
    assert.equal(failures.length, 2);
    const silent = failures.find((failure) => failure.server === "silent");
    const missing = failures.find((failure) => failure.server === "missing");
    assert.ok(silent !== undefined && /timed out/.test(silent.error));
    assert.ok(missing !== undefined && missing.error.length > 0);
  } finally {
    manager.close();
  }
});

test("a server crash during a call becomes a tool error, not a throw", async () => {
  await withManager({ crashy: server("crash-on-call") }, async (_manager, tools) => {
    const echo = byName(tools, "mcp_crashy_echo");
    const first = await echo.execute(echo.parse({ text: "x" }), context());
    assert.equal(first.isError, true);
    assert.match(first.output, /mcp server exited before responding/);
    const second = await echo.execute(echo.parse({ text: "y" }), context());
    assert.equal(second.isError, true);
  });
});

test("names are sanitized and collisions get numeric suffixes", async () => {
  await withManager({ "a.b": server(), "a/b": server() }, async (_manager, tools) => {
    assert.deepEqual(tools.map((tool) => tool.name), [
      "mcp_a_b_echo",
      "mcp_a_b_peek",
      "mcp_a_b_echo_2",
      "mcp_a_b_peek_2",
    ]);
  });
});

test("reserved built-in names are never reused", async () => {
  await withManager(
    { mock: server() },
    async (_manager, tools) => {
      assert.deepEqual(tools.map((tool) => tool.name), ["mcp_mock_echo_2", "mcp_mock_peek"]);
    },
    { reservedNames: ["mcp_mock_echo"] },
  );
});

test("disabled servers are skipped entirely", async () => {
  await withManager({ off: server(undefined, { enabled: false }) }, async (_manager, tools) => {
    assert.deepEqual(tools, []);
  });
});

test("relative server cwd resolves against the workspace", async () => {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "altiora-mcp-ws-")));
  mkdirSync(path.join(workspace, "sub"));
  await withManager(
    { loc: server("cwd-tool", { cwd: "sub" }) },
    async (_manager, tools) => {
      const where = byName(tools, "mcp_loc_where");
      const result = await where.execute(where.parse({}), context());
      assert.equal(result.isError, false);
      assert.equal(result.output, path.join(workspace, "sub"));
    },
    { cwd: workspace },
  );
});

test("an aborted context short-circuits the call", async () => {
  await withManager({ mock: server() }, async (_manager, tools) => {
    const controller = new AbortController();
    controller.abort();
    const echo = byName(tools, "mcp_mock_echo");
    const result = await echo.execute(echo.parse({ text: "hi" }), context({ signal: controller.signal }));
    assert.deepEqual(result, { output: "mcp call aborted", isError: true, truncated: false });
  });
});

test("aborting mid-call returns a tool error and keeps the server alive", async () => {
  await withManager({ mock: server("hang-tool") }, async (_manager, tools) => {
    const stall = byName(tools, "mcp_mock_stall");
    const controller = new AbortController();
    const pending = stall.execute(stall.parse({}), context({ signal: controller.signal }));
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.output, /mcp request aborted/);
    const echo = byName(tools, "mcp_mock_echo");
    const after = await echo.execute(echo.parse({ text: "ok" }), context());
    assert.deepEqual(after, { output: "echo:ok", isError: false, truncated: false });
  });
});

test("calls after manager close return a tool error", async () => {
  await withManager({ mock: server() }, async (manager, tools) => {
    const echo = byName(tools, "mcp_mock_echo");
    manager.close();
    const result = await echo.execute(echo.parse({ text: "hi" }), context());
    assert.equal(result.isError, true);
    assert.match(result.output, /mcp client is closed/);
  });
});