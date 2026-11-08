import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { sessionDirFor } from "../config/paths.ts";
import { FALLBACK_CONTEXT_WINDOW } from "../config/schema.ts";
import { compactMessages, compactionThreshold } from "../core/compaction.ts";
import { toHarnessError } from "../core/errors.ts";
import { runAgent, type RunEvent } from "../core/loop.ts";
import type { Message } from "../core/types.ts";
import { fetchModelLimits } from "../providers/models.ts";
import { computeStats } from "../session/stats.ts";
import { buildRuntime, prepareSession, type SessionSetup } from "./runtime.ts";

export interface ChatIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  version: string;
}

export async function chatCommand(argv: string[], io: ChatIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      model: { type: "string" },
      "base-url": { type: "string" },
      config: { type: "string" },
      "trust-project": { type: "boolean" },
      "api-key-env": { type: "string" },
      "max-steps": { type: "string" },
      "context-window": { type: "string" },
      "permission-mode": { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      resume: { type: "string" },
    },
  });

  const built = await buildRuntime(
    { cwd: io.cwd, env: io.env, stderr: io.stderr, version: io.version },
    values,
  );
  if (!built.ok) return built.code;
  const {
    config,
    provider,
    registry,
    subagentRegistry,
    permissions,
    systemPrompt,
    estimator,
    contextWindow,
    contextWindowSource,
  } = built.runtime;

  let model = config.model;
  let activeWindow = contextWindow;
  let windowSource = contextWindowSource;

  const sessionDirectory = sessionDirFor(io.cwd);
  mkdirSync(sessionDirectory, { recursive: true });

  const openSessionFor = (resumeId: string | undefined): SessionSetup =>
    prepareSession({
      directory: sessionDirectory,
      cwd: io.cwd,
      model,
      version: io.version,
      resumeId,
      forkId: undefined,
    });

  let session: SessionSetup;
  try {
    session = openSessionFor(typeof values.resume === "string" ? values.resume : undefined);
  } catch (error) {
    io.stderr.write(`cannot open session: ${(error as Error).message}\n`);
    return 1;
  }

  const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  let active: AbortController | undefined;

  rl.on("SIGINT", () => {
    if (active !== undefined) {
      active.abort();
      return;
    }
    rl.close();
  });

  io.stdout.write(
    `Altiora interactive. Session ${session.id}. Window ${activeWindow} (${windowSource}). Type /help for commands.\n`,
  );

  let history: Message[] = session.history ?? [];
  let turn = session.turn;

  for (;;) {
    let line: string;
    try {
      line = await rl.question("altiora> ");
    } catch {
      break;
    }
    const input = line.trim();
    if (input === "") continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      io.stdout.write(
        "/new start a fresh session\n" +
          "/stats show session usage and context\n" +
          "/compress summarize the conversation history\n" +
          "/model [name] show or switch the model\n" +
          "/exit quit\n" +
          "anything else runs a turn\n",
      );
      continue;
    }
    if (input === "/stats") {
      const stats = computeStats(session.log.records());
      const estimated = estimator.estimateMessages(history);
      const threshold = compactionThreshold(config.compaction, activeWindow, config.reserveOutputTokens);
      io.stdout.write(
        `turns=${stats.turns} steps=${stats.steps} input=${stats.inputTokens} output=${stats.outputTokens} cached=${stats.cachedInputTokens}\n` +
          `tools=${stats.toolCalls} errors=${stats.toolErrors} denied=${stats.toolDenials} duration=${stats.toolDurationMs}ms compactions=${stats.compactions} permission_denials=${stats.permissionDenials}\n` +
          `context=${estimated}/${activeWindow} threshold=${threshold} source=${windowSource}\n`,
      );
      continue;
    }
    if (input === "/compress") {
      active = new AbortController();
      const controller = active;
      try {
        const outcome = await compactMessages(history, {
          provider,
          model,
          config: config.compaction,
          estimator,
          signal: controller.signal,
          policy: config.retry,
        });
        if (outcome === null) {
          io.stdout.write("nothing to compress\n");
        } else {
          session.log.append({
            t: "compaction",
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
            summary: outcome.summary,
            keptMessages: outcome.kept,
          });
          history = outcome.messages;
          io.stdout.write(`[compacted ${outcome.tokensBefore} -> ${outcome.tokensAfter} estimated tokens]\n`);
        }
      } catch (error) {
        io.stderr.write(`${toHarnessError(error, "provider").message}\n`);
      } finally {
        active = undefined;
      }
      continue;
    }
    if (input === "/model" || input.startsWith("/model ")) {
      const requested = input.slice("/model".length).trim();
      if (requested === "") {
        io.stdout.write(`model ${model} window=${activeWindow} (${windowSource})\n`);
        continue;
      }
      model = requested;
      if (config.contextWindow === "auto") {
        const apiKey = io.env[config.apiKeyEnv];
        const limits =
          apiKey === undefined ? undefined : await fetchModelLimits({ baseUrl: config.baseUrl, apiKey, model });
        activeWindow = limits?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
        windowSource = limits?.contextWindow === undefined ? "fallback" : "models";
      }
      session.log.append({ t: "notice", level: "info", text: `model switched to ${model}` });
      io.stdout.write(`model ${model} window=${activeWindow} (${windowSource})\n`);
      continue;
    }
    if (input === "/new") {
      session = openSessionFor(undefined);
      history = session.history ?? [];
      turn = session.turn;
      io.stdout.write(`new session ${session.id}\n`);
      continue;
    }

    active = new AbortController();
    const controller = active;
    const confirm = async (request: { tool: string; resources: string[]; reason: string }): Promise<boolean> => {
      try {
        const answer = await rl.question(
          `allow ${request.tool} (${request.resources.join(", ") || request.reason})? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      } catch {
        return false;
      }
    };

    try {
      const result = await runAgent(input, {
        provider,
        registry,
        permissions,
        model,
        cwd: io.cwd,
        platform: process.platform,
        signal: controller.signal,
        maxSteps: config.maxSteps,
        maxToolCallsPerStep: config.maxToolCallsPerStep,
        maxOutputChars: config.maxOutputChars,
        bash: config.tools.bash,
        retry: config.retry,
        ...(history.length === 0 ? {} : { history }),
        turn,
        log: session.log,
        systemPrompt,
        estimator,
        compaction: config.compaction,
        contextWindow: activeWindow,
        reserveOutputTokens: config.reserveOutputTokens,
        confirm,
        runSubagent: async (prompt: string) => {
          const nested = await runAgent(prompt, {
            provider,
            registry: subagentRegistry,
            permissions,
            model,
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
          return { text: nested.text, isError: nested.stopReason !== "completed" };
        },
        onEvent: (event: RunEvent) => {
          if (event.type === "text-delta") io.stdout.write(event.text);
          else if (event.type === "tool-call") io.stdout.write(`\n[${event.name}]\n`);
          else if (event.type === "tool-result" && event.isError) {
            io.stdout.write(`[${event.name}] ${event.output.split("\n")[0]}\n`);
          } else if (event.type === "compaction") {
            io.stdout.write(`[compacted ${event.tokensBefore} -> ${event.tokensAfter}]\n`);
          }
        },
      });
      history = result.messages;
      turn += 1;
      io.stdout.write("\n");
      if (result.stopReason !== "completed") {
        io.stdout.write(`stopped: ${result.stopReason}\n`);
      }
    } catch (error) {
      const failure = toHarnessError(error, "provider");
      io.stderr.write(`${failure.message}\n`);
      history = [...history, { role: "user", content: input }];
    } finally {
      active = undefined;
    }
  }

  rl.close();
  return 0;
}
