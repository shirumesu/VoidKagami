import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { Select } from "./select.tsx";
import "./diff.css";

export interface FileDiff {
  path: string;
  previousPath?: string;
  status: "Added" | "Deleted" | "Renamed" | "Modified";
  added: number;
  removed: number;
  lines: string[];
}

function displayPath(value: string, gitPrefix = false): string {
  let path = value;
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    const characters: Record<string, string> = { "\\t": "\t", "\\n": "\n", "\\r": "\r" };
    const escaped = path.slice(1, -1).match(/\\[0-7]{3}|\\.|[^\\]+/g) || [];
    for (const part of escaped) {
      if (/^\\[0-7]{3}$/.test(part)) bytes.push(parseInt(part.slice(1), 8));
      else bytes.push(...encoder.encode(part.startsWith("\\") ? (characters[part] || part.slice(1)) : part));
    }
    path = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return gitPrefix ? path.replace(/^[ab]\//, "") : path;
}

export function parseDiff(diff: string): FileDiff[] {
  return diff.split(/(?=^diff --git )/m).filter((section) => section.trim()).map((section) => {
    const lines = section.replace(/\n$/, "").split("\n");
    const oldLine = lines.find((line) => line.startsWith("--- "))?.slice(4);
    const newLine = lines.find((line) => line.startsWith("+++ "))?.slice(4);
    const renamedFrom = lines.find((line) => line.startsWith("rename from "))?.slice(12);
    const renamedTo = lines.find((line) => line.startsWith("rename to "))?.slice(10);
    const headerPath = lines[0]?.match(/^diff --git (?:"a\/.*"|a\/.*) ("b\/.*"|b\/.*)$/)?.[1];
    const path = renamedTo ? displayPath(renamedTo) : displayPath((newLine !== "/dev/null" ? newLine : oldLine) || headerPath || "Changes", true);
    const status = renamedTo ? "Renamed" : lines.some((line) => line.startsWith("new file mode ")) ? "Added" : lines.some((line) => line.startsWith("deleted file mode ")) ? "Deleted" : "Modified";
    let inHunk = false;
    let added = 0;
    let removed = 0;
    const content = lines.filter((line) => {
      if (line.startsWith("@@")) inHunk = true;
      if (inHunk) { if (line.startsWith("+")) added++; if (line.startsWith("-")) removed++; }
      return inHunk || !/^(diff --git |index |--- |\+\+\+ )/.test(line);
    });
    return {
      path,
      previousPath: renamedFrom ? displayPath(renamedFrom) : undefined,
      status,
      added,
      removed,
      lines: content,
    };
  });
}

interface DiffRow { text: string; oldNumber?: number; newNumber?: number; kind: "added" | "removed" | "context" | "heading"; }
export function diffStats(diff: string) {
  return parseDiff(diff).reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
}

function lineNumbers(lines: string[]): DiffRow[] {
  let oldNumber = 0;
  let newNumber = 0;
  return lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]); return { text, kind: "heading" }; }
    if (text.startsWith("+")) return { text: text.slice(1), newNumber: newNumber++, kind: "added" };
    if (text.startsWith("-")) return { text: text.slice(1), oldNumber: oldNumber++, kind: "removed" };
    if (text.startsWith(" ")) return { text: text.slice(1), oldNumber: oldNumber++, newNumber: newNumber++, kind: "context" };
    return { text, kind: "heading" };
  });
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="diff-counts"><span className="diff-add-count">+{added}</span><span className="diff-remove-count">−{removed}</span></span>;
}

export function DiffView({ diff, loading = false, emptyMessage, expansion = { action: "collapse", revision: 0 } }: { diff: string; loading?: boolean; emptyMessage?: string; expansion?: { action: "expand" | "collapse"; revision: number } }) {
  const { t } = useI18n();
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { setExpanded(expansion.action === "expand" ? new Set(files.map((file) => file.path)) : new Set()); }, [expansion.revision, files]);
  if (loading) return <div className="empty-diff" role="status">{t("Loading changes…", "正在加载差异…")}</div>;
  if (!files.length) return <div className="empty-diff" role="status">{emptyMessage || t("No file changes in this view.", "此范围内没有文件改动。")}</div>;
  return <div className="diff-files">
    {files.map((file, index) => {
      const open = expanded.has(file.path);
      const letters = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R" } as const;
      const slash = file.path.lastIndexOf("/");
      const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
      const name = file.path.slice(slash + 1);
      return <section className="diff-file" key={`${file.path}-${index}`}>
        <button className="diff-file-toggle" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next; })}>
          <span className={`diff-file-status status-${file.status.toLowerCase()}`}>{letters[file.status]}</span><span className="diff-file-name" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}><span className="diff-directory">{directory}</span>{name}</span><span className="diff-chevron"><Icon name={open ? "chevron-down" : "chevron"} /></span><Counts added={file.added} removed={file.removed} />
        </button>
        {open && <>
          {file.previousPath && <div className="diff-rename">{t("Renamed from", "重命名前")} {file.previousPath}</div>}
          <div className="diff-code" role="region" aria-label={file.path}>{lineNumbers(file.lines).map((line, lineIndex) => line.kind === "heading" ? <div className="diff-hunk" key={lineIndex}>{line.text}</div> : <div className={`diff-line ${line.kind}`} key={lineIndex}><span className="diff-line-number">{line.oldNumber}</span><span className="diff-line-number">{line.newNumber}</span><code>{line.text || " "}</code></div>)}</div>
        </>}
      </section>;
    })}
  </div>;
}

export function DiffPanel({ sessionId, eventId, revision }: { sessionId: string; eventId?: string; revision?: unknown }) {
  const { t } = useI18n();
  const [view, setView] = useState<"last-turn" | "branch">("last-turn");
  const [baseBranch, setBaseBranch] = useState("");
  const [currentBranch, setCurrentBranch] = useState("");
  const [resolvedBase, setResolvedBase] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [expansion, setExpansion] = useState<{ action: "expand" | "collapse"; revision: number }>({ action: "collapse", revision: 0 });
  const totals = useMemo(() => diffStats(diff), [diff]);
  useEffect(() => { setBaseBranch(""); setDiff(""); setBranches([]); setExpansion((value) => ({ action: "collapse", revision: value.revision + 1 })); }, [sessionId]);
  useEffect(() => { if (eventId) setView("last-turn"); }, [eventId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setDiff("");
    void window.voidkagami.request("session.diff", { sessionId, view, eventId: view === "last-turn" ? eventId : undefined, baseBranch: baseBranch || undefined }).then((result) => {
      if (cancelled) return;
      setDiff(result.diff); setCurrentBranch(result.currentBranch || ""); setResolvedBase(result.baseBranch || "");
    }).catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, eventId, view, baseBranch, refresh, revision]);
  useEffect(() => {
    if (view !== "branch") return;
    let cancelled = false;
    void window.voidkagami.request("session.attach", { sessionId }).then((result) => window.voidkagami.request("project.branches", { cwd: result.session.cwd })).then((result) => { if (!cancelled) setBranches(result); }).catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { cancelled = true; };
  }, [sessionId, view, refresh, revision]);
  const expandAll = (action: "expand" | "collapse") => { setExpansion((value) => ({ action, revision: value.revision + 1 })); };
  return <div className="review-panel-content">
    <div className="review-toolbar"><div className="review-toolbar-left"><Menu ariaLabel={t("Review scope", "审查范围")} className="review-scope" trigger={<>{view === "last-turn" ? eventId ? t("Selected turn", "所选轮次") : t("Last turn", "上一轮") : t("Branch", "分支")}<Icon name="chevron-down" /></>}><button role="menuitem" onClick={() => { setView("last-turn"); setExpansion((value) => ({ action: "collapse", revision: value.revision + 1 })); }}>{eventId ? t("Selected turn", "所选轮次") : t("Last turn", "上一轮")}</button><button role="menuitem" onClick={() => { setView("branch"); setExpansion((value) => ({ action: "collapse", revision: value.revision + 1 })); }}>{t("Branch", "分支")}</button></Menu><Counts {...totals} /></div>
      <Menu ariaLabel={t("Review options", "审查选项")} className="review-menu-container" align="end" trigger={<Icon name="more" />}><button role="menuitem" onClick={() => setRefresh((value) => value + 1)}>{t("Refresh", "刷新")}</button><button role="menuitem" onClick={() => expandAll("expand")}>{t("Expand all diffs", "展开全部差异")}</button><button role="menuitem" onClick={() => expandAll("collapse")}>{t("Collapse all diffs", "收起全部差异")}</button></Menu>
    </div>
    {view === "branch" && <div className="review-branch"><span title={currentBranch}>{currentBranch || "HEAD"}</span><span>→</span><Select aria-label={t("Base branch", "基准分支")} value={baseBranch || resolvedBase} onChange={(event) => setBaseBranch(event.target.value)}>{!branches.includes(resolvedBase) && <option value={resolvedBase}>{resolvedBase || t("Default branch", "默认分支")}</option>}{branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select></div>}
    {error ? <div className="review-error" role="alert">{error}</div> : <DiffView diff={diff} loading={loading} expansion={expansion} />}
  </div>;
}
