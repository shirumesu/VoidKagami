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
  onConnection: (listener) => {
    let active = true;
    const dispose = listen("connection", listener);
    void ipcRenderer.invoke("connection-state").then((state: string) => { if (active) listener(state); });
    return () => { active = false; dispose(); };
  },
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  chooseAttachments: () => ipcRenderer.invoke("choose-attachments"),
  importAttachments: (files) => ipcRenderer.invoke("import-attachments", files),
  setAppearance: (appearance) => ipcRenderer.invoke("set-appearance", appearance),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
};
contextBridge.exposeInMainWorld("voidkagami", bridge);
