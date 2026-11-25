import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMcpClient, type McpClient } from "../../src/mcp/client.ts";
import { startStdioTransport } from "../../src/mcp/transport.ts";

const fixture = fileURLToPath(new URL("../mock/mcp-server.ts", import.meta.url));

interface SetupOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function withClient(
  mode: string | undefined,
  options: SetupOptions,
  fn: (client: McpClient) => Promise<void>,
): Promise<void> {
  const transport = startStdioTransport({
    command: process.execPath,
    args: mode === undefined ? [fixture] : [fixture, mode],
  });
  const clientOptions: { transport: typeof transport; timeoutMs: number; signal?: AbortSignal } = {
    transport,
    timeoutMs: options.timeoutMs ?? 2000,
  };
  if (options.signal !== undefined) clientOptions.signal = options.signal;
  const client = createMcpClient(clientOptions);
  try {
    await fn(client);
  } finally {
    client.close();
    transport.close();
    await transport.exited;
  }
}

const ECHO_TOOL = {
  name: "echo",
  description: "echo arguments",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readOnlyHint: false,
};
const PEEK_TOOL = { name: "peek", description: "", inputSchema: { type: "object" }, readOnlyHint: true };

test("initialize handshake, initialized notification and tool mapping", async () => {
  await withClient(undefined, {}, async (client) => {
    await client.initialize();
    const tools = await client.listTools();
    assert.deepEqual(tools, [ECHO_TOOL, PEEK_TOOL]);
  });
});

test("callTool maps text results, isError and json-rpc errors", async () => {
  await withClient(undefined, {}, async (client) => {
    await client.initialize();
    const ok = await client.callTool("echo", { text: "hi" });
    assert.deepEqual(ok, { content: [{ type: "text", text: "echo:hi" }], isError: false });
    const failed = await client.callTool("fail", {});
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: "text", text: "tool failed" }]);
    await assert.rejects(client.callTool("boom", {}), /unknown tool: boom/);
  });
});

test("initialize falls back when the first protocol version is rejected", async () => {
  await withClient("bad-version", {}, async (client) => {
    await client.initialize();
    assert.deepEqual(await client.listTools(), [ECHO_TOOL, PEEK_TOOL]);
  });
});

test("initialize accepts an older supported version from the server", async () => {
  await withClient("old-version", {}, async (client) => {
    await client.initialize();
  });
});

test("initialize fails when every version is unsupported", async () => {
  await withClient("always-bad-version", {}, async (client) => {
    await assert.rejects(client.initialize(), /protocol version 1999-01-01 is not supported/);
  });
});

test("initialize fails when the server rejects every attempt", async () => {
  await withClient("error-init", {}, async (client) => {
    await assert.rejects(client.initialize(), /mcp initialize failed: initialize rejected/);
  });
});

test("a silent server hits the per-request timeout", async () => {
  await withClient("hang", { timeoutMs: 100 }, async (client) => {
    await assert.rejects(client.initialize(), /timed out after 100ms/);
  });
});

test("a silent tool call times out without killing later calls", async () => {
  await withClient(undefined, { timeoutMs: 500 }, async (client) => {
    await client.initialize();
    await assert.rejects(client.callTool("hang", {}), /mcp tools\/call timed out after 500ms/);
    const ok = await client.callTool("echo", { text: "after" });
    assert.deepEqual(ok.content, [{ type: "text", text: "echo:after" }]);
  });
});

test("a server crash rejects pending and later calls with the exit detail", async () => {
  await withClient("crash-on-call", {}, async (client) => {
    await client.initialize();
    await assert.rejects(client.callTool("echo", { text: "x" }), /mcp server exited before responding \(code 5\)/);
    await assert.rejects(client.callTool("echo", { text: "y" }), /mcp server exited before responding/);
  });
});

test("abort rejects the in-flight request", async () => {
  const controller = new AbortController();
  await withClient("hang", { timeoutMs: 5000, signal: controller.signal }, async (client) => {
    const pending = client.initialize();
    controller.abort();
    await assert.rejects(pending, /mcp request aborted/);
  });
});

test("a per-call abort rejects only that call and keeps the server usable", async () => {
  await withClient(undefined, { timeoutMs: 5000 }, async (client) => {
    await client.initialize();
    const controller = new AbortController();
    const pending = client.callTool("hang", {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, /mcp request aborted/);
    const ok = await client.callTool("echo", { text: "still-alive" });
    assert.deepEqual(ok.content, [{ type: "text", text: "echo:still-alive" }]);
  });
});

test("close rejects pending requests and refuses new ones", async () => {
  await withClient("hang", { timeoutMs: 5000 }, async (client) => {
    const pending = client.initialize();
    client.close();
    await assert.rejects(pending, /mcp client is closed/);
    await assert.rejects(client.listTools(), /mcp client is closed/);
  });
});

test("listTools follows pagination cursors", async () => {
  await withClient("paged", {}, async (client) => {
    await client.initialize();
    assert.deepEqual(await client.listTools(), [ECHO_TOOL, PEEK_TOOL]);
  });
});

test("answers server ping and rejects unsupported server requests", async () => {
  await withClient("server-ping", {}, async (client) => {
    await client.initialize();
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    const report = tools[0];
    assert.ok(report !== undefined);
    const received = JSON.parse(report.description) as Record<string, Record<string, unknown>>;
    assert.deepEqual(received["srv-1"]?.["result"], {});
    const error = received["srv-2"]?.["error"] as Record<string, unknown>;
    assert.equal(error["code"], -32601);
  });
});

test("garbage frames before the handshake are ignored", async () => {
  await withClient("garbage", {}, async (client) => {
    await client.initialize();
    assert.deepEqual(await client.listTools(), [ECHO_TOOL, PEEK_TOOL]);
  });
});