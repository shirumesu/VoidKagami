import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "node:fs/promises";
import { isBusy, type Config, type Method, type RpcMethods } from "@voidkagami/protocol";
import { SessionManager } from "./sessions.ts";

const exec = promisify(execFile);
type Handlers = { [K in Exclude<Method, "hello" | "session.detach" | "daemon.stop">]: (params: RpcMethods[K]["params"]) => RpcMethods[K]["result"] | Promise<RpcMethods[K]["result"]> };

export class Kernel extends SessionManager {
  readonly handlers: Handlers = {
    "daemon.status": () => ({ pid: process.pid, running: this.activeCount, sessions: this.store.list().length, uptime: process.uptime() }),
    "session.create": (params) => this.create(params),
    "session.list": (params) => this.store.list(params.query),
    "session.attach": (params) => this.attach(params.sessionId, params.afterSeq),
    "session.send": async (params) => { await this.send(params.sessionId, params.text, params.attachments); return { accepted: true }; },
    "session.steer": async (params) => {
      await this.queue(params.sessionId, params.text, "steer", params.attachments);
      return { accepted: true };
    },
    "session.followUp": async (params) => {
      await this.queue(params.sessionId, params.text, "followUp", params.attachments);
      return { accepted: true };
    },
    "session.abort": (params) => { this.abort(params.sessionId); return null; },
    "session.rename": (params) => this.rename(params.sessionId, params.title),
    "session.fork": (params) => this.fork(params.sessionId, params.eventId, params.worktree ?? true),
    "session.rewind": (params) => this.rewind(params.sessionId, params.eventId, params.restoreFiles ?? true),
    "session.context": (params) => this.context(params.sessionId),
    "session.compact": async (params) => { await this.compact(params.sessionId); return null; },
    "session.diff": async (params) => ({ diff: await this.diff(params.sessionId, params.eventId) }),
    "session.mode": (params) => this.mode(params.sessionId, params.mode),
    "session.tasks": (params) => { this.store.get(params.sessionId); return this.tasks.list(params.sessionId); },
    "task.stop": (params) => {
      if (this.tasks.get(params.taskId).sessionId !== params.sessionId) throw new Error("Task belongs to another session");
      this.tasks.stop(params.taskId); return null;
    },
    "approval.respond": async (params) => { await this.respond(params); return null; },
    "model.list": () => this.models.list(),
    "model.select": (params) => this.selectModel(params.sessionId, params.model),
    "auth.login": (params) => ({ loginId: this.models.login(params.provider) }),
    "auth.respond": (params) => { this.models.respond(params.loginId, params.value); return null; },
    "auth.key": (params) => {
      if (!params.provider || !params.apiKey.trim()) throw new Error("Provider and API key are required");
      this.models.credentials.set(params.provider, { type: "api_key", apiKey: params.apiKey.trim() }); return null;
    },
    "auth.logout": (params) => { this.models.credentials.set(params.provider); return null; },
    "auth.status": () => this.models.status(),
    "config.get": () => this.config.get(),
    "config.set": (params: Partial<Config>) => this.config.set(params),
    "project.branches": async (params) => {
      const { stdout } = await exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: params.cwd });
      return stdout.trim().split("\n").filter(Boolean);
    },
    "project.files": async (params) => {
      const files: string[] = [];
      for await (const file of glob("**/*", { cwd: params.cwd, exclude: ["**/node_modules/**", "**/.git/**"] })) {
        if (!params.query || file.toLowerCase().includes(params.query.toLowerCase())) files.push(file);
        if (files.length === 1000) break;
      }
      return files;
    },
    "commands.list": async (params) => (await this.extension(params.cwd)).catalog.commands.map(({ name, description }) => ({ name, description })),
  };
  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.handlers, method)) throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) throw Object.assign(new Error("Parameters must be an object"), { code: -32602 });
    const handler = this.handlers[method as keyof Handlers] as (params: object) => unknown;
    return handler(params as object || {});
  }
}
