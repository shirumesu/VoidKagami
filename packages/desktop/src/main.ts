import { app, BrowserWindow, dialog, ipcMain, Notification, shell, Menu } from "electron";
import { resolve, join } from "node:path";
import { SocketClient } from "@voidkagami/client";
import type { Method, RpcMethods, RpcNotification, SessionEvent } from "@voidkagami/protocol";

let window: BrowserWindow | undefined;
const client = new SocketClient({ daemonPath: process.env.VOIDKAGAMI_DAEMON || (app.isPackaged ? join(process.resourcesPath, "daemon.js") : resolve(app.getAppPath(), "../daemon/src/index.ts")) });
const allowed = new Set<Method>(["daemon.status", "session.create", "session.list", "session.attach", "session.detach", "session.send", "session.steer", "session.followUp", "session.abort", "session.rename", "session.fork", "session.rewind", "session.context", "session.compact", "session.diff", "session.mode", "session.tasks", "task.stop", "approval.respond", "model.list", "model.select", "auth.login", "auth.respond", "auth.key", "auth.logout", "auth.status", "config.get", "config.set", "project.branches", "project.files", "commands.list"]);

app.setName("VoidKagami");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  ipcMain.handle("rpc", (_event, method: Method, params: RpcMethods[Method]["params"]) => {
    if (!allowed.has(method)) throw new Error(`Unsupported method: ${method}`);
    return client.request(method, params);
  });
  ipcMain.handle("choose-folder", async () => { const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"], title: "Open project" }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle("choose-attachments", async () => { const result = await dialog.showOpenDialog(window!, { properties: ["openFile", "multiSelections"], title: "Attach files" }); return result.canceled ? [] : result.filePaths; });
  ipcMain.handle("open-external", async (_event, url: string) => { if (/^https?:\/\//.test(url)) await shell.openExternal(url); });
  client.on("notification", (message: RpcNotification) => {
    window?.webContents.send("notification", message);
    if (message.method !== "event" || window?.isFocused()) return;
    const event = message.params as SessionEvent;
    if (["turn.ended", "approval.requested", "run.error"].includes(event.type) && Notification.isSupported()) {
      const notification = new Notification({ title: event.type === "approval.requested" ? "VoidKagami needs your input" : event.type === "run.error" ? "Task failed" : "Task finished", body: String(event.data.message || "Open VoidKagami to continue.") });
      notification.on("click", () => { window?.show(); window?.focus(); }); notification.show();
    }
  });
  client.on("replay", (view) => window?.webContents.send("replay", view));
  client.on("state", (state) => window?.webContents.send("connection", state));
  client.on("connectionError", (error: Error) => window?.webContents.send("connection", error.message));

  async function createWindow() {
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 620, title: "VoidKagami", titleBarStyle: "hiddenInset", backgroundColor: "#171717", webPreferences: { preload: join(app.getAppPath(), "dist/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: "deny" }; });
    if (process.env.VOIDKAGAMI_RENDERER_URL) await window.loadURL(process.env.VOIDKAGAMI_RENDERER_URL);
    else await window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
    window.on("closed", () => { window = undefined; });
  }
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "VoidKagami", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }] }, { role: "editMenu" }, { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] }, { role: "windowMenu" }]));
    await createWindow();
  });
  app.on("activate", () => { if (!window) void createWindow(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => client.close());
}
