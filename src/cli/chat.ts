import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { sessionDirFor } from "../config/paths.ts";
import { toHarnessError } from "../core/errors.ts";
import { runAgent, type RunEvent } from "../core/loop.ts";
import type { Message } from "../core/types.ts";
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

  const sessionDirectory = sessionDirFor(io.cwd);
  mkdirSync(sessionDirectory, { recursive: true });

  const openSessionFor = (resumeId: string | undefined): SessionSetup =>
    prepareSession({
      directory: sessionDirectory,
      cwd: io.cwd,
      model: config.model,
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
    `Altiora interactive. Session ${session.id}. Window ${contextWindow} (${contextWindowSource}). Type /help for commands.\n`,
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
      io.stdout.write("/new start a fresh session\n/exit quit\nanything else runs a turn\n");
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
        model: config.model,
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
        contextWindow: contextWindow,
        reserveOutputTokens: config.reserveOutputTokens,
        confirm,
        runSubagent: async (prompt: string) => {
          const nested = await runAgent(prompt, {
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
