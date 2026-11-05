import { toHarnessError } from "../core/errors.ts";
import type { Provider, ProviderEvent, ProviderRequest } from "../core/types.ts";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* streamWithRetry(
  provider: Provider,
  request: ProviderRequest,
  options: { signal: AbortSignal; policy: RetryPolicy },
): AsyncGenerator<ProviderEvent> {
  let emitted = false;
  for (let attempt = 1; ; attempt++) {
    try {
      for await (const event of provider.stream(request, { signal: options.signal })) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      const failure = toHarnessError(error, "provider");
      const canRetry =
        !emitted &&
        failure.retryable &&
        attempt < options.policy.maxAttempts &&
        !options.signal.aborted;
      if (!canRetry) throw failure;
      const waitMs = failure.retryAfterMs ?? options.policy.baseDelayMs * 2 ** (attempt - 1);
      await delay(waitMs, options.signal);
    }
  }
}
