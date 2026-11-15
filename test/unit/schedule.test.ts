import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Scheduler } from "../../src/schedule/scheduler.ts";
import { loadSchedules, newScheduleId, saveSchedules, type ScheduleEntry } from "../../src/schedule/store.ts";
import { sseChunks, startMockServer } from "../mock/openai-server.ts";

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: newScheduleId(),
    name: "test",
    cron: "*/5 * * * *",
    prompt: "hi",
    cwd: tmpdir(),
    enabled: true,
    allow: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

test("schedules round-trip through the store", () => {
  const dir = mkdtempSync(join(tmpdir(), "altiora-sched-"));
  try {
    assert.deepEqual(loadSchedules(dir), []);
    const e = entry();
    saveSchedules(dir, [e]);
    const loaded = loadSchedules(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, e.id);
    saveSchedules(dir, []);
    assert.deepEqual(loadSchedules(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler runs a due entry and records the outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "altiora-sched-"));
  const server = await startMockServer(() => ({
    chunks: sseChunks([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
  }));
  try {
    const e = entry({ cwd: dir, nextRunAt: Date.now() - 1000 });
    saveSchedules(dir, [e]);
    const scheduler = new Scheduler({
      env: {
        ...process.env,
        ALTIORA_API_KEY: "test-key",
        ALTIORA_BASE_URL: server.url,
        ALTIORA_MODEL: "test-model",
        ALTIORA_DATA_DIR: dir,
        ALTIORA_CONTEXT_WINDOW: "128000",
      },
      version: "test",
    });
    await scheduler.tick();
    const loaded = loadSchedules(dir);
    assert.equal(loaded[0]?.lastStatus, "ok");
    assert.ok(loaded[0]?.lastSessionId);
    assert.ok((loaded[0]?.nextRunAt ?? 0) > Date.now());
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler skips disabled entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "altiora-sched-"));
  try {
    const e = entry({ cwd: dir, enabled: false, nextRunAt: Date.now() - 1000 });
    saveSchedules(dir, [e]);
    const scheduler = new Scheduler({
      env: { ...process.env, ALTIORA_DATA_DIR: dir },
      version: "test",
    });
    await scheduler.tick();
    const loaded = loadSchedules(dir);
    assert.equal(loaded[0]?.lastStatus, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});