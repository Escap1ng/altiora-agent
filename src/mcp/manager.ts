import path from "node:path";
import type { McpServerConfig } from "../config/schema.ts";
import { HarnessError } from "../core/errors.ts";
import { asObject, type ToolContext, type ToolDefinition, type ToolResult } from "../tools/registry.ts";
import { truncateText } from "../tools/truncate.ts";
import { createMcpClient, type McpClient, type McpTool } from "./client.ts";
import { startStdioTransport, type StdioTransport } from "./transport.ts";

export interface McpManagerOptions {
  servers: Record<string, McpServerConfig>;
  cwd: string;
  reservedNames?: Iterable<string>;
}

export interface McpDiscovery {
  tools: ToolDefinition[];
  failures: Array<{ server: string; error: string }>;
}

export interface McpManager {
  discover(): Promise<McpDiscovery>;
  close(): void;
}

interface ServerEntry {
  transport: StdioTransport;
  client: McpClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeName(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function parseInput(schema: Record<string, unknown>, input: unknown): Record<string, unknown> {
  const record = asObject(input);
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in record)) {
        throw new HarnessError(`missing required field: ${key}`, { code: "bad_request" });
      }
    }
  }
  const properties = schema["properties"];
  if (isRecord(properties)) {
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      const spec = properties[key];
      if (!isRecord(spec)) continue;
      const type = spec["type"];
      const matches =
        type === "string"
          ? typeof value === "string"
          : type === "number"
            ? typeof value === "number"
            : type === "integer"
              ? typeof value === "number" && Number.isInteger(value)
              : type === "boolean"
                ? typeof value === "boolean"
                : type === "array"
                  ? Array.isArray(value)
                  : type === "object"
                    ? isRecord(value)
                    : true;
      if (!matches) {
        throw new HarnessError(`${key} must be of type ${String(type)}`, { code: "bad_request" });
      }
    }
  }
  return record;
}

function renderContent(item: Record<string, unknown>): string {
  const type = item["type"];
  if (type === "text") return typeof item["text"] === "string" ? item["text"] : "";
  if (type === "image") return `[image: ${String(item["mimeType"] ?? "unknown")}]`;
  if (type === "resource") {
    const resource = isRecord(item["resource"]) ? item["resource"] : {};
    return `[resource: ${String(resource["uri"] ?? "unknown")}]`;
  }
  return JSON.stringify(item);
}

function wrapTool(server: string, tool: McpTool, client: McpClient, name: string): ToolDefinition {
  const schema = tool.inputSchema;
  const description = tool.description !== "" ? tool.description : `mcp tool ${tool.name} from server ${server}`;
  return {
    name,
    description: `[mcp:${server}] ${description}`,
    parameters: schema,
    readOnly: tool.readOnlyHint,
    parse: (input) => parseInput(schema, input),
    async execute(input, context: ToolContext): Promise<ToolResult> {
      if (context.signal.aborted) {
        return { output: "mcp call aborted", isError: true, truncated: false };
      }
      try {
        const result = await client.callTool(tool.name, asObject(input));
        const text = result.content.map(renderContent).join("\n");
        const truncated = truncateText(text, context.maxOutputChars);
        return { output: truncated.text, isError: result.isError, truncated: truncated.truncated };
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
          truncated: false,
        };
      }
    },
  };
}

export function createMcpManager(options: McpManagerOptions): McpManager {
  const entries = new Map<string, ServerEntry>();
  let discovery: Promise<McpDiscovery> | undefined;

  const connect = async (
    server: string,
    config: McpServerConfig,
  ): Promise<{ server: string; tools: Array<{ tool: McpTool; client: McpClient }>; failures: McpDiscovery["failures"] }> => {
    const transportOptions: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> } = {
      command: config.command,
    };
    if (config.args !== undefined) transportOptions.args = config.args;
    if (config.cwd !== undefined) transportOptions.cwd = path.resolve(options.cwd, config.cwd);
    if (config.env !== undefined) transportOptions.env = config.env;
    const transport = startStdioTransport(transportOptions);
    const clientOptions: { transport: StdioTransport; timeoutMs?: number } = { transport };
    if (config.timeoutMs !== undefined) clientOptions.timeoutMs = config.timeoutMs;
    const client = createMcpClient(clientOptions);
    entries.set(server, { transport, client });
    try {
      await client.initialize();
      const tools = await client.listTools();
      return { server, tools: tools.map((tool) => ({ tool, client })), failures: [] };
    } catch (error) {
      entries.delete(server);
      client.close();
      transport.close();
      return {
        server,
        tools: [],
        failures: [{ server, error: error instanceof Error ? error.message : String(error) }],
      };
    }
  };

  return {
    discover() {
      discovery ??= (async () => {
        const used = new Set<string>(options.reservedNames ?? []);
        const active = Object.entries(options.servers).filter(([, config]) => config.enabled !== false);
        const results = await Promise.all(active.map(([server, config]) => connect(server, config)));
        const tools: ToolDefinition[] = [];
        const failures: McpDiscovery["failures"] = [];
        for (const result of results) {
          failures.push(...result.failures);
          for (const { tool, client } of result.tools) {
            const base = `mcp_${sanitizeName(result.server)}_${sanitizeName(tool.name)}`;
            tools.push(wrapTool(result.server, tool, client, uniqueName(base, used)));
          }
        }
        return { tools, failures };
      })();
      return discovery;
    },
    close() {
      for (const entry of entries.values()) {
        entry.client.close();
        entry.transport.close();
      }
      entries.clear();
    },
  };
}