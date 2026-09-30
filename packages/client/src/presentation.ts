import type { SessionStatus, PermissionMode, ThinkingLevel } from "@voidkagami/protocol";
import type { TranscriptItem } from "./store.ts";

export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "agent" | "task" | "question" | "other";
export type Translate = (english: string, chinese: string) => string;
export interface ToolDescription {
  kind: ToolKind;
  verb: string;
  activeVerb: string;
  target: string;
  added?: number;
  removed?: number;
  readOnly: boolean;
}

const stringArg = (args: Record<string, unknown>, key: string) => typeof args[key] === "string" ? args[key] as string : "";
const countLines = (value: string) => value ? value.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n").length : 0;
function pathTarget(value: string, cwd?: string): string {
  if (!cwd || !value) return value;
  const base = cwd.replace(/[\\/]+$/, "");
  const path = value.replaceAll("\\", "/");
  const root = base.replaceAll("\\", "/");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
function patchStats(patch: string) {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) continue;
    if (line.startsWith("+")) added++;
    if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim());
}

export function describeTool(item: TranscriptItem, t: Translate, cwd?: string): ToolDescription {
  const tool = item.tool || "";
  const args = item.toolArgs || {};
  const active = item.toolStatus === "running";
  const pair = (kind: ToolKind, en: string, zh: string, activeEn: string, activeZh: string, target: string, readOnly = false): ToolDescription => ({
    kind, verb: t(en, zh), activeVerb: t(activeEn, activeZh), target, readOnly,
  });
  if (tool === "bash") return pair("command", "Ran", "运行了", "Running", "正在运行", stringArg(args, "command").split(/\r?\n/, 1)[0]!);
  if (tool === "read") {
    const path = pathTarget(stringArg(args, "path"), cwd);
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return pair("read", "Read", "读取了", "Reading", "正在读取", `${path}${offset !== undefined ? `:${offset}${limit ? `-${offset + limit - 1}` : ""}` : ""}`, true);
  }
  if (tool === "write") {
    const target = pathTarget(stringArg(args, "path"), cwd);
    return { ...pair("edit", "Wrote", "写入了", "Writing", "正在写入", target), added: countLines(stringArg(args, "content")), removed: 0 };
  }
  if (tool === "edit" || tool === "apply_patch") {
    const patch = tool === "apply_patch" ? stringArg(args, "patch") : "";
    const paths = tool === "apply_patch" ? patchPaths(patch) : [stringArg(args, "path")];
    const target = paths.filter(Boolean).map((path) => pathTarget(path, cwd));
    const label = target.length > 1 ? t(`${target[0]} and ${target.length - 1} more`, `${target[0]} 等 ${target.length} 个文件`) : target[0] || "";
    const stats = tool === "apply_patch" ? patchStats(patch) : { added: countLines(stringArg(args, "new_text")), removed: countLines(stringArg(args, "old_text")) };
    return { ...pair("edit", "Edited", "编辑了", "Editing", "正在编辑", label), ...stats };
  }
  if (tool === "glob") return pair("search", "Listed", "列出了", "Listing", "正在列出", stringArg(args, "pattern"), true);
  if (tool === "grep") {
    const pattern = stringArg(args, "pattern");
    const path = stringArg(args, "path");
    return pair("search", "Searched", "搜索了", "Searching", "正在搜索", `${pattern}${path ? ` ${t("in", "于")} ${pathTarget(path, cwd)}` : ""}`, true);
  }
  if (tool === "web_search") return pair("web", "Searched the web", "搜索了网页", "Searching the web", "正在搜索网页", stringArg(args, "query"), true);
  if (tool === "web_fetch") {
    let target = stringArg(args, "url");
    try { const url = new URL(target); target = `${url.host}${url.pathname}`; } catch {}
    return pair("web", "Fetched", "获取了", "Fetching", "正在获取", target, true);
  }
  if (tool === "view_image") return pair("read", "Viewed", "查看了", "Viewing", "正在查看", pathTarget(stringArg(args, "path"), cwd), true);
  if (tool === "task_list" || tool === "task_read") return pair("task", "Checked tasks", "查看了任务", "Checking tasks", "正在查看任务", stringArg(args, "id"), true);
  if (tool === "task_stop") return pair("task", "Stopped task", "停止了任务", "Stopping task", "正在停止任务", stringArg(args, "id"));
  if (tool === "subagent") return pair("agent", "Delegated", "委派了", "Delegating", "正在委派", stringArg(args, "task"));
  if (tool === "ask_user") {
    const questions = Array.isArray(args.questions) ? args.questions as { question?: string }[] : [];
    return pair("question", "Asked you", "询问了你", "Asking you", "正在询问你", questions[0]?.question || "");
  }
  if (tool === "todo") return pair("other", "", "", "", "", "");
  const first = Object.values(args).find((value): value is string => typeof value === "string") || "";
  return { ...pair("other", tool, tool, tool, tool, first), readOnly: false };
}

export function truncateMiddle(text: string, width: number): string {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= 1) return width > 0 ? "…" : "";
  const available = width - 1;
  const left = Math.ceil(available / 2);
  const right = Math.floor(available / 2);
  return `${chars.slice(0, left).join("")}…${chars.slice(chars.length - right).join("")}`;
}

export function truncateEnd(text: string, width: number): string {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= 1) return width > 0 ? "…" : "";
  return `${chars.slice(0, width - 1).join("")}…`;
}

export function activitySummary(items: TranscriptItem[], t: Translate): string {
  const tools = items.filter((item) => item.role === "tool" && item.tool !== "todo");
  const commands = tools.filter((item) => item.tool === "bash").length;
  const edited = new Set(tools.flatMap((item) => {
    if (item.tool === "apply_patch") return patchPaths(String(item.toolArgs?.patch || ""));
    const path = ["write", "edit"].includes(item.tool || "") ? String(item.toolArgs?.path || "") : "";
    return path ? [path] : [];
  })).size;
  const reads = tools.filter((item) => item.tool === "read" || item.tool === "view_image").length;
  const failed = tools.filter((item) => item.toolStatus === "error" || item.error).length;
  const parts: string[] = [];
  if (commands) parts.push(t(`Ran ${commands} ${commands === 1 ? "command" : "commands"}`, `运行 ${commands} 个命令`));
  if (edited) parts.push(t(`edited ${edited} ${edited === 1 ? "file" : "files"}`, `编辑 ${edited} 个文件`));
  if (reads) parts.push(t(`read ${reads} ${reads === 1 ? "file" : "files"}`, `读取 ${reads} 个文件`));
  if (failed) parts.push(t(`${failed} failed`, `${failed} 个失败`));
  return parts.join(" · ");
}

export function formatDuration(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t(`${seconds}s`, `${seconds} 秒`);
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return t(`${minutes}m ${remainder}s`, `${minutes} 分 ${remainder} 秒`);
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  return t(`${hours}h ${minutes}m`, `${hours} 小时 ${minutes} 分`);
}

export function statusText(status: SessionStatus, t: Translate): string {
  const labels: Record<SessionStatus, [string, string]> = {
    idle: ["Ready", "就绪"], running: ["Working", "执行中"], waiting_approval: ["Needs approval", "等待审批"],
    completed: ["Done", "已完成"], interrupted: ["Stopped", "已停止"], failed: ["Failed", "失败"],
  };
  return t(...labels[status]);
}

export function modeText(mode: PermissionMode, t: Translate, length: "short" | "long"): string {
  const labels: Record<PermissionMode, { short: [string, string]; long: [string, string] }> = {
    ask: { short: ["Ask", "询问"], long: ["Ask before changes", "修改前询问"] },
    accept_edits: { short: ["Edits", "编辑"], long: ["Accept file edits", "自动接受编辑"] },
    auto: { short: ["Auto", "自动"], long: ["Fully automatic", "完全自动"] },
    plan: { short: ["Plan", "规划"], long: ["Plan, read only", "规划（只读）"] },
  };
  return t(...labels[mode][length]);
}

export function modeTone(mode: PermissionMode): "muted" | "accent" | "warning" | "accent2" {
  return mode === "accept_edits" ? "accent" : mode === "auto" ? "warning" : mode === "plan" ? "accent2" : "muted";
}

export function statusTone(status: SessionStatus): "muted" | "accent" | "warning" | "success" | "danger" {
  return status === "running" ? "accent" : status === "waiting_approval" ? "warning" : status === "completed" ? "success" : status === "failed" ? "danger" : "muted";
}

export function thinkingText(level: ThinkingLevel, t: Translate): string {
  const labels: Record<ThinkingLevel, [string, string]> = {
    off: ["Default", "默认"], minimal: ["Minimal", "最低"], low: ["Low", "低"], medium: ["Medium", "中"],
    high: ["High", "高"], xhigh: ["Extra high", "极高"], max: ["Maximum", "最高"],
  };
  return t(...labels[level]);
}
