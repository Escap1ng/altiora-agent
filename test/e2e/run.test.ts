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

function envFor(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALTIORA_API_KEY: "test-key",
    ALTIORA_DATA_DIR: join(cwd, ".data"),
  };
}

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
      env: envFor(cwd),
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "Hello from mock\n");
    assert.equal(result.stderr, "");

    const body = server.requests[0]?.body;
    assert.equal(body?.["model"], "test-model");
    const messages = body?.["messages"] as Record<string, unknown>[];
    assert.equal(messages[0]?.["role"], "system");
    assert.deepEqual(messages[1], { role: "user", content: "say hi" });
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
      { cwd, env: envFor(cwd) },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done\n");
    assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "hi");
    assert.match(result.stderr, /\[write note\.txt\]/);
    assert.match(result.stderr, /\[bash node -e/);

    const second = server.requests[1]?.body;
    const messages = second?.["messages"] as Record<string, unknown>[];
    assert.equal(messages.length, 4);
    assert.equal(messages[0]?.["role"], "system");
    assert.equal(messages[2]?.["role"], "assistant");
    assert.equal(messages[3]?.["role"], "tool");
    assert.equal(messages[3]?.["tool_call_id"], "call_1");
    assert.match(String(messages[3]?.["content"]), /wrote 2 bytes to note\.txt/);

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
      env: envFor(cwd),
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
  const env = envFor(cwd);
  delete env.ALTIORA_API_KEY;

  const result = await runCli(["run", "hi", "--model", "some-model"], { cwd, env });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing api key: set ALTIORA_API_KEY/);
});

interface NdjsonLine {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { role: string; content: { type: string; text?: string }[] };
  result?: string;
}

function parseNdjson(stdout: string): NdjsonLine[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as NdjsonLine);
}

test("emits stream-json events and a result", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
  }));
  try {
    const result = await runCli(
      ["run", "hello", "--base-url", server.url, "--model", "m", "--output-format", "stream-json"],
      { cwd, env: envFor(cwd) },
    );

    assert.equal(result.code, 0);
    const lines = parseNdjson(result.stdout);
    assert.equal(lines[0]?.type, "system");
    assert.equal(lines[0]?.subtype, "init");
    assert.match(lines[0]?.session_id ?? "", /^s_/);

    const assistant = lines.find((line) => line.type === "assistant");
    assert.equal(assistant?.message?.content[0]?.text, "hi");

    const last = lines.at(-1);
    assert.equal(last?.type, "result");
    assert.equal(last?.subtype, "success");
    assert.equal(last?.session_id, lines[0]?.session_id);
  } finally {
    await server.close();
  }
});

test("resumes a session with the prior conversation", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: index === 0 ? "first" : "second" }, finish_reason: "stop" }] },
    ]),
  }));

  try {
    const first = await runCli(
      ["run", "first turn", "--base-url", server.url, "--model", "m"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(first.stdout, "first\n");

    const list = await runCli(["sessions", "list", "--json"], { cwd, env: envFor(cwd) });
    const sessions = JSON.parse(list.stdout) as { id: string }[];
    assert.equal(sessions.length, 1);
    const id = sessions[0]!.id;

    const second = await runCli(
      ["run", "another", "--resume", id, "--base-url", server.url, "--model", "m"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(second.stdout, "second\n");

    const messages = server.requests[1]?.body?.["messages"] as Record<string, unknown>[];
    assert.deepEqual(
      messages.map((message) => message["role"]),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(messages[1]?.["content"], "first turn");
  } finally {
    await server.close();
  }
});

test("forks a session into a new log without touching the source", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) => ({
    chunks: sseChunks([
      { choices: [{ delta: { content: index === 0 ? "one" : "two" }, finish_reason: "stop" }] },
    ]),
  }));

  try {
    await runCli(["run", "base", "--base-url", server.url, "--model", "m"], { cwd, env: envFor(cwd) });
    const list = await runCli(["sessions", "list", "--json"], { cwd, env: envFor(cwd) });
    const sourceId = (JSON.parse(list.stdout) as { id: string }[])[0]!.id;

    const forked = await runCli(
      ["run", "child", "--fork", sourceId, "--base-url", server.url, "--model", "m"],
      { cwd, env: envFor(cwd) },
    );
    assert.equal(forked.stdout, "two\n");

    const after = JSON.parse(
      (await runCli(["sessions", "list", "--json"], { cwd, env: envFor(cwd) })).stdout,
    ) as { id: string }[];
    assert.equal(after.length, 2);
    assert.ok(after.some((session) => session.id === sourceId));
    assert.ok(after.some((session) => session.id !== sourceId));

    const show = await runCli(["sessions", "show", sourceId], { cwd, env: envFor(cwd) });
    assert.match(show.stdout, /assistant: one/);
  } finally {
    await server.close();
  }
});

test("prints a single json result object", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]),
  }));
  try {
    const result = await runCli(
      ["run", "hello", "--base-url", server.url, "--model", "m", "--output-format", "json"],
      { cwd, env: envFor(cwd) },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { type: string; result: string; subtype: string };
    assert.equal(parsed.type, "result");
    assert.equal(parsed.subtype, "success");
    assert.equal(parsed.result, "hi");
  } finally {
    await server.close();
  }
});

test("init writes project config and AGENTS.md once", async () => {
  const cwd = await workspace();

  const first = await runCli(["init"], { cwd, env: envFor(cwd) });
  assert.equal(first.code, 0);
  assert.match(first.stdout, /wrote/);
  assert.equal(existsSync(join(cwd, ".altiora", "config.json")), true);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), true);

  const config = JSON.parse(await readFile(join(cwd, ".altiora", "config.json"), "utf8")) as {
    permissions: { mode: string };
  };
  assert.equal(config.permissions.mode, "default");

  const second = await runCli(["init"], { cwd, env: envFor(cwd) });
  assert.match(second.stdout, /nothing to write/);
});
