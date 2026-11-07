import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectConfigFile, resolveAppPaths } from "../config/paths.ts";
import { DEFAULT_CONFIG, validateConfig, type Config } from "../config/schema.ts";

export interface ConfigCommandIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const OPTIONAL_KEYS: ReadonlySet<string> = new Set(["temperature"]);

function keyIsKnown(path: readonly string[]): boolean {
  if (lookup(DEFAULT_CONFIG, path).found) return true;
  return path.length === 1 && OPTIONAL_KEYS.has(path[0] ?? "");
}

function readUserPartial(path: string): Partial<Config> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid json in config ${path}: ${(error as Error).message}`, { cause: error });
  }
  const problems = validateConfig(parsed);
  if (problems.length > 0) {
    throw new Error(`invalid config ${path}: ${problems.join("; ")}`);
  }
  return parsed as Partial<Config>;
}

type LookupResult = { found: true; value: unknown } | { found: false };

function lookup(root: unknown, path: readonly string[]): LookupResult {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function setAt(root: Record<string, unknown>, path: readonly string[], value: unknown): string | undefined {
  const leafIndex = path.length - 1;
  const leaf = path[leafIndex];
  if (leaf === undefined) return "cannot set an empty key";
  let current: Record<string, unknown> = root;
  for (const key of path.slice(0, leafIndex)) {
    if (!(key in current)) {
      current[key] = {};
    }
    const existing = current[key];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      return `cannot descend into ${key}: it is not an object`;
    }
    current = existing as Record<string, unknown>;
  }
  current[leaf] = value;
  return undefined;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printValue(io: ConfigCommandIo, value: unknown): void {
  io.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

export function configCommand(args: string[], io: ConfigCommandIo): number {
  const [sub] = args;
  const paths = resolveAppPaths(io.env);

  if (sub === undefined || sub === "path") {
    io.stdout.write(`config   ${paths.configFile}\n`);
    io.stdout.write(`memory   ${paths.memoryFile}\n`);
    io.stdout.write(`sessions ${paths.sessionsDir}\n`);
    io.stdout.write(`project  ${projectConfigFile(io.cwd)}\n`);
    return EXIT_OK;
  }

  try {
    if (sub === "get") {
      const user = readUserPartial(paths.configFile);
      const merged = { ...DEFAULT_CONFIG, ...user };
      const rest = args.slice(1).filter((part) => part !== "");
      if (rest.length === 0) {
        io.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
        return EXIT_OK;
      }
      const key = rest.join(".");
      if (!keyIsKnown(key.split("."))) {
        io.stderr.write(`unknown config key: ${key}\n`);
        return EXIT_USAGE;
      }
      const result = lookup(merged, key.split("."));
      if (!result.found) {
        io.stdout.write("not set\n");
        return EXIT_OK;
      }
      printValue(io, result.value);
      return EXIT_OK;
    }

    if (sub === "set") {
      const rest = args.slice(1);
      if (rest[0] === undefined || rest[0] === "" || rest.length < 2) {
        io.stderr.write("usage: altiora config set <key> <value>\n");
        return EXIT_USAGE;
      }
      const path = rest[0].split(".");
      if (!keyIsKnown(path)) {
        io.stderr.write(`unknown config key: ${rest[0]}\n`);
        return EXIT_USAGE;
      }
      const value = parseValue(rest.slice(1).join(" "));

      const user = readUserPartial(paths.configFile);
      const updated: Record<string, unknown> = JSON.parse(JSON.stringify(user));
      const problem = setAt(updated, path, value);
      if (problem !== undefined) {
        io.stderr.write(`${problem}\n`);
        return EXIT_ERROR;
      }

      const problems = validateConfig(updated);
      if (problems.length > 0) {
        io.stderr.write(`invalid value for ${rest[0]}: ${problems.join("; ")}\n`);
        return EXIT_ERROR;
      }

      mkdirSync(dirname(paths.configFile), { recursive: true });
      writeFileSync(paths.configFile, `${JSON.stringify(updated, null, 2)}\n`);
      io.stdout.write(`${rest[0]} = ${JSON.stringify(value)} in ${paths.configFile}\n`);
      return EXIT_OK;
    }
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\n`);
    return EXIT_ERROR;
  }

  io.stderr.write(`unknown config subcommand: ${sub}\n`);
  return EXIT_USAGE;
}
