import assert from "node:assert/strict";
import { test } from "node:test";
import { runCompactionGate } from "../../src/core/compaction-gate.ts";
import { compactMessages, compactionThreshold, shouldCompact, splitForCompaction } from "../../src/core/compaction.ts";
import { TokenEstimator } from "../../src/core/tokens.ts";
import type { Message, Provider, ProviderEvent } from "../../src/core/types.ts";

const config = {
  enabled: true,
  thresholdRatio: 0.85,
  minThresholdTokens: 16000,
  keepTailTokens: 15000,
};

function fakeProvider(text: string): Provider {
  return {
    id: "fake",
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: "text-delta", text };
      yield { type: "finish", reason: "stop" };
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;

test("computes the threshold from the usable window", () => {
  assert.equal(compactionThreshold(config, 128000, 16000), Math.floor(112000 * 0.85));
  assert.equal(compactionThreshold({ ...config, minThresholdTokens: 200000 }, 128000, 16000), 200000);
});

test("ignores the threshold when compaction is disabled", () => {
  assert.equal(shouldCompact(1_000_000, { ...config, enabled: false }, 128000, 0), false);
  assert.equal(shouldCompact(50000, config, 128000, 16000), false);
  assert.equal(shouldCompact(100000, config, 128000, 16000), true);
});

test("keeps a tail that starts at a user message", () => {
  const messages: Message[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "answer one" }] },
    { role: "user", content: "second" },
    { role: "assistant", content: [{ type: "text", text: "answer two" }] },
  ];
  const split = splitForCompaction(messages, new TokenEstimator(), 1);

  assert.equal(split.kept[0]?.role, "user");
  assert.equal(split.kept.length, 2);
  assert.equal(split.prefix.length, 2);
});

test("replaces the prefix with a summary and keeps the tail", async () => {
  const estimator = new TokenEstimator();
  const messages: Message[] = [
    { role: "user", content: "a".repeat(4000) },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(4000) }] },
    { role: "user", content: "recent question" },
  ];

  const outcome = await compactMessages(messages, {
    provider: fakeProvider("Objective: test\nNext Move: continue"),
    model: "m",
    config: { ...config, keepTailTokens: 10 },
    estimator,
    signal: signal(),
    policy: { maxAttempts: 1, baseDelayMs: 1 },
  });

  assert.ok(outcome);
  assert.equal(outcome.messages[0]?.role, "system");
  assert.match(outcome.messages[0]?.role === "system" ? outcome.messages[0].content : "", /test/);
  assert.equal(outcome.kept.at(-1)?.role, "user");
  assert.ok(outcome.tokensAfter < outcome.tokensBefore);
});

test("does not compact when there is no prefix to summarize", async () => {
  const outcome = await compactMessages([{ role: "user", content: "short" }], {
    provider: fakeProvider("summary"),
    model: "m",
    config,
    estimator: new TokenEstimator(),
    signal: signal(),
    policy: { maxAttempts: 1, baseDelayMs: 1 },
  });
  assert.equal(outcome, null);
});

const gateConfig = { enabled: true, thresholdRatio: 1, minThresholdTokens: 1, keepTailTokens: 1 };

function gateMessages(): Message[] {
  return [
    { role: "user", content: "a".repeat(4000) },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(4000) }] },
    { role: "user", content: "recent" },
  ];
}

function gateOptions(provider: Provider, compactedAt: number | undefined) {
  const messages = gateMessages();
  return {
    messages,
    requestMessages: messages,
    compactedAt,
    compaction: gateConfig,
    contextWindow: 10,
    reserveOutputTokens: 0,
    systemPrompt: undefined,
    estimator: new TokenEstimator(),
    provider,
    model: "m",
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    signal: signal(),
  };
}

test("recompacts within one run after the context regrows", async () => {
  let summaries = 0;
  const provider: Provider = {
    id: "counting",
    async *stream(): AsyncGenerator<ProviderEvent> {
      summaries += 1;
      yield { type: "text-delta", text: "summary" };
      yield { type: "finish", reason: "stop" };
    },
  };

  const first = await runCompactionGate(gateOptions(provider, undefined));
  assert.equal(summaries, 1);
  assert.equal(first.compactedAt, first.messages.length);

  const same = await runCompactionGate({
    ...gateOptions(provider, first.compactedAt),
    messages: first.messages,
    requestMessages: first.requestMessages,
  });
  assert.equal(summaries, 1);
  assert.equal(same.compactedAt, first.compactedAt);

  const grown: Message[] = [...first.messages, { role: "user", content: "c".repeat(4000) }];
  const third = await runCompactionGate({
    ...gateOptions(provider, first.compactedAt),
    messages: grown,
    requestMessages: grown,
  });
  assert.equal(summaries, 2);
  assert.ok(third.compactedAt !== undefined && third.compactedAt < grown.length);
});

test("stalls compaction for the rest of the run when summarization fails", async () => {
  let calls = 0;
  const provider: Provider = {
    id: "empty",
    async *stream(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      yield { type: "finish", reason: "stop" };
    },
  };

  const first = await runCompactionGate(gateOptions(provider, undefined));
  assert.equal(calls, 1);
  assert.equal(first.compactedAt, Number.MAX_SAFE_INTEGER);

  const grown: Message[] = [...gateMessages(), { role: "user", content: "c".repeat(4000) }];
  await runCompactionGate({ ...gateOptions(provider, first.compactedAt), messages: grown, requestMessages: grown });
  assert.equal(calls, 1);
});

test("stalls compaction when the summary does not reduce tokens", async () => {
  let calls = 0;
  const provider: Provider = {
    id: "huge",
    async *stream(): AsyncGenerator<ProviderEvent> {
      calls += 1;
      yield { type: "text-delta", text: "x".repeat(20000) };
      yield { type: "finish", reason: "stop" };
    },
  };

  const first = await runCompactionGate(gateOptions(provider, undefined));
  assert.equal(calls, 1);
  assert.equal(first.compactedAt, Number.MAX_SAFE_INTEGER);
});
