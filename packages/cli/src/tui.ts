import { resolve, extname, join, basename } from "node:path";
import { stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { TuiMainScreen, ProcessTerminal, Container, Text, Markdown, Editor, Input, CombinedAutocompleteProvider, matchesKey, CURSOR_MARKER, visibleWidth, truncateToWidth, getNativeClipboard } from "@voidkagami/tui";
import type { Component, MarkdownTheme, SelectItem, SelectListTheme, Terminal } from "@voidkagami/tui";
import { SessionStore, describeTool, formatDuration, modeText, modeTone, statusText, truncateEnd, truncateMiddle } from "@voidkagami/client";
import type { SocketClient, TranscriptItem } from "@voidkagami/client";
import { isBusy, VERSION } from "@voidkagami/protocol";
import type { Attachment, Session, SessionEvent, LiveEvent, PermissionMode, ModelSelection, Approval, SessionStatus } from "@voidkagami/protocol";
import { SearchPicker } from "./picker.ts";
import type { SearchPickerOptions } from "./picker.ts";
import { ModelPicker } from "./model-picker.ts";
import { ToolOutput } from "./tool-output.ts";
import { commands, commandName } from "./commands.ts";
import { t, setLanguage, statusLabel } from "./i18n.ts";
import { renderEmblem } from "./brand.ts";
import { accent, accent2, applyTerminalColors, bold, dim, green, italic, red, shimmer, strikethrough, tone, underline, warning, yellow } from "./theme.ts";

const identity = (text: string) => text;
export const selectTheme: SelectListTheme = { selectedMarker: "› ", selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
export const markdownTheme: MarkdownTheme = { heading: bold, link: accent, linkUrl: dim, code: identity, codeBlock: identity, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: identity, bold, italic, strikethrough, underline };
type TuiClient = Pick<SocketClient, "request" | "state"> & {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};
type InjectableTerminal = Terminal & { feedInput?: (data: string) => void };
export interface TuiHandle { render(width: number): string[]; input(data: string): void; exit(): void; }
export interface StartTuiOptions { terminal?: Terminal; onReady?: (handle: TuiHandle) => void; }

class BlankLine implements Component {
  render() { return [""]; }
  invalidate() {}
}

export class Prefixed implements Component {
  private prefix: string;
  private child: Component;
  private repeat: boolean;
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(prefix: string, child: Component, repeat = false) { this.prefix = prefix; this.child = child; this.repeat = repeat; }
  render(width: number) {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const prefixWidth = visibleWidth(this.prefix);
    const lines = this.child.render(Math.max(1, width - prefixWidth)).map((line, index) => {
      if (!line.trim()) return "";
      return `${index === 0 || this.repeat ? this.prefix : " ".repeat(prefixWidth)}${line}`;
    });
    this.cachedWidth = width; this.cachedLines = lines;
    return lines;
  }
  invalidate() { this.cachedWidth = undefined; this.cachedLines = undefined; this.child.invalidate(); }
}

export class WelcomeCard implements Component {
  private session: Session;
  constructor(session: Session) { this.session = session; }
  setSession(session: Session) { this.session = session; }
  invalidate() {}
  render(width: number) {
    const cwd = this.session.cwd.replace(homedir(), "~");
    const worktree = this.session.worktree ? ` ${t("⑂ worktree", "⑂ 工作树")}` : "";
    const info = [bold(`VoidKagami ${VERSION}`), dim(t("personal agent harness", "个人 Agent 工作台")), "", dim(`${cwd}${worktree}`), dim(`${t("Session", "会话")} ${this.session.id.slice(0, 8)} · ${this.session.title}`)];
    const hint = dim(t("/help for commands · shift+tab for mode · ctrl+o for details · @ for files", "/help 查看命令 · shift+tab 切换模式 · ctrl+o 展开详情 · @ 引用文件"));
    if (width < 60) return [...info.map((line) => truncateToWidth(line, width, "…")), truncateToWidth(hint, width, "…")];
    const inner = Math.max(1, width - 2);
    const logos = renderEmblem();
    const rightWidth = Math.max(1, inner - 14);
    const rows = info.map((line, index) => {
      const logo = logos[index] || "";
      const content = truncateToWidth(line, rightWidth);
      return `│${logo}${" ".repeat(Math.max(1, 12 - visibleWidth(logo) + 2))}${content}${" ".repeat(Math.max(0, rightWidth - visibleWidth(content)))}│`;
    });
    const top = dim(`╭${"─".repeat(inner)}╮`);
    const bottom = dim(`╰${"─".repeat(inner)}╯`);
    return [top, ...rows, bottom, truncateToWidth(hint, width, "…")];
  }
}

class Footer implements Component {
  private session?: Session;
  private context?: { tokens: number; limit: number };
  private cost = 0;
  private connection = "connected";
  private notice = "";
  set(session: Session, context: { tokens: number; limit: number } | undefined, cost: number, connection: string, notice: string) { this.session = session; this.context = context; this.cost = cost; this.connection = connection; this.notice = notice; }
  invalidate() {}
  render(width: number) {
    if (!this.session) return [];
    const session = this.session;
    let shortcut = this.notice ? "" : t(" · shift+tab", " · shift+tab");
    const leftBase = this.notice || tone(modeText(session.permissionMode, t, "long").trimStart(), modeTone(session.permissionMode));
    const leftText = () => `${leftBase}${dim(shortcut)}`;
    const connected = this.connection === "disconnected" || this.connection === "reconnecting" || this.connection === "connecting";
    const connection = connected ? `${warning(t(this.connection === "disconnected" ? "Disconnected" : "Reconnecting…", this.connection === "disconnected" ? "已断开" : "重新连接中…"))} ` : "";
    const effort = session.model.thinkingLevel && session.model.thinkingLevel !== "off" ? statusLabel(session.model.thinkingLevel) : "";
    const context = this.context ? `${Math.round(100 * this.context.tokens / this.context.limit)}%` : "";
    let includeEffort = Boolean(effort);
    let includeContext = Boolean(context);
    let includeCost = true;
    const rightText = () => `${connection}${session.model.provider}/${session.model.id}${includeEffort ? ` ${effort}` : ""}${includeContext ? ` · ${context}` : ""}${includeCost ? ` · $${this.cost.toFixed(4)}` : ""}`;
    while (visibleWidth(leftText()) + visibleWidth(rightText()) > width && includeCost) includeCost = false;
    while (visibleWidth(leftText()) + visibleWidth(rightText()) > width && includeContext) includeContext = false;
    while (visibleWidth(leftText()) + visibleWidth(rightText()) > width && includeEffort) includeEffort = false;
    while (visibleWidth(leftText()) + visibleWidth(rightText()) > width && shortcut) shortcut = "";
    const left = truncateToWidth(leftText(), width);
    const right = truncateToWidth(rightText(), Math.max(0, width - visibleWidth(left)));
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return [truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width)];
  }
}

export class Dialog extends Container {
  target: Component;
  private title: Text;
  private body: Text | undefined;
  private height: () => number;
  private bodyOffset = 0;
  private bodyRows = 1;
  private approval: boolean;
  constructor(title: string, body: string, target: Component, height: () => number, approval = false) {
    super(); this.target = target; this.height = height; this.approval = approval; this.title = new Text(bold(title), 0, 0);
    if (body) this.body = new Text(dim(body), 2, 0);
  }
  render(width: number) {
    const available = this.height();
    const title = this.title.render(width);
    const body = this.body?.render(width) || [];
    const rule = tone("─".repeat(width), this.approval ? "warning" : "accent");
    const reserveBody = Math.min(body.length, Math.max(0, Math.floor(available * 0.35)));
    if (this.target instanceof SearchPicker || this.target instanceof ModelPicker) this.target.setMaxVisible(available - title.length - reserveBody - (body.length ? 3 : 2));
    const controls = this.target.render(width);
    this.bodyRows = Math.min(body.length, Math.max(0, available - 1 - title.length - controls.length - (body.length ? 2 : 0)));
    this.bodyOffset = Math.max(0, Math.min(this.bodyOffset, body.length - this.bodyRows));
    const bodyLines = body.slice(this.bodyOffset, this.bodyOffset + this.bodyRows);
    const bodyHint = body.length > this.bodyRows ? [new Text(dim(`${t("Input", "输入")} ${this.bodyOffset + 1}–${Math.min(body.length, this.bodyOffset + this.bodyRows)}/${body.length} · ${t("PgUp/PgDn scroll", "PgUp/PgDn 滚动")}`), 0, 0).render(width)[0] || ""] : [];
    const preview = [rule, ...title, ...bodyLines, ...bodyHint, ...(body.length ? [""] : [])];
    this.clear();
    this.addChild({ render: () => preview, invalidate: () => {} });
    this.addChild(this.target);
    return super.render(width);
  }
  handleInput(data: string) {
    if (this.body && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) this.bodyOffset += (matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.bodyRows);
    else this.target.handleInput?.(data);
  }
}

class SecretInput extends Input {
  render(width: number) { return super.render(width).map((line) => line.split(CURSOR_MARKER).map((part) => "•".repeat(visibleWidth(part))).join(CURSOR_MARKER)); }
}

function modelSelection(value: string): ModelSelection {
  const at = value.indexOf("/");
  if (at <= 0) throw new Error(t("Use provider/model-id", "请使用 provider/model-id 格式"));
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

export function renderHelpText() {
  const list = commands();
  const nameWidth = Math.max(...list.map((item) => item.name.length)) + 2;
  const commandRows = list.map((item) => `  /${item.name.padEnd(nameWidth)}${item.description}`);
  const shortcuts: [string, string, string][] = [
    ["enter", "Send (steer while busy)", "发送（执行中为引导）"], ["shift+enter", "Insert a newline", "换行"], ["esc", "Stop, decline, or close", "停止、拒绝或关闭"],
    ["ctrl+c", "Clear input, stop, or exit", "清空输入、停止或退出"], ["ctrl+d", "Exit with empty input", "输入为空时退出"], ["ctrl+o", "Toggle full details", "展开或收起详情"],
    ["ctrl+v", "Paste clipboard content", "粘贴剪贴板内容"], ["shift+tab", "Cycle permission mode", "切换权限模式"], ["up/down", "Browse input history", "浏览输入历史"], ["tab", "Complete command or @file", "补全命令或 @文件"],
  ];
  const keyWidth = Math.max(...shortcuts.map(([key]) => key.length)) + 2;
  const keyboardRows = shortcuts.map(([key, en, zh]) => `  ${key.padEnd(keyWidth)}${t(en, zh)}`);
  return `${t("Commands", "命令")}\n${commandRows.join("\n")}\n\n${t("Keyboard", "快捷键")}\n${keyboardRows.join("\n")}`;
}

export async function startTui(client: TuiClient, initial: Session, initialPrompt = "", initialAttachments: Attachment[] = [], resume = false, options: StartTuiOptions = {}) {
  setLanguage((await client.request("config.get", {})).language);
  const store = new SessionStore();
  let sessionId = initial.id;
  let activeDialog: Dialog | undefined;
  let dismissDialog: (() => void) | undefined;
  let dialogApprovalId: string | undefined;
  let dialogLoginId: string | undefined;
  const dialogs: { show: () => void; cancel: () => void; loginId?: string }[] = [];
  let approvalId: string | undefined;
  let changingSession = false;
  let pickingInitialSession = resume;
  let stopped = false;
  let notice = "";
  let noticeTone: "error" | "info" = "info";
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let details = false;
  let loginId: string | undefined;
  let pendingLogin: { cancelled: boolean; promise: Promise<void> } | undefined;
  const authBacklog: Record<string, unknown>[] = [];
  let pendingAttachments = initialAttachments;
  const drafts = new Map<string, { text: string; attachments: Attachment[] }>();
  const terminal = options.terminal || new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, true);
  const header = new WelcomeCard(initial);
  const transcript = new Container();
  const streaming = new Container();
  const feedback = new Container();
  const editor = new Editor(tui, { borderColor: dim, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8, prompt: `${accent("›")} `, placeholder: t("Message · / commands · @ files", "输入消息 · / 命令 · @ 文件") });
  const attachmentLine = new Text("", 2, 0);
  const footer = new Footer();
  const inputArea = new Container();
  inputArea.addChild(attachmentLine); inputArea.addChild(editor); inputArea.addChild(footer);
  tui.addChild(header); tui.addChild(transcript); tui.addChild(streaming); tui.addChild(feedback); tui.addChild(inputArea);
  const transcriptCache = new Map<string, { signature: string; components: Component[] }>();
  const extraTranscript = new Map<string, Component[][]>();
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let finish: () => void = () => {};
  const completed = new Promise<void>((resolveDone) => { finish = resolveDone; });

  const handle: TuiHandle = {
    render: (width) => tui.render(width),
    input: (data) => (terminal as InjectableTerminal).feedInput?.(data),
    exit: () => finish(),
  };
  function closeDialog() { dismissDialog?.(); }
  function setNotice(value: string, valueTone: "error" | "info" = "info") {
    notice = value; noticeTone = valueTone; clearTimeout(noticeTimer);
    if (value) noticeTimer = setTimeout(() => { notice = ""; noticeTone = "info"; render(); }, 5000);
  }
  function report(error: unknown) { setNotice(error instanceof Error ? error.message : String(error), "error"); render(); }
  function execute(action: () => Promise<unknown>) { void action().catch(report); }
  function nextDialog() {
    if (activeDialog || stopped) return;
    dialogs.shift()?.show();
  }
  function showDialog(title: string, body: string, create: (finish: (value?: string) => void) => Component, approval?: Approval, authId?: string): Promise<string | undefined> {
    if (stopped) return Promise.resolve(undefined);
    return new Promise((resolveDialog) => {
      const request = {
        loginId: authId,
        cancel: () => resolveDialog(undefined),
        show: () => {
          if (stopped || (approval && !store.get(approval.sessionId)?.approvals.some((item) => item.id === approval.id)) || (authId && authId !== loginId)) { resolveDialog(undefined); nextDialog(); return; }
          let settled = false;
          const finishDialog = (value?: string) => {
            if (settled) return;
            settled = true;
            activeDialog = undefined; inputArea.clear(); inputArea.addChild(attachmentLine); inputArea.addChild(editor); inputArea.addChild(footer); dismissDialog = undefined; dialogApprovalId = undefined; dialogLoginId = undefined;
            tui.setFocus(editor); resolveDialog(value);
            queueMicrotask(() => { nextDialog(); render(); });
          };
          dismissDialog = () => finishDialog(); dialogApprovalId = approval?.id; dialogLoginId = authId;
          const height = () => Math.max(3, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.85)));
          activeDialog = new Dialog(title, body, create(finishDialog), height, Boolean(approval));
          inputArea.clear(); inputArea.addChild(new BlankLine()); inputArea.addChild(activeDialog);
          tui.setFocus(activeDialog); tui.requestRender();
        },
      };
      dialogs.push(request); nextDialog();
    });
  }
  function choose(title: string, items: SelectItem[], body = "", approval?: Approval, pickerOptions: SearchPickerOptions = {}): Promise<string | undefined> {
    return showDialog(title, body, (finishDialog) => {
      const choices = new SearchPicker(items, selectTheme, pickerOptions);
      choices.onSelect = finishDialog;
      choices.onCancel = () => finishDialog();
      return choices;
    }, approval);
  }
  function ask(title: string, body = "", secret = false, approval?: Approval, authId?: string): Promise<string | undefined> {
    return showDialog(title, body, (finishDialog) => {
      const input = secret ? new SecretInput({ prompt: "" }) : new Input();
      input.focused = true;
      input.onSubmit = finishDialog;
      input.onEscape = () => finishDialog();
      return input;
    }, approval, authId);
  }
  function showText(title: string, body: string) {
    const content = extraTranscript.get(sessionId) || [];
    content.push([new Text(bold(title), 0, 0), new Markdown(body, 0, 0, markdownTheme)]);
    extraTranscript.set(sessionId, content); render();
  }

  async function attach(session: Session) {
    changingSession = true;
    try {
      if (sessionId !== session.id) {
        drafts.set(sessionId, { text: editor.getText(), attachments: pendingAttachments });
        await client.request("session.detach", { sessionId });
        const draft = drafts.get(session.id);
        editor.setText(draft?.text || ""); pendingAttachments = draft?.attachments || [];
      }
      sessionId = session.id;
      store.attach(await client.request("session.attach", { sessionId }));
      header.setSession(session); setNotice("");
      const customCommands = await client.request("commands.list", { cwd: session.cwd });
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands(), ...customCommands], session.cwd));
    } finally { changingSession = false; render(); }
  }

  function approvalBody(approval: Approval): string {
    if (approval.question) return approval.question;
    if (approval.tool === "bash") return `$ ${String(approval.args.command || "")}`;
    const item = { id: approval.id, seq: 0, role: "tool" as const, text: "", event: { id: approval.id, sessionId: approval.sessionId, parentId: null, seq: 0, timestamp: "", type: "tool.call", data: {} }, tool: approval.tool, toolArgs: approval.args } satisfies TranscriptItem;
    const description = describeTool(item, t, store.get(approval.sessionId)?.session.cwd);
    if (["write", "edit", "apply_patch"].includes(approval.tool)) return `${description.target}${description.added ? `  ${green(`+${description.added}`)}` : ""}${description.removed ? ` ${red(`−${description.removed}`)}` : ""}`;
    const detail = Object.values(approval.args).find((value): value is string => typeof value === "string");
    return detail || approval.tool;
  }
  async function approve(approval: Approval) {
    approvalId = approval.id;
    try {
      const title = approval.question ? t("Question", "问题") : approval.tool === "bash" ? t("Allow running this command?", "允许运行此命令？") : ["write", "edit", "apply_patch"].includes(approval.tool) ? t("Allow file changes?", "允许修改文件？") : t(`Allow ${approval.tool}?`, `允许 ${approval.tool}？`);
      const option = approval.question
        ? await choose(title, [...(approval.options || []).map((value) => ({ label: value, value })), { label: t("Write an answer…", "输入回答…"), value: "__answer" }], approvalBody(approval), approval, { searchable: false, quickPickCount: 4, hint: t("↑↓ select · enter confirm · 1-4 quick pick · esc stop", "↑↓ 选择 · enter 确认 · 1-4 快选 · esc 停止") })
        : await choose(title, [{ label: t("Allow once", "仅允许一次"), value: "allow" }, { label: t("Allow for this project", "对此项目允许"), value: "project" }, { label: t("Always allow", "始终允许"), value: "global" }, { label: t("Deny", "拒绝"), value: "deny" }], approvalBody(approval), approval, { searchable: false, quickPickCount: 4, hint: t("↑↓ select · enter confirm · 1-4 quick pick · esc deny", "↑↓ 选择 · enter 确认 · 1-4 快选 · esc 拒绝") });
      let answer = option;
      if (option === "__answer") answer = await ask(t("Your answer", "你的回答"), approval.question, false, approval);
      if (stopped || !store.get(approval.sessionId)?.approvals.some((item) => item.id === approval.id)) return;
      if (answer === undefined && approval.question) await client.request("session.abort", { sessionId: approval.sessionId });
      else await client.request("approval.respond", { approvalId: approval.id, allow: answer !== undefined && (approval.question ? true : option !== "deny"), answer: approval.question ? answer : undefined, remember: option === "project" || option === "global" ? option : undefined });
    } finally { if (approvalId === approval.id) approvalId = undefined; render(); }
  }

  function itemComponents(item: TranscriptItem, state: NonNullable<ReturnType<SessionStore["get"]>>): Component[] {
    if (item.role === "assistant") {
      const block = new Container();
      if (item.thinking && details) block.addChild(new Prefixed(dim("┊ "), new Text(italic(item.thinking), 0, 0), true));
      if (item.text) block.addChild(new Prefixed(accent(bold("✦ ")), new Markdown(item.text, 0, 0, markdownTheme)));
      return block.children.length ? [block] : [];
    }
    if (item.role === "user") {
      const status = item.inputKind ? dim(` · ${item.inputKind === "steer" ? t("steered", "已引导") : t("follow-up", "已排队")}${item.delivery === "queued" ? ` · ${t("queued", "已排队")}` : ""}`) : "";
      const attachments = item.attachments?.length ? `\n${dim(item.attachments.map((file) => `[${file.type}: ${basename(file.path)}]`).join(" "))}` : "";
      return [new Prefixed(`${accent(bold("›"))} `, new Text(`${item.text}${status}${attachments}`, 0, 0))];
    }
    if (item.role === "tool") return item.tool === "todo" ? [] : [new ToolOutput(item, state.session.cwd, details, () => spinnerFrame)];
    if (item.kind === "plan") {
      if (item.id !== state.planItemId) return [new Text(dim(t("Updated plan", "更新了计划")), 0, 0)];
      const block = new Container();
      block.addChild(new Text(bold(t("Plan", "计划")), 0, 0));
      for (const task of item.plan || []) {
        const marker = task.status === "completed" ? green("✓") : task.status === "in_progress" ? accent("▸") : dim("◦");
        const text = task.status === "completed" ? dim(task.content) : task.status === "in_progress" ? bold(task.content) : task.content;
        block.addChild(new Prefixed(`  ${marker} `, new Text(text, 0, 0)));
      }
      return [block];
    }
    if (item.kind === "turn") {
      if (!item.hasTools && (item.durationMs || 0) < 10000) return [];
      const duration = formatDuration(item.durationMs || 0, t);
      const line = item.turnStatus === "failed" ? t(`Failed after ${duration}`, `${duration} 后失败`) : item.turnStatus === "interrupted" ? t(`Stopped after ${duration}`, `${duration} 后停止`) : t(`Worked for ${duration}`, `工作了 ${duration}`);
      return [new Text(tone(`  ─ ${line} ─`, item.turnStatus === "failed" ? "danger" : item.turnStatus === "interrupted" ? "warning" : "muted"), 0, 0)];
    }
    const message = item.text || t("Context updated", "上下文已更新");
    return [new Prefixed(item.error ? red("✗ ") : dim("· "), new Text(message, 0, 0))];
  }

  function renderHelp() { return renderHelpText(); }

  function transcriptBlocks(state: NonNullable<ReturnType<SessionStore["get"]>>) {
    const blocks: { components: Component[]; tool: boolean }[] = [];
    const present = new Set<string>();
    for (const item of state.transcript) {
      const key = `${sessionId}:${item.id}`;
      present.add(key);
      const signature = JSON.stringify([item.role, item.text, item.thinking, item.tool, item.toolArgs, item.toolStatus, item.error, item.inputKind, item.delivery, item.attachments, item.kind, item.plan, item.turnStatus, item.durationMs, item.hasTools, state.planItemId === item.id, details, state.session.cwd]);
      let cached = transcriptCache.get(key);
      if (!cached || cached.signature !== signature) { cached = { signature, components: itemComponents(item, state) }; transcriptCache.set(key, cached); }
      if (cached.components.length) blocks.push({ components: cached.components, tool: item.role === "tool" });
    }
    for (const key of transcriptCache.keys()) if (key.startsWith(`${sessionId}:`) && !present.has(key)) transcriptCache.delete(key);
    for (const components of extraTranscript.get(sessionId) || []) blocks.push({ components, tool: false });
    return blocks;
  }

  function renderTranscript(state: NonNullable<ReturnType<SessionStore["get"]>>) {
    const blocks = transcriptBlocks(state);
    transcript.clear();
    if (blocks.length) transcript.addChild(new BlankLine());
    blocks.forEach((block, index) => {
      if (index > 0 && !(blocks[index - 1]!.tool && block.tool)) transcript.addChild(new BlankLine());
      for (const component of block.components) transcript.addChild(component);
    });
    return blocks.length > 0;
  }

  function renderStreaming(state: NonNullable<ReturnType<SessionStore["get"]>>) {
    streaming.clear();
    const blocks: Component[] = [];
    if (details && state.thinking) blocks.push(new Prefixed(dim("┊ "), new Text(italic(state.thinking), 0, 0), true));
    if (state.streaming) blocks.push(new Prefixed(accent(bold("✦ ")), new Markdown(state.streaming, 0, 0, markdownTheme)));
    if (!blocks.length) return false;
    streaming.addChild(new BlankLine());
    for (let index = 0; index < blocks.length; index++) {
      if (index > 0) streaming.addChild(new BlankLine());
      streaming.addChild(blocks[index]!);
    }
    return true;
  }

  let statusState: { busy: boolean; approval: boolean; activity: string; turnStartedAt?: string; progress: string[] } = { busy: false, approval: false, activity: "", progress: [] };
  function updateFeedback() {
    const { busy, approval, activity, turnStartedAt, progress } = statusState;
    const elapsed = turnStartedAt ? formatDuration(Date.now() - Date.parse(turnStartedAt), t) : "";
    const phase = (Math.floor(Date.now() / 100) % 20) / 20;
    const statusLine = busy ? `${accent(spinnerFrames[spinnerFrame % spinnerFrames.length]!)} ${approval ? warning(activity) : shimmer(activity, phase)}${elapsed ? dim(` · ${elapsed}`) : ""} · ${dim(t("esc to stop", "esc 停止"))}` : "";
    feedback.clear();
    if (statusLine || progress.length) {
      feedback.addChild(new BlankLine());
      if (statusLine) feedback.addChild(new Text(statusLine, 0, 0));
      if (progress.length) {
        feedback.addChild(new Prefixed(dim("  └ "), new Text(dim(progress[0]!), 0, 0)));
        for (const line of progress.slice(1)) feedback.addChild(new Text(dim(line), 4, 0));
      }
    }
  }

  function renderDynamic(state: NonNullable<ReturnType<SessionStore["get"]>>) {
    const busy = isBusy(state.session.status);
    let activity = "";
    const approval = state.approvals.length > 0;
    if (busy) {
      if (approval) activity = t("Needs approval", "等待审批");
      else {
        const runningTool = [...state.transcript].reverse().find((item) => item.role === "tool" && item.toolStatus === "running");
        if (runningTool) { const description = describeTool(runningTool, t, state.session.cwd); const targetWidth = Math.max(8, tui.terminal.columns - 42); const target = runningTool.tool === "bash" ? truncateEnd(description.target, targetWidth) : truncateMiddle(description.target, targetWidth); activity = `${description.activeVerb}${description.target ? ` ${target}` : ""}`; }
        else if (state.thinking) activity = t("Thinking", "思考中");
        else if (state.streaming) activity = t("Replying", "正在回复");
        else activity = statusText(state.session.status as SessionStatus, t);
      }
    }
    const progress = state.progress ? (details ? state.progress.split("\n") : state.progress.split("\n").slice(0, 3)).slice(0, 3) : [];
    statusState = { busy, approval, activity, turnStartedAt: state.turnStartedAt, progress };
    editor.placeholder = busy ? t("Add direction · enter steers · /queue follows up", "补充指令，enter 引导 · /queue 排队") : t("Message · / commands · @ files", "输入消息 · / 命令 · @ 文件");
    editor.borderColor = state.session.permissionMode === "ask" ? dim : state.session.permissionMode === "accept_edits" ? accent : state.session.permissionMode === "auto" ? yellow : accent2;
    attachmentLine.setText(pendingAttachments.length ? dim(`${pendingAttachments.map((file) => `[${basename(file.path)}]`).join(" ")} · ${t("/attachments to remove", "/attachments 移除")}`) : "");
    footer.set(state.session, state.context, state.cost, client.state, notice ? noticeTone === "error" ? red(notice) : notice : "");
    updateFeedback();
  }

  function render() {
    const state = store.get(sessionId);
    if (!state || stopped) return;
    renderTranscript(state);
    renderStreaming(state);
    renderDynamic(state);
    tui.requestRender();
    if (approvalId && !state.approvals.some((approval) => approval.id === approvalId)) { if (dialogApprovalId === approvalId) closeDialog(); approvalId = undefined; }
    if (state.approvals.length && !activeDialog && !dialogs.length && !approvalId && !changingSession && !pickingInitialSession) execute(() => approve(state.approvals[0]!));
  }

  function animate() {
    if (stopped || !statusState.busy) return;
    spinnerFrame++;
    updateFeedback();
    tui.requestRender();
  }

  async function slash(text: string) {
    const [name, ...parts] = text.slice(1).split(/\s+/);
    const command = commandName(name || "");
    const arg = parts.join(" ");
    const state = store.get(sessionId)!;
    const session = state.session;
    if (command === "exit") { finish(); return; }
    if (command === "help") { showText(t("Help", "帮助"), renderHelp()); return; }
    if (command === "details") { details = !details; render(); return; }
    if (command === "attach") { if (!arg) throw new Error(t("Usage: /attach <path>", "用法：/attach <路径>")); const path = resolve(session.cwd, arg); if (!(await stat(path)).isFile()) throw new Error(t("Choose a file", "请选择文件")); pendingAttachments.push({ type: /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "file", path }); render(); return; }
    if (command === "attachments") { const selected = await choose(t("Remove attachment", "移除附件"), pendingAttachments.map((file, index) => ({ value: String(index), label: basename(file.path), description: file.path }))); if (selected !== undefined) pendingAttachments.splice(Number(selected), 1); render(); return; }
    if (command === "cancel-login") {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
      loginId = undefined; setNotice(t("Sign-in cancelled", "已取消登录")); render(); return;
    }
    if (command === "new") { await attach(await client.request("session.create", { cwd: arg ? resolve(session.cwd, arg) : session.projectPath || session.cwd, model: session.model, permissionMode: session.permissionMode })); return; }
    if (command === "resume") {
      const sessions = await client.request("session.list", { query: arg || undefined });
      const selected = await choose(t("Resume session", "恢复会话"), sessions.map((item) => ({ value: item.id, label: item.title, description: `${statusLabel(item.status)} · ${item.cwd}` })));
      const next = sessions.find((item) => item.id === selected); if (next) await attach(next); return;
    }
    if (command === "archive") {
      await client.request("session.archive", { sessionId, archived: true });
      const sessions = await client.request("session.list", {});
      await attach(sessions.find((item) => item.cwd === session.cwd) || await client.request("session.create", { cwd: session.cwd, model: session.model, permissionMode: session.permissionMode })); return;
    }
    if (command === "archived") {
      const sessions = await client.request("session.list", { archived: true, query: arg || undefined });
      const selected = await choose(t("Restore session", "恢复已归档会话"), sessions.map((item) => ({ value: item.id, label: item.title, description: item.cwd })));
      if (selected) await attach(await client.request("session.archive", { sessionId: selected, archived: false })); return;
    }
    if (command === "model") {
      const models = (await client.request("model.list", {})).filter((model) => model.authenticated);
      models.sort((a, b) => Number(b.provider === session.model.provider && b.id === session.model.id) - Number(a.provider === session.model.provider && a.id === session.model.id));
      if (!models.length) { setNotice(t("No available models. Use /login to connect a provider.", "暂无可用模型，请使用 /login 登录服务商。")); render(); return; }
      let selection: ModelSelection | undefined;
      if (arg) {
        const requested = modelSelection(arg);
        if (!models.some((model) => model.provider === requested.provider && model.id === requested.id)) throw new Error(t("This model is unavailable. Use /login or choose an available model.", "该模型不可用，请使用 /login 登录或选择可用模型。"));
        selection = requested;
      } else {
        await showDialog(t("Choose model", "选择模型"), "", (finishDialog) => {
          const picker = new ModelPicker(models, session.model, selectTheme);
          picker.onSelect = (model) => { selection = model; finishDialog(); };
          picker.onCancel = () => finishDialog();
          return picker;
        });
      }
      if (selection) { store.updateSession(await client.request("model.select", { sessionId, model: selection })); setNotice(t("Model changed", "模型已切换")); render(); } return;
    }
    if (command === "language") {
      const language = arg || await choose(t("Language", "语言"), [{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }], "", undefined, { searchable: false, quickPickCount: 2 });
      if (language) {
        if (language !== "zh-CN" && language !== "en") throw new Error(t("Choose zh-CN or en", "请选择 zh-CN 或 en"));
        setLanguage((await client.request("config.set", { language })).language);
        const customCommands = await client.request("commands.list", { cwd: session.cwd });
        editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands(), ...customCommands], session.cwd));
        transcriptCache.clear(); setNotice(""); render();
      } return;
    }
    if (command === "effort") {
      const model = (await client.request("model.list", {})).find((item) => item.provider === session.model.provider && item.id === session.model.id)!;
      const level = arg || await choose(t("Thinking effort", "思考能力"), model.thinkingLevels.map((value) => ({ value, label: `${value === (session.model.thinkingLevel || "off") ? "✓ " : ""}${statusLabel(value)}` })), "", undefined, { searchable: false, quickPickCount: model.thinkingLevels.length });
      if (level) { store.updateSession(await client.request("model.select", { sessionId, model: { ...session.model, thinkingLevel: level as ModelSelection["thinkingLevel"] } })); setNotice(t("Model changed", "模型已切换")); render(); } return;
    }
    if (command === "mode") {
      const mode = arg || await choose(t("Permission mode", "权限模式"), [{ label: t("Ask before changes", "修改前询问"), value: "ask" }, { label: t("Accept file edits", "允许文件编辑"), value: "accept_edits" }, { label: t("Fully automatic", "完全自动"), value: "auto" }, { label: t("Plan (read only)", "规划（只读）"), value: "plan" }], "", undefined, { searchable: false, quickPickCount: 4 });
      if (mode) { store.updateSession(await client.request("session.mode", { sessionId, mode: mode as PermissionMode })); setNotice(t("Permission mode changed", "权限模式已切换")); render(); } return;
    }
    if (command === "context") { const context = await client.request("session.context", { sessionId }); store.setContext(sessionId, context); showText(t("Context", "上下文"), `${t("Approximately", "约")} ${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens · ${context.messageCount} ${t("messages", "条消息")}\n\n${context.components.map((part) => `- ${part.name}: ~${part.tokens.toLocaleString()} tokens`).join("\n")}\n\n${context.systemPrompt}`); return; }
    if (command === "compact") { await client.request("session.compact", { sessionId }); setNotice(t("Context compacted", "上下文已压缩")); render(); return; }
    if (command === "fork" || command === "rewind") {
      const turns = state.transcript.filter((item) => item.event.type === "user.message" || item.event.type === "assistant.message");
      const eventId = arg || await choose(command === "fork" ? t("Fork from message", "从消息分叉") : t("Rewind to message and restore files", "回退到消息并恢复文件"), turns.map((item) => ({ value: item.id, label: item.text.slice(0, 70), description: `${statusLabel(item.role)} · ${item.seq}` })).reverse());
      if (eventId) {
        const choice = await choose(command === "fork" ? t("Fork workspace", "分叉工作区") : t("Restore to selected message", "恢复到所选消息"), command === "fork" ? [{ label: t("Same workspace", "相同工作区"), value: "conversation" }, { label: t("Isolated Git worktree", "隔离的 Git 工作树"), value: "files" }] : [{ label: t("Conversation only", "仅会话"), value: "conversation" }, { label: t("Conversation and files", "会话与文件"), value: "files" }], "", undefined, { searchable: false, quickPickCount: 2 });
        if (choice) { const next = command === "fork" ? await client.request("session.fork", { sessionId, eventId, worktree: choice === "files" }) : await client.request("session.rewind", { sessionId, eventId, restoreFiles: choice === "files" }); await attach(next); }
      } return;
    }
    if (command === "diff") { const { diff } = await client.request("session.diff", { sessionId, eventId: arg || undefined }); showText(t("Changes", "变更"), diff ? `\`\`\`diff\n${diff}\n\`\`\`` : t("No changes.", "暂无变更。")); return; }
    if (command === "tasks" || command === "stop") {
      const tasks = await client.request("session.tasks", { sessionId });
      if (command === "tasks") {
        const children = (await client.request("session.list", {})).filter((item) => item.parentSessionId === sessionId);
        showText(t("Background tasks", "后台任务"), tasks.length ? tasks.map((task) => `**${task.id}** ${statusLabel(task.status)}\n\`\`\`\n${task.command}\n${task.output}\n\`\`\``).join("\n\n") : t("No background tasks.", "暂无后台任务。"));
        if (children.length) { const selected = await choose(t("Agent sessions", "子 Agent 会话"), children.map((child) => ({ value: child.id, label: child.title, description: `${statusLabel(child.status)}${child.status === "waiting_approval" ? t(" · needs your input", " · 等待你的操作") : ""}` }))); const child = children.find((item) => item.id === selected); if (child) await attach(child); }
      }
      else { const taskId = arg || await choose(t("Stop background task", "停止后台任务"), tasks.filter((task) => task.status === "running").map((task) => ({ label: task.command, value: task.id }))); if (taskId) await client.request("task.stop", { sessionId, taskId }); } return;
    }
    if (command === "queue") { if (!arg) throw new Error(t("Usage: /queue <message>", "用法：/queue <消息>")); await client.request("session.followUp", { sessionId, text: arg, attachments: await references(arg) }); setNotice(t("Message queued", "消息已排队")); render(); return; }
    if (command === "rename") { const title = arg || await ask(t("Session title", "会话名称")); if (title) store.updateSession(await client.request("session.rename", { sessionId, title })); return; }
    if (command === "settings") { showText(t("Configuration", "配置"), `\`\`\`json\n${JSON.stringify(await client.request("config.get", {}), null, 2)}\n\`\`\`\n${t("Change configuration with", "修改配置")}: voidkagami config <key> '<json>'\n/language · ${t("Choose interface language", "切换界面语言")}`); return; }
    if (command === "logout") { if (!arg) throw new Error(t("Usage: /logout <provider>", "用法：/logout <服务商>")); await client.request("auth.logout", { provider: arg }); setNotice(t(`Signed out of ${arg}`, `已退出 ${arg}`)); render(); return; }
    if (command === "login") {
      const provider = arg || await choose(t("Connect provider", "连接服务商"), [{ label: t("ChatGPT subscription", "ChatGPT 订阅"), value: "openai" }, { label: t("DeepSeek API key", "DeepSeek API 密钥"), value: "deepseek" }, { label: t("Anthropic API key", "Anthropic API 密钥"), value: "anthropic" }], "", undefined, { searchable: false, quickPickCount: 3 });
      if (!provider) return;
      if (provider === "openai") {
        if (pendingLogin || loginId) throw new Error(t("A login is already in progress", "已有登录正在进行"));
        const pending: { cancelled: boolean; promise: Promise<void> } = {
          cancelled: false,
          promise: client.request("auth.login", { provider }).then(async (result) => {
            loginId = result.loginId;
            if (pending.cancelled || stopped) { await client.request("auth.cancel", { loginId }); loginId = undefined; }
          }).finally(() => {
            pendingLogin = undefined;
            const events = authBacklog.splice(0);
            if (!pending.cancelled && !stopped) for (const event of events) onAuth(event);
          }),
        };
        pendingLogin = pending;
        await pending.promise;
      }
      else { const apiKey = await ask(`${provider} ${t("API key", "API 密钥")}`, "", true); if (apiKey) { await client.request("auth.key", { provider, apiKey }); setNotice(t(`Signed in to ${provider}`, `已登录 ${provider}`)); render(); } } return;
    }
    await send(text);
  }

  async function references(text: string): Promise<Attachment[]> {
    const state = store.get(sessionId)!;
    const attachments: Attachment[] = [];
    const paths = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/g)].map((match) => match[1] || match[2]!);
    for (const path of paths) {
      const fullPath = resolve(state.session.cwd, path);
      if ((await stat(fullPath)).isFile()) attachments.push({ type: /\.(png|jpe?g|gif|webp)$/i.test(extname(fullPath)) ? "image" : "file", path: fullPath });
    }
    return attachments;
  }

  async function send(text: string, attachments: Attachment[] = []) {
    const state = store.get(sessionId)!;
    attachments = [...attachments, ...await references(text)];
    setNotice("");
    if (isBusy(state.session.status)) await client.request("session.steer", { sessionId, text, attachments });
    else await client.request("session.send", { sessionId, text, attachments });
  }

  const onEvent = (event: SessionEvent) => { store.event(event); if (event.type === "turn.ended" && event.sessionId === sessionId) execute(async () => store.setContext(sessionId, await client.request("session.context", { sessionId }))); };
  const onLive = (event: LiveEvent) => store.live(event);
  const onReplay = (view: Parameters<SessionStore["attach"]>[0]) => store.attach(view);
  const onAuth = (event: Record<string, unknown>) => {
    if (pendingLogin) { authBacklog.push(event); return; }
    if (event.loginId !== loginId) return;
    const authId = String(event.loginId);
    if (event.type === "url") { showText(t("Sign in with ChatGPT", "登录 ChatGPT"), `${event.url}\n\n${event.instructions || t("Open this URL in your browser.", "请在浏览器中打开此链接。")}`); }
    if (event.type === "prompt") execute(async () => { const value = await ask(String(event.message || t("Authorization code", "授权码")), "", false, undefined, authId); if (stopped || authId !== loginId) return; if (value) await client.request("auth.respond", { loginId: authId, value }); else await client.request("auth.cancel", { loginId: authId }); });
    if (event.type === "complete" || event.type === "error" || event.type === "cancelled") {
      loginId = undefined;
      for (let index = dialogs.length - 1; index >= 0; index--) if (dialogs[index]!.loginId === authId) dialogs.splice(index, 1)[0]!.cancel();
      if (dialogLoginId === authId) closeDialog();
    }
    if (event.type === "complete" || event.type === "error" || event.type === "progress" || event.type === "cancelled") { setNotice(String(event.message || (event.type === "complete" ? t("Signed in with ChatGPT", "已登录 ChatGPT") : event.type)), event.type === "error" ? "error" : "info"); render(); }
  };
  client.on("event", onEvent); client.on("live", onLive); client.on("replay", onReplay); client.on("auth", onAuth); client.on("state", render); client.on("connectionError", report);
  const unsubscribe = store.subscribe(render);
  editor.onSubmit = (text) => {
    if (!text.trim() && !pendingAttachments.length) return;
    const submittedSession = sessionId;
    const submittedAttachments = pendingAttachments;
    if (!text.startsWith("/")) pendingAttachments = [];
    void (text.startsWith("/") ? slash(text) : send(text, submittedAttachments)).then(() => { editor.addToHistory(text); render(); }).catch((error) => {
      if (sessionId === submittedSession) { editor.setText([text, editor.getText()].filter(Boolean).join("\n")); if (!text.startsWith("/")) pendingAttachments = [...submittedAttachments, ...pendingAttachments]; }
      else { const draft = drafts.get(submittedSession); drafts.set(submittedSession, { text: [text, draft?.text].filter(Boolean).join("\n"), attachments: [...submittedAttachments, ...(draft?.attachments || [])] }); }
      report(error);
    });
  };
  tui.addInputListener((data) => {
    if (activeDialog) return undefined;
    if (matchesKey(data, "ctrl+o")) { details = !details; render(); return { consume: true }; }
    if (matchesKey(data, "shift+tab")) { const modes: PermissionMode[] = ["ask", "accept_edits", "auto", "plan"]; const current = store.get(sessionId)!.session.permissionMode; execute(async () => { store.updateSession(await client.request("session.mode", { sessionId, mode: modes[(modes.indexOf(current) + 1) % modes.length]! })); setNotice(t("Permission mode changed", "权限模式已切换")); render(); }); return { consume: true }; }
    if (matchesKey(data, "ctrl+v")) {
      execute(async () => {
        const clipboard = getNativeClipboard();
        if (!clipboard) throw new Error(t("Clipboard is unavailable in this terminal. Use /attach <path>.", "此终端无法读取剪贴板，请使用 /attach <路径>。"));
        const image = await clipboard.getImage();
        if (image) { const directory = join(process.env.VOIDKAGAMI_HOME || join(homedir(), ".voidkagami"), "attachments"); await mkdir(directory, { recursive: true }); const path = join(directory, `${randomUUID()}.png`); await writeFile(path, image, { mode: 0o600 }); pendingAttachments.push({ type: "image", path }); }
        else { const text = await clipboard.getText(); if (text) editor.insertTextAtCursor(text); }
        render();
      }); return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && !editor.getText()) { finish(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) { if (editor.getText()) { editor.setText(""); tui.requestRender(); } else if (isBusy(store.get(sessionId)!.session.status)) execute(() => client.request("session.abort", { sessionId })); else finish(); return { consume: true }; }
    if (matchesKey(data, "escape") && !activeDialog && isBusy(store.get(sessionId)!.session.status)) { execute(() => client.request("session.abort", { sessionId })); return { consume: true }; }
    return undefined;
  });
  try {
    tui.setFocus(editor); tui.start(); applyTerminalColors(tui, render);
    animationTimer = setInterval(animate, 80);
    await attach(initial);
    options.onReady?.(handle);
    if (resume) { try { await slash("/resume"); } finally { pickingInitialSession = false; render(); } }
    if (initialPrompt || initialAttachments.length) { await send(initialPrompt, initialAttachments); pendingAttachments = []; }
    await completed;
  } finally {
    stopped = true; clearInterval(animationTimer); clearTimeout(noticeTimer); closeDialog(); for (const dialog of dialogs.splice(0)) dialog.cancel();
    try {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
    } finally {
      unsubscribe(); tui.stop();
      client.off("event", onEvent); client.off("live", onLive); client.off("replay", onReplay); client.off("auth", onAuth); client.off("state", render); client.off("connectionError", report);
    }
  }
}
