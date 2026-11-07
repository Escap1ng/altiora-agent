import { streamWithRetry, type RetryPolicy } from "../providers/retry.ts";
import type { Part, Provider, ProviderRequest, Usage } from "./types.ts";

export interface PendingCall {
  id?: string;
  name?: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  error?: string;
}

export interface StepOutput {
  parts: Part[];
  text: string;
  reasoning: string;
  usage: Usage;
  toolCalls: ToolCall[];
}

export interface StepCollectorOptions {
  provider: Provider;
  retry: RetryPolicy;
  signal: AbortSignal;
  onEvent?: (event: { type: "text-delta"; text: string } | { type: "reasoning-delta"; text: string }) => void;
}

export async function collectStep(request: ProviderRequest, options: StepCollectorOptions): Promise<StepOutput> {
  const pending = new Map<number, PendingCall>();
  let text = "";
  let reasoning = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for await (const event of streamWithRetry(options.provider, request, {
    signal: options.signal,
    policy: options.retry,
  })) {
    switch (event.type) {
      case "text-delta":
        text += event.text;
        options.onEvent?.({ type: "text-delta", text: event.text });
        break;
      case "reasoning-delta":
        reasoning += event.text;
        options.onEvent?.({ type: "reasoning-delta", text: event.text });
        break;
      case "tool-call-delta": {
        const call = pending.get(event.index) ?? { arguments: "" };
        if (event.id !== undefined) call.id = event.id;
        if (event.name !== undefined) call.name = event.name;
        if (event.argsDelta !== undefined) call.arguments += event.argsDelta;
        pending.set(event.index, call);
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      case "finish":
        break;
    }
  }

  const parts: Part[] = [];
  if (text !== "") parts.push({ type: "text", text });

  const toolCalls: ToolCall[] = [];
  for (const [index, call] of [...pending.entries()].sort(([left], [right]) => left - right)) {
    if (call.name === undefined) continue;
    const id = call.id ?? `call_${index}`;
    if (call.arguments.trim() === "") {
      toolCalls.push({ id, name: call.name, input: {} });
      parts.push({ type: "tool_use", id, name: call.name, input: {} });
      continue;
    }
    try {
      const input: unknown = JSON.parse(call.arguments);
      toolCalls.push({ id, name: call.name, input });
      parts.push({ type: "tool_use", id, name: call.name, input });
    } catch (error) {
      toolCalls.push({
        id,
        name: call.name,
        input: {},
        error: `invalid tool arguments: ${(error as Error).message}`,
      });
    }
  }

  return { parts, text, reasoning, usage, toolCalls };
}
