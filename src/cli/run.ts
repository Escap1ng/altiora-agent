import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import { loadMemory } from "../config/memory.ts";
import { resolveAppPaths, sessionDirFor } from "../config/paths.ts";
import type { Config, PermissionMode, PermissionRule } from "../config/schema.ts";
import { buildSystemPrompt } from "../core/context.ts";
import { toHarnessError } from "../core/errors.ts";
import { runAgent, type RunEvent } from "../core/loop.ts";
import { TokenEstimator } from "../core/tokens.ts";
import type { Message } from "../core/types.ts";
import { createPermissionEngine } from "../permissions/engine.ts";
import { parseRuleString } from "../permissions/rules.ts";
import { OpenAiCompatProvider } from "../providers/openai-compat.ts";
import { deriveMessages } from "../session/derive.ts";
import { openSession, sessionPath, type SessionLog } from "../session/log.ts";
import { parseRecords } from "../session/records.ts";
import { createRegistry } from "../tools/registry.ts";
import { defaultTools } from "../tools/index.ts";
import { createStreamJsonRenderer, type ResultSummary } from "./render/stream-json.ts";

export interface RunIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  version: string;
}

const MODES: ReadonlySet<string> = new Set(["default", "plan", "unattended"]);
const FORMATS: ReadonlySet<string> = new Set(["text", "json", "stream-json"]);

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

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

interface SessionSetup {
  id: string;
  log: SessionLog;
  history: Message[] | undefined;
  turn: number;
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
      resume: { type: "string" },
      fork: { type: "string" },
      verbose: { type: "boolean" },
    },
  });

  const prompt = readPrompt(positionals);
  if (prompt === "") {
    io.stderr.write("usage: altiora run <prompt> [options]\n");
    return 2;
  }

  const format = typeof values["output-format"] === "string" ? values["output-format"] : "text";
  if (!FORMATS.has(format)) {
    io.stderr.write(`unsupported output format: ${format}\n`);
    return 2;
  }
  if (values.resume !== undefined && values.fork !== undefined) {
    io.stderr.write("--resume and --fork cannot be used together\n");
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

  const sessionDir = sessionDirFor(io.cwd);
  mkdirSync(sessionDir, { recursive: true });
  let session: SessionSetup;
  try {
    session = prepareSession(sessionDir, io, config, {
      resumeId: typeof values.resume === "string" ? values.resume : undefined,
      forkId: typeof values.fork === "string" ? values.fork : undefined,
    });
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\n`);
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

  const streamJson =
    format === "stream-json"
      ? createStreamJsonRenderer(
          (value) => io.stdout.write(`${JSON.stringify(value)}\n`),
          {
            sessionId: session.id,
            model: config.model,
            cwd: io.cwd,
            tools: registry.names(),
            permissionMode: mode,
            version: io.version,
          },
        )
      : undefined;
  streamJson?.init();

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);

  const verbose = values.verbose === true;
  const startedAt = Date.now();
  let steps = 0;
  let wroteText = false;

  const usage = { inputTokens: 0, outputTokens: 0 };

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
      ...(session.history === undefined ? {} : { history: session.history }),
      turn: session.turn,
      log: session.log,
      systemPrompt,
      estimator,
      compaction: config.compaction,
      contextWindow: config.contextWindow,
      reserveOutputTokens: config.reserveOutputTokens,
      onEvent: (event) => {
        if (event.type === "step-start") {
          steps += 1;
          if (verbose && format === "text") io.stderr.write(`[step ${event.step + 1}]\n`);
        } else if (event.type === "text-delta") {
          wroteText = true;
          if (format === "text") io.stdout.write(event.text);
        } else if (event.type === "tool-call") {
          if (format === "text") io.stderr.write(`[${summarize(event)}]\n`);
        } else if (event.type === "tool-result" && event.isError) {
          if (format === "text") io.stderr.write(`[${event.name}] ${event.output.split("\n")[0]}\n`);
        } else if (event.type === "compaction" && verbose) {
          io.stderr.write(
            `[compaction] ${event.tokensBefore} -> ${event.tokensAfter} estimated tokens\n`,
          );
        }
        streamJson?.event(event);
      },
    });

    usage.inputTokens = result.usage.inputTokens;
    usage.outputTokens = result.usage.outputTokens;

    const summary: ResultSummary = {
      text: result.text,
      isError: result.stopReason !== "completed",
      stopReason: result.stopReason,
      durationMs: Date.now() - startedAt,
      steps,
      usage,
    };

    if (format === "stream-json") {
      streamJson?.result(summary);
    } else if (format === "json") {
      io.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype:
            result.stopReason === "completed"
              ? "success"
              : result.stopReason === "max_steps"
                ? "error_max_steps"
                : result.stopReason === "loop_detected"
                  ? "error_loop"
                  : "error_provider",
          is_error: summary.isError,
          duration_ms: summary.durationMs,
          num_steps: steps,
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
          result: result.text,
          session_id: session.id,
        })}\n`,
      );
    } else {
      if (wroteText) io.stdout.write("\n");
      if (verbose) {
        io.stderr.write(
          `[usage] input=${usage.inputTokens} output=${usage.outputTokens} stop=${result.stopReason} session=${session.id}\n`,
        );
      }
    }

    if (result.stopReason === "max_steps" || result.stopReason === "loop_detected") {
      if (format === "text") io.stderr.write(`stopped: ${result.stopReason}\n`);
      return 4;
    }
    return 0;
  } catch (error) {
    const failure = toHarnessError(error, "provider");
    streamJson?.result({
      text: "",
      isError: true,
      stopReason: "failed",
      durationMs: Date.now() - startedAt,
      steps,
      usage,
    });
    io.stderr.write(`${failure.message}\n`);
    return failure.code === "aborted" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

function prepareSession(
  directory: string,
  io: RunIo,
  config: Config,
  ids: { resumeId: string | undefined; forkId: string | undefined },
): SessionSetup {
  const start = (id: string): SessionSetup => {
    const log = openSession(directory, id);
    if (log.records().length === 0) {
      log.append({
        t: "session/start",
        id,
        cwd: io.cwd,
        model: config.model,
        provider: "openai-compat",
        harnessVersion: io.version,
      });
    }
    return { id, log, history: undefined, turn: 1 };
  };

  if (ids.resumeId === undefined && ids.forkId === undefined) return start(newSessionId());

  const sourceId = ids.resumeId ?? ids.forkId!;
  const sourcePath = sessionPath(directory, sourceId);
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch {
    throw new Error(`session not found: ${sourceId}`);
  }
  const records = parseRecords(raw);
  const history = deriveMessages(records).messages;
  const turn = records.filter((record) => record.t === "turn/start").length + 1;

  if (ids.forkId === undefined) {
    return { id: sourceId, log: openSession(directory, sourceId), history, turn };
  }

  const id = newSessionId();
  const header = JSON.stringify({
    v: 1,
    ts: Date.now(),
    t: "session/start",
    id,
    cwd: io.cwd,
    model: config.model,
    provider: "openai-compat",
    harnessVersion: io.version,
  });
  writeFileSync(sessionPath(directory, id), `${header}\n${raw}`, "utf8");
  return { id, log: openSession(directory, id), history, turn };
}
