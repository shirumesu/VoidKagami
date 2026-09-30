import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge.ts";

function listen<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const bridge: DesktopBridge = {
  request: (method, params) => ipcRenderer.invoke("rpc", method, params),
  onNotification: (listener) => listen("notification", listener),
  onReplay: (listener) => listen("replay", listener),
  onConnection: (listener) => listen("connection", listener),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  chooseAttachments: () => ipcRenderer.invoke("choose-attachments"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
};
contextBridge.exposeInMainWorld("voidkagami", bridge);
