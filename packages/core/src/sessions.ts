import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { realpath, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@voidkagami/agent";
import { createInitialSystemMessage, streamSimple, toToolDeclaration, validateToolArguments, type Message, type UserMessage } from "@voidkagami/ai";
import { isBusy, type Approval, type Attachment, type ContextInfo, type LiveEvent, type ModelSelection, type PermissionMode, type RpcMethods, type Session, type SessionEvent, type SessionView } from "@voidkagami/protocol";
import { ConfigStore } from "./config.ts";
import { EventStore } from "./store.ts";
import { ModelRegistry } from "./models.ts";
import { compactConversation, contextComponents, conversation, estimateTokens, messageText, systemPrompt, userMessage } from "./context.ts";
import { evaluatePermission } from "./permissions.ts";
import { WorkspaceManager } from "./workspace.ts";
import { createBuiltinTools, listBuiltinToolDeclarations, TaskManager, type ToolContext } from "./tools.ts";
import { ExtensionManager, McpManager } from "./extensions.ts";

interface Run {
  controller: AbortController;
  agent?: Agent;
  promise?: Promise<void>;
  tools?: string[];
  instructions?: string;
  prompts: UserMessage[];
  inputs: Map<UserMessage, string>;
  queued: { message: UserMessage; kind: "steer" | "followUp" }[];
  accepting: boolean;
  snapshot?: { id: string; cwd: string };
}
interface PendingApproval {
  approval: Approval;
  resolve: (response: { allow: boolean; answer?: string }) => void;
  reject: (error: Error) => void;
}
interface TransientState {
  streaming: string;
  thinking: string;
  progress: string;
  liveRevision: number;
}

export class SessionManager extends EventEmitter {
  readonly config: ConfigStore;
  readonly store: EventStore;
  readonly models: ModelRegistry;
  readonly workspaces: WorkspaceManager;
  readonly tasks: TaskManager;
  private runs = new Map<string, Run>();
  private approvals = new Map<string, PendingApproval>();
  private extensions = new Map<string, ExtensionManager>();
  private mcps = new Map<string, McpManager>();
  private contexts = new Map<string, ContextInfo>();
  private transient = new Map<string, TransientState>();
  private liveEpoch = randomUUID();
  private operations = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(home?: string) {
    super();
    this.config = new ConfigStore(home);
    this.store = new EventStore(this.config.home, (english, chinese) => this.config.text(english, chinese));
    this.models = new ModelRegistry(this.config, (data) => this.emit("auth", data));
    this.workspaces = new WorkspaceManager(this.config.home, (english, chinese) => this.config.text(english, chinese));
    this.tasks = new TaskManager(this.config.home);
    for (const session of this.store.list()) {
      if (isBusy(session.status)) this.append(session.id, "run.interrupted", { message: this.config.text("The service stopped while this session was active. Continue to resume.", "此会话运行期间服务已停止，发送消息即可继续。") });
    }
  }
  append(id: string, type: string, data: Record<string, unknown>): SessionEvent {
    const event = this.store.append(id, type, data);
    if (["turn.started", "assistant.message", "turn.ended", "run.error", "run.interrupted"].includes(type)) {
      const state = this.transient.get(id);
      if (state) { state.streaming = ""; state.thinking = ""; state.progress = ""; }
    }
    if (type === "tool.call" || type === "tool.result") {
      const state = this.transient.get(id);
      if (state) state.progress = "";
    }
    this.emit("event", event);
    return event;
  }
  live(id: string, type: LiveEvent["type"], data: Record<string, unknown>): void {
    const state = this.transient.get(id) ?? { streaming: "", thinking: "", progress: "", liveRevision: 0 };
    if (type === "assistant.delta") state[data.thinking ? "thinking" : "streaming"] += String(data.delta ?? data.text ?? "");
    if (type === "tool.progress") {
      const result = data.result as { content?: { type: string; text?: string }[] } | undefined;
      state.progress = String(data.text ?? data.output ?? result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? data.tool ?? "Working…");
    }
    state.liveRevision++;
    this.transient.set(id, state);
    this.emit("live", { sessionId: id, type, data, liveRevision: state.liveRevision, liveEpoch: this.liveEpoch } satisfies LiveEvent);
  }
  get activeCount(): number { return this.runs.size + this.operations.size + this.tasks.list().filter((task) => task.status === "running").length + this.models.activeLogins; }
  async extension(cwd: string): Promise<ExtensionManager> {
    let manager = this.extensions.get(cwd);
    if (!manager) {
      manager = new ExtensionManager(this.config.home, cwd);
      await manager.load();
      manager.watch();
      this.extensions.set(cwd, manager);
    }
    return manager;
  }
  async create(params: RpcMethods["session.create"]["params"]): Promise<Session> {
    const parent = params.parentSessionId ? this.store.get(params.parentSessionId) : undefined;
    let cwd = await this.resolveWorkspace(params.cwd ?? parent?.cwd);
    const projectPath = parent ? parent.projectPath === undefined ? parent.cwd : parent.projectPath : params.cwd ? cwd : null;
    const config = this.config.get();
    const model = params.model || config.defaultModel;
    await this.models.prepare(model);
    let worktree: string | undefined;
    if (params.worktree) {
      const info = await this.workspaces.createWorktree(cwd, { name: randomUUID().slice(0, 8), ref: params.branch });
      cwd = info.path;
      worktree = info.path;
    }
    const session = this.store.create({ title: params.title || "New session", cwd, projectPath, model, permissionMode: params.permissionMode || config.permissionMode, parentSessionId: params.parentSessionId, worktree });
    this.emit("event", this.store.events(session.id)[0]);
    return session;
  }
  private async resolveWorkspace(cwd?: string | null): Promise<string> {
    if (!cwd) {
      cwd = join(this.config.get().defaultWorkspace, randomUUID());
      await mkdir(cwd, { recursive: true });
    }
    const path = await realpath(resolve(cwd));
    if (!(await stat(path)).isDirectory()) throw new Error(this.config.text("Working directory must be a directory", "工作路径必须是一个目录"));
    return path;
  }
  async workspace(params: RpcMethods["session.workspace"]["params"]): Promise<Session> {
    return this.operate(params.sessionId, async () => {
      const session = this.assertIdle(params.sessionId);
      if (this.tasks.list(session.id).some((task) => task.status === "running")) throw new Error(this.config.text("Stop this session's background tasks before changing its workspace", "更改工作区前，请先停止此会话的后台任务"));
      let cwd = params.cwd === undefined ? session.cwd : await this.resolveWorkspace(params.cwd);
      const projectPath = params.cwd === undefined ? session.projectPath === undefined ? session.cwd : session.projectPath : params.cwd === null ? null : cwd;
      let worktree = params.cwd === undefined ? session.worktree : undefined;
      if (params.worktree && !worktree) {
        const info = await this.workspaces.createWorktree(cwd, { name: randomUUID().slice(0, 8), ref: params.branch });
        cwd = info.path;
        worktree = info.path;
      } else if (params.worktree === false && worktree) {
        cwd = projectPath ?? await this.resolveWorkspace();
        worktree = undefined;
      }
      await this.mcps.get(session.id)?.close();
      this.mcps.delete(session.id);
      this.contexts.delete(session.id);
      this.append(session.id, "workspace.changed", { cwd, projectPath, worktree });
      return this.store.get(session.id);
    });
  }
  attach(id: string, afterSeq = 0): SessionView {
    return { session: this.store.get(id), events: this.store.events(id, afterSeq), eventSeq: this.store.events(id).at(-1)?.seq ?? 0,
      approvals: [...this.approvals.values()].filter((pending) => pending.approval.sessionId === id).map((pending) => pending.approval),
      context: this.contexts.get(id), liveEpoch: this.liveEpoch, ...(this.transient.get(id) ?? { streaming: "", thinking: "", progress: "", liveRevision: 0 }) };
  }
  private assertIdle(id: string): Session {
    const session = this.store.get(id);
    if (this.runs.has(id)) throw new Error(this.config.text("Stop the current run first", "请先停止当前运行"));
    return session;
  }
  private async operate<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error(this.config.text("The service is stopping", "服务正在停止"));
    const operation = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.closing) throw new Error(this.config.text("The service is stopping", "服务正在停止"));
      return action();
    });
    this.operations.set(id, operation);
    try { return await operation; } finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }
  async send(id: string, text: string, attachments?: Attachment[], options?: { tools?: string[]; instructions?: string }, kind: "steer" | "followUp" = "steer"): Promise<void> {
    await this.operate(id, () => this.submitInput(id, text, attachments, options, kind));
  }
  private async submitInput(id: string, text: string, attachments: Attachment[] | undefined, options: { tools?: string[]; instructions?: string } | undefined, kind: "steer" | "followUp"): Promise<void> {
    const session = this.store.get(id);
    if (!text.trim() && !attachments?.length) throw new Error(this.config.text("Enter a message or attach a file", "请输入消息或添加附件"));
    await this.models.requireAuth(session.model);
    const snapshot = this.runs.has(id) ? undefined : await this.workspaces.snapshot(session.cwd);
    const extension = await this.extension(session.cwd);
    const command = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (command) text = await extension.expandCommand(command[1]!, command[2] || "");
    const hook = await extension.runHooks("UserPromptSubmit", { sessionId: id, cwd: session.cwd, text }, this.config.get().hooks);
    if (typeof hook.text === "string") text = hook.text;
    const promptText = typeof hook.additionalContext === "string" ? `${text}\n\n${hook.additionalContext}` : text;
    const message = await userMessage(promptText, attachments, session.cwd);
    if (session.archived) this.append(id, "session.archived", { archived: false });
    if (this.runs.has(id)) { this.queueMessage(id, text, message, kind, attachments); return; }
    if (session.title === "New session") this.append(id, "session.renamed", { title: text.slice(0, 72).replace(/\s+/g, " ") });
    if (options) this.append(id, "session.configured", { ...options });
    this.append(id, "user.message", { text, attachments, message });
    this.start(id, options, snapshot);
  }
  private pendingInputs(id: string): SessionEvent[] {
    const events = this.store.branch(id);
    const consumed = new Set(events.filter((event) => event.type === "message.persisted").map((event) => event.data.sourceEventId));
    return events.filter((event) => ["user.message", "user.steer", "user.followUp"].includes(event.type) && !consumed.has(event.id));
  }
  private start(id: string, options?: { tools?: string[]; instructions?: string }, snapshot?: Run["snapshot"]): void {
    if (this.closing) throw new Error(this.config.text("The service is stopping", "服务正在停止"));
    const pending = this.pendingInputs(id);
    if (!pending.length) return;
    const configured = options ?? this.store.branch(id).findLast((event) => event.type === "session.configured")?.data as { tools?: string[]; instructions?: string } | undefined;
    const run: Run = { controller: new AbortController(), ...configured, prompts: pending.map((event) => event.data.message as UserMessage),
      inputs: new Map(pending.map((event) => [event.data.message as UserMessage, event.id])), queued: [], accepting: true, snapshot };
    this.runs.set(id, run);
    this.append(id, "turn.started", {});
    run.promise = this.execute(id, run);
    // Storage failures cannot be persisted, but must remain visible to the service owner.
    void run.promise.catch((error: unknown) => this.emit("runtime.error", { sessionId: id, message: error instanceof Error ? error.message : String(error) }));
  }
  async queue(id: string, text: string, kind: "steer" | "followUp", attachments?: Attachment[]): Promise<void> {
    await this.send(id, text, attachments, undefined, kind);
  }
  private queueMessage(id: string, text: string, message: UserMessage, kind: "steer" | "followUp", attachments?: Attachment[]): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(this.config.text("This session has no active run", "此会话当前没有正在运行的任务"));
    const event = this.append(id, `user.${kind}`, { text, message, attachments });
    run.inputs.set(message, event.id);
    if (!run.accepting) return;
    if (!run.agent) run.queued.push({ message, kind });
    else if (kind === "steer") run.agent.steer(message);
    else run.agent.followUp(message);
  }
  abort(id: string): void {
    this.store.get(id);
    const run = this.runs.get(id);
    run?.controller.abort();
    run?.agent?.abort();
    for (const pending of this.approvals.values()) if (pending.approval.sessionId === id) pending.reject(new Error(this.config.text("Run aborted", "运行已停止")));
  }
  private async requestApproval(approval: Approval, signal?: AbortSignal): Promise<{ allow: boolean; answer?: string }> {
    return new Promise((resolve, reject) => {
      const finish = (response?: { allow: boolean; answer?: string }, error?: Error) => {
        if (!this.approvals.delete(approval.id)) return;
        signal?.removeEventListener("abort", abort);
        const waiting = [...this.approvals.values()].some((pending) => pending.approval.sessionId === approval.sessionId);
        this.append(approval.sessionId, "approval.resolved", { approvalId: approval.id, allow: response?.allow ?? false, answer: response?.answer, status: waiting ? "waiting_approval" : "running" });
        this.live(approval.sessionId, "status.changed", { status: waiting ? "waiting_approval" : "running" });
        if (error) reject(error); else resolve(response!);
      };
      const abort = () => finish(undefined, new Error(this.config.text("Run aborted", "运行已停止")));
      this.approvals.set(approval.id, { approval, resolve: (response) => finish(response), reject: (error) => finish(undefined, error) });
      this.append(approval.sessionId, "approval.requested", { approval });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async respond(params: RpcMethods["approval.respond"]["params"]): Promise<void> {
    const pending = this.approvals.get(params.approvalId);
    if (!pending) throw new Error(this.config.text("This approval has already been resolved", "此审批已经处理"));
    if (params.remember && pending.approval.tool !== "ask_user") {
      const rule = { tool: pending.approval.tool, pattern: String(pending.approval.args.command ?? pending.approval.args.path ?? JSON.stringify(pending.approval.args)), action: params.allow ? "allow" as const : "deny" as const };
      if (params.remember === "global") this.config.set({ rules: [...this.config.get().rules, rule] });
      else {
        const path = join(this.store.get(pending.approval.sessionId).cwd, ".voidkagami", "permissions.json");
        const rules = await readFile(path, "utf8").then((data) => JSON.parse(data) as unknown[]).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, JSON.stringify([...rules, rule], null, 2) + "\n");
      }
    }
    pending.resolve(params);
  }
  private async execute(id: string, run: Run): Promise<void> {
    const session = this.store.get(id);
    const started = this.store.events(id).findLast((event) => event.type === "turn.started")!;
    let snapshot: Promise<string> | undefined;
    let checkpoint: Promise<string> | undefined;
    let mcp: McpManager | undefined;
    let extension: ExtensionManager | undefined;
    let failure: unknown;
    const beforeWrite = async () => {
      checkpoint ??= this.workspaces.snapshot(session.cwd).then((value) => {
        this.append(id, "snapshot.created", { snapshotId: value.id, cwd: value.cwd, turnId: started.id });
        return value.id;
      });
      snapshot ??= checkpoint;
      await checkpoint;
    };
    try {
      const before = run.snapshot ?? await this.workspaces.snapshot(session.cwd);
      snapshot = checkpoint = Promise.resolve(before.id);
      this.append(id, "snapshot.created", { snapshotId: before.id, cwd: before.cwd, turnId: started.id, phase: "start" });
      extension = await this.extension(session.cwd);
      const resources = extension;
      const config = this.config.get();
      const authorize = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal, readOnly?: boolean) => {
        const projectRules = await readFile(join(session.cwd, ".voidkagami", "permissions.json"), "utf8").then((data) => JSON.parse(data)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
        const decision = evaluatePermission(session.permissionMode, [...this.config.get().rules, ...projectRules], tool, args, readOnly);
        if (decision === "deny") throw new Error(this.config.text(`Permission denied for ${tool} in ${session.permissionMode} mode`, `当前 ${session.permissionMode} 权限模式不允许执行 ${tool}`));
        if (decision === "ask") {
          const response = await this.requestApproval({ id: randomUUID(), sessionId: id, tool, args }, signal);
          if (!response.allow) throw new Error(this.config.text(`User denied ${tool}`, `用户拒绝执行 ${tool}`));
        }
      };
      const context: ToolContext = {
        cwd: session.cwd, sessionId: id, tasks: this.tasks, sandbox: config.sandbox,
        authorize, beforeWrite,
        emit: (type, data) => { if (type === "tool.progress") this.live(id, type, data); else this.append(id, type, data); },
        instructionsFor: (path) => resources.instructionsFor(path),
        askUser: async (questions, signal) => {
          const answers: string[] = [];
          for (const question of questions) {
            const response = await this.requestApproval({ id: randomUUID(), sessionId: id, tool: "ask_user", args: {}, question: question.question, options: question.options }, signal);
            if (!response.allow) throw new Error(this.config.text("User declined to answer", "用户拒绝回答"));
            answers.push(response.answer || "");
          }
          return answers;
        },
        delegate: async (input, signal) => {
          const definition = input.agent ? resources.catalog.agents.find((agent) => agent.name === input.agent) : undefined;
          if (input.agent && !definition) throw new Error(this.config.text(`Unknown agent: ${input.agent}`, `未知代理：${input.agent}`));
          const selectedModel = input.model ?? (typeof definition?.metadata.model === "string" ? definition.metadata.model : undefined);
          const separator = selectedModel?.indexOf("/") ?? -1;
          if (selectedModel && separator < 1) throw new Error(this.config.text("Delegate model must use provider/model-id", "子代理模型必须使用 provider/model-id 格式"));
          const model = selectedModel ? { provider: selectedModel.slice(0, separator), id: selectedModel.slice(separator + 1) } : session.model;
          signal?.throwIfAborted();
          const configuredMode = definition?.metadata.permissionMode;
          const permissionMode = input.permissionMode ?? (typeof configuredMode === "string" && ["ask", "accept_edits", "auto", "plan"].includes(configuredMode) ? configuredMode as PermissionMode : session.permissionMode);
          const child = await this.create({ cwd: session.cwd, title: input.task.slice(0, 72), parentSessionId: id,
            model, permissionMode, worktree: input.worktree });
          this.append(id, "subagent.spawned", { sessionId: child.id, task: input.task });
          const abort = () => this.abort(child.id);
          signal?.addEventListener("abort", abort, { once: true });
          try {
            const configuredTools = Array.isArray(definition?.metadata.tools) ? definition.metadata.tools.filter((value): value is string => typeof value === "string") : undefined;
            await this.send(child.id, input.task, undefined, { tools: input.tools ?? configuredTools, instructions: definition?.content });
            if (signal?.aborted) this.abort(child.id);
            while (this.runs.has(child.id)) await this.runs.get(child.id)!.promise;
            const result = this.store.branch(child.id).findLast((event) => event.type === "assistant.message")?.data.text || "";
            const status = this.store.get(child.id).status;
            this.append(id, "subagent.completed", { sessionId: child.id, status, result });
            if (status === "failed" || status === "interrupted") throw new Error(`Subagent failed: ${result || this.store.branch(child.id).findLast((event) => event.type === "run.error")?.data.message}`);
            return { sessionId: child.id, status, result };
          } finally { signal?.removeEventListener("abort", abort); }
        },
      };
      const builtinTools = () => createBuiltinTools(context).filter((tool) => session.model.provider === "openai" ? tool.name !== "edit" : tool.name !== "apply_patch");
      let tools = builtinTools();
      mcp = this.mcps.get(id) ?? new McpManager(context);
      mcp.setContext(context);
      this.mcps.set(id, mcp);
      await mcp.configure(config.mcpServers);
      tools.push(...mcp.tools());
      if (run.tools) tools = tools.filter((tool) => run.tools!.includes(tool.name));
      if (run.controller.signal.aborted) throw new Error(this.config.text("Run aborted", "运行已停止"));
      const sessionHook = await resources.runHooks("SessionStart", { sessionId: id, cwd: session.cwd }, config.hooks, run.controller.signal);
      const buildPrompt = async () => [await systemPrompt(session, (await resources.instructionsFor()).map((document) => `Instructions from ${document.path}:\n${document.content}`).join("\n\n"), resources.catalog.skills, resources.catalog.agents), run.instructions, sessionHook.additionalContext].filter(Boolean).join("\n\n");
      const buildContext = async (availableTools: AgentTool[]) => {
        const prompt = await buildPrompt();
        const model = this.models.resolve(session.model);
        let messages = conversation(this.store.branch(id));
        const tokens = contextComponents(prompt, availableTools.map(toToolDeclaration), messages).reduce((sum, component) => sum + component.tokens, 0);
        if (tokens > model.contextWindow * this.config.get().compactThreshold) {
          await resources.runHooks("PreCompact", { sessionId: id }, this.config.get().hooks, run.controller.signal);
          await compactConversation(this.store, this.models, session, model, (type, data) => this.append(id, type, data), run.controller.signal);
          messages = conversation(this.store.branch(id));
        }
        const components = contextComponents(prompt, availableTools.map(toToolDeclaration), messages);
        this.contexts.set(id, { components, estimated: true, tokens: components.reduce((sum, component) => sum + component.tokens, 0), limit: model.contextWindow,
          systemPrompt: prompt, messageCount: messages.length, skills: resources.catalog.skills, cost: this.cost(id) });
        const system = createInitialSystemMessage(prompt, availableTools.map(toToolDeclaration))!;
        return { model, thinkingLevel: session.model.thinkingLevel ?? "off", context: { messages: [system, ...messages], tools: availableTools } };
      };
      const initial = conversation(this.store.branch(id));
      const agent = new Agent({ initialState: { model: this.models.resolve(session.model), thinkingLevel: session.model.thinkingLevel ?? "off", systemPrompt: await buildPrompt(), messages: initial, tools },
        streamFn: streamSimple, getApiKey: (provider) => this.models.apiKey(provider), sessionId: id, toolExecution: "parallel",
        prepareRequest: async () => {
          await resources.load();
          await mcp!.configure(this.config.get().mcpServers);
          context.sandbox = this.config.get().sandbox;
          const currentTools = [...builtinTools(), ...mcp!.tools()].filter((tool) => !run.tools || run.tools.includes(tool.name));
          return buildContext(currentTools);
        },
        beforeToolCall: async ({ toolCall, args, context: callContext }, signal) => {
          const update = await resources.runHooks("PreToolUse", { sessionId: id, tool: toolCall.name, args }, this.config.get().hooks, signal);
          if (update.args !== args && update.args && typeof update.args === "object") {
            const tool = callContext.tools?.find((item) => item.name === toolCall.name)!;
            const next = validateToolArguments(tool, { ...toolCall, arguments: update.args as typeof toolCall.arguments });
            for (const key of Object.keys(args as object)) delete (args as Record<string, unknown>)[key];
            Object.assign(args as object, next);
            this.append(id, "tool.arguments.changed", { toolCallId: toolCall.id, args });
          }
          return undefined;
        },
        afterToolCall: async ({ toolCall, result }, signal) => {
          const update = await resources.runHooks("PostToolUse", { sessionId: id, tool: toolCall.name, result }, this.config.get().hooks, signal);
          return update.result as { content?: typeof result.content } | undefined;
        },
      });
      run.agent = agent;
      const abort = () => agent.abort();
      run.controller.signal.addEventListener("abort", abort, { once: true });
      agent.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") checkpoint = undefined;
        if (event.type === "agent_end") run.accepting = false;
        this.agentEvent(id, event, run);
      });
      for (const queued of run.queued) {
        if (queued.kind === "steer") agent.steer(queued.message); else agent.followUp(queued.message);
      }
      run.queued = [];
      run.controller.signal.throwIfAborted();
      await agent.prompt(run.prompts);
      run.controller.signal.removeEventListener("abort", abort);
      if (agent.state.errorMessage && !run.controller.signal.aborted) throw new Error(agent.state.errorMessage);
    } catch (error) {
      failure = error;
    } finally {
      run.accepting = false;
      const aborted = run.controller.signal.aborted;
      try {
        await extension?.runHooks("Stop", { sessionId: id, status: aborted ? "interrupted" : failure ? "failed" : "completed" }, this.config.get().hooks);
      } catch (error) {
        failure ??= error;
      }
      try {
        if (snapshot) {
          const beforeSnapshotId = await snapshot;
          const after = await this.workspaces.snapshot(session.cwd);
          this.append(id, "snapshot.completed", { snapshotId: after.id, cwd: after.cwd, beforeSnapshotId, turnId: started.id });
        }
      } catch (error) {
        failure ??= error;
      }
      this.runs.delete(id);
      const status = aborted ? "interrupted" : failure ? "failed" : "completed";
      if (aborted || failure) this.append(id, aborted ? "run.interrupted" : "run.error", { message: failure instanceof Error ? failure.message : failure ? String(failure) : this.config.text("Run aborted", "运行已停止") });
      this.append(id, "turn.ended", { status, cost: this.cost(id) });
      this.live(id, "status.changed", { status });
      if (!this.closing && !aborted && !failure && this.pendingInputs(id).length) this.start(id, { tools: run.tools, instructions: run.instructions });
    }
  }
  private agentEvent(id: string, event: AgentEvent, run: Run): void {
    if (event.type === "message_end") {
      const sourceEventId = event.message.role === "user" ? run.inputs.get(event.message) : undefined;
      this.append(id, "message.persisted", { message: event.message, sourceEventId });
      if (event.message.role === "assistant") this.append(id, "assistant.message", { message: event.message, text: messageText(event.message) });
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") this.live(id, "assistant.delta", { delta: update.delta, thinking: update.type === "thinking_delta" });
    } else if (event.type === "tool_execution_start") this.append(id, "tool.call", { toolCallId: event.toolCallId, tool: event.toolName, args: event.args });
    else if (event.type === "tool_execution_update") this.live(id, "tool.progress", { toolCallId: event.toolCallId, tool: event.toolName, result: event.partialResult });
    else if (event.type === "tool_execution_end") this.append(id, "tool.result", { toolCallId: event.toolCallId, tool: event.toolName, result: event.result, isError: event.isError });
  }
  cost(id: string): number {
    return this.store.branch(id).reduce((sum, event) => {
      const usage = event.type === "assistant.message" ? (event.data.message as { usage?: { cost?: { total?: number } } }).usage : event.type === "context.compacted" ? event.data.usage as { cost?: { total?: number } } : undefined;
      return sum + (usage?.cost?.total || 0);
    }, 0);
  }
  async context(id: string): Promise<ContextInfo> {
    const session = this.store.get(id);
    const extension = await this.extension(session.cwd);
    const configured = this.store.branch(id).findLast((event) => event.type === "session.configured")?.data as { tools?: string[]; instructions?: string } | undefined;
    const prompt = [await systemPrompt(session, (await extension.instructionsFor()).map((document) => `Instructions from ${document.path}:\n${document.content}`).join("\n\n"), extension.catalog.skills, extension.catalog.agents), configured?.instructions].filter(Boolean).join("\n\n");
    const messages = conversation(this.store.branch(id));
    const tools = [...listBuiltinToolDeclarations().filter((tool) => session.model.provider === "openai" ? tool.name !== "edit" : tool.name !== "apply_patch"), ...(this.mcps.get(id)?.tools().map(toToolDeclaration) ?? [])]
      .filter((tool) => !configured?.tools || configured.tools.includes(tool.name));
    const components = contextComponents(prompt, tools, messages);
    return { components, estimated: true, tokens: components.reduce((sum, component) => sum + component.tokens, 0), limit: this.models.resolve(session.model).contextWindow,
      systemPrompt: prompt, messageCount: messages.length, skills: extension.catalog.skills, cost: this.cost(id) };
  }
  async compact(id: string): Promise<void> {
    await this.operate(id, async () => {
      const session = this.assertIdle(id);
      await this.models.requireAuth(session.model);
      const extension = await this.extension(session.cwd);
      await extension.runHooks("PreCompact", { sessionId: id }, this.config.get().hooks);
      await compactConversation(this.store, this.models, session, this.models.resolve(session.model), (type, data) => { this.append(id, type, data); });
      this.contexts.delete(id);
    });
  }
  rename(id: string, title: string): Session { this.append(id, "session.renamed", { title }); return this.store.get(id); }
  async archive(id: string, archived: boolean): Promise<Session> {
    return this.operate(id, async () => {
      const session = archived ? this.assertIdle(id) : this.store.get(id);
      if (archived && this.tasks.list(id).some((task) => task.status === "running")) throw new Error(this.config.text("Stop background tasks before archiving this session", "归档此会话前，请先停止后台任务"));
      if (Boolean(session.archived) !== archived) this.append(id, "session.archived", { archived });
      return session;
    });
  }
  async selectModel(id: string, model: ModelSelection): Promise<Session> {
    await this.models.prepare(model);
    this.append(id, "model.changed", { model });
    return this.store.get(id);
  }
  mode(id: string, mode: PermissionMode): Session {
    if (!["ask", "accept_edits", "auto", "plan"].includes(mode)) throw new Error(this.config.text("Unknown permission mode", "未知的权限模式"));
    this.append(id, "mode.changed", { mode });
    return this.store.get(id);
  }
  async diff(id: string, eventId?: string): Promise<string> {
    const events = this.store.events(id);
    const branch = this.store.branch(id);
    const selected = eventId ? events.find((event) => event.id === eventId)
      : branch.findLast((event) => event.type === "turn.ended") ?? branch.findLast((event) => event.type === "assistant.message");
    if (!selected) {
      if (eventId) throw new Error(this.config.text("Unknown event", "事件不存在"));
      return "";
    }
    const origin = selected.data.origin as { sessionId: string; eventId: string } | undefined;
    if (origin) return this.diff(origin.sessionId, origin.eventId);
    const turn = selected.type === "user.message"
      ? events.find((event) => event.seq > selected.seq && event.type === "turn.started" && this.store.branch(id, event.id).some((ancestor) => ancestor.id === selected.id))?.id
      : this.store.branch(id, selected.id).findLast((event) => event.type === "turn.started")?.id;
    const before = events.find((event) => event.type === "snapshot.created" && event.data.turnId === turn);
    if (!before) return "";
    const after = events.findLast((event) => event.type === "snapshot.completed" && event.data.turnId === turn);
    if (!after) throw new Error(this.config.text("This turn has no completed workspace snapshot yet", "此轮尚未生成完整的工作区快照"));
    return this.workspaces.diff(this.snapshotWorkspace(id, before), before.data.snapshotId as string, after.data.snapshotId as string);
  }
  private snapshotWorkspace(id: string, event: SessionEvent): string {
    if (typeof event.data.cwd === "string") return event.data.cwd;
    const branch = this.store.branch(id, event.id);
    const workspace = branch.findLast((entry) => entry.type === "workspace.changed");
    return workspace ? workspace.data.cwd as string : (branch[0]!.data.session as Session).cwd;
  }
  private async snapshotAt(id: string, eventId: string): Promise<{ cwd: string; id: string } | undefined> {
    const session = this.store.get(id);
    const events = this.store.events(id);
    const selected = events.find((event) => event.id === eventId);
    if (!selected) throw new Error(this.config.text("Unknown event", "事件不存在"));
    const origin = selected.data.origin as { sessionId: string; eventId: string } | undefined;
    if (origin) return this.snapshotAt(origin.sessionId, origin.eventId);
    const later = events.find((event) => event.seq > selected.seq && ["snapshot.created", "snapshot.completed"].includes(event.type)
      && this.store.branch(id, event.id).some((ancestor) => ancestor.id === eventId));
    if (later) return { cwd: this.snapshotWorkspace(id, later), id: later.data.snapshotId as string };
    if (eventId === session.headId) {
      const snapshot = await this.workspaces.snapshot(session.cwd);
      return { cwd: session.cwd, id: snapshot.id };
    }
    const branch = this.store.branch(id, eventId);
    const previous = branch.findLast((event) => event.type === "snapshot.completed");
    if (previous) return { cwd: this.snapshotWorkspace(id, previous), id: previous.data.snapshotId as string };
    return branch.find((event) => event.type === "branch.created")?.data.snapshot as { cwd: string; id: string } | undefined;
  }
  async rewind(id: string, eventId: string, restoreFiles = true): Promise<Session> {
    return this.operate(id, () => this.rewindIdle(id, eventId, restoreFiles));
  }
  private async rewindIdle(id: string, eventId: string, restoreFiles: boolean): Promise<Session> {
    const session = this.assertIdle(id);
    if (restoreFiles && this.tasks.list(id).some((task) => task.status === "running")) throw new Error(this.config.text("Stop this session's background tasks before restoring files. Use task.stop or /stop.", "恢复文件前，请先通过 task.stop 或 /stop 停止此会话的后台任务。"));
    const selected = this.store.branch(id).find((event) => event.id === eventId);
    if (!selected) throw new Error(this.config.text("Event is not on the current branch", "此事件不在当前会话分支上"));
    if (!["user.message", "assistant.message", "turn.started", "turn.ended"].includes(selected.type)) throw new Error(this.config.text("Rewind requires a submitted user message or an assistant response checkpoint", "请选择已发送的用户消息或助手回复作为回退位置"));
    if (restoreFiles && eventId !== session.headId) {
      const snapshot = await this.snapshotAt(id, eventId);
      if (snapshot) await this.workspaces.restoreInto(snapshot.cwd, session.cwd, snapshot.id);
    }
    this.append(id, "head.moved", { headId: eventId });
    this.contexts.delete(id);
    return session;
  }
  async fork(id: string, eventId?: string, worktree = false): Promise<Session> {
    return this.operate(id, () => this.forkIdle(id, eventId, worktree));
  }
  private async forkIdle(id: string, eventId: string | undefined, worktree: boolean): Promise<Session> {
    const source = this.assertIdle(id);
    if (worktree && this.tasks.list(id).some((task) => task.status === "running")) throw new Error(this.config.text("Stop this session's background tasks before copying its workspace. Use task.stop or /stop.", "复制工作区前，请先通过 task.stop 或 /stop 停止此会话的后台任务。"));
    const headId = eventId || source.headId!;
    const events = this.store.branch(id, headId);
    const selected = events.at(-1)!;
    if (eventId && !["user.message", "assistant.message", "turn.started", "turn.ended"].includes(selected.type)) throw new Error(this.config.text("Fork requires a submitted user message or an assistant response checkpoint", "请选择已发送的用户消息或助手回复作为分叉位置"));
    const snapshot = await this.snapshotAt(id, headId);
    const child = await this.create({ cwd: source.cwd, title: `${source.title} (fork)`, model: source.model, permissionMode: source.permissionMode, parentSessionId: id, worktree });
    return this.operate(child.id, async () => {
      this.append(child.id, "branch.created", { sourceSessionId: id, sourceEventId: headId, snapshot });
      const copiedIds = new Map<string, string>();
      for (const event of events) {
        if (["session.configured", "user.message", "user.steer", "user.followUp", "assistant.message", "message.persisted", "tool.call", "tool.result", "context.compacted"].includes(event.type)) {
          const data: Record<string, unknown> = { ...event.data, origin: { sessionId: id, eventId: event.id } };
          if (event.type === "message.persisted" && typeof data.sourceEventId === "string") data.sourceEventId = copiedIds.get(data.sourceEventId);
          copiedIds.set(event.id, this.append(child.id, event.type, data).id);
        }
      }
      if (snapshot && worktree) await this.workspaces.restoreInto(snapshot.cwd, child.cwd, snapshot.id);
      return child;
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    this.models.close();
    const runs = [...this.runs.entries()];
    for (const [id] of runs) this.abort(id);
    await Promise.allSettled([...this.operations.values(), ...runs.map(([, run]) => run.promise)]);
    for (const manager of this.extensions.values()) manager.close();
    await Promise.all([...this.mcps.values()].map((manager) => manager.close()));
    this.mcps.clear();
    await this.tasks.close();
    this.store.close();
  }
}
