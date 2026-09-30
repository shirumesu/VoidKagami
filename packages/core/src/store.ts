import { appendFileSync, mkdirSync, readdirSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Session, SessionEvent } from "@voidkagami/protocol";

export class EventStore {
  readonly home: string;
  private db: DatabaseSync;
  private logs = new Map<string, SessionEvent[]>();
  private sessions = new Map<string, Session>();
  constructor(home: string) {
    this.home = join(home, "sessions");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "index.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL); DELETE FROM sessions;");
    for (const file of readdirSync(this.home).filter((name) => name.endsWith(".jsonl"))) {
      const path = join(this.home, file);
      const contents = readFileSync(path, "utf8");
      const end = contents.lastIndexOf("\n") + 1;
      // Only a trailing interrupted write is discarded; complete invalid records remain visible errors.
      if (end < contents.length) truncateSync(path, Buffer.byteLength(contents.slice(0, end)));
      const events = contents.slice(0, end).split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
      if (!events.length) continue;
      const id = events[0]!.sessionId;
      this.logs.set(id, events);
      for (const event of events) this.reduce(event);
      this.index(this.get(id));
    }
  }
  private reduce(event: SessionEvent): void {
    if (event.type === "session.created") {
      this.sessions.set(event.sessionId, { ...(event.data.session as Session), headId: event.id });
      return;
    }
    const session = this.get(event.sessionId);
    session.updatedAt = event.timestamp;
    session.headId = event.type === "head.moved" ? event.data.headId as string : event.id;
    if (event.type === "session.renamed") session.title = event.data.title as string;
    if (event.type === "session.archived") session.archived = Boolean(event.data.archived);
    if (event.type === "model.changed") session.model = event.data.model as Session["model"];
    if (event.type === "mode.changed") session.permissionMode = event.data.mode as Session["permissionMode"];
    if (event.type === "turn.started") session.status = "running";
    if (event.type === "approval.requested") session.status = "waiting_approval";
    if (event.type === "approval.resolved") session.status = (event.data.status as Session["status"]) || "running";
    if (event.type === "turn.ended") session.status = (event.data.status as Session["status"]) || "completed";
    if (event.type === "run.interrupted") session.status = "interrupted";
    if (event.type === "run.error") session.status = "failed";
    if (event.type === "head.moved") session.status = "idle";
  }
  private index(session: Session): void {
    this.db.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?)")
      .run(session.id, session.title, session.cwd, session.updatedAt, JSON.stringify(session));
  }
  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }
  list(query = "", archived?: boolean): Session[] {
    const rows = this.db.prepare("SELECT data FROM sessions WHERE title LIKE ? OR cwd LIKE ? ORDER BY updated_at DESC")
      .all(`%${query}%`, `%${query}%`);
    return rows.map((row) => JSON.parse(row.data as string) as Session)
      .filter((session) => archived === undefined || Boolean(session.archived) === archived);
  }
  create(input: Omit<Session, "id" | "createdAt" | "updatedAt" | "headId" | "status">): Session {
    const now = new Date().toISOString();
    const session: Session = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, headId: null, status: "idle" };
    this.sessions.set(session.id, session);
    this.logs.set(session.id, []);
    this.append(session.id, "session.created", { session: { ...session } });
    return this.get(session.id);
  }
  append(id: string, type: string, data: Record<string, unknown>, parentId?: string | null): SessionEvent {
    const session = this.get(id);
    const log = this.logs.get(id)!;
    const event: SessionEvent = {
      id: randomUUID(), sessionId: id, parentId: parentId === undefined ? session.headId : parentId,
      seq: (log.at(-1)?.seq ?? 0) + 1, timestamp: new Date().toISOString(), type, data,
    };
    appendFileSync(join(this.home, `${id}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 });
    log.push(event);
    this.reduce(event);
    this.index(this.get(id));
    return event;
  }
  events(id: string, afterSeq = 0): SessionEvent[] {
    this.get(id);
    return this.logs.get(id)!.filter((event) => event.seq > afterSeq);
  }
  branch(id: string, headId: string | null = this.get(id).headId): SessionEvent[] {
    const map = new Map(this.events(id).map((event) => [event.id, event]));
    const branch: SessionEvent[] = [];
    let head = headId;
    while (head) {
      const event = map.get(head);
      if (!event) throw new Error(`Unknown event: ${head}`);
      branch.push(event);
      head = event.parentId;
    }
    return branch.reverse();
  }
  close(): void { this.db.close(); }
}
