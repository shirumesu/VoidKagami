import React, { useMemo } from "react";

interface FileDiff {
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

function parseDiff(diff: string): FileDiff[] {
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

export function DiffView({ diff, loading = false, emptyMessage = "No file changes at this point." }: { diff: string; loading?: boolean; emptyMessage?: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (loading) return <div className="empty-diff" role="status">Loading changes…</div>;
  if (!files.length) return <div className="empty-diff" role="status">{emptyMessage}</div>;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return <div className="diff-files">
    <div className="diff-summary"><span>{files.length} {files.length === 1 ? "file" : "files"} changed</span><span className="diff-counts"><span className="diff-add-count">+{added}</span><span className="diff-remove-count">−{removed}</span></span></div>
    {files.map((file, index) => <details className="diff-file" key={`${file.path}-${index}`} open>
      <summary><span className="diff-file-name" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>{file.path}</span><span className="diff-file-status">{file.status}</span><span className="diff-counts"><span className="diff-add-count">+{file.added}</span><span className="diff-remove-count">−{file.removed}</span></span></summary>
      {file.previousPath && <div className="diff-rename">Renamed from {file.previousPath}</div>}
      <pre className="diff-code">{file.lines.map((line, lineIndex) => <div className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "diff-heading" : ""} key={lineIndex}>{line || " "}</div>)}</pre>
    </details>)}
  </div>;
}
