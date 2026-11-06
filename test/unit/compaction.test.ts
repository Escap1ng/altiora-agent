import assert from "node:assert/strict";
import { test } from "node:test";
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
