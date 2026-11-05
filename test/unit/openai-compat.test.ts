import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessError } from "../../src/core/errors.ts";
import type { ProviderEvent } from "../../src/core/types.ts";
import { OpenAiCompatProvider } from "../../src/providers/openai-compat.ts";
import { streamWithRetry } from "../../src/providers/retry.ts";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

const signal = (): AbortSignal => new AbortController().signal;

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("streams text deltas, usage and finish", async () => {
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]),
  }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "test-key" });
    const events = await collect(
      provider.stream(
        { model: "test-model", messages: [{ role: "user", content: "hi" }] },
        { signal: signal() },
      ),
    );

    assert.deepEqual(events, [
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
      { type: "finish", reason: "stop" },
    ]);

    const body = server.requests[0]?.body;
    assert.equal(body?.["model"], "test-model");
    assert.equal(body?.["stream"], true);
    assert.deepEqual(body?.["stream_options"], { include_usage: true });
    assert.deepEqual(body?.["messages"], [{ role: "user", content: "hi" }]);
    assert.equal(server.requests[0]?.headers.authorization, "Bearer test-key");
  } finally {
    await server.close();
  }
});

test("emits tool call deltas with partial arguments", async () => {
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: "tool_calls" },
        ],
      },
    ]),
  }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    const events = await collect(
      provider.stream({ model: "m", messages: [{ role: "user", content: "read" }] }, { signal: signal() }),
    );

    assert.deepEqual(events, [
      { type: "tool-call-delta", index: 0, id: "call_1", name: "read", argsDelta: '{"pa' },
      { type: "tool-call-delta", index: 0, argsDelta: 'th":"a.ts"}' },
      { type: "finish", reason: "tool_calls" },
    ]);
  } finally {
    await server.close();
  }
});

test("round-trips reasoning_content on assistant messages", async () => {
  const server = await startMockServer(() => ({ chunks: sseChunks([{ choices: [{ delta: {}, finish_reason: "stop" }] }]) }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await collect(
      provider.stream(
        {
          model: "m",
          messages: [
            { role: "assistant", content: [{ type: "text", text: "done" }], reasoning: "I thought about it" },
            { role: "user", content: "next" },
          ],
        },
        { signal: signal() },
      ),
    );

    const messages = server.requests[0]?.body?.["messages"] as Record<string, unknown>[];
    assert.equal(messages[0]?.["role"], "assistant");
    assert.equal(messages[0]?.["reasoning_content"], "I thought about it");
    assert.equal(messages[0]?.["content"], "done");
  } finally {
    await server.close();
  }
});

test("sends tool declarations in the request body", async () => {
  const server = await startMockServer(() => ({ chunks: sseChunks([{ choices: [{ delta: {}, finish_reason: "stop" }] }]) }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await collect(
      provider.stream(
        {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
        },
        { signal: signal() },
      ),
    );

    const body = server.requests[0]?.body;
    assert.deepEqual(body?.["tools"], [
      { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } },
    ]);
    assert.equal(body?.["tool_choice"], "auto");
  } finally {
    await server.close();
  }
});

test("maps authentication failures to a non-retryable error", async () => {
  const server = await startMockServer(() => ({ status: 401, body: "bad key" }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "nope" });
    await assert.rejects(
      collect(provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }] }, { signal: signal() })),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "auth");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("retries a rate-limited request before any token is emitted", async () => {
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { status: 429, headers: { "retry-after": "0" }, body: "slow down" }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]) },
  );
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    const events = await collect(
      streamWithRetry(
        provider,
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { signal: signal(), policy: { maxAttempts: 3, baseDelayMs: 5 } },
      ),
    );

    assert.equal(server.requests.length, 2);
    assert.deepEqual(events[0], { type: "text-delta", text: "ok" });
  } finally {
    await server.close();
  }
});

test("gives up after the attempt limit", async () => {
  const server = await startMockServer(() => ({ status: 503, body: "unavailable" }));
  try {
    const provider = new OpenAiCompatProvider({ baseUrl: server.url, apiKey: "k" });
    await assert.rejects(
      collect(
        streamWithRetry(
          provider,
          { model: "m", messages: [{ role: "user", content: "hi" }] },
          { signal: signal(), policy: { maxAttempts: 2, baseDelayMs: 1 } },
        ),
      ),
      (error: unknown) => error instanceof HarnessError && error.code === "server",
    );
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});
