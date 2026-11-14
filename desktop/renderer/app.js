const api = window.altiora;
const $ = (s) => document.querySelector(s);

const shellEl = $(".shell");
const toggleSidebarEl = $("#toggle-sidebar");
const collapseSidebarEl = $("#collapse-sidebar");
const toggleRightEl = $("#toggle-right");
const closeRightEl = $("#close-right");
const treeEl = $("#tree");
const resultFilesEl = $("#result-files");
const planBodyEl = $("#plan-body");
const skillChipsEl = $("#skill-chips");
const openFolderEl = $("#open-folder");
const filesToggleEl = $("#files-toggle");
const skillsToggleEl = $("#skills-toggle");
const previewEl = $("#preview");
const previewPathEl = $("#preview-path");
const previewBodyEl = $("#preview-body");
const previewCloseEl = $("#preview-close");
const messagesEl = $("#messages");
const composerEl = $("#composer");
const promptEl = $("#prompt");
const sendEl = $("#send");
const abortEl = $("#abort");
const sessionsEl = $("#sessions");
const tasksEl = $("#tasks");
const newSessionEl = $("#new-session");
const pickWorkspaceEl = $("#pick-workspace");
const composerWorkspaceEl = $("#composer-workspace");
const projectToggleEl = $("#project-toggle");
const sessionTitleEl = $("#session-title");
const workspaceNameEl = $("#workspace-name");
const statusDotEl = $("#status-dot");
const statusTextEl = $("#status-text");
const versionEl = $("#version");
const themeToggleEl = $("#theme-toggle");
const modeChipEl = $("#mode-chip");
const modelChipEl = $("#model-chip");
const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const modalEl = $("#modal");
const modalTitleEl = $("#modal-title");
const modalBodyEl = $("#modal-body");
const approveEl = $("#approve");
const denyEl = $("#deny");
const infoEl = $("#info");
const infoTitleEl = $("#info-title");
const infoBodyEl = $("#info-body");
const infoCloseEl = $("#info-close");

let busy = false;
let currentSessionId = "";
let pendingConfirm = null;
let run = null;
let stepAssistant = null;
let stepReasoning = null;
let runTimerId = 0;
let treeLoaded = false;
let sidebarBeforeRight = true;
const toolRows = new Map();
const pendingWrites = new Map();
const resultFiles = new Map();
const usedTools = new Set();

const SIDEBAR_KEY = "altiora.sidebar";
const RIGHT_KEY = "altiora.rightPanel";
const THEME_KEY = "altiora.theme";

/* ---------- theme ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}
applyTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
themeToggleEl.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
);

/* ---------- panels ---------- */
function setSidebar(open) {
  if (open && shellEl.classList.contains("right-open")) setRightPanel(false);
  shellEl.classList.toggle("sidebar-collapsed", !open);
  toggleSidebarEl.hidden = open;
  toggleSidebarEl.setAttribute("aria-expanded", String(open));
  localStorage.setItem(SIDEBAR_KEY, open ? "open" : "collapsed");
}
function setRightPanel(open) {
  if (open) {
    sidebarBeforeRight = !shellEl.classList.contains("sidebar-collapsed");
    shellEl.classList.add("sidebar-collapsed");
    toggleSidebarEl.hidden = false;
    toggleSidebarEl.setAttribute("aria-expanded", "false");
    void loadTree();
  } else {
    if (sidebarBeforeRight) {
      shellEl.classList.remove("sidebar-collapsed");
      toggleSidebarEl.hidden = true;
      toggleSidebarEl.setAttribute("aria-expanded", "true");
      localStorage.setItem(SIDEBAR_KEY, "open");
    }
  }
  shellEl.classList.toggle("right-open", open);
  toggleRightEl.setAttribute("aria-expanded", String(open));
  toggleRightEl.title = open ? "Hide progress panel" : "Show progress panel";
  localStorage.setItem(RIGHT_KEY, open ? "open" : "closed");
}
setSidebar(localStorage.getItem(SIDEBAR_KEY) !== "collapsed");
if (localStorage.getItem(RIGHT_KEY) === "open") setRightPanel(true);

toggleSidebarEl.addEventListener("click", () => setSidebar(true));
collapseSidebarEl.addEventListener("click", () => setSidebar(false));
toggleRightEl.addEventListener("click", () => setRightPanel(!shellEl.classList.contains("right-open")));
closeRightEl.addEventListener("click", () => setRightPanel(false));

projectToggleEl.addEventListener("click", () => {
  const collapsed = projectToggleEl.parentElement.classList.toggle("collapsed");
  projectToggleEl.setAttribute("aria-expanded", String(!collapsed));
});

filesToggleEl.addEventListener("click", () => {
  const c = filesToggleEl.parentElement.classList.toggle("collapsed");
  filesToggleEl.setAttribute("aria-expanded", String(!c));
});
skillsToggleEl.addEventListener("click", () => {
  const c = skillsToggleEl.parentElement.classList.toggle("collapsed");
  skillsToggleEl.setAttribute("aria-expanded", String(!c));
});
openFolderEl.addEventListener("click", () => void api.openFolder(""));

/* ---------- file type icons ---------- */
const EXT_COLORS = {
  png: "#38bdf8", jpg: "#38bdf8", jpeg: "#38bdf8", gif: "#38bdf8", webp: "#38bdf8", svg: "#38bdf8",
  md: "#8b5cf6", markdown: "#8b5cf6",
  ts: "#3178c6", js: "#eab308", mjs: "#eab308", cjs: "#eab308", tsx: "#3178c6", jsx: "#eab308",
  json: "#f59e0b", css: "#2f6bff", html: "#f97316",
  py: "#22c55e", rs: "#f97316", go: "#06b6d4",
};
function fileIcon(name) {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const ico = document.createElement("span");
  ico.className = "file-ico";
  ico.style.background = EXT_COLORS[ext] ?? "#9aa0a6";
  ico.textContent = ext.slice(0, 3).toUpperCase() || "F";
  return ico;
}

/* ---------- result files ---------- */
function addResultFile(path) {
  if (typeof path !== "string" || path === "" || resultFiles.has(path)) return;
  resultFiles.set(path, true);
  renderResultFiles();
}
function renderResultFiles() {
  resultFilesEl.replaceChildren();
  if (resultFiles.size === 0) {
    const m = document.createElement("div");
    m.className = "panel-muted";
    m.textContent = "No files touched yet.";
    resultFilesEl.append(m);
    return;
  }
  for (const path of resultFiles.keys()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = path;
    row.append(fileIcon(path), name);
    row.addEventListener("click", () => void openPreview(path));
    resultFilesEl.append(row);
  }
}
function resetResultFiles() {
  resultFiles.clear();
  renderResultFiles();
}

/* ---------- plan + tasks ---------- */
function renderTodos(input) {
  const todos = typeof input === "object" && input !== null ? input.todos : undefined;
  const list = Array.isArray(todos) ? todos : [];
  tasksEl.replaceChildren();
  planBodyEl.replaceChildren();
  if (list.length === 0) {
    const e = document.createElement("div");
    e.className = "session-empty";
    e.textContent = "No tasks";
    tasksEl.append(e);
    const m = document.createElement("div");
    m.className = "panel-muted";
    m.textContent = "Complex tasks get a plan before execution.";
    planBodyEl.append(m);
    return;
  }
  const planList = document.createElement("div");
  planList.className = "plan-list";
  for (const todo of list) {
    if (typeof todo !== "object" || todo === null) continue;
    const status = todo.status ?? "pending";
    const item = document.createElement("div");
    item.className = `task-item ${status}`;
    const marker = document.createElement("span");
    marker.className = "task-marker";
    const text = document.createElement("span");
    text.className = "task-text";
    text.textContent = String(todo.content ?? "");
    item.append(marker, text);
    tasksEl.append(item);
    const p = item.cloneNode(true);
    p.className = `plan-item ${status}`;
    planList.append(p);
  }
  planBodyEl.append(planList);
}

/* ---------- skills chips ---------- */
function addUsedTool(name) {
  if (usedTools.has(name)) return;
  usedTools.add(name);
  const chip = document.createElement("span");
  chip.className = "skill-chip";
  chip.textContent = name;
  skillChipsEl.append(chip);
}
function resetUsedTools() {
  usedTools.clear();
  skillChipsEl.replaceChildren();
  for (const base of ["agent loop", "permissions", "sessions"]) {
    const chip = document.createElement("span");
    chip.className = "skill-chip";
    chip.textContent = base;
    skillChipsEl.append(chip);
  }
}

/* ---------- file tree ---------- */
function treeNote(text) {
  const n = document.createElement("div");
  n.className = "tree-note";
  n.textContent = text;
  return n;
}
async function loadTree() {
  treeLoaded = true;
  treeEl.replaceChildren(treeNote("loading..."));
  const result = await api.listDir("");
  treeEl.replaceChildren();
  if (!result.ok) return treeEl.append(treeNote(result.message));
  if (result.entries.length === 0) return treeEl.append(treeNote("empty workspace"));
  renderEntries(treeEl, result.entries, 0);
}
function renderEntries(container, entries, depth) {
  for (const entry of entries) {
    const item = document.createElement("div");
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tree-row ${entry.type}`;
    row.style.paddingLeft = `${6 + depth * 12}px`;
    const marker = document.createElement("span");
    marker.className = entry.type === "dir" ? "chevron" : "file-dot";
    if (entry.type === "dir") marker.textContent = "▸";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;
    row.append(marker, label);
    const children = document.createElement("div");
    children.hidden = true;
    item.append(row, children);
    container.append(item);
    if (entry.type === "file") {
      row.addEventListener("click", () => void openPreview(entry.path));
      continue;
    }
    row.addEventListener("click", async () => {
      if (children.dataset.loaded !== "1") {
        const r = await api.listDir(entry.path);
        children.replaceChildren();
        if (!r.ok) children.append(treeNote(r.message));
        else if (r.entries.length === 0) children.append(treeNote("empty"));
        else renderEntries(children, r.entries, depth + 1);
        children.dataset.loaded = "1";
      }
      children.hidden = !children.hidden;
      marker.textContent = children.hidden ? "▸" : "▾";
    });
  }
}
async function openPreview(path) {
  const r = await api.readFile(path);
  previewPathEl.textContent = path;
  previewBodyEl.textContent = r.ok ? r.content : r.message;
  previewEl.hidden = false;
  previewCloseEl.focus();
}
function closePreview() { previewEl.hidden = true; }
previewCloseEl.addEventListener("click", closePreview);
previewEl.addEventListener("click", (e) => { if (e.target === previewEl) closePreview(); });

/* ---------- stream ---------- */
function stream() {
  let el = messagesEl.querySelector(".stream");
  if (el === null) {
    messagesEl.querySelector(".empty")?.remove();
    el = document.createElement("div");
    el.className = "stream";
    messagesEl.append(el);
  }
  return el;
}
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function restoreEmpty() {
  messagesEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  const mark = document.createElement("div"); mark.className = "empty-mark"; mark.textContent = "A";
  const title = document.createElement("div"); title.className = "empty-title"; title.textContent = "Ready when you are";
  const body = document.createElement("div"); body.className = "empty-body"; body.textContent = "Ask Altiora to inspect or change the workspace.";
  const sug = document.createElement("div"); sug.className = "suggestions";
  for (const text of [
    "Summarize this repository and its architecture",
    "Find the most complex function in this codebase and explain it",
    "List the files that changed recently and what they do",
  ]) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "suggestion"; chip.dataset.prompt = text;
    chip.textContent = text.split(" ").slice(0, 4).join(" ");
    sug.append(chip);
  }
  empty.append(mark, title, body, sug);
  messagesEl.append(empty);
}
messagesEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".suggestion");
  if (chip === null || busy) return;
  promptEl.value = chip.dataset.prompt ?? "";
  autosize(); promptEl.focus();
});
function addUser(text) {
  const b = document.createElement("div"); b.className = "msg user"; b.textContent = text;
  stream().append(b); scrollDown();
}
function addNotice(text, kind = "") {
  const n = document.createElement("div"); n.className = `notice ${kind}`.trim();
  n.textContent = text; n.title = text; stream().append(n); scrollDown();
}

/* ---------- markdown ---------- */
function inlineMarkdown(text, parent) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith("`")) { const c = document.createElement("code"); c.textContent = t.slice(1, -1); parent.append(c); }
    else if (t.startsWith("**")) { const s = document.createElement("strong"); s.textContent = t.slice(2, -2); parent.append(s); }
    else if (t.startsWith("*")) { const s = document.createElement("em"); s.textContent = t.slice(1, -1); parent.append(s); }
    else { const a = document.createElement("a"); a.textContent = t.slice(1, t.indexOf("]")); a.title = t.slice(t.indexOf("(") + 1, -1); parent.append(a); }
    last = m.index + t.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}
function renderMarkdown(text, container) {
  container.replaceChildren();
  const lines = text.split("\n");
  let para = [], list = null, code = null;
  const flushP = () => { if (para.length) { const p = document.createElement("p"); inlineMarkdown(para.join(" "), p); container.append(p); para = []; } };
  const flushL = () => { if (list) container.append(list); list = null; };
  for (const line of lines) {
    if (code !== null) {
      if (line.startsWith("```")) code = null;
      else code.textContent += `${line}\n`;
      continue;
    }
    if (line.startsWith("```")) {
      flushP(); flushL();
      const pre = document.createElement("pre"); const inner = document.createElement("code");
      pre.append(inner); container.append(pre); code = inner; continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushP(); flushL(); const el = document.createElement(`h${h[1].length}`); inlineMarkdown(h[2], el); container.append(el); continue; }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    const n = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (b || n) {
      flushP();
      if (list === null || list.tagName !== (b ? "UL" : "OL")) { flushL(); list = document.createElement(b ? "ul" : "ol"); }
      const li = document.createElement("li"); inlineMarkdown((b ?? n)[1], li); list.append(li); continue;
    }
    if (line.trim() === "") { flushP(); flushL(); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();
}

/* ---------- run timeline ---------- */
function formatDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function startRun() {
  const root = document.createElement("div"); root.className = "run";
  const head = document.createElement("button"); head.type = "button"; head.className = "run-head";
  const spinner = document.createElement("span"); spinner.className = "spinner";
  const label = document.createElement("span"); label.className = "run-label"; label.textContent = "Running";
  const timer = document.createElement("span"); timer.className = "run-timer"; timer.textContent = "0s";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▾";
  head.append(spinner, label, timer, chev);
  const body = document.createElement("div"); body.className = "run-body";
  root.append(head, body); stream().append(root);
  const startedAt = Date.now();
  runTimerId = window.setInterval(() => { timer.textContent = formatDuration(Date.now() - startedAt); }, 1000);
  head.addEventListener("click", () => root.classList.toggle("collapsed"));
  run = { root, head, body, label, timer, startedAt };
  stepAssistant = null; stepReasoning = null; scrollDown();
}
function endRun(text, failed) {
  if (run === null) return;
  window.clearInterval(runTimerId);
  run.head.classList.add("done");
  run.label.textContent = text;
  run.timer.textContent = formatDuration(Date.now() - run.startedAt);
  if (failed) run.label.style.color = "var(--danger)";
  collapseReasoning(stepReasoning);
  run = null; stepAssistant = null; stepReasoning = null;
}
function runBody() { if (run === null) startRun(); return run.body; }
function addReasoningBlock(open) {
  const d = document.createElement("details"); d.className = "think";
  const s = document.createElement("summary");
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  const label = document.createElement("span"); label.textContent = "Thinking";
  s.append(chev, label);
  const body = document.createElement("div"); body.className = "think-body";
  d.append(s, body); runBody().append(d);
  const block = { details: d, label, body, text: "", touched: false };
  s.addEventListener("click", () => { block.touched = true; });
  d.open = open; scrollDown();
  return block;
}
function setReasoningText(block, text) {
  block.text = text; block.body.textContent = text;
  block.label.textContent = `Thinking · ${text.length.toLocaleString()} chars`;
  if (block.details.open) block.body.scrollTop = block.body.scrollHeight;
}
function collapseReasoning(block) {
  if (block !== null && !block.touched) {
    block.details.open = false;
    block.label.textContent = `Thought · ${block.text.length.toLocaleString()} chars`;
  }
}
function currentAssistant() {
  if (stepAssistant === null) {
    const body = document.createElement("div"); body.className = "answer";
    runBody().append(body); stepAssistant = { body, text: "" };
  }
  return stepAssistant;
}
function summarizeInput(input) {
  if (typeof input === "object" && input !== null) {
    for (const k of ["path", "command", "pattern", "query", "url"]) {
      const v = input[k];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return "";
}
const TOOL_VERBS = {
  read: "Read", write: "Wrote", edit: "Edited", apply_patch: "Patched", bash: "Ran",
  glob: "Searched files", grep: "Searched text", ls: "Listed", webfetch: "Fetched",
  task: "Subagent", todo_write: "Updated tasks",
};
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
function addToolRow(name, input) {
  const d = document.createElement("details"); d.className = "tool-row running";
  const s = document.createElement("summary");
  const dot = document.createElement("span"); dot.className = "tool-dot";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  const label = document.createElement("span"); label.className = "tool-label";
  const verb = document.createElement("b"); verb.textContent = TOOL_VERBS[name] ?? name;
  const rest = summarizeInput(input);
  label.append(verb);
  if (rest !== "") label.append(document.createTextNode(` ${rest}`));
  s.append(dot, label, chev);
  const output = document.createElement("div"); output.className = "tool-output"; output.textContent = "running...";
  d.append(s, output); runBody().append(d); scrollDown();
  return { details: d, output, label };
}

/* ---------- events ---------- */
function handleEvent(event) {
  if (event.type === "step-start") { stepAssistant = null; stepReasoning = null; return; }
  if (event.type === "reasoning-delta") {
    if (stepReasoning === null) stepReasoning = addReasoningBlock(true);
    setReasoningText(stepReasoning, stepReasoning.text + event.text); scrollDown(); return;
  }
  if (event.type === "text-delta") {
    collapseReasoning(stepReasoning);
    const a = currentAssistant(); a.text += event.text; renderMarkdown(a.text, a.body); scrollDown(); return;
  }
  if (event.type === "tool-call") {
    collapseReasoning(stepReasoning);
    addUsedTool(event.name);
    if (event.name === "todo_write") renderTodos(event.input);
    if (WRITE_TOOLS.has(event.name)) {
      const p = typeof event.input === "object" && event.input !== null ? event.input.path : undefined;
      if (typeof p === "string") pendingWrites.set(event.id, p);
    }
    toolRows.set(event.id, addToolRow(event.name, event.input));
    return;
  }
  if (event.type === "tool-result") {
    const writePath = pendingWrites.get(event.id);
    if (writePath !== undefined) {
      pendingWrites.delete(event.id);
      if (!event.denied && !event.isError) addResultFile(writePath);
    }
    const row = toolRows.get(event.id);
    const first = event.output.split("\n")[0] ?? "";
    const target = row ?? addToolRow(event.name, null);
    target.details.classList.remove("running");
    target.details.classList.add(event.denied ? "denied" : event.isError ? "error" : "ok");
    target.output.textContent = event.output === "" ? "(no output)" : event.output;
    if (event.denied) target.label.append(document.createTextNode(" · denied"));
    else if (first !== "" && event.isError) target.label.append(document.createTextNode(` · ${first.slice(0, 80)}`));
    return;
  }
  if (event.type === "step-end") { collapseReasoning(stepReasoning); return; }
  if (event.type === "compaction") addNotice(`compacted ${event.tokensBefore} -> ${event.tokensAfter} estimated tokens`);
}
function handleFinish(payload) {
  const failed = payload.stopReason !== "completed";
  endRun(failed ? `Stopped: ${payload.stopReason}` : "Completed", failed);
  setBusy(false);
  if (shellEl.classList.contains("right-open")) void loadTree();
  void refreshSessions();
}
function handleError(payload) {
  endRun("Failed", true); setBusy(false);
  if (payload.message !== "request aborted") addNotice(payload.message, "error");
  void refreshSessions();
}

/* ---------- approvals ---------- */
function closeConfirm(approved) {
  if (pendingConfirm === null) return;
  const req = pendingConfirm; pendingConfirm = null; modalEl.hidden = true;
  void api.respond(req.id, approved);
  addNotice(`${approved ? "allowed" : "denied"} ${req.tool}`, approved ? "" : "error");
}
function showConfirm(req) {
  pendingConfirm = req;
  modalTitleEl.textContent = `Allow ${req.tool}?`;
  modalBodyEl.replaceChildren();
  if (req.resources.length > 0) {
    const ul = document.createElement("ul");
    for (const r of req.resources) { const li = document.createElement("li"); li.textContent = r; ul.append(li); }
    modalBodyEl.append(ul);
  }
  const reason = document.createElement("div"); reason.className = "modal-reason"; reason.textContent = req.reason;
  modalBodyEl.append(reason);
  modalEl.hidden = false; approveEl.focus();
}
approveEl.addEventListener("click", () => closeConfirm(true));
denyEl.addEventListener("click", () => closeConfirm(false));

/* ---------- info ---------- */
function showInfo(title, lines) {
  infoTitleEl.textContent = title; infoBodyEl.replaceChildren();
  for (const l of lines) { const p = document.createElement("p"); p.textContent = l; infoBodyEl.append(p); }
  infoEl.hidden = false; infoCloseEl.focus();
}
$("#nav-skills").addEventListener("click", () => showInfo("Skills", [
  "Skills arrive with milestone M10a: markdown skill files discovered from the user config directory and .altiora/skills, injected into context on demand.",
  "Nothing is installed yet. Track progress in docs/PLAN.md.",
]));
$("#nav-connections").addEventListener("click", () => showInfo("Connections", [
  "MCP connections arrive with milestone M9: stdio servers declared in mcpServers, started only for trusted projects, tools exposed as mcp_<server>_<tool>.",
  "No servers are configured in this workspace yet.",
]));
infoCloseEl.addEventListener("click", () => { infoEl.hidden = true; });
infoEl.addEventListener("click", (e) => { if (e.target === infoEl) infoEl.hidden = true; });

/* ---------- sessions ---------- */
function shortId(id) { return id.length > 12 ? id.slice(0, 12) : id; }
function relativeTime(ms) {
  const d = Date.now() - ms; const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
async function refreshSessions() {
  const sessions = await api.sessions();
  sessionsEl.replaceChildren();
  if (sessions.length === 0) {
    const e = document.createElement("div"); e.className = "session-empty"; e.textContent = "No sessions yet";
    sessionsEl.append(e); return;
  }
  for (const s of sessions) {
    const b = document.createElement("button"); b.type = "button"; b.className = "session-item";
    if (s.id === currentSessionId) b.classList.add("active");
    const t = document.createElement("span"); t.className = "session-title-text";
    t.textContent = s.title || `Session ${shortId(s.id)}`;
    const meta = document.createElement("span"); meta.className = "session-meta";
    meta.textContent = relativeTime(s.updatedAt);
    b.append(t, meta);
    b.addEventListener("click", () => void openSession(s.id));
    sessionsEl.append(b);
  }
}
function renderHistory(history) {
  resetResultFiles();
  resetUsedTools();
  if (history.length === 0) { restoreEmpty(); return; }
  messagesEl.replaceChildren();
  const toolResults = new Map();
  const writeCalls = new Map();
  let lastTodos = null;
  for (const m of history) {
    if (m.role === "tool") toolResults.set(m.toolCallId, m);
    if (m.role === "assistant") {
      for (const p of m.content) {
        if (p.type !== "tool_use") continue;
        if (p.name === "todo_write") lastTodos = p.input;
        if (WRITE_TOOLS.has(p.name)) {
          const path = typeof p.input === "object" && p.input !== null ? p.input.path : undefined;
          if (typeof path === "string") writeCalls.set(p.id, path);
        }
      }
    }
  }
  renderTodos(lastTodos);
  for (const m of history) {
    if (m.role === "user") { addUser(m.content); continue; }
    if (m.role === "assistant") {
      if (run === null) startRun();
      if (typeof m.reasoning === "string" && m.reasoning !== "") {
        const b = addReasoningBlock(false); setReasoningText(b, m.reasoning);
        b.label.textContent = `Thought · ${m.reasoning.length.toLocaleString()} chars`;
      }
      for (const p of m.content) {
        if (p.type !== "tool_use") continue;
        addUsedTool(p.name);
        if (writeCalls.has(p.id)) {
          const result = toolResults.get(p.id);
          if (result !== undefined && !result.isError) addResultFile(writeCalls.get(p.id));
        }
      }
      const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (text !== "") { const a = currentAssistant(); a.text = text; renderMarkdown(text, a.body); }
      stepAssistant = null; stepReasoning = null; continue;
    }
    if (m.role === "tool") {
      const row = addToolRow("tool", null);
      row.details.classList.remove("running");
      row.details.classList.add(m.isError ? "error" : "ok");
      row.output.textContent = m.output; continue;
    }
    const summary = m.content.length > 160 ? `${m.content.slice(0, 160)}...` : m.content;
    addNotice(summary);
  }
  endRun("Completed", false); scrollDown();
}
async function openSession(id) {
  if (busy) return;
  const r = await api.openSession(id);
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.sessionId;
  sessionTitleEl.textContent = `Session ${shortId(r.sessionId)}`;
  toolRows.clear(); renderHistory(r.history);
  await refreshSessions();
}

/* ---------- mode ---------- */
function applyModeUI(mode) {
  modeChipEl.textContent = mode;
  modeChipEl.className = `chip mode-${mode}`;
  for (const tab of modeTabs) tab.classList.toggle("active", tab.dataset.mode === mode);
}
async function setMode(mode) {
  const r = await api.setMode(mode);
  if (r.ok) applyModeUI(mode);
  else addNotice(r.message, "error");
}
for (const tab of modeTabs) tab.addEventListener("click", () => void setMode(tab.dataset.mode));
modeChipEl.addEventListener("click", () => {
  const order = ["default", "plan", "unattended"];
  const cur = modeChipEl.textContent;
  void setMode(order[(order.indexOf(cur) + 1) % order.length]);
});

/* ---------- state ---------- */
function setBusy(v) {
  busy = v;
  sendEl.hidden = v; abortEl.hidden = !v; promptEl.disabled = v;
  statusTextEl.textContent = v ? "running" : statusTextEl.dataset.idle ?? "idle";
}
async function refreshState() {
  const r = await api.state();
  if (!r.ok) {
    statusDotEl.classList.add("offline");
    statusTextEl.textContent = r.message; statusTextEl.dataset.idle = r.message;
    setBusy(false); promptEl.disabled = true; sendEl.disabled = true;
    if (r.message !== "starting") addNotice(r.message, "error");
    return;
  }
  const s = r.state;
  currentSessionId = s.sessionId;
  statusDotEl.classList.add("online"); statusDotEl.classList.remove("offline");
  const idle = `${s.model} · ${Math.round(s.contextWindow / 1000)}k ctx`;
  statusTextEl.textContent = idle; statusTextEl.dataset.idle = idle;
  workspaceNameEl.textContent = s.workspace.split(/[\\/]/).pop() ?? s.workspace;
  workspaceNameEl.title = s.workspace;
  sessionTitleEl.textContent = `Session ${shortId(s.sessionId)}`;
  versionEl.textContent = `v${s.version}`;
  modelChipEl.textContent = s.model;
  modelChipEl.title = `Context window ${s.contextWindow.toLocaleString()} (${s.contextWindowSource})`;
  applyModeUI(s.permissionMode);
  promptEl.disabled = false; sendEl.disabled = false;
  await refreshSessions();
}
api.onReady((p) => {
  if (p !== null && typeof p === "object" && "error" in p) {
    statusDotEl.classList.add("offline"); statusTextEl.textContent = p.error;
    addNotice(p.error, "error"); promptEl.disabled = true; sendEl.disabled = true; return;
  }
  void refreshState();
});
api.onEvent(handleEvent);
api.onFinish(handleFinish);
api.onError(handleError);
api.onConfirm(showConfirm);

/* ---------- composer ---------- */
function autosize() {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 176)}px`;
}
promptEl.addEventListener("input", autosize);
composerEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (text === "" || busy) return;
  promptEl.value = ""; autosize();
  addUser(text); toolRows.clear(); startRun(); setBusy(true);
  const r = await api.run(text);
  if (!r.ok && r.message !== "a turn is already running" && r.message !== "request aborted") addNotice(r.message, "error");
  setBusy(false);
});
abortEl.addEventListener("click", () => { addNotice("stopping..."); void api.abort(); });
newSessionEl.addEventListener("click", async () => {
  if (busy) return;
  const r = await api.newSession();
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.sessionId;
  sessionTitleEl.textContent = "New task";
  toolRows.clear(); resetResultFiles(); resetUsedTools(); renderTodos(null); restoreEmpty();
  await refreshSessions();
});
async function pickWorkspace() {
  if (busy) return;
  const r = await api.pickWorkspace();
  if (r.canceled) return;
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.state.sessionId;
  toolRows.clear(); resetResultFiles(); resetUsedTools(); renderTodos(null); restoreEmpty();
  treeLoaded = false;
  await refreshState();
  if (shellEl.classList.contains("right-open")) await loadTree();
}
pickWorkspaceEl.addEventListener("click", () => void pickWorkspace());
composerWorkspaceEl.addEventListener("click", () => void pickWorkspace());
modelChipEl.addEventListener("click", () => showInfo("Model", [
  `Active model: ${modelChipEl.textContent}.`,
  "Mid-session model switching and the model list arrive with milestone M12; today the model comes from config, environment or CLI flags.",
]));

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composerEl.requestSubmit(); }
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    if (e.shiftKey) setRightPanel(!shellEl.classList.contains("right-open"));
    else setSidebar(shellEl.classList.contains("sidebar-collapsed"));
    return;
  }
  if (!modalEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeConfirm(false); }
    else if (e.key === "Enter" && document.activeElement !== denyEl) { e.preventDefault(); closeConfirm(true); }
    return;
  }
  if (!previewEl.hidden && e.key === "Escape") { e.preventDefault(); closePreview(); return; }
  if (!infoEl.hidden && e.key === "Escape") { e.preventDefault(); infoEl.hidden = true; return; }
  if (shellEl.classList.contains("right-open") && e.key === "Escape") { e.preventDefault(); setRightPanel(false); return; }
});

void refreshState();