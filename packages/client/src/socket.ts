import { EventEmitter } from "node:events";
import { connect as connectSocket, type Socket } from "node:net";
import { mkdir, readFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION, VERSION } from "@voidkagami/protocol";
import type { Method, RpcMethods, RpcResponse, RpcNotification, SessionEvent, SessionView } from "@voidkagami/protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
export type ClientNotification = RpcNotification;
export interface ClientOptions { home?: string; autoStart?: boolean; reconnect?: boolean; daemonPath?: string; nodePath?: string; }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; }

export function runtimePaths(home = process.env.VOIDKAGAMI_HOME || join(homedir(), ".voidkagami")) {
  return { home, socket: process.platform === "win32" ? `\\\\.\\pipe\\voidkagami-${Buffer.from(home).toString("hex")}` : join(home, "daemon.sock"), metadata: join(home, "daemon.json"), log: join(home, "daemon.log") };
}

export class RpcError extends Error {
  code: number;
  constructor(message: string, code: number) { super(message); this.name = "RpcError"; this.code = code; }
}

export class SocketClient extends EventEmitter {
  state: ConnectionState = "disconnected";
  options: ClientOptions;
  serverVersion?: string;
  private socket?: Socket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<string, number>();
  private connecting?: Promise<void>;
  private closed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private recoveryNotifications?: RpcNotification[];

  constructor(options: ClientOptions = {}) { super(); this.options = options; }

  connect(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = this.establish().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private setState(state: ConnectionState) { this.state = state; this.emit("state", state); }

  private async establish() {
    const recoveryCursors = new Map(this.subscriptions);
    this.recoveryNotifications = [];
    this.setState(this.subscriptions.size ? "reconnecting" : "connecting");
    try {
      try { await this.connectAndHandshake(); }
      catch (error) {
        this.discardSocket();
        if (this.options.autoStart === false || error instanceof RpcError) throw error;
        await this.startDaemon();
        let connected = false;
        let failure = error;
        for (let attempt = 0; attempt < 80 && !this.closed; attempt++) {
          await delay(100);
          try { await this.connectAndHandshake(); connected = true; break; } catch (err) { this.discardSocket(); if (err instanceof RpcError) throw err; failure = err; }
        }
        if (!connected) throw new Error(`Cannot start VoidKagami daemon: ${failure instanceof Error ? failure.message : failure}. See ${runtimePaths(this.options.home).log}`);
      }
      for (const [sessionId, afterSeq] of recoveryCursors) {
        const view = await this.send("session.attach", { sessionId, afterSeq });
        this.trackView(view);
        this.emit("replay", view);
      }
      const buffered = this.recoveryNotifications;
      this.recoveryNotifications = undefined;
      const replayBoundary = new Map<string, number>();
      buffered.forEach((message, index) => {
        if (message.method === "event") { const event = message.params as SessionEvent; if (event.seq <= (this.subscriptions.get(event.sessionId) || 0)) replayBoundary.set(event.sessionId, index); }
      });
      buffered.forEach((message, index) => {
        if (message.method === "live" && index <= (replayBoundary.get(String(message.params.sessionId)) ?? -1)) return;
        this.notify(message);
      });
      this.setState("connected");
    } catch (error) {
      this.recoveryNotifications = undefined;
      this.socket?.destroy();
      this.setState("disconnected");
      throw error;
    }
  }

  private discardSocket() { const socket = this.socket; this.socket = undefined; socket?.destroy(); }

  private async connectAndHandshake() {
    await this.openSocket();
    const { token } = JSON.parse(await readFile(runtimePaths(this.options.home).metadata, "utf8")) as { token: string };
    let needsUpgrade = false;
    try {
      const hello = await this.send("hello", { token, protocolVersion: PROTOCOL_VERSION, clientVersion: VERSION });
      this.serverVersion = hello.serverVersion;
      const clientParts = VERSION.split(".").map(Number);
      const serverParts = hello.serverVersion.split(".").map(Number);
      const differing = clientParts.findIndex((part, index) => part !== serverParts[index]);
      needsUpgrade = hello.protocolVersion !== PROTOCOL_VERSION || (differing >= 0 && clientParts[differing]! > serverParts[differing]!);
    } catch (error) { if (error instanceof RpcError && error.code === -32002) needsUpgrade = true; else throw error; }
    if (!needsUpgrade) return;
    const status = await this.send("daemon.status", {});
    if (status.running > 0) throw new RpcError(`Daemon ${this.serverVersion || "protocol"} is older than this client and has ${status.running} running task(s). Reconnect after they finish.`, -32002);
    await this.send("daemon.stop", {});
    this.discardSocket();
    await delay(150);
    throw new Error("Restarting the idle daemon for this client version");
  }

  private async openSocket(): Promise<void> {
    const socket = connectSocket(runtimePaths(this.options.home).socket);
    await new Promise<void>((resolveConnection, reject) => {
      const onError = (error: Error) => { socket.destroy(); reject(error); };
      socket.once("error", onError);
      socket.once("connect", () => { socket.removeListener("error", onError); resolveConnection(); });
    });
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim()) this.receive(line);
      }
    });
    socket.on("error", (error) => this.emit("connectionError", error));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const pending of this.pending.values()) pending.reject(new Error("Daemon connection closed"));
      this.pending.clear();
      this.setState("disconnected");
      if (!this.closed && this.options.reconnect !== false) this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) void this.connect().catch((error) => { this.emit("connectionError", error); this.scheduleReconnect(); });
    }, 800);
  }

  private receive(line: string) {
    let message: RpcResponse | RpcNotification;
    try { message = JSON.parse(line) as RpcResponse | RpcNotification; }
    catch { this.emit("connectionError", new Error("Daemon sent invalid JSON")); return; }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.message, message.error.code));
      else pending.resolve(message.result);
      return;
    }
    if (this.recoveryNotifications) { this.recoveryNotifications.push(message); return; }
    this.notify(message);
  }

  private notify(message: RpcNotification) {
    if (message.method === "event") {
      const event = message.params as SessionEvent;
      const seq = this.subscriptions.get(event.sessionId);
      if (seq !== undefined && event.seq <= seq) return;
      if (seq !== undefined) this.subscriptions.set(event.sessionId, event.seq);
    }
    this.emit("notification", message);
    this.emit(message.method, message.params);
  }

  private async startDaemon() {
    const paths = runtimePaths(this.options.home);
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    let daemon = this.options.daemonPath || process.env.VOIDKAGAMI_DAEMON;
    if (!daemon) {
      const here = dirname(fileURLToPath(import.meta.url));
      const source = resolve(here, "../../daemon/src/index.ts");
      daemon = existsSync(source) ? source : join(here, "daemon.js");
    }
    const log = await open(paths.log, "a", 0o600);
    try {
      const child = spawn(this.options.nodePath || process.execPath, [daemon], { detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, VOIDKAGAMI_HOME: paths.home, ELECTRON_RUN_AS_NODE: "1" } });
      await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
      child.unref();
    } finally { await log.close(); }
  }

  private send<K extends Method>(method: K, params: RpcMethods[K]["params"]): Promise<RpcMethods[K]["result"]> {
    return new Promise((resolveRequest, reject) => {
      if (!this.socket || this.socket.destroyed) { reject(new Error("Daemon is disconnected")); return; }
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolveRequest as (value: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }

  async request<K extends Method>(method: K, params: RpcMethods[K]["params"]): Promise<RpcMethods[K]["result"]> {
    await this.connect();
    if (method === "session.attach") { const id = (params as { sessionId: string }).sessionId; if (!this.subscriptions.has(id)) this.subscriptions.set(id, 0); }
    const result = await this.send(method, params);
    if (method === "session.attach") this.trackView(result as SessionView);
    if (method === "session.detach") this.subscriptions.delete((params as { sessionId: string }).sessionId);
    return result;
  }

  private trackView(view: SessionView) { this.subscriptions.set(view.session.id, Math.max(this.subscriptions.get(view.session.id) || 0, ...view.events.map((event) => event.seq))); }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.setState("disconnected");
  }
}
