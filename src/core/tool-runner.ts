import type { PermissionEngine } from "../permissions/engine.ts";
import type { HookConfig, HookEvent } from "../config/schema.ts";
import { runHooks } from "../hooks/runner.ts";
import type { SessionLog } from "../session/log.ts";
import type { ToolContext, ToolRegistry } from "../tools/registry.ts";
import { HarnessError } from "./errors.ts";
import type { ToolCall } from "./step.ts";
import type { RunEvent } from "./loop.ts";

export interface ToolOutcome {
  output: string;
  isError: boolean;
  denied: boolean;
  truncated: boolean;
}

export interface ToolRunnerOptions {
  registry: ToolRegistry;
  permissions: PermissionEngine;
  hooks?: HookConfig[];
  confirm?: (request: { tool: string; resources: string[]; reason: string }) => Promise<boolean>;
  log?: SessionLog;
  onEvent?: (event: RunEvent) => void;
}

export async function runTool(
  call: ToolCall,
  context: ToolContext,
  options: ToolRunnerOptions,
  step: number,
): Promise<ToolOutcome> {
  const startedAt = Date.now();

  const emitCall = (resources: string[]): void => {
    options.onEvent?.({ type: "tool-call", id: call.id, name: call.name, input: call.input, resources, startedAt });
  };

  const deny = (output: string): ToolOutcome => {
    options.onEvent?.({
      type: "tool-result",
      id: call.id,
      name: call.name,
      output,
      isError: true,
      denied: true,
      durationMs: Date.now() - startedAt,
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
      durationMs: Date.now() - startedAt,
    });
    return { output, isError: true, denied: false, truncated: false };
  };

  if (call.error !== undefined) {
    emitCall([]);
    return fail(call.error);
  }

  const definition = options.registry.get(call.name);
  if (definition === undefined) {
    emitCall([]);
    return fail(`unknown tool: ${call.name}`);
  }

  let input: unknown;
  try {
    input = definition.parse(call.input);
  } catch (error) {
    emitCall([]);
    return fail(error instanceof Error ? error.message : String(error));
  }

  let resources: string[];
  try {
    resources = definition.resources?.(input, context) ?? [];
  } catch (error) {
    emitCall([]);
    return fail(error instanceof Error ? error.message : String(error));
  }
  emitCall(resources);

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

  if (decision.effect === "deny") return deny(`denied: ${decision.reason}`);
  if (decision.effect === "ask") {
    const approved =
      options.confirm === undefined
        ? false
        : await options.confirm({ tool: call.name, resources, reason: decision.reason });
    if (!approved) return deny(`denied: ${decision.reason} (not approved)`);
  }

  if (context.signal.aborted) return fail("not executed: run aborted");

  const runPhase = async (event: HookEvent): Promise<void> => {
    if (options.hooks === undefined || options.hooks.length === 0) return;
    const outcomes = await runHooks(
      options.hooks,
      event,
      { tool: call.name, callId: call.id, cwd: context.cwd },
      context.signal,
    );
    for (const outcome of outcomes) {
      options.log?.append({
        t: "hook",
        callId: call.id,
        tool: call.name,
        event: outcome.event,
        status: outcome.status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        output: outcome.output,
      });
    }
  };

  await runPhase("pre_tool_use");
  if (context.signal.aborted) return fail("not executed: run aborted");

  const started = Date.now();
  let outcome: ToolOutcome;
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
      durationMs: Date.now() - started,
    });
    outcome = { output: result.output, isError: result.isError, denied: false, truncated: result.truncated };
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
    outcome = fail(output);
  }

  await runPhase("post_tool_use");
  return outcome;
}
