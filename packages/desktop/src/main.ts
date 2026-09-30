import { app, BrowserWindow, dialog, ipcMain, Notification, shell, Menu, nativeTheme } from "electron";
import { resolve, join, basename } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SocketClient } from "@voidkagami/client";
import type { Method, RpcMethods, RpcNotification, SessionEvent } from "@voidkagami/protocol";
import { normalizeLanguage, translate, type Language } from "@voidkagami/protocol";

let window: BrowserWindow | undefined;
let appearanceBackground: string | undefined;
let language: Language = normalizeLanguage(app.getLocale());
const t = (english: string, chinese: string) => translate(language, english, chinese);
const client = new SocketClient({ daemonPath: process.env.VOIDKAGAMI_DAEMON || (app.isPackaged ? join(process.resourcesPath, "daemon.js") : resolve(app.getAppPath(), "../daemon/src/index.ts")) });
const allowed = new Set<Method>(["daemon.status", "session.create", "session.list", "session.attach", "session.detach", "session.send", "session.steer", "session.followUp", "session.abort", "session.rename", "session.archive", "session.fork", "session.rewind", "session.context", "session.compact", "session.diff", "session.mode", "session.tasks", "task.stop", "approval.respond", "model.list", "model.select", "auth.login", "auth.respond", "auth.cancel", "auth.key", "auth.logout", "auth.status", "config.get", "config.set", "project.branches", "project.files", "commands.list"]);

app.setName("VoidKagami");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  allowed.add("session.workspace");
  ipcMain.handle("rpc", async (_event, method: Method, params: RpcMethods[Method]["params"]) => {
    if (!allowed.has(method)) throw new Error(`Unsupported method: ${method}`);
    const result = await client.request(method, params);
    if ((method === "config.get" || method === "config.set") && result && "language" in result) language = result.language as Language;
    return result;
  });
  ipcMain.handle("choose-folder", async () => { const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"], title: t("Choose workspace", "选择工作目录") }); return result.canceled ? null : result.filePaths[0]; });
  ipcMain.handle("connection-state", () => client.state);
  ipcMain.handle("set-appearance", (_event, appearance: { theme: "system" | "light" | "dark"; background: string }) => {
    nativeTheme.themeSource = appearance.theme;
    appearanceBackground = appearance.background;
    window?.setBackgroundColor(appearance.background);
  });
  nativeTheme.on("updated", () => { if (nativeTheme.themeSource === "system") window?.setBackgroundColor(appearanceBackground || (nativeTheme.shouldUseDarkColors ? "#1A1A1B" : "#FFFFFF")); });
  ipcMain.handle("choose-attachments", async () => { const result = await dialog.showOpenDialog(window!, { properties: ["openFile", "multiSelections"], title: t("Attach files", "添加文件") }); return result.canceled ? [] : result.filePaths; });
  ipcMain.handle("import-attachments", async (_event, files: { name: string; data: ArrayBuffer }[]) => Promise.all(files.map(async (file) => {
    const directory = join(app.getPath("userData"), "attachments", randomUUID());
    await mkdir(directory, { recursive: true });
    const path = join(directory, basename(file.name) || "attachment");
    await writeFile(path, Buffer.from(file.data));
    return path;
  })));
  ipcMain.handle("open-external", async (_event, url: string) => { if (/^https?:\/\//.test(url)) await shell.openExternal(url); });
  client.on("notification", (message: RpcNotification) => {
    window?.webContents.send("notification", message);
    if (message.method !== "event" || window?.isFocused()) return;
    const event = message.params as SessionEvent;
    if (["turn.ended", "approval.requested", "run.error"].includes(event.type) && Notification.isSupported()) {
      const notification = new Notification({ title: event.type === "approval.requested" ? t("VoidKagami needs your input", "VoidKagami 需要你的确认") : event.type === "run.error" ? t("Task failed", "任务失败") : t("Task finished", "任务完成"), body: String(event.data.message || t("Open VoidKagami to continue.", "打开 VoidKagami 继续。")) });
      notification.on("click", () => { window?.show(); window?.focus(); }); notification.show();
    }
  });
  client.on("replay", (view) => window?.webContents.send("replay", view));
  client.on("state", (state) => window?.webContents.send("connection", state));
  client.on("connectionError", (error: Error) => window?.webContents.send("connection", error.message));

  async function createWindow() {
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 620, title: "VoidKagami", titleBarStyle: "hiddenInset", backgroundColor: nativeTheme.shouldUseDarkColors ? "#1A1A1B" : "#FFFFFF", webPreferences: { preload: join(app.getAppPath(), "dist/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
