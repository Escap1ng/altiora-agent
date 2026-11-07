import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessError } from "../../src/core/errors.ts";
import type { ProviderEvent } from "../../src/core/types.ts";
import { OpenAiCompatProvider } from "../../src/providers/openai-compat.ts";
import { streamWithRetry } from "../../src/providers/retry.ts";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

const signal = (): AbortSignal => new AbortController().signal;
const policy = { maxAttempts: 3, baseDelayMs: 5 };
const simpleChunk = sseChunks([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("retries when the connection is reset before any byte", async () => {
  const server = await startMockServer((_request, index) =>
    index === 0 ? { destroy: true } : { chunks: simpleChunk },
  );
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    const events = await collect(
      streamWithRetry(provider, { model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal(), policy }),
    );

    assert.equal(server.requests.length, 2);
    assert.deepEqual(events[0], { type: "text-delta", text: "ok" });
  } finally {
    await server.close();
  }
});

test("honors retry-after from a 429 response", async () => {
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { status: 429, headers: { "retry-after": "0.08" }, body: "slow down" }
      : { chunks: simpleChunk },
  );
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await collect(
      streamWithRetry(provider, { model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal(), policy }),
    );

    assert.equal(server.requests.length, 2);
    const waited = server.requests[1]!.at - server.requests[0]!.at;
    assert.ok(waited >= 70, `expected at least 70ms honoring retry-after, waited ${waited}ms`);
    assert.ok(waited < 5000, `expected a bounded wait, waited ${waited}ms`);
  } finally {
    await server.close();
  }
});

test("falls back to exponential backoff when 429 has no retry-after", async () => {
  const server = await startMockServer((_request, index) =>
    index === 0 ? { status: 429, body: "" } : { chunks: simpleChunk },
  );
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await collect(
      streamWithRetry(
        provider,
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { signal: signal(), policy: { maxAttempts: 3, baseDelayMs: 40 } },
      ),
    );

    assert.equal(server.requests.length, 2);
    const waited = server.requests[1]!.at - server.requests[0]!.at;
    assert.ok(waited >= 30, `expected at least 30ms backoff, waited ${waited}ms`);
  } finally {
    await server.close();
  }
});

test("does not retry after a mid-stream disconnect", async () => {
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "Hel" } }] }]),
    destroy: { afterChunks: 1 },
  }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await assert.rejects(
      collect(
        streamWithRetry(provider, { model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal(), policy }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "network");
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(server.requests.length, 1, "a broken stream mid-response must never be replayed");
  } finally {
    await server.close();
  }
});

test("completes a stream that ends cleanly without [DONE] using the default finish", async () => {
  const server = await startMockServer(() => ({
    chunks: ["data: " + JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }) + "\n\n"],
  }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    const events = await collect(
      provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal() }),
    );

    assert.deepEqual(events, [
      { type: "text-delta", text: "Hel" },
      { type: "finish", reason: "stop" },
    ]);
  } finally {
    await server.close();
  }
});

test("treats an abort during the stream as non-retryable", async () => {
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
    ]),
  }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    const controller = new AbortController();
    const streaming = async () => {
      let first = true;
      for await (const event of streamWithRetry(
        provider,
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { signal: controller.signal, policy },
      )) {
        if (first && event.type === "text-delta") {
          controller.abort();
          first = false;
        }
      }
    };
    await assert.rejects(streaming(), (error: unknown) => {
      assert.ok(error instanceof HarnessError);
      assert.equal(error.code, "aborted");
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("does not retry a malformed stream chunk", async () => {
  const server = await startMockServer(() => ({ chunks: ["data: {not json\n\n"] }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await assert.rejects(
      collect(provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal() })),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "provider");
        assert.match(error.message, /invalid stream chunk/);
        return true;
      },
    );
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});
