import React, { useEffect, useState } from "react";
import type { Session, TaskInfo } from "@voidkagami/protocol";
import { useI18n } from "./i18n.ts";
import { baseName, sessionProject } from "./sidebar.tsx";

const api = window.voidkagami;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function statusLabel(status: string, t: (en: string, zh: string) => string): string {
  const labels: Record<string, [string, string]> = { idle: ["Ready", "就绪"], running: ["Running", "运行中"], waiting_approval: ["Approval needed", "等待确认"], interrupted: ["Stopped", "已停止"], completed: ["Completed", "已完成"], failed: ["Failed", "失败"], error: ["Error", "出错"] };
  const label = labels[status];
  return label ? t(...label) : status;
}

export function TaskPanel({ session, childrenSessions, onSelect, onError }: { session: Session; childrenSessions: Session[]; onSelect: (id: string) => void; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void api.request("session.tasks", { sessionId: session.id }).then((items) => { if (!disposed) setTasks(items); }).catch((error: unknown) => { if (!disposed) onError(errorText(error)); });
    setTasks([]); refresh(); const timer = setInterval(refresh, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [session.id]);
  return <div className="panel-content">
    {childrenSessions.length > 0 && <h3>{t("Agents", "子代理")}</h3>}
    {childrenSessions.map((child) => <div className="task-card" key={child.id}><div><strong>{child.title}</strong><span className="tag">{statusLabel(child.status, t)}</span></div><button onClick={() => onSelect(child.id)}>{child.status === "waiting_approval" ? t("Respond to agent", "回应子代理") : t("Open chat", "打开聊天")}</button></div>)}
    <h3>{t("Background processes", "后台进程")}</h3>
    {!tasks.length && <p className="muted">{t("No background processes in this chat.", "此聊天没有后台进程。")}</p>}
    {tasks.map((task) => <div className="task-card" key={task.id}><details><summary><strong className="tool-preview">{task.command.replace(/\s+/g, " ")}</strong><span className="tag">{statusLabel(task.status, t)}</span></summary><pre aria-label={t("Command", "命令")}>{task.command}</pre><pre aria-label={t("Output", "输出")}>{task.output}</pre></details>{task.status === "running" && <button onClick={() => void api.request("task.stop", { sessionId: session.id, taskId: task.id }).then(() => api.request("session.tasks", { sessionId: session.id })).then(setTasks).catch((error: unknown) => onError(errorText(error)))}>{t("Stop process", "停止进程")}</button>}</div>)}
  </div>;
}

export function WorkspacePanel({ session, busy, onUpdate, onError, onFork }: { session: Session; busy: boolean; onUpdate: (session: Session) => void; onError: (message: string) => void; onFork: () => void }) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [pending, setPending] = useState(false);
  const project = sessionProject(session);
  useEffect(() => { let disposed = false; setBranch(""); setBranches([]); if (project) void api.request("project.branches", { cwd: project }).then((items) => { if (!disposed) setBranches(items); }).catch(() => {}); return () => { disposed = true; }; }, [project]);
  async function change(options: { cwd?: string | null; worktree?: boolean; branch?: string }) {
    setPending(true);
    try { onUpdate(await api.request("session.workspace", { sessionId: session.id, ...options })); }
    catch (error) { onError(errorText(error)); }
    finally { setPending(false); }
  }
  return <div className="panel-content workspace-panel">
    <h3>{t("Project", "项目")}</h3><p>{project ? baseName(project) : t("No project", "无项目")}</p><p className="workspace-path muted">{session.cwd}</p>
    <div className="workspace-buttons"><button disabled={busy || pending} onClick={() => void api.chooseFolder().then((cwd) => { if (cwd) return change({ cwd, worktree: false }); }).catch((error: unknown) => onError(errorText(error)))}>{t("Choose project folder", "选择项目目录")}</button>{project && <button disabled={busy || pending} onClick={() => void change({ cwd: null, worktree: false })}>{t("Use a projectless workspace", "切换为无项目工作区")}</button>}</div>
    <h3>{t("Workspace", "工作区")}</h3>
    <p className="muted">{session.worktree ? t("This chat uses an isolated Git worktree.", "此聊天使用独立的 Git worktree。") : project ? t("This chat uses the project folder.", "此聊天直接使用项目目录。") : t("This chat has its own folder. The default location is configurable in Settings.", "此聊天使用独立目录，默认位置可在设置中调整。")}</p>
    {project && (session.worktree ? <button disabled={busy || pending} onClick={() => void change({ worktree: false })}>{t("Use project folder", "切换回项目目录")}</button> : <><label>{t("Starting branch", "起始分支")}<select value={branch} disabled={busy || pending} onChange={(event) => setBranch(event.target.value)}><option value="">{t("Current branch", "当前分支")}</option>{branches.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><button disabled={busy || pending || !branches.length} onClick={() => void change({ worktree: true, branch: branch || undefined })}>{t("Create an isolated worktree", "创建独立 worktree")}</button></>)}
    <h3>{t("Conversation", "聊天")}</h3><button disabled={busy || pending} onClick={onFork}>{t("Fork chat", "分支聊天")}</button>
    {busy && <p className="muted">{t("Workspace changes are available when the agent has finished.", "代理运行结束后可以调整工作区。")}</p>}
  </div>;
}
