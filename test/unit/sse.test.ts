import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSse } from "../../src/providers/sse.ts";

async function* fromChunks(chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}

async function collect(chunks: string[]): Promise<string[]> {
  const events: string[] = [];
  for await (const event of parseSse(fromChunks(chunks))) events.push(event);
  return events;
}

test("parses one event per blank line", async () => {
  const events = await collect(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']);
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
});

test("reassembles events split across chunks", async () => {
  const events = await collect(["data: {\"a\"", ":1}\n", "\n"]);
  assert.deepEqual(events, ['{"a":1}']);
});

test("joins multiple data lines with a newline", async () => {
  const events = await collect(["data: first\ndata: second\n\n"]);
  assert.deepEqual(events, ["first\nsecond"]);
});

test("ignores comments and non-data fields", async () => {
  const events = await collect([": ping\nevent: message\nid: 7\ndata: ok\n\n"]);
  assert.deepEqual(events, ["ok"]);
});

test("handles CRLF line endings", async () => {
  const events = await collect(["data: a\r\n\r\n"]);
  assert.deepEqual(events, ["a"]);
});

test("flushes a final event without a trailing blank line", async () => {
  const events = await collect(["data: tail\n"]);
  assert.deepEqual(events, ["tail"]);
});

test("handles a multi-byte character split across chunks", async () => {
  const bytes = new TextEncoder().encode("data: \u4f60\u597d\n\n");
  const cut = 8;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield bytes.slice(0, cut);
    yield bytes.slice(cut);
  }
  const events: string[] = [];
  for await (const event of parseSse(chunks())) events.push(event);
  assert.deepEqual(events, ["\u4f60\u597d"]);
});
