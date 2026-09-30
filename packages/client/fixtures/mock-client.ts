import type { Approval, Attachment, Config, ContextInfo, LiveEvent, Method, ModelInfo, RpcMethods, RpcNotification, Session, SessionEvent, SessionView, TaskInfo } from "@voidkagami/protocol";
import { demoApprovals, demoCommands, demoConfig, demoContext, demoDiff, demoLiveEvents, demoModels, demoProjects, demoSessions, demoTasks, demoViews } from "./demo.ts";

export interface MockNotification { method: "event" | "live" | "auth"; params: SessionEvent | LiveEvent | Record<string, unknown>; }
type Listener = (...args: any[]) => void;
type PendingApproval = { approval: Approval; resolve: (allow: boolean) => void };
type RunState = { aborted: boolean; pending?: PendingApproval };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockClient {
  state: "connected" = "connected";
  private listeners = new Map<string, Set<Listener>>();
  private subscribers = new Set<(notification: MockNotification) => void>();
  private sessions = new Map<string, Session>();
  private views = new Map<string, SessionView>();
  private approvals = new Map<string, Approval>();
  private runs = new Map<string, RunState>();
  private liveRevision = new Map<string, number>();
  private counter = 1;
  private config: Config = structuredClone(demoConfig);
  private tasks: TaskInfo[] = demoTasks.map((task) => ({ ...task }));
  private models: ModelInfo[] = demoModels.map((model) => ({ ...model, thinkingLevels: [...model.thinkingLevels] }));
  private auth = new Map<string, string>();
  private logins = new Set<string>();

  constructor() {
    for (const source of demoViews) {
      const view: SessionView = { ...source, session: { ...source.session }, events: source.events.map((event) => ({ ...event, data: { ...event.data } })), approvals: [...source.approvals] };
      this.views.set(view.session.id, view);
      this.sessions.set(view.session.id, { ...view.session });
      for (const approval of view.approvals) this.approvals.set(approval.id, approval);
    }
    for (const live of demoLiveEvents) this.liveRevision.set(live.sessionId, live.liveRevision || 0);
  }

  on(event: string | symbol, listener: Listener): this {
    const key = String(event);
    const entries = this.listeners.get(key) || new Set<Listener>();
    entries.add(listener); this.listeners.set(key, entries); return this;
  }
  off(event: string | symbol, listener: Listener): this { this.listeners.get(String(event))?.delete(listener); return this; }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const entries = this.listeners.get(String(event));
    if (!entries?.size) return false;
    for (const listener of entries) listener(...args);
    return true;
  }
  subscribe(listener: (notification: MockNotification) => void): () => void { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }

  private notify(method: MockNotification["method"], params: MockNotification["params"]) {
    const notification = { method, params } satisfies MockNotification;
    for (const listener of this.subscribers) listener(notification);
    this.emit("notification", { jsonrpc: "2.0", ...notification } satisfies RpcNotification);
    this.emit(method, params);
  }
  private nextId(prefix: string) { return `${prefix}-${String(this.counter++).padStart(4, "0")}`; }
  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
  private view(sessionId: string): SessionView {
    const view = this.views.get(sessionId);
    if (!view) throw new Error(`Session not found: ${sessionId}`);
    return view;
  }
  private append(sessionId: string, type: string, data: Record<string, unknown>): SessionEvent {
    const view = this.view(sessionId);
    const session = this.session(sessionId);
    const previous = view.events.at(-1);
    const timestamp = new Date().toISOString();
    const event: SessionEvent = { id: this.nextId("event"), sessionId, parentId: session.headId, seq: (previous?.seq || 0) + 1, timestamp, type, data };
    view.events.push(event); view.eventSeq = event.seq;
    if (["turn.started", "assistant.message", "turn.ended", "run.error", "run.interrupted"].includes(type)) { view.streaming = ""; view.thinking = ""; view.progress = ""; }
    if (type === "tool.call" || type === "tool.result") view.progress = "";
    session.headId = event.id; session.updatedAt = timestamp;
    if (type === "session.renamed") session.title = String(data.title);
    if (type === "session.archived") session.archived = Boolean(data.archived);
    if (type === "turn.started") session.status = "running";
    if (type === "turn.ended") session.status = (data.status as Session["status"]) || "completed";
    if (type === "run.error") session.status = "failed";
    if (type === "run.interrupted") session.status = "interrupted";
    if (type === "approval.requested") {
      const approval = (data.approval || data) as unknown as Approval;
      view.approvals = [...view.approvals.filter((item) => item.id !== approval.id), approval];
      session.status = "waiting_approval";
    }
    if (type === "approval.resolved") {
      view.approvals = view.approvals.filter((approval) => approval.id !== (data.approvalId || data.id));
      session.status = (data.status as Session["status"]) || "running";
    }
    if (type === "model.changed") session.model = data.model as Session["model"];
    if (type === "mode.changed") session.permissionMode = data.mode as Session["permissionMode"];
    view.session = { ...session };
    this.notify("event", event);
    return event;
  }
  private live(sessionId: string, type: LiveEvent["type"], data: Record<string, unknown>) {
    const liveRevision = (this.liveRevision.get(sessionId) || 0) + 1;
    this.liveRevision.set(sessionId, liveRevision);
    const event: LiveEvent = { sessionId, type, data, liveRevision, liveEpoch: "demo-epoch" };
    const view = this.views.get(sessionId);
    if (view) { view.liveRevision = liveRevision; if (type === "assistant.delta") { if (data.thinking) view.thinking = `${view.thinking || ""}${String(data.delta || "")}`; else view.streaming = `${view.streaming || ""}${String(data.delta || "")}`; } if (type === "tool.progress") view.progress = String(data.text || ""); }
    this.notify("live", event);
  }
  private context(sessionId: string): ContextInfo { return { ...demoContext, cost: this.view(sessionId).context?.cost || demoContext.cost }; }
  private addSession(params: RpcMethods["session.create"]["params"]): Session {
    const cwd = params.cwd || this.config.defaultWorkspace;
    const id = this.nextId("session");
    const timestamp = new Date().toISOString();
    const session: Session = { id, title: params.title || "New session", cwd, projectPath: cwd, createdAt: timestamp, updatedAt: timestamp, status: "idle", model: params.model || this.config.defaultModel, permissionMode: params.permissionMode || this.config.permissionMode, headId: null, ...(params.worktree ? { worktree: `${cwd}/.worktrees/demo` } : {}), ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}) };
    const view: SessionView = { session: { ...session }, events: [], eventSeq: 0, approvals: [], context: this.context(demoSessions[0]!.id), liveEpoch: "demo-epoch", liveRevision: 0 };
    this.sessions.set(id, session); this.views.set(id, view);
    this.append(id, "session.created", { session: { ...session } });
    return { ...session };
  }
  private async wait(run: RunState, ms = 180): Promise<boolean> { await pause(ms); return !run.aborted; }
  private async runScript(sessionId: string, text: string, attachments: Attachment[] = []) {
    const run: RunState = { aborted: false };
    this.runs.set(sessionId, run);
    const session = this.session(sessionId);
    if (session.title === "New session") this.append(sessionId, "session.renamed", { title: text.slice(0, 72).replace(/\s+/g, " ") });
    const userMessage = { role: "user", content: [{ type: "text", text }] };
    const submitted = this.append(sessionId, "user.message", { text, attachments, message: userMessage });
    this.append(sessionId, "turn.started", {});
    this.append(sessionId, "message.persisted", { message: userMessage, sourceEventId: submitted.id });
    const end = async (status: "completed" | "failed" | "interrupted", message?: string) => {
      if (status === "interrupted") this.append(sessionId, "run.interrupted", { message: "Run aborted" });
      else if (status === "failed") this.append(sessionId, "run.error", { message: message || "Scripted run failed" });
      this.append(sessionId, "turn.ended", { status, cost: 0.0037 });
      this.live(sessionId, "status.changed", { status });
      this.runs.delete(sessionId);
    };
    const toolCall = (tool: string, args: Record<string, unknown>) => {
      const toolCallId = this.nextId("call");
      this.append(sessionId, "tool.call", { toolCallId, tool, args });
      return toolCallId;
    };
    const toolResult = (toolCallId: string, tool: string, output: string, isError = false) => this.append(sessionId, "tool.result", { toolCallId, tool, result: { content: [{ type: "text", text: output }], details: {} }, isError });
    try {
      if (!await this.wait(run)) return await end("interrupted");
      this.live(sessionId, "assistant.delta", { delta: "I’ll check the current files and make the smallest safe change. ", thinking: true });
      if (!await this.wait(run)) return await end("interrupted");
      const bashId = toolCall("bash", { command: "pnpm check" });
      this.live(sessionId, "tool.progress", { toolCallId: bashId, tool: "bash", text: "Checking TypeScript types…" });
      if (!await this.wait(run)) return await end("interrupted");
      toolResult(bashId, "bash", "TypeScript check passed");
      if (!await this.wait(run)) return await end("interrupted");
      const editId = toolCall("edit", { path: "packages/client/src/presentation.ts", old_text: "Ready", new_text: "Ready to work" });
      if (!await this.wait(run)) return await end("interrupted");
      toolResult(editId, "edit", "Updated packages/client/src/presentation.ts (1 replacement)");
      if (!await this.wait(run)) return await end("interrupted");
      const riskyCommand = "pnpm release:publish --dry-run=false";
      const riskyId = toolCall("bash", { command: riskyCommand });
      const approval: Approval = { id: this.nextId("approval"), sessionId, tool: "bash", args: { command: riskyCommand } };
      this.approvals.set(approval.id, approval);
      const approvalResponse = new Promise<boolean>((resolve) => { run.pending = { approval, resolve }; });
      this.append(sessionId, "approval.requested", { approval });
      const allowed = await approvalResponse;
      run.pending = undefined;
      this.approvals.delete(approval.id);
      this.append(sessionId, "approval.resolved", { approvalId: approval.id, allow: allowed, status: "running" });
      if (run.aborted) return await end("interrupted");
      toolResult(riskyId, "bash", allowed ? "Release command completed" : "User denied bash\n[exit 1]", !allowed);
      const response = allowed ? "The requested changes are ready. I checked the code and left the release command gated behind approval." : "I left the release command untouched because it was denied. The other changes are ready for review.";
      for (const delta of [response.slice(0, 38), response.slice(38, 82), response.slice(82)]) {
        if (!delta) continue;
        if (!await this.wait(run, 120)) return await end("interrupted");
        this.live(sessionId, "assistant.delta", { delta });
      }
      const message = { role: "assistant", content: [{ type: "thinking", thinking: "The privileged command was explicitly approved or declined." }, { type: "text", text: response }], usage: { cost: { total: 0.0037 } } };
      this.append(sessionId, "message.persisted", { message });
      this.append(sessionId, "assistant.message", { message, text: response });
      this.append(sessionId, "todo.updated", { items: [{ content: "Inspect the existing implementation", status: "completed" }, { content: "Apply the focused change", status: "completed" }, { content: "Run the relevant checks", status: "completed" }] });
      await end("completed");
    } catch (error) {
      if (run.aborted) await end("interrupted");
      else await end("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async request<K extends Method>(method: K, params: RpcMethods[K]["params"]): Promise<RpcMethods[K]["result"]> {
    const input = params as Record<string, any>;
    let result: unknown;
    switch (method) {
      case "hello": result = { protocolVersion: 1, serverVersion: "0.1.2", pid: 1 }; break;
      case "daemon.status": result = { pid: 1, running: this.runs.size, sessions: this.sessions.size, uptime: 600 }; break;
      case "daemon.stop": result = { stopped: true }; break;
      case "session.create": result = this.addSession(input as RpcMethods["session.create"]["params"]); break;
      case "session.list": {
        const query = String(input.query || "").toLowerCase();
        result = [...this.sessions.values()].filter((session) => input.archived === undefined || Boolean(session.archived) === input.archived).filter((session) => !query || `${session.title} ${session.cwd} ${session.id}`.toLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => ({ ...session }));
        break;
      }
      case "session.attach": {
        const view = this.view(input.sessionId);
        const afterSeq = Number(input.afterSeq || 0);
        result = { ...view, session: { ...view.session }, events: view.events.filter((event) => event.seq > afterSeq).map((event) => ({ ...event, data: { ...event.data } })), approvals: [...view.approvals] };
        break;
      }
      case "session.detach": result = null; break;
      case "session.send": void this.runScript(input.sessionId, String(input.text || ""), input.attachments); result = { accepted: true }; break;
      case "session.steer":
      case "session.followUp": this.append(input.sessionId, method === "session.steer" ? "user.steer" : "user.followUp", { text: String(input.text || ""), attachments: input.attachments, message: { role: "user", content: [{ type: "text", text: String(input.text || "") }] } }); result = { accepted: true }; break;
      case "session.abort": {
        const run = this.runs.get(input.sessionId);
        if (run) { run.aborted = true; run.pending?.resolve(false); }
        result = null; break;
      }
      case "session.rename": this.append(input.sessionId, "session.renamed", { title: input.title }); result = { ...this.session(input.sessionId) }; break;
      case "session.archive": this.append(input.sessionId, "session.archived", { archived: input.archived }); result = { ...this.session(input.sessionId) }; break;
      case "session.workspace": {
        const session = this.session(input.sessionId);
        const cwd = input.cwd === undefined ? session.cwd : input.cwd === null ? this.config.defaultWorkspace : String(input.cwd);
        const projectPath = input.cwd === null ? null : input.cwd === undefined ? session.projectPath ?? session.cwd : cwd;
        this.append(input.sessionId, "workspace.changed", { cwd, projectPath, worktree: input.worktree ? `${cwd}/.worktrees/demo` : undefined });
        session.cwd = cwd; session.projectPath = projectPath; session.worktree = input.worktree ? `${cwd}/.worktrees/demo` : undefined;
        this.view(input.sessionId).session = { ...session };
        result = { ...session }; break;
      }
      case "session.fork": {
        const source = this.session(input.sessionId);
        const fork = this.addSession({ cwd: source.cwd, title: `${source.title} (fork)`, model: source.model, permissionMode: source.permissionMode, worktree: input.worktree, parentSessionId: source.id });
        result = fork; break;
      }
      case "session.rewind": {
        const session = this.session(input.sessionId);
        this.append(input.sessionId, "head.moved", { headId: input.eventId });
        session.status = "idle"; session.headId = input.eventId;
        this.view(input.sessionId).session = { ...session };
        result = { ...session }; break;
      }
      case "session.context": result = this.context(input.sessionId); break;
      case "session.compact": this.append(input.sessionId, "context.compacted", { message: "Context compacted" }); result = null; break;
      case "session.diff": {
        const events = this.view(input.sessionId).events;
        const hasChanges = events.some((event) => event.type === "tool.call" && ["write", "edit", "apply_patch"].includes(String(event.data.tool)));
        result = { diff: hasChanges ? demoDiff : "", currentBranch: "design/cli-refresh", baseBranch: "main" }; break;
      }
      case "session.mode": this.append(input.sessionId, "mode.changed", { mode: input.mode }); result = { ...this.session(input.sessionId) }; break;
      case "session.tasks": result = this.tasks.filter((task) => task.sessionId === input.sessionId).map((task) => ({ ...task })); break;
      case "task.stop": this.tasks = this.tasks.map((task) => task.id === input.taskId ? { ...task, status: "failed" } : task); result = null; break;
      case "approval.respond": {
        const approval = this.approvals.get(input.approvalId);
        if (approval) this.runs.get(approval.sessionId)?.pending?.resolve(Boolean(input.allow));
        result = null; break;
      }
      case "model.list": result = this.models.map((model) => ({ ...model, thinkingLevels: [...model.thinkingLevels] })); break;
      case "model.select": {
        this.append(input.sessionId, "model.changed", { model: input.model });
        result = { ...this.session(input.sessionId) }; break;
      }
      case "auth.login": {
        const loginId = this.nextId("login"); this.logins.add(loginId);
        queueMicrotask(() => this.notify("auth", { loginId, type: "url", url: "https://example.test/device", instructions: "Demo sign-in flow" }));
        result = { loginId }; break;
      }
      case "auth.respond": this.logins.delete(input.loginId); this.auth.set("openai", "oauth"); this.models = this.models.map((model) => model.provider === "openai" ? { ...model, authenticated: true } : model); this.notify("auth", { loginId: input.loginId, type: "complete", message: "Signed in" }); result = null; break;
      case "auth.cancel": this.logins.delete(input.loginId); this.notify("auth", { loginId: input.loginId, type: "cancelled" }); result = null; break;
      case "auth.key": this.auth.set(input.provider, "api_key"); this.models = this.models.map((model) => model.provider === input.provider ? { ...model, authenticated: true } : model); result = null; break;
      case "auth.logout": this.auth.delete(input.provider); this.models = this.models.map((model) => model.provider === input.provider ? { ...model, authenticated: false } : model); result = null; break;
      case "auth.status": result = [...this.auth].map(([provider, type]) => ({ provider, type })); break;
      case "config.get": result = structuredClone(this.config); break;
      case "config.set": this.config = { ...this.config, ...(params as Partial<Config>) }; result = structuredClone(this.config); break;
      case "project.branches": result = demoProjects.find((project) => project.path === input.cwd)?.branches || ["main"]; break;
      case "project.files": {
        const files = demoProjects.find((project) => project.path === input.cwd)?.files || [];
        const query = String(input.query || "").toLowerCase(); result = files.filter((path) => path.toLowerCase().includes(query)); break;
      }
      case "commands.list": result = demoCommands.map((command) => ({ ...command })); break;
      default: throw new Error(`Unsupported mock method: ${String(method)}`);
    }
    return result as RpcMethods[K]["result"];
  }
}
