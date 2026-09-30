import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SessionStore } from "@voidkagami/client/store";
import { isBusy } from "@voidkagami/protocol";
import type { Approval, Attachment, ContextInfo, LiveEvent, ModelInfo, ModelSelection, PermissionMode, Session, SessionEvent, ThinkingLevel } from "@voidkagami/protocol";
import type { DesktopBridge } from "../bridge.ts";
import "./style.css";
import { DiffPanel } from "./diff.tsx";
import { initializeAppearance } from "./appearance.tsx";
import { SettingsPage } from "./settings.tsx";
import { useI18n, initializeLanguage } from "./i18n.ts";
import { Sidebar, ResizeHandle, baseName, sessionProject } from "./sidebar.tsx";
import { Icon } from "./icons.tsx";
import { TaskPanel, WorkspacePanel, statusLabel } from "./session-panels.tsx";

const api: DesktopBridge = window.voidkagami;
const store = new SessionStore();
const modes: { value: PermissionMode; label: string; zh: string }[] = [{ value: "ask", label: "Ask before changes", zh: "修改前询问" }, { value: "accept_edits", label: "Accept edits", zh: "允许编辑" }, { value: "auto", label: "Fully automatic", zh: "全自动" }, { value: "plan", label: "Plan · read only", zh: "规划 · 只读" }];
const modelValue = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
type ComposerDraft = { text: string; attachments: Attachment[] };
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
const commandDefinitions = [
  { name: "new", description: "Start a new chat", zh: "新建聊天" }, { name: "model", description: "Choose a model", zh: "选择模型" },
  { name: "context", description: "Inspect context usage", zh: "查看上下文用量" }, { name: "compact", description: "Summarize this conversation", zh: "压缩聊天上下文" },
  { name: "diff", description: "Review file changes", zh: "审查文件变更" }, { name: "tasks", description: "Inspect background tasks", zh: "查看后台任务" },
  { name: "fork", description: "Branch this conversation", zh: "分支聊天" }, { name: "rename", description: "Rename this chat", zh: "重命名聊天" },
  { name: "queue", description: "Queue a follow-up message", zh: "排队发送后续消息" }, { name: "settings", description: "Accounts and configuration", zh: "账户和设置" },
  { name: "login", description: "Connect a provider", zh: "登录模型服务" }, { name: "help", description: "Commands and shortcuts", zh: "命令和快捷键" },
];
function effortLabel(level: ThinkingLevel, t: (en: string, zh: string) => string) {
  const names: Record<ThinkingLevel, [string, string]> = { off: ["Default", "默认"], minimal: ["Minimal", "最低"], low: ["Low", "低"], medium: ["Medium", "中"], high: ["High", "高"], xhigh: ["Extra high", "极高"], max: ["Maximum", "最高"] };
  return t(...names[level]);
}
const pathAttachment = (path: string): Attachment => ({ type: /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : "file", path });
function readDrafts(): Record<string, ComposerDraft> {
  try { return JSON.parse(localStorage.getItem("drafts") || "{}"); } catch { return {}; }
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void api.openExternal(href); }}>{children}</a> }}>{text}</ReactMarkdown>;
}

function Modal({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const { t } = useI18n();
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [close]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label={t("Close", "关闭")}>×</button></header>{children}</section></div>;
}

function App() {
  const { t } = useI18n();
  const builtInCommands = commandDefinitions.map((command) => ({ ...command, description: t(command.description, command.zh) }));
  useSyncExternalStore(store.subscribe, () => store.version);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("selectedSession"));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "accounts">("general");
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem("sidebarWidth")) || 260);
  const [panelWidth, setPanelWidth] = useState(() => Number(localStorage.getItem("panelWidth")) || 410);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
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
  const [modal, setModal] = useState<"context" | "rename" | "fork" | "rewind" | "model" | "help" | null>(null);
  const [actionEvent, setActionEvent] = useState<string | undefined>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"review" | "tasks" | "workspace">("review");
  const [diffEvent, setDiffEvent] = useState<string | undefined>();
  const [auth, setAuth] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);
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
  const attached = selected ? store.get(selected) : undefined;
  const state = attached?.session.archived ? undefined : attached;
  const busy = state ? isBusy(state.session.status) : false;
  const panelVisible = !settingsOpen && panelOpen && Boolean(state);
  const sidebarMaximum = Math.min(440, windowWidth - 340 - (panelVisible ? 282 : 1));
  const displayedSidebarWidth = Math.min(sidebarWidth, sidebarMaximum);
  const panelMaximum = Math.min(780, windowWidth - displayedSidebarWidth - 342);
  const displayedPanelWidth = Math.min(panelWidth, panelMaximum);
  const act = (action: () => Promise<unknown>) => { setError(""); void action().catch((failure: unknown) => setError(errorText(failure))); };
  const update = (session: Session) => { store.updateSession(session); setSessions((items) => session.archived ? items.filter((item) => item.id !== session.id) : items.some((item) => item.id === session.id) ? items.map((item) => item.id === session.id ? session : item) : [session, ...items]); };
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      (async () => {
        const nextSessions = await api.request("session.list", {});
        setSessions(nextSessions);
        for (const session of nextSessions.filter((item) => isBusy(item.status))) if (!store.get(session.id)) store.attach(await api.request("session.attach", { sessionId: session.id }));
      })(),
      (async () => {
        const nextModels = await api.request("model.list", {});
        setModels(nextModels.filter((model) => model.authenticated));
      })(),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : []);
    if (failures.length) throw new Error(failures.join("\n"));
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
        if (next) update(next);
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

  useEffect(() => { void initializeLanguage().catch((failure: unknown) => setError(errorText(failure))); }, []);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { localStorage.setItem("sidebarWidth", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem("panelWidth", String(panelWidth)); }, [panelWidth]);
  useEffect(() => { localStorage.setItem("drafts", JSON.stringify(drafts)); }, [drafts]);
  useEffect(() => { if (selected) localStorage.setItem("selectedSession", selected); else localStorage.removeItem("selectedSession"); }, [selected]);
  useEffect(() => {
    if (attached?.session.archived) setSelected((current) => current === attached.session.id ? null : current);
  }, [attached?.session.id, attached?.session.archived]);
  useEffect(() => {
    if (!selected) return;
    let canceled = false;
    void api.request("session.attach", { sessionId: selected }).then((view) => { if (!canceled) { store.attach(view); if (view.session.archived) setSelected(null); } }).catch((failure: unknown) => setError(errorText(failure)));
    followScroll.current = true; setSearch(""); setDiffEvent(undefined); setQueue(false); setFileSuggestions([]); setMentionDismissed(false); setCursor(0);
    return () => { canceled = true; };
  }, [selected]);
  useEffect(() => { if (followScroll.current) end.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth" }); }, [selected, state?.transcriptRevision, state?.liveRevision]);
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

  function selectSession(id: string) { setSelected(id); setSettingsOpen(false); }
  async function createSession(cwd?: string) {
    const session = await api.request("session.create", cwd ? { cwd } : {});
    update(session); selectSession(session.id); setModal(null);
  }
  async function archiveSession(session: Session) {
    update(await api.request("session.archive", { sessionId: session.id, archived: true }));
    setSelected((current) => current === session.id ? sessions.find((item) => item.id !== session.id && !item.archived)?.id || null : current);
  }
  function openSettings(section: "general" | "accounts" = "general") { setSettingsSection(section); setSettingsOpen(true); setModal(null); }
  function openReview(eventId?: string) { setDiffEvent(eventId); setPanelTab("review"); setPanelOpen(true); }
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      if (event.key.toLowerCase() === "n") { event.preventDefault(); act(() => createSession()); }
      if (event.key === ",") { event.preventDefault(); openSettings(); }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);
  async function send() {
    if (!selected || (!draft.trim() && !attachments.length) || sending || importing) return;
    setSending(true);
    try {
      let text = draft.trim();
      const [enteredCommand, ...parts] = text.slice(1).split(/\s+/);
      const command = enteredCommand === "clear" ? "new" : enteredCommand;
      if (text.startsWith("/") && builtInCommands.some((item) => item.name === command)) {
        if (command === "queue") { text = parts.join(" "); if (!text && !attachments.length) throw new Error(t("Usage: /queue <message>", "用法：/queue <消息>")); }
        else {
          if (command === "new") await createSession();
          if (command === "model") setModal("model");
          if (command === "context") await showContext();
          if (command === "compact") await api.request("session.compact", { sessionId: selected });
          if (command === "diff") openReview();
          if (command === "tasks") await showTasks();
          if (command === "fork") { setActionEvent(undefined); setModal("fork"); }
          if (command === "rename") { if (parts.length) update(await api.request("session.rename", { sessionId: selected, title: parts.join(" ") })); else setModal("rename"); }
          if (command === "settings" || command === "login") openSettings(command === "login" ? "accounts" : "general");
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
  function showTasks() { setPanelTab("tasks"); setPanelOpen(true); }
  async function fork(worktree: boolean) { if (selected) { const next = await api.request("session.fork", { sessionId: selected, eventId: actionEvent, worktree }); setSessions((items) => [next, ...items.filter((item) => item.id !== next.id)]); selectSession(next.id); setModal(null); } }
  async function rewind(restoreFiles: boolean) { if (selected && actionEvent) { update(await api.request("session.rewind", { sessionId: selected, eventId: actionEvent, restoreFiles })); store.attach(await api.request("session.attach", { sessionId: selected })); setModal(null); } }
  const transcript = state?.transcript.filter((item) => !search || item.text.toLowerCase().includes(search.toLowerCase())) || [];

  return <div className="app-shell" style={{ "--sidebar-width": `${displayedSidebarWidth}px`, "--panel-width": `${displayedPanelWidth}px` } as React.CSSProperties}>
    <Sidebar sessions={sessions} selected={selected} settingsOpen={settingsOpen} connection={connection} onSelect={selectSession} onNew={(cwd) => act(() => createSession(cwd))} onArchive={(session) => act(() => archiveSession(session))} onSettings={() => openSettings()} chooseProject={async () => { try { return await api.chooseFolder(); } catch (failure) { setError(errorText(failure)); return null; } }} />
    <ResizeHandle value={displayedSidebarWidth} onChange={setSidebarWidth} min={200} max={sidebarMaximum} side="left" label={t("Resize sidebar", "调整侧栏宽度")} />
    <main className="main-column">
      {!settingsOpen && <header className="topbar"><div className="title-path">{state ? <>{sessionProject(state.session) && <><button className="workspace-link" title={state.session.cwd} onClick={() => { setPanelTab("workspace"); setPanelOpen(true); }}>{baseName(sessionProject(state.session)!)}</button><span className="separator">/</span></>}<button className="session-title-button" title={t("Rename chat", "重命名聊天")} onClick={() => setModal("rename")}>{state.session.title === "New session" ? t("New chat", "新聊天") : state.session.title}</button>{state.session.worktree && <span className="tag">⑂ Worktree</span>}</> : <span>VoidKagami</span>}</div>{state && <div className="topbar-actions"><button className="icon-button" disabled={busy} title={t("Archive chat", "归档聊天")} aria-label={t("Archive chat", "归档聊天")} onClick={() => act(() => archiveSession(state.session))}><Icon name="archive" /></button><button className={panelOpen && panelTab === "review" ? "active" : ""} title={t("Review changes", "审查变更")} onClick={() => { if (panelOpen && panelTab === "review") setPanelOpen(false); else openReview(); }}><Icon name="review" /><span>{t("Review", "审查")}</span></button><button className={`icon-button ${panelOpen ? "active" : ""}`} title={t("Toggle side panel", "切换侧边标签页")} aria-label={t("Toggle side panel", "切换侧边标签页")} aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}><Icon name="panel" /></button></div>}</header>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={t("Dismiss error", "关闭错误提示")}>×</button></div>}
      {settingsOpen ? <SettingsPage close={() => setSettingsOpen(false)} onRestored={(session) => update(session)} onConfigChanged={refresh} auth={auth} initialSection={settingsSection} /> : state ? <>
        <div className="conversation-toolbar"><span className={`status-dot ${state.session.status}`} /><span>{statusLabel(state.session.status, t)}</span><input aria-label={t("Search conversation", "搜索聊天内容")} placeholder={t("Find in conversation", "在聊天中查找")} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <div className="conversation" ref={scroll} onScroll={() => { if (scroll.current) followScroll.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100; }}>
          <div className="messages">
            {!transcript.length && !search && <div className="conversation-start"><h1>{t("What would you like to work on?", "你想做些什么？")}</h1><p>{state.session.cwd}</p></div>}
            {search && !transcript.length && <p className="muted">{t("No matching messages.", "没有匹配的消息。")}</p>}
            {transcript.map((item) => <article className={`message ${item.role}`} key={item.id}>
              {item.role === "tool" ? <details><summary><span className={`tool-name ${item.error ? "error-text" : ""}`} title={item.tool}>{item.toolStatus === "running" ? "◌" : item.error ? "×" : "◇"} {item.tool}</span><span className="tool-preview" title={t("Expand command and output", "展开命令和输出")}>{String(item.toolArgs?.command || item.toolArgs?.path || item.toolArgs?.query || item.text).replace(/\s+/g, " ").slice(0, 110)}</span><span className="tool-status">{statusLabel(item.toolStatus || "completed", t)} · {t("expand", "展开")}</span></summary>{item.toolArgs && <pre className="tool-input" aria-label={t("Tool command and arguments", "工具命令和参数")}>{JSON.stringify(item.toolArgs, null, 2)}</pre>}<pre aria-label={t("Tool output", "工具输出")}>{item.text}</pre></details> : <><div className="message-label">{item.role === "user" ? t("You", "你") : item.role === "assistant" ? "VoidKagami" : t("Session", "会话")}{item.delivery === "queued" && <span className="tag">{item.inputKind === "followUp" ? t("Queued follow-up", "已排队的后续消息") : t("Queued steering", "已排队的引导消息")}</span>}</div>{item.thinking && <details className="thinking"><summary>{t("Thinking", "思考过程")}</summary><div className="markdown"><Markdown text={item.thinking} /></div></details>}<div className="markdown"><Markdown text={item.text} /></div>{item.attachments?.length ? <div className="message-attachments">{item.attachments.map((attachment, index) => <span className="attachment" key={index}>{attachment.type === "image" ? "▧" : "▤"} {baseName(attachment.path)}</span>)}</div> : null}{(item.event.type === "assistant.message" || item.event.type === "user.message") && <div className="message-actions"><button onClick={() => act(() => navigator.clipboard.writeText(item.text))}>{t("Copy", "复制")}</button><button disabled={busy} onClick={() => { setActionEvent(item.id); setModal("fork"); }}>{t("Fork here", "从此处分支")}</button><button disabled={busy} onClick={() => { setActionEvent(item.id); setModal("rewind"); }}>{t("Rewind", "回退")}</button><button onClick={() => { openReview(item.id); }}>{t("Changes", "变更")}</button></div>}</>}
            </article>)}
            {(state.streaming || state.thinking) && !search && <article className="message assistant streaming"><div className="message-label">VoidKagami <span className="thinking-dot" /></div>{state.thinking && <details className="thinking"><summary>{t("Thinking…", "思考中…")}</summary><div className="markdown"><Markdown text={state.thinking} /></div></details>}{state.streaming && <div className="markdown"><Markdown text={state.streaming} /></div>}</article>}
            {state.progress && <details className="tool-progress"><summary><span>{t("Running tool", "正在运行工具")}</span><span className="tool-preview">{state.progress.replace(/\s+/g, " ").slice(-110)}</span><span className="tool-status">{t("expand", "展开")}</span></summary><pre>{state.progress}</pre></details>}
            {!state.streaming && busy && !state.approvals.length && <div className="working"><span className="thinking-dot" />{t("Working…", "处理中…")}</div>}
            <div ref={end} />
          </div>
        </div>
        {state.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onError={setError} />)}
        <form className="composer-area" onSubmit={(event) => { event.preventDefault(); act(send); }}>
          <div className={`composer ${dragging ? "dragging" : ""}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); const files = [...event.dataTransfer.files]; if (files.length) act(() => importFiles(files)); }}>
            {importing && <div className="picker-hint" role="status">{t("Adding attachments…", "正在添加附件…")}</div>}
            {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <span className="attachment" key={`${attachment.path}-${index}`}>{attachment.type === "image" ? "▧" : "▤"} {baseName(attachment.path)}<button type="button" aria-label={`${t("Remove", "移除")} ${baseName(attachment.path)}`} onClick={() => setAttachments((items) => items.filter((_, at) => at !== index))}>×</button></span>)}</div>}
            <textarea ref={input} value={draft} placeholder={busy ? t("Steer this task, or queue a follow-up…", "补充指令，或排队发送后续消息…") : t("Ask anything, @ to reference a file…", "输入消息，@ 引用文件…")} rows={3} aria-label={t("Message", "消息")} aria-controls={fileSuggestions.length ? "file-suggestions" : undefined} aria-activedescendant={fileSuggestions.length ? `file-suggestion-${fileIndex}` : undefined} onChange={(event) => { setDraft(event.target.value); setCursor(event.target.selectionStart); setFileIndex(0); setMentionDismissed(false); }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); act(() => importFiles(files)); } }} onKeyDown={(event) => {
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
            {commandSuggestions.length > 0 && <div className="file-suggestions" role="listbox" aria-label={t("Commands", "命令")}>{commandSuggestions.map((command, index) => <button type="button" role="option" aria-selected={index === fileIndex} className={index === fileIndex ? "selected" : ""} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraft(`/${command.name} `); input.current?.focus(); }}>/{command.name}<span className="command-description">{command.description}</span></button>)}<div className="picker-hint">{t("↑↓ navigate · Enter or Tab insert · Esc dismiss", "↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭")}</div></div>}
            {fileSuggestions.length > 0 && <div className="file-suggestions" id="file-suggestions" role="listbox" aria-label={t("Project files", "项目文件")}>{fileSuggestions.map((path, index) => <button type="button" id={`file-suggestion-${index}`} role="option" aria-selected={index === fileIndex} className={index === fileIndex ? "selected" : ""} key={path} onMouseDown={(event) => event.preventDefault()} onClick={() => selectFile(path)}>{path}</button>)}<div className="picker-hint">{t("↑↓ navigate · Enter or Tab insert · Esc dismiss", "↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭")}</div></div>}
            <div className="composer-actions"><button type="button" className="icon-button" title={t("Attach files or images", "添加文件或图片")} onClick={() => act(async () => { const paths = await api.chooseAttachments(); setAttachments((items) => [...items, ...paths.map(pathAttachment)]); })}>＋</button><button type="button" className="model-button" aria-label={t("Choose model", "选择模型")} disabled={busy} onClick={() => setModal("model")}>{models.find((model) => modelValue(model) === modelValue(state.session.model))?.name || state.session.model.id}<span>⌄</span></button>{(models.find((model) => modelValue(model) === modelValue(state.session.model))?.thinkingLevels?.length || 0) > 1 && <select aria-label={t("Thinking effort", "思考强度")} value={state.session.model.thinkingLevel || models.find((model) => modelValue(model) === modelValue(state.session.model))?.thinkingLevel || models.find((model) => modelValue(model) === modelValue(state.session.model))?.thinkingLevels[0] || "off"} disabled={busy} onChange={(event) => act(async () => update(await api.request("model.select", { sessionId: state.session.id, model: { ...state.session.model, thinkingLevel: event.target.value as ThinkingLevel } })))}>{models.find((model) => modelValue(model) === modelValue(state.session.model))!.thinkingLevels.map((level) => <option value={level} key={level}>{effortLabel(level, t)}</option>)}</select>}<div className="composer-spacer" />{busy && <label className="queue-option"><input type="checkbox" checked={queue} onChange={(event) => setQueue(event.target.checked)} />{t("Queue", "排队")}</label>}{busy && <button type="button" className="stop-button" title={t("Stop task", "停止运行")} onClick={() => act(() => api.request("session.abort", { sessionId: state.session.id }))}>■</button>}<button className="send-button" disabled={(!draft.trim() && !attachments.length) || sending || importing} title={busy ? queue ? t("Queue message", "排队发送") : t("Steer task", "补充指令") : t("Send message", "发送消息")} type="submit">↑</button></div>
          </div>
          <div className="composer-footer"><select aria-label={t("Permission mode", "权限模式")} value={state.session.permissionMode} onChange={(event) => act(async () => update(await api.request("session.mode", { sessionId: state.session.id, mode: event.target.value as PermissionMode })))}>{modes.map((mode) => <option value={mode.value} key={mode.value}>{t(mode.label, mode.zh)}</option>)}</select><button type="button" onClick={() => act(showContext)}>{state.context ? `${Math.round(100 * state.context.tokens / state.context.limit)}% ${t("context", "上下文")} · ` : `${t("Context", "上下文")} · `}${state.cost.toFixed(4)}</button></div>
        </form>
      </> : <div className="welcome"><h1>{t("What would you like to work on?", "你想做些什么？")}</h1><button className="primary" onClick={() => act(() => createSession())}>{t("New chat", "新聊天")}</button></div>}
    </main>
    {panelVisible && state && <><ResizeHandle value={displayedPanelWidth} onChange={setPanelWidth} min={280} max={panelMaximum} side="right" label={t("Resize side panel", "调整侧边面板宽度")} /><aside className="side-panel"><div className="side-panel-tabs" role="tablist" aria-label={t("Side panel", "侧边标签页")}>{(["review", "tasks", "workspace"] as const).map((tab) => <button key={tab} role="tab" aria-selected={panelTab === tab} className={panelTab === tab ? "active" : ""} onClick={() => setPanelTab(tab)}>{tab === "review" ? t("Review", "审查") : tab === "tasks" ? t("Tasks", "任务") : t("Workspace", "工作区")}</button>)}<button className="small-icon panel-close" aria-label={t("Close side panel", "关闭侧边面板")} onClick={() => setPanelOpen(false)}><Icon name="close" /></button></div>{panelTab === "review" ? <DiffPanel sessionId={state.session.id} eventId={diffEvent} revision={`${state.session.cwd}:${state.events.findLast((event) => ["turn.ended", "head.moved", "workspace.changed"].includes(event.type))?.id || ""}`} /> : panelTab === "tasks" ? <TaskPanel session={state.session} childrenSessions={sessions.filter((session) => session.parentSessionId === selected && !session.archived)} onSelect={selectSession} onError={setError} /> : <WorkspacePanel key={state.session.id} session={state.session} busy={busy} onUpdate={update} onError={setError} onFork={() => { setActionEvent(undefined); setModal("fork"); }} />}</aside></>}
    {modal === "help" && <Modal title={t("Commands and shortcuts", "命令和快捷键")} close={() => setModal(null)}><div className="modal-content"><p className="muted">{t("Enter sends · Shift+Enter adds a line · Esc stops a running task · @ adds project files · Paste or drop files and images", "Enter 发送 · Shift+Enter 换行 · Esc 停止运行 · @ 添加项目文件 · 支持粘贴或拖入文件和图片")}</p>{[...builtInCommands, ...customCommands].map((command) => <div className="command-help" key={command.name}><code>/{command.name}</code><span>{command.description}</span></div>)}</div></Modal>}
    {modal === "rename" && state && <RenameTask title={state.session.title} close={() => setModal(null)} save={async (title) => { update(await api.request("session.rename", { sessionId: state.session.id, title })); setModal(null); }} onError={setError} />}
    {modal === "fork" && state && <SessionAction title={t("Fork task", "分支聊天")} close={() => setModal(null)} onError={setError} submit={fork} action={t("Fork task", "分支聊天")} options={[{ value: false, label: t("Use the same workspace", "使用同一工作区"), description: t("Continue a copy of this conversation in the current workspace.", "在当前工作区继续此聊天的副本。") }, { value: true, label: t("Create an isolated Git worktree", "创建独立 Git worktree"), description: t("Continue in a separate workspace with this conversation's files.", "携带此聊天的文件，在独立工作区中继续。") }]} />}
    {modal === "rewind" && state && <SessionAction title={t("Rewind task", "回退聊天")} close={() => setModal(null)} onError={setError} submit={rewind} action={t("Rewind task", "回退聊天")} options={[{ value: false, label: t("Rewind conversation only", "仅回退聊天"), description: t("Keep current workspace files.", "保留当前工作区文件。") }, { value: true, label: t("Rewind conversation and files", "回退聊天及文件"), description: t("Restore workspace files to this point in the conversation.", "将工作区文件恢复至聊天的这一时刻。") }]} />}
    {modal === "model" && state && <ModelPicker models={models} current={modelValue(state.session.model)} close={() => setModal(null)} onError={setError} select={async (model) => { update(await api.request("model.select", { sessionId: state.session.id, model })); setModal(null); }} />}
    {modal === "context" && context && <Modal title={t("Context", "上下文")} close={() => setModal(null)}><div className="modal-content"><div className="context-stats"><strong>~{context.tokens.toLocaleString()} <span>/ {context.limit.toLocaleString()} tokens</span></strong><span>{context.messageCount} {t("messages", "条消息")} · ${context.cost.toFixed(4)}</span></div><progress max={context.limit} value={context.tokens} /><p className="muted">{t("Estimated context usage", "预估上下文用量")}</p><div className="context-breakdown">{context.components.map((part) => <div key={part.name}><span>{part.name === "system" ? t("System", "系统") : part.name === "tools" ? t("Tools", "工具") : part.name === "conversation" ? t("Conversation", "聊天") : part.name}</span><span>~{part.tokens.toLocaleString()} tokens</span></div>)}</div><h3>{t("System instructions", "系统指令")}</h3><pre className="context-prompt">{context.systemPrompt}</pre><h3>{t("Available skills", "可用技能")}</h3>{context.skills.map((skill) => <div className="skill-item" key={skill.path}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}<button disabled={busy} onClick={() => act(async () => { await api.request("session.compact", { sessionId: selected! }); await showContext(); })}>{t("Compact context", "压缩上下文")}</button></div></Modal>}

  </div>;
}

function RenameTask({ title, close, save, onError }: { title: string; close: () => void; save: (title: string) => Promise<void>; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  return <Modal title={t("Rename task", "重命名聊天")} close={close}><form className="modal-content form" onSubmit={(event) => { event.preventDefault(); setPending(true); void save(value.trim()).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); }}><label>{t("Chat title", "聊天标题")}<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} /></label><footer><button type="button" onClick={close}>{t("Cancel", "取消")}</button><button className="primary" disabled={pending || !value.trim()}>{t("Save", "保存")}</button></footer></form></Modal>;
}

function SessionAction({ title, close, onError, submit, action, options }: { title: string; close: () => void; onError: (message: string) => void; submit: (value: boolean) => Promise<void>; action: string; options: { value: boolean; label: string; description: string }[] }) {
  const { t } = useI18n();
  const [value, setValue] = useState(false);
  const [pending, setPending] = useState(false);
  return <Modal title={title} close={close}><form className="modal-content form" onSubmit={(event) => { event.preventDefault(); setPending(true); void submit(value).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); }}>{options.map((option) => <label className="action-option" key={String(option.value)}><input type="radio" name="workspace-action" checked={value === option.value} onChange={() => setValue(option.value)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}<footer><button type="button" onClick={close}>{t("Cancel", "取消")}</button><button className="primary" disabled={pending}>{action}</button></footer></form></Modal>;
}

function ModelPicker({ models, current, close, onError, select }: { models: ModelInfo[]; current: string; close: () => void; onError: (message: string) => void; select: (value: ModelSelection) => Promise<void> }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const filtered = models.filter((model) => model.authenticated && `${model.name} ${modelValue(model)}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(modelValue(b) === current) - Number(modelValue(a) === current));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index, query]);
  const choose = (model: ModelInfo) => {
    if (pending) return;
    setPending(true);
    void select({ provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel }).catch((error: unknown) => { onError(errorText(error)); setPending(false); });
  };
  return <Modal title={t("Choose model", "选择模型")} close={close}><div className="modal-content model-picker"><input aria-label={t("Search models", "搜索模型")} autoFocus placeholder={t("Search models", "搜索模型")} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((value) => Math.max(0, Math.min(filtered.length - 1, value + (event.key === "ArrowDown" ? 1 : -1)))); } if (event.key === "Enter" && filtered[index]) { event.preventDefault(); choose(filtered[index]!); } }} /><div ref={list} role="listbox" aria-label={t("Models", "模型")}>{filtered.map((model, at) => <button role="option" aria-selected={at === index} className={at === index ? "selected" : ""} key={modelValue(model)} disabled={pending} onClick={() => choose(model)}><span>{modelValue(model) === current ? "✓ " : ""}{model.name}<small>{model.provider} / {model.id}</small></span><small>{`${Math.round(model.contextWindow / 1000)}k`}</small></button>)}</div>{!filtered.length && <p className="muted">{t("No matching models.", "没有匹配的可用模型。")}</p>}<p className="picker-hint">{t("↑↓ select · Enter confirm · Esc cancel", "↑↓ 选择 · Enter 确认 · Esc 取消")}</p></div></Modal>;
}

function ApprovalCard({ approval, onError }: { approval: Approval; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [remember, setRemember] = useState<"" | "project" | "global">("");
  const [pending, setPending] = useState(false);
  const respond = (allow: boolean, value?: string) => { setPending(true); void api.request("approval.respond", { approvalId: approval.id, allow, answer: value, remember: remember || undefined }).catch((error: unknown) => { onError(errorText(error)); setPending(false); }); };
  return <section className="approval-card"><h3>{approval.question || `${t("Allow", "允许")} ${approval.tool}?`}</h3>{approval.question ? <><div className="approval-options">{approval.options?.map((option) => <button disabled={pending} key={option} onClick={() => respond(true, option)}>{option}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); respond(true, answer); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={t("Write your answer…", "请输入回答…")} /><button disabled={pending || !answer.trim()} className="primary">{t("Send answer", "发送回答")}</button></form></> : <><pre>{String(approval.args.command || approval.args.patch || approval.args.path || approval.tool)}{typeof approval.args.oldText === "string" ? `\n− ${approval.args.oldText}\n+ ${approval.args.newText || ""}` : typeof approval.args.content === "string" ? `\n${approval.args.content}` : ""}</pre><details><summary>{t("Full request", "完整请求")}</summary><pre>{JSON.stringify(approval.args, null, 2)}</pre></details><div className="approval-actions"><select value={remember} onChange={(event) => setRemember(event.target.value as typeof remember)} aria-label={t("Remember approval", "记住授权")}><option value="">{t("This request only", "仅此次请求")}</option><option value="project">{t("Remember for project", "为此项目记住")}</option><option value="global">{t("Remember globally", "全局记住")}</option></select><button disabled={pending} onClick={() => respond(false)}>{t("Deny", "拒绝")}</button><button disabled={pending} className="primary" onClick={() => respond(true)}>{t("Allow", "允许")}</button></div></>}</section>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
