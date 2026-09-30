import type { Approval, ContextInfo, LiveEvent, Session, SessionEvent, SessionView } from "@voidkagami/protocol";

export interface TranscriptItem {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  event: SessionEvent;
  tool?: string;
  error?: boolean;
}
export interface SessionState {
  session: Session;
  events: SessionEvent[];
  transcript: TranscriptItem[];
  approvals: Approval[];
  context?: ContextInfo;
  streaming: string;
  progress: string;
  cost: number;
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
    const state: SessionState = { session: view.session, events: [...events.values()].sort((a, b) => a.seq - b.seq), transcript: [], approvals: view.approvals, context: view.context || existing?.context, streaming: "", progress: "", cost: existing?.cost || 0 };
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

  event(event: SessionEvent) {
    const state = this.states.get(event.sessionId);
    if (!state) { const events = this.pending.get(event.sessionId) || []; events.push(event); this.pending.set(event.sessionId, events); return; }
    if (state.events.some((item) => item.id === event.id)) return;
    state.events.push(event);
    state.session = { ...state.session, headId: event.id, updatedAt: event.timestamp };
    if (event.type === "session.renamed") state.session.title = String(event.data.title);
    if (event.type === "head.moved" && typeof event.data.headId === "string") state.session.headId = event.data.headId;
    if (event.type === "turn.started") { state.session.status = "running"; state.streaming = ""; }
    if (event.type === "assistant.message") state.streaming = "";
    if (event.type === "turn.ended") { state.session.status = (event.data.status as Session["status"]) || "completed"; state.streaming = ""; state.progress = ""; }
    if (event.type === "run.error") { state.session.status = "failed"; state.streaming = ""; state.progress = ""; }
    if (event.type === "run.interrupted") { state.session.status = "interrupted"; state.streaming = ""; state.progress = ""; }
    if (event.type === "model.changed" && event.data.model) state.session.model = event.data.model as Session["model"];
    if (event.type === "mode.changed") state.session.permissionMode = event.data.mode as Session["permissionMode"];
    if (event.type === "approval.requested") {
      const approval = (event.data.approval || event.data) as unknown as Approval;
      state.approvals = [...state.approvals.filter((item) => item.id !== approval.id), approval]; state.session.status = "waiting_approval";
    }
    if (event.type === "approval.resolved") { state.approvals = state.approvals.filter((approval) => approval.id !== (event.data.approvalId || event.data.id)); state.session.status = event.data.status as Session["status"] || "running"; }
    this.rebuild(state); this.changed();
  }

  live(event: LiveEvent) {
    const state = this.states.get(event.sessionId);
    if (!state) { const events = this.pending.get(event.sessionId) || []; events.push(event); this.pending.set(event.sessionId, events); return; }
    if (event.type === "assistant.delta") state.streaming += String(event.data.delta ?? event.data.text ?? "");
    if (event.type === "tool.progress") state.progress = eventText(event.data) || String(event.data.tool ?? "Working…");
    if (event.type === "status.changed") state.session = { ...state.session, status: event.data.status as Session["status"] };
    this.changed();
  }

  private rebuild(state: SessionState) {
    const path = activeEvents(state.events, state.session.headId);
    state.transcript = path.flatMap((event): TranscriptItem[] => {
      const base = { id: event.id, seq: event.seq, text: eventText(event.data), event };
      if (["user.message", "user.steer", "user.followUp"].includes(event.type)) return [{ ...base, role: "user" }];
      if (event.type === "assistant.message") return [{ ...base, role: "assistant" }];
      if (event.type === "tool.call") return [{ ...base, role: "tool", tool: String(event.data.tool || event.data.name || "Tool"), text: JSON.stringify(event.data.args || event.data.arguments || {}, null, 2) }];
      if (event.type === "tool.result") return [{ ...base, role: "tool", tool: String(event.data.tool || event.data.name || "Result"), error: Boolean(event.data.isError) }];
      if (["run.error", "run.interrupted", "context.compacted", "subagent.spawned", "subagent.completed"].includes(event.type)) return [{ ...base, role: "system", text: base.text || event.type.replaceAll(".", " "), error: event.type === "run.error" }];
      return [];
    });
    const lastTurn = path.findLast((event) => event.type === "turn.ended");
    state.cost = Number(lastTurn?.data.cost || 0);
  }
}
