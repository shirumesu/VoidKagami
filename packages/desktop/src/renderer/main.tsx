import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionStore } from "@voidkagami/client/store";
import { isBusy } from "@voidkagami/protocol";
import type { Approval, Attachment, Config, ContextInfo, LiveEvent, ModelInfo, PermissionMode, Session, SessionEvent, TaskInfo, ThinkingLevel } from "@voidkagami/protocol";
import type { DesktopBridge } from "../bridge.ts";
import "./style.css";
import { DiffView } from "./diff.tsx";
import { AppearanceSettings, initializeAppearance } from "./appearance.tsx";

const api: DesktopBridge = window.voidkagami;
const store = new SessionStore();
const modes: { value: PermissionMode; label: string }[] = [{ value: "ask", label: "Ask before changes" }, { value: "accept_edits", label: "Accept edits" }, { value: "auto", label: "Fully automatic" }, { value: "plan", label: "Plan · read only" }];
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const sessionProject = (session: Session) => session.projectPath || session.cwd;
const modelValue = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const parseModel = (value: string) => ({ provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
type ComposerDraft = { text: string; attachments: Attachment[] };
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
const builtInCommands = [
  { name: "new", description: "Start a new task" }, { name: "model", description: "Choose a model" },
  { name: "context", description: "Inspect context usage" }, { name: "compact", description: "Summarize this conversation" },
  { name: "diff", description: "Review file changes" }, { name: "tasks", description: "Inspect background tasks" },
  { name: "fork", description: "Branch this conversation" }, { name: "rename", description: "Rename this task" },
  { name: "queue", description: "Queue a follow-up message" }, { name: "settings", description: "Accounts and configuration" },
  { name: "login", description: "Connect a provider" }, { name: "help", description: "Commands and shortcuts" },
];
const pathAttachment = (path: string): Attachment => ({ type: /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : "file", path });
function readDrafts(): Record<string, ComposerDraft> {
  try { return JSON.parse(localStorage.getItem("drafts") || "{}"); } catch { return {}; }
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void api.openExternal(href); }}>{children}</a> }}>{text}</ReactMarkdown>;
}

function Modal({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [close]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close">×</button></header>{children}</section></div>;
}

function App() {
  useSyncExternalStore(store.subscribe, () => store.version);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("selectedSession"));
  const [projects, setProjects] = useState<string[]>(() => JSON.parse(localStorage.getItem("projects") || "[]") as string[]);
  const [project, setProject] = useState<string>("");
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => JSON.parse(localStorage.getItem("collapsedProjects") || "[]") as string[]);
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>(readDrafts);
  const composer = selected ? drafts[selected] || emptyDraft : emptyDraft;
  const draft = composer.text;
  const attachments = composer.attachments;
  const setDraft = (value: React.SetStateAction<string>) => { if (selected) setDrafts((items) => { const current = items[selected] || emptyDraft; return { ...items, [selected]: { ...current, text: typeof value === "function" ? value(current.text) : value } }; }); };
  const setAttachments = (value: React.SetStateAction<Attachment[]>) => { if (selected) setDrafts((items) => { const current = items[selected] || emptyDraft; return { ...items, [selected]: { ...current, attachments: typeof value === "function" ? value(current.attachments) : value } }; }); };
  const [queue, setQueue] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | "context" | "tasks" | "rename" | "fork" | "rewind" | "model" | "help" | null>(null);
  const [actionEvent, setActionEvent] = useState<string | undefined>();
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffEvent, setDiffEvent] = useState("");
  const [auth, setAuth] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [sending, setSending] = useState(false);
  const [imports, setImports] = useState<Record<string, number>>({});
  const importing = selected ? (imports[selected] || 0) > 0 : false;
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [customCommands, setCustomCommands] = useState<{ name: string; description: string }[]>([]);
  const slashQuery = /^\/([^\s]*)$/.exec(draft)?.[1];
  const [fileIndex, setFileIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const commandSuggestions = slashQuery !== undefined && !mentionDismissed ? [...builtInCommands, ...customCommands].filter((item) => item.name.includes(slashQuery)).slice(0, 7) : [];
  const [dragging, setDragging] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const followScroll = useRef(true);
  const state = selected ? store.get(selected) : undefined;
  const busy = state ? isBusy(state.session.status) : false;
  const act = (action: () => Promise<unknown>) => { setError(""); void action().catch((failure: unknown) => setError(errorText(failure))); };
  const update = (session: Session) => { store.updateSession(session); setSessions((items) => items.map((item) => item.id === session.id ? session : item)); };
  const refresh = useCallback(async () => {
    const [active, archived, nextModels] = await Promise.all([api.request("session.list", {}), api.request("session.list", { archived: true }), api.request("model.list", {})]);
    const nextSessions = [...active, ...archived]; setSessions(nextSessions); setModels(nextModels);
    for (const session of nextSessions.filter((item) => isBusy(item.status))) if (!store.get(session.id)) store.attach(await api.request("session.attach", { sessionId: session.id }));
  }, []);

  useEffect(() => {
    const dispose = api.onNotification((message) => {
      if (message.method === "event") {
        const event = message.params as SessionEvent; store.event(event);
        if (event.type === "session.created" && event.data.session) {
          const created = event.data.session as Session;
          setSessions((items) => items.some((item) => item.id === created.id) ? items : [created, ...items]);
          void api.request("session.attach", { sessionId: created.id }).then((view) => store.attach(view)).catch((failure: unknown) => setError(errorText(failure)));
        }
        const next = store.get(event.sessionId)?.session;
        if (next) setSessions((items) => items.map((item) => item.id === next.id ? next : item));
        else if (event.type !== "session.created") void refresh().catch((failure: unknown) => setError(errorText(failure)));
        if (event.type === "turn.ended") void api.request("session.context", { sessionId: event.sessionId }).then((value) => store.setContext(event.sessionId, value)).catch(() => {});
      }
      if (message.method === "live") store.live(message.params as LiveEvent);
      if (message.method === "auth") { setAuth(message.params as Record<string, unknown>); if (message.params.type === "complete") void refresh(); }
    });
    const replay = api.onReplay((view) => { store.attach(view); update(view.session); });
    const status = api.onConnection(setConnection);
    void refresh().catch((failure: unknown) => setError(errorText(failure)));
    return () => { dispose(); replay(); status(); };
  }, [refresh]);

  useEffect(() => { localStorage.setItem("projects", JSON.stringify(projects)); }, [projects]);
  useEffect(() => { localStorage.setItem("collapsedProjects", JSON.stringify(collapsedProjects)); }, [collapsedProjects]);
  useEffect(() => { localStorage.setItem("drafts", JSON.stringify(drafts)); }, [drafts]);
  useEffect(() => { if (selected) localStorage.setItem("selectedSession", selected); }, [selected]);
  useEffect(() => {
    if (!selected) return;
    let canceled = false;
    void api.request("session.attach", { sessionId: selected }).then((view) => { if (!canceled) { store.attach(view); setProject(sessionProject(view.session)); } }).catch((failure: unknown) => setError(errorText(failure)));
    followScroll.current = true; setSearch(""); setDiffEvent(""); setQueue(false); setFileSuggestions([]); setMentionDismissed(false); setCursor(0);
    return () => { canceled = true; };
  }, [selected]);
  useEffect(() => { if (followScroll.current) end.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth" }); }, [selected, state?.transcriptRevision, state?.liveRevision]);
  useEffect(() => {
    if (!diffOpen || !selected) return;
    let cancelled = false;
    setDiffLoading(true); setDiffError("");
    void api.request("session.diff", { sessionId: selected, eventId: diffEvent || undefined }).then((result) => { if (!cancelled) setDiff(result.diff); }).catch((failure: unknown) => { if (!cancelled) setDiffError(errorText(failure)); }).finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [selected, diffOpen, diffEvent, state?.session.status]);
  useEffect(() => {
    const match = draft.slice(0, cursor).match(/(?:^|\s)@([^\s"]*)$/);
    setFileIndex(0);
    if (!match || !state || mentionDismissed) { setFileSuggestions([]); return; }
    let canceled = false;
    const timer = setTimeout(() => { void api.request("project.files", { cwd: state.session.cwd, query: match[1] }).then((files) => { if (!canceled) setFileSuggestions(files.slice(0, 7)); }).catch(() => {}); }, 150);
    return () => { canceled = true; clearTimeout(timer); };
  }, [draft, cursor, state?.session.cwd, mentionDismissed]);
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    void api.request("commands.list", { cwd: state.session.cwd }).then((items) => { if (!cancelled) setCustomCommands(items); }).catch((failure: unknown) => setError(errorText(failure)));
    return () => { cancelled = true; };
  }, [state?.session.cwd]);
  useEffect(() => {
    if (modal !== "tasks" || !selected) return;
    let canceled = false;
    const refreshTasks = () => { void api.request("session.tasks", { sessionId: selected }).then((value) => { if (!canceled) setTasks(value); }).catch((failure: unknown) => { if (!canceled) setError(errorText(failure)); }); };
    refreshTasks();
    const timer = setInterval(refreshTasks, 1000);
    return () => { canceled = true; clearInterval(timer); };
  }, [modal, selected]);

  function selectFile(path: string) {
    const match = draft.slice(0, cursor).match(/@[^\s"]*$/);
    if (!match) return;
    const reference = `@"${path}" `;
    const start = cursor - match[0].length;
    const nextCursor = start + reference.length;
    setDraft(draft.slice(0, start) + reference + draft.slice(cursor));
    setCursor(nextCursor); setFileSuggestions([]);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCursor, nextCursor); });
  }
  async function importFiles(files: File[]) {
    if (!selected) return;
    const sessionId = selected;
    setImports((items) => ({ ...items, [sessionId]: (items[sessionId] || 0) + 1 }));
    try {
      const paths = await api.importAttachments(await Promise.all(files.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() }))));
      setAttachments((items) => [...items, ...paths.map(pathAttachment)]);
    } finally {
      setImports((items) => ({ ...items, [sessionId]: items[sessionId]! - 1 }));
    }
  }

  async function openProject() { const cwd = await api.chooseFolder(); if (cwd) { setProjects((items) => [...new Set([...items, cwd])]); setProject(cwd); setModal("new"); } }
  async function createSession(cwd: string, branch: string, worktree: boolean, model: string, mode: PermissionMode) {
    const session = await api.request("session.create", { cwd, branch: branch || undefined, worktree, model: model ? parseModel(model) : undefined, permissionMode: mode });
    setSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]); setSelected(session.id); setCollapsedProjects((items) => items.filter((item) => item !== sessionProject(session))); setModal(null);
  }
  async function send() {
    if (!selected || (!draft.trim() && !attachments.length) || sending || importing) return;
    setSending(true);
    try {
      let text = draft.trim();
      const [command, ...parts] = text.slice(1).split(/\s+/);
      if (text.startsWith("/") && builtInCommands.some((item) => item.name === command)) {
        if (command === "queue") { text = parts.join(" "); if (!text && !attachments.length) throw new Error("Usage: /queue <message>"); }
        else {
          if (command === "new") setModal("new");
          if (command === "model") setModal("model");
          if (command === "context") await showContext();
          if (command === "compact") await api.request("session.compact", { sessionId: selected });
          if (command === "diff") setDiffOpen(true);
          if (command === "tasks") await showTasks();
          if (command === "fork") { setActionEvent(undefined); setModal("fork"); }
          if (command === "rename") { if (parts.length) update(await api.request("session.rename", { sessionId: selected, title: parts.join(" ") })); else setModal("rename"); }
          if (command === "settings" || command === "login") setModal("settings");
          if (command === "help") setModal("help");
          setDraft(""); return;
        }
      }
      const refs: Attachment[] = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)].map((match) => pathAttachment(match[1] || match[2]!));
      if (busy) await api.request(queue || command === "queue" ? "session.followUp" : "session.steer", { sessionId: selected, text, attachments: [...attachments, ...refs] });
      else await api.request("session.send", { sessionId: selected, text, attachments: [...attachments, ...refs] });
      setDrafts((items) => { if (items[selected] !== composer) return items; const next = { ...items }; delete next[selected]; return next; });
      setQueue(false); followScroll.current = true; input.current?.focus();
    } finally { setSending(false); }
  }
  async function showContext() { if (selected) { const value = await api.request("session.context", { sessionId: selected }); setContext(value); store.setContext(selected, value); setModal("context"); } }
  async function showTasks() { setTasks([]); setModal("tasks"); }
  async function fork(worktree: boolean) { if (selected) { const next = await api.request("session.fork", { sessionId: selected, eventId: actionEvent, worktree }); setSessions((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelected(next.id); setModal(null); } }
  async function rewind(restoreFiles: boolean) { if (selected && actionEvent) { update(await api.request("session.rewind", { sessionId: selected, eventId: actionEvent, restoreFiles })); store.attach(await api.request("session.attach", { sessionId: selected })); setModal(null); } }
  const groups = useMemo(() => [...new Set([...projects, ...sessions.map(sessionProject)])], [projects, sessions]);
  const filtered = sessions.filter((session) => Boolean(session.archived) === showArchived && `${session.title} ${sessionProject(session)} ${session.cwd}`.toLowerCase().includes(filter.toLowerCase()));
  const transcript = state?.transcript.filter((item) => !search || item.text.toLowerCase().includes(search.toLowerCase())) || [];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <div className="sidebar-brand">VoidKagami</div>
      <button className="new-task" onClick={() => project ? setModal("new") : act(openProject)}><span>＋</span> New task</button>
      <input className="sidebar-search" placeholder="Search tasks" aria-label="Search tasks" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="project-list">
        <div className="section-label"><span>{showArchived ? "Archived tasks" : "Projects"}</span><button onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Back" : "Archived"}</button><button className="icon-button" aria-label="Open project" title="Open project" onClick={() => act(openProject)}>＋</button></div>
        {groups.map((cwd) => <div className="project-group" key={cwd}>
          <div className="project-heading"><button className="project-title" title={cwd} aria-expanded={!collapsedProjects.includes(cwd)} onClick={() => { setProject(cwd); setCollapsedProjects((items) => items.includes(cwd) ? items.filter((item) => item !== cwd) : [...items, cwd]); }}><span className="project-chevron">{collapsedProjects.includes(cwd) ? "▸" : "▾"}</span><span className="project-name">{baseName(cwd)}</span><span className="project-count">{filtered.filter((session) => sessionProject(session) === cwd).length}</span></button><button className="project-add" aria-label={`New task in ${baseName(cwd)}`} title="New task in project" onClick={() => { setProject(cwd); setCollapsedProjects((items) => items.filter((item) => item !== cwd)); setModal("new"); }}>＋</button></div>
          {!collapsedProjects.includes(cwd) && filtered.filter((session) => sessionProject(session) === cwd).map((session) => <button key={session.id} className={`session-link ${selected === session.id ? "selected" : ""}`} onClick={() => setSelected(session.id)} title={session.title}><span className={`status-dot ${session.status}`} /><span>{session.title}</span>{session.parentSessionId && <span className="branch-badge">⑂</span>}</button>)}
        </div>)}
        {!groups.length && <p className="sidebar-empty">Open a project to start a task.</p>}
      </div>
      <div className="sidebar-bottom"><button onClick={() => setModal("settings")}>⚙ <span>Settings</span></button><span className={`connection ${connection === "connected" ? "" : "offline"}`} title={connection}>{connection === "connected" ? "Connected" : connection === "connecting" || connection === "reconnecting" ? connection : "Disconnected"}</span></div>
    </aside>
    <main className="main-column">
      <header className="topbar"><div className="title-path">{state ? <><span>{baseName(sessionProject(state.session))}</span><span className="separator">/</span><button className="session-title-button" title="Rename task" onClick={() => setModal("rename")}>{state.session.title}</button>{state.session.worktree && <span className="tag">⑂ Worktree</span>}</> : <span>New task</span>}</div>{state && <div className="topbar-actions"><button onClick={() => act(showTasks)} title="Background tasks">Tasks</button><button onClick={() => { setActionEvent(undefined); setModal("fork"); }} disabled={busy}>Fork</button><button disabled={busy} onClick={() => act(async () => { const archived = !state.session.archived; update(await api.request("session.archive", { sessionId: state.session.id, archived })); setShowArchived(archived); })}>{state.session.archived ? "Restore" : "Archive"}</button><button className={diffOpen ? "active" : ""} onClick={() => setDiffOpen(!diffOpen)}>Changes {diffOpen ? "›" : "‹"}</button></div>}</header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
      {state ? <>
        <div className="conversation-toolbar"><span className={`status-dot ${state.session.status}`} /><span>{state.session.status.replaceAll("_", " ")}</span><input aria-label="Search conversation" placeholder="Find in conversation" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <div className="conversation" ref={scroll} onScroll={() => { if (scroll.current) followScroll.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
          <div className="messages">
            {!transcript.length && !search && <div className="conversation-start"><h1>What would you like to work on?</h1><p>{state.session.cwd}</p></div>}
            {search && !transcript.length && <p className="muted">No matching messages.</p>}
            {transcript.map((item) => <article className={`message ${item.role}`} key={item.id}>
              {item.role === "tool" ? <details><summary><span className={`tool-name ${item.error ? "error-text" : ""}`} title={item.tool}>{item.toolStatus === "running" ? "◌" : item.error ? "×" : "◇"} {item.tool}</span><span className="tool-preview" title="Expand command and output">{String(item.toolArgs?.command || item.toolArgs?.path || item.toolArgs?.query || item.text).replace(/\s+/g, " ").slice(0, 110)}</span><span className="tool-status">{item.toolStatus} · expand</span></summary>{item.toolArgs && <pre className="tool-input" aria-label="Tool command and arguments">{JSON.stringify(item.toolArgs, null, 2)}</pre>}<pre aria-label="Tool output">{item.text}</pre></details> : <><div className="message-label">{item.role === "user" ? "You" : item.role === "assistant" ? "VoidKagami" : "Session"}{item.delivery === "queued" && <span className="tag">{item.inputKind === "followUp" ? "Queued follow-up" : "Queued steering"}</span>}</div>{item.thinking && <details className="thinking"><summary>Thinking</summary><div className="markdown"><Markdown text={item.thinking} /></div></details>}<div className="markdown"><Markdown text={item.text} /></div>{item.attachments?.length ? <div className="message-attachments">{item.attachments.map((attachment, index) => <span className="attachment" key={index}>{attachment.type === "image" ? "▧" : "▤"} {baseName(attachment.path)}</span>)}</div> : null}{(item.event.type === "assistant.message" || item.event.type === "user.message") && <div className="message-actions"><button onClick={() => act(() => navigator.clipboard.writeText(item.text))}>Copy</button><button disabled={busy} onClick={() => { setActionEvent(item.id); setModal("fork"); }}>Fork here</button><button disabled={busy} onClick={() => { setActionEvent(item.id); setModal("rewind"); }}>Rewind</button><button onClick={() => { setDiffEvent(item.id); setDiffOpen(true); }}>Changes</button></div>}</>}
            </article>)}
            {(state.streaming || state.thinking) && !search && <article className="message assistant streaming"><div className="message-label">VoidKagami <span className="thinking-dot" /></div>{state.thinking && <details className="thinking"><summary>Thinking…</summary><div className="markdown"><Markdown text={state.thinking} /></div></details>}{state.streaming && <div className="markdown"><Markdown text={state.streaming} /></div>}</article>}
            {state.progress && <details className="tool-progress"><summary><span>Running tool</span><span className="tool-preview">{state.progress.replace(/\s+/g, " ").slice(-110)}</span><span className="tool-status">expand</span></summary><pre>{state.progress}</pre></details>}
            {!state.streaming && busy && !state.approvals.length && <div className="working"><span className="thinking-dot" />Working…</div>}
            <div ref={end} />
          </div>
        </div>
        {state.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onError={setError} />)}
        <form className="composer-area" onSubmit={(event) => { event.preventDefault(); act(send); }}>
          <div className={`composer ${dragging ? "dragging" : ""}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); const files = [...event.dataTransfer.files]; if (files.length) act(() => importFiles(files)); }}>
            {importing && <div className="picker-hint" role="status">Adding attachments…</div>}
            {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <span className="attachment" key={`${attachment.path}-${index}`}>{attachment.type === "image" ? "▧" : "▤"} {baseName(attachment.path)}<button type="button" aria-label={`Remove ${baseName(attachment.path)}`} onClick={() => setAttachments((items) => items.filter((_, at) => at !== index))}>×</button></span>)}</div>}
            <textarea ref={input} value={draft} placeholder={busy ? "Steer this task, or queue a follow-up…" : "Ask anything, @ to reference a file…"} rows={3} aria-label="Message" aria-controls={fileSuggestions.length ? "file-suggestions" : undefined} aria-activedescendant={fileSuggestions.length ? `file-suggestion-${fileIndex}` : undefined} onChange={(event) => { setDraft(event.target.value); setCursor(event.target.selectionStart); setFileIndex(0); setMentionDismissed(false); }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); act(() => importFiles(files)); } }} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (commandSuggestions.length) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setFileIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + commandSuggestions.length) % commandSuggestions.length); return; }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); setDraft(`/${commandSuggestions[fileIndex]?.name || commandSuggestions[0]!.name} `); setFileIndex(0); return; }
                if (event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); return; }
              }
              if (fileSuggestions.length) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setFileIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + fileSuggestions.length) % fileSuggestions.length); return; }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); selectFile(fileSuggestions[fileIndex]!); return; }
                if (event.key === "Escape") { event.preventDefault(); setMentionDismissed(true); setFileSuggestions([]); return; }
              }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); act(send); }
              if (event.key === "Escape" && busy && selected) act(() => api.request("session.abort", { sessionId: selected }));
            }} />
            {commandSuggestions.length > 0 && <div className="file-suggestions" role="listbox" aria-label="Commands">{commandSuggestions.map((command, index) => <button type="button" role="option" aria-selected={index === fileIndex} className={index === fileIndex ? "selected" : ""} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraft(`/${command.name} `); input.current?.focus(); }}>/{command.name}<span className="command-description">{command.description}</span></button>)}<div className="picker-hint">↑↓ navigate · Enter or Tab insert · Esc dismiss</div></div>}
            {fileSuggestions.length > 0 && <div className="file-suggestions" id="file-suggestions" role="listbox" aria-label="Project files">{fileSuggestions.map((path, index) => <button type="button" id={`file-suggestion-${index}`} role="option" aria-selected={index === fileIndex} className={index === fileIndex ? "selected" : ""} key={path} onMouseDown={(event) => event.preventDefault()} onClick={() => selectFile(path)}>{path}</button>)}<div className="picker-hint">↑↓ navigate · Enter or Tab insert · Esc dismiss</div></div>}
            <div className="composer-actions"><button type="button" className="icon-button" title="Attach files or images" onClick={() => act(async () => { const paths = await api.chooseAttachments(); setAttachments((items) => [...items, ...paths.map(pathAttachment)]); })}>＋</button><button type="button" className="model-button" aria-label="Choose model" disabled={busy} onClick={() => setModal("model")}>{models.find((model) => modelValue(model) === modelValue(state.session.model))?.name || state.session.model.id}<span>⌄</span></button>{(models.find((model) => modelValue(model) === modelValue(state.session.model))?.thinkingLevels?.length || 0) > 1 && <select aria-label="Thinking effort" value={state.session.model.thinkingLevel || "off"} disabled={busy} onChange={(event) => act(async () => update(await api.request("model.select", { sessionId: state.session.id, model: { ...state.session.model, thinkingLevel: event.target.value as ThinkingLevel } })))}>{models.find((model) => modelValue(model) === modelValue(state.session.model))!.thinkingLevels.map((level) => <option value={level} key={level}>{level === "off" ? "Default effort" : level}</option>)}</select>}<div className="composer-spacer" />{busy && <label className="queue-option"><input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />Queue</label>}{busy && <button type="button" className="stop-button" title="Stop task" onClick={() => act(() => api.request("session.abort", { sessionId: state.session.id }))}>■</button>}<button className="send-button" disabled={(!draft.trim() && !attachments.length) || sending || importing} title={busy ? queue ? "Queue message" : "Steer task" : "Send message"} type="submit">↑</button></div>
          </div>
          <div className="composer-footer"><select aria-label="Permission mode" value={state.session.permissionMode} onChange={(event) => act(async () => update(await api.request("session.mode", { sessionId: state.session.id, mode: event.target.value as PermissionMode })))}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}</select><button type="button" onClick={() => act(showContext)}>{state.context ? `${Math.round(100 * state.context.tokens / state.context.limit)}% context · ` : "Context · "}${state.cost.toFixed(4)}</button></div>
        </form>
      </> : <div className="welcome"><h1>What would you like to work on?</h1><p>Choose a project to start a task.</p><button className="primary" onClick={() => act(openProject)}>Open project</button>{groups.length > 0 && <select aria-label="Existing project" value="" onChange={(event) => { setProject(event.target.value); setModal("new"); }}><option value="" disabled>Or choose a recent project</option>{groups.map((cwd) => <option value={cwd} key={cwd}>{baseName(cwd)}</option>)}</select>}</div>}
    </main>
    {diffOpen && state && <aside className="diff-panel"><header><h3>Changes</h3><button className="icon-button" onClick={() => setDiffOpen(false)} aria-label="Close changes">×</button></header><select aria-label="Changes at turn" value={diffEvent} onChange={(event) => setDiffEvent(event.target.value)}><option value="">Current changes</option>{state.transcript.filter((item) => item.event.type === "user.message" || item.event.type === "assistant.message").map((item) => <option value={item.id} key={item.id}>{item.role}: {item.text.slice(0, 60)}</option>)}</select>{diffError ? <div className="error-banner" role="alert">{diffError}</div> : <DiffView diff={diff} loading={diffLoading} />}</aside>}
    {modal === "help" && <Modal title="Commands and shortcuts" close={() => setModal(null)}><div className="modal-content"><p className="muted">Enter sends · Shift+Enter adds a line · Esc stops a running task · @ adds project files · Paste or drop files and images</p>{[...builtInCommands, ...customCommands].map((command) => <div className="command-help" key={command.name}><code>/{command.name}</code><span>{command.description}</span></div>)}</div></Modal>}
    {modal === "new" && <NewTask cwd={project} models={models} close={() => setModal(null)} create={createSession} onError={setError} chooseFolder={async () => { const path = await api.chooseFolder(); if (path) { setProject(path); setProjects((items) => [...new Set([...items, path])]); } }} />}
    {modal === "settings" && <Settings close={() => setModal(null)} models={models} authEvent={auth} onError={setError} refresh={refresh} />}
    {modal === "rename" && state && <RenameTask title={state.session.title} close={() => setModal(null)} save={async (title) => { update(await api.request("session.rename", { sessionId: state.session.id, title })); setModal(null); }} onError={setError} />}
    {modal === "fork" && state && <SessionAction title="Fork task" close={() => setModal(null)} onError={setError} submit={fork} action="Fork task" options={[{ value: false, label: "Use the same project folder", description: "Continue a copy of this conversation in the current workspace." }, { value: true, label: "Create an isolated Git worktree", description: "Continue in a separate workspace with this conversation's files." }]} />}
    {modal === "rewind" && state && <SessionAction title="Rewind task" close={() => setModal(null)} onError={setError} submit={rewind} action="Rewind task" options={[{ value: false, label: "Rewind conversation only", description: "Keep current workspace files." }, { value: true, label: "Rewind conversation and files", description: "Restore workspace files to this point in the conversation." }]} />}
    {modal === "model" && state && <ModelPicker models={models} current={modelValue(state.session.model)} close={() => setModal(null)} onError={setError} select={async (model) => { update(await api.request("model.select", { sessionId: state.session.id, model: parseModel(model) })); setModal(null); }} />}
    {modal === "context" && context && <Modal title="Context" close={() => setModal(null)}><div className="modal-content"><div className="context-stats"><strong>~{context.tokens.toLocaleString()} <span>/ {context.limit.toLocaleString()} tokens</span></strong><span>{context.messageCount} messages · ${context.cost.toFixed(4)}</span></div><progress max={context.limit} value={context.tokens} /><p className="muted">Estimated context usage</p><div className="context-breakdown">{context.components.map((part) => <div key={part.name}><span>{part.name}</span><span>~{part.tokens.toLocaleString()} tokens</span></div>)}</div><h3>System instructions</h3><pre className="context-prompt">{context.systemPrompt}</pre><h3>Available skills</h3>{context.skills.map((skill) => <div className="skill-item" key={skill.path}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}<button disabled={busy} onClick={() => act(async () => { await api.request("session.compact", { sessionId: selected! }); await showContext(); })}>Compact context</button></div></Modal>}
    {modal === "tasks" && <Modal title="Background tasks" close={() => setModal(null)}><div className="modal-content">{sessions.filter((session) => session.parentSessionId === selected).map((child) => <div className="task-card" key={child.id}><div><strong>{child.title}</strong><span className="tag">{child.status.replaceAll("_", " ")}</span></div><button onClick={() => { setSelected(child.id); setModal(null); }}>{child.status === "waiting_approval" ? "Respond to agent" : "Open agent session"}</button></div>)}{!tasks.length && <p className="muted">No background shell processes in this session.</p>}{tasks.map((task) => <div className="task-card" key={task.id}><details><summary><strong className="tool-preview">{task.command.replace(/\s+/g, " ")}</strong><span className="tag">{task.status}</span><span className="tool-status">expand</span></summary><pre aria-label="Task command">{task.command}</pre><pre aria-label="Task output">{task.output}</pre></details>{task.status === "running" && <button onClick={() => act(async () => { await api.request("task.stop", { sessionId: selected!, taskId: task.id }); await showTasks(); })}>Stop process</button>}</div>)}</div></Modal>}
  </div>;
}

function RenameTask({ title, close, save, onError }: { title: string; close: () => void; save: (title: string) => Promise<void>; onError: (message: string) => void }) {
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  return <Modal title="Rename task" close={close}><form className="modal-content form" onSubmit={(event) => { event.preventDefault(); setPending(true); void save(value.trim()).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); }}><label>Task title<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label><footer><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={pending || !value.trim()}>Save</button></footer></form></Modal>;
}

function SessionAction({ title, close, onError, submit, action, options }: { title: string; close: () => void; onError: (message: string) => void; submit: (value: boolean) => Promise<void>; action: string; options: { value: boolean; label: string; description: string }[] }) {
  const [value, setValue] = useState(false);
  const [pending, setPending] = useState(false);
  return <Modal title={title} close={close}><form className="modal-content form" onSubmit={(event) => { event.preventDefault(); setPending(true); void submit(value).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); }}>{options.map((option) => <label className="action-option" key={String(option.value)}><input type="radio" name="workspace-action" checked={value === option.value} onChange={() => setValue(option.value)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}<footer><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={pending}>{action}</button></footer></form></Modal>;
}

function ModelPicker({ models, current, close, onError, select }: { models: ModelInfo[]; current: string; close: () => void; onError: (message: string) => void; select: (value: string) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const filtered = models.filter((model) => `${model.name} ${modelValue(model)}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(modelValue(b) === current) - Number(modelValue(a) === current));
  const choose = (value: string) => { if (pending) return; setPending(true); void select(value).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); };
  return <Modal title="Choose model" close={close}><div className="modal-content model-picker"><input aria-label="Search models" autoFocus placeholder="Search models" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((value) => Math.max(0, Math.min(filtered.length - 1, value + (event.key === "ArrowDown" ? 1 : -1)))); } if (event.key === "Enter" && filtered[index]) { event.preventDefault(); choose(modelValue(filtered[index]!)); } }} /><div role="listbox" aria-label="Models">{filtered.map((model, at) => <button role="option" aria-selected={at === index} className={at === index ? "selected" : ""} key={modelValue(model)} disabled={pending} onClick={() => choose(modelValue(model))}><span>{modelValue(model) === current ? "✓ " : ""}{model.name}<small>{model.provider} / {model.id}</small></span><small>{model.authenticated ? `${Math.round(model.contextWindow / 1000)}k` : "Sign in required"}</small></button>)}</div>{!filtered.length && <p className="muted">No matching models.</p>}<p className="picker-hint">↑↓ select · Enter confirm · Esc cancel</p></div></Modal>;
}

function ApprovalCard({ approval, onError }: { approval: Approval; onError: (message: string) => void }) {
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState<"" | "project" | "global">("");
  const [pending, setPending] = useState(false);
  const respond = (allow: boolean, value?: string) => { setPending(true); void api.request("approval.respond", { approvalId: approval.id, allow, answer: value, remember: remember || undefined }).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); };
  return <section className="approval-card"><h3>{approval.question || `Allow ${approval.tool}?`}</h3>{approval.question ? <><div className="approval-options">{approval.options?.map((option) => <button disabled={pending} key={option} onClick={() => respond(true, option)}>{option}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); respond(true, answer); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Write your answer…" /><button disabled={pending || !answer.trim()} className="primary">Send answer</button></form></> : <><pre>{String(approval.args.command || approval.args.patch || approval.args.path || approval.tool)}{typeof approval.args.oldText === "string" ? `\n− ${approval.args.oldText}\n+ ${approval.args.newText || ""}` : typeof approval.args.content === "string" ? `\n${approval.args.content}` : ""}</pre><details><summary>Full request</summary><pre>{JSON.stringify(approval.args, null, 2)}</pre></details><div className="approval-actions"><select value={remember} onChange={(event) => setRemember(event.target.value as typeof remember)} aria-label="Remember approval"><option value="">This request only</option><option value="project">Remember for project</option><option value="global">Remember globally</option></select><button disabled={pending} onClick={() => respond(false)}>Deny</button><button disabled={pending} className="primary" onClick={() => respond(true)}>Allow</button></div></>}</section>;
}

function NewTask({ cwd, models, close, create, onError, chooseFolder }: { cwd: string; models: ModelInfo[]; close: () => void; create: (cwd: string, branch: string, worktree: boolean, model: string, mode: PermissionMode) => Promise<void>; onError: (message: string) => void; chooseFolder: () => Promise<void> }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [pending, setPending] = useState(false);
  useEffect(() => { void api.request("project.branches", { cwd }).then(setBranches).catch(() => setBranches([])); void api.request("config.get", {}).then((config) => { setModel(modelValue(config.defaultModel)); setMode(config.permissionMode); }).catch((error: unknown) => onError(errorText(error))); }, [cwd]);
  return <Modal title="New task" close={close}><form className="modal-content form" onSubmit={(event) => { event.preventDefault(); setPending(true); void create(cwd, branch, worktree, model, mode).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); }}><label>Project<button type="button" className="folder-choice" onClick={() => void chooseFolder()}>{cwd || "Choose a folder"}<span>…</span></button></label><label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option value={modelValue(item)} key={modelValue(item)}>{item.provider} / {item.name}{item.authenticated ? "" : " · sign in required"}</option>)}</select></label><label>Permissions<select value={mode} onChange={(event) => setMode(event.target.value as PermissionMode)}>{modes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} />Use an isolated Git worktree</label>{worktree && <label>Starting branch<select value={branch} onChange={(event) => setBranch(event.target.value)}><option value="">Current branch</option>{branches.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}<footer><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary" disabled={!cwd || pending}>{pending ? "Creating…" : "Create task"}</button></footer></form></Modal>;
}

function Settings({ close, models, authEvent, onError, refresh }: { close: () => void; models: ModelInfo[]; authEvent: Record<string, unknown> | null; onError: (message: string) => void; refresh: () => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [raw, setRaw] = useState("");
  const [accounts, setAccounts] = useState<{ provider: string; type: string }[]>([]);
  const [provider, setProvider] = useState("deepseek");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState("");
  const activeLogin = useRef<string | undefined>(undefined);
  const loginGeneration = useRef(0);
  const [loggingIn, setLoggingIn] = useState(false);
  const act = (action: () => Promise<unknown>) => { setSaved(""); void action().catch((error: unknown) => onError(errorText(error))); };
  const load = async () => { const [next, auth] = await Promise.all([api.request("config.get", {}), api.request("auth.status", {})]); setConfig(next); setRaw(JSON.stringify(next, null, 2)); setAccounts(auth); };
  useEffect(() => { act(load); }, []);
  useEffect(() => { if (authEvent?.type === "complete") act(load); if (authEvent?.loginId === activeLogin.current && ["complete", "error", "cancelled"].includes(String(authEvent?.type))) { activeLogin.current = undefined; setLoggingIn(false); } }, [authEvent]);
  useEffect(() => () => { loginGeneration.current++; if (activeLogin.current) void api.request("auth.cancel", { loginId: activeLogin.current }).catch((error: unknown) => onError(errorText(error))); }, []);
  const startLogin = async () => {
    const generation = ++loginGeneration.current;
    setLoggingIn(true);
    try {
      const result = await api.request("auth.login", { provider: "openai" });
      if (generation !== loginGeneration.current) { await api.request("auth.cancel", { loginId: result.loginId }); return; }
      activeLogin.current = result.loginId;
    } catch (error) { if (generation === loginGeneration.current) setLoggingIn(false); throw error; }
  };
  const cancelLogin = async () => {
    loginGeneration.current++;
    const loginId = activeLogin.current;
    activeLogin.current = undefined; setLoggingIn(false);
    if (loginId) await api.request("auth.cancel", { loginId });
  };
  const save = async (next: Partial<Config>) => { const result = await api.request("config.set", next); setConfig(result); setRaw(JSON.stringify(result, null, 2)); setSaved("Saved"); await refresh(); };
  return <Modal title="Settings" close={close}><div className="modal-content settings">
    <AppearanceSettings />
    <h3>Accounts</h3>{accounts.map((account) => <div className="account-row" key={account.provider}><span><strong>{account.provider}</strong><small>{account.type}</small></span><button onClick={() => act(async () => { await api.request("auth.logout", { provider: account.provider }); await load(); await refresh(); })}>Sign out</button></div>)}
    <button className="primary" disabled={loggingIn} onClick={() => act(startLogin)}>Sign in with ChatGPT</button>{loggingIn && <button onClick={() => act(cancelLogin)}>Cancel sign-in</button>}
    {authEvent && <div className={`auth-progress ${authEvent.type === "error" ? "error-text" : ""}`}>{authEvent.type === "url" && <><button onClick={() => void api.openExternal(String(authEvent.url))}>Open sign-in page ↗</button><p>{String(authEvent.instructions || "Complete sign-in in your browser.")}</p></>}{authEvent.message ? <p>{String(authEvent.message)}</p> : null}{authEvent.type === "prompt" && <form onSubmit={(event) => { event.preventDefault(); act(() => api.request("auth.respond", { loginId: String(authEvent.loginId), value: code })); }}><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Authorization code or redirect URL" /><button>Continue</button></form>}{authEvent.type === "complete" && <p>Signed in successfully.</p>}</div>}
    <form className="api-key-form" onSubmit={(event) => { event.preventDefault(); act(async () => { await api.request("auth.key", { provider, apiKey: key }); setKey(""); await load(); await refresh(); }); }}><label>Provider<input list="provider-options" value={provider} onChange={(event) => setProvider(event.target.value)} /><datalist id="provider-options"><option value="deepseek" /><option value="anthropic" /><option value="openai" />{config && Object.keys(config.providers).map((name) => <option value={name} key={name} />)}</datalist></label><label>API key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label><button disabled={!provider || !key}>Save API key</button></form>
    {config && <><h3>Defaults</h3><label>Model<select value={modelValue(config.defaultModel)} onChange={(event) => act(() => save({ defaultModel: parseModel(event.target.value) }))}>{models.map((model) => <option value={modelValue(model)} key={modelValue(model)}>{model.provider} / {model.name}</option>)}</select></label><label>Permissions<select value={config.permissionMode} onChange={(event) => act(() => save({ permissionMode: event.target.value as PermissionMode }))}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={config.sandbox} onChange={(event) => act(() => save({ sandbox: event.target.checked }))} />Sandbox shell commands</label><details className="advanced-settings"><summary>Providers, MCP, hooks and permission rules</summary><p className="muted">Edit daemon configuration. Provider API keys are managed above.</p><textarea aria-label="Daemon configuration JSON" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} rows={20} /><button onClick={() => act(() => save(JSON.parse(raw) as Config))}>Save configuration</button></details></>}
    {saved && <p className="muted" role="status">{saved}</p>}
  </div></Modal>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
