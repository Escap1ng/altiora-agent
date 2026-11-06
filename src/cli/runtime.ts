import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import { loadMemory } from "../config/memory.ts";
import { resolveAppPaths } from "../config/paths.ts";
import type { Config, PermissionMode, PermissionRule } from "../config/schema.ts";
import { buildSystemPrompt } from "../core/context.ts";
import { TokenEstimator } from "../core/tokens.ts";
import type { Message } from "../core/types.ts";
import { createPermissionEngine, type PermissionEngine } from "../permissions/engine.ts";
import { parseRuleString } from "../permissions/rules.ts";
import { OpenAiCompatProvider } from "../providers/openai-compat.ts";
import { deriveMessages } from "../session/derive.ts";
import { openSession, sessionPath, type SessionLog } from "../session/log.ts";
import { parseRecords } from "../session/records.ts";
import { createRegistry, type ToolRegistry } from "../tools/registry.ts";
import { defaultTools } from "../tools/index.ts";

export interface RuntimeIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderr: NodeJS.WritableStream;
  version: string;
}

export interface Runtime {
  config: Config;
  mode: PermissionMode;
  provider: OpenAiCompatProvider;
  registry: ToolRegistry;
  subagentRegistry: ToolRegistry;
  permissions: PermissionEngine;
  systemPrompt: string;
  estimator: TokenEstimator;
}

export type RuntimeResult = { ok: true; runtime: Runtime } | { ok: false; code: number };

const MODES: ReadonlySet<string> = new Set(["default", "plan", "unattended"]);

export function buildRuntime(io: RuntimeIo, values: Record<string, unknown>): RuntimeResult {
  let mode: PermissionMode;
  const requestedMode = values["permission-mode"];
  if (requestedMode === undefined) {
    mode = "default";
  } else if (typeof requestedMode === "string" && MODES.has(requestedMode)) {
    mode = requestedMode as PermissionMode;
  } else {
    io.stderr.write(`unknown permission mode: ${String(requestedMode)}\n`);
    return { ok: false, code: 2 };
  }

  const overrides: Partial<Config> = {};
  if (typeof values.model === "string") overrides.model = values.model;
  if (typeof values["base-url"] === "string") overrides.baseUrl = values["base-url"];
  if (typeof values["api-key-env"] === "string") overrides.apiKeyEnv = values["api-key-env"];
  if (typeof values.temperature === "string") overrides.temperature = Number(values.temperature);
  if (typeof values["max-output-tokens"] === "string") {
    overrides.maxOutputTokens = Number(values["max-output-tokens"]);
  }
  if (typeof values["max-steps"] === "string") overrides.maxSteps = Number(values["max-steps"]);

  let loaded;
  try {
    loaded = loadConfig({
      cwd: io.cwd,
      env: io.env,
      configPath: typeof values.config === "string" ? values.config : undefined,
      trustProject: values["trust-project"] === true,
      overrides,
    });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { ok: false, code: 1 };
  }
  const { config, apiKey } = loaded;

  if (config.model === "") {
    io.stderr.write("missing model: pass --model or set ALTIORA_MODEL\n");
    return { ok: false, code: 1 };
  }
  if (apiKey === undefined) {
    io.stderr.write(`missing api key: set ${config.apiKeyEnv}\n`);
    return { ok: false, code: 1 };
  }

  const rules: PermissionRule[] = [...config.permissions.rules];
  const allowRules = Array.isArray(values.allow)
    ? values.allow.filter((value): value is string => typeof value === "string")
    : [];
  const denyRules = Array.isArray(values.deny)
    ? values.deny.filter((value): value is string => typeof value === "string")
    : [];
  for (const [index, rule] of allowRules.entries()) {
    rules.push(parseRuleString(rule, "allow", `cli-allow-${index}`));
  }
  for (const [index, rule] of denyRules.entries()) {
    rules.push(parseRuleString(rule, "deny", `cli-deny-${index}`));
  }

  const allTools = defaultTools();
  const registry = createRegistry(allTools);
  const subagentRegistry = createRegistry(allTools.filter((tool) => tool.name !== "task"));
  const permissions = createPermissionEngine({ mode, rules, cwd: io.cwd, platform: process.platform });
  const provider = new OpenAiCompatProvider({ baseUrl: config.baseUrl, apiKey });
  const memory = loadMemory({
    cwd: io.cwd,
    globalFile: resolveAppPaths(io.env).memoryFile,
    platform: process.platform,
  });
  const systemPrompt = buildSystemPrompt({
    cwd: io.cwd,
    platform: process.platform,
    shell: config.tools.bash.shell,
    memory: memory.text,
  });
  const estimator = new TokenEstimator();

  return {
    ok: true,
    runtime: { config, mode, provider, registry, subagentRegistry, permissions, systemPrompt, estimator },
  };
}

export interface SessionSetup {
  id: string;
  log: SessionLog;
  history: Message[] | undefined;
  turn: number;
}

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export interface SessionOptions {
  directory: string;
  cwd: string;
  model: string;
  version: string;
  resumeId: string | undefined;
  forkId: string | undefined;
}

export function prepareSession(options: SessionOptions): SessionSetup {
  const startRecord = (id: string): SessionSetup => {
    const log = openSession(options.directory, id);
    if (log.records().length === 0) {
      log.append({
        t: "session/start",
        id,
        cwd: options.cwd,
        model: options.model,
        provider: "openai-compat",
        harnessVersion: options.version,
      });
    }
    return { id, log, history: undefined, turn: 1 };
  };

  if (options.resumeId === undefined && options.forkId === undefined) return startRecord(newSessionId());

  const sourceId = options.resumeId ?? options.forkId!;
  const sourcePath = sessionPath(options.directory, sourceId);
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch {
    throw new Error(`session not found: ${sourceId}`);
  }
  const records = parseRecords(raw);
  const history = deriveMessages(records).messages;
  const turn = records.filter((record) => record.t === "turn/start").length + 1;

  if (options.forkId === undefined) {
    return { id: sourceId, log: openSession(options.directory, sourceId), history, turn };
  }

  const id = newSessionId();
  const header = JSON.stringify({
    v: 1,
    ts: Date.now(),
    t: "session/start",
    id,
    cwd: options.cwd,
    model: options.model,
    provider: "openai-compat",
    harnessVersion: options.version,
  });
  writeFileSync(sessionPath(options.directory, id), `${header}\n${raw}`, "utf8");
  return { id, log: openSession(options.directory, id), history, turn };
}
