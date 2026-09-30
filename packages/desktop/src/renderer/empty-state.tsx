import React from "react";
import type { Session } from "@voidkagami/protocol";
import { useI18n } from "./i18n.ts";
import { Emblem } from "./emblem.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { baseName } from "./sidebar.tsx";
import "./empty-state.css";

export function EmptyState({ session, projects, children, onNew, onChangeWorkspace, onChooseProject }: {
  session?: Session;
  projects: string[];
  children?: React.ReactNode;
  onNew: (path?: string) => void;
  onChangeWorkspace?: (path: string | null) => void;
  onChooseProject?: () => Promise<string | null>;
}) {
  const { t } = useI18n();
  const project = session ? session.projectPath === null ? null : session.projectPath || session.cwd : null;
  return <div className={`empty-state ${session ? "for-session" : "no-session"}`}>
    <div className="empty-state-content">
      <Emblem />
      <h1>{t("What should we build?", "想做点什么？")}</h1>
      {session ? <Menu ariaLabel={t("Choose project", "选择项目")} className="project-picker" trigger={<><Icon name="folder" /><span>{project ? baseName(project) : t("Choose project", "选择项目")}</span><Icon name="chevron-down" /></>}>
        {projects.map((path) => <button role="menuitem" key={path} onClick={() => onChangeWorkspace?.(path)}><Icon name="folder" />{baseName(path)}<small>{path}</small></button>)}
        {onChooseProject && <button role="menuitem" onClick={() => void onChooseProject().then((path) => { if (path) onChangeWorkspace?.(path); })}><Icon name="folder-plus" />{t("Choose folder…", "选择文件夹…")}</button>}
        <button role="menuitem" onClick={() => onChangeWorkspace?.(null)}><Icon name="close" />{t("No project", "无项目")}</button>
      </Menu> : <>
        <button className="primary empty-new-chat" onClick={() => onNew()}><Icon name="compose" />{t("New chat", "新聊天")}</button>
        {projects.length > 0 && <div className="recent-projects"><h2>{t("Recent projects", "最近的项目")}</h2>{projects.slice(0, 5).map((path) => <button key={path} onClick={() => onNew(path)}><Icon name="folder" /><span>{baseName(path)}</span><small>{path}</small></button>)}</div>}
      </>}
    </div>
    {session && children}
  </div>;
}
