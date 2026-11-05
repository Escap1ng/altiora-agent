import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath, resolveInside } from "./path-guard.ts";
import { asObject, requireString, type ToolDefinition } from "./registry.ts";

interface WriteInput {
  path: string;
  content: string;
}

export const writeTool: ToolDefinition<WriteInput> = {
  name: "write",
  description: "Create or overwrite a file with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },
  parse(input) {
    const record = asObject(input);
    return { path: requireString(record, "path"), content: requireString(record, "content") };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path, context.platform)];
  },
  async execute(input, context) {
    const absolute = resolveInside(context.cwd, input.path, context.platform);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, input.content, "utf8");
    } catch (error) {
      return { output: `cannot write ${input.path}: ${(error as Error).message}`, isError: true, truncated: false };
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    return {
      output: `wrote ${bytes} bytes to ${displayPath(context.cwd, absolute, context.platform)}`,
      isError: false,
      truncated: false,
    };
  },
};
