import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(desktop, "..", "dist");
const target = join(desktop, "core-dist");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
