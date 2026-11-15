import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRun, parseCron } from "../../src/schedule/cron.ts";

test("parseCron accepts five fields and rejects others", () => {
  assert.ok(parseCron("*/5 * * * *").minutes.has(0));
  assert.ok(parseCron("*/5 * * * *").minutes.has(55));
  assert.equal(parseCron("*/5 * * * *").minutes.size, 12);
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /invalid cron field/);
  assert.throws(() => parseCron("* 24 * * *"), /invalid cron field/);
  assert.throws(() => parseCron("* * * 13 *"), /invalid cron field/);
  assert.throws(() => parseCron("* * * * 7"), /invalid cron field/);
  assert.throws(() => parseCron("*/0 * * * *"), /invalid cron step/);
});

test("nextRun computes the next matching minute", () => {
  const after = new Date(2026, 0, 1, 9, 3, 30);
  const next = nextRun("*/5 * * * *", after);
  assert.equal(next.getMinutes(), 5);
  assert.equal(next.getHours(), 9);
});

test("nextRun rolls to the next day", () => {
  const after = new Date(2026, 0, 1, 23, 59, 0);
  const next = nextRun("0 0 * * *", after);
  assert.equal(next.getDate(), 2);
  assert.equal(next.getHours(), 0);
  assert.equal(next.getMinutes(), 0);
});

test("nextRun honors day-of-week", () => {
  const after = new Date(2026, 0, 1, 12, 0, 0); // Thursday
  const next = nextRun("0 9 * * 1", after); // Monday
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 9);
});

test("nextRun supports ranges and lists", () => {
  const after = new Date(2026, 0, 1, 8, 0, 0);
  const next = nextRun("0 9-17 * * *", after);
  assert.equal(next.getHours(), 9);
  const next2 = nextRun("30 8,12,18 * * *", after);
  assert.equal(next2.getHours(), 8);
  assert.equal(next2.getMinutes(), 30);
});