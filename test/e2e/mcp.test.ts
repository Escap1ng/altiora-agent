import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../mock/mcp-server.ts", import.meta.url));
const cleanups: string[] = [];

after(async () => {
  await Promise.all(cleanups.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "altiora-mcp-e2e-"));
  cleanups.push(directory);
  return directory;
}

function envFor(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALTIORA_API_KEY: "test-key",
    ALTIORA_DATA_DIR: join(cwd, ".data"),
    ALTIORA_CONFIG_DIR: join(cwd, ".cfg"),
    ALTIORA_CONTEXT_WINDOW: "128000",
  };
}

async function writeUserConfig(cwd: string, config: Record<string, unknown>): Promise<void> {
  const dir = join(cwd, ".cfg");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf8");
}

function mcpConfig(mode?: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    command: process.execPath,
    args: mode === undefined ? [fixture] : [fixture, mode],
    ...extra,
  };
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function declaredTools(body: Record<string, unknown> | null | undefined): string[] {
  const tools = body?.["tools"];
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const fn = (tool as Record<string, unknown>)["function"] as Record<string, unknown> | undefined;
    return String(fn?.["name"]);
  });
}

test("discovers mcp tools and feeds an allowed call result back to the model", async () => {
  const cwd = await workspace();
  await writeUserConfig(cwd, { mcpServers: { mock: mcpConfig() } });
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "mcp_mock_echo", { text: "hi" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]) },
  );
  try {
    const result = await runCli(
      ["run", "echo please", "--base-url", server.url, "--model", "m", "--allow", "mcp_mock_echo"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done\n");
    assert.ok(declaredTools(server.requests[0]?.body).includes("mcp_mock_echo"));
    const second = server.requests[1]?.body;
    const toolMessage = (second?.["messages"] as Record<string, unknown>[]).at(-1);
    assert.equal(toolMessage?.["role"], "tool");
    assert.match(String(toolMessage?.["content"]), /echo:hi/);
  } finally {
    await server.close();
  }
});

test("an unmatched mcp call is denied in a headless run", async () => {
  const cwd = await workspace();
  await writeUserConfig(cwd, { mcpServers: { mock: mcpConfig() } });
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "mcp_mock_echo", { text: "hi" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "blocked" }, finish_reason: "stop" }] }]) },
  );
  try {
    const result = await runCli(["run", "echo please", "--base-url", server.url, "--model", "m"], {
      cwd,
      env: envFor(cwd),
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /denied: no matching rule/);
    const toolMessage = (server.requests[1]?.body?.["messages"] as Record<string, unknown>[]).at(-1);
    assert.match(String(toolMessage?.["content"]), /denied/);
  } finally {
    await server.close();
  }
});

test("a dead server is reported and the run continues without its tools", async () => {
  const cwd = await workspace();
  await writeUserConfig(cwd, {
    mcpServers: {
      good: mcpConfig(),
      dead: { command: "altiora-no-such-command-9f3k2" },
    },
  });
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
  }));
  try {
    const result = await runCli(["run", "hi", "--base-url", server.url, "--model", "m"], {
      cwd,
      env: envFor(cwd),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "ok\n");
    assert.match(result.stderr, /mcp server dead unavailable:/);
    const tools = declaredTools(server.requests[0]?.body);
    assert.ok(tools.includes("mcp_good_echo"));
    assert.ok(!tools.some((name) => name.startsWith("mcp_dead")));
  } finally {
    await server.close();
  }
});

test("a silent server times out at discovery without failing the run", async () => {
  const cwd = await workspace();
  await writeUserConfig(cwd, { mcpServers: { slow: mcpConfig("hang", { timeoutMs: 200 }) } });
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
  }));
  try {
    const result = await runCli(["run", "hi", "--base-url", server.url, "--model", "m"], {
      cwd,
      env: envFor(cwd),
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /mcp server slow unavailable:.*timed out/);
    assert.ok(!declaredTools(server.requests[0]?.body).some((name) => name.startsWith("mcp_")));
  } finally {
    await server.close();
  }
});

test("a server crash mid-call becomes a tool error and the turn completes", async () => {
  const cwd = await workspace();
  await writeUserConfig(cwd, { mcpServers: { crashy: mcpConfig("crash-on-call") } });
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "mcp_crashy_echo", { text: "x" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }]) },
  );
  try {
    const result = await runCli(
      ["run", "call it", "--base-url", server.url, "--model", "m", "--allow", "mcp_crashy_echo"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "recovered\n");
    const toolMessage = (server.requests[1]?.body?.["messages"] as Record<string, unknown>[]).at(-1);
    assert.match(String(toolMessage?.["content"]), /mcp server exited before responding/);
  } finally {
    await server.close();
  }
});

test("project mcp servers load only with --trust-project", async () => {
  const cwd = await workspace();
  await mkdir(join(cwd, ".altiora"), { recursive: true });
  await writeFile(
    join(cwd, ".altiora", "config.json"),
    JSON.stringify({ mcpServers: { proj: mcpConfig() } }),
    "utf8",
  );
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
  }));
  try {
    const untrusted = await runCli(["run", "hi", "--base-url", server.url, "--model", "m"], {
      cwd,
      env: envFor(cwd),
    });
    assert.equal(untrusted.code, 0);
    assert.ok(!declaredTools(server.requests[0]?.body).some((name) => name.startsWith("mcp_")));

    const trusted = await runCli(
      ["run", "hi", "--base-url", server.url, "--model", "m", "--trust-project"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(trusted.code, 0);
    assert.ok(declaredTools(server.requests[1]?.body).includes("mcp_proj_echo"));
  } finally {
    await server.close();
  }
});