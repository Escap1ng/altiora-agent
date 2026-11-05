import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
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

test("prints streamed text from an openai-compatible endpoint", async () => {
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "from mock" }, finish_reason: "stop" }] },
    ]),
  }));
  try {
    const result = await runCli(["run", "say hi", "--base-url", server.url, "--model", "test-model"], {
      ...process.env,
      ALTIORA_API_KEY: "test-key",
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

test("exits 1 with a clear message when the api key is missing", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ALTIORA_API_KEY;

  const result = await runCli(["run", "hi", "--model", "some-model"], env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing api key: set ALTIORA_API_KEY/);
});
