import { readFileSync } from "node:fs";
import type { StdioTransport } from "./transport.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_TIMEOUT_MS = 30000;

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  isError: boolean;
}

export interface McpClientOptions {
  transport: StdioTransport;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const transport = options.transport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  let nextId = 1;
  let closed = false;
  let failure: Error | null = null;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error): void => {
    failure ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const onAbort = (): void => {
    failAll(new Error("mcp request aborted"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const pump = (async () => {
    for await (const frame of transport.frames()) {
      if (closed) break;
      if (frame.kind === "invalid") continue;
      const message = frame.message;
      if (message.kind === "response") {
        if (typeof message.id !== "number") continue;
        const entry = pending.get(message.id);
        if (entry === undefined) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== null) {
          entry.reject(new Error(`mcp ${entry.method} failed: ${message.error.message} (code ${message.error.code})`));
        } else {
          entry.resolve(message.result);
        }
      } else if (message.kind === "request") {
        if (message.method === "ping") {
          transport.send({ kind: "response", id: message.id, result: {}, error: null });
        } else {
          transport.send({
            kind: "response",
            id: message.id,
            result: undefined,
            error: { code: -32601, message: `method not supported: ${message.method}`, data: undefined },
          });
        }
      }
    }
    const exit = await transport.exited;
    const detail = exit.error ?? `code ${exit.code ?? "null"}`;
    failAll(new Error(`mcp server exited before responding (${detail})`));
  })();
  void pump.catch(() => undefined);

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure !== null) return Promise.reject(failure);
    if (closed) return Promise.reject(new Error("mcp client is closed"));
    if (signal?.aborted === true) return Promise.reject(new Error("mcp request aborted"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      if (!transport.send({ kind: "request", id, method, params })) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("mcp server stdin is not writable"));
      }
    });
  };

  return {
    async initialize() {
      let lastError: Error | null = null;
      for (const version of PROTOCOL_VERSIONS) {
        if (failure !== null) throw failure;
        try {
          const result = await request("initialize", {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "altiora", version: pkg.version },
          });
          const record = isRecord(result) ? result : {};
          const negotiated = record["protocolVersion"];
          if (typeof negotiated === "string" && PROTOCOL_VERSIONS.includes(negotiated)) {
            transport.send({ kind: "notification", method: "notifications/initialized", params: undefined });
            return;
          }
          lastError = new Error(`mcp server protocol version ${String(negotiated)} is not supported`);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (failure !== null) throw failure;
        }
      }
      throw lastError ?? new Error("mcp initialize failed");
    },

    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = await request("tools/list", cursor === undefined ? {} : { cursor });
        const record = isRecord(result) ? result : {};
        const items = record["tools"];
        if (!Array.isArray(items)) throw new Error("mcp tools/list result has no tools array");
        for (const item of items) {
          if (!isRecord(item)) throw new Error("mcp tools/list entry is not an object");
          const name = item["name"];
          if (typeof name !== "string" || name === "") throw new Error("mcp tools/list entry has no name");
          const schema = item["inputSchema"];
          const annotations = isRecord(item["annotations"]) ? item["annotations"] : {};
          tools.push({
            name,
            description: typeof item["description"] === "string" ? item["description"] : "",
            inputSchema: isRecord(schema) ? schema : { type: "object" },
            readOnlyHint: annotations["readOnlyHint"] === true,
          });
        }
        const next = record["nextCursor"];
        cursor = typeof next === "string" && next !== "" ? next : undefined;
      } while (cursor !== undefined);
      return tools;
    },

    async callTool(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      const record = isRecord(result) ? result : {};
      const content = record["content"];
      if (!Array.isArray(content)) throw new Error(`mcp tools/call result for ${name} has no content array`);
      return { content: content.filter(isRecord), isError: record["isError"] === true };
    },

    close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      failAll(new Error("mcp client is closed"));
    },
  };
}