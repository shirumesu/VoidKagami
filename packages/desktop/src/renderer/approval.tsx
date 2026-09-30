import React, { useMemo, useState } from "react";
import type { Approval, SessionEvent } from "@voidkagami/protocol";
import { describeTool } from "@voidkagami/client/presentation";
import type { TranscriptItem } from "@voidkagami/client/store";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import "./approval.css";

export function ApprovalCard({ approval, index, count, cwd, onRespond, onViewDiff }: {
  approval: Approval; index: number; count: number; cwd: string;
  onRespond: (approval: Approval, allow: boolean, answer?: string, remember?: "project" | "global") => void;
  onViewDiff: (eventId: string) => void;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const description = useMemo(() => {
    const event: SessionEvent = { id: approval.id, sessionId: approval.sessionId, parentId: null, seq: 0, timestamp: new Date().toISOString(), type: "tool.call", data: { tool: approval.tool, args: approval.args } };
    const item: TranscriptItem = { id: approval.id, seq: 0, role: "tool", text: "", event, tool: approval.tool, toolArgs: approval.args };
    return describeTool(item, t, cwd);
  }, [approval, cwd, t]);
  const respond = (allow: boolean, value?: string, remember?: "project" | "global") => { if (pending) return; setPending(true); onRespond(approval, allow, value, remember); };
  const title = approval.question ? t("A question needs your answer", "需要你回答问题") : approval.tool === "bash" ? t("Allow this command?", "允许运行此命令？") : ["write", "edit", "apply_patch"].includes(approval.tool) ? t("Allow these file changes?", "允许这些文件改动？") : t(`Allow ${approval.tool}?`, `允许 ${approval.tool}？`);
  return <section className="approval-card" aria-label={title}>
    <header className="approval-heading"><span className="approval-mark"><Icon name="error" /></span><h3>{title}</h3>{count > 1 && <span className="approval-counter">{index + 1} / {count}</span>}</header>
    {approval.question ? <>
      <p className="approval-question">{approval.question}</p>
      <div className="approval-options">{approval.options?.map((option) => <button type="button" disabled={pending} key={option} onClick={() => respond(true, option)}>{option}</button>)}</div>
      <form className="approval-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) respond(true, answer.trim()); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={t("Write an answer…", "输入回答…")} /><button className="primary" disabled={pending || !answer.trim()}>{t("Send answer", "发送回答")}</button></form>
      <button type="button" className="approval-decline" disabled={pending} onClick={() => respond(false)}>{t("Stop run", "停止运行")}</button>
    </> : <>
      <div className="approval-description"><Icon name={description.kind === "command" ? "terminal" : description.kind === "edit" ? "file-search" : "help"} />
        {approval.tool === "bash" ? <pre><code>{`$ ${String(approval.args.command || "")}`}</code></pre> : <div><strong>{description.target}</strong>{(description.added || description.removed) ? <span className="diff-counts"><span>+{description.added || 0}</span><span>−{description.removed || 0}</span></span> : null}</div>}
      </div>
      {description.kind === "edit" && <button type="button" className="approval-diff-link" onClick={() => onViewDiff(approval.id)}>{t("View diff", "查看差异")}</button>}
      <div className="approval-actions">
        <button type="button" className="approval-deny" disabled={pending} onClick={() => respond(false)}>{t("Deny", "拒绝")}</button>
        <button type="button" className="approval-secondary" disabled={pending} onClick={() => respond(true, undefined, "project")}>{t("Allow for this project", "对此项目允许")}</button>
        <button type="button" className="approval-secondary" disabled={pending} onClick={() => respond(true, undefined, "global")}>{t("Always allow", "始终允许")}</button>
        <button type="button" className="primary approval-allow" disabled={pending} onClick={() => respond(true)}>{t("Allow", "允许")} <kbd>⏎</kbd></button>
      </div>
    </>}
  </section>;
}
