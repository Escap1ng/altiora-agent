import { asObject, requireString, type ToolDefinition } from "./registry.ts";

interface TaskInput {
  description: string;
  prompt: string;
}

export const taskTool: ToolDefinition<TaskInput> = {
  name: "task",
  description: "Run a focused subagent with a fresh context and return its final answer.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short label for the subagent task." },
      prompt: { type: "string", description: "Complete instructions for the subagent." },
    },
    required: ["description", "prompt"],
  },
  parse(input) {
    const record = asObject(input);
    return { description: requireString(record, "description"), prompt: requireString(record, "prompt") };
  },
  resources() {
    return [];
  },
  async execute(input, context) {
    if (context.runSubagent === undefined) {
      return { output: "subagents are not available in this run", isError: true, truncated: false };
    }
    const result = await context.runSubagent(input.prompt);
    return {
      output: result.text === "" ? "(subagent produced no output)" : result.text,
      isError: result.isError,
      truncated: false,
    };
  },
};
