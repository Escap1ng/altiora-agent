const api = window.altiora;

const shellEl = document.querySelector(".shell");
const toggleSidebarEl = document.querySelector("#toggle-sidebar");
const toggleRightEl = document.querySelector("#toggle-right");
const treeEl = document.querySelector("#tree");
const refreshTreeEl = document.querySelector("#refresh-tree");
const previewEl = document.querySelector("#preview");
const previewPathEl = document.querySelector("#preview-path");
const previewBodyEl = document.querySelector("#preview-body");
const previewCloseEl = document.querySelector("#preview-close");
const messagesEl = document.querySelector("#messages");
const composerEl = document.querySelector("#composer");
const promptEl = document.querySelector("#prompt");
const sendEl = document.querySelector("#send");
const abortEl = document.querySelector("#abort");
const sessionsEl = document.querySelector("#sessions");
const newSessionEl = document.querySelector("#new-session");
const pickWorkspaceEl = document.querySelector("#pick-workspace");
const sessionTitleEl = document.querySelector("#session-title");
const workspaceEl = document.querySelector("#workspace");
const statusDotEl = document.querySelector("#status-dot");
const statusTextEl = document.querySelector("#status-text");
const modalEl = document.querySelector("#modal");
const modalTitleEl = document.querySelector("#modal-title");
const modalBodyEl = document.querySelector("#modal-body");
const approveEl = document.querySelector("#approve");
const denyEl = document.querySelector("#deny");

let busy = false;
let currentSessionId = "";
let stepAssistant = null;
let stepReasoning = null;
let pendingConfirm = null;
const toolRows = new Map();

const SIDEBAR_KEY = "altiora.sidebar";
const RIGHT_KEY = "altiora.rightPanel";
let treeLoaded = false;

function setSidebar(open) {
  shellEl.classList.toggle("sidebar-collapsed", !open);
  toggleSidebarEl.setAttribute("aria-expanded", String(open));
  toggleSidebarEl.title = open ? "Hide sidebar" : "Show sidebar";
  localStorage.setItem(SIDEBAR_KEY, open ? "open" : "collapsed");
}

function setRightPanel(open) {
  shellEl.classList.toggle("right-open", open);
  toggleRightEl.setAttribute("aria-expanded", String(open));
  toggleRightEl.title = open ? "Hide files" : "Show files";
  localStorage.setItem(RIGHT_KEY, open ? "open" : "closed");
  if (open && !treeLoaded) void loadTree();
}

function treeNote(text) {
  const note = document.createElement("div");
  note.className = "tree-note";
  note.textContent = text;
  return note;
}

async function loadTree() {
  treeLoaded = true;
  treeEl.replaceChildren(treeNote("loading..."));
  const result = await api.listDir("");
  treeEl.replaceChildren();
  if (!result.ok) {
    treeEl.append(treeNote(result.message));
    return;
  }
  if (result.entries.length === 0) {
    treeEl.append(treeNote("empty workspace"));
    return;
  }
  renderEntries(treeEl, result.entries, 0);
}

function renderEntries(container, entries, depth) {
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "tree-item";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tree-row ${entry.type}`;
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const marker = document.createElement("span");
    marker.className = entry.type === "dir" ? "chevron" : "file-dot";
    if (entry.type === "dir") marker.textContent = "▸";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;
    row.append(marker, label);

    const children = document.createElement("div");
    children.className = "tree-children";
    children.hidden = true;
    item.append(row, children);
    container.append(item);

    if (entry.type === "file") {
      row.addEventListener("click", () => void openPreview(entry.path));
      continue;
    }

    row.addEventListener("click", async () => {
      if (children.dataset.loaded !== "1") {
        const result = await api.listDir(entry.path);
        children.replaceChildren();
        if (!result.ok) children.append(treeNote(result.message));
        else if (result.entries.length === 0) children.append(treeNote("empty"));
        else renderEntries(children, result.entries, depth + 1);
        children.dataset.loaded = "1";
      }
      children.hidden = !children.hidden;
      marker.textContent = children.hidden ? "▸" : "▾";
    });
  }
}

function loadTreeIfOpen() {
  if (shellEl.classList.contains("right-open")) return loadTree();
  return Promise.resolve();
}

async function openPreview(path) {
  const result = await api.readFile(path);
  previewPathEl.textContent = path;
  previewBodyEl.textContent = result.ok ? result.content : result.message;
  previewEl.hidden = false;
  previewCloseEl.focus();
}

function closePreview() {
  previewEl.hidden = true;
}

setSidebar(localStorage.getItem(SIDEBAR_KEY) !== "collapsed");
setRightPanel(localStorage.getItem(RIGHT_KEY) !== "closed");

toggleSidebarEl.addEventListener("click", () => {
  setSidebar(shellEl.classList.contains("sidebar-collapsed"));
});

toggleRightEl.addEventListener("click", () => {
  setRightPanel(!shellEl.classList.contains("right-open"));
});

refreshTreeEl.addEventListener("click", () => {
  void loadTree();
});

previewCloseEl.addEventListener("click", closePreview);
previewEl.addEventListener("click", (event) => {
  if (event.target === previewEl) closePreview();
});

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeEmpty() {
  messagesEl.querySelector(".empty")?.remove();
}

function restoreEmpty() {
  messagesEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  const mark = document.createElement("div");
  mark.className = "empty-mark";
  mark.textContent = "A";
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = "Ready when you are";
  const body = document.createElement("div");
  body.className = "empty-body";
  body.textContent = "Ask Altiora to inspect or change the workspace.";
  empty.append(mark, title, body);
  messagesEl.append(empty);
}

function addBubble(role, text = "") {
  removeEmpty();
  const root = document.createElement("div");
  root.className = `msg ${role}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  root.append(body);
  messagesEl.append(root);
  scrollDown();
  return { root, body };
}

function addNotice(text, kind = "") {
  removeEmpty();
  const notice = document.createElement("div");
  notice.className = `notice ${kind}`.trim();
  notice.textContent = text;
  messagesEl.append(notice);
  scrollDown();
}

function summarizeInput(input) {
  if (typeof input === "object" && input !== null) {
    for (const key of ["path", "command", "pattern"]) {
      const value = input[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function addToolRow(name, input) {
  removeEmpty();
  const row = document.createElement("div");
  row.className = "tool-row";
  const summary = summarizeInput(input);
  row.textContent = summary === "" ? `tool ${name}` : `tool ${name} ${summary}`;
  messagesEl.append(row);
  scrollDown();
  return row;
}

function setBusy(value) {
  busy = value;
  sendEl.disabled = value;
  abortEl.hidden = !value;
  statusTextEl.textContent = value ? "running" : statusTextEl.dataset.idle ?? "idle";
}

function addReasoningBlock(open) {
  removeEmpty();
  const details = document.createElement("details");
  details.className = "reasoning";
  const summary = document.createElement("summary");
  const body = document.createElement("div");
  body.className = "reasoning-body";
  details.append(summary, body);
  messagesEl.append(details);

  const block = { details, summary, body, text: "", touched: false };
  summary.addEventListener("click", () => {
    block.touched = true;
  });
  details.open = open;
  scrollDown();
  return block;
}

function setReasoningText(block, text) {
  block.text = text;
  block.body.textContent = text;
  block.summary.textContent = `Thinking · ${text.length.toLocaleString()} chars`;
  if (block.details.open) block.body.scrollTop = block.body.scrollHeight;
}

function collapseReasoning(block) {
  if (block !== null && !block.touched) block.details.open = false;
}

function resetStep() {
  stepAssistant = null;
  stepReasoning = null;
}

function currentAssistant() {
  if (stepAssistant === null) stepAssistant = addBubble("assistant");
  return stepAssistant;
}

function handleEvent(event) {
  if (event.type === "step-start") {
    resetStep();
    return;
  }
  if (event.type === "reasoning-delta") {
    if (stepReasoning === null) stepReasoning = addReasoningBlock(true);
    setReasoningText(stepReasoning, stepReasoning.text + event.text);
    scrollDown();
    return;
  }
  if (event.type === "text-delta") {
    collapseReasoning(stepReasoning);
    const bubble = currentAssistant();
    bubble.body.textContent += event.text;
    scrollDown();
    return;
  }
  if (event.type === "tool-call") {
    collapseReasoning(stepReasoning);
    toolRows.set(event.id, addToolRow(event.name, event.input));
    return;
  }
  if (event.type === "tool-result") {
    const row = toolRows.get(event.id);
    const firstLine = event.output.split("\n")[0] ?? "";
    if (row === undefined) {
      const created = addToolRow(event.name, null);
      created.textContent += firstLine === "" ? "" : ` ${firstLine}`;
      if (event.isError) created.classList.add("error");
      return;
    }
    row.classList.add(event.isError ? "error" : "ok");
    if (firstLine !== "") row.textContent += ` - ${firstLine}`;
    return;
  }
  if (event.type === "step-end") {
    collapseReasoning(stepReasoning);
    return;
  }
  if (event.type === "compaction") {
    addNotice(
      `compacted ${event.tokensBefore} -> ${event.tokensAfter} estimated tokens`,
    );
  }
}

function handleFinish(payload) {
  resetStep();
  setBusy(false);
  if (payload.stopReason !== "completed") addNotice(`stopped: ${payload.stopReason}`, "error");
  void refreshSessions();
}

function handleError(payload) {
  resetStep();
  setBusy(false);
  if (payload.message !== "request aborted") addNotice(payload.message, "error");
  void refreshSessions();
}

function closeConfirm(approved) {
  if (pendingConfirm === null) return;
  const request = pendingConfirm;
  pendingConfirm = null;
  modalEl.hidden = true;
  void api.respond(request.id, approved);
  addNotice(`${approved ? "allowed" : "denied"} ${request.tool}`, approved ? "" : "error");
}

function showConfirm(request) {
  pendingConfirm = request;
  modalTitleEl.textContent = `Allow ${request.tool}?`;
  modalBodyEl.replaceChildren();
  if (request.resources.length > 0) {
    const list = document.createElement("ul");
    for (const resource of request.resources) {
      const item = document.createElement("li");
      item.textContent = resource;
      list.append(item);
    }
    modalBodyEl.append(list);
  }
  const reason = document.createElement("div");
  reason.className = "modal-reason";
  reason.textContent = request.reason;
  modalBodyEl.append(reason);
  modalEl.hidden = false;
  approveEl.focus();
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function formatDate(milliseconds) {
  return new Date(milliseconds).toLocaleString();
}

async function refreshSessions() {
  const sessions = await api.sessions();
  sessionsEl.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No sessions yet";
    sessionsEl.append(empty);
    return;
  }
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    if (session.id === currentSessionId) button.classList.add("active");
    const id = document.createElement("span");
    id.className = "session-id";
    id.textContent = shortId(session.id);
    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.model || "unknown"} · ${formatDate(session.updatedAt)}`;
    button.append(id, meta);
    button.addEventListener("click", () => void openSession(session.id));
    sessionsEl.append(button);
  }
}

function renderHistory(history) {
  if (history.length === 0) {
    restoreEmpty();
    return;
  }
  messagesEl.replaceChildren();
  for (const message of history) {
    if (message.role === "user") {
      addBubble("user", message.content);
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.reasoning === "string" && message.reasoning !== "") {
        const block = addReasoningBlock(false);
        setReasoningText(block, message.reasoning);
      }
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text !== "") addBubble("assistant", text);
      continue;
    }
    if (message.role === "tool") {
      const row = document.createElement("div");
      row.className = message.isError ? "tool-row error" : "tool-row ok";
      row.textContent = `tool ${message.toolCallId} - ${(message.output.split("\n")[0] ?? "").slice(0, 200)}`;
      messagesEl.append(row);
      continue;
    }
    const summary = message.content.length > 160 ? `${message.content.slice(0, 160)}...` : message.content;
    addNotice(summary);
  }
  scrollDown();
}

async function openSession(id) {
  if (busy) return;
  const result = await api.openSession(id);
  if (!result.ok) {
    addNotice(result.message, "error");
    return;
  }
  currentSessionId = result.sessionId;
  sessionTitleEl.textContent = `Session ${shortId(result.sessionId)}`;
  resetStep();
  renderHistory(result.history);
  await refreshSessions();
}

async function refreshState() {
  const result = await api.state();
  if (!result.ok) {
    statusDotEl.classList.add("offline");
    statusTextEl.textContent = result.message;
    statusTextEl.dataset.idle = result.message;
    setBusy(false);
    promptEl.disabled = true;
    sendEl.disabled = true;
    if (result.message !== "starting") addNotice(result.message, "error");
    return;
  }
  const state = result.state;
  currentSessionId = state.sessionId;
  statusDotEl.classList.add("online");
  statusDotEl.classList.remove("offline");
  statusTextEl.textContent = `${state.model} · ${state.contextWindow} ctx (${state.contextWindowSource})`;
  statusTextEl.dataset.idle = `${state.model} · ${state.contextWindow} ctx (${state.contextWindowSource})`;
  workspaceEl.textContent = state.workspace;
  sessionTitleEl.textContent = `Session ${shortId(state.sessionId)}`;
  promptEl.disabled = false;
  sendEl.disabled = false;
  await refreshSessions();
}

api.onReady((payload) => {
  if (payload !== null && typeof payload === "object" && "error" in payload) {
    statusDotEl.classList.add("offline");
    statusTextEl.textContent = payload.error;
    addNotice(payload.error, "error");
    promptEl.disabled = true;
    sendEl.disabled = true;
    return;
  }
  void refreshState().then(() => loadTreeIfOpen());
});
api.onEvent(handleEvent);
api.onFinish(handleFinish);
api.onError(handleError);
api.onConfirm(showConfirm);

composerEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if (text === "" || busy) return;
  promptEl.value = "";
  addBubble("user", text);
  resetStep();
  toolRows.clear();
  setBusy(true);
  const result = await api.run(text);
  if (!result.ok && result.message !== "a turn is already running") {
    if (result.message !== "request aborted") addNotice(result.message, "error");
  }
  setBusy(false);
});

abortEl.addEventListener("click", () => {
  addNotice("stopping...");
  void api.abort();
});

newSessionEl.addEventListener("click", async () => {
  if (busy) return;
  const result = await api.newSession();
  if (!result.ok) {
    addNotice(result.message, "error");
    return;
  }
  currentSessionId = result.sessionId;
  sessionTitleEl.textContent = `Session ${shortId(result.sessionId)}`;
  resetStep();
  restoreEmpty();
  await refreshSessions();
});

pickWorkspaceEl.addEventListener("click", async () => {
  if (busy) return;
  const result = await api.pickWorkspace();
  if (result.canceled) return;
  if (!result.ok) {
    addNotice(result.message, "error");
    return;
  }
  currentSessionId = result.state.sessionId;
  resetStep();
  toolRows.clear();
  restoreEmpty();
  treeLoaded = false;
  await refreshState();
  await loadTreeIfOpen();
});

approveEl.addEventListener("click", () => closeConfirm(true));
denyEl.addEventListener("click", () => closeConfirm(false));

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "b") {
    event.preventDefault();
    if (event.shiftKey) setRightPanel(!shellEl.classList.contains("right-open"));
    else setSidebar(shellEl.classList.contains("sidebar-collapsed"));
    return;
  }
  if (!previewEl.hidden && event.key === "Escape") {
    event.preventDefault();
    closePreview();
    return;
  }
  if (modalEl.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeConfirm(false);
  } else if (event.key === "Enter" && document.activeElement !== denyEl) {
    event.preventDefault();
    closeConfirm(true);
  }
});

void refreshState().then(() => loadTreeIfOpen());
