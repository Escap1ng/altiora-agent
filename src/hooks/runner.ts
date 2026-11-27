import { spawn } from "node:child_process";
import type { HookConfig, HookEvent } from "../config/schema.ts";

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_OUTPUT_CHARS = 4000;

export interface HookInvocation {
  tool: string;
  callId: string;
  cwd: string;
}

export interface HookOutcome {
  event: HookEvent;
  command: string[];
  status: "ok" | "error" | "timeout" | "aborted";
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export function matchingHooks(hooks: readonly HookConfig[], event: HookEvent, tool: string): HookConfig[] {
  return hooks.filter(
    (hook) =>
      hook.enabled !== false &&
      hook.event === event &&
      (hook.matcher === undefined || hook.matcher === "*" || hook.matcher === tool),
  );
}

function runHook(
  hook: HookConfig,
  event: HookEvent,
  invocation: HookInvocation,
  signal: AbortSignal,
): Promise<HookOutcome> {
  const started = Date.now();
  const base = { event, command: hook.command };
  if (signal.aborted) return Promise.resolve({ ...base, status: "aborted", exitCode: null, durationMs: 0, output: "" });

  return new Promise((resolve) => {
    const [file, ...args] = hook.command;
    let output = "";
    let forced: "timeout" | "aborted" | undefined;
    let settled = false;

    const settle = (status: HookOutcome["status"], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        ...base,
        status,
        exitCode,
        durationMs: Date.now() - started,
        output: output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : output,
      });
    };

    const child = spawn(file!, args, {
      cwd: invocation.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ALTIORA_HOOK_EVENT: event,
        ALTIORA_TOOL: invocation.tool,
        ALTIORA_CALL_ID: invocation.callId,
        ALTIORA_WORKSPACE: invocation.cwd,
      },
    });

    const collect = (chunk: Buffer): void => {
      if (output.length <= MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const force = (status: "timeout" | "aborted"): void => {
      if (settled || forced !== undefined) return;
      forced = status;
      child.kill();
    };
    const timer = setTimeout(() => force("timeout"), hook.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => force("aborted");
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      output += error.message;
      settle("error", null);
    });
    child.on("close", (code) => {
      settle(forced ?? (code === 0 ? "ok" : "error"), code);
    });
  });
}

export async function runHooks(
  hooks: readonly HookConfig[],
  event: HookEvent,
  invocation: HookInvocation,
  signal: AbortSignal,
): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  for (const hook of matchingHooks(hooks, event, invocation.tool)) {
    outcomes.push(await runHook(hook, event, invocation, signal));
  }
  return outcomes;
}
