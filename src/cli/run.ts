import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import { HarnessError, toHarnessError } from "../core/errors.ts";
import { OpenAiCompatProvider } from "../providers/openai-compat.ts";
import { streamWithRetry } from "../providers/retry.ts";

export interface RunIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function readPrompt(positionals: string[]): string {
  const joined = positionals.join(" ").trim();
  if (joined === "-") return readFileSync(0, "utf8");
  return joined;
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
      "output-format": { type: "string" },
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

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);

  const provider = new OpenAiCompatProvider({ baseUrl: config.baseUrl, apiKey });
  let wroteText = false;

  try {
    for await (const event of streamWithRetry(
      provider,
      { model: config.model, messages: [{ role: "user", content: prompt }] },
      { signal: controller.signal, policy: config.retry },
    )) {
      if (event.type === "text-delta") {
        wroteText = true;
        io.stdout.write(event.text);
      }
    }
    if (wroteText) io.stdout.write("\n");
    return 0;
  } catch (error) {
    const failure = toHarnessError(error, "provider");
    io.stderr.write(`${failure.message}\n`);
    return failure instanceof HarnessError && failure.code === "aborted" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
