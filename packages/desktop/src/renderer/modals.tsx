import React, { useEffect, useRef, useState } from "react";
import { VERSION } from "@voidkagami/protocol";
import type { ContextInfo } from "@voidkagami/protocol";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import { Emblem } from "./emblem.tsx";
import "./modals.css";

export function Modal({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close)")?.focus());
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button modal-close" onClick={close} aria-label={t("Close", "关闭")}><Icon name="close" /></button></header><div className="modal-content">{children}</div></section></div>;
}

export function RenameDialog({ title, close, save, onError }: { title: string; close: () => void; save: (title: string) => Promise<void>; onError: (message: string) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  return <Modal title={t("Rename chat", "重命名聊天")} close={close}><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); setPending(true); void save(value.trim()).catch((error: unknown) => { onError(error instanceof Error ? error.message : String(error)); setPending(false); }); }}><label>{t("Chat title", "聊天标题")}<input value={value} onChange={(event) => setValue(event.target.value)} /></label><footer><button type="button" onClick={close}>{t("Cancel", "取消")}</button><button className="primary" disabled={pending || !value.trim()}>{t("Save", "保存")}</button></footer></form></Modal>;
}

export function SessionActionDialog({ title, close, onError, submit, action, options }: { title: string; close: () => void; onError: (message: string) => void; submit: (value: boolean) => Promise<void>; action: string; options: { value: boolean; label: string; description: string }[] }) {
  const { t } = useI18n();
  const [value, setValue] = useState(options[0]?.value ?? false);
  const [pending, setPending] = useState(false);
  return <Modal title={title} close={close}><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); setPending(true); void submit(value).catch((error: unknown) => { onError(error instanceof Error ? error.message : String(error)); setPending(false); }); }}>{options.map((option) => <label className="action-option" key={String(option.value)}><input type="radio" name="workspace-action" checked={value === option.value} onChange={() => setValue(option.value)} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}<footer><button type="button" onClick={close}>{t("Cancel", "取消")}</button><button className="primary" disabled={pending}>{action}</button></footer></form></Modal>;
}

export function ContextModal({ context, cost, busy, close, onCompact }: { context: ContextInfo; cost: number; busy: boolean; close: () => void; onCompact: () => void }) {
  const { t } = useI18n();
  const percent = Math.max(0, Math.min(100, context.tokens / Math.max(1, context.limit) * 100));
  return <Modal title={t("Context", "上下文")} close={close}>
    <div className="context-stats"><strong>~{context.tokens.toLocaleString()} <span>/ {context.limit.toLocaleString()} tokens</span></strong><span>{context.messageCount} {t("messages", "条消息")} · ${cost.toFixed(4)}</span></div>
    <div className={`context-progress ${percent > 80 ? "warning" : ""}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
    <p className="muted">{t("Estimated context usage", "预估上下文用量")}</p>
    <div className="context-breakdown">{context.components.map((part) => <div key={part.name}><span>{part.name === "system" ? t("System", "系统") : part.name === "tools" ? t("Tools", "工具") : part.name === "conversation" ? t("Conversation", "聊天") : part.name}</span><span>~{part.tokens.toLocaleString()} tokens</span></div>)}</div>
    <h3>{t("System instructions", "系统指令")}</h3><pre className="context-prompt">{context.systemPrompt}</pre>
    <h3>{t("Available skills", "可用技能")}</h3>{context.skills.map((skill) => <div className="skill-item" key={skill.path}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}
    <footer className="modal-actions"><button className="primary" disabled={busy} onClick={onCompact}>{t("Compact context", "压缩上下文")}</button></footer>
  </Modal>;
}

export function HelpModal({ close, commands }: { close: () => void; commands: { name: string; description: string }[] }) {
  const { t } = useI18n();
  return <Modal title={t("Commands and shortcuts", "命令和快捷键")} close={close}>
    <p className="muted">{t("Enter sends · Shift+Enter adds a line · Esc stops a running task · @ adds project files · Paste or drop files and images", "Enter 发送 · Shift+Enter 换行 · Esc 停止运行 · @ 添加项目文件 · 支持粘贴或拖入文件和图片")}</p>
    <div className="command-table">{commands.map((command) => <div className="command-help" key={command.name}><code>/{command.name}</code><span>{command.description}</span></div>)}</div>
    <h3>{t("Shortcuts", "快捷键")}</h3>
    <div className="shortcut-table">{[["⌘N", t("New chat", "新聊天")], ["⌘,", t("Settings", "设置")], ["⌘K", t("Search chats", "搜索聊天")], ["⌘F", t("Find in conversation", "在聊天中查找")], ["⌘B", t("Toggle sidebar", "切换侧栏")], ["⌘⇧D", t("Toggle review panel", "切换审阅面板")], ["⏎", t("Send", "发送")], ["⇧⏎", t("New line", "换行")], ["esc", t("Close menu or stop", "关闭菜单或停止运行")]].map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div>
  </Modal>;
}

export function AboutModal({ close }: { close: () => void }) {
  const { t } = useI18n();
  return <Modal title={t("About VoidKagami", "关于 VoidKagami")} close={close}><div className="about-content"><Emblem /><h3>VoidKagami</h3><p>{t("Personal agent harness", "个人 Agent 工作台")}</p><small>Version {VERSION}</small></div></Modal>;
}
