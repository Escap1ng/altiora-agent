import { readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", "coverage", ".altiora"]);

export interface WalkOptions {
  ignore?: Set<string>;
  limit?: number;
}

export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const ignore = options.ignore ?? DEFAULT_IGNORE;
  const limit = options.limit ?? 5000;
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (ignore.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }

  await walk(root);
  return files;
}
