import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { displayPath, resolveInside } from "./path-guard.ts";
import { applyHunks } from "./patch-applier.ts";
import { parsePatch, type PatchOp } from "./patch-parser.ts";
import { asObject, requireString, type ToolDefinition } from "./registry.ts";

interface ApplyPatchInput {
  patch: string;
}

type PlannedChange =
  | { kind: "write"; path: string; display: string; content: string }
  | { kind: "delete"; path: string; display: string };

function planPaths(ops: PatchOp[]): string[] {
  const paths: string[] = [];
  for (const op of ops) {
    paths.push(op.path);
    if (op.kind === "update" && op.moveTo !== undefined) paths.push(op.moveTo);
  }
  return paths;
}

function fold(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function addContent(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function summarize(ops: PatchOp[]): string {
  const parts = ops.map((op) => {
    if (op.kind === "add") return `added ${op.path}`;
    if (op.kind === "delete") return `deleted ${op.path}`;
    return op.moveTo === undefined ? `updated ${op.path}` : `moved ${op.path} -> ${op.moveTo}`;
  });
  return `applied patch: ${parts.join(", ")}`;
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput> = {
  name: "apply_patch",
  description: [
    "Apply a patch that can add, update, move and delete multiple files in one call.",
    "Grammar:",
    "*** Begin Patch",
    "*** Add File: path/to/new.ts",
    "+new line",
    "*** Update File: path/to/existing.ts",
    "*** Move to: path/to/renamed.ts",
    "@@ optional anchor hint",
    " context line",
    "-removed line",
    "+added line",
    "*** Delete File: path/to/removed.ts",
    "*** End Patch",
    "Every add or update line needs a prefix: + added, - removed, space kept. Update hunks are matched by exact text and must include at least one context line, so keep them small. Prefer this tool for multi-hunk or multi-file changes; use edit for a single unique replacement.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Patch text using the *** Begin Patch grammar." },
    },
    required: ["patch"],
  },
  parse(input) {
    return { patch: requireString(asObject(input), "patch") };
  },
  resources(input, context) {
    const absolute = planPaths(parsePatch(input.patch)).map((path) =>
      resolveInside(context.cwd, path, context.platform),
    );
    return [...new Set(absolute)];
  },
  async execute(input, context) {
    let ops: PatchOp[];
    try {
      ops = parsePatch(input.patch);
    } catch (error) {
      return { output: (error as Error).message, isError: true, truncated: false };
    }

    const resolve = (path: string): string => resolveInside(context.cwd, path, context.platform);
    const display = (path: string): string => displayPath(context.cwd, path, context.platform);
    const seen = new Map<string, string>();
    const plan: PlannedChange[] = [];

    const register = (absolute: string): string | undefined => {
      const key = fold(absolute, context.platform);
      const label = display(absolute);
      const existing = seen.get(key);
      if (existing !== undefined) return existing;
      seen.set(key, label);
      return undefined;
    };

    for (const op of ops) {
      const absolute = resolve(op.path);
      const label = display(absolute);
      const duplicate = register(absolute);
      if (duplicate !== undefined) {
        return { output: `patch touches ${duplicate} more than once`, isError: true, truncated: false };
      }

      if (op.kind === "add") {
        if (await exists(absolute)) {
          return { output: `add file ${label} already exists`, isError: true, truncated: false };
        }
        plan.push({ kind: "write", path: absolute, display: label, content: addContent(op.lines) });
        continue;
      }

      if (op.kind === "delete") {
        if (!(await exists(absolute))) {
          return { output: `delete file ${label} does not exist`, isError: true, truncated: false };
        }
        plan.push({ kind: "delete", path: absolute, display: label });
        continue;
      }

      let original: string;
      try {
        original = await readFile(absolute, "utf8");
      } catch (error) {
        return { output: `cannot read ${label}: ${(error as Error).message}`, isError: true, truncated: false };
      }

      let content: string;
      try {
        content = applyHunks(original, label, op.hunks);
      } catch (error) {
        return { output: (error as Error).message, isError: true, truncated: false };
      }

      if (op.moveTo === undefined) {
        plan.push({ kind: "write", path: absolute, display: label, content });
        continue;
      }

      const target = resolve(op.moveTo);
      const targetLabel = display(target);
      const samePath = fold(target, context.platform) === fold(absolute, context.platform);
      if (!samePath) {
        const targetDuplicate = register(target);
        if (targetDuplicate !== undefined) {
          return { output: `patch touches ${targetDuplicate} more than once`, isError: true, truncated: false };
        }
        if (await exists(target)) {
          return { output: `move target ${targetLabel} already exists`, isError: true, truncated: false };
        }
        plan.push({ kind: "delete", path: absolute, display: label });
      }
      plan.push({ kind: "write", path: target, display: targetLabel, content });
    }

    try {
      for (const change of plan) {
        if (change.kind === "delete") {
          await unlink(change.path);
        } else {
          await mkdir(dirname(change.path), { recursive: true });
          await writeFile(change.path, change.content, "utf8");
        }
      }
    } catch (error) {
      return { output: `patch write failed: ${(error as Error).message}`, isError: true, truncated: false };
    }

    return { output: summarize(ops), isError: false, truncated: false };
  },
};
