export type ErrorCode =
  | "auth"
  | "rate_limit"
  | "network"
  | "server"
  | "bad_request"
  | "aborted"
  | "provider"
  | "config";

export interface HarnessErrorOptions {
  code: ErrorCode;
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: HarnessErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export function toHarnessError(error: unknown, fallback: ErrorCode = "provider"): HarnessError {
  if (error instanceof HarnessError) return error;
  if (isAbortError(error)) {
    return new HarnessError("request aborted", { code: "aborted", cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HarnessError(message, { code: fallback, retryable: true, cause: error });
}

export function errorFromStatus(status: number, body: string, retryAfterMs?: number): HarnessError {
  const detail = body.trim().slice(0, 500);
  const suffix = detail === "" ? "" : `: ${detail}`;
  const retryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 401 || status === 403) {
    return new HarnessError(`authentication failed (${status})${suffix}`, { code: "auth", status });
  }
  if (status === 429) {
    return new HarnessError(`rate limited (429)${suffix}`, {
      code: "rate_limit",
      status,
      retryable: true,
      ...retryAfter,
    });
  }
  if (status >= 500) {
    return new HarnessError(`provider error (${status})${suffix}`, {
      code: "server",
      status,
      retryable: true,
      ...retryAfter,
    });
  }
  return new HarnessError(`bad request (${status})${suffix}`, { code: "bad_request", status });
}
