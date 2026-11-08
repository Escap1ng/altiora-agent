import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!name.endsWith(".d.ts")) continue;
    const source = readFileSync(path, "utf8");
    const rewritten = source.replace(/\.ts(["'])/g, ".js$1");
    if (rewritten !== source) writeFileSync(path, rewritten, "utf8");
  }
}

walk(dist);
