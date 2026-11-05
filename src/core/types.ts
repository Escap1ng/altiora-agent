export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: Part[]; reasoning?: string }
  | { role: "tool"; toolCallId: string; output: string; isError: boolean };

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: object;
}

export interface ProviderRequest {
  model: string;
  messages: Message[];
  tools?: ToolDeclaration[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxOutputTokens?: number;
}

export type ProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: "stop" | "length" | "tool_calls" };

export interface Provider {
  readonly id: string;
  stream(request: ProviderRequest, options: { signal: AbortSignal }): AsyncIterable<ProviderEvent>;
}

export interface AssistantText {
  text: string;
  reasoning: string;
}
