import { HarnessError, errorFromStatus, toHarnessError } from "../core/errors.ts";
import type { Message, Provider, ProviderEvent, ProviderRequest } from "../core/types.ts";
import { parseSse } from "./sse.ts";

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

interface WireDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: WireToolCall[];
}

interface WireToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: { delta?: WireDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class OpenAiCompatProvider implements Provider {
  readonly id = "openai-compat";
  readonly #options: OpenAiCompatOptions;

  constructor(options: OpenAiCompatOptions) {
    this.#options = options;
  }

  async *stream(request: ProviderRequest, options: { signal: AbortSignal }): AsyncGenerator<ProviderEvent> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const url = `${this.#options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#options.apiKey}`,
          accept: "text/event-stream",
          ...this.#options.headers,
        },
        body: JSON.stringify(toBody(request)),
        signal: options.signal,
      });
    } catch (error) {
      throw toHarnessError(error, "network");
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw errorFromStatus(
        response.status,
        body,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (response.body === null) {
      throw new HarnessError("provider returned an empty body", { code: "provider", retryable: true });
    }

    let finishReason: ProviderEvent | null = null;
    try {
      for await (const data of parseSse(response.body)) {
      if (data === "[DONE]") break;
      let chunk: WireChunk;
      try {
        chunk = JSON.parse(data) as WireChunk;
      } catch (error) {
        throw new HarnessError(`invalid stream chunk: ${data.slice(0, 120)}`, {
          code: "provider",
          cause: error,
        });
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content };
        if (delta?.content) yield { type: "text-delta", text: delta.content };
        for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
          yield {
            type: "tool-call-delta",
            index: call.index ?? position,
            ...(call.id === undefined ? {} : { id: call.id }),
            ...(call.function?.name === undefined ? {} : { name: call.function.name }),
            ...(call.function?.arguments === undefined ? {} : { argsDelta: call.function.arguments }),
          };
        }
        if (choice.finish_reason) {
          finishReason = {
            type: "finish",
            reason:
              choice.finish_reason === "length"
                ? "length"
                : choice.finish_reason === "tool_calls"
                  ? "tool_calls"
                  : "stop",
          };
        }
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
              ? {}
              : { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }),
          },
        };
      }
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw toHarnessError(error, "network");
    }

    yield finishReason ?? { type: "finish", reason: "stop" };
  }
}

function toBody(request: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toProviderMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body["tool_choice"] = request.toolChoice ?? "auto";
  }
  if (request.temperature !== undefined) body["temperature"] = request.temperature;
  if (request.maxOutputTokens !== undefined) body["max_tokens"] = request.maxOutputTokens;
  return body;
}

function toProviderMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.output };
    case "assistant": {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const calls = message.content.filter(
        (part): part is Extract<typeof part, { type: "tool_use" }> => part.type === "tool_use",
      );
      const wire: Record<string, unknown> = {
        role: "assistant",
        content: text === "" ? null : text,
      };
      if (calls.length > 0) {
        wire["tool_calls"] = calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
      }
      if (message.reasoning !== undefined) wire["reasoning_content"] = message.reasoning;
      return wire;
    }
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
