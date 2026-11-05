import assert from "node:assert/strict";
import { test } from "node:test";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { matchesResource, parseRuleString } from "../../src/permissions/rules.ts";
import { globToRegExp } from "../../src/util/glob.ts";

test("deny wins over allow regardless of order", () => {
  const engine = createPermissionEngine({
    mode: "default",
    cwd: "D:\\proj",
    platform: "win32",
    rules: [
      parseRuleString("bash", "allow", "a"),
      parseRuleString("bash(rm *)", "deny", "b"),
    ],
  });
  assert.equal(engine.decide({ tool: "bash", resources: ["rm -rf src"], readOnly: false }).effect, "deny");
  assert.equal(engine.decide({ tool: "bash", resources: ["git status"], readOnly: false }).effect, "allow");
});

test("read-only tools are allowed without rules", () => {
  const engine = createPermissionEngine({ mode: "default", cwd: "/p", platform: "linux", rules: [] });
  assert.equal(engine.decide({ tool: "read", resources: ["/p/a.ts"], readOnly: true }).effect, "allow");
  assert.equal(engine.decide({ tool: "write", resources: ["/p/a.ts"], readOnly: false }).effect, "ask");
});

test("unattended mode turns ask into deny", () => {
  const engine = createPermissionEngine({ mode: "unattended", cwd: "/p", platform: "linux", rules: [] });
  const decision = engine.decide({ tool: "bash", resources: ["ls"], readOnly: false });
  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /unattended/);
});

test("plan mode blocks writes even when allowed by a rule", () => {
  const engine = createPermissionEngine({
    mode: "plan",
    cwd: "/p",
    platform: "linux",
    rules: [parseRuleString("write", "allow", "a")],
  });
  assert.equal(engine.decide({ tool: "write", resources: ["/p/a.ts"], readOnly: false }).effect, "deny");
  assert.equal(engine.decide({ tool: "read", resources: ["/p/a.ts"], readOnly: true }).effect, "allow");
});

test("path patterns match relative and absolute resources", () => {
  const pattern = "src/**";
  assert.equal(matchesResource(pattern, "/p/src/a/b.ts", "/p", "linux"), true);
  assert.equal(matchesResource(pattern, "/p/test/a.ts", "/p", "linux"), false);
  assert.equal(matchesResource("src/*", "/p/src/a/b.ts", "/p", "linux"), false);
  assert.equal(matchesResource("src/*", "/p/src/a.ts", "/p", "linux"), true);
});

test("windows matching is case-insensitive and separator agnostic", () => {
  assert.equal(matchesResource("SRC/**", "D:\\proj\\src\\A.ts", "D:\\proj", "win32"), true);
  assert.equal(matchesResource("src/**", "D:\\proj\\SRC\\a.ts", "D:\\proj", "win32"), true);
});

test("glob translation distinguishes * from **", () => {
  assert.equal(globToRegExp("a/*", "linux").test("a/b/c"), false);
  assert.equal(globToRegExp("a/**", "linux").test("a/b/c"), true);
  assert.equal(globToRegExp("a/?.ts", "linux").test("a/b.ts"), true);
});

test("rule strings reject malformed input", () => {
  assert.throws(() => parseRuleString("write((", "allow", "a"), /invalid permission rule/);
});
