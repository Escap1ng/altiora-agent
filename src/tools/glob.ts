import { posix, win32 } from "node:path";
import { globToRegExp } from "../util/glob.ts";
import { resolveInside } from "./path-guard.ts";
import { asObject, optionalNumber, requireString, type ToolDefinition } from "./registry.ts";
import { walkFiles } from "./walk.ts";

interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export function matchRelative(pattern: string, relativePath: string, platform: NodeJS.Platform): boolean {
  const candidate = platform === "win32" ? relativePath.toLowerCase() : relativePath;
  const basePattern = platform === "win32" ? pattern.toLowerCase() : pattern;
  if (globToRegExp(basePattern, platform).test(candidate)) return true;
  if (basePattern.startsWith("**/")) {
    return globToRegExp(basePattern.slice(3), platform).test(candidate);
  }
  return false;
}

export const globTool: ToolDefinition<GlobInput> = {
  name: "glob",
  description: "List workspace files whose path matches a glob such as src/**/*.ts.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, * does not cross directories and ** does." },
      path: { type: "string", description: "Directory to search, defaults to the workspace root." },
      limit: { type: "number", description: "Maximum number of files to return." },
    },
    required: ["pattern"],
  },
  parse(input) {
    const record = asObject(input);
    const path = record["path"];
    const limit = optionalNumber(record, "limit");
    return {
      pattern: requireString(record, "pattern"),
      ...(typeof path === "string" ? { path } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
  },
  resources(input, context) {
    return [resolveInside(context.cwd, input.path ?? ".", context.platform)];
  },
  async execute(input, context) {
    const root = resolveInside(context.cwd, input.path ?? ".", context.platform);
    const files = await walkFiles(root);
    const limit = Math.min(input.limit ?? 200, 1000);
    const paths = pathsFor(context.platform);
    const matches: string[] = [];
    for (const file of files) {
      const relative = paths.relative(context.cwd, file).replace(/\\/g, "/");
      if (matchRelative(input.pattern, relative, context.platform)) matches.push(relative);
      if (matches.length >= limit) break;
    }
    matches.sort();
    if (matches.length === 0) return { output: "(no matches)", isError: false, truncated: false };
    return { output: matches.join("\n"), isError: false, truncated: false };
  },
};

function pathsFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}
