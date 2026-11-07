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
  compacted: boolean;
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
  compacted: boolean;
}

export async function runCompactionGate(input: CompactionGateInput): Promise<CompactionGateResult> {
  const unchanged: CompactionGateResult = {
    messages: input.messages,
    requestMessages: input.requestMessages,
    compacted: input.compacted,
  };
  if (input.compaction === undefined || input.compacted) return unchanged;

  const estimated = input.estimator.estimateMessages(input.requestMessages);
  if (
    !shouldCompact(estimated, input.compaction, input.contextWindow, input.reserveOutputTokens)
  ) {
    return { ...unchanged, compacted: false };
  }

  const outcome = await compactMessages(input.messages, {
    provider: input.provider,
    model: input.model,
    config: input.compaction,
    estimator: input.estimator,
    signal: input.signal,
    policy: input.retry,
  });
  if (outcome === null) return unchanged;

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
  return { messages: outcome.messages, requestMessages, compacted: true };
}
