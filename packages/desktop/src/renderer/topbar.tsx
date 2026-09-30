import React from "react";
import { isBusy } from "@voidkagami/protocol";
import type { Session } from "@voidkagami/protocol";
import { statusText } from "@voidkagami/client/presentation";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { baseName, sessionProject } from "./sidebar.tsx";
import "./topbar.css";

export function Topbar({ session, sidebarCollapsed, panelOpen, panelTab, changes, onToggleSidebar, onRename, onReview, onPanel, onFork, onRewind, onContext, onCompact, onArchive, onWorkspace, onAbout, onFind }: {
  session?: Session;
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  panelTab: "review" | "tasks" | "workspace";
  changes: { added: number; removed: number };
  onToggleSidebar: () => void;
  onRename: () => void;
  onReview: () => void;
  onPanel: () => void;
  onFork: () => void;
  onRewind: () => void;
  onContext: () => void;
  onCompact: () => void;
  onArchive: () => void;
  onWorkspace: () => void;
  onAbout: () => void;
  onFind: () => void;
}) {
  const { t } = useI18n();
  const busy = session ? isBusy(session.status) : false;
  const project = session ? sessionProject(session) : null;
  return <header className="topbar">
    <div className="topbar-leading">
      {sidebarCollapsed && <div className="traffic-light-placeholder" aria-hidden="true" />}
      <button className="icon-button sidebar-toggle" title={t("Toggle sidebar · ⌘B", "切换侧栏 · ⌘B")} aria-label={t("Toggle sidebar", "切换侧栏")} onClick={onToggleSidebar}><Icon name={sidebarCollapsed ? "panel-left-open" : "panel-left"} /></button>
      {session?.status === "running" && <span className="topbar-spinner" aria-label={statusText(session.status, t)} />}
      {session?.status === "waiting_approval" && <span className="status-dot tone-warning approval-dot" title={statusText(session.status, t)} aria-label={statusText(session.status, t)} />}
      <div className="title-path">
        {session ? <>
          {project && <button className="workspace-link" title={session.cwd} onClick={onWorkspace}>{baseName(project)}</button>}
          {project && <span className="separator">/</span>}
          <button className="session-title-button" title={t("Rename chat", "重命名聊天")} onClick={onRename}>{session.title === "New session" ? t("New chat", "新聊天") : session.title}</button>
          {session.worktree && <span className="tag worktree-tag">⑂ {t("Worktree", "工作树")}</span>}
        </> : <span className="app-wordmark">VoidKagami</span>}
      </div>
    </div>
    {session && <div className="topbar-actions">
      <button className={panelOpen && panelTab === "review" ? "active" : ""} title={t("Review changes · ⌘⇧D", "审查变更 · ⌘⇧D")} onClick={onReview}><Icon name="review" /><span>{t("Review", "审查")}</span>{(changes.added || changes.removed) > 0 && <span className="review-totals"><span>+{changes.added}</span> <span>−{changes.removed}</span></span>}</button>
      <button className={`icon-button ${panelOpen ? "active" : ""}`} title={t("Toggle side panel", "切换侧边面板")} aria-label={t("Toggle side panel", "切换侧边面板")} aria-expanded={panelOpen} onClick={onPanel}><Icon name="panel" /></button>
      <Menu ariaLabel={t("More chat actions", "更多聊天操作")} className="topbar-menu" align="end" trigger={<Icon name="more" />}>
        <button role="menuitem" onClick={onRename}><Icon name="compose" />{t("Rename", "重命名")}</button>
        <button role="menuitem" onClick={onFind}><Icon name="search" />{t("Find in conversation", "在聊天中查找")} <kbd>⌘F</kbd></button>
        <button role="menuitem" onClick={onFork}><Icon name="fork" />{t("Fork", "分支")}</button>
        <button role="menuitem" onClick={onRewind}><Icon name="rewind" />{t("Rewind", "回退")}</button>
        <button role="menuitem" onClick={onContext}><Icon name="circle-dot" />{t("View context", "查看上下文")}</button>
        <button role="menuitem" onClick={onCompact}><Icon name="archive" />{t("Compact context", "压缩上下文")}</button>
        <button role="menuitem" disabled={busy} onClick={onArchive}><Icon name="archive" />{t("Archive chat", "归档聊天")}</button>
        <button role="menuitem" onClick={onAbout}><Icon name="book" />{t("About VoidKagami", "关于 VoidKagami")}</button>
      </Menu>
    </div>}
  </header>;
}
