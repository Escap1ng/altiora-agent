import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdioTransport, type StdioTransport } from "../../src/mcp/transport.ts";
import type { FrameResult } from "../../src/mcp/frames.ts";

const fixture = fileURLToPath(new URL("../mock/stdio-fixture.ts", import.meta.url));

function launch(mode?: string, overrides?: { cwd?: string; env?: Record<string, string> }): StdioTransport {
  return startStdioTransport({
    command: process.execPath,
    args: mode === undefined ? [fixture] : [fixture, mode],
    ...overrides,
  });
}

async function drain(transport: StdioTransport): Promise<FrameResult[]> {
  const results: FrameResult[] = [];
  for await (const result of transport.frames()) results.push(result);
  return results;
}

test("round-trips a request frame through the child process", async () => {
  const transport = launch();
  const iterator = transport.frames();
  const sent = transport.send({ kind: "request", id: 1, method: "ping", params: { x: 1 } });
  assert.equal(sent, true);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, {
    kind: "message",
    message: { kind: "request", id: 1, method: "ping", params: { x: 1 } },
  });
  transport.close();
  await transport.exited;
});

test("honors cwd and env options", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "altiora-mcp-")));
  const transport = launch("probe", { cwd: dir, env: { ALTIORA_MCP_TEST: "present" } });
  const results = await drain(transport);
  const exit = await transport.exited;
  assert.equal(exit.code, 0);
  assert.equal(results.length, 1);
  const frame = results[0];
  assert.ok(frame !== undefined && frame.kind === "message");
  assert.deepEqual(frame.message, {
    kind: "notification",
    method: "probe",
    params: { cwd: dir, marker: "present" },
  });
});

test("a crashing server yields its frames, stderr and exit code instead of throwing", async () => {
  const transport = launch("crash");
  const results = await drain(transport);
  const exit = await transport.exited;
  assert.equal(results.length, 2);
  assert.equal(results[0]?.kind, "invalid");
  assert.deepEqual(results[1], {
    kind: "message",
    message: { kind: "response", id: 1, result: { ok: true }, error: null },
  });
  assert.equal(exit.code, 3);
  assert.match(exit.stderr, /fixture crash/);
  assert.equal(exit.error, null);
});

test("a spawn failure surfaces through exited and ends the frame stream", async () => {
  const transport = startStdioTransport({ command: "altiora-no-such-command-9f3k2" });
  const results = await drain(transport);
  const exit = await transport.exited;
  assert.deepEqual(results, []);
  assert.equal(exit.code, null);
  assert.ok(exit.error !== null && exit.error.length > 0);
});

test("close terminates the child and refuses further sends", async () => {
  const transport = launch();
  assert.equal(typeof transport.pid, "number");
  transport.close();
  transport.close();
  const exit = await transport.exited;
  assert.ok(exit.code !== null || exit.signal !== null);
  assert.equal(transport.send({ kind: "notification", method: "late", params: undefined }), false);
});