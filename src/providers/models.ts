export interface ModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface FetchModelLimitsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 3000;
const MAX_REASONABLE_TOKENS = 16_000_000;

function asTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  if (value > MAX_REASONABLE_TOKENS) return undefined;
  return value;
}

// Never throws: any unsupported endpoint or malformed payload falls back to undefined.
export async function fetchModelLimits(options: FetchModelLimitsOptions): Promise<ModelLimits | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    const data =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)["data"]
        : undefined;
    if (!Array.isArray(data)) return undefined;
    const entry = data.find(
      (item: unknown): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>)["id"] === options.model,
    );
    if (entry === undefined) return undefined;
    const contextWindow = asTokenCount(entry["context_window"]) ?? asTokenCount(entry["context_length"]);
    const maxOutputTokens = asTokenCount(entry["max_output"]);
    if (contextWindow === undefined && maxOutputTokens === undefined) return undefined;
    const limits: ModelLimits = {};
    if (contextWindow !== undefined) limits.contextWindow = contextWindow;
    if (maxOutputTokens !== undefined) limits.maxOutputTokens = maxOutputTokens;
    return limits;
  } catch {
    return undefined;
  }
}
