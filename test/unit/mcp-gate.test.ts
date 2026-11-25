import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/load.ts";
import type { PermissionMode } from "../../src/config/schema.ts";
import { runTool } from "../../src/core/tool-runner.ts";
import { createMcpManager } from "../../src/mcp/manager.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { parseRuleString } from "../../src/permissions/rules.ts";
import { createRegistry, type ToolContext, type ToolDefinition } from "../../src/tools/registry.ts";

const fixture = fileURLToPath(new URL("../mock/mcp-server.ts", import.meta.url));

function context(): ToolContext {
  return {
    cwd: process.cwd(),
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 10000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
  };
}

async function withMcpTools(fn: (tools: ToolDefinition[]) => Promise<void>): Promise<void> {
  const manager = createMcpManager({
    servers: { mock: { command: process.execPath, args: [fixture] } },
    cwd: process.cwd(),
  });
  try {
    const { tools } = await manager.discover();
    await fn(tools);
  } finally {
    manager.close();
  }
}

function engine(mode: PermissionMode, rules: ReturnType<typeof parseRuleString>[]) {
  return createPermissionEngine({ mode, rules, cwd: process.cwd(), platform: process.platform });
}

test("unmatched mcp calls ask in default mode and deny in plan/unattended", () => {
  const request = { tool: "mcp_mock_echo", resources: [], readOnly: false };
  const byDefault = engine("default", []);
  assert.equal(byDefault.decide(request).effect, "ask");
  byDefault.setMode("unattended");
  const unattended = byDefault.decide(request);
  assert.equal(unattended.effect, "deny");
  assert.match(unattended.reason, /unattended/);
  assert.equal(engine("plan", []).decide(request).effect, "deny");
});

test("readOnlyHint mcp tools are allowed without a rule", () => {
  const decision = engine("default", []).decide({ tool: "mcp_mock_peek", resources: [], readOnly: true });
  assert.equal(decision.effect, "allow");
});

test("allow and deny rules match mcp tool names like built-ins", () => {
  const allow = engine("default", [parseRuleString("mcp_mock_echo", "allow", "r1")]);
  const allowed = allow.decide({ tool: "mcp_mock_echo", resources: [], readOnly: false });
  assert.equal(allowed.effect, "allow");
  assert.equal(allowed.ruleId, "0");
  const both = engine("default", [
    parseRuleString("mcp_mock_echo", "allow", "r1"),
    parseRuleString("mcp_mock_echo", "deny", "r2"),
  ]);
  assert.equal(both.decide({ tool: "mcp_mock_echo", resources: [], readOnly: false }).effect, "deny");
});

test("runTool denies an mcp call when the user does not approve", async () => {
  await withMcpTools(async (tools) => {
    const outcome = await runTool(
      { id: "c1", name: "mcp_mock_echo", input: { text: "hi" } },
      context(),
      { registry: createRegistry(tools), permissions: engine("default", []), confirm: async () => false },
      1,
    );
    assert.equal(outcome.denied, true);
    assert.match(outcome.output, /not approved/);
  });
});

test("runTool executes an mcp call after approval", async () => {
  await withMcpTools(async (tools) => {
    const outcome = await runTool(
      { id: "c1", name: "mcp_mock_echo", input: { text: "hi" } },
      context(),
      { registry: createRegistry(tools), permissions: engine("default", []), confirm: async () => true },
      1,
    );
    assert.deepEqual(outcome, { output: "echo:hi", isError: false, denied: false, truncated: false });
  });
});

test("unattended denies mcp calls without ever asking", async () => {
  await withMcpTools(async (tools) => {
    let asked = 0;
    const outcome = await runTool(
      { id: "c1", name: "mcp_mock_echo", input: { text: "hi" } },
      context(),
      {
        registry: createRegistry(tools),
        permissions: engine("unattended", []),
        confirm: async () => {
          asked += 1;
          return true;
        },
      },
      1,
    );
    assert.equal(asked, 0);
    assert.equal(outcome.denied, true);
  });
});

test("an allow rule executes mcp calls without asking", async () => {
  await withMcpTools(async (tools) => {
    let asked = 0;
    const outcome = await runTool(
      { id: "c1", name: "mcp_mock_echo", input: { text: "hi" } },
      context(),
      {
        registry: createRegistry(tools),
        permissions: engine("default", [parseRuleString("mcp_mock_echo", "allow", "r1")]),
        confirm: async () => {
          asked += 1;
          return false;
        },
      },
      1,
    );
    assert.equal(asked, 0);
    assert.equal(outcome.output, "echo:hi");
  });
});

test("project mcp servers load only when the project is trusted", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "altiora-mcp-trust-"));
  const configDir = mkdtempSync(path.join(tmpdir(), "altiora-mcp-user-"));
  mkdirSync(path.join(workspace, ".altiora"));
  writeFileSync(
    path.join(workspace, ".altiora", "config.json"),
    JSON.stringify({ mcpServers: { proj: { command: "some-server" } } }),
    "utf8",
  );
  const env = { ALTIORA_CONFIG_DIR: configDir };
  const untrusted = loadConfig({ cwd: workspace, env, trustProject: false });
  assert.deepEqual(untrusted.config.mcpServers, {});
  const trusted = loadConfig({ cwd: workspace, env, trustProject: true });
  assert.deepEqual(trusted.config.mcpServers, { proj: { command: "some-server" } });
});