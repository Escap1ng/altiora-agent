import type { RunEvent } from "../../core/loop.ts";

export interface StreamJsonMeta {
  sessionId: string;
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  version: string;
}

interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultView {
  id: string;
  output: string;
  isError: boolean;
}

export interface ResultSummary {
  text: string;
  isError: boolean;
  stopReason: string;
  durationMs: number;
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface StreamJsonRenderer {
  init(): void;
  event(event: RunEvent): void;
  result(summary: ResultSummary): void;
}

export function createStreamJsonRenderer(
  write: (value: unknown) => void,
  meta: StreamJsonMeta,
): StreamJsonRenderer {
  let stepText = "";
  let calls: ToolCallView[] = [];
  let results: ToolResultView[] = [];

  const flush = (): void => {
    const content: unknown[] = [];
    if (stepText !== "") content.push({ type: "text", text: stepText });
    for (const call of calls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    if (content.length > 0) {
      write({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null });
    }
    if (results.length > 0) {
      write({
        type: "user",
        message: {
          role: "user",
          content: results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.output,
            is_error: result.isError,
          })),
        },
        parent_tool_use_id: null,
      });
    }
    stepText = "";
    calls = [];
    results = [];
  };

  return {
    init() {
      write({
        type: "system",
        subtype: "init",
        session_id: meta.sessionId,
        model: meta.model,
        cwd: meta.cwd,
        tools: meta.tools,
        permission_mode: meta.permissionMode,
        harness_version: meta.version,
      });
    },
    event(event) {
      switch (event.type) {
        case "step-start":
          break;
        case "text-delta":
          stepText += event.text;
          break;
        case "tool-call":
          calls.push({ id: event.id, name: event.name, input: event.input });
          break;
        case "tool-result":
          results.push({ id: event.id, output: event.output, isError: event.isError });
          break;
        case "step-end":
          flush();
          break;
        case "compaction":
          write({
            type: "system",
            subtype: "compaction",
            tokens_before: event.tokensBefore,
            tokens_after: event.tokensAfter,
          });
          break;
        case "reasoning-delta":
          break;
      }
    },
    result(summary) {
      const subtype =
        summary.stopReason === "completed"
          ? "success"
          : summary.stopReason === "max_steps"
            ? "error_max_steps"
            : summary.stopReason === "loop_detected"
              ? "error_loop"
              : summary.stopReason === "aborted"
                ? "aborted"
                : "error_provider";
      write({
        type: "result",
        subtype,
        is_error: summary.isError,
        duration_ms: summary.durationMs,
        num_steps: summary.steps,
        usage: {
          input_tokens: summary.usage.inputTokens,
          output_tokens: summary.usage.outputTokens,
        },
        result: summary.text,
        session_id: meta.sessionId,
      });
    },
  };
}
