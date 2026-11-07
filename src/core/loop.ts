import type { CompactionConfig } from "../config/schema.ts";
import { runCompactionGate } from "./compaction-gate.ts";
import { TokenEstimator } from "./tokens.ts";
import type { PermissionEngine } from "../permissions/engine.ts";
import type { RetryPolicy } from "../providers/retry.ts";
import type { SessionLog } from "../session/log.ts";
import { collectStep } from "./step.ts";
import { runTool } from "./tool-runner.ts";
import type { ToolContext, ToolRegistry } from "../tools/registry.ts";
import type { Message, Provider, ProviderRequest, Usage } from "./types.ts";

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
  runSubagent?: (prompt: string) => Promise<{ text: string; isError: boolean }>;
  confirm?: (request: {
    tool: string;
    resources: string[];
    reason: string;
  }) => Promise<boolean>;
  log?: SessionLog;
  onEvent?: (event: RunEvent) => void;
}

export interface RunResult {
  text: string;
  messages: Message[];
  usage: Usage;
  stopReason: StopReason;
}

export async function runAgent(input: string, options: LoopOptions): Promise<RunResult> {
  const turn = options.turn ?? 1;
  let messages: Message[] = [...(options.history ?? []), { role: "user", content: input }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const context: ToolContext = {
    cwd: options.cwd,
    platform: options.platform,
    signal: options.signal,
    maxOutputChars: options.maxOutputChars,
    bash: options.bash,
    todos: [],
    ...(options.runSubagent === undefined ? {} : { runSubagent: options.runSubagent }),
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

      const initialRequestMessages: Message[] =
        options.systemPrompt === undefined
          ? messages
          : [{ role: "system", content: options.systemPrompt }, ...messages];

      const gate = await runCompactionGate({
        messages,
        requestMessages: initialRequestMessages,
        compacted,
        compaction: options.compaction,
        contextWindow: options.contextWindow ?? 128000,
        reserveOutputTokens: options.reserveOutputTokens ?? 0,
        systemPrompt: options.systemPrompt,
        estimator,
        provider: options.provider,
        model: options.model,
        retry: options.retry,
        signal: options.signal,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      messages = gate.messages;
      const requestMessages: Message[] = gate.requestMessages;
      compacted = gate.compacted;

      const estimated = estimator.estimateMessages(requestMessages);

      const request: ProviderRequest = {
        model: options.model,
        messages: requestMessages,
        ...(declarations.length === 0 ? {} : { tools: declarations }),
      };

      const result = await collectStep(request, {
        provider: options.provider,
        retry: options.retry,
        signal: options.signal,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
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
        const outcome = await runTool(
          call,
          context,
          {
            registry: options.registry,
            permissions: options.permissions,
            ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
            ...(options.log === undefined ? {} : { log: options.log }),
            ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
          },
          step,
        );
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
