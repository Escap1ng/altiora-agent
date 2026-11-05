import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { asObject, optionalBoolean, optionalString, requireString, type ToolDefinition } from "./registry.ts";
import { resolveInside } from "./path-guard.ts";
import { matchRelative } from "./glob.ts";
import { truncateText } from "./truncate.ts";
import { walkFiles } from "./walk.ts";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  case_sensitive?: boolean;
}

const MAX_MATCHES = 200;

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description: "Search workspace files for a regular expression and return file:line matches.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: { type: "string", description: "Directory to search, defaults to the workspace root." },
      glob: { type: "string", description: "Only search files matching this glob." },
      case_sensitive: { type: "boolean", description: "Match case sensitively." },
    },
    required: ["pattern"],
  },
  parse(input) {
    const record = asObject(input);
    const path = optionalString(record, "path");
    const glob = optionalString(record, "glob");
    const caseSensitive = optionalBoolean(record, "case_sensitive");
    return {
      pattern: requireString(record, "pattern"),
      ...(path === undefined ? {} : { path }),
      ...(glob === undefined ? {} : { glob }),
      ...(caseSensitive === undefined ? {} : { case_sensitive: caseSensitive }),
    };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path ?? ".", context.platform)];
  },
  async execute(input, context) {
    let expression: RegExp;
    try {
      expression = new RegExp(input.pattern, input.case_sensitive === true ? "" : "i");
    } catch (error) {
      return { output: `invalid pattern: ${(error as Error).message}`, isError: true, truncated: false };
    }

    const root = resolveInside(context.cwd, input.path ?? ".", context.platform);
    const paths = context.platform === "win32" ? win32 : posix;
    const files = await walkFiles(root);
    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break;
      const relative = paths.relative(context.cwd, file).replace(/\\/g, "/");
      if (input.glob !== undefined && !matchRelative(input.glob, relative, context.platform)) continue;
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (matches.length >= MAX_MATCHES) break;
        const line = lines[index]!;
        if (expression.test(line)) {
          matches.push(`${relative}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      }
    }

    if (matches.length === 0) return { output: "(no matches)", isError: false, truncated: false };
    const truncated = truncateText(matches.join("\n"), context.maxOutputChars);
    return { output: truncated.text, isError: false, truncated: truncated.truncated };
  },
};
