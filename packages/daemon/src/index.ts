#!/usr/bin/env node
import { createServer, connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Kernel, dataHome } from "@voidkagami/core";
import { PROTOCOL_VERSION, VERSION, type RpcRequest, type RpcResponse, type RpcNotification, type SessionEvent, type LiveEvent } from "@voidkagami/protocol";

const home = dataHome;
const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\voidkagami-${Buffer.from(home).toString("hex")}` : join(home, "daemon.sock");
const metadataPath = join(home, "daemon.json");
await mkdir(home, { recursive: true, mode: 0o700 });

async function existingDaemon(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}
if (await existingDaemon()) process.exit(0);
// SQLite holds process ownership with an OS lock, released automatically after a crash.
const ownership = new DatabaseSync(join(home, "daemon-owner.sqlite"));
try { ownership.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); }
catch (error) {
  ownership.close();
  if (/locked|busy/i.test((error as Error).message)) process.exit(0);
  throw error;
}
await chmod(join(home, "daemon-owner.sqlite"), 0o600);
if (await existingDaemon()) { ownership.close(); process.exit(0); }
if (process.platform !== "win32") await unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });

const token = randomBytes(32).toString("hex");
const clients = new Map<Socket, { authenticated: boolean; subscriptions: Set<string> }>();
const requests = new Set<Promise<void>>();
const kernel = new Kernel(home);
let stopping = false;
let idleSince = Date.now();

function send(socket: Socket, message: RpcResponse | RpcNotification): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}
function notify(method: RpcNotification["method"], params: RpcNotification["params"]): void {
  for (const [socket, client] of clients) {
    if (!client.authenticated) continue;
    if (method === "live" && !client.subscriptions.has((params as LiveEvent).sessionId)) continue;
    send(socket, { jsonrpc: "2.0", method, params });
  }
}
async function handle(socket: Socket, request: RpcRequest): Promise<void> {
  const client = clients.get(socket)!;
  try {
    if (stopping) throw new Error("The daemon is shutting down; reconnect after it exits");
    if (request.jsonrpc !== "2.0" || typeof request.id !== "number" || typeof request.method !== "string") throw Object.assign(new Error("Invalid JSON-RPC request"), { code: -32600 });
    let result: unknown;
    if (request.method === "hello") {
      const params = request.params as { token?: string; protocolVersion?: number; clientVersion?: string };
      const supplied = Buffer.from(params?.token || "");
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw Object.assign(new Error("Invalid daemon token"), { code: -32001 });
      if (params.protocolVersion !== PROTOCOL_VERSION) throw Object.assign(new Error(`Protocol version mismatch; server requires ${PROTOCOL_VERSION}`), { code: -32002 });
      client.authenticated = true;
      result = { protocolVersion: PROTOCOL_VERSION, serverVersion: VERSION, pid: process.pid };
    } else {
      if (!client.authenticated) throw Object.assign(new Error("Handshake required"), { code: -32001 });
      if (request.method === "daemon.stop") {
        if (kernel.activeCount || requests.size > 1) throw new Error("The daemon still has active requests, runs, background tasks, or a login. Stop them first.");
        result = { stopped: true };
        stopping = true;
        setImmediate(() => { void shutdown(true); });
      } else if (request.method === "session.detach") {
        client.subscriptions.delete((request.params as { sessionId: string }).sessionId);
        result = null;
      } else {
        if (request.method === "session.attach") client.subscriptions.add((request.params as { sessionId: string }).sessionId);
        result = await kernel.dispatch(request.method, request.params);
      }
    }
    send(socket, { jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send(socket, { jsonrpc: "2.0", id: request.id, error: { code: (error as { code?: number }).code || -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}
const server = createServer((socket) => {
  clients.set(socket, { authenticated: false, subscriptions: new Set() });
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line) as RpcRequest;
        const pending = Promise.resolve().then(() => handle(socket, request));
        requests.add(pending);
        void pending.finally(() => requests.delete(pending));
      }
      catch { send(socket, { jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Invalid JSON" } }); }
    }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { clients.delete(socket); if (!clients.size) idleSince = Date.now(); });
});

kernel.on("event", (event: SessionEvent) => notify("event", event));
kernel.on("live", (event: LiveEvent) => notify("live", event));
kernel.on("auth", (event: Record<string, unknown>) => notify("auth", event));
kernel.on("runtime.error", (error: unknown) => console.error(error));
await writeFile(metadataPath, JSON.stringify({ pid: process.pid, token, protocolVersion: PROTOCOL_VERSION, serverVersion: VERSION }), { mode: 0o600 });
await chmod(metadataPath, 0o600);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  throw error;
});
if (process.platform !== "win32") await chmod(socketPath, 0o600);
console.log(`VoidKagami ${VERSION} listening on ${socketPath}`);

const idleTimer = setInterval(() => {
  if (clients.size || kernel.activeCount || requests.size) idleSince = Date.now();
  else if (Date.now() - idleSince >= kernel.config.get().idleTimeoutMs) void shutdown();
}, 1000);

async function shutdown(accepted = false): Promise<void> {
  if (stopping && !accepted) return;
  stopping = true;
  clearInterval(idleTimer);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([...requests]);
  await kernel.close();
  for (const socket of clients.keys()) socket.end();
  await closed;
  const owner = await readFile(metadataPath, "utf8").then((data) => JSON.parse(data) as { pid: number }).catch(() => undefined);
  if (owner?.pid === process.pid) await unlink(metadataPath);
  ownership.exec("ROLLBACK");
  ownership.close();
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
