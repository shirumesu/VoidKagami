import type { Method, RpcMethods, RpcNotification, SessionView } from "@voidkagami/protocol";

export interface DesktopBridge {
  request<K extends Method>(method: K, params: RpcMethods[K]["params"]): Promise<RpcMethods[K]["result"]>;
  onNotification(listener: (message: RpcNotification) => void): () => void;
  onReplay(listener: (view: SessionView) => void): () => void;
  onConnection(listener: (state: string) => void): () => void;
  chooseFolder(): Promise<string | null>;
  chooseAttachments(): Promise<string[]>;
  importAttachments(files: { name: string; data: ArrayBuffer }[]): Promise<string[]>;
  setAppearance(appearance: { theme: "system" | "light" | "dark"; background: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
}

declare global { interface Window { voidkagami: DesktopBridge; } }
