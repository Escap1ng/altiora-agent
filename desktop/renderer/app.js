import { STRINGS } from "./i18n.js";

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
const wsSearchEl = $("#ws-search");
const wsSearchBoxEl = $("#ws-search-box");
const wsSearchInputEl = $("#ws-search-input");
const wsSortEl = $("#ws-sort");
let sessionFilter = "";
let sessionSort = "recent";
const sessionTitleEl = $("#session-title");
const workspaceNameEl = $("#workspace-name");
const statusDotEl = $("#status-dot");
const statusTextEl = $("#status-text");
const versionEl = $("#version");
const themeToggleEl = $("#theme-toggle");
const modeChipEl = $("#mode-chip");
const modelChipEl = $("#model-chip");
const modalEl = $("#modal");
const modalTitleEl = $("#modal-title");
const modalBodyEl = $("#modal-body");
const approveEl = $("#approve");
const denyEl = $("#deny");
const infoEl = $("#info");
const infoTitleEl = $("#info-title");
const infoBodyEl = $("#info-body");
const infoCloseEl = $("#info-close");
const settingsEl = $("#settings");
const settingsCloseEl = $("#settings-close");
const langTabs = Array.from(document.querySelectorAll("#lang-seg .mode-tab"));
const themeSegTabs = Array.from(document.querySelectorAll("#theme-seg .mode-tab"));

let busy = false;
let currentSessionId = "";
let currentMode = "default";
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
const thinkBlocks = new Set();
const answerBlocks = new Set();

const SIDEBAR_KEY = "altiora.sidebar";
const RIGHT_KEY = "altiora.rightPanel";
const THEME_KEY = "altiora.theme";
const LANG_KEY = "altiora.lang";

// Left/right panel linkage is kept but not wired for now; flip to true to re-enable.
const PANEL_LINKAGE = false;

/* ---------- i18n ---------- */
let lang = localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";

function t(key, vars) {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

function applyI18n() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll(".suggestion[data-sug]")) el.dataset.prompt = t(`sug${el.dataset.sug}.prompt`);
  renderHomeSuggestions();
  applyModeUI(currentMode);
  for (const tab of langTabs) tab.classList.toggle("active", tab.dataset.lang === lang);
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  for (const tab of themeSegTabs) tab.classList.toggle("active", tab.dataset.themeChoice === theme);
  for (const b of thinkBlocks) {
    if (b.details.open && b.text === "") b.label.textContent = t("think.thinking");
    else if (b.details.open) b.label.textContent = t("think.thinkingChars", { n: b.text.length.toLocaleString() });
    else b.label.textContent = t("think.thoughtChars", { n: b.text.length.toLocaleString() });
  }
  for (const a of answerBlocks) renderMarkdown(a.text, a.body);
}

function setLang(next) {
  lang = next === "en" ? "en" : "zh";
  localStorage.setItem(LANG_KEY, lang);
  applyI18n();
  void refreshState();
  void refreshSessions();
  if (treeLoaded) void loadTree();
}

/* ---------- theme ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  for (const tab of themeSegTabs) tab.classList.toggle("active", tab.dataset.themeChoice === theme);
}
applyTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
themeToggleEl.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
);

/* ---------- settings ---------- */
$("#open-settings").addEventListener("click", () => {
  applyI18n();
  settingsEl.hidden = false;
  settingsCloseEl.focus();
});
settingsCloseEl.addEventListener("click", () => { settingsEl.hidden = true; });
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) settingsEl.hidden = true; });
for (const tab of langTabs) tab.addEventListener("click", () => setLang(tab.dataset.lang));
for (const tab of themeSegTabs) tab.addEventListener("click", () => applyTheme(tab.dataset.themeChoice));

/* ---------- panels ---------- */
function setSidebar(open) {
  if (PANEL_LINKAGE && open && shellEl.classList.contains("right-open")) setRightPanel(false);
  shellEl.classList.toggle("sidebar-collapsed", !open);
  toggleSidebarEl.hidden = open;
  toggleSidebarEl.setAttribute("aria-expanded", String(open));
  localStorage.setItem(SIDEBAR_KEY, open ? "open" : "collapsed");
}
function setRightPanel(open) {
  if (open) {
    if (PANEL_LINKAGE) {
      sidebarBeforeRight = !shellEl.classList.contains("sidebar-collapsed");
      shellEl.classList.add("sidebar-collapsed");
      toggleSidebarEl.hidden = false;
      toggleSidebarEl.setAttribute("aria-expanded", "false");
    }
    void loadTree();
  } else if (PANEL_LINKAGE && sidebarBeforeRight) {
    shellEl.classList.remove("sidebar-collapsed");
    toggleSidebarEl.hidden = true;
    toggleSidebarEl.setAttribute("aria-expanded", "true");
    localStorage.setItem(SIDEBAR_KEY, "open");
  }
  shellEl.classList.toggle("right-open", open);
  toggleRightEl.setAttribute("aria-expanded", String(open));
  const key = open ? "progress.hide" : "progress.show";
  toggleRightEl.title = t(key);
  toggleRightEl.setAttribute("aria-label", t(key));
  localStorage.setItem(RIGHT_KEY, open ? "open" : "closed");
}
setSidebar(localStorage.getItem(SIDEBAR_KEY) !== "collapsed");
if (localStorage.getItem(RIGHT_KEY) === "open") setRightPanel(true);

toggleSidebarEl.addEventListener("click", () => setSidebar(true));
collapseSidebarEl.addEventListener("click", () => setSidebar(false));
toggleRightEl.addEventListener("click", () => setRightPanel(!shellEl.classList.contains("right-open")));
closeRightEl.addEventListener("click", () => setRightPanel(false));

let folderAnimTimer = 0;
projectToggleEl.addEventListener("click", () => {
  const group = projectToggleEl.parentElement;
  const collapsed = group.classList.toggle("collapsed");
  projectToggleEl.setAttribute("aria-expanded", String(!collapsed));
  window.clearTimeout(folderAnimTimer);
  group.classList.remove("just-opened");
  if (!collapsed) {
    void group.offsetHeight;
    group.classList.add("just-opened");
    folderAnimTimer = window.setTimeout(() => group.classList.remove("just-opened"), 520);
  }
});
wsSearchEl.addEventListener("click", () => {
  wsSearchBoxEl.hidden = !wsSearchBoxEl.hidden;
  if (!wsSearchBoxEl.hidden) wsSearchInputEl.focus();
  else { sessionFilter = ""; wsSearchInputEl.value = ""; void refreshSessions(); }
});
wsSearchInputEl.addEventListener("input", () => {
  sessionFilter = wsSearchInputEl.value.trim();
  void refreshSessions();
});
wsSortEl.addEventListener("click", () => {
  sessionSort = sessionSort === "recent" ? "name" : "recent";
  void refreshSessions();
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
    m.textContent = t("files.none");
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
    e.textContent = t("tasks.none");
    tasksEl.append(e);
    const m = document.createElement("div");
    m.className = "panel-muted";
    m.textContent = t("plan.empty");
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
  for (const key of ["chip.loop", "chip.permissions", "chip.sessions"]) {
    const chip = document.createElement("span");
    chip.className = "skill-chip";
    chip.dataset.i18n = key;
    chip.textContent = t(key);
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
  treeEl.replaceChildren(treeNote(t("tree.loading")));
  const result = await api.listDir("");
  treeEl.replaceChildren();
  if (!result.ok) return treeEl.append(treeNote(result.message));
  if (result.entries.length === 0) return treeEl.append(treeNote(t("tree.emptyWorkspace")));
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
        else if (r.entries.length === 0) children.append(treeNote(t("tree.empty")));
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
function setHome(on) {
  const was = shellEl.classList.contains("home");
  if (was && !on) {
    const first = composerEl.getBoundingClientRect().top;
    shellEl.classList.remove("home");
    const last = composerEl.getBoundingClientRect().top;
    const dy = first - last;
    if (dy !== 0) {
      composerEl.style.transition = "none";
      composerEl.style.transform = `translateY(${dy}px)`;
      void composerEl.offsetHeight;
      composerEl.style.transition = "transform 320ms cubic-bezier(0.22, 0.8, 0.36, 1)";
      composerEl.style.transform = "";
      window.setTimeout(() => { composerEl.style.transition = ""; }, 360);
    }
  } else {
    shellEl.classList.toggle("home", on);
  }
}
function renderHomeSuggestions() {
  composerEl.querySelector(".suggestions")?.remove();
  if (!shellEl.classList.contains("home")) return;
  const sug = document.createElement("div");
  sug.className = "suggestions";
  for (const i of [1, 2, 3]) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "suggestion"; chip.dataset.sug = String(i);
    chip.dataset.prompt = t(`sug${i}.prompt`);
    chip.textContent = t(`sug${i}.label`);
    sug.append(chip);
  }
  composerEl.append(sug);
}
function restoreEmpty() {
  messagesEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  const hero = document.createElement("div"); hero.className = "home-hero";
  const mark = document.createElement("span"); mark.className = "home-mark"; mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="url(#homeGradDyn)"/><path d="M13.1 17.2l3.8-5.8 3.9 5.8z" fill="#fff"/><path d="M4.2 17.2l6-10.3 6 10.3z" fill="#fff"/><defs><linearGradient id="homeGradDyn" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse"><stop stop-color="#26292e"/><stop offset="1" stop-color="#101114"/></linearGradient></defs></svg>';
  const slogan = document.createElement("h1"); slogan.className = "home-slogan"; slogan.textContent = t("home.slogan");
  hero.append(mark, slogan);
  const sub = document.createElement("p"); sub.className = "home-sub"; sub.textContent = t("home.sub");
  empty.append(hero, sub);
  messagesEl.append(empty);
  setHome(true);
  renderHomeSuggestions();
}
document.addEventListener("click", (e) => {
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
    const tk = m[0];
    if (tk.startsWith("`")) { const c = document.createElement("code"); c.textContent = tk.slice(1, -1); parent.append(c); }
    else if (tk.startsWith("**")) { const s = document.createElement("strong"); s.textContent = tk.slice(2, -2); parent.append(s); }
    else if (tk.startsWith("*")) { const s = document.createElement("em"); s.textContent = tk.slice(1, -1); parent.append(s); }
    else { const a = document.createElement("a"); a.textContent = tk.slice(1, tk.indexOf("]")); a.title = tk.slice(tk.indexOf("(") + 1, -1); parent.append(a); }
    last = m.index + tk.length;
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
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? t("dur.ms", { m, s }) : t("dur.s", { s });
}
function startRun() {
  const root = document.createElement("div"); root.className = "run";
  const head = document.createElement("button"); head.type = "button"; head.className = "run-head";
  const spinner = document.createElement("span"); spinner.className = "spinner";
  const label = document.createElement("span"); label.className = "run-label"; label.textContent = t("run.running");
  const timer = document.createElement("span"); timer.className = "run-timer"; timer.textContent = formatDuration(0);
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
  const label = document.createElement("span"); label.textContent = t("think.thinking");
  s.append(chev, label);
  const body = document.createElement("div"); body.className = "think-body";
  d.append(s, body); runBody().append(d);
  const block = { details: d, label, body, text: "", touched: false };
  thinkBlocks.add(block);
  s.addEventListener("click", () => { block.touched = true; });
  d.open = open; scrollDown();
  return block;
}
function setReasoningText(block, text) {
  block.text = text; block.body.textContent = text;
  block.label.textContent = t("think.thinkingChars", { n: text.length.toLocaleString() });
  if (block.details.open) block.body.scrollTop = block.body.scrollHeight;
}
function collapseReasoning(block) {
  if (block !== null && !block.touched) {
    block.details.open = false;
    block.label.textContent = t("think.thoughtChars", { n: block.text.length.toLocaleString() });
  }
}
function currentAssistant() {
  if (stepAssistant === null) {
    const body = document.createElement("div"); body.className = "answer";
    runBody().append(body); stepAssistant = { body, text: "" };
    answerBlocks.add(stepAssistant);
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
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
function addToolRow(name, input) {
  const d = document.createElement("details"); d.className = "tool-row running";
  const s = document.createElement("summary");
  const dot = document.createElement("span"); dot.className = "tool-dot";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  const label = document.createElement("span"); label.className = "tool-label";
  const verbKey = `verb.${name}`;
  const verb = document.createElement("b"); verb.textContent = STRINGS[lang][verbKey] ?? STRINGS.en[verbKey] ?? name;
  const rest = summarizeInput(input);
  label.append(verb);
  if (rest !== "") label.append(document.createTextNode(` ${rest}`));
  s.append(dot, label, chev);
  const output = document.createElement("div"); output.className = "tool-output"; output.textContent = t("tool.running");
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
    target.output.textContent = event.output === "" ? t("tool.noOutput") : event.output;
    if (event.denied) target.label.append(document.createTextNode(` · ${t("tool.denied")}`));
    else if (first !== "" && event.isError) target.label.append(document.createTextNode(` · ${first.slice(0, 80)}`));
    return;
  }
  if (event.type === "step-end") { collapseReasoning(stepReasoning); return; }
  if (event.type === "compaction") addNotice(t("notice.compaction", { before: event.tokensBefore, after: event.tokensAfter }));
}
function handleFinish(payload) {
  const failed = payload.stopReason !== "completed";
  endRun(failed ? t("run.stopped", { reason: payload.stopReason }) : t("run.completed"), failed);
  setBusy(false);
  if (shellEl.classList.contains("right-open")) void loadTree();
  void refreshSessions();
}
function handleError(payload) {
  endRun(t("run.failed"), true); setBusy(false);
  if (payload.message !== "request aborted") addNotice(payload.message, "error");
  void refreshSessions();
}

/* ---------- approvals ---------- */
function closeConfirm(approved) {
  if (pendingConfirm === null) return;
  const req = pendingConfirm; pendingConfirm = null; modalEl.hidden = true;
  void api.respond(req.id, approved);
  addNotice(t(approved ? "notice.allowed" : "notice.denied", { tool: req.tool }), approved ? "" : "error");
}
function showConfirm(req) {
  pendingConfirm = req;
  modalTitleEl.textContent = t("allowTool", { tool: req.tool });
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
$("#nav-skills").addEventListener("click", () => showInfo(t("info.skills.title"), [t("info.skills.1"), t("info.skills.2")]));
$("#nav-connections").addEventListener("click", () => showInfo(t("info.connections.title"), [t("info.connections.1"), t("info.connections.2")]));
infoCloseEl.addEventListener("click", () => { infoEl.hidden = true; });
infoEl.addEventListener("click", (e) => { if (e.target === infoEl) infoEl.hidden = true; });

/* ---------- schedules ---------- */
const schedulesEl = $("#schedules");
const schedListEl = $("#sched-list");
const schedCloseEl = $("#sched-close");
const schedAddEl = $("#sched-add");
const schedNameEl = $("#sched-name");
const schedCronEl = $("#sched-cron");
const schedPromptEl = $("#sched-prompt");
const schedAllowEl = $("#sched-allow");

function fmtTime(ms) {
  return new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
}
async function renderSchedules() {
  const entries = await api.schedules();
  schedListEl.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    const m = document.createElement("div");
    m.className = "panel-muted";
    m.textContent = t("sched.empty");
    schedListEl.append(m);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `sched-row${entry.enabled ? "" : " off"}`;
    const info = document.createElement("div");
    info.className = "sched-info";
    const name = document.createElement("div");
    name.className = "sched-name";
    name.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "sched-meta";
    const next = entry.nextRunAt ? t("sched.next", { time: fmtTime(entry.nextRunAt) }) : "";
    const last = entry.lastRunAt ? t("sched.last", { time: fmtTime(entry.lastRunAt), status: entry.lastStatus ?? "" }) : "";
    meta.textContent = `${entry.cron}  ${next}  ${last}`;
    info.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "sched-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = t("sched.run");
    run.addEventListener("click", async () => {
      run.textContent = t("sched.running");
      run.disabled = true;
      await api.runSchedule(entry.id);
      await renderSchedules();
    });
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = entry.enabled ? t("sched.disable") : t("sched.enable");
    toggle.addEventListener("click", async () => {
      await api.toggleSchedule(entry.id, !entry.enabled);
      await renderSchedules();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = t("sched.remove");
    remove.addEventListener("click", async () => {
      await api.removeSchedule(entry.id);
      await renderSchedules();
    });
    actions.append(run, toggle, remove);
    row.append(info, actions);
    schedListEl.append(row);
  }
}
$("#nav-schedules").addEventListener("click", () => {
  schedulesEl.hidden = false;
  void renderSchedules();
  schedCloseEl.focus();
});
schedCloseEl.addEventListener("click", () => { schedulesEl.hidden = true; });
schedulesEl.addEventListener("click", (e) => { if (e.target === schedulesEl) schedulesEl.hidden = true; });
schedAddEl.addEventListener("click", async () => {
  const allow = schedAllowEl.value.split(",").map((v) => v.trim()).filter((v) => v !== "");
  const result = await api.addSchedule({
    name: schedNameEl.value,
    cron: schedCronEl.value,
    prompt: schedPromptEl.value,
    allow,
  });
  if (result.ok) {
    schedNameEl.value = "";
    schedCronEl.value = "";
    schedPromptEl.value = "";
    schedAllowEl.value = "";
    await renderSchedules();
  } else {
    addNotice(result.message, "error");
  }
});

/* ---------- sessions ---------- */
function shortId(id) { return id.length > 12 ? id.slice(0, 12) : id; }
function relativeTime(ms) {
  const d = Date.now() - ms; const m = Math.floor(d / 60000);
  if (m < 1) return t("time.now");
  if (m < 60) return t("time.m", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.h", { n: h });
  const days = Math.floor(h / 24);
  if (days < 7) return t("time.d", { n: days });
  return new Date(ms).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US");
}
async function refreshSessions() {
  const sessions = await api.sessions();
  sessionsEl.replaceChildren();

  const newRow = document.createElement("button");
  newRow.type = "button"; newRow.className = "session-item session-new";
  const newTi = document.createElement("span"); newTi.className = "session-title-text";
  newTi.textContent = t("ws.new");
  newRow.append(newTi);
  newRow.addEventListener("click", () => newSessionEl.click());
  sessionsEl.append(newRow);

  let list = sessions;
  if (sessionFilter !== "") {
    const f = sessionFilter.toLowerCase();
    list = list.filter((s) => (s.title || "").toLowerCase().includes(f));
  }
  if (sessionSort === "name") {
    list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  } else {
    list = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  for (const s of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "session-item";
    if (s.id === currentSessionId) b.classList.add("active");
    const ti = document.createElement("span"); ti.className = "session-title-text";
    ti.textContent = s.title || t("session.fallback", { id: shortId(s.id) });
    const meta = document.createElement("span"); meta.className = "session-meta";
    meta.textContent = relativeTime(s.updatedAt);
    b.append(ti, meta);
    b.addEventListener("click", () => void openSession(s.id));
    sessionsEl.append(b);
  }
}
function clearTimeline() {
  for (const b of thinkBlocks) b.details.remove();
  thinkBlocks.clear();
  for (const a of answerBlocks) a.body.remove();
  answerBlocks.clear();
}
function renderHistory(history) {
  clearTimeline();
  resetResultFiles();
  resetUsedTools();
  if (history.length === 0) { restoreEmpty(); return; }
  setHome(false); renderHomeSuggestions();
  messagesEl.replaceChildren();
  const toolResults = new Map();
  const writeCalls = new Map();
  const toolUses = new Map();
  let lastTodos = null;
  for (const m of history) {
    if (m.role === "tool") toolResults.set(m.toolCallId, m);
    if (m.role === "assistant") {
      for (const p of m.content) {
        if (p.type !== "tool_use") continue;
        toolUses.set(p.id, p);
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
        b.label.textContent = t("think.thoughtChars", { n: m.reasoning.length.toLocaleString() });
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
      const use = toolUses.get(m.toolCallId);
      const row = addToolRow(use?.name ?? "tool", use?.input ?? null);
      row.details.classList.remove("running");
      row.details.classList.add(m.isError ? "error" : "ok");
      row.output.textContent = m.output; continue;
    }
    const summary = m.content.length > 160 ? `${m.content.slice(0, 160)}...` : m.content;
    addNotice(summary);
  }
  endRun(t("run.completed"), false); scrollDown();
}
async function openSession(id) {
  if (busy) return;
  const r = await api.openSession(id);
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.sessionId;
  sessionTitleEl.textContent = t("session.fallback", { id: shortId(r.sessionId) });
  toolRows.clear(); renderHistory(r.history);
  await refreshSessions();
}

/* ---------- mode ---------- */
function applyModeUI(mode) {
  currentMode = mode;
  modeChipEl.textContent = t(`mode.${mode}`);
  modeChipEl.className = `chip mode-${mode}`;
}
async function setMode(mode) {
  const r = await api.setMode(mode);
  if (r.ok) applyModeUI(mode);
  else addNotice(r.message, "error");
}
modeChipEl.addEventListener("click", () => {
  const order = ["default", "plan", "unattended"];
  void setMode(order[(order.indexOf(currentMode) + 1) % order.length]);
});

/* ---------- state ---------- */
function setBusy(v) {
  busy = v;
  sendEl.hidden = v; abortEl.hidden = !v; promptEl.disabled = v;
  statusTextEl.textContent = v ? t("status.running") : statusTextEl.dataset.idle ?? t("status.starting");
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
  const idle = t("status.ctx", { model: s.model, k: Math.round(s.contextWindow / 1000) });
  statusTextEl.textContent = busy ? t("status.running") : idle;
  statusTextEl.dataset.idle = idle;
  workspaceNameEl.title = s.workspace;
  sessionTitleEl.textContent = t("session.fallback", { id: shortId(s.sessionId) });
  versionEl.textContent = `v${s.version}`;
  modelChipEl.textContent = s.model;
  modelChipEl.title = t("model.title", { n: s.contextWindow.toLocaleString(), source: s.contextWindowSource });
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
  setHome(false); renderHomeSuggestions();
  addUser(text); toolRows.clear(); startRun(); setBusy(true);
  const r = await api.run(text);
  if (!r.ok && r.message !== "a turn is already running" && r.message !== "request aborted") addNotice(r.message, "error");
  setBusy(false);
});
abortEl.addEventListener("click", () => { addNotice(t("notice.stopping")); void api.abort(); });
newSessionEl.addEventListener("click", async () => {
  if (busy) return;
  const r = await api.newSession();
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.sessionId;
  sessionTitleEl.textContent = t("session.new");
  toolRows.clear(); clearTimeline(); resetResultFiles(); resetUsedTools(); renderTodos(null); restoreEmpty();
  await refreshSessions();
});
async function pickWorkspace() {
  if (busy) return;
  const r = await api.pickWorkspace();
  if (r.canceled) return;
  if (!r.ok) { addNotice(r.message, "error"); return; }
  currentSessionId = r.state.sessionId;
  toolRows.clear(); clearTimeline(); resetResultFiles(); resetUsedTools(); renderTodos(null); restoreEmpty();
  treeLoaded = false;
  await refreshState();
  if (shellEl.classList.contains("right-open")) await loadTree();
}
pickWorkspaceEl.addEventListener("click", () => void pickWorkspace());
composerWorkspaceEl.addEventListener("click", () => void pickWorkspace());
modelChipEl.addEventListener("click", () => showInfo(t("info.model.title"), [
  t("info.model.1", { model: modelChipEl.textContent }),
  t("info.model.2"),
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
  if (!settingsEl.hidden && e.key === "Escape") { e.preventDefault(); settingsEl.hidden = true; return; }
  if (!schedulesEl.hidden && e.key === "Escape") { e.preventDefault(); schedulesEl.hidden = true; return; }
  if (!infoEl.hidden && e.key === "Escape") { e.preventDefault(); infoEl.hidden = true; return; }
  if (shellEl.classList.contains("right-open") && e.key === "Escape") { e.preventDefault(); setRightPanel(false); return; }
});

setHome(true);
applyI18n();
void refreshState();