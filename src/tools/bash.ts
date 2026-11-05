import { asObject, optionalNumber, requireString, type ToolDefinition } from "./registry.ts";
import { runShell } from "./shell.ts";
import { truncateText } from "./truncate.ts";

interface BashInput {
  command: string;
  timeout_ms?: number;
}

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description: "Run a shell command in the workspace and return its combined output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run. PowerShell on Windows, sh elsewhere, unless configured." },
      timeout_ms: { type: "number", description: "Timeout override in milliseconds." },
    },
    required: ["command"],
  },
  parse(input) {
    const record = asObject(input);
    const timeout = optionalNumber(record, "timeout_ms");
    return {
      command: requireString(record, "command"),
      ...(timeout === undefined ? {} : { timeout_ms: timeout }),
    };
  },
  resources(input) {
    return [input.command];
  },
  async execute(input, context) {
    const result = await runShell({
      command: input.command,
      cwd: context.cwd,
      platform: context.platform,
      shell: context.bash.shell,
      timeoutMs: input.timeout_ms ?? context.bash.timeoutMs,
      signal: context.signal,
    });
    const truncated = truncateText(result.output, context.maxOutputChars);
    const notes: string[] = [];
    if (result.timedOut) notes.push("[timed out]");
    if (result.aborted) notes.push("[aborted]");
    if (result.exitCode !== null && result.exitCode !== 0) notes.push(`[exit ${result.exitCode}]`);
    const body = truncated.text === "" ? "(no output)" : truncated.text;
    return {
      output: notes.length === 0 ? body : `${body}\n${notes.join(" ")}`,
      isError: result.exitCode !== 0 || result.timedOut || result.aborted,
      truncated: truncated.truncated,
    };
  },
};
