import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rec } from "../../src/session/records.ts";
import { computeStats } from "../../src/session/stats.ts";

function record(partial: Record<string, unknown>): Rec {
  return { v: 1, ts: 0, ...partial } as unknown as Rec;
}

test("sums usage, tool activity and denials", () => {
  const stats = computeStats([
    record({ t: "turn/start", turn: 1, input: "hi" }),
    record({ t: "step/start", step: 0 }),
    record({
      t: "assistant/attempt",
      step: 0,
      status: "ok",
      content: [],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 64 },
    }),
    record({ t: "tool/call", step: 0, callId: "c1", name: "bash", input: {} }),
    record({ t: "tool/result", step: 0, callId: "c1", status: "ok", output: "x", truncated: false, durationMs: 12 }),
    record({ t: "tool/result", step: 0, callId: "c2", status: "denied", output: "no", truncated: false, durationMs: 1 }),
    record({ t: "tool/result", step: 0, callId: "c3", status: "error", output: "boom", truncated: false, durationMs: 7 }),
    record({ t: "permission", callId: "c2", tool: "bash", effect: "deny", source: "builtin" }),
    record({ t: "compaction", tokensBefore: 900, tokensAfter: 100, summary: "s", keptMessages: [] }),
    record({ t: "turn/end", turn: 1, stopReason: "completed", usage: { inputTokens: 100, outputTokens: 20 } }),
  ]);

  assert.deepEqual(stats, {
    turns: 1,
    steps: 1,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 64,
    toolCalls: 1,
    toolErrors: 1,
    toolDenials: 1,
    toolDurationMs: 20,
    compactions: 1,
    permissionDenials: 1,
  });
});

test("returns zeros for an empty session", () => {
  const stats = computeStats([]);
  assert.equal(stats.turns, 0);
  assert.equal(stats.cachedInputTokens, 0);
  assert.equal(stats.toolDurationMs, 0);
});
