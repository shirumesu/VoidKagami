import React, { useEffect, useMemo, useRef, useState } from "react";
import { isBusy } from "@voidkagami/protocol";
import type { SessionState, TranscriptItem } from "@voidkagami/client/store";
import { activitySummary, describeTool, formatDuration, statusText } from "@voidkagami/client/presentation";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import "./conversation.css";

interface ConversationProps {
  state: SessionState;
  items: TranscriptItem[];
  search?: string;
  selectedSearchId?: string;
  findOpen?: boolean;
  onFork: (eventId: string) => void;
  onRewind: (eventId: string) => void;
  onViewDiff: (eventId: string) => void;
}
type TranscriptChunk = { turnId: string; items: TranscriptItem[] } | { item: TranscriptItem };
function chunks(items: TranscriptItem[]): TranscriptChunk[] {
  const output: TranscriptChunk[] = [];
  let active: { turnId: string; items: TranscriptItem[] } | undefined;
  const flush = () => { if (active?.items.length) output.push(active); active = undefined; };
  for (const item of items) {
    if (item.role === "user" && item.inputKind === "steer" && item.turnId) { flush(); output.push({ item }); continue; }
    if (item.turnId) {
      if (active?.turnId === item.turnId) active.items.push(item);
      else { flush(); active = { turnId: item.turnId, items: [item] }; }
    } else { flush(); output.push({ item }); }
  }
  flush();
  return output;
}
const kindIcons: Record<string, "terminal" | "file" | "file-search" | "globe" | "agent" | "tasks" | "help"> = {
  command: "terminal", read: "file", edit: "file-search", search: "file-search", web: "globe", agent: "agent", task: "tasks", question: "help", other: "file",
};
const fileUrl = (path: string) => path.startsWith("/") ? `file://${encodeURI(path)}` : `file:///${encodeURI(path)}`;
function AttachmentPreview({ attachment }: { attachment: { type: "image" | "file"; path: string } }) {
  return <span className="attachment">{attachment.type === "image" && <img src={fileUrl(attachment.path)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}<Icon name={attachment.type === "image" ? "image" : "file"} /><span>{attachment.path.split(/[\\/]/).at(-1)}</span></span>;
}

export function Conversation({ state, items, search = "", selectedSearchId, findOpen = false, onFork, onRewind, onViewDiff }: ConversationProps) {
  const { t } = useI18n();
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const isRunning = isBusy(state.session.status);
  const activeTurnId = isRunning ? state.events.findLast((event) => event.type === "turn.started")?.id : undefined;
  const history = chunks(items);
  const summaries = useMemo(() => new Map(state.transcript.filter((item) => item.kind === "turn" && item.turnId).map((item) => [item.turnId!, item])), [state.transcript]);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);
  useEffect(() => { if (!awayFromLatest && !search) bottom.current?.scrollIntoView({ behavior: isRunning ? "instant" : "smooth" }); }, [state.transcriptRevision, state.liveRevision, awayFromLatest, isRunning, search]);
  useEffect(() => {
    if (!selectedSearchId) return;
    scroll.current?.querySelector<HTMLElement>(`[data-search-id="${CSS.escape(selectedSearchId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedSearchId]);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    setter((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function renderTool(item: TranscriptItem) {
    const description = describeTool(item, t, state.session.cwd);
    const running = item.toolStatus === "running";
    const open = expandedTools.has(item.id) || running;
    const progress = running && latestActiveTool?.id === item.id && state.progress ? state.progress.split("\n").slice(-3) : [];
    const args = item.tool === "bash" ? `$ ${String(item.toolArgs?.command || "")}` : JSON.stringify(item.toolArgs || {}, null, 2);
    return <div className={`tool-row ${item.error ? "is-error" : ""} ${running ? "is-running" : ""} ${item.id === selectedSearchId ? "search-result current" : ""}`} data-search-id={item.id} key={item.id}>
      <button className="tool-row-summary" aria-expanded={open} onClick={() => toggle(setExpandedTools, item.id)}>
        <span className={`tool-state ${item.error ? "tone-danger" : item.toolStatus === "interrupted" ? "tone-warning" : running ? "tone-accent" : "tone-success"}`}>{running ? <span className="tool-spinner" /> : <Icon name={item.error ? "failed" : "check"} />}</span>
        <Icon name={kindIcons[description.kind] || "file"} className="tool-kind-icon" />
        <span className="tool-verb">{running ? description.activeVerb : description.verb}</span>
        <code className="tool-target" title={description.target}>{description.target}</code>
        {(description.added || description.removed) ? <span className="diff-counts"><span>+{description.added || 0}</span><span>−{description.removed || 0}</span></span> : null}
        <Icon name={open ? "chevron-down" : "chevron"} className="tool-chevron" />
      </button>
      {open && <div className={`tool-output ${running ? "live-tool-progress" : ""}`}>
        {running ? progress.length > 0 && <pre className="tool-progress-preview" aria-label={t("Live tool progress", "工具实时进度")}>{progress.join("\n")}</pre> : <>
          {item.toolArgs && <pre className="tool-arguments">{args}</pre>}
          {item.text && <pre aria-label={t("Tool output", "工具输出")}>{item.text}</pre>}
          {description.kind === "edit" && <button type="button" className="view-diff-link" onClick={() => onViewDiff(item.id)}><Icon name="review" />{t("View diff", "查看差异")}</button>}
        </>}
      </div>}
    </div>;
  }
  const searchClass = (item: TranscriptItem) => item.id === selectedSearchId ? "search-match-selected" : "";
  function renderPlan(item: TranscriptItem, latest: boolean) {
    if (!latest) return <div className={`updated-plan ${searchClass(item)}`} data-search-id={item.id} key={item.id}>{t("Updated plan", "更新了计划")}</div>;
    const plan = item.plan || [];
    const completed = plan.filter((task) => task.status === "completed").length;
    return <section className={`plan-card ${searchClass(item)}`} data-search-id={item.id} key={item.id}>
      <header><Icon name="checklist" /><strong>{t("Plan", "计划")} · {completed}/{plan.length}</strong></header>
      <ul>{plan.map((task, index) => <li className={`plan-task ${task.status}`} key={`${item.id}-${index}`}><span className="plan-marker">{task.status === "completed" ? <Icon name="circle-check" /> : task.status === "in_progress" ? <Icon name="circle-dot" /> : <span className="plan-empty-circle" />}</span><span>{task.content}</span></li>)}</ul>
    </section>;
  }
  function renderMessage(item: TranscriptItem) {
    if (item.role === "tool") return renderTool(item);
    if (item.kind === "plan") return renderPlan(item, item.id === state.planItemId || (!state.planItemId && item.id === items.filter((candidate) => candidate.kind === "plan").at(-1)?.id));
    if (item.kind === "turn") return null;
    if (item.kind === "notice") return item.error ? <div className={`error-callout ${searchClass(item)}`} data-search-id={item.id} key={item.id}><Icon name="error" /><span>{item.text || t("The task failed.", "任务失败。")}</span></div> : <div className={`system-notice ${searchClass(item)}`} data-search-id={item.id} key={item.id}><span />{item.text || t("Context updated", "上下文已更新")}<span /></div>;
    if (item.role === "system") return item.error ? <div className={`error-callout ${searchClass(item)}`} data-search-id={item.id} key={item.id}><Icon name="error" /><span>{item.text}</span></div> : <div className={`system-notice ${searchClass(item)}`} data-search-id={item.id} key={item.id}><span />{item.text}<span /></div>;
    if (item.role === "user") return <article className="message user" data-search-id={item.id} key={item.id}>
      {item.attachments?.length ? <div className="message-attachments">{item.attachments.map((attachment, index) => <AttachmentPreview key={`${attachment.path}-${index}`} attachment={attachment} />)}</div> : null}
      <div className={`user-bubble ${searchClass(item)}`}><Markdown text={item.text} /></div>
      {(item.inputKind || item.delivery === "queued") && <span className="delivery-tag">{item.inputKind === "steer" ? t("Steered", "已引导") : item.delivery === "queued" ? t("Queued", "已排队") : t("Follow-up", "后续消息")}</span>}
      <div className="message-actions"><button title={t("Copy", "复制")} aria-label={t("Copy", "复制")} onClick={() => void navigator.clipboard.writeText(item.text)}><Icon name="copy" /></button><button title={t("Fork from here", "从此处分支")} aria-label={t("Fork from here", "从此处分支")} onClick={() => onFork(item.id)}><Icon name="fork" /></button><button title={t("Rewind to here", "回退到此处")} aria-label={t("Rewind to here", "回退到此处")} onClick={() => onRewind(item.id)}><Icon name="rewind" /></button></div>
    </article>;
    return <article className={`message assistant ${item.error ? "has-error" : ""} ${searchClass(item)}`} data-search-id={item.id} key={item.id}>
      {item.thinking && <details className="thinking-block" open={expandedThinking.has(item.id)} onToggle={(event) => { const open = (event.currentTarget as HTMLDetailsElement).open; setExpandedThinking((current) => { const next = new Set(current); if (open) next.add(item.id); else next.delete(item.id); return next; }); }}><summary><Icon name="chevron" className="disclosure-chevron" />{t("Thought", "思考")}</summary><div><Markdown text={item.thinking} /></div></details>}
      <Markdown text={item.text} />
      {item.attachments?.length ? <div className="message-attachments">{item.attachments.map((attachment, index) => <AttachmentPreview key={`${attachment.path}-${index}`} attachment={attachment} />)}</div> : null}
      <div className="message-actions"><button title={t("Copy", "复制")} aria-label={t("Copy", "复制")} onClick={() => void navigator.clipboard.writeText(item.text)}><Icon name="copy" /></button><button title={t("Fork from here", "从此处分支")} aria-label={t("Fork from here", "从此处分支")} onClick={() => onFork(item.id)}><Icon name="fork" /></button><button title={t("Rewind to here", "回退到此处")} aria-label={t("Rewind to here", "回退到此处")} onClick={() => onRewind(item.id)}><Icon name="rewind" /></button></div>
    </article>;
  }
  function renderWorkBlock(turnId: string, chunkItems: TranscriptItem[]) {
    const turn = chunkItems.find((item) => item.kind === "turn") || summaries.get(turnId);
    const finalAssistant = [...chunkItems].reverse().find((item) => item.role === "assistant");
    const workItems = chunkItems.filter((item) => item.kind !== "turn" && item.id !== finalAssistant?.id);
    const active = isRunning && activeTurnId === turnId;
    const searchMatch = Boolean(search && chunkItems.some((item) => item.id === selectedSearchId));
    const expanded = expandedTurns.has(turnId) || active || searchMatch;
    const durationMs = turn?.durationMs || (active && state.turnStartedAt ? now - Date.parse(state.turnStartedAt) : 0);
    const duration = formatDuration(durationMs, t);
    const summary = activitySummary(workItems, t);
    const label = turn?.turnStatus === "failed" ? t(`Failed after ${duration}`, `${duration} 后失败`) : turn?.turnStatus === "interrupted" ? t(`Stopped after ${duration}`, `${duration} 后停止`) : t(`Worked for ${duration}`, `工作了 ${duration}`);
    const failed = workItems.some((item) => item.role === "tool" && item.error);
    const tone = turn?.turnStatus === "failed" ? "danger" : turn?.turnStatus === "interrupted" ? "warning" : "muted";
    return <React.Fragment key={`${turnId}-${chunkItems[0]?.id || "work"}`}>
      {(workItems.length > 0 || turn?.hasTools) && <section className={`work-block ${active ? "live" : expanded ? "expanded" : "collapsed"} tone-${tone}`} data-turn-id={turnId}>
        {active ? <div className="work-block-content live-work-content">{workItems.map((item) => <React.Fragment key={item.id}>{renderMessage(item)}</React.Fragment>)}</div> : <>
          <button className="work-block-toggle" aria-expanded={expanded} onClick={() => toggle(setExpandedTurns, turnId)}><span>{label}</span><Icon name={expanded ? "chevron-down" : "chevron"} /><span className={`work-activity ${failed ? "tone-danger" : ""}`}>{summary}</span></button>
          {expanded && <div className="work-block-content">{workItems.map((item) => <React.Fragment key={item.id}>{renderMessage(item)}</React.Fragment>)}</div>}
        </>}
      </section>}
      {finalAssistant && renderMessage(finalAssistant)}
    </React.Fragment>;
  }

  const latestActiveTool = [...state.transcript].reverse().find((item) => item.role === "tool" && item.toolStatus === "running");
  const activeTool = latestActiveTool ? describeTool(latestActiveTool, t, state.session.cwd) : undefined;
  const waitingApproval = state.session.status === "waiting_approval" || state.approvals.length > 0;
  const waitingForAnswer = state.approvals.some((approval) => Boolean(approval.question));
  const elapsed = state.turnStartedAt ? formatDuration(now - Date.parse(state.turnStartedAt), t) : "";
  const working = isRunning;
  const workLabel = waitingApproval ? waitingForAnswer ? t("Waiting for your answer", "等待你的回答") : t("Waiting for approval", "等待审批") : activeTool ? `${activeTool.activeVerb}${activeTool.target ? ` ${activeTool.target}` : ""}` : state.thinking ? t("Thinking", "思考中") : state.streaming ? t("Replying", "正在回复") : statusText(state.session.status, t);

  return <div className={`conversation-scroll ${findOpen ? "with-find-bar" : ""}`} ref={scroll} onScroll={() => { const element = scroll.current; if (element) setAwayFromLatest(element.scrollHeight - element.scrollTop - element.clientHeight > 120); }}>
    <div className="conversation-content">
      {search && !items.length && <p className="empty-search">{t("No matching messages.", "没有匹配的消息。")}</p>}
      {history.map((entry) => "turnId" in entry ? renderWorkBlock(entry.turnId, entry.items) : renderMessage(entry.item))}
      {(state.streaming || state.thinking) && <article className="message assistant streaming-message">
        {state.thinking && <details className="thinking-block" open><summary><Icon name="chevron" className="disclosure-chevron" /><span className="shimmer">{t("Thinking", "思考中")}</span></summary><div><Markdown text={state.thinking} /></div></details>}
        {state.streaming && <Markdown text={state.streaming} />}
      </article>}
      {working && <div className={`working-indicator ${waitingApproval ? "waiting-approval" : ""}`}><span className="working-state">{waitingApproval ? <Icon name="error" /> : <span className="tool-spinner" />}</span><span className={waitingApproval ? "working-label" : "working-label shimmer"}>{workLabel}</span><time>{elapsed}</time><span className="stop-hint">{t("esc to stop", "esc 停止")}</span></div>}
      <div ref={bottom} />
    </div>
    {awayFromLatest && <button className="jump-latest" title={t("Jump to latest", "跳转到最新消息")} aria-label={t("Jump to latest", "跳转到最新消息")} onClick={() => { setAwayFromLatest(false); bottom.current?.scrollIntoView({ behavior: "smooth" }); }}><Icon name="arrow-down" /></button>}
  </div>;
}
