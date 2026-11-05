import { readdir } from "node:fs/promises";
import { asObject, optionalString, type ToolDefinition } from "./registry.ts";
import { displayPath, resolveInside } from "./path-guard.ts";

interface LsInput {
  path?: string;
}

export const lsTool: ToolDefinition<LsInput> = {
  name: "ls",
  description: "List entries in a workspace directory.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, defaults to the workspace root." },
    },
  },
  parse(input) {
    const record = asObject(input);
    const path = optionalString(record, "path");
    return path === undefined ? {} : { path };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path ?? ".", context.platform)];
  },
  async execute(input, context) {
    const absolute = resolveInside(context.cwd, input.path ?? ".", context.platform);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      return { output: `cannot list ${input.path ?? "."}: ${(error as Error).message}`, isError: true, truncated: false };
    }
    if (entries.length === 0) {
      return { output: `(empty directory ${displayPath(context.cwd, absolute, context.platform)})`, isError: false, truncated: false };
    }
    const lines = entries
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .sort((left, right) => left.localeCompare(right));
    return { output: lines.join("\n"), isError: false, truncated: false };
  },
};
