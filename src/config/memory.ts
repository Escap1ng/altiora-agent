import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isInside } from "../tools/path-guard.ts";

const FILE_NAME = "AGENTS.md";
const MAX_DEPTH = 4;
const DEFAULT_BUDGET = 48000;

export interface MemoryOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  globalFile?: string;
  maxChars?: number;
}

export interface MemoryResult {
  text: string;
  files: string[];
  truncated: boolean;
}

function readText(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function findRepoRoot(cwd: string): string {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export function discoverMemoryFiles(cwd: string, repoRoot: string): string[] {
  const files: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    const candidate = join(current, FILE_NAME);
    if (existsSync(candidate)) files.push(candidate);
    if (current === repoRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files.reverse();
}

function expand(
  text: string,
  file: string,
  repoRoot: string,
  depth: number,
  platform: NodeJS.Platform,
): string {
  if (depth >= MAX_DEPTH) return text;
  return text
    .split("\n")
    .map((line) => {
      const match = /^@(.+)$/.exec(line.trim());
      if (match === null) return line;
      const target = resolve(dirname(file), match[1]!);
      if (!isInside(repoRoot, target, platform)) {
        return `[skipped import outside the repository: ${match[1]}]`;
      }
      const imported = readText(target);
      if (imported === undefined) return `[missing import: ${match[1]}]`;
      return expand(imported, target, repoRoot, depth + 1, platform);
    })
    .join("\n");
}

export function loadMemory(options: MemoryOptions): MemoryResult {
  const platform = options.platform ?? process.platform;
  const repoRoot = findRepoRoot(options.cwd);
  const files = discoverMemoryFiles(options.cwd, repoRoot);
  const budget = options.maxChars ?? DEFAULT_BUDGET;
  const sections: string[] = [];
  const used: string[] = [];

  const globalFile = options.globalFile;
  if (globalFile !== undefined) {
    const text = readText(globalFile);
    if (text !== undefined && text.trim() !== "") {
      sections.push(`## global\n\n${expand(text, globalFile, repoRoot, 0, platform)}`);
      used.push(globalFile);
    }
  }

  for (const file of files) {
    const text = readText(file);
    if (text === undefined || text.trim() === "") continue;
    sections.push(`## ${relative(repoRoot, file).replace(/\\/g, "/")}\n\n${expand(text, file, repoRoot, 0, platform)}`);
    used.push(file);
  }

  let combined = sections.join("\n\n");
  let truncated = false;
  if (combined.length > budget) {
    combined = `${combined.slice(0, budget)}\n[memory truncated]`;
    truncated = true;
  }
  return { text: combined, files: used, truncated };
}
