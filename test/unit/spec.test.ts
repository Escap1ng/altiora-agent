import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { prepareSession } from "../../src/cli/runtime.ts";
import { runAgent } from "../../src/core/loop.ts";
import { resolveConfig } from "../../src/config/schema.ts";
import { openSession } from "../../src/session/log.ts";
import { parseRecords, serializeRecord } from "../../src/session/records.ts";
import { fingerprintConfig, inputFingerprint, type HarnessSpec } from "../../src/session/spec.ts";
import type { Provider, ProviderEvent } from "../../src/core/types.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { createRegistry } from "../../src/tools/registry.ts";
import { defaultTools } from "../../src/tools/index.ts";

const cleanups: string[] = [];

after(() => {
  for (const directory of cleanups) rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "altiora-spec-"));
  cleanups.push(directory);
  return directory;
}

const spec: HarnessSpec = { toolNames: ["read", "write"], configFingerprint: "abc123" };

function answerProvider(): Provider {
  return {
    id: "answer",
    async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

test("config fingerprints ignore key order and change with values", () => {
  const read = { command: "read", args: ["-n"] };
  const edit = { command: "edit", args: ["-n"] };
  const left = resolveConfig({ mcpServers: { a: read, b: edit } });
  const right = resolveConfig({ mcpServers: { b: edit, a: read } });
  assert.equal(fingerprintConfig(left), fingerprintConfig(right));
  assert.match(fingerprintConfig(left), /^[0-9a-f]{32}$/);
  assert.notEqual(fingerprintConfig(left), fingerprintConfig(resolveConfig({ model: "other" })));
});

test("a new session records the harness spec", () => {
  const directory = workspace();
  const setup = prepareSession({
    directory,
    cwd: directory,
    model: "m",
    version: "9.9.9",
    resumeId: undefined,
    forkId: undefined,
    spec,
  });
  const start = setup.log.records()[0];
  assert.ok(start !== undefined && start.t === "session/start");
  assert.deepEqual(start.t === "session/start" ? start.toolNames : undefined, spec.toolNames);
  assert.equal(start.t === "session/start" ? start.configFingerprint : undefined, spec.configFingerprint);
  assert.equal(start.t === "session/start" ? start.harnessVersion : undefined, "9.9.9");
});

test("resume and fork keep the recorded spec and turn fingerprints", async () => {
  const directory = workspace();
  const setup = prepareSession({
    directory,
    cwd: directory,
    model: "m",
    version: "1.0.0",
    resumeId: undefined,
    forkId: undefined,
    spec,
  });
  await runAgent("hello", {
    provider: answerProvider(),
    registry: createRegistry(defaultTools()),
    permissions: createPermissionEngine({ mode: "default", rules: [], cwd: directory, platform: process.platform }),
    model: "m",
    cwd: directory,
    platform: process.platform,
    signal: new AbortController().signal,
    maxSteps: 2,
    maxToolCallsPerStep: 2,
    maxOutputChars: 1000,
    bash: { shell: "auto", timeoutMs: 1000 },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    log: setup.log,
  });

  const resumed = prepareSession({
    directory,
    cwd: directory,
    model: "m",
    version: "1.0.0",
    resumeId: setup.id,
    forkId: undefined,
    spec,
  });
  const resumedStart = resumed.log.records()[0];
  assert.ok(resumedStart !== undefined && resumedStart.t === "session/start");
  assert.equal(resumedStart.t === "session/start" ? resumedStart.configFingerprint : undefined, "abc123");

  const next: HarnessSpec = { toolNames: ["read"], configFingerprint: "next" };
  const forked = prepareSession({
    directory,
    cwd: directory,
    model: "m",
    version: "1.0.1",
    resumeId: undefined,
    forkId: setup.id,
    spec: next,
  });
  const records = forked.log.records();
  const forkStart = records[0];
  assert.ok(forkStart !== undefined && forkStart.t === "session/start");
  assert.deepEqual(forkStart.t === "session/start" ? forkStart.toolNames : undefined, next.toolNames);
  assert.equal(forkStart.t === "session/start" ? forkStart.configFingerprint : undefined, "next");
  const turn = records.find((record) => record.t === "turn/start");
  assert.ok(turn !== undefined && turn.t === "turn/start");
  assert.equal(turn.t === "turn/start" ? turn.fingerprint : undefined, inputFingerprint("hello"));
});

test("turn fingerprints are stable across replay", async () => {
  const directory = workspace();
  const log = openSession(directory, "s_fp");
  const options = {
    provider: answerProvider(),
    registry: createRegistry(defaultTools()),
    permissions: createPermissionEngine({ mode: "default" as const, rules: [], cwd: directory, platform: process.platform }),
    model: "m",
    cwd: directory,
    platform: process.platform,
    signal: new AbortController().signal,
    maxSteps: 2,
    maxToolCallsPerStep: 2,
    maxOutputChars: 1000,
    bash: { shell: "auto" as const, timeoutMs: 1000 },
    retry: { maxAttempts: 1, baseDelayMs: 1 },
    log,
  };
  await runAgent("same input", options);
  await runAgent("different input", options);

  const records = log.records();
  const turns = records.filter((record) => record.t === "turn/start");
  assert.equal(turns.length, 2);
  const first = turns[0];
  const second = turns[1];
  assert.ok(first !== undefined && first.t === "turn/start");
  assert.ok(second !== undefined && second.t === "turn/start");
  assert.equal(first.fingerprint, inputFingerprint("same input"));
  assert.equal(second.fingerprint, inputFingerprint("different input"));
  assert.notEqual(first.fingerprint, second.fingerprint);

  const raw = records.map((record) => serializeRecord({ ...record, v: 1, ts: 1 })).join("");
  const replayed = parseRecords(raw);
  assert.equal(replayed.length, records.length);
  assert.equal(replayed[0]?.t === "turn/start" ? replayed[0].fingerprint : undefined, first.fingerprint);
});

test("the fingerprint reflects only the turn input text", () => {
  assert.equal(inputFingerprint("abc"), inputFingerprint("abc"));
  assert.notEqual(inputFingerprint("abc"), inputFingerprint("abc "));
  assert.match(inputFingerprint(""), /^[0-9a-f]{32}$/);
});
