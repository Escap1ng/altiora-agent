import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./agent.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let window: BrowserWindow | undefined;
let service: AgentService | undefined;
let startupError: string | undefined;

function send(channel: string, payload: unknown): void {
  if (window !== undefined && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: "Altiora",
    backgroundColor: "#0e1116",
    show: false,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadFile(join(root, "renderer", "index.html"));
}

ipcMain.handle("app:ping", () => ({ version: app.getVersion() }));

ipcMain.handle("altiora:state", () =>
  service === undefined
    ? { ok: false, message: startupError ?? "starting" }
    : { ok: true, state: service.state() },
);

ipcMain.handle("altiora:run", (_event, prompt: unknown) => {
  if (service === undefined) return { ok: false, message: startupError ?? "starting" };
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return { ok: false, message: "prompt must be a non-empty string" };
  }
  return service.run(prompt.trim());
});

ipcMain.handle("altiora:abort", () => {
  service?.abort();
  return { ok: true };
});

ipcMain.handle("altiora:sessions", () => service?.sessions() ?? []);

ipcMain.handle("altiora:open-session", (_event, id: unknown) => {
  if (service === undefined) return { ok: false, message: startupError ?? "starting" };
  if (typeof id !== "string" || id === "") return { ok: false, message: "invalid session id" };
  return service.openSession(id);
});

ipcMain.handle("altiora:new-session", () =>
  service === undefined ? { ok: false, message: startupError ?? "starting" } : service.newSession(),
);

ipcMain.handle("altiora:pick-workspace", async () => {
  if (service?.isRunning() === true) return { ok: false, message: "stop the current turn first" };
  const options: Electron.OpenDialogOptions = {
    title: "Choose a workspace",
    properties: ["openDirectory"],
  };
  const result =
    window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  if (result.canceled) return { canceled: true };
  const cwd = result.filePaths[0];
  if (cwd === undefined) return { canceled: true };

  try {
    service?.abort();
    service = await AgentService.create({
      cwd,
      env: process.env,
      version: app.getVersion(),
      send,
    });
    const state = service.state();
    send("altiora:ready", state);
    return { ok: true, state };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("altiora:confirm-response", (_event, payload: unknown) => {
  if (typeof payload !== "object" || payload === null) return { ok: false };
  const record = payload as Record<string, unknown>;
  const id = record["id"];
  const approved = record["approved"];
  if (typeof id !== "string" || typeof approved !== "boolean") return { ok: false };
  return { ok: service?.resolveConfirm(id, approved) ?? false };
});

void app.whenReady().then(async () => {
  createWindow();

  try {
    service = await AgentService.create({
      cwd: process.env.ALTIORA_WORKSPACE ?? process.cwd(),
      env: process.env,
      version: app.getVersion(),
      send,
    });
    send("altiora:ready", service.state());
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    send("altiora:ready", { error: startupError });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
