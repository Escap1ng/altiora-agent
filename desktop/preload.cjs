const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("altiora", {
  ping: () => ipcRenderer.invoke("app:ping"),
  state: () => ipcRenderer.invoke("altiora:state"),
  run: (prompt) => ipcRenderer.invoke("altiora:run", prompt),
  abort: () => ipcRenderer.invoke("altiora:abort"),
  sessions: () => ipcRenderer.invoke("altiora:sessions"),
  openSession: (id) => ipcRenderer.invoke("altiora:open-session", id),
  newSession: () => ipcRenderer.invoke("altiora:new-session"),
  pickWorkspace: () => ipcRenderer.invoke("altiora:pick-workspace"),
  respond: (id, approved) => ipcRenderer.invoke("altiora:confirm-response", { id, approved }),
  onReady: (callback) => subscribe("altiora:ready", callback),
  onEvent: (callback) => subscribe("altiora:event", callback),
  onFinish: (callback) => subscribe("altiora:run-finished", callback),
  onError: (callback) => subscribe("altiora:run-error", callback),
  onConfirm: (callback) => subscribe("altiora:confirm-request", callback),
});
