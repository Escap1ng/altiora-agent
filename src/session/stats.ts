import type { Rec } from "./records.ts";

export interface SessionStats {
  turns: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCalls: number;
  toolErrors: number;
  toolDenials: number;
  toolDurationMs: number;
  compactions: number;
  permissionDenials: number;
}

export function computeStats(records: Rec[]): SessionStats {
  const stats: SessionStats = {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolDenials: 0,
    toolDurationMs: 0,
    compactions: 0,
    permissionDenials: 0,
  };

  for (const record of records) {
    switch (record.t) {
      case "turn/end":
        stats.turns += 1;
        stats.inputTokens += record.usage.inputTokens;
        stats.outputTokens += record.usage.outputTokens;
        break;
      case "step/start":
        stats.steps += 1;
        break;
      case "assistant/attempt":
        stats.cachedInputTokens += record.usage?.cachedInputTokens ?? 0;
        break;
      case "tool/call":
        stats.toolCalls += 1;
        break;
      case "tool/result":
        stats.toolDurationMs += record.durationMs;
        if (record.status === "error") stats.toolErrors += 1;
        if (record.status === "denied") stats.toolDenials += 1;
        break;
      case "compaction":
        stats.compactions += 1;
        break;
      case "permission":
        if (record.effect === "deny") stats.permissionDenials += 1;
        break;
      default:
        break;
    }
  }

  return stats;
}
