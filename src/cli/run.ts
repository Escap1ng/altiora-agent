import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import type { Config, PermissionMode, PermissionRule } from "../config/schema.ts";
import { toHarnessError } from "../core/errors.ts";
import { runAgent, type RunEvent } from "../core/loop.ts";
import { createPermissionEngine } from "../permissions/engine.ts";
import { parseRuleString } from "../permissions/rules.ts";
import { OpenAiCompatProvider } from "../providers/openai-compat.ts";
import { createRegistry } from "../tools/registry.ts";
import { defaultTools } from "../tools/index.ts";

export interface RunIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const MODES: ReadonlySet<string> = new Set(["default", "plan", "unattended"]);

function readPrompt(positionals: string[]): string {
  const joined = positionals.join(" ").trim();
  if (joined === "-") return readFileSync(0, "utf8");
  return joined;
}

function summarize(event: Extract<RunEvent, { type: "tool-call" }>): string {
  const input = event.input;
  if (typeof input === "object" && input !== null) {
    for (const key of ["path", "command", "pattern"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string") return `${event.name} ${value}`;
    }
  }
  return event.name;
}

export async function runCommand(argv: string[], io: RunIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      model: { type: "string" },
      "base-url": { type: "string" },
      config: { type: "string" },
      "trust-project": { type: "boolean" },
      "api-key-env": { type: "string" },
      temperature: { type: "string" },
      "max-output-tokens": { type: "string" },
      "max-steps": { type: "string" },
      "permission-mode": { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      "output-format": { type: "string" },
      verbose: { type: "boolean" },
    },
  });

  const prompt = readPrompt(positionals);
  if (prompt === "") {
    io.stderr.write("usage: altiora run <prompt> [options]\n");
    return 2;
  }
  if (values["output-format"] !== undefined && values["output-format"] !== "text") {
    io.stderr.write(`unsupported output format: ${String(values["output-format"])}\n`);
    return 2;
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

  let mode: PermissionMode;
  const requestedMode = values["permission-mode"];
  if (requestedMode === undefined) {
    mode = "default";
  } else if (typeof requestedMode === "string" && MODES.has(requestedMode)) {
    mode = requestedMode as PermissionMode;
  } else {
    io.stderr.write(`unknown permission mode: ${String(requestedMode)}\n`);
    return 2;
  }

  const loaded = loadConfig({
    cwd: io.cwd,
    env: io.env,
    configPath: typeof values.config === "string" ? values.config : undefined,
    trustProject: values["trust-project"] === true,
    overrides,
  });
  const { config, apiKey } = loaded;

  if (config.model === "") {
    io.stderr.write("missing model: pass --model or set ALTIORA_MODEL\n");
    return 1;
  }
  if (apiKey === undefined) {
    io.stderr.write(`missing api key: set ${config.apiKeyEnv}\n`);
    return 1;
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

  const registry = createRegistry(defaultTools());
  const permissions = createPermissionEngine({
    mode,
    rules,
    cwd: io.cwd,
    platform: process.platform,
  });
  const provider = new OpenAiCompatProvider({ baseUrl: config.baseUrl, apiKey });

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);

  let wroteText = false;
  const verbose = values.verbose === true;

  try {
    const result = await runAgent(prompt, {
      provider,
      registry,
      permissions,
      model: config.model,
      cwd: io.cwd,
      platform: process.platform,
      signal: controller.signal,
      maxSteps: config.maxSteps,
      maxToolCallsPerStep: config.maxToolCallsPerStep,
      maxOutputChars: config.maxOutputChars,
      bash: config.tools.bash,
      retry: config.retry,
      onEvent: (event) => {
        if (event.type === "text-delta") {
          wroteText = true;
          io.stdout.write(event.text);
        } else if (event.type === "tool-call") {
          io.stderr.write(`[${summarize(event)}]\n`);
        } else if (event.type === "tool-result" && event.isError) {
          io.stderr.write(`[${event.name}] ${event.output.split("\n")[0]}\n`);
        } else if (verbose && event.type === "step-start") {
          io.stderr.write(`[step ${event.step + 1}]\n`);
        }
      },
    });

    if (wroteText) io.stdout.write("\n");
    if (verbose) {
      io.stderr.write(
        `[usage] input=${result.usage.inputTokens} output=${result.usage.outputTokens} stop=${result.stopReason}\n`,
      );
    }
    if (result.stopReason === "max_steps" || result.stopReason === "loop_detected") {
      io.stderr.write(`stopped: ${result.stopReason}\n`);
      return 4;
    }
    return 0;
  } catch (error) {
    const failure = toHarnessError(error, "provider");
    io.stderr.write(`${failure.message}\n`);
    return failure.code === "aborted" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
