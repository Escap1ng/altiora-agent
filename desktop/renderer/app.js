const api = window.altiora;

const messagesEl = document.querySelector("#messages");
const composerEl = document.querySelector("#composer");
const promptEl = document.querySelector("#prompt");
const sendEl = document.querySelector("#send");
const abortEl = document.querySelector("#abort");
const sessionsEl = document.querySelector("#sessions");
const newSessionEl = document.querySelector("#new-session");
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
let assistantBubble = null;
let pendingConfirm = null;
const toolRows = new Map();

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
  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = "Ready when you are";
  const body = document.createElement("div");
  body.className = "empty-body";
  body.textContent = "Ask Altiora to inspect or change the workspace.";
  empty.append(title, body);
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

function currentAssistant() {
  if (assistantBubble === null) assistantBubble = addBubble("assistant");
  return assistantBubble;
}

function handleEvent(event) {
  if (event.type === "text-delta") {
    const bubble = currentAssistant();
    bubble.body.textContent += event.text;
    scrollDown();
    return;
  }
  if (event.type === "tool-call") {
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
  if (event.type === "compaction") {
    addNotice(
      `compacted ${event.tokensBefore} -> ${event.tokensAfter} estimated tokens`,
    );
  }
}

function handleFinish(payload) {
  assistantBubble = null;
  setBusy(false);
  if (payload.stopReason !== "completed") addNotice(`stopped: ${payload.stopReason}`, "error");
  void refreshSessions();
}

function handleError(payload) {
  assistantBubble = null;
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
  assistantBubble = null;
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
    addNotice(result.message, "error");
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
  void refreshState();
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
  assistantBubble = null;
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
  assistantBubble = null;
  restoreEmpty();
  await refreshSessions();
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
  if (modalEl.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeConfirm(false);
  } else if (event.key === "Enter" && document.activeElement !== denyEl) {
    event.preventDefault();
    closeConfirm(true);
  }
});

void refreshState();
