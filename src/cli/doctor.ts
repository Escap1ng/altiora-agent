import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import { projectConfigFile, resolveAppPaths, sessionDirFor } from "../config/paths.ts";
import { validateConfig, type Config } from "../config/schema.ts";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  minNode: string;
  configPath?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface DoctorIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  nodeVersion: string;
  minNode: string;
}

const PROVIDER_TIMEOUT_MS = 5000;

function parseVersion(text: string): [number, number, number] | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function meetsMinimum(current: [number, number, number], minimum: [number, number, number]): boolean {
  for (const index of [0, 1, 2] as const) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function checkNode(nodeVersion: string, minNode: string): DoctorCheck {
  const current = parseVersion(nodeVersion);
  const minimum = parseVersion(minNode);
  if (current === undefined || minimum === undefined) {
    return { name: "node", status: "warn", detail: `cannot compare node ${nodeVersion} with ${minNode}` };
  }
  return meetsMinimum(current, minimum)
    ? { name: "node", status: "ok", detail: `${nodeVersion} meets ${minNode}` }
    : { name: "node", status: "error", detail: `${nodeVersion} is older than ${minNode}` };
}

function projectConfigCheck(config: Config, cwd: string, platform: NodeJS.Platform): DoctorCheck | undefined {
  const file = projectConfigFile(cwd, platform);
  if (!existsSync(file)) return undefined;
  const trusted = config.permissions.trustProjectConfig;
  let problems: string[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    problems = validateConfig(parsed);
  } catch (error) {
    problems = [error instanceof Error ? error.message : String(error)];
  }
  if (problems.length > 0) {
    return {
      name: "project-config",
      status: trusted ? "error" : "warn",
      detail: `${file}: ${problems.join("; ")}${trusted ? "" : " (untrusted, ignored)"}`,
    };
  }
  return {
    name: "project-config",
    status: trusted ? "ok" : "warn",
    detail: `${file}${trusted ? " (trusted)" : " present but untrusted; pass --trust-project to apply"}`,
  };
}

function probeWritable(directory: string): void {
  const file = join(directory, `.altiora-doctor-${process.pid}.tmp`);
  writeFileSync(file, "ok");
  rmSync(file, { force: true });
}

function checkWorkspace(cwd: string): DoctorCheck {
  try {
    if (!statSync(cwd).isDirectory()) {
      return { name: "workspace", status: "error", detail: `not a directory: ${cwd}` };
    }
    probeWritable(cwd);
    return { name: "workspace", status: "ok", detail: `writable: ${cwd}` };
  } catch (error) {
    return {
      name: "workspace",
      status: "error",
      detail: `not writable: ${cwd} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function checkSessions(cwd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck {
  const directory = sessionDirFor(cwd, resolveAppPaths(env, platform), platform);
  try {
    mkdirSync(directory, { recursive: true });
    probeWritable(directory);
    const count = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length;
    return { name: "sessions", status: "ok", detail: `writable: ${directory} (${count} sessions)` };
  } catch (error) {
    return {
      name: "sessions",
      status: "error",
      detail: `not writable: ${directory} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

async function checkProvider(
  config: Config,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const base = config.baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { name: "provider", status: "error", detail: `authentication failed (${response.status}) at ${base}` };
    }
    if (!response.ok) {
      return { name: "provider", status: "warn", detail: `unexpected status ${response.status} at ${base}` };
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const data =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)["data"]
        : undefined;
    const count = Array.isArray(data) ? data.length : 0;
    return { name: "provider", status: "ok", detail: `reachable: ${base}/models (${count} models)` };
  } catch (error) {
    return {
      name: "provider",
      status: "warn",
      detail: `unreachable: ${base} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [checkNode(options.nodeVersion, options.minNode)];

  let config: Config | undefined;
  let apiKey: string | undefined;
  try {
    const loaded = loadConfig({
      cwd: options.cwd,
      env: options.env,
      configPath: options.configPath,
      trustProject: false,
    });
    config = loaded.config;
    apiKey = loaded.apiKey;
    const paths = resolveAppPaths(options.env, options.platform);
    const file = options.configPath ?? paths.configFile;
    checks.push({
      name: "config",
      status: "ok",
      detail: existsSync(file) || options.configPath !== undefined ? `loaded: ${file}` : `defaults: ${file} not found`,
    });
    const project = projectConfigCheck(config, options.cwd, options.platform);
    if (project !== undefined) checks.push(project);
  } catch (error) {
    checks.push({
      name: "config",
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (config === undefined) {
    checks.push({ name: "api-key", status: "warn", detail: "skipped: config invalid" });
    checks.push({ name: "provider", status: "warn", detail: "skipped: config invalid" });
  } else {
    if (config.model === "") {
      checks.push({ name: "api-key", status: "warn", detail: "no model configured: pass --model or set ALTIORA_MODEL" });
    } else if (apiKey === undefined) {
      checks.push({ name: "api-key", status: "error", detail: `missing api key: set ${config.apiKeyEnv}` });
    } else {
      checks.push({ name: "api-key", status: "ok", detail: `${config.apiKeyEnv} is set` });
    }
    if (config.model === "" || apiKey === undefined) {
      checks.push({ name: "provider", status: "warn", detail: "skipped: model or api key missing" });
    } else {
      checks.push(await checkProvider(config, apiKey, options.fetchImpl ?? fetch));
    }
  }

  checks.push(checkWorkspace(options.cwd));
  checks.push(checkSessions(options.cwd, options.env, options.platform));
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[], format: "text" | "json"): string {
  if (format === "json") {
    return `${JSON.stringify({ ok: !checks.some((check) => check.status === "error"), checks })}\n`;
  }
  const lines = checks.map((check) => `${check.status.padEnd(5)} ${check.name}: ${check.detail}`);
  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  lines.push(errors === 0 ? `ok: ${checks.length - warnings} checks passed, ${warnings} warnings` : `failed: ${errors} errors, ${warnings} warnings`);
  return `${lines.join("\n")}\n`;
}

export async function doctorCommand(argv: string[], io: DoctorIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      "output-format": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) {
    io.stdout.write(
      "Usage: altiora doctor [--output-format text|json] [--config path]\n\n" +
        "Checks node version, config, api key, provider reachability, workspace and session storage.\n",
    );
    return 0;
  }

  const format = values["output-format"] ?? "text";
  if (format !== "text" && format !== "json") {
    io.stderr.write(`unknown output format: ${String(format)}\n`);
    return 2;
  }

  const checks = await runDoctor({
    cwd: io.cwd,
    env: io.env,
    platform: process.platform,
    nodeVersion: io.nodeVersion,
    minNode: io.minNode,
    configPath: typeof values.config === "string" ? values.config : undefined,
  });
  io.stdout.write(formatDoctor(checks, format));
  return checks.some((check) => check.status === "error") ? 1 : 0;
}
