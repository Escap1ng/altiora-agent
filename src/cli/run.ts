import { mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sessionDirFor } from "../config/paths.ts";
import { toHarnessError } from "../core/errors.ts";
import { runAgent, type RunEvent } from "../core/loop.ts";
import { createStreamJsonRenderer, type ResultSummary } from "./render/stream-json.ts";
import { buildRuntime, prepareSession, type SessionSetup } from "./runtime.ts";

export interface RunIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  version: string;
}

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
      "context-window": { type: "string" },
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

  const built = await buildRuntime(
    { cwd: io.cwd, env: io.env, stderr: io.stderr, version: io.version },
    values,
  );
  if (!built.ok) return built.code;
  const {
    config,
    mode,
    provider,
    registry,
    subagentRegistry,
    permissions,
    systemPrompt,
    estimator,
    contextWindow,
    contextWindowSource,
  } = built.runtime;
  if (values.verbose === true) {
    io.stderr.write(`[context] window=${contextWindow} source=${contextWindowSource}\n`);
  }

  const sessionDir = sessionDirFor(io.cwd);
  mkdirSync(sessionDir, { recursive: true });
  let session: SessionSetup;
  try {
    session = prepareSession({
      directory: sessionDir,
      cwd: io.cwd,
      model: config.model,
      version: io.version,
      resumeId: typeof values.resume === "string" ? values.resume : undefined,
      forkId: typeof values.fork === "string" ? values.fork : undefined,
    });
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const controller = new AbortController();

  const runSubagent = async (prompt: string): Promise<{ text: string; isError: boolean }> => {
    const result = await runAgent(prompt, {
      provider,
      registry: subagentRegistry,
      permissions,
      model: config.model,
      cwd: io.cwd,
      platform: process.platform,
      signal: controller.signal,
      maxSteps: Math.min(config.maxSteps, 20),
      maxToolCallsPerStep: config.maxToolCallsPerStep,
      maxOutputChars: config.maxOutputChars,
      bash: config.tools.bash,
      retry: config.retry,
      systemPrompt,
    });
    return { text: result.text, isError: result.stopReason !== "completed" };
  };

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
      contextWindow: contextWindow,
      reserveOutputTokens: config.reserveOutputTokens,
      runSubagent,
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
