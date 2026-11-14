import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sseChunks, startMockServer } from "../../test/mock/openai-server.ts";
import { AgentService } from "../dist/agent.js";

const cleanups: string[] = [];

after(async () => {
  await Promise.all(cleanups.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "altiora-desktop-"));
  cleanups.push(directory);
  return directory;
}

function envFor(cwd: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALTIORA_API_KEY: "test-key",
    ALTIORA_BASE_URL: baseUrl,
    ALTIORA_MODEL: "test-model",
    ALTIORA_DATA_DIR: join(cwd, ".data"),
    ALTIORA_WORKSPACE: cwd,
    ALTIORA_CONTEXT_WINDOW: "128000",
  };
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

test("streams a turn and records the session", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] }]),
  }));
  try {
    const events: { type: string }[] = [];
    const service = await AgentService.create({
      cwd,
      env: envFor(cwd, server.url),
      version: "test",
      send: (_channel, payload) => events.push(payload as { type: string }),
    });

    const outcome = await service.run("hi");
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.stopReason === "completed");
    assert.ok(events.some((event) => event.type === "text-delta"));
    assert.equal(server.requests.length, 1);
    assert.equal(service.sessions().length, 1);
    assert.equal(service.sessions()[0]?.title, "hi");
  } finally {
    await server.close();
  }
});

test("asks for approval before a write and applies it when approved", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "write", { path: "note.txt", content: "hi" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]) },
  );

  let service: AgentService | undefined;
  const channels: string[] = [];
  try {
    service = await AgentService.create({
      cwd,
      env: envFor(cwd, server.url),
      version: "test",
      send: (channel, payload) => {
        channels.push(channel);
        if (channel === "altiora:confirm-request") {
          const request = payload as { id: string };
          service?.resolveConfirm(request.id, true);
        }
      },
    });

    const outcome = await service.run("write a note");
    assert.equal(outcome.ok, true);
    assert.ok(channels.includes("altiora:confirm-request"));
    assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "hi");
  } finally {
    await server.close();
  }
});

test("denies a write when the confirmation is rejected", async () => {
  const cwd = await workspace();
  const server = await startMockServer((_request, index) =>
    index === 0
      ? { chunks: sseChunks([toolCall("call_1", "write", { path: "blocked.txt", content: "x" })]) }
      : { chunks: sseChunks([{ choices: [{ delta: { content: "blocked" }, finish_reason: "stop" }] }]) },
  );

  let service: AgentService | undefined;
  try {
    service = await AgentService.create({
      cwd,
      env: envFor(cwd, server.url),
      version: "test",
      send: (channel, payload) => {
        if (channel === "altiora:confirm-request") {
          const request = payload as { id: string };
          service?.resolveConfirm(request.id, false);
        }
      },
    });

    await service.run("write a file");
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
  } finally {
    await server.close();
  }
});

test("forwards reasoning deltas and replays them on resume", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([
      { choices: [{ delta: { reasoning_content: "thinking hard" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
    ]),
  }));
  try {
    const events: { type: string; text?: string }[] = [];
    const service = await AgentService.create({
      cwd,
      env: envFor(cwd, server.url),
      version: "test",
      send: (_channel, payload) => events.push(payload as { type: string; text?: string }),
    });

    await service.run("hi");
    const reasoning = events.find((event) => event.type === "reasoning-delta");
    assert.equal(reasoning?.text, "thinking hard");

    const sessionId = service.state().sessionId;
    service.newSession();
    const reopened = await service.openSession(sessionId);
    assert.equal(reopened.ok, true);
    const assistant = reopened.ok
      ? reopened.history.find((message) => message.role === "assistant")
      : undefined;
    assert.equal(
      assistant !== undefined && assistant.role === "assistant" ? assistant.reasoning : undefined,
      "thinking hard",
    );
  } finally {
    await server.close();
  }
});

test("opens a previous session with its history", async () => {
  const cwd = await workspace();
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "remembered" }, finish_reason: "stop" }] }]),
  }));
  try {
    const service = await AgentService.create({
      cwd,
      env: envFor(cwd, server.url),
      version: "test",
      send: () => {},
    });

    await service.run("first");
    const sessionId = service.state().sessionId;
    const fresh = service.newSession();
    assert.equal(fresh.ok, true);

    const reopened = await service.openSession(sessionId);
    assert.equal(reopened.ok, true);
    assert.ok(reopened.ok && reopened.history.some((message) => message.role === "user"));
    assert.equal(service.state().sessionId, sessionId);
  } finally {
    await server.close();
  }
});
