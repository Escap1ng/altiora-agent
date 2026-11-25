export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data: unknown;
}

export type JsonRpcMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId | null; result: unknown; error: JsonRpcError | null };

export type FrameResult =
  | { kind: "message"; message: JsonRpcMessage }
  | { kind: "invalid"; reason: string };

function snippet(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function invalid(reason: string, text: string): FrameResult {
  return { kind: "invalid", reason: `${reason}: ${snippet(text)}` };
}

export function parseFrame(line: string): FrameResult | null {
  const text = line.trim();
  if (text === "") return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("invalid json frame", text);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("frame is not a json object", text);
  }
  const record = value as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0") {
    return invalid("frame is not json-rpc 2.0", text);
  }

  const method = record["method"];
  const id = record["id"];
  if (typeof method === "string") {
    if (id === undefined) {
      return { kind: "message", message: { kind: "notification", method, params: record["params"] } };
    }
    if (typeof id === "string" || typeof id === "number") {
      return { kind: "message", message: { kind: "request", id, method, params: record["params"] } };
    }
    return invalid("request id must be a string or number", text);
  }

  if ("result" in record || "error" in record) {
    if (id !== null && typeof id !== "string" && typeof id !== "number") {
      return invalid("response id must be a string, number or null", text);
    }
    let error: JsonRpcError | null = null;
    const rawError = record["error"];
    if (rawError !== undefined && rawError !== null) {
      if (typeof rawError !== "object" || Array.isArray(rawError)) {
        return invalid("error must be an object", text);
      }
      const errorRecord = rawError as Record<string, unknown>;
      const code = errorRecord["code"];
      const message = errorRecord["message"];
      if (typeof code !== "number" || typeof message !== "string") {
        return invalid("error needs a numeric code and a string message", text);
      }
      error = { code, message, data: errorRecord["data"] };
    }
    return { kind: "message", message: { kind: "response", id, result: record["result"], error } };
  }

  return invalid("frame has no method, result or error", text);
}

export function encodeFrame(message: JsonRpcMessage): string {
  let wire: Record<string, unknown>;
  if (message.kind === "request") {
    wire = { jsonrpc: "2.0", id: message.id, method: message.method };
    if (message.params !== undefined) wire["params"] = message.params;
  } else if (message.kind === "notification") {
    wire = { jsonrpc: "2.0", method: message.method };
    if (message.params !== undefined) wire["params"] = message.params;
  } else {
    wire = { jsonrpc: "2.0", id: message.id };
    if (message.error !== null) {
      const error: Record<string, unknown> = { code: message.error.code, message: message.error.message };
      if (message.error.data !== undefined) error["data"] = message.error.data;
      wire["error"] = error;
    } else {
      wire["result"] = message.result ?? null;
    }
  }
  return `${JSON.stringify(wire)}\n`;
}

export async function* parseFrames(stream: AsyncIterable<Uint8Array>): AsyncGenerator<FrameResult> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const result = parseFrame(line);
      if (result !== null) yield result;
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const result = parseFrame(buffer);
  if (result !== null) yield result;
}