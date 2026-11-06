import type { Message } from "../core/types.ts";
import type { Rec } from "./records.ts";

export interface DerivedHistory {
  messages: Message[];
  danglingCalls: { callId: string; name: string }[];
}

export function deriveMessages(records: Rec[]): DerivedHistory {
  const messages: Message[] = [];
  const pending = new Map<string, string>();

  for (const record of records) {
    switch (record.t) {
      case "turn/start":
        messages.push({ role: "user", content: record.input });
        break;
      case "assistant/attempt":
        if (record.status !== "ok") break;
        messages.push({
          role: "assistant",
          content: record.content,
          ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
        });
        break;
      case "tool/call":
        pending.set(record.callId, record.name);
        break;
      case "tool/result":
        pending.delete(record.callId);
        messages.push({
          role: "tool",
          toolCallId: record.callId,
          output: record.output,
          isError: record.status !== "ok",
        });
        break;
      case "compaction":
        messages.length = 0;
        messages.push({ role: "system", content: `Summary of earlier conversation:\n${record.summary}` });
        messages.push(...record.keptMessages);
        break;
      case "session/start":
      case "step/start":
      case "permission":
      case "step/end":
      case "turn/end":
      case "notice":
        break;
    }
  }

  const danglingCalls = [...pending.entries()].map(([callId, name]) => ({ callId, name }));
  for (const call of danglingCalls) {
    messages.push({
      role: "tool",
      toolCallId: call.callId,
      output: "interrupted: the run ended before this tool returned",
      isError: true,
    });
  }

  return { messages, danglingCalls };
}
