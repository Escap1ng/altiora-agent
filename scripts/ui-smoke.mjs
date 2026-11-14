import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const desktop = join(root, "desktop");
const tmp = join(root, ".tmp-ui");
mkdirSync(tmp, { recursive: true });
mkdirSync(join(tmp, "data"), { recursive: true });
mkdirSync(join(tmp, "config"), { recursive: true });
mkdirSync(join(tmp, "workspace"), { recursive: true });
writeFileSync(join(tmp, "workspace", "hello.txt"), "hello from the smoke workspace\n", "utf8");
writeFileSync(join(tmp, "blank.html"), "<!doctype html><title>blank</title><p>blank</p>", "utf8");

const sse = (payloads) =>
  [...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].join("");

let chatCalls = 0;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if ((req.url ?? "").includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "smoke-model", context_window: 128000, max_output: 8192 }] }));
      return;
    }
    chatCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (chatCalls === 1) {
      const chunks = sse([
        { choices: [{ delta: { reasoning_content: "Looking at the workspace layout first. " } }] },
        { choices: [{ delta: { reasoning_content: "The tree has one text file; I will read it." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_todo", function: { name: "todo_write", arguments: JSON.stringify({ todos: [ { content: "Inspect workspace", status: "in_progress" }, { content: "Read hello.txt", status: "pending" }, { content: "Summarize findings", status: "pending" } ] }) } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
      res.end(chunks);
      return;
    }
    if (chatCalls === 2) {
      res.end(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_read", function: { name: "read", arguments: JSON.stringify({ path: "hello.txt" }) } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      );
      return;
    }
    if (chatCalls === 3) {
      res.end(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_todo2", function: { name: "todo_write", arguments: JSON.stringify({ todos: [ { content: "Inspect workspace", status: "completed" }, { content: "Read hello.txt", status: "completed" }, { content: "Summarize findings", status: "in_progress" } ] }) } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      );
      return;
    }
    const answer = [
      { choices: [{ delta: { content: "## Workspace summary\n\n" } }] },
      { choices: [{ delta: { content: "The workspace contains a single file, `hello.txt`, with one line of text.\n\n" } }] },
      { choices: [{ delta: { content: "- **File**: hello.txt\n- **Content**: a greeting line\n\n" } }] },
      { choices: [{ delta: { content: "```txt\nhello from the smoke workspace\n```\n" } }] },
      { choices: [{ delta: { content: "Nothing else to inspect. Ask me to change it whenever you like." }, finish_reason: "stop" }] },
    ];
    res.end(sse(answer));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const preloadPath = join(desktop, "preload.cjs");
const mainJsPath = join(desktop, "dist", "main.js");
const originalPreload = readFileSync(preloadPath, "utf8");
const originalMainJs = readFileSync(mainJsPath, "utf8");

const driver = `
window.addEventListener("DOMContentLoaded", () => {
  const { ipcRenderer } = require("electron");
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  (async () => {
    await sleep(1200);
    check("bridge exposed", typeof window.altiora === "object");
    check("empty state", q(".empty") !== null);
    q("#prompt").value = "Summarize this workspace";
    q("#composer").requestSubmit();
    await sleep(400);
    check("running head", q(".run-head .run-label")?.textContent === "Running");
    check("stop visible", !q("#abort").hidden);
    let done = false;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      if (q(".run-head")?.classList.contains("done")) { done = true; break; }
    }
    check("run completed", done && q(".run-head .run-label")?.textContent === "Completed");
    check("thinking row", document.querySelectorAll(".think").length >= 1);
    check("tool rows", document.querySelectorAll(".tool-row").length >= 2);
    check("tasks rendered", document.querySelectorAll(".task-item").length === 3);
    check("tasks completed", document.querySelectorAll(".task-item.completed").length === 2);
    check("markdown heading", q(".answer h2") !== null);
    check("code block", q(".answer pre code") !== null);
    check("sidebar title", (q(".session-title-text")?.textContent ?? "").includes("Summarize this workspace"));
    q("#theme-toggle").click();
    await sleep(200);
    check("dark theme", document.documentElement.dataset.theme === "dark");
    q("#theme-toggle").click();
    q("#toggle-right").click();
    await sleep(600);
    check("file tree", (q("#tree")?.textContent ?? "").includes("hello.txt"));
    q("#nav-skills").click();
    await sleep(200);
    check("skills modal", !q("#info").hidden);
    q("#info-close").click();
    q("#new-session").click();
    await sleep(400);
    check("new task empty", q(".empty") !== null);
    q(".session-item")?.click();
    await sleep(600);
    check("history replay", q(".answer h2") !== null);
    ipcRenderer.send("smoke:report", { checks });
  })().catch((e) => ipcRenderer.send("smoke:report", { checks, error: String(e && e.stack || e) }));
});
`;
writeFileSync(preloadPath, originalPreload + driver, "utf8");
const handler = `
ipcMain.on("smoke:report", (_e, report) => {
  require("node:fs").writeFileSync(${JSON.stringify(join(tmp, "report.json"))}, JSON.stringify(report, null, 2));
  console.log("SMOKE " + JSON.stringify(report.checks.every((c) => c.ok) ? "PASS" : "FAIL"));
  app.quit();
});
`;
writeFileSync(mainJsPath, originalMainJs + handler, "utf8");
const restoreAll = () => {
  writeFileSync(preloadPath, originalPreload, "utf8");
  writeFileSync(mainJsPath, originalMainJs, "utf8");
};
process.on("exit", restoreAll);

const electronBin = join(desktop, "node_modules", "electron", "dist", "electron.exe");
const child = spawn(
  electronBin,
  [desktop, `--user-data-dir=${join(tmp, "profile")}`, "--remote-debugging-port=9222", "--in-process-gpu", "--disable-features=CalculateNativeWinOcclusion", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  {
  cwd: desktop,
  env: {
    ...process.env,
    ALTIORA_API_KEY: "smoke-key",
    ALTIORA_BASE_URL: baseUrl,
    ALTIORA_MODEL: "smoke-model",
    ALTIORA_CONTEXT_WINDOW: "128000",
    ALTIORA_DATA_DIR: join(tmp, "data"),
    ALTIORA_CONFIG_DIR: join(tmp, "config"),
    ALTIORA_WORKSPACE: join(tmp, "workspace"),
    ALTIORA_DISABLE_SANDBOX: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += String(c)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (stage) => console.error(`[smoke] ${stage}`);

function killTree() {
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { encoding: "utf8", timeout: 10000 });
  } catch {}
}

const watchdog = setTimeout(() => {
  console.error(`[smoke] watchdog fired; childAlive=${child.exitCode === null}; stderr:\n${stderr.slice(-3000)}`);
  killTree();
  server.close();
  restoreAll();
  process.exit(2);
}, 120000);

child.on("exit", (code) => log(`electron exited: ${code}`));
log("app spawned; waiting for in-renderer report");

let report = null;
for (let i = 0; i < 220; i++) {
  await sleep(500);
  if (existsSync(join(tmp, "report.json"))) {
    report = JSON.parse(readFileSync(join(tmp, "report.json"), "utf8"));
    break;
  }
}

clearTimeout(watchdog);
killTree();
server.close();
restoreAll();

if (report === null) {
  console.error(`[smoke] no report produced; stderr:\n${stderr.slice(-3000)}`);
  process.exit(2);
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.checks.every((c) => c.ok) && report.error === undefined ? 0 : 1);