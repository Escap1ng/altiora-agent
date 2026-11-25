import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, parseFrame, parseFrames, type FrameResult, type JsonRpcMessage } from "../../src/mcp/frames.ts";

async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function collect(chunks: string[]): Promise<FrameResult[]> {
  const encoder = new TextEncoder();
  const results: FrameResult[] = [];
  for await (const result of parseFrames(fromChunks(chunks.map((chunk) => encoder.encode(chunk))))) {
    results.push(result);
  }
  return results;
}

function message(result: FrameResult | null | undefined): JsonRpcMessage {
  assert.ok(result !== null && result !== undefined && result.kind === "message");
  return result.message;
}

test("parses a request with id and params", () => {
  const result = message(parseFrame('{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{"a":1}}'));
  assert.deepEqual(result, { kind: "request", id: 7, method: "tools/list", params: { a: 1 } });
});

test("parses a string id and a notification without id", () => {
  const request = message(parseFrame('{"jsonrpc":"2.0","id":"abc","method":"ping"}'));
  assert.deepEqual(request, { kind: "request", id: "abc", method: "ping", params: undefined });
  const notification = message(parseFrame('{"jsonrpc":"2.0","method":"notifications/initialized"}'));
  assert.deepEqual(notification, { kind: "notification", method: "notifications/initialized", params: undefined });
});

test("parses result and error responses", () => {
  const ok = message(parseFrame('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'));
  assert.deepEqual(ok, { kind: "response", id: 1, result: { tools: [] }, error: null });
  const failed = message(parseFrame('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"method not found","data":"x"}}'));
  assert.deepEqual(failed, {
    kind: "response",
    id: 2,
    result: undefined,
    error: { code: -32601, message: "method not found", data: "x" },
  });
  const nullId = message(parseFrame('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}'));
  assert.equal(nullId.kind === "response" && nullId.id, null);
});

test("empty and whitespace lines yield null", () => {
  assert.equal(parseFrame(""), null);
  assert.equal(parseFrame("  \r"), null);
});

test("tolerates a trailing carriage return", () => {
  const result = message(parseFrame('{"jsonrpc":"2.0","id":1,"method":"ping"}\r'));
  assert.equal(result.kind === "request" && result.method, "ping");
});

test("rejects garbage with a lowercase reason naming the content", () => {
  const result = parseFrame("not json at all");
  assert.ok(result !== null && result.kind === "invalid");
  assert.match(result.reason, /^invalid json frame: not json at all/);
});

test("rejects non-objects, wrong version and malformed ids", () => {
  const cases: Array<[string, RegExp]> = [
    ["[1,2]", /not a json object/],
    ["42", /not a json object/],
    ['"text"', /not a json object/],
    ["null", /not a json object/],
    ['{"method":"ping"}', /not json-rpc 2\.0/],
    ['{"jsonrpc":"1.0","method":"ping"}', /not json-rpc 2\.0/],
    ['{"jsonrpc":"2.0","id":true,"method":"ping"}', /request id must be a string or number/],
    ['{"jsonrpc":"2.0","result":{}}', /response id must be a string, number or null/],
    ['{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}', /numeric code and a string message/],
    ['{"jsonrpc":"2.0","id":1,"error":5}', /error must be an object/],
    ['{"jsonrpc":"2.0","id":1}', /no method, result or error/],
  ];
  for (const [line, pattern] of cases) {
    const result = parseFrame(line);
    assert.ok(result !== null && result.kind === "invalid", line);
    assert.match(result.reason, pattern, line);
  }
});

test("truncates long offending content in the reason", () => {
  const result = parseFrame("x".repeat(200));
  assert.ok(result !== null && result.kind === "invalid");
  assert.ok(result.reason.length < 120);
  assert.ok(result.reason.endsWith("..."));
});

test("encodeFrame round-trips every message kind", () => {
  const messages: JsonRpcMessage[] = [
    { kind: "request", id: 1, method: "tools/call", params: { name: "echo" } },
    { kind: "request", id: "s", method: "ping", params: undefined },
    { kind: "notification", method: "notifications/initialized", params: undefined },
    { kind: "response", id: 1, result: { ok: true }, error: null },
    { kind: "response", id: null, result: undefined, error: null },
    { kind: "response", id: 2, result: undefined, error: { code: -32000, message: "boom", data: undefined } },
  ];
  for (const sent of messages) {
    const wire = encodeFrame(sent);
    assert.ok(wire.endsWith("\n"));
    assert.ok(!wire.slice(0, -1).includes("\n"));
    const back = message(parseFrame(wire));
    const expected =
      sent.kind === "response" && sent.error === null && sent.result === undefined ? { ...sent, result: null } : sent;
    assert.deepEqual(back, expected);
  }
});

test("parseFrames reassembles frames split across chunks", async () => {
  const results = await collect(['{"jsonrpc":"2.0","id":1,', '"method":"ping"}\n{"jsonrpc":"2.0","id":2,"result":{}}\n']);
  assert.equal(results.length, 2);
  const first = message(results[0]);
  assert.equal(first.kind === "request" && first.method, "ping");
});

test("parseFrames handles crlf, blank lines and a final frame without newline", async () => {
  const results = await collect(['{"jsonrpc":"2.0","method":"a"}\r\n\r\n{"jsonrpc":"2.0","method":"b"}']);
  assert.equal(results.length, 2);
});

test("parseFrames keeps garbage frames as invalid results without losing the next frame", async () => {
  const results = await collect(["garbage\n", '{"jsonrpc":"2.0","id":1,"result":null}\n']);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.kind, "invalid");
  assert.equal(results[1]?.kind, "message");
});

test("parseFrames survives a multibyte character split across chunks", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('{"jsonrpc":"2.0","method":"工具"}\n');
  let split = 0;
  while (split < bytes.length && (bytes[split] ?? 0) < 0x80) split += 1;
  split += 1;
  const results: FrameResult[] = [];
  for await (const result of parseFrames(fromChunks([bytes.slice(0, split), bytes.slice(split)]))) {
    results.push(result);
  }
  assert.equal(results.length, 1);
  const parsed = message(results[0]);
  assert.equal(parsed.kind === "notification" && parsed.method, "工具");
});