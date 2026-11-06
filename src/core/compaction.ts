import type { CompactionConfig } from "../config/schema.ts";
import type { RetryPolicy } from "../providers/retry.ts";
import { streamWithRetry } from "../providers/retry.ts";
import type { TokenEstimator } from "./tokens.ts";
import type { Message, Provider } from "./types.ts";

export function compactionThreshold(
  config: CompactionConfig,
  contextWindow: number,
  reserveOutputTokens: number,
): number {
  const ceiling = Math.max(0, contextWindow - reserveOutputTokens);
  return Math.max(config.minThresholdTokens, Math.floor(ceiling * config.thresholdRatio));
}

export function shouldCompact(
  estimatedTokens: number,
  config: CompactionConfig,
  contextWindow: number,
  reserveOutputTokens: number,
): boolean {
  if (!config.enabled) return false;
  return estimatedTokens >= compactionThreshold(config, contextWindow, reserveOutputTokens);
}

export interface CompactionSplit {
  prefix: Message[];
  kept: Message[];
}

export function splitForCompaction(
  messages: Message[],
  estimator: TokenEstimator,
  keepTailTokens: number,
): CompactionSplit {
  let tokens = 0;
  let cut = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    tokens += estimator.estimateMessages([message]);
    if (tokens > keepTailTokens) {
      cut = index + 1;
      break;
    }
    cut = index;
  }
  while (cut > 0 && messages[cut]?.role !== "user") cut--;
  return { prefix: messages.slice(0, cut), kept: messages.slice(cut) };
}

function renderMessage(message: Message): string {
  switch (message.role) {
    case "user":
      return `user: ${message.content}`;
    case "assistant": {
      const body = message.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[tool ${part.name} ${JSON.stringify(part.input).slice(0, 400)}]`,
        )
        .join("\n");
      return `assistant: ${body}`;
    }
    case "tool":
      return `tool ${message.toolCallId}${message.isError ? " (error)" : ""}: ${message.output.slice(0, 2000)}`;
    case "system":
      return `system: ${message.content}`;
  }
}

export async function summarize(
  provider: Provider,
  model: string,
  messages: Message[],
  options: { signal: AbortSignal; policy: RetryPolicy },
): Promise<string> {
  const prompt = [
    "Summarize the conversation below for another agent that will continue the work.",
    "Use these sections: Objective, Requirements, Decisions, Work State, Next Move, Relevant Files, Important Context.",
    "Be concrete and short. Keep file paths and commands exactly as written.",
    "",
    messages.map(renderMessage).join("\n\n"),
  ].join("\n");

  let text = "";
  for await (const event of streamWithRetry(
    provider,
    { model, messages: [{ role: "user", content: prompt }] },
    { signal: options.signal, policy: options.policy },
  )) {
    if (event.type === "text-delta") text += event.text;
  }
  return text.trim();
}

export interface CompactionOutcome {
  messages: Message[];
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  kept: Message[];
}

export async function compactMessages(
  messages: Message[],
  options: {
    provider: Provider;
    model: string;
    config: CompactionConfig;
    estimator: TokenEstimator;
    signal: AbortSignal;
    policy: RetryPolicy;
  },
): Promise<CompactionOutcome | null> {
  const tokensBefore = options.estimator.estimateMessages(messages);
  const { prefix, kept } = splitForCompaction(messages, options.estimator, options.config.keepTailTokens);
  if (prefix.length < 2) return null;

  const summary = await summarize(options.provider, options.model, prefix, options);
  if (summary === "") return null;

  const next: Message[] = [
    { role: "system", content: `Summary of earlier conversation:\n${summary}` },
    ...kept,
  ];
  return {
    messages: next,
    summary,
    tokensBefore,
    tokensAfter: options.estimator.estimateMessages(next),
    kept,
  };
}
