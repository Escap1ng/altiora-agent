import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions, sessionTitle } from "../../src/session/store.ts";

test("sessionTitle uses the first non-empty turn input line", () => {
  assert.equal(sessionTitle([]), "");
  assert.equal(sessionTitle([{ t: "session/start" }]), "");
  assert.equal(sessionTitle([{ t: "turn/start", input: "  \n fix the login bug \n second line" }]), "fix the login bug");
  assert.equal(sessionTitle([{ t: "turn/start", input: "" }, { t: "turn/start", input: "second" }]), "second");
});

test("sessionTitle truncates long inputs", () => {
  const long = "a".repeat(80);
  const title = sessionTitle([{ t: "turn/start", input: long }]);
  assert.equal(title.length, 60);
  assert.ok(title.endsWith("..."));
});

test("listSessions exposes the derived title", () => {
  const directory = mkdtempSync(join(tmpdir(), "altiora-store-"));
  try {
    const lines = [
      { v: 1, ts: 1, t: "session/start", id: "s_one", cwd: directory, model: "m", provider: "p", harnessVersion: "0" },
      { v: 1, ts: 2, t: "turn/start", turn: 1, input: "summarize the repo" },
    ];
    writeFileSync(join(directory, "s_one.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    const sessions = listSessions(directory);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, "summarize the repo");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});