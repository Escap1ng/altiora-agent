import type { Message, Part, Usage } from "../core/types.ts";

export const RECORD_VERSION = 1;

interface Base {
  v: number;
  t: string;
  ts: number;
}

export type Rec =
  | (Base & {
      t: "session/start";
      id: string;
      cwd: string;
      model: string;
      provider: string;
      harnessVersion: string;
    })
  | (Base & { t: "turn/start"; turn: number; input: string })
  | (Base & { t: "step/start"; step: number })
  | (Base & {
      t: "assistant/attempt";
      step: number;
      status: "ok" | "failed" | "aborted";
      content: Part[];
      reasoning?: string;
      usage?: Usage;
    })
  | (Base & { t: "tool/call"; step: number; callId: string; name: string; input: unknown })
  | (Base & {
      t: "permission";
      callId: string;
      tool: string;
      effect: "allow" | "ask" | "deny";
      source: string;
      ruleId?: string;
    })
  | (Base & {
      t: "tool/result";
      step: number;
      callId: string;
      status: "ok" | "error" | "denied";
      output: string;
      truncated: boolean;
      durationMs: number;
    })
  | (Base & { t: "step/end"; step: number; stopReason: string })
  | (Base & {
      t: "compaction";
      tokensBefore: number;
      tokensAfter: number;
      summary: string;
      keptMessages: Message[];
    })
  | (Base & { t: "turn/end"; turn: number; stopReason: string; usage: Usage })
  | (Base & { t: "notice"; level: "info" | "warn"; text: string });

export type RecordType = Rec["t"];

export function serializeRecord(record: Rec): string {
  return `${JSON.stringify(record)}\n`;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "session/start",
  "turn/start",
  "step/start",
  "assistant/attempt",
  "tool/call",
  "permission",
  "tool/result",
  "step/end",
  "compaction",
  "turn/end",
  "notice",
]);

export function parseRecord(line: string): Rec | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["t"] !== "string" || !KNOWN_TYPES.has(record["t"])) return null;
  if (typeof record["v"] !== "number" || record["v"] > RECORD_VERSION) return null;
  if (typeof record["ts"] !== "number") return null;
  return record as unknown as Rec;
}

export function parseRecords(raw: string): Rec[] {
  const records: Rec[] = [];
  for (const line of raw.split("\n")) {
    const record = parseRecord(line);
    if (record !== null) records.push(record);
  }
  return records;
}
