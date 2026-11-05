import { readFile } from "node:fs/promises";
import { resolveInside } from "./path-guard.ts";
import { asObject, requireString, optionalNumber, type ToolDefinition } from "./registry.ts";
import { truncateText } from "./truncate.ts";

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description: "Read a UTF-8 text file from the workspace, optionally a line range.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      offset: { type: "number", description: "First line to read, 1-based." },
      limit: { type: "number", description: "Maximum number of lines." },
    },
    required: ["path"],
  },
  parse(input) {
    const record = asObject(input);
    const path = requireString(record, "path");
    const offset = optionalNumber(record, "offset");
    const limit = optionalNumber(record, "limit");
    return {
      path,
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { limit }),
    };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path, context.platform)];
  },
  async execute(input, context) {
    const absolute = resolveInside(context.cwd, input.path, context.platform);
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch (error) {
      return {
        output: `cannot read ${input.path}: ${(error as Error).message}`,
        isError: true,
        truncated: false,
      };
    }
    let text = content;
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, (input.offset ?? 1) - 1);
      const end = input.limit === undefined ? lines.length : start + input.limit;
      text = lines.slice(start, end).join("\n");
    }
    const result = truncateText(text, context.maxOutputChars);
    return {
      output: result.text === "" ? "(empty file)" : result.text,
      isError: false,
      truncated: result.truncated,
    };
  },
};
