const mode = process.argv[2] ?? "default";

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const TOOLS = [
  {
    name: "echo",
    description: "echo arguments",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "peek", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

let initCount = 0;
let initialized = false;
let pagedFirst = false;
let pendingList: unknown = null;
const received: Record<string, unknown> = {};

if (mode === "garbage") {
  process.stdout.write("this is not json\n");
}

function listResult(): unknown {
  if (mode === "paged") {
    if (!pagedFirst) {
      pagedFirst = true;
      return { tools: [TOOLS[0]], nextCursor: "c2" };
    }
    return { tools: [TOOLS[1]] };
  }
  if (mode === "server-ping") {
    return { tools: [{ name: "report", description: JSON.stringify(received), inputSchema: { type: "object" } }] };
  }
  if (mode === "cwd-tool") {
    return { tools: [{ name: "where", description: "report cwd", inputSchema: { type: "object" } }] };
  }
  return { tools: TOOLS };
}

function handle(line: string): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const method = record["method"];
  const id = record["id"];

  if (typeof method !== "string") {
    if (typeof id === "string") received[id] = record;
    if (mode === "server-ping" && pendingList !== null && received["srv-1"] && received["srv-2"]) {
      send({ jsonrpc: "2.0", id: pendingList, result: listResult() });
      pendingList = null;
    }
    return;
  }

  if (method === "initialize") {
    initCount += 1;
    if (mode === "hang") return;
    if (mode === "error-init") {
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "initialize rejected" } });
      return;
    }
    if (mode === "always-bad-version" || (mode === "bad-version" && initCount === 1)) {
      send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "mock", version: "0" } },
      });
      return;
    }
    const version = mode === "old-version" || mode === "bad-version" ? "2024-11-05" : "2025-06-18";
    send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } },
    });
    if (mode === "server-ping") {
      send({ jsonrpc: "2.0", id: "srv-1", method: "ping" });
      send({ jsonrpc: "2.0", id: "srv-2", method: "sampling/createMessage", params: {} });
    }
    return;
  }

  if (method === "notifications/initialized") {
    initialized = true;
    return;
  }

  if (method === "tools/list") {
    if (!initialized) {
      send({ jsonrpc: "2.0", id, error: { code: -32002, message: "not initialized" } });
      return;
    }
    if (mode === "server-ping" && !(received["srv-1"] && received["srv-2"])) {
      pendingList = id;
      return;
    }
    send({ jsonrpc: "2.0", id, result: listResult() });
    return;
  }

  if (method === "tools/call") {
    const params = record["params"] as Record<string, unknown> | undefined;
    const name = params?.["name"];
    if (name === "hang") return;
    if (mode === "crash-on-call") {
      setTimeout(() => process.exit(5), 10);
      return;
    }
    if (name === "echo") {
      const args = params?.["arguments"] as Record<string, unknown> | undefined;
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${String(args?.["text"])}` }] } });
      return;
    }
    if (name === "fail") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "tool failed" }], isError: true } });
      return;
    }
    if (name === "where") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: process.cwd() }] } });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handle(line);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));