import type { PermissionEngine } from "../permissions/engine.ts";
import { streamWithRetry, type RetryPolicy } from "../providers/retry.ts";
import type { ToolContext, ToolRegistry } from "../tools/registry.ts";
import { HarnessError } from "./errors.ts";
import type { Message, Part, Provider, ProviderRequest, Usage } from "./types.ts";

export type StopReason = "completed" | "max_steps" | "loop_detected";

export type RunEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: string; isError: boolean; denied: boolean }
  | { type: "step-end"; step: number; reason: StopReason | "tool_calls" };

export interface LoopOptions {
  provider: Provider;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  model: string;
  cwd: string;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxOutputChars: number;
  bash: ToolContext["bash"];
  retry: RetryPolicy;
  onEvent?: (event: RunEvent) => void;
}

export interface RunResult {
  text: string;
  messages: Message[];
  usage: Usage;
  stopReason: StopReason;
}

interface PendingCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  error?: string;
}

interface StepOutput {
  parts: Part[];
  text: string;
  reasoning: string;
  usage: Usage;
  toolCalls: ToolCall[];
}

async function collectStep(request: ProviderRequest, options: LoopOptions): Promise<StepOutput> {
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

async function runTool(
  call: ToolCall,
  context: ToolContext,
  options: LoopOptions,
): Promise<{ output: string; isError: boolean; denied: boolean }> {
  options.onEvent?.({ type: "tool-call", id: call.id, name: call.name, input: call.input });

  if (call.error !== undefined) {
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output: call.error,
      isError: true,
      denied: false,
    });
    return { output: call.error, isError: true, denied: false };
  }

  const definition = options.registry.get(call.name);
  if (definition === undefined) {
    const output = `unknown tool: ${call.name}`;
    options.onEvent?.({ type: "tool-result", id: call.id, name: call.name, output, isError: true, denied: false });
    return { output, isError: true, denied: false };
  }

  let input: unknown;
  try {
    input = definition.parse(call.input);
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "tool-result", id: call.id, name: call.name, output, isError: true, denied: false });
    return { output, isError: true, denied: false };
  }

  let resources: string[];
  try {
    resources = definition.resources?.(input, context) ?? [];
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    options.onEvent?.({ type: "tool-result", id: call.id, name: call.name, output, isError: true, denied: false });
    return { output, isError: true, denied: false };
  }

  const decision = options.permissions.decide({
    tool: call.name,
    resources,
    readOnly: definition.readOnly === true,
  });
  if (decision.effect !== "allow") {
    const output = `denied: ${decision.reason}`;
    options.onEvent?.({ type: "tool-result", id: call.id, name: call.name, output, isError: true, denied: true });
    return { output, isError: true, denied: true };
  }

  try {
    const result = await definition.execute(input, context);
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output: result.output,
      isError: result.isError,
      denied: false,
    });
    return { output: result.output, isError: result.isError, denied: false };
  } catch (error) {
    const output = error instanceof HarnessError ? error.message : String(error);
    options.onEvent?.({ type: "tool-result", id: call.id, name: call.name, output, isError: true, denied: false });
    return { output, isError: true, denied: false };
  }
}

export async function runAgent(prompt: string, options: LoopOptions): Promise<RunResult> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const context: ToolContext = {
    cwd: options.cwd,
    platform: options.platform,
    signal: options.signal,
    maxOutputChars: options.maxOutputChars,
    bash: options.bash,
    todos: [],
  };
  const declarations = options.registry.declarations();
  const repeated = new Map<string, number>();
  let text = "";

  const finish = (stopReason: StopReason, step: number): RunResult => {
    options.onEvent?.({ type: "step-end", step, reason: stopReason });
    return { text, messages, usage, stopReason };
  };

  for (let step = 0; step < options.maxSteps; step++) {
    options.onEvent?.({ type: "step-start", step });
    const request: ProviderRequest = {
      model: options.model,
      messages,
      ...(declarations.length === 0 ? {} : { tools: declarations }),
    };

    const result = await collectStep(request, options);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    text += result.text;
    messages.push({
      role: "assistant",
      content: result.parts,
      ...(result.reasoning === "" ? {} : { reasoning: result.reasoning }),
    });

    if (result.toolCalls.length === 0) return finish("completed", step);

    const signature = JSON.stringify(result.toolCalls.map((call) => [call.name, call.input]));
    const count = (repeated.get(signature) ?? 0) + 1;
    repeated.set(signature, count);
    if (count >= 3) {
      options.onEvent?.({ type: "step-end", step, reason: "loop_detected" });
      return { text, messages, usage, stopReason: "loop_detected" };
    }

    for (const call of result.toolCalls.slice(0, options.maxToolCallsPerStep)) {
      const outcome = await runTool(call, context, options);
      messages.push({ role: "tool", toolCallId: call.id, output: outcome.output, isError: outcome.isError });
    }
    for (const skipped of result.toolCalls.slice(options.maxToolCallsPerStep)) {
      const output = `not executed: more than ${options.maxToolCallsPerStep} tool calls in one step`;
      messages.push({ role: "tool", toolCallId: skipped.id, output, isError: true });
    }

    options.onEvent?.({ type: "step-end", step, reason: "tool_calls" });
  }

  return finish("max_steps", options.maxSteps);
}
