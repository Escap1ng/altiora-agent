import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveMessages } from "../../src/session/derive.ts";
import type { Rec } from "../../src/session/records.ts";

const ts = 1;

function base(t: Rec["t"]): { v: number; t: Rec["t"]; ts: number } {
  return { v: 1, t, ts };
}

test("projects turns, attempts and tool results in order", () => {
  const records: Rec[] = [
    { ...base("session/start"), t: "session/start", id: "s_1", cwd: "/p", model: "m", provider: "p", harnessVersion: "0.1.0" },
    { ...base("turn/start"), t: "turn/start", turn: 1, input: "hello" },
    { ...base("step/start"), t: "step/start", step: 0 },
    {
      ...base("assistant/attempt"),
      t: "assistant/attempt",
      step: 0,
      status: "ok",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } },
      ],
      reasoning: "thinking",
    },
    { ...base("tool/call"), t: "tool/call", step: 0, callId: "call_1", name: "read", input: { path: "a.ts" } },
    {
      ...base("tool/result"),
      t: "tool/result",
      step: 0,
      callId: "call_1",
      status: "ok",
      output: "contents",
      truncated: false,
      durationMs: 5,
    },
    { ...base("turn/end"), t: "turn/end", turn: 1, stopReason: "completed", usage: { inputTokens: 1, outputTokens: 2 } },
  ];

  const { messages, danglingCalls } = deriveMessages(records);

  assert.equal(danglingCalls.length, 0);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(messages[0]?.role === "user" ? messages[0].content : "", "hello");
  const assistant = messages[1];
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.equal(assistant.reasoning, "thinking");
    assert.equal(assistant.content.length, 2);
  }
  const tool = messages[2];
  assert.equal(tool?.role, "tool");
  if (tool?.role === "tool") {
    assert.equal(tool.toolCallId, "call_1");
    assert.equal(tool.output, "contents");
    assert.equal(tool.isError, false);
  }
});

test("settles a tool call that never returned", () => {
  const records: Rec[] = [
    { ...base("turn/start"), t: "turn/start", turn: 1, input: "go" },
    { ...base("tool/call"), t: "tool/call", step: 0, callId: "call_9", name: "bash", input: {} },
  ];

  const { messages, danglingCalls } = deriveMessages(records);

  assert.deepEqual(danglingCalls, [{ callId: "call_9", name: "bash" }]);
  const tool = messages.at(-1);
  assert.equal(tool?.role, "tool");
  if (tool?.role === "tool") {
    assert.equal(tool.isError, true);
    assert.match(tool.output, /interrupted/);
  }
});

test("skips failed attempts and inserts compaction summaries", () => {
  const records: Rec[] = [
    { ...base("turn/start"), t: "turn/start", turn: 1, input: "go" },
    { ...base("assistant/attempt"), t: "assistant/attempt", step: 0, status: "failed", content: [] },
    {
      ...base("assistant/attempt"),
      t: "assistant/attempt",
      step: 0,
      status: "ok",
      content: [{ type: "text", text: "recovered" }],
    },
    {
      ...base("compaction"),
      t: "compaction",
      tokensBefore: 100,
      tokensAfter: 10,
      summary: "earlier work",
      keptMessages: [],
    },
    { ...base("turn/start"), t: "turn/start", turn: 2, input: "next" },
  ];

  const { messages } = deriveMessages(records);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.equal(messages[0]?.role === "system" ? messages[0].content : "", "Summary of earlier conversation:\nearlier work");
});
