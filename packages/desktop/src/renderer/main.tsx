import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionStore } from "@voidkagami/client/store";
import { isBusy } from "@voidkagami/protocol";
import type { Approval, Attachment, Config, ContextInfo, LiveEvent, ModelInfo, PermissionMode, Session, SessionEvent, TaskInfo } from "@voidkagami/protocol";
import type { DesktopBridge } from "../bridge.ts";
import "./style.css";

const api: DesktopBridge = window.voidkagami;
const store = new SessionStore();
const modes: { value: PermissionMode; label: string }[] = [{ value: "ask", label: "Ask before changes" }, { value: "accept_edits", label: "Accept edits" }, { value: "auto", label: "Fully automatic" }, { value: "plan", label: "Plan · read only" }];
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const modelValue = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const parseModel = (value: string) => ({ provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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
  const [selected, setSelected] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>(() => JSON.parse(localStorage.getItem("projects") || "[]") as string[]);
  const [project, setProject] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [queue, setQueue] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | "context" | "tasks" | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState("");
  const [diffEvent, setDiffEvent] = useState("");
  const [auth, setAuth] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [sending, setSending] = useState(false);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const followScroll = useRef(true);
  const state = selected ? store.get(selected) : undefined;
  const busy = state ? isBusy(state.session.status) : false;
  const act = (action: () => Promise<unknown>) => { setError(""); void action().catch((failure: unknown) => setError(errorText(failure))); };
  const update = (session: Session) => { store.updateSession(session); setSessions((items) => items.map((item) => item.id === session.id ? session : item)); };
  const refresh = useCallback(async () => {
    const [nextSessions, nextModels] = await Promise.all([api.request("session.list", {}), api.request("model.list", {})]);
    setSessions(nextSessions); setModels(nextModels);
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
        else if (event.type !== "session.created") void api.request("session.list", {}).then(setSessions).catch((failure: unknown) => setError(errorText(failure)));
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
  useEffect(() => {
    if (!selected) return;
    let canceled = false;
    void api.request("session.attach", { sessionId: selected }).then((view) => { if (!canceled) { store.attach(view); setProject(view.session.cwd); } }).catch((failure: unknown) => setError(errorText(failure)));
    followScroll.current = true; setSearch(""); setDiffEvent(""); setDraft(""); setAttachments([]);
    return () => { canceled = true; };
  }, [selected]);
  useEffect(() => { if (followScroll.current) end.current?.scrollIntoView({ behavior: state?.streaming ? "instant" : "smooth" }); }, [selected, state?.transcript.length, state?.streaming]);
  useEffect(() => {
    if (!diffOpen || !selected) return;
    void api.request("session.diff", { sessionId: selected, eventId: diffEvent || undefined }).then((result) => setDiff(result.diff)).catch((failure: unknown) => setError(errorText(failure)));
  }, [selected, diffOpen, diffEvent, state?.session.status]);
  useEffect(() => {
    const match = draft.match(/(?:^|\s)@([^\s]*)$/);
    if (!match || !state) { setFileSuggestions([]); return; }
    let canceled = false;
    const timer = setTimeout(() => { void api.request("project.files", { cwd: state.session.cwd, query: match[1] }).then((files) => { if (!canceled) setFileSuggestions(files.slice(0, 7)); }).catch(() => {}); }, 150);
    return () => { canceled = true; clearTimeout(timer); };
  }, [draft, state?.session.cwd]);

  async function openProject() { const cwd = await api.chooseFolder(); if (cwd) { setProjects((items) => [...new Set([...items, cwd])]); setProject(cwd); setModal("new"); } }
  async function createSession(cwd: string, branch: string, worktree: boolean, model: string, mode: PermissionMode) {
    const session = await api.request("session.create", { cwd, branch: branch || undefined, worktree, model: model ? parseModel(model) : undefined, permissionMode: mode });
    setSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]); setSelected(session.id); setModal(null);
  }
  async function send() {
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    try {
      const text = draft.trim();
      const refs: Attachment[] = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)].map((match) => ({ type: "file", path: match[1] || match[2]! }));
      if (busy) await api.request(queue ? "session.followUp" : "session.steer", { sessionId: selected, text, attachments: [...attachments, ...refs] });
      else await api.request("session.send", { sessionId: selected, text, attachments: [...attachments, ...refs] });
      setDraft(""); setAttachments([]); setQueue(false); followScroll.current = true; input.current?.focus();
    } finally { setSending(false); }
  }
  async function showContext() { if (selected) { const value = await api.request("session.context", { sessionId: selected }); setContext(value); store.setContext(selected, value); setModal("context"); } }
  async function showTasks() { if (selected) { setTasks(await api.request("session.tasks", { sessionId: selected })); setModal("tasks"); } }
  async function fork(eventId?: string) { if (selected) { const next = await api.request("session.fork", { sessionId: selected, eventId }); setSessions((items) => [next, ...items.filter((item) => item.id !== next.id)]); setSelected(next.id); } }
  async function rewind(eventId: string) { if (selected && window.confirm("Rewind this conversation and restore files to this point?")) { update(await api.request("session.rewind", { sessionId: selected, eventId, restoreFiles: true })); store.attach(await api.request("session.attach", { sessionId: selected })); } }
  const groups = useMemo(() => [...new Set([...projects, ...sessions.map((session) => session.cwd)])], [projects, sessions]);
  const filtered = sessions.filter((session) => `${session.title} ${session.cwd}`.toLowerCase().includes(filter.toLowerCase()));
  const transcript = state?.transcript.filter((item) => !search || item.text.toLowerCase().includes(search.toLowerCase())) || [];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="traffic-space" />
      <div className="sidebar-brand">VoidKagami</div>
      <button className="new-task" onClick={() => project ? setModal("new") : act(openProject)}><span>＋</span> New task</button>
      <input className="sidebar-search" placeholder="Search tasks" aria-label="Search tasks" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="project-list">
        <div className="section-label"><span>Projects</span><button className="icon-button" aria-label="Open project" title="Open project" onClick={() => act(openProject)}>＋</button></div>
        {groups.map((cwd) => <div className="project-group" key={cwd}>
          <button className="project-title" title={cwd} onClick={() => { setProject(cwd); setModal("new"); }}><span className="folder-icon">▱</span>{baseName(cwd)}<span className="project-plus">＋</span></button>
          {filtered.filter((session) => session.cwd === cwd).map((session) => <button key={session.id} className={`session-link ${selected === session.id ? "selected" : ""}`} onClick={() => setSelected(session.id)} title={session.title}><span className={`status-dot ${session.status}`} /><span>{session.title}</span>{session.parentSessionId && <span className="branch-badge">⑂</span>}</button>)}
        </div>)}
        {!groups.length && <p className="sidebar-empty">Open a project to start a task.</p>}
      </div>
      <div className="sidebar-bottom"><button onClick={() => setModal("settings")}>⚙ <span>Settings</span></button><span className={`connection ${connection === "connected" ? "" : "offline"}`} title={connection}>{connection === "connected" ? "Connected" : connection === "connecting" || connection === "reconnecting" ? connection : "Disconnected"}</span></div>
    </aside>
    <main className="main-column">
      <header className="topbar"><div className="title-path">{state ? <><span>{baseName(state.session.cwd)}</span><span className="separator">/</span><button className="session-title-button" onClick={() => { const title = window.prompt("Session title", state.session.title); if (title) act(async () => update(await api.request("session.rename", { sessionId: state.session.id, title }))); }}>{state.session.title}</button>{state.session.worktree && <span className="tag">⑂ Worktree</span>}</> : <span>New task</span>}</div>{state && <div className="topbar-actions"><button onClick={() => act(showTasks)} title="Background tasks">Tasks</button><button onClick={() => act(() => fork())} disabled={busy}>Fork</button><button className={diffOpen ? "active" : ""} onClick={() => setDiffOpen(!diffOpen)}>Changes {diffOpen ? "›" : "‹"}</button></div>}</header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
      {state ? <>
        <div className="conversation-toolbar"><span className={`status-dot ${state.session.status}`} /><span>{state.session.status.replaceAll("_", " ")}</span><input aria-label="Search conversation" placeholder="Find in conversation" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <div className="conversation" ref={scroll} onScroll={() => { if (scroll.current) followScroll.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
          <div className="messages">
            {!transcript.length && !search && <div className="conversation-start"><h1>What would you like to work on?</h1><p>{state.session.cwd}</p></div>}
            {search && !transcript.length && <p className="muted">No matching messages.</p>}
            {transcript.map((item) => <article className={`message ${item.role}`} key={item.id}>
              {item.role === "tool" ? <details><summary><span className={item.error ? "error-text" : ""}>{item.error ? "×" : "◇"} {item.tool}</span><span className="tool-preview">{item.text.split("\n")[0]?.slice(0, 90)}</span></summary><pre>{item.text}</pre></details> : <><div className="message-label">{item.role === "user" ? "You" : item.role === "assistant" ? "VoidKagami" : "Session"}</div><div className="markdown"><Markdown text={item.text} /></div>{(item.event.type === "assistant.message" || item.event.type === "user.message") && <div className="message-actions"><button onClick={() => act(() => navigator.clipboard.writeText(item.text))}>Copy</button><button disabled={busy} onClick={() => act(() => fork(item.id))}>Fork here</button><button disabled={busy} onClick={() => act(() => rewind(item.id))}>Rewind</button><button onClick={() => { setDiffEvent(item.id); setDiffOpen(true); }}>Changes</button></div>}</>}
            </article>)}
            {state.streaming && !search && <article className="message assistant streaming"><div className="message-label">VoidKagami <span className="thinking-dot" /></div><div className="markdown"><Markdown text={state.streaming} /></div></article>}
            {state.progress && <div className="tool-progress">{state.progress.slice(-1200)}</div>}
            {!state.streaming && busy && !state.approvals.length && <div className="working"><span className="thinking-dot" />Working…</div>}
            <div ref={end} />
          </div>
        </div>
        {state.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onError={setError} />)}
        <form className="composer-area" onSubmit={(event) => { event.preventDefault(); act(send); }}>
          <div className="composer">
            {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <span className="attachment" key={`${attachment.path}-${index}`}>{attachment.type === "image" ? "▧" : "▤"} {baseName(attachment.path)}<button type="button" aria-label={`Remove ${baseName(attachment.path)}`} onClick={() => setAttachments((items) => items.filter((_, at) => at !== index))}>×</button></span>)}</div>}
            <textarea ref={input} value={draft} placeholder={busy ? "Steer this task, or queue a follow-up…" : "Ask anything, @ to reference a file…"} rows={3} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); act(send); } if (event.key === "Escape" && busy && selected) act(() => api.request("session.abort", { sessionId: selected })); }} />
            {fileSuggestions.length > 0 && <div className="file-suggestions">{fileSuggestions.map((path) => <button type="button" key={path} onClick={() => { setDraft((text) => text.replace(/@[^\s]*$/, `@"${path}" `)); setFileSuggestions([]); input.current?.focus(); }}>{path}</button>)}</div>}
            <div className="composer-actions"><button type="button" className="icon-button" title="Attach files or images" onClick={() => act(async () => { const paths = await api.chooseAttachments(); setAttachments((items) => [...items, ...paths.map((path): Attachment => ({ type: /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : "file", path }))]); })}>＋</button><select aria-label="Model" value={modelValue(state.session.model)} disabled={busy} onChange={(event) => act(async () => update(await api.request("model.select", { sessionId: state.session.id, model: parseModel(event.target.value) })))}>{models.map((model) => <option value={modelValue(model)} key={modelValue(model)}>{model.name}{model.authenticated ? "" : " · sign in"}</option>)}</select><div className="composer-spacer" />{busy && <label className="queue-option"><input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />Queue</label>}{busy && <button type="button" className="stop-button" title="Stop task" onClick={() => act(() => api.request("session.abort", { sessionId: state.session.id }))}>■</button>}<button className="send-button" disabled={!draft.trim() || sending} title={busy ? queue ? "Queue message" : "Steer task" : "Send message"} type="submit">↑</button></div>
          </div>
          <div className="composer-footer"><select aria-label="Permission mode" value={state.session.permissionMode} onChange={(event) => act(async () => update(await api.request("session.mode", { sessionId: state.session.id, mode: event.target.value as PermissionMode })))}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}</select><button type="button" onClick={() => act(showContext)}>{state.context ? `${Math.round(100 * state.context.tokens / state.context.limit)}% context · ` : "Context · "}${state.cost.toFixed(4)}</button></div>
        </form>
      </> : <div className="welcome"><h1>What would you like to work on?</h1><p>Choose a project to start a task.</p><button className="primary" onClick={() => act(openProject)}>Open project</button>{groups.length > 0 && <select aria-label="Existing project" value="" onChange={(event) => { setProject(event.target.value); setModal("new"); }}><option value="" disabled>Or choose a recent project</option>{groups.map((cwd) => <option value={cwd} key={cwd}>{baseName(cwd)}</option>)}</select>}</div>}
    </main>
    {diffOpen && state && <aside className="diff-panel"><header><h3>Changes</h3><button className="icon-button" onClick={() => setDiffOpen(false)} aria-label="Close changes">×</button></header><select aria-label="Changes at turn" value={diffEvent} onChange={(event) => setDiffEvent(event.target.value)}><option value="">Current changes</option>{state.transcript.filter((item) => item.event.type === "user.message" || item.event.type === "assistant.message").map((item) => <option value={item.id} key={item.id}>{item.role}: {item.text.slice(0, 60)}</option>)}</select>{diff ? <pre className="diff-code">{diff.split("\n").map((line, index) => <div className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") || line.startsWith("diff") ? "diff-heading" : ""} key={index}>{line || " "}</div>)}</pre> : <div className="empty-diff">No file changes at this point.</div>}</aside>}
    {modal === "new" && <NewTask cwd={project} models={models} close={() => setModal(null)} create={createSession} onError={setError} chooseFolder={async () => { const path = await api.chooseFolder(); if (path) { setProject(path); setProjects((items) => [...new Set([...items, path])]); } }} />}
    {modal === "settings" && <Settings close={() => setModal(null)} models={models} authEvent={auth} onError={setError} refresh={refresh} />}
    {modal === "context" && context && <Modal title="Context" close={() => setModal(null)}><div className="modal-content"><div className="context-stats"><strong>~{context.tokens.toLocaleString()} <span>/ {context.limit.toLocaleString()} tokens</span></strong><span>{context.messageCount} messages · ${context.cost.toFixed(4)}</span></div><progress max={context.limit} value={context.tokens} /><p className="muted">Estimated context usage</p><div className="context-breakdown">{context.components.map((part) => <div key={part.name}><span>{part.name}</span><span>~{part.tokens.toLocaleString()} tokens</span></div>)}</div><h3>System instructions</h3><pre className="context-prompt">{context.systemPrompt}</pre><h3>Available skills</h3>{context.skills.map((skill) => <div className="skill-item" key={skill.path}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}<button disabled={busy} onClick={() => act(async () => { await api.request("session.compact", { sessionId: selected! }); await showContext(); })}>Compact context</button></div></Modal>}
    {modal === "tasks" && <Modal title="Background tasks" close={() => setModal(null)}><div className="modal-content">{!tasks.length && <p className="muted">No background tasks in this session.</p>}{tasks.map((task) => <div className="task-card" key={task.id}><div><strong>{task.command}</strong><span className="tag">{task.status}</span></div><pre>{task.output}</pre>{task.status === "running" && <button onClick={() => act(async () => { await api.request("task.stop", { sessionId: selected!, taskId: task.id }); await showTasks(); })}>Stop process</button>}</div>)}</div></Modal>}
  </div>;
}

function ApprovalCard({ approval, onError }: { approval: Approval; onError: (message: string) => void }) {
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState<"" | "project" | "global">("");
  const [pending, setPending] = useState(false);
  const respond = (allow: boolean, value?: string) => { setPending(true); void api.request("approval.respond", { approvalId: approval.id, allow, answer: value, remember: remember || undefined }).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); };
  return <section className="approval-card"><h3>{approval.question || `Allow ${approval.tool}?`}</h3>{approval.question ? <><div className="approval-options">{approval.options?.map((option) => <button disabled={pending} key={option} onClick={() => respond(true, option)}>{option}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); respond(true, answer); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Write your answer…" /><button disabled={pending || !answer.trim()} className="primary">Send answer</button></form></> : <><pre>{JSON.stringify(approval.args, null, 2)}</pre><div className="approval-actions"><select value={remember} onChange={(event) => setRemember(event.target.value as typeof remember)} aria-label="Remember approval"><option value="">This request only</option><option value="project">Remember for project</option><option value="global">Remember globally</option></select><button disabled={pending} onClick={() => respond(false)}>Deny</button><button disabled={pending} className="primary" onClick={() => respond(true)}>Allow</button></div></>}</section>;
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
  const act = (action: () => Promise<unknown>) => { setSaved(""); void action().catch((error: unknown) => onError(errorText(error))); };
  const load = async () => { const [next, auth] = await Promise.all([api.request("config.get", {}), api.request("auth.status", {})]); setConfig(next); setRaw(JSON.stringify(next, null, 2)); setAccounts(auth); };
  useEffect(() => { act(load); }, []);
  useEffect(() => { if (authEvent?.type === "complete") act(load); }, [authEvent]);
  const save = async (next: Partial<Config>) => { const result = await api.request("config.set", next); setConfig(result); setRaw(JSON.stringify(result, null, 2)); setSaved("Saved"); await refresh(); };
  return <Modal title="Settings" close={close}><div className="modal-content settings">
    <h3>Accounts</h3>{accounts.map((account) => <div className="account-row" key={account.provider}><span><strong>{account.provider}</strong><small>{account.type}</small></span><button onClick={() => act(async () => { await api.request("auth.logout", { provider: account.provider }); await load(); await refresh(); })}>Sign out</button></div>)}
    <button className="primary" onClick={() => act(() => api.request("auth.login", { provider: "openai" }))}>Sign in with ChatGPT</button>
    {authEvent && <div className={`auth-progress ${authEvent.type === "error" ? "error-text" : ""}`}>{authEvent.type === "url" && <><button onClick={() => void api.openExternal(String(authEvent.url))}>Open sign-in page ↗</button><p>{String(authEvent.instructions || "Complete sign-in in your browser.")}</p></>}{authEvent.message ? <p>{String(authEvent.message)}</p> : null}{authEvent.type === "prompt" && <form onSubmit={(event) => { event.preventDefault(); act(() => api.request("auth.respond", { loginId: String(authEvent.loginId), value: code })); }}><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Authorization code or redirect URL" /><button>Continue</button></form>}{authEvent.type === "complete" && <p>Signed in successfully.</p>}</div>}
    <form className="api-key-form" onSubmit={(event) => { event.preventDefault(); act(async () => { await api.request("auth.key", { provider, apiKey: key }); setKey(""); await load(); await refresh(); }); }}><label>Provider<input list="provider-options" value={provider} onChange={(event) => setProvider(event.target.value)} /><datalist id="provider-options"><option value="deepseek" /><option value="anthropic" /><option value="openai" />{config && Object.keys(config.providers).map((name) => <option value={name} key={name} />)}</datalist></label><label>API key<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label><button disabled={!provider || !key}>Save API key</button></form>
    {config && <><h3>Defaults</h3><label>Model<select value={modelValue(config.defaultModel)} onChange={(event) => act(() => save({ defaultModel: parseModel(event.target.value) }))}>{models.map((model) => <option value={modelValue(model)} key={modelValue(model)}>{model.provider} / {model.name}</option>)}</select></label><label>Permissions<select value={config.permissionMode} onChange={(event) => act(() => save({ permissionMode: event.target.value as PermissionMode }))}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{mode.label}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={config.sandbox} onChange={(event) => act(() => save({ sandbox: event.target.checked }))} />Sandbox shell commands</label><details className="advanced-settings"><summary>Providers, MCP, hooks and permission rules</summary><p className="muted">Edit daemon configuration. Provider API keys are managed above.</p><textarea aria-label="Daemon configuration JSON" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} rows={20} /><button onClick={() => act(() => save(JSON.parse(raw) as Config))}>Save configuration</button></details></>}
    {saved && <p className="muted" role="status">{saved}</p>}
  </div></Modal>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
