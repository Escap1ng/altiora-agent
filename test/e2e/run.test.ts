import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const cleanups: string[] = [];

after(async () => {
  await Promise.all(cleanups.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "altiora-e2e-"));
  cleanups.push(directory);
  return directory;
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

test("prints streamed text from an openai-compatible endpoint", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "from mock" }, finish_reason: "stop" }] },
    ]),
  }));
  try {
    const result = await runCli(["run", "say hi", "--base-url", server.url, "--model", "test-model"], {
      cwd,
      env: { ...process.env, ALTIORA_API_KEY: "test-key" },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "Hello from mock\n");
    assert.equal(result.stderr, "");

    const body = server.requests[0]?.body;
    assert.equal(body?.["model"], "test-model");
    assert.deepEqual(body?.["messages"], [{ role: "user", content: "say hi" }]);
  } finally {
    await server.close();
  }
});

test("runs tools across steps and feeds results back", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) => {
    if (index === 0) {
      return { chunks: sseChunks([toolCall("call_1", "write", { path: "note.txt", content: "hi" })]) };
    }
    if (index === 1) {
      return { chunks: sseChunks([toolCall("call_2", "bash", { command: 'node -e "console.log(42)"' })]) };
    }
    return {
      chunks: sseChunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    };
  });

  try {
    const result = await runCli(
      [
        "run",
        "make a note",
        "--base-url",
        server.url,
        "--model",
        "test-model",
        "--allow",
        "write",
        "--allow",
        "bash",
      ],
      { cwd, env: { ...process.env, ALTIORA_API_KEY: "test-key" } },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done\n");
    assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "hi");
    assert.match(result.stderr, /\[write note\.txt\]/);
    assert.match(result.stderr, /\[bash node -e/);

    const second = server.requests[1]?.body;
    const messages = second?.["messages"] as Record<string, unknown>[];
    assert.equal(messages.length, 3);
    assert.equal(messages[1]?.["role"], "assistant");
    assert.equal(messages[2]?.["role"], "tool");
    assert.equal(messages[2]?.["tool_call_id"], "call_1");
    assert.match(String(messages[2]?.["content"]), /wrote 2 bytes to note\.txt/);

    const bashResult = (server.requests[2]?.body?.["messages"] as Record<string, unknown>[]).at(-1);
    assert.match(String(bashResult?.["content"]), /42/);
  } finally {
    await server.close();
  }
});

test("denies tools without a matching allow rule", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "write", { path: "blocked.txt", content: "x" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "blocked" }, finish_reason: "stop" }] }]) },
  );

  try {
    const result = await runCli(["run", "write a file", "--base-url", server.url, "--model", "m"], {
      cwd,
      env: { ...process.env, ALTIORA_API_KEY: "test-key" },
    });

    assert.equal(result.code, 0);
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
    assert.match(result.stderr, /\[write\] denied: no matching rule/);

    const second = server.requests[1]?.body;
    const toolMessage = (second?.["messages"] as Record<string, unknown>[]).at(-1);
    assert.match(String(toolMessage?.["content"]), /denied/);
  } finally {
    await server.close();
  }
});

test("exits 1 with a clear message when the api key is missing", async () => {
  const cwd = await workspace();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ALTIORA_API_KEY;

  const result = await runCli(["run", "hi", "--model", "some-model"], { cwd, env });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing api key: set ALTIORA_API_KEY/);
});
