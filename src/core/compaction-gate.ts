import type { RetryPolicy } from "../providers/retry.ts";
import type { CompactionConfig } from "../config/schema.ts";
import { compactMessages, shouldCompact } from "./compaction.ts";
import type { Message, Provider } from "./types.ts";
import type { TokenEstimator } from "./tokens.ts";
import type { SessionLog } from "../session/log.ts";
import type { RunEvent } from "./loop.ts";

export interface CompactionGateInput {
  messages: Message[];
  requestMessages: Message[];
  compactedAt: number | undefined;
  compaction: CompactionConfig | undefined;
  contextWindow: number;
  reserveOutputTokens: number;
  systemPrompt: string | undefined;
  estimator: TokenEstimator;
  provider: Provider;
  model: string;
  retry: RetryPolicy;
  signal: AbortSignal;
  log?: SessionLog;
  onEvent?: (event: RunEvent) => void;
}

export interface CompactionGateResult {
  messages: Message[];
  requestMessages: Message[];
  compactedAt: number | undefined;
}

export async function runCompactionGate(input: CompactionGateInput): Promise<CompactionGateResult> {
  const unchanged: CompactionGateResult = {
    messages: input.messages,
    requestMessages: input.requestMessages,
    compactedAt: input.compactedAt,
  };
  if (input.compaction === undefined) return unchanged;
  if (input.compactedAt !== undefined && input.messages.length <= input.compactedAt) return unchanged;

  const estimated = input.estimator.estimateMessages(input.requestMessages);
  if (
    !shouldCompact(estimated, input.compaction, input.contextWindow, input.reserveOutputTokens)
  ) {
    return unchanged;
  }

  const outcome = await compactMessages(input.messages, {
    provider: input.provider,
    model: input.model,
    config: input.compaction,
    estimator: input.estimator,
    signal: input.signal,
    policy: input.retry,
  });
  if (outcome === null || outcome.tokensAfter >= outcome.tokensBefore) {
    // disable compaction for the rest of the turn so a failing summary is not retried every step
    return { ...unchanged, compactedAt: Number.MAX_SAFE_INTEGER };
  }

  input.log?.append({
    t: "compaction",
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
    summary: outcome.summary,
    keptMessages: outcome.kept,
  });
  input.onEvent?.({
    type: "compaction",
    tokensBefore: outcome.tokensBefore,
    tokensAfter: outcome.tokensAfter,
  });

  const requestMessages: Message[] =
    input.systemPrompt === undefined
      ? outcome.messages
      : [{ role: "system" as const, content: input.systemPrompt }, ...outcome.messages];
  return { messages: outcome.messages, requestMessages, compactedAt: outcome.messages.length };
}
