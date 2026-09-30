import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { SessionStore } from "@voidkagami/client/store";
import { isBusy } from "@voidkagami/protocol";
import type { Approval, Attachment, ContextInfo, LiveEvent, ModelInfo, ModelSelection, PermissionMode, Session, SessionEvent, ThinkingLevel } from "@voidkagami/protocol";
import type { DesktopBridge } from "../bridge.ts";
import "./style.css";
import { diffStats, DiffPanel } from "./diff.tsx";
import { initializeAppearance } from "./appearance.tsx";
import { SettingsPage, type SettingsSection } from "./settings.tsx";
import { useI18n, initializeLanguage } from "./i18n.ts";
import { Sidebar, ResizeHandle, sessionProject } from "./sidebar.tsx";
import { Icon } from "./icons.tsx";
import { TaskPanel, WorkspacePanel } from "./session-panels.tsx";
import { Conversation } from "./conversation.tsx";
import { Composer, type ComposerCommand } from "./composer.tsx";
import { ApprovalCard } from "./approval.tsx";
import { Topbar } from "./topbar.tsx";
import { EmptyState } from "./empty-state.tsx";
import { FindBar } from "./find-bar.tsx";
import { AboutModal, ContextModal, HelpModal, RenameDialog, SessionActionDialog } from "./modals.tsx";

const api: DesktopBridge = window.voidkagami;
const store = new SessionStore();
const previewParams = new URLSearchParams(window.location.search);
type ComposerDraft = { text: string; attachments: Attachment[] };
const emptyDraft: ComposerDraft = { text: "", attachments: [] };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const pathAttachment = (path: string): Attachment => ({ type: /\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : "file", path });
const commandDefinitions = [
  { name: "new", description: "Start a new chat", zh: "新建聊天" }, { name: "model", description: "Choose a model", zh: "选择模型" },
  { name: "mode", description: "Change permission mode", zh: "切换权限模式" }, { name: "context", description: "Inspect context usage", zh: "查看上下文用量" },
  { name: "compact", description: "Summarize this conversation", zh: "压缩聊天上下文" }, { name: "diff", description: "Review file changes", zh: "审查文件变更" },
  { name: "tasks", description: "Inspect background tasks", zh: "查看后台任务" }, { name: "fork", description: "Branch this conversation", zh: "分支聊天" },
  { name: "rewind", description: "Restore an earlier point", zh: "回退到较早的消息" }, { name: "rename", description: "Rename this chat", zh: "重命名聊天" },
  { name: "queue", description: "Queue a follow-up message", zh: "排队发送后续消息" }, { name: "archive", description: "Archive this chat", zh: "归档聊天" },
  { name: "archived", description: "Restore an archived chat", zh: "恢复已归档聊天" }, { name: "settings", description: "Accounts and configuration", zh: "账户和设置" },
  { name: "login", description: "Connect a provider", zh: "登录模型服务" }, { name: "help", description: "Commands and shortcuts", zh: "命令和快捷键" },
];
function readDrafts(): Record<string, ComposerDraft> {
  try { return JSON.parse(localStorage.getItem("drafts") || "{}"); } catch { return {}; }
}
function settingsFromQuery(): SettingsSection | undefined {
  const section = previewParams.get("settings");
  return ["general", "appearance", "accounts", "archived", "advanced"].includes(section || "") ? section as SettingsSection : undefined;
}
function App() {
  const { t } = useI18n();
  const builtInCommands: ComposerCommand[] = commandDefinitions.map((command) => ({ ...command, description: t(command.description, command.zh) }));
  useSyncExternalStore(store.subscribe, () => store.version);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem("selectedSession"));
  const [settingsOpen, setSettingsOpen] = useState(() => Boolean(settingsFromQuery()));
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(settingsFromQuery() || "general");
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem("sidebarWidth")) || 260);
  const [panelWidth, setPanelWidth] = useState(() => Number(localStorage.getItem("panelWidth")) || 410);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sidebarCollapsed") === "true");
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>(readDrafts);
  const composer = selected ? drafts[selected] || emptyDraft : emptyDraft;
  const draft = composer.text;
  const attachments = composer.attachments;
  const setDraft = (value: string) => { setMentionDismissed(false); if (selected) setDrafts((items) => ({ ...items, [selected]: { ...(items[selected] || emptyDraft), text: value } })); };
  const setAttachments = (value: React.SetStateAction<Attachment[]>) => { if (selected) setDrafts((items) => { const current = items[selected] || emptyDraft; return { ...items, [selected]: { ...current, attachments: typeof value === "function" ? value(current.attachments) : value } }; }); };
  const [queue, setQueue] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"context" | "rename" | "fork" | "rewind" | "help" | "about" | null>(null);
  const [actionEvent, setActionEvent] = useState<string | undefined>();
  const [panelOpen, setPanelOpen] = useState(() => ["review", "tasks", "workspace"].includes(previewParams.get("panel") || ""));
  const [panelTab, setPanelTab] = useState<"review" | "tasks" | "workspace">(() => ["review", "tasks", "workspace"].includes(previewParams.get("panel") || "") ? previewParams.get("panel") as "review" | "tasks" | "workspace" : "review");
  const [diffEvent, setDiffEvent] = useState<string | undefined>();
  const [changeStats, setChangeStats] = useState({ added: 0, removed: 0 });
  const [auth, setAuth] = useState<Record<string, unknown> | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [sending, setSending] = useState(false);
  const [imports, setImports] = useState<Record<string, number>>({});
  const importing = selected ? (imports[selected] || 0) > 0 : false;
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [customCommands, setCustomCommands] = useState<ComposerCommand[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const sidebarSearch = useRef<HTMLInputElement>(null);
  const attached = selected ? store.get(selected) : undefined;
  const state = attached?.session.archived ? undefined : attached;
  const busy = state ? isBusy(state.session.status) : false;
  const panelVisible = !settingsOpen && panelOpen && Boolean(state);
  const sidebarMaximum = Math.max(200, Math.min(440, windowWidth - 340 - (panelVisible ? 282 : 1)));
  const displayedSidebarWidth = sidebarCollapsed ? 0 : Math.min(sidebarWidth, sidebarMaximum);
  const panelMaximum = Math.max(280, Math.min(780, windowWidth - displayedSidebarWidth - 342));
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
      (async () => setModels((await api.request("model.list", {})).filter((model) => model.authenticated)))(),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [errorText(result.reason)] : []);
    if (failures.length) throw new Error(failures.join("\n"));
  }, []);

  useEffect(() => {
    const dispose = api.onNotification((message) => {
      if (message.method === "event") {
        const event = message.params as SessionEvent;
        store.event(event);
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
  useEffect(() => { const resize = () => setWindowWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { localStorage.setItem("sidebarWidth", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { localStorage.setItem("panelWidth", String(panelWidth)); }, [panelWidth]);
  useEffect(() => { localStorage.setItem("sidebarCollapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("drafts", JSON.stringify(drafts)); }, [drafts]);
  useEffect(() => { if (selected) localStorage.setItem("selectedSession", selected); else localStorage.removeItem("selectedSession"); }, [selected]);
  useEffect(() => { if (attached?.session.archived) setSelected((current) => current === attached.session.id ? null : current); }, [attached?.session.id, attached?.session.archived]);
  useEffect(() => {
    if (!selected) return;
    let canceled = false;
    void api.request("session.attach", { sessionId: selected }).then((view) => { if (!canceled) { store.attach(view); if (view.session.archived) setSelected(null); } }).catch((failure: unknown) => setError(errorText(failure)));
    setSearch(""); setFindOpen(false); setFindIndex(0); setDiffEvent(undefined); setQueue(false); setFileSuggestions([]); setMentionDismissed(false); setCursor(0);
    return () => { canceled = true; };
  }, [selected]);
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
    let canceled = false;
    void api.request("commands.list", { cwd: state.session.cwd }).then((items) => { if (!canceled) setCustomCommands(items); }).catch((failure: unknown) => setError(errorText(failure)));
    return () => { canceled = true; };
  }, [state?.session.cwd]);
  const diffRevision = state?.events.findLast((event) => ["turn.ended", "head.moved", "workspace.changed"].includes(event.type))?.id || state?.session.cwd;
  useEffect(() => {
    if (!selected) { setChangeStats({ added: 0, removed: 0 }); return; }
    let canceled = false;
    void api.request("session.diff", { sessionId: selected, view: "last-turn" }).then((result) => { if (!canceled) setChangeStats(diffStats(result.diff)); }).catch(() => { if (!canceled) setChangeStats({ added: 0, removed: 0 }); });
    return () => { canceled = true; };
  }, [selected, diffRevision]);

  function selectSession(id: string) { setSelected(id); setSettingsOpen(false); setModelMenuOpen(false); setModeMenuOpen(false); setModal(null); }
  async function createSession(cwd?: string) {
    const session = await api.request("session.create", cwd ? { cwd } : {});
    update(session); selectSession(session.id); setModal(null);
  }
  async function archiveSession(session: Session) {
    update(await api.request("session.archive", { sessionId: session.id, archived: true }));
    setSelected((current) => current === session.id ? sessions.find((item) => item.id !== session.id && !item.archived)?.id || null : current);
  }
  function openSettings(section: SettingsSection = "general") { setSettingsSection(section); setSettingsOpen(true); setModal(null); }
  function openReview(eventId?: string) { setDiffEvent(eventId); setPanelTab("review"); setPanelOpen(true); }
  async function changeWorkspace(cwd: string | null) { if (selected) update(await api.request("session.workspace", { sessionId: selected, cwd, worktree: false })); }
  async function importFiles(files: File[]) {
    if (!selected) return;
    const sessionId = selected;
    setImports((items) => ({ ...items, [sessionId]: (items[sessionId] || 0) + 1 }));
    try {
      const paths = await api.importAttachments(await Promise.all(files.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() }))));
      setAttachments((items) => [...items, ...paths.map(pathAttachment)]);
    } finally { setImports((items) => ({ ...items, [sessionId]: Math.max(0, items[sessionId]! - 1) })); }
  }
  function selectFile(path: string) {
    const match = draft.slice(0, cursor).match(/@[^"]*$/);
    if (!match) return;
    const reference = `@"${path}" `;
    const start = cursor - match[0].length;
    const nextCursor = start + reference.length;
    setDrafts((items) => { if (!selected) return items; const current = items[selected] || emptyDraft; return { ...items, [selected]: { ...current, text: current.text.slice(0, start) + reference + current.text.slice(cursor) } }; });
    setCursor(nextCursor); setFileSuggestions([]); requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCursor, nextCursor); });
  }
  async function chooseAttachments() {
    if (!selected) return;
    const paths = await api.chooseAttachments();
    setAttachments((items) => [...items, ...paths.map(pathAttachment)]);
  }
  async function selectModel(model: ModelSelection) { if (selected) update(await api.request("model.select", { sessionId: selected, model })); setModelMenuOpen(false); }
  async function selectEffort(thinkingLevel: ThinkingLevel) { if (selected && state) update(await api.request("model.select", { sessionId: selected, model: { ...state.session.model, thinkingLevel } })); }
  async function selectMode(mode: PermissionMode) { if (selected) update(await api.request("session.mode", { sessionId: selected, mode })); setModeMenuOpen(false); }
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
          if (command === "model") setModelMenuOpen(true);
          if (command === "mode") setModeMenuOpen(true);
          if (command === "context") await showContext();
          if (command === "compact") { await api.request("session.compact", { sessionId: selected }); await showContext(); }
          if (command === "diff") openReview();
          if (command === "tasks") { setPanelTab("tasks"); setPanelOpen(true); }
          if (command === "fork") { setActionEvent(undefined); setModal("fork"); }
          if (command === "rewind") { setActionEvent(state?.transcript.filter((item) => item.role === "user" || item.role === "assistant").at(-1)?.id); setModal("rewind"); }
          if (command === "rename") { if (parts.length) update(await api.request("session.rename", { sessionId: selected, title: parts.join(" ") })); else setModal("rename"); }
          if (command === "archive") { if (state) await archiveSession(state.session); }
          if (command === "archived") openSettings("archived");
          if (command === "settings" || command === "login") openSettings(command === "login" ? "accounts" : "general");
          if (command === "help") setModal("help");
          setDraft(""); return;
        }
      }
      const references: Attachment[] = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)].map((match) => pathAttachment(match[1] || match[2]!));
      if (busy) await api.request(queue || command === "queue" ? "session.followUp" : "session.steer", { sessionId: selected, text, attachments: [...attachments, ...references] });
      else await api.request("session.send", { sessionId: selected, text, attachments: [...attachments, ...references] });
      setDrafts((items) => { if (items[selected] !== composer) return items; const next = { ...items }; delete next[selected]; return next; });
      setQueue(false); input.current?.focus();
    } finally { setSending(false); }
  }
  async function showContext() { if (selected) { const value = await api.request("session.context", { sessionId: selected }); setContext(value); store.setContext(selected, value); setModal("context"); } }
  async function fork(worktree: boolean) { if (selected) { const next = await api.request("session.fork", { sessionId: selected, eventId: actionEvent, worktree }); setSessions((items) => [next, ...items.filter((item) => item.id !== next.id)]); selectSession(next.id); setModal(null); } }
  async function rewind(restoreFiles: boolean) { if (selected && actionEvent) { update(await api.request("session.rewind", { sessionId: selected, eventId: actionEvent, restoreFiles })); store.attach(await api.request("session.attach", { sessionId: selected })); setModal(null); } }
  function startRewind() { setActionEvent(state?.transcript.filter((item) => item.role === "user" || item.role === "assistant").at(-1)?.id); setModal("rewind"); }
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); act(() => createSession()); }
      if (event.key === ",") { event.preventDefault(); openSettings(); }
      if (key === "f" && state && !settingsOpen) { event.preventDefault(); setFindOpen(true); setSearch(""); }
      if (key === "k") { event.preventDefault(); setSettingsOpen(false); setSidebarCollapsed(false); requestAnimationFrame(() => sidebarSearch.current?.focus()); }
      if (key === "b") { event.preventDefault(); setSidebarCollapsed((value) => !value); }
      if (key === "d" && event.shiftKey) { event.preventDefault(); if (panelOpen && panelTab === "review") setPanelOpen(false); else openReview(); }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [panelOpen, panelTab, state?.session.id, settingsOpen]);

  const slashQuery = /^\/([^\s]*)$/.exec(draft)?.[1];
  const commandSuggestions = slashQuery !== undefined && !mentionDismissed ? [...builtInCommands, ...customCommands].filter((item) => item.name.includes(slashQuery)).slice(0, 7) : [];
  const findMatches = state && search ? state.transcript.filter((item) => item.text.toLowerCase().includes(search.toLowerCase())) : [];
  const transcript = search ? findMatches : state?.transcript || [];
  const selectedSearchId = findMatches[findIndex]?.id;
  useEffect(() => { setFindIndex(0); }, [search]);
  const isEmptySession = Boolean(state && state.transcript.length === 0);
  const recentProjects = [...new Set(sessions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(sessionProject).filter((path): path is string => path !== null))].slice(0, 5);
  const chooseProject = async () => {
    try { return await api.chooseFolder(); } catch (failure) { setError(errorText(failure)); return null; }
  };
  const fileRef = (value: number) => setCursor(value);
  const onApproval = (approval: Approval, allow: boolean, answer?: string, remember?: "project" | "global") => act(() => api.request("approval.respond", { approvalId: approval.id, allow, answer, remember }));
  const closeFind = () => { setFindOpen(false); setSearch(""); setFindIndex(0); };
  const cycleFind = (direction: number) => { if (findMatches.length) setFindIndex((index) => (index + direction + findMatches.length) % findMatches.length); };

  const composerNode = state ? <Composer session={state.session} busy={busy} models={models} draft={draft} setDraft={setDraft} attachments={attachments} setAttachments={setAttachments} inputRef={input} cursorChanged={fileRef} queue={queue} setQueue={setQueue} commands={commandSuggestions} files={fileSuggestions} selectedSuggestion={fileIndex} setSelectedSuggestion={setFileIndex} dismissSuggestions={() => { setMentionDismissed(true); setFileSuggestions([]); }} onSelectFile={selectFile} onSend={() => act(send)} onStop={() => act(() => api.request("session.abort", { sessionId: state.session.id }))} onImport={(files) => act(() => importFiles(files))} onChooseAttachments={() => act(chooseAttachments)} onModel={(model) => act(() => selectModel(model))} onEffort={(level) => act(() => selectEffort(level))} onMode={(mode) => act(() => selectMode(mode))} onContext={() => act(showContext)} context={state.context || null} cost={state.cost} importing={importing} sending={sending} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} modeMenuOpen={modeMenuOpen} setModeMenuOpen={setModeMenuOpen} /> : null;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--sidebar-width": `${displayedSidebarWidth}px`, "--panel-width": `${displayedPanelWidth}px` } as React.CSSProperties}>
    {!sidebarCollapsed && <Sidebar sessions={sessions} selected={selected} settingsOpen={settingsOpen} connection={connection} searchRef={sidebarSearch} onSelect={selectSession} onNew={(cwd) => act(() => createSession(cwd))} onArchive={(session) => act(() => archiveSession(session))} onSettings={() => openSettings()} chooseProject={chooseProject} />}
    {!sidebarCollapsed && <ResizeHandle value={displayedSidebarWidth} onChange={setSidebarWidth} min={200} max={sidebarMaximum} side="left" label={t("Resize sidebar", "调整侧栏宽度")} />}
    <main className="main-column">
      {!settingsOpen && <Topbar session={state?.session} sidebarCollapsed={sidebarCollapsed} panelOpen={panelOpen} panelTab={panelTab} changes={changeStats} onToggleSidebar={() => setSidebarCollapsed((value) => !value)} onRename={() => setModal("rename")} onReview={() => { if (panelOpen && panelTab === "review") setPanelOpen(false); else openReview(); }} onPanel={() => setPanelOpen((value) => !value)} onFork={() => { setActionEvent(undefined); setModal("fork"); }} onRewind={startRewind} onContext={() => act(showContext)} onCompact={() => act(async () => { await api.request("session.compact", { sessionId: selected! }); await showContext(); })} onArchive={() => state && act(() => archiveSession(state.session))} onWorkspace={() => { setPanelTab("workspace"); setPanelOpen(true); }} onAbout={() => setModal("about")} onFind={() => { setFindOpen(true); setSearch(""); setFindIndex(0); }} />}
      {findOpen && state && !settingsOpen && <FindBar query={search} matches={findMatches.length} index={findMatches.length ? findIndex + 1 : 0} onChange={(value) => { setSearch(value); setFindIndex(0); }} onPrevious={() => cycleFind(-1)} onNext={() => cycleFind(1)} onClose={closeFind} />}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={t("Dismiss error", "关闭错误提示")}><Icon name="close" /></button></div>}
      {settingsOpen ? <SettingsPage close={() => setSettingsOpen(false)} onRestored={(session) => { update(session); selectSession(session.id); }} onConfigChanged={refresh} auth={auth} initialSection={settingsSection} /> : state ? isEmptySession ? <EmptyState session={state.session} projects={recentProjects} onNew={(path) => act(() => createSession(path))} onChangeWorkspace={(cwd) => act(() => changeWorkspace(cwd))} onChooseProject={chooseProject}>{composerNode}</EmptyState> : <>
        <Conversation key={state.session.id} state={state} items={transcript} search={search} selectedSearchId={selectedSearchId} findOpen={findOpen} onFork={(eventId) => { setActionEvent(eventId); setModal("fork"); }} onRewind={(eventId) => { setActionEvent(eventId); setModal("rewind"); }} onViewDiff={(eventId) => openReview(eventId)} />
        {state.approvals.map((approval, index) => <ApprovalCard key={approval.id} approval={approval} index={index} count={state.approvals.length} cwd={state.session.cwd} onRespond={onApproval} onViewDiff={openReview} />)}
        {composerNode}
      </> : <EmptyState projects={recentProjects} onNew={(path) => act(() => createSession(path))} onChooseProject={chooseProject} />}
    </main>
    {panelVisible && state && <><ResizeHandle value={displayedPanelWidth} onChange={setPanelWidth} min={280} max={panelMaximum} side="right" label={t("Resize side panel", "调整侧边面板宽度")} /><aside className="side-panel"><div className="side-panel-tabs" role="tablist" aria-label={t("Side panel", "侧边面板")}><div className="segmented">{(["review", "tasks", "workspace"] as const).map((tab) => <button key={tab} role="tab" aria-selected={panelTab === tab} className={panelTab === tab ? "active" : ""} onClick={() => setPanelTab(tab)}>{tab === "review" ? t("Review", "审查") : tab === "tasks" ? t("Tasks", "任务") : t("Workspace", "工作区")}</button>)}</div><button className="small-icon panel-close" aria-label={t("Close side panel", "关闭侧边面板")} onClick={() => setPanelOpen(false)}><Icon name="close" /></button></div>{panelTab === "review" ? <DiffPanel sessionId={state.session.id} eventId={diffEvent} revision={`${state.session.cwd}:${diffRevision || ""}`} /> : panelTab === "tasks" ? <TaskPanel session={state.session} childrenSessions={sessions.filter((session) => session.parentSessionId === selected && !session.archived)} onSelect={selectSession} onError={setError} /> : <WorkspacePanel key={state.session.id} session={state.session} busy={busy} onUpdate={update} onError={setError} onFork={() => { setActionEvent(undefined); setModal("fork"); }} />}</aside></>}
    {modal === "help" && <HelpModal close={() => setModal(null)} commands={[...builtInCommands, ...customCommands]} />}
    {modal === "rename" && state && <RenameDialog title={state.session.title} close={() => setModal(null)} save={async (title) => { update(await api.request("session.rename", { sessionId: state.session.id, title })); setModal(null); }} onError={setError} />}
    {modal === "fork" && state && <SessionActionDialog title={t("Fork chat", "分支聊天")} close={() => setModal(null)} onError={setError} submit={fork} action={t("Fork chat", "分支聊天")} options={[{ value: false, label: t("Use the same workspace", "使用同一工作区"), description: t("Continue a copy of this conversation in the current workspace.", "在当前工作区继续此聊天的副本。") }, { value: true, label: t("Create an isolated Git worktree", "创建独立 Git 工作树"), description: t("Continue in a separate workspace with this conversation's files.", "携带此聊天的文件，在独立工作区中继续。") }]} />}
    {modal === "rewind" && state && <SessionActionDialog title={t("Rewind chat", "回退聊天")} close={() => setModal(null)} onError={setError} submit={rewind} action={t("Rewind", "回退")} options={[{ value: false, label: t("Rewind conversation only", "仅回退聊天"), description: t("Keep current workspace files.", "保留当前工作区文件。") }, { value: true, label: t("Rewind conversation and files", "回退聊天及文件"), description: t("Restore workspace files to this point in the conversation.", "将工作区文件恢复至聊天的这一时刻。") }]} />}
    {modal === "context" && context && <ContextModal context={context} cost={state?.cost || 0} busy={busy} close={() => setModal(null)} onCompact={() => act(async () => { await api.request("session.compact", { sessionId: selected! }); await showContext(); })} />}
    {modal === "about" && <AboutModal close={() => setModal(null)} />}
  </div>;
}

initializeAppearance();
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
