import React, { useEffect, useMemo, useRef, useState } from "react";
import { isBusy } from "@voidkagami/protocol";
import type { Session } from "@voidkagami/protocol";
import { Icon } from "./icons.tsx";
import { useI18n } from "./i18n.ts";

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export const sessionProject = (session: Session): string | null => session.projectPath === null ? null : session.projectPath || session.cwd;

function useStoredList(key: string) {
  const [value, setValue] = useState<string[]>(() => JSON.parse(localStorage.getItem(key) || "[]") as string[]);
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)); }, [key, value]);
  return [value, setValue] as const;
}

export function Sidebar({ sessions, selected, settingsOpen, connection, onSelect, onNew, onArchive, onSettings, chooseProject }: {
  sessions: Session[]; selected: string | null; settingsOpen: boolean; connection: string;
  onSelect: (id: string) => void; onNew: (cwd?: string) => void; onArchive: (session: Session) => void;
  onSettings: () => void; chooseProject: () => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [projects, setProjects] = useStoredList("projects");
  const [collapsed, setCollapsed] = useStoredList("collapsedProjects");
  const [pinnedProjects, setPinnedProjects] = useStoredList("pinnedProjects");
  const [pinnedSessions, setPinnedSessions] = useStoredList("pinnedSessions");
  const [filter, setFilter] = useState("");
  const dragged = useRef<string | null>(null);
  const ignoreClick = useRef(false);
  const [dropTarget, setDropTarget] = useState<{ path: string; after: boolean } | null>(null);
  const active = sessions.filter((session) => !session.archived);
  const groups = useMemo(() => [...new Set([...projects, ...sessions.filter((session) => !session.archived).map(sessionProject).filter((path): path is string => path !== null)])], [projects, sessions]);
  const visible = active.filter((session) => `${session.title} ${sessionProject(session) || ""}`.toLowerCase().includes(filter.toLowerCase()));
  const matchingGroups = groups.filter((cwd) => !filter || cwd.toLowerCase().includes(filter.toLowerCase()) || visible.some((session) => sessionProject(session) === cwd));
  const toggle = (items: string[], value: string) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  function moveProject(target: string, pinned: boolean, after: boolean) {
    const source = dragged.current;
    if (!source || source === target) return;
    const order = groups.filter((path) => path !== source);
    order.splice(order.indexOf(target) + Number(after), 0, source);
    setProjects(order);
    setPinnedProjects((items) => pinned ? [...new Set([...items, source])] : items.filter((path) => path !== source));
    dragged.current = null; setDropTarget(null);
  }
  function startProjectDrag(event: React.PointerEvent<HTMLButtonElement>, cwd: string) {
    if (event.button !== 0) return;
    const button = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let moving = false;
    button.setPointerCapture(event.pointerId);
    const destination = (x: number, y: number) => {
      const heading = document.elementFromPoint(x, y)?.closest<HTMLElement>(".project-heading[data-project-path]");
      if (!heading) return null;
      const bounds = heading.getBoundingClientRect();
      return { path: heading.dataset.projectPath!, pinned: heading.dataset.pinned === "true", after: y > bounds.top + bounds.height / 2 };
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moving && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      moving = true; dragged.current = cwd;
      next.preventDefault();
      setDropTarget(destination(next.clientX, next.clientY));
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      button.removeEventListener("lostpointercapture", finish);
      if (button.hasPointerCapture(next.pointerId)) button.releasePointerCapture(next.pointerId);
      if (moving) {
        ignoreClick.current = true;
        setTimeout(() => { ignoreClick.current = false; }, 0);
        if (next.type === "pointerup") {
          const target = destination(next.clientX, next.clientY);
          if (target) moveProject(target.path, target.pinned, target.after);
        }
      }
      dragged.current = null; setDropTarget(null);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    button.addEventListener("lostpointercapture", finish);
  }
  function sessionRow(session: Session, nested = false) {
    return <div className={`session-row ${nested ? "nested" : ""} ${selected === session.id && !settingsOpen ? "selected" : ""}`} key={session.id}>
      <button className="session-link" onClick={() => onSelect(session.id)} title={session.title}>
        <span className="session-name">{session.title === "New session" ? t("New chat", "新聊天") : session.title}</span>
        {isBusy(session.status) && <span className={`status-dot ${session.status}`} />}
      </button>
      <div className="session-row-actions">
        <button className="small-icon" aria-label={pinnedSessions.includes(session.id) ? t("Unpin chat", "取消置顶聊天") : t("Pin chat", "置顶聊天")} title={pinnedSessions.includes(session.id) ? t("Unpin chat", "取消置顶聊天") : t("Pin chat", "置顶聊天")} onClick={() => setPinnedSessions((items) => toggle(items, session.id))}><Icon name="pin" /></button>
        <button className="small-icon" aria-label={t("Archive chat", "归档聊天")} title={t("Archive chat", "归档聊天")} disabled={isBusy(session.status)} onClick={() => onArchive(session)}><Icon name="archive" /></button>
      </div>
    </div>;
  }
  function projectRow(cwd: string, pinned: boolean) {
    const expanded = !collapsed.includes(cwd) || Boolean(filter);
    return <div className={`project-group ${dropTarget?.path === cwd ? dropTarget.after ? "drop-after" : "drop-before" : ""}`} key={cwd}>
      <div className="project-heading" data-project-path={cwd} data-pinned={pinned}>
        <button className="project-title" title={cwd} aria-expanded={expanded} onPointerDown={(event) => startProjectDrag(event, cwd)} onClick={(event) => { if (ignoreClick.current && event.detail !== 0) { event.preventDefault(); return; } setCollapsed((items) => toggle(items, cwd)); }}><Icon name={expanded ? "folder-open" : "folder"} /><span className="project-name">{baseName(cwd)}</span></button>
        <div className="project-row-actions"><button className="small-icon" title={pinned ? t("Unpin project", "取消置顶项目") : t("Pin project", "置顶项目")} aria-label={pinned ? t("Unpin project", "取消置顶项目") : t("Pin project", "置顶项目")} onClick={() => setPinnedProjects((items) => toggle(items, cwd))}><Icon name="pin" /></button><button className="small-icon" aria-label={`${t("New chat in", "新建聊天于")} ${baseName(cwd)}`} title={t("New chat in project", "在项目中新建聊天")} onClick={() => { setCollapsed((items) => items.filter((path) => path !== cwd)); onNew(cwd); }}><Icon name="plus" /></button></div>
      </div>
      {expanded && visible.filter((session) => sessionProject(session) === cwd).map((session) => sessionRow(session, true))}
    </div>;
  }
  return <aside className="sidebar">
    <div className="traffic-space" />
    <button className="new-chat" onClick={() => onNew()}><Icon name="compose" />{t("New chat", "新聊天")}</button>
    <input className="sidebar-search" placeholder={t("Search chats", "搜索聊天")} aria-label={t("Search chats", "搜索聊天")} value={filter} onChange={(event) => setFilter(event.target.value)} />
    <div className="project-list">
      {(pinnedProjects.length > 0 || pinnedSessions.some((id) => visible.some((session) => session.id === id))) && <section className="sidebar-section"><div className="section-label">{t("Pinned", "置顶")}</div>{matchingGroups.filter((cwd) => pinnedProjects.includes(cwd)).map((cwd) => projectRow(cwd, true))}{visible.filter((session) => pinnedSessions.includes(session.id)).map((session) => sessionRow(session))}</section>}
      <section className="sidebar-section"><div className="section-label"><span>{t("Projects", "项目")}</span><button className="small-icon" aria-label={t("Add project", "添加项目")} title={t("Add project", "添加项目")} onClick={() => void chooseProject().then((path) => { if (path) setProjects((items) => [...new Set([...items, path])]); })}><Icon name="plus" /></button></div>{matchingGroups.filter((cwd) => !pinnedProjects.includes(cwd)).map((cwd) => projectRow(cwd, false))}</section>
      <section className="sidebar-section"><div className="section-label">{t("Recents", "最近")}</div>{visible.filter((session) => !pinnedSessions.includes(session.id)).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => sessionRow(session))}{!visible.length && <p className="sidebar-empty">{filter ? t("No matching chats.", "没有匹配的聊天。") : t("Your chats will appear here.", "你的聊天会显示在这里。")}</p>}</section>
    </div>
    <div className="sidebar-bottom"><button className={settingsOpen ? "active" : ""} onClick={onSettings}><Icon name="settings" /><span>{t("Settings", "设置")}</span></button><span className={`connection ${connection === "connected" ? "" : "offline"}`} title={connection}>{connection === "connected" ? t("Connected", "已连接") : connection === "connecting" || connection === "reconnecting" ? t("Connecting…", "连接中…") : t("Disconnected", "已断开")}</span></div>
  </aside>;
}

export function ResizeHandle({ value, onChange, min, max, side, label }: { value: number; onChange: (value: number) => void; min: number; max: number; side: "left" | "right"; label: string }) {
  const clamp = (next: number) => Math.max(min, Math.min(next, max));
  return <div className="resize-handle" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} onPointerDown={(event) => {
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX; const width = value; const target = event.currentTarget;
    const move = (next: PointerEvent) => onChange(clamp(width + (next.clientX - start) * (side === "left" ? 1 : -1)));
    const finish = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", finish); target.removeEventListener("pointercancel", finish); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", finish); target.addEventListener("pointercancel", finish);
  }} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); onChange(clamp(value + (event.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1))); }} />;
}
