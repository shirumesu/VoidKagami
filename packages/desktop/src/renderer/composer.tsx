import React, { useLayoutEffect, useMemo, useRef } from "react";
import type { Attachment, ContextInfo, ModelInfo, ModelSelection, PermissionMode, Session, ThinkingLevel } from "@voidkagami/protocol";
import { modeText, modeTone, thinkingText } from "@voidkagami/client/presentation";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import "./composer.css";

export interface ComposerCommand { name: string; description: string; }
interface ComposerProps {
  session: Session;
  busy: boolean;
  models: ModelInfo[];
  draft: string;
  setDraft: (value: string) => void;
  attachments: Attachment[];
  setAttachments: (value: React.SetStateAction<Attachment[]>) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  cursorChanged: (value: number) => void;
  queue: boolean;
  setQueue: (value: boolean) => void;
  commands: ComposerCommand[];
  files: string[];
  selectedSuggestion: number;
  setSelectedSuggestion: (value: React.SetStateAction<number>) => void;
  dismissSuggestions: () => void;
  onSelectFile: (path: string) => void;
  onSend: () => void;
  onStop: () => void;
  onImport: (files: File[]) => void;
  onChooseAttachments: () => void;
  onModel: (model: ModelSelection) => void;
  onEffort: (level: ThinkingLevel) => void;
  onMode: (mode: PermissionMode) => void;
  onContext: () => void;
  context: ContextInfo | null;
  cost: number;
  importing: boolean;
  sending: boolean;
  modelMenuOpen: boolean;
  setModelMenuOpen: (value: boolean) => void;
  modeMenuOpen: boolean;
  setModeMenuOpen: (value: boolean) => void;
}

const modes: { value: PermissionMode; description: [string, string]; icon: "circle-dot" | "file-search" | "send" | "book" }[] = [
  { value: "ask", description: ["Ask before changes", "修改前询问"], icon: "circle-dot" },
  { value: "accept_edits", description: ["Accept file edits", "自动接受编辑"], icon: "file-search" },
  { value: "auto", description: ["Fully automatic", "完全自动"], icon: "send" },
  { value: "plan", description: ["Plan, read only", "规划（只读）"], icon: "book" },
];
const modelValue = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const fileUrl = (path: string) => path.startsWith("/") ? `file://${encodeURI(path)}` : `file:///${encodeURI(path)}`;

export function Composer({ session, busy, models, draft, setDraft, attachments, setAttachments, inputRef, cursorChanged, queue, setQueue, commands, files, selectedSuggestion, setSelectedSuggestion, dismissSuggestions, onSelectFile, onSend, onStop, onImport, onChooseAttachments, onModel, onEffort, onMode, onContext, context, cost, importing, sending, modelMenuOpen, setModelMenuOpen, modeMenuOpen, setModeMenuOpen }: ComposerProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const currentModel = models.find((model) => modelValue(model) === modelValue(session.model));
  const selectedEffort = session.model.thinkingLevel || currentModel?.thinkingLevel || currentModel?.thinkingLevels[0] || "off";
  const modelPill = `${currentModel?.name || session.model.id}${currentModel && currentModel.thinkingLevels.length > 1 && selectedEffort !== "off" ? ` · ${thinkingText(selectedEffort, t)}` : ""}`;
  const groups = useMemo(() => [...new Set(models.map((model) => model.provider))], [models]);
  const usage = context ? Math.max(0, Math.min(100, context.tokens / Math.max(1, context.limit) * 100)) : 0;
  const ringTone = usage > 80 ? "warning" : "accent";
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 23;
    element.style.height = `${Math.min(element.scrollHeight, lineHeight * 10 + 20)}px`;
    element.style.overflowY = element.scrollHeight > lineHeight * 10 + 20 ? "auto" : "hidden";
  }, [draft, inputRef]);
  const pickFile = (path: string) => onSelectFile(path);
  const activeList = commands.length ? "commands" : files.length ? "files" : "";
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    const options = activeList === "commands" ? commands : files;
    if (options.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelectedSuggestion((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); return; }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        if (activeList === "commands") setDraft(`/${commands[selectedSuggestion]?.name || commands[0]!.name} `);
        else pickFile(files[selectedSuggestion] || files[0]!);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); dismissSuggestions(); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); }
    if (event.key === "Escape" && busy) onStop();
  }
  const attachmentFiles = (files: FileList | null) => { const list = files ? [...files] : []; if (list.length) onImport(list); };
  return <form className="composer-area" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
    <div ref={root} className={`composer ${dragging ? "dragging" : ""}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); attachmentFiles(event.dataTransfer.files); }}>
      {dragging && <div className="drag-overlay"><Icon name="paperclip" />{t("Drop to add attachments", "松开以添加附件")}</div>}
      {importing && <div className="picker-hint" role="status">{t("Adding attachments…", "正在添加附件…")}</div>}
      {attachments.length > 0 && <div className="attachments">{attachments.map((attachment, index) => <span className="attachment" key={`${attachment.path}-${index}`}>{attachment.type === "image" && <img src={fileUrl(attachment.path)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}<Icon name={attachment.type === "image" ? "image" : "file"} /><span>{attachment.path.split(/[\\/]/).at(-1)}</span><button type="button" aria-label={`${t("Remove", "移除")} ${attachment.path}`} onClick={() => setAttachments((items) => items.filter((_, at) => at !== index))}><Icon name="close" /></button></span>)}</div>}
      <textarea ref={inputRef} value={draft} placeholder={busy ? t("Add direction · enter steers · /queue follows up", "补充指令，enter 引导 · /queue 排队") : t("Message · / commands · @ files", "输入消息 · / 命令 · @ 文件")} rows={1} aria-label={t("Message", "消息")} aria-controls={files.length ? "file-suggestions" : undefined} aria-activedescendant={files.length ? `file-suggestion-${selectedSuggestion}` : undefined} onChange={(event) => { setDraft(event.target.value); cursorChanged(event.target.selectionStart); setSelectedSuggestion(0); }} onSelect={(event) => cursorChanged(event.currentTarget.selectionStart)} onPaste={(event) => { const pasted = [...event.clipboardData.files]; if (pasted.length) { event.preventDefault(); onImport(pasted); } }} onKeyDown={onKeyDown} />
      {commands.length > 0 && <div className="suggestion-menu" role="listbox" aria-label={t("Commands", "命令")}>{commands.map((command, index) => <button type="button" role="option" aria-selected={index === selectedSuggestion} className={index === selectedSuggestion ? "selected" : ""} key={command.name} onMouseDown={(event) => event.preventDefault()} onClick={() => { setDraft(`/${command.name} `); inputRef.current?.focus(); }}>{`/${command.name}`}<span>{command.description}</span></button>)}<div className="picker-hint">{t("↑↓ navigate · Enter or Tab insert · Esc dismiss", "↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭")}</div></div>}
      {files.length > 0 && <div className="suggestion-menu" id="file-suggestions" role="listbox" aria-label={t("Project files", "项目文件")}>{files.map((path, index) => <button type="button" id={`file-suggestion-${index}`} role="option" aria-selected={index === selectedSuggestion} className={index === selectedSuggestion ? "selected" : ""} key={path} onMouseDown={(event) => event.preventDefault()} onClick={() => pickFile(path)}><Icon name="file" />{path}</button>)}<div className="picker-hint">{t("↑↓ navigate · Enter or Tab insert · Esc dismiss", "↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭")}</div></div>}
      <div className="composer-actions">
        <button type="button" className="attachment-button" title={t("Attach files or images", "添加文件或图片")} aria-label={t("Attach files or images", "添加文件或图片")} onClick={onChooseAttachments}><Icon name="plus" /></button>
        <Menu ariaLabel={t("Choose model", "选择模型")} className="model-menu" align="start" placement="top" disabled={busy} open={modelMenuOpen} onOpenChange={setModelMenuOpen} trigger={<><span>{modelPill}</span><span className="pill-chevron"><Icon name="chevron-down" /></span></>}>
          {groups.map((provider) => <div className="menu-group" key={provider}><div className="menu-group-label">{provider}</div>{models.filter((model) => model.provider === provider).map((model) => <button role="menuitem" className="model-menu-item" key={modelValue(model)} onClick={() => onModel({ provider: model.provider, id: model.id, thinkingLevel: modelValue(model) === modelValue(session.model) ? session.model.thinkingLevel : model.thinkingLevel })}><span>{model.name}<small>{model.id} · {Math.round(model.contextWindow / 1000)}k</small></span>{modelValue(model) === modelValue(session.model) && <Icon name="check" />}</button>)}</div>)}
          {currentModel && currentModel.thinkingLevels.length > 1 && <div className="effort-control" role="group" aria-label={t("Thinking effort", "思考强度")}>{currentModel.thinkingLevels.map((level) => <button key={level} type="button" className={selectedEffort === level ? "selected" : ""} data-menu-keep-open role="menuitem" aria-checked={selectedEffort === level} onClick={() => onEffort(level)}>{thinkingText(level, t)}</button>)}</div>}
        </Menu>
        <Menu ariaLabel={t("Permission mode", "权限模式")} className="mode-menu" align="start" placement="top" open={modeMenuOpen} onOpenChange={setModeMenuOpen} trigger={<><Icon name={modes.find((item) => item.value === session.permissionMode)?.icon || "circle-dot"} /><span>{modeText(session.permissionMode, t, "short")}</span><Icon name="chevron-down" /></>}>
          {modes.map((mode) => <button role="menuitem" className={`mode-menu-item tone-${modeTone(mode.value)}`} key={mode.value} onClick={() => onMode(mode.value)}><Icon name={mode.icon} /><span><strong>{modeText(mode.value, t, "long")}</strong><small>{t(...mode.description)}</small></span>{session.permissionMode === mode.value && <Icon name="check" />}</button>)}
        </Menu>
        <div className="composer-spacer" />
        {busy && <button type="button" className={`queue-pill ${queue ? "selected" : ""}`} aria-pressed={queue} onClick={() => setQueue(!queue)} title={t("Queue after the current turn", "在当前轮次后排队发送")}>{t("Queue", "排队")}</button>}
        <button type="button" className="context-control" title={context ? `${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens · $${cost.toFixed(4)}` : t("View context", "查看上下文")} aria-label={context ? `${t("Context", "上下文")} ${Math.round(usage)}%` : t("View context", "查看上下文")} onClick={onContext}><span className={`context-ring ${ringTone}`} style={{ "--usage": `${usage}%` } as React.CSSProperties} aria-hidden="true" />{context && <span className="context-usage">{Math.round(usage)}%</span>}</button>
        {busy && !draft.trim() && !attachments.length ? <button type="button" className="send-button stop-button" title={t("Stop task · esc", "停止运行 · esc")} aria-label={t("Stop task", "停止运行")} onClick={onStop}><Icon name="stop" /></button> : <button type="submit" className="send-button" disabled={(!draft.trim() && !attachments.length) || importing || sending} title={busy ? t("Steer task · ⏎", "引导任务 · ⏎") : t("Send message · ⏎", "发送消息 · ⏎")} aria-label={busy ? t("Steer task", "引导任务") : t("Send message", "发送消息")}><Icon name="arrow-up" /></button>}
      </div>
    </div>
  </form>;
}
