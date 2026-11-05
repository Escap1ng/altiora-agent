import { readFile, writeFile } from "node:fs/promises";
import { displayPath, resolveInside } from "./path-guard.ts";
import { asObject, optionalBoolean, requireString, type ToolDefinition } from "./registry.ts";

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function countOccurrences(text: string, search: string): number {
  if (search === "") return 0;
  return text.split(search).length - 1;
}

export const editTool: ToolDefinition<EditInput> = {
  name: "edit",
  description: "Replace an exact string in a file. The match must be unique unless replace_all is set.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
    required: ["path", "old_string", "new_string"],
  },
  parse(input) {
    const record = asObject(input);
    const replaceAll = optionalBoolean(record, "replace_all");
    return {
      path: requireString(record, "path"),
      old_string: requireString(record, "old_string"),
      new_string: requireString(record, "new_string"),
      ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
    };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path, context.platform)];
  },
  async execute(input, context) {
    const absolute = resolveInside(context.cwd, input.path, context.platform);
    const display = displayPath(context.cwd, absolute, context.platform);
    let original: string;
    try {
      original = await readFile(absolute, "utf8");
    } catch (error) {
      return { output: `cannot read ${display}: ${(error as Error).message}`, isError: true, truncated: false };
    }

    let source = original;
    let normalized = false;
    if (countOccurrences(source, input.old_string) === 0) {
      const lf = original.replace(/\r\n/g, "\n");
      if (countOccurrences(lf, input.old_string) > 0) {
        source = lf;
        normalized = true;
      }
    }

    const matches = countOccurrences(source, input.old_string);
    if (matches === 0) {
      return { output: `old_string not found in ${display}`, isError: true, truncated: false };
    }
    if (matches > 1 && input.replace_all !== true) {
      return {
        output: `old_string appears ${matches} times in ${display}; pass replace_all or use a longer match`,
        isError: true,
        truncated: false,
      };
    }

    const replaced =
      input.replace_all === true
        ? source.split(input.old_string).join(input.new_string)
        : source.replace(input.old_string, input.new_string);
    const output = normalized ? replaced.replace(/\n/g, "\r\n") : replaced;

    try {
      await writeFile(absolute, output, "utf8");
    } catch (error) {
      return { output: `cannot write ${display}: ${(error as Error).message}`, isError: true, truncated: false };
    }
    return { output: `replaced ${matches} occurrence(s) in ${display}`, isError: false, truncated: false };
  },
};
