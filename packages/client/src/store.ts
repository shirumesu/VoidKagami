import type { Approval, Attachment, ContextInfo, LiveEvent, Session, SessionEvent, SessionView } from "@voidkagami/protocol";

export interface TranscriptItem {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  event: SessionEvent;
  thinking?: string;
  tool?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolStatus?: "running" | "completed" | "error" | "interrupted";
  inputKind?: "steer" | "followUp";
  delivery?: "queued" | "consumed";
  attachments?: Attachment[];
  error?: boolean;
  kind?: "turn" | "plan" | "notice";
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  turnId?: string;
  durationMs?: number;
  turnStatus?: "completed" | "failed" | "interrupted";
  hasTools?: boolean;
}
export interface SessionState {
  session: Session;
  events: SessionEvent[];
  transcript: TranscriptItem[];
  transcriptRevision: number;
  approvals: Approval[];
  context?: ContextInfo;
  streaming: string;
  thinking: string;
  progress: string;
  liveRevision: number;
  liveEpoch?: string;
  cost: number;
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  planItemId?: string;
  turnStartedAt?: string;
}

export function eventText(data: Record<string, unknown>): string {
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) return data.content.map((part: { text?: string; type?: string }) => part.text || (part.type === "image" ? "[Image]" : "")).filter(Boolean).join("\n");
  if (data.message && typeof data.message === "object") return eventText(data.message as Record<string, unknown>);
  if (data.result && typeof data.result === "object") return eventText(data.result as Record<string, unknown>);
  if (typeof data.summary === "string") return data.summary;
  if (typeof data.message === "string") return data.message;
  if (typeof data.output === "string") return data.output;
  if (typeof data.error === "string") return data.error;
  return "";
}

function eventThinking(data: Record<string, unknown>): string {
  if (Array.isArray(data.content)) return data.content.filter((part: { type?: string }) => part.type === "thinking").map((part: { thinking?: string }) => part.thinking || "").filter(Boolean).join("\n\n");
  if (data.message && typeof data.message === "object") return eventThinking(data.message as Record<string, unknown>);
  return typeof data.thinking === "string" ? data.thinking : "";
}

export function activeEvents(events: SessionEvent[], headId: string | null): SessionEvent[] {
  if (!headId) return events;
  const byId = new Map(events.map((event) => [event.id, event]));
  const path: SessionEvent[] = [];
  let current = byId.get(headId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    path.push(current); visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export class SessionStore {
  private states = new Map<string, SessionState>();
  private pending = new Map<string, (SessionEvent | LiveEvent)[]>();
  private responseDeltas = new Map<string, LiveEvent[]>();
  private progressUpdates = new Map<string, LiveEvent>();
  private listeners = new Set<() => void>();
  version = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (id: string) => this.states.get(id);
  list = () => [...this.states.values()];
  private changed() { this.version++; for (const listener of this.listeners) listener(); }

  attach(view: SessionView) {
    const existing = this.states.get(view.session.id);
    const events = new Map((existing?.events || []).map((event) => [event.id, event]));
    for (const event of view.events) events.set(event.id, event);
    const snapshotRevision = view.liveRevision ?? 0;
    const sameEpoch = existing?.liveEpoch === view.liveEpoch;
    const latestSnapshotSeq = view.eventSeq ?? view.events.at(-1)?.seq ?? 0;
    const newerEvents = sameEpoch ? existing?.events.filter((event) => event.seq > latestSnapshotSeq) ?? [] : [];
    const responseCleared = newerEvents.some((event) => ["turn.started", "assistant.message", "turn.ended", "run.error", "run.interrupted"].includes(event.type));
    const progressCleared = responseCleared || newerEvents.some((event) => event.type === "tool.call" || event.type === "tool.result");
    let streaming = view.streaming ?? "";
    let thinking = view.thinking ?? "";
    let progress = view.progress ?? "";
    if (!sameEpoch) { this.responseDeltas.delete(view.session.id); this.progressUpdates.delete(view.session.id); }
    if (responseCleared) { streaming = existing!.streaming; thinking = existing!.thinking; }
    else {
      // A cached session may have missed deltas while detached. Preserve the complete snapshot and add its later suffix.
      for (const event of this.responseDeltas.get(view.session.id) ?? []) {
        if (event.liveEpoch !== view.liveEpoch || event.liveRevision === undefined || event.liveRevision <= snapshotRevision) continue;
        const delta = String(event.data.delta ?? event.data.text ?? "");
        if (event.data.thinking) thinking += delta; else streaming += delta;
      }
    }
    if (progressCleared) progress = existing!.progress;
    else {
      const update = this.progressUpdates.get(view.session.id);
      if (update?.liveEpoch === view.liveEpoch && update?.liveRevision !== undefined && update.liveRevision > snapshotRevision) progress = eventText(update.data) || String(update.data.tool ?? "Working…");
    }
    const state: SessionState = {
      session: { ...view.session },
      events: [...events.values()].sort((a, b) => a.seq - b.seq),
      transcript: [],
      transcriptRevision: existing?.transcriptRevision ?? 0,
      approvals: view.approvals,
      context: view.context || existing?.context,
      streaming, thinking, progress,
      liveRevision: sameEpoch ? Math.max(existing?.liveRevision ?? 0, snapshotRevision) : snapshotRevision,
      liveEpoch: view.liveEpoch,
      cost: existing?.cost || 0,
    };
    for (const event of newerEvents) this.applyEventMetadata(state, event);
    this.rebuild(state); this.states.set(view.session.id, state);
    const queued = this.pending.get(view.session.id) || [];
    this.pending.delete(view.session.id);
    for (const event of queued) { if ("seq" in event) this.event(event); else this.live(event); }
    this.changed();
  }

  updateSession(session: Session) {
    const state = this.states.get(session.id);
    if (state) { state.session = session; this.rebuild(state); this.changed(); }
  }

  setContext(id: string, context: ContextInfo) { const state = this.states.get(id); if (state) { state.context = context; this.changed(); } }

  private applyEventMetadata(state: SessionState, event: SessionEvent) {
    state.session = { ...state.session, headId: event.id, updatedAt: event.timestamp };
    if (event.type === "session.renamed") state.session.title = String(event.data.title);
    if (event.type === "session.archived") state.session.archived = Boolean(event.data.archived);
    if (event.type === "head.moved" && typeof event.data.headId === "string") { state.session.headId = event.data.headId; state.session.status = "idle"; }
    if (event.type === "turn.started") state.session.status = "running";
    if (event.type === "turn.ended") state.session.status = (event.data.status as Session["status"]) || "completed";
    if (event.type === "run.error") state.session.status = "failed";
    if (event.type === "run.interrupted") state.session.status = "interrupted";
    if (event.type === "model.changed" && event.data.model) state.session.model = event.data.model as Session["model"];
    if (event.type === "mode.changed") state.session.permissionMode = event.data.mode as Session["permissionMode"];
    if (event.type === "workspace.changed") {
      state.session.cwd = String(event.data.cwd);
      state.session.projectPath = event.data.projectPath as string | null;
      state.session.worktree = event.data.worktree as string | undefined;
      state.context = undefined;
    }
    if (event.type === "approval.requested") {
      const approval = (event.data.approval || event.data) as unknown as Approval;
      state.approvals = [...state.approvals.filter((item) => item.id !== approval.id), approval]; state.session.status = "waiting_approval";
    }
    if (event.type === "approval.resolved") { state.approvals = state.approvals.filter((approval) => approval.id !== (event.data.approvalId || event.data.id)); state.session.status = event.data.status as Session["status"] || "running"; }
  }

  event(event: SessionEvent) {
    const state = this.states.get(event.sessionId);
    if (!state) { const events = this.pending.get(event.sessionId) || []; events.push(event); this.pending.set(event.sessionId, events); return; }
    if (state.events.some((item) => item.id === event.id)) return;
    state.events.push(event);
    if (["turn.started", "assistant.message", "turn.ended", "run.error", "run.interrupted"].includes(event.type)) {
      this.responseDeltas.delete(event.sessionId); this.progressUpdates.delete(event.sessionId);
    }
    if (event.type === "tool.call" || event.type === "tool.result") this.progressUpdates.delete(event.sessionId);
    this.applyEventMetadata(state, event);
    if (["turn.started", "assistant.message", "turn.ended", "run.error", "run.interrupted"].includes(event.type)) { state.streaming = ""; state.thinking = ""; state.progress = ""; }
    if (event.type === "tool.call" || event.type === "tool.result") state.progress = "";
    this.rebuild(state); this.changed();
  }

  live(event: LiveEvent) {
    const state = this.states.get(event.sessionId);
    if (!state) { const events = this.pending.get(event.sessionId) || []; events.push(event); this.pending.set(event.sessionId, events); return; }
    if (event.liveEpoch !== undefined && state.liveEpoch !== undefined && event.liveEpoch !== state.liveEpoch) return;
    if (event.liveRevision !== undefined) {
      if (event.liveRevision <= state.liveRevision) return;
      state.liveRevision = event.liveRevision;
    }
    if (event.type === "assistant.delta") {
      const deltas = this.responseDeltas.get(event.sessionId) ?? [];
      deltas.push(event); this.responseDeltas.set(event.sessionId, deltas);
      const delta = String(event.data.delta ?? event.data.text ?? "");
      if (event.data.thinking) state.thinking += delta;
      else state.streaming += delta;
    }
    if (event.type === "tool.progress") { this.progressUpdates.set(event.sessionId, event); state.progress = eventText(event.data) || String(event.data.tool ?? "Working…"); }
    if (event.type === "status.changed") state.session = { ...state.session, status: event.data.status as Session["status"] };
    this.changed();
  }

  private rebuild(state: SessionState) {
    const path = activeEvents(state.events, state.session.headId);
    const consumed = new Set(path.filter((event) => event.type === "message.persisted").map((event) => event.data.sourceEventId));
    const tools = new Map<string, TranscriptItem>();
    const pendingTools = new Set<TranscriptItem>();
    const transcript: TranscriptItem[] = [];
    let activeTurnId: string | undefined;
    let turnStartedAt: string | undefined;
    let turnHasTools = false;
    let turnFailure: "failed" | "interrupted" | undefined;
    let latestPlan: TranscriptItem["plan"];
    let planItemId: string | undefined;
    const finishTools = (status: "completed" | "error" | "interrupted") => {
      for (const item of pendingTools) { item.toolStatus = status; item.error = status === "error"; }
      pendingTools.clear();
    };
    for (const event of path) {
      const turnId = activeTurnId;
      const base = { id: event.id, seq: event.seq, text: eventText(event.data), event, turnId };
      if (event.type === "turn.started") {
        activeTurnId = event.id;
        turnStartedAt = event.timestamp;
        turnHasTools = false;
        turnFailure = undefined;
      } else if (["user.message", "user.steer", "user.followUp"].includes(event.type)) {
        const inputKind = event.type === "user.steer" ? "steer" : event.type === "user.followUp" ? "followUp" : undefined;
        transcript.push({ ...base, role: "user", attachments: event.data.attachments as Attachment[] | undefined, inputKind, delivery: inputKind ? consumed.has(event.id) ? "consumed" : "queued" : undefined });
      } else if (event.type === "assistant.message") {
        const thinking = eventThinking(event.data);
        if (base.text || thinking) transcript.push({ ...base, role: "assistant", thinking: thinking || undefined });
      } else if (event.type === "tool.call") {
        turnHasTools = true;
        const toolCallId = String(event.data.toolCallId || event.id);
        const toolArgs = (event.data.args || event.data.arguments || {}) as Record<string, unknown>;
        const item: TranscriptItem = { ...base, role: "tool", tool: String(event.data.tool || event.data.name || "Tool"), toolCallId, toolArgs, toolStatus: "running", text: JSON.stringify(toolArgs, null, 2) };
        tools.set(toolCallId, item); pendingTools.add(item); transcript.push(item);
      } else if (event.type === "tool.arguments.changed") {
        const item = tools.get(String(event.data.toolCallId));
        if (item) { item.toolArgs = event.data.args as Record<string, unknown>; if (item.toolStatus === "running") item.text = JSON.stringify(item.toolArgs, null, 2); }
      } else if (event.type === "tool.result") {
        const toolCallId = String(event.data.toolCallId || event.id);
        const error = Boolean(event.data.isError);
        const item = tools.get(toolCallId);
        const text = base.text || JSON.stringify(event.data.result ?? event.data.output ?? "", null, 2);
        if (item) { item.text = text; item.error = error; item.toolStatus = error ? "error" : "completed"; pendingTools.delete(item); }
        else transcript.push({ ...base, role: "tool", tool: String(event.data.tool || event.data.name || "Result"), toolCallId, toolStatus: error ? "error" : "completed", text, error });
      } else if (event.type === "todo.updated") {
        latestPlan = Array.isArray(event.data.items) ? event.data.items as TranscriptItem["plan"] : [];
        planItemId = event.id;
        transcript.push({ ...base, role: "system", kind: "plan", plan: latestPlan, text: "" });
      } else if (["run.error", "run.interrupted"].includes(event.type)) {
        turnFailure = event.type === "run.error" ? "failed" : "interrupted";
        finishTools(turnFailure === "failed" ? "error" : "interrupted");
        transcript.push({ ...base, role: "system", kind: "notice", text: base.text || event.type.replaceAll(".", " "), error: event.type === "run.error" });
        const following = path.slice(path.indexOf(event) + 1).find((candidate) => candidate.type === "turn.started" || candidate.type === "turn.ended");
        const pairedEnd = following?.type === "turn.ended";
        if (!pairedEnd) {
          const end = Date.parse(event.timestamp);
          const start = Date.parse(turnStartedAt || event.timestamp);
          transcript.push({ ...base, role: "system", kind: "turn", turnStatus: turnFailure, durationMs: Math.max(0, end - start), hasTools: turnHasTools });
          activeTurnId = undefined; turnStartedAt = undefined;
        }
      } else if (["context.compacted", "subagent.spawned", "subagent.completed"].includes(event.type)) {
        transcript.push({ ...base, role: "system", kind: "notice", text: base.text || event.type.replaceAll(".", " ") });
      }
      if (event.type === "turn.ended") {
        const end = Date.parse(event.timestamp);
        const start = Date.parse(turnStartedAt || event.timestamp);
        const rawStatus = event.data.status;
        const turnStatus = turnFailure || (rawStatus === "failed" || rawStatus === "interrupted" ? rawStatus : "completed");
        finishTools(turnStatus === "failed" ? "error" : turnStatus === "interrupted" ? "interrupted" : "completed");
        transcript.push({ ...base, role: "system", kind: "turn", turnStatus, durationMs: Math.max(0, end - start), hasTools: turnHasTools });
        activeTurnId = undefined; turnStartedAt = undefined; turnFailure = undefined; turnHasTools = false;
      }
    }
    if (state.session.status !== "running" && state.session.status !== "waiting_approval") finishTools(state.session.status === "failed" ? "error" : "interrupted");
    state.transcript = transcript;
    state.transcriptRevision++;
    state.plan = latestPlan;
    state.planItemId = planItemId;
    state.turnStartedAt = state.session.status === "running" || state.session.status === "waiting_approval" ? turnStartedAt : undefined;
    const lastTurn = path.findLast((event) => event.type === "turn.ended");
    state.cost = Number(lastTurn?.data.cost || 0);
  }
}
