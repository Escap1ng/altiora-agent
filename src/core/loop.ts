import type { CompactionConfig } from "../config/schema.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import { streamWithRetry, type RetryPolicy } from "../providers/retry.ts";
import type { SessionLog } from "../session/log.ts";
import type { ToolContext, ToolRegistry } from "../tools/registry.ts";
import { compactMessages, shouldCompact } from "./compaction.ts";
import { HarnessError } from "./errors.ts";
import { TokenEstimator } from "./tokens.ts";
import type { Message, Part, Provider, ProviderRequest, Usage } from "./types.ts";

export type StopReason = "completed" | "max_steps" | "loop_detected" | "failed";

export type RunEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: string; isError: boolean; denied: boolean }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number }
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
  history?: Message[];
  turn?: number;
  systemPrompt?: string;
  estimator?: TokenEstimator;
  compaction?: CompactionConfig;
  contextWindow?: number;
  reserveOutputTokens?: number;
  log?: SessionLog;
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

interface ToolOutcome {
  output: string;
  isError: boolean;
  denied: boolean;
  truncated: boolean;
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
  step: number,
): Promise<ToolOutcome> {
  options.onEvent?.({ type: "tool-call", id: call.id, name: call.name, input: call.input });

  const deny = (output: string): ToolOutcome => {
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output,
      isError: true,
      denied: true,
    });
    return { output, isError: true, denied: true, truncated: false };
  };

  const fail = (output: string): ToolOutcome => {
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output,
      isError: true,
      denied: false,
    });
    return { output, isError: true, denied: false, truncated: false };
  };

  if (call.error !== undefined) return fail(call.error);

  const definition = options.registry.get(call.name);
  if (definition === undefined) return fail(`unknown tool: ${call.name}`);

  let input: unknown;
  try {
    input = definition.parse(call.input);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let resources: string[];
  try {
    resources = definition.resources?.(input, context) ?? [];
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const decision = options.permissions.decide({
    tool: call.name,
    resources,
    readOnly: definition.readOnly === true,
  });
  options.log?.append({
    t: "permission",
    callId: call.id,
    tool: call.name,
    effect: decision.effect,
    source: decision.ruleId === undefined ? "builtin" : "rule",
    ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
  });

  if (decision.effect !== "allow") return deny(`denied: ${decision.reason}`);

  const started = Date.now();
  try {
    const result = await definition.execute(input, context);
    options.log?.append({
      t: "tool/result",
      step,
      callId: call.id,
      status: result.isError ? "error" : "ok",
      output: result.output,
      truncated: result.truncated,
      durationMs: Date.now() - started,
    });
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output: result.output,
      isError: result.isError,
      denied: false,
    });
    return { output: result.output, isError: result.isError, denied: false, truncated: result.truncated };
  } catch (error) {
    const output = error instanceof HarnessError ? error.message : String(error);
    options.log?.append({
      t: "tool/result",
      step,
      callId: call.id,
      status: "error",
      output,
      truncated: false,
      durationMs: Date.now() - started,
    });
    return fail(output);
  }
}

export async function runAgent(input: string, options: LoopOptions): Promise<RunResult> {
  const turn = options.turn ?? 1;
  const messages: Message[] = [...(options.history ?? []), { role: "user", content: input }];
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
  const estimator = options.estimator ?? new TokenEstimator();
  let compacted = false;
  let text = "";
  let settled = false;

  options.log?.append({ t: "turn/start", turn, input });

  const finish = (stopReason: StopReason, step: number): RunResult => {
    settled = true;
    options.log?.append({ t: "turn/end", turn, stopReason, usage });
    options.onEvent?.({ type: "step-end", step, reason: stopReason });
    return { text, messages, usage, stopReason };
  };

  try {
    for (let step = 0; step < options.maxSteps; step++) {
      options.onEvent?.({ type: "step-start", step });
      options.log?.append({ t: "step/start", step });

      let requestMessages: Message[] =
        options.systemPrompt === undefined
          ? messages
          : [{ role: "system", content: options.systemPrompt }, ...messages];
      let estimated = estimator.estimateMessages(requestMessages);

      if (
        options.compaction !== undefined &&
        !compacted &&
        shouldCompact(
          estimated,
          options.compaction,
          options.contextWindow ?? 128000,
          options.reserveOutputTokens ?? 0,
        )
      ) {
        const outcome = await compactMessages(messages, {
          provider: options.provider,
          model: options.model,
          config: options.compaction,
          estimator,
          signal: options.signal,
          policy: options.retry,
        });
        if (outcome !== null) {
          messages.splice(0, messages.length, ...outcome.messages);
          options.log?.append({
            t: "compaction",
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
            summary: outcome.summary,
            keptMessages: outcome.kept,
          });
          options.onEvent?.({
            type: "compaction",
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
          });
          compacted = true;
          requestMessages =
            options.systemPrompt === undefined
              ? messages
              : [{ role: "system", content: options.systemPrompt }, ...messages];
          estimated = estimator.estimateMessages(requestMessages);
        }
      }

      const request: ProviderRequest = {
        model: options.model,
        messages: requestMessages,
        ...(declarations.length === 0 ? {} : { tools: declarations }),
      };

      const result = await collectStep(request, options);
      if (result.usage.inputTokens > 0) estimator.observe(estimated, result.usage.inputTokens);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      text += result.text;
      messages.push({
        role: "assistant",
        content: result.parts,
        ...(result.reasoning === "" ? {} : { reasoning: result.reasoning }),
      });
      options.log?.append({
        t: "assistant/attempt",
        step,
        status: "ok",
        content: result.parts,
        ...(result.reasoning === "" ? {} : { reasoning: result.reasoning }),
        usage: result.usage,
      });

      if (result.toolCalls.length === 0) return finish("completed", step);

      const signature = JSON.stringify(result.toolCalls.map((call) => [call.name, call.input]));
      const count = (repeated.get(signature) ?? 0) + 1;
      repeated.set(signature, count);
      if (count >= 3) return finish("loop_detected", step);

      for (const call of result.toolCalls.slice(0, options.maxToolCallsPerStep)) {
        options.log?.append({ t: "tool/call", step, callId: call.id, name: call.name, input: call.input });
        const outcome = await runTool(call, context, options, step);
        messages.push({ role: "tool", toolCallId: call.id, output: outcome.output, isError: outcome.isError });
      }
      for (const skipped of result.toolCalls.slice(options.maxToolCallsPerStep)) {
        const output = `not executed: more than ${options.maxToolCallsPerStep} tool calls in one step`;
        messages.push({ role: "tool", toolCallId: skipped.id, output, isError: true });
      }

      options.log?.append({ t: "step/end", step, stopReason: "tool_calls" });
      options.onEvent?.({ type: "step-end", step, reason: "tool_calls" });
    }

    return finish("max_steps", options.maxSteps);
  } catch (error) {
    if (!settled) {
      options.log?.append({ t: "turn/end", turn, stopReason: "failed", usage });
    }
    throw error;
  }
}
