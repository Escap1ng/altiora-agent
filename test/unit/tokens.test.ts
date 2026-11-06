import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateText, TokenEstimator } from "../../src/core/tokens.ts";

test("estimates ascii at roughly four characters per token", () => {
  assert.equal(estimateText("abcdefgh"), 2);
  assert.equal(estimateText("a".repeat(400)), 100);
});

test("estimates cjk at roughly one token per character", () => {
  assert.equal(estimateText("\u4f60\u597d\u4e16\u754c"), 4);
  assert.ok(estimateText("\u4f60".repeat(100)) >= 100);
});

test("calibrates the factor from observed usage", () => {
  const estimator = new TokenEstimator();
  const estimated = estimator.estimateText("x".repeat(400));
  estimator.observe(estimated, estimated * 1.5);
  assert.ok(estimator.factor > 1);
  assert.ok(estimator.estimateText("x".repeat(400)) > estimated);

  estimator.observe(100, 1);
  assert.equal(estimator.factor, 0.5);
});

test("counts message overhead", () => {
  const estimator = new TokenEstimator();
  assert.equal(estimator.estimateMessages([{ role: "user", content: "" }]), 5);
});
