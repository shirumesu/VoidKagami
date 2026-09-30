import { resolve, extname, join, basename } from "node:path";
import { stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { TuiMainScreen, ProcessTerminal, Container, Text, Markdown, Editor, Input, CombinedAutocompleteProvider, matchesKey, CURSOR_MARKER, visibleWidth, getNativeClipboard } from "@voidkagami/tui";
import type { Component, MarkdownTheme, SelectItem, SelectListTheme } from "@voidkagami/tui";
import { SessionStore } from "@voidkagami/client";
import type { SocketClient } from "@voidkagami/client";
import { isBusy } from "@voidkagami/protocol";
import type { Attachment, Session, SessionEvent, LiveEvent, PermissionMode, ModelSelection, Approval } from "@voidkagami/protocol";
import { SearchPicker } from "./picker.ts";
import { ModelPicker } from "./model-picker.ts";
import { ToolOutput } from "./tool-output.ts";
import { commands, commandName } from "./commands.ts";
import { t, setLanguage, statusLabel } from "./i18n.ts";

const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
const identity = (text: string) => text;
const selectTheme: SelectListTheme = { selectedPrefix: bold, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme: MarkdownTheme = { heading: bold, link: identity, linkUrl: dim, code: identity, codeBlock: identity, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: identity, bold, italic: (text) => `\x1b[3m${text}\x1b[23m`, strikethrough: (text) => `\x1b[9m${text}\x1b[29m`, underline: (text) => `\x1b[4m${text}\x1b[24m` };

class Dialog extends Container {
  target: Component;
  private title: Text;
  private body: Text | undefined;
  private height: () => number;
  private bodyOffset = 0;
  private bodyRows = 1;
  constructor(title: string, body: string, target: Component, height: () => number) {
    super(); this.target = target; this.height = height; this.title = new Text(bold(title), 1, 0);
    if (body) this.body = new Text(body, 1, 0);
  }
  render(width: number) {
    const available = this.height();
    const title = this.title.render(width).slice(0, 2);
    const body = this.body?.render(width) || [];
    const previewRows = body.length ? Math.min(8, Math.max(1, Math.floor((available - title.length - 5) / 2))) : 0;
    if (this.target instanceof SearchPicker || this.target instanceof ModelPicker) this.target.setMaxVisible(available - title.length - previewRows - (body.length > previewRows ? 1 : 0) - 3);
    const controls = this.target.render(width);
    const bodySpace = Math.max(0, available - title.length - controls.length);
    this.bodyRows = body.length > bodySpace ? Math.max(0, bodySpace - 1) : bodySpace;
    this.bodyOffset = Math.max(0, Math.min(this.bodyOffset, body.length - this.bodyRows));
    const hint = body.length > this.bodyRows ? new Text(dim(`${t("Input", "输入")} ${this.bodyOffset + 1}–${Math.min(body.length, this.bodyOffset + this.bodyRows)}/${body.length} · ${t("PgUp/PgDn scroll", "PgUp/PgDn 滚动")}`), 1, 0).render(width) : [];
    const preview = [...title, ...body.slice(this.bodyOffset, this.bodyOffset + this.bodyRows), ...hint];
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

export async function startTui(client: SocketClient, initial: Session, initialPrompt = "", initialAttachments: Attachment[] = [], resume = false) {
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
  let details = false;
  let loginId: string | undefined;
  let pendingLogin: { cancelled: boolean; promise: Promise<void> } | undefined;
  const authBacklog: Record<string, unknown>[] = [];
  let pendingAttachments = initialAttachments;
  const drafts = new Map<string, { text: string; attachments: Attachment[] }>();
  const tui = new TuiMainScreen(new ProcessTerminal(), true);
  const header = new Text("", 1, 1);
  const transcript = new Container();
  const streaming = new Markdown("", 1, 0, markdownTheme);
  const feedback = new Text("", 1, 0);
  const editor = new Editor(tui, { borderColor: dim, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8 });
  const footer = new Text("", 1, 0);
  const inputArea = new Container();
  inputArea.addChild(editor); inputArea.addChild(footer);
  tui.addChild(header); tui.addChild(transcript); tui.addChild(streaming); tui.addChild(feedback); tui.addChild(inputArea);
  let transcriptKey = "";
  let finish: () => void = () => {};
  const completed = new Promise<void>((resolveDone) => { finish = resolveDone; });

  function closeDialog() { dismissDialog?.(); }
  function report(error: unknown) { notice = error instanceof Error ? error.message : String(error); render(); }
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
            activeDialog = undefined; inputArea.clear(); inputArea.addChild(editor); inputArea.addChild(footer); dismissDialog = undefined; dialogApprovalId = undefined; dialogLoginId = undefined;
            tui.setFocus(editor); resolveDialog(value);
            queueMicrotask(() => { nextDialog(); render(); });
          };
          dismissDialog = () => finishDialog(); dialogApprovalId = approval?.id; dialogLoginId = authId;
          const height = () => Math.max(3, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.85)));
          activeDialog = new Dialog(title, body, create(finishDialog), height);
          inputArea.clear(); inputArea.addChild(activeDialog);
          tui.setFocus(activeDialog); tui.requestRender();
        },
      };
      dialogs.push(request); nextDialog();
    });
  }
  function choose(title: string, items: SelectItem[], body = "", approval?: Approval): Promise<string | undefined> {
    return showDialog(title, body, (finishDialog) => {
      const choices = new SearchPicker(items, selectTheme);
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
    transcript.addChild(new Text(bold(title), 1, 1)); transcript.addChild(new Markdown(body, 1, 0, markdownTheme)); tui.requestRender();
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
      transcriptKey = ""; notice = "";
      const customCommands = await client.request("commands.list", { cwd: session.cwd });
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands(), ...customCommands], session.cwd));
    } finally { changingSession = false; render(); }
  }

  async function approve(approval: Approval) {
    approvalId = approval.id;
    try {
      const option = approval.question
        ? await choose(t("Question", "问题"), [...(approval.options || []).map((value) => ({ label: value, value })), { label: t("Write an answer…", "输入回答…"), value: "__answer" }], approval.question, approval)
        : await choose(t(`Allow ${approval.tool}?`, `允许 ${approval.tool}？`), [ { label: t("Allow once", "仅允许一次"), value: "allow" }, { label: t("Allow for this project", "对此项目允许"), value: "project" }, { label: t("Allow globally", "全局允许"), value: "global" }, { label: t("Deny", "拒绝"), value: "deny" } ], JSON.stringify(approval.args, null, 2), approval);
      let answer = option;
      if (option === "__answer") answer = await ask(t("Your answer", "你的回答"), approval.question, false, approval);
      if (stopped || !store.get(approval.sessionId)?.approvals.some((item) => item.id === approval.id)) return;
      if (answer === undefined && approval.question) await client.request("session.abort", { sessionId: approval.sessionId });
      else await client.request("approval.respond", { approvalId: approval.id, allow: answer !== undefined && (approval.question ? true : option !== "deny"), answer: approval.question ? answer : undefined, remember: option === "project" || option === "global" ? option : undefined });
    } finally { if (approvalId === approval.id) approvalId = undefined; render(); }
  }

  function render() {
    const state = store.get(sessionId);
    if (!state || stopped) return;
    header.setText(`${bold("VoidKagami")}  ${state.session.title}\n${dim(state.session.cwd)}  ${dim(sessionId.slice(0, 8))}`);
    const key = `${sessionId}:${details}:${state.transcriptRevision}`;
    if (key !== transcriptKey) {
      transcript.clear();
      for (const item of state.transcript) {
        if (item.role === "assistant") {
          if (item.thinking && details) transcript.addChild(new Text(dim(`${t("Thinking", "思考")}\n${item.thinking}`), 1, 1));
          if (item.text) transcript.addChild(new Markdown(item.text, 1, 1, markdownTheme));
        } else if (item.role === "user") transcript.addChild(new Text(`${bold("›")} ${item.text}${item.inputKind ? dim(` [${statusLabel(item.inputKind)} · ${statusLabel(item.delivery || "")}]`) : ""}${item.attachments?.length ? `\n${dim(item.attachments.map((file) => `[${file.type}: ${basename(file.path)}]`).join(" "))}` : ""}`, 1, 1));
        else if (item.role === "tool") {
          const args = item.toolArgs || {};
          const symbol = item.toolStatus === "running" ? "◌" : item.error ? "×" : item.toolStatus === "interrupted" ? "■" : "✓";
          transcript.addChild(new ToolOutput(`${symbol} ${item.tool}`, args, item.text, details, item.error ? red : dim));
        } else transcript.addChild(new Text((item.error ? red : dim)(item.text), 1, 1));
      }
      transcriptKey = key;
    }
    streaming.setText(`${details && state.thinking ? `*${t("Thinking", "思考")}*\n\n${state.thinking}\n\n` : ""}${state.streaming}`);
    const progress = details ? state.progress : `${state.progress.split("\n").slice(0, 3).join("\n").slice(0, 300)}${state.progress.length > 300 || state.progress.split("\n").length > 3 ? t("\n… Ctrl+O for full output", "\n… Ctrl+O 查看完整输出") : ""}`;
    feedback.setText(dim(notice || progress || (isBusy(state.session.status) ? `${statusLabel(state.session.status)}  ${t("Esc to stop · input to steer · /queue to follow up", "Esc 停止 · 输入以引导 · /queue 排队消息")}` : "")));
    const context = state.context ? ` · ${Math.round(100 * state.context.tokens / state.context.limit)}% ${t("context", "上下文")}` : "";
    footer.setText(dim(`${pendingAttachments.length ? `${pendingAttachments.map((file) => `[${basename(file.path)}]`).join(" ")} · ${t("/attachments to remove", "/attachments 移除附件")}\n` : ""}${state.session.model.provider}/${state.session.model.id}${state.session.model.thinkingLevel ? ` (${statusLabel(state.session.model.thinkingLevel)})` : ""} · ${statusLabel(state.session.permissionMode)}${context} · $${state.cost.toFixed(4)} · ${statusLabel(client.state)}\n${t("/help · @file · Shift+Enter newline · Ctrl+O details · Ctrl+D exit", "/help 帮助 · @文件 · Shift+Enter 换行 · Ctrl+O 详情 · Ctrl+D 退出")}`));
    tui.requestRender();
    if (approvalId && !state.approvals.some((approval) => approval.id === approvalId)) { if (dialogApprovalId === approvalId) closeDialog(); approvalId = undefined; }
    if (state.approvals.length && !activeDialog && !dialogs.length && !approvalId && !changingSession && !pickingInitialSession) execute(() => approve(state.approvals[0]!));
  }

  async function slash(text: string) {
    const [name, ...parts] = text.slice(1).split(/\s+/);
    const command = commandName(name || "");
    const arg = parts.join(" ");
    const state = store.get(sessionId)!;
    const session = state.session;
    if (command === "exit") { finish(); return; }
    if (command === "help") { showText(t("Commands", "命令"), commands().map((item) => `- /${item.name} — ${item.description}`).join("\n") + t("\n\n**Keyboard**\n- Enter: send (steer while busy)\n- Shift+Enter or Alt+Enter: newline\n- Esc: stop the run, decline an approval, or close a menu\n- Ctrl+C: clear input, stop, or exit\n- Ctrl+D: exit with empty input\n- Ctrl+O: toggle full tools and thinking\n- Ctrl+V: paste clipboard image or text\n- Shift+Tab: cycle permission mode\n- Up/Down: input history · Tab: complete a command or @file\n- Type in a picker to search · ↑↓ select · Enter confirm\n- /model: ←→ thinking effort", "\n\n**快捷键**\n- Enter：发送（执行中发送引导）\n- Shift+Enter 或 Alt+Enter：换行\n- Esc：停止执行、拒绝审批或关闭菜单\n- Ctrl+C：清空输入、停止或退出\n- Ctrl+D：输入为空时退出\n- Ctrl+O：展开或收起工具与思考\n- Ctrl+V：粘贴图片或文本\n- Shift+Tab：循环权限模式\n- ↑↓：输入历史 · Tab：补全命令或 @文件\n- 选择器中输入搜索 · ↑↓ 选择 · Enter 确认\n- /model 中 ←→ 调整思考能力")); return; }
    if (command === "details") { details = !details; render(); return; }
    if (command === "attach") { if (!arg) throw new Error(t("Usage: /attach <path>", "用法：/attach <路径>")); const path = resolve(session.cwd, arg); if (!(await stat(path)).isFile()) throw new Error(t("Choose a file", "请选择文件")); pendingAttachments.push({ type: /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "file", path }); render(); return; }
    if (command === "attachments") { const selected = await choose(t("Remove attachment", "移除附件"), pendingAttachments.map((file, index) => ({ value: String(index), label: basename(file.path), description: file.path }))); if (selected !== undefined) pendingAttachments.splice(Number(selected), 1); render(); return; }
    if (command === "cancel-login") {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
      loginId = undefined; notice = t("Sign-in cancelled", "已取消登录"); render(); return;
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
      if (!models.length) { notice = t("No available models. Use /login to connect a provider.", "暂无可用模型，请使用 /login 登录服务商。"); render(); return; }
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
      if (selection) store.updateSession(await client.request("model.select", { sessionId, model: selection })); return;
    }
    if (command === "language") {
      const language = arg || await choose(t("Language", "语言"), [{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]);
      if (language) {
        if (language !== "zh-CN" && language !== "en") throw new Error(t("Choose zh-CN or en", "请选择 zh-CN 或 en"));
        setLanguage((await client.request("config.set", { language })).language);
        const customCommands = await client.request("commands.list", { cwd: session.cwd });
        editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands(), ...customCommands], session.cwd));
        transcriptKey = ""; notice = ""; render();
      } return;
    }
    if (command === "effort") {
      const model = (await client.request("model.list", {})).find((item) => item.provider === session.model.provider && item.id === session.model.id)!;
      const level = arg || await choose(t("Thinking effort", "思考能力"), model.thinkingLevels.map((value) => ({ value, label: `${value === (session.model.thinkingLevel || "off") ? "✓ " : ""}${statusLabel(value)}` })));
      if (level) store.updateSession(await client.request("model.select", { sessionId, model: { ...session.model, thinkingLevel: level as ModelSelection["thinkingLevel"] } })); return;
    }
    if (command === "mode") {
      const mode = arg || await choose(t("Permission mode", "权限模式"), [{ label: t("Ask before changes", "修改前询问"), value: "ask" }, { label: t("Accept file edits", "允许文件编辑"), value: "accept_edits" }, { label: t("Fully automatic", "完全自动"), value: "auto" }, { label: t("Plan (read only)", "规划（只读）"), value: "plan" }]);
      if (mode) store.updateSession(await client.request("session.mode", { sessionId, mode: mode as PermissionMode })); return;
    }
    if (command === "context") { const context = await client.request("session.context", { sessionId }); store.setContext(sessionId, context); showText(t("Context", "上下文"), `${t("Approximately", "约")} ${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens · ${context.messageCount} ${t("messages", "条消息")}\n\n${context.components.map((part) => `- ${part.name}: ~${part.tokens.toLocaleString()} tokens`).join("\n")}\n\n${context.systemPrompt}`); return; }
    if (command === "compact") { await client.request("session.compact", { sessionId }); notice = t("Context compacted", "上下文已压缩"); render(); return; }
    if (command === "fork" || command === "rewind") {
      const turns = state.transcript.filter((item) => item.event.type === "user.message" || item.event.type === "assistant.message");
      const eventId = arg || await choose(command === "fork" ? t("Fork from message", "从消息分叉") : t("Rewind to message and restore files", "回退到消息并恢复文件"), turns.map((item) => ({ value: item.id, label: item.text.slice(0, 70), description: `${statusLabel(item.role)} · ${item.seq}` })).reverse());
      if (eventId) {
        const choice = await choose(command === "fork" ? t("Fork workspace", "分叉工作区") : t("Restore to selected message", "恢复到所选消息"), command === "fork" ? [{ label: t("Same workspace", "相同工作区"), value: "conversation" }, { label: t("Isolated Git worktree", "隔离的 Git 工作树"), value: "files" }] : [{ label: t("Conversation only", "仅会话"), value: "conversation" }, { label: t("Conversation and files", "会话与文件"), value: "files" }]);
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
    if (command === "queue") { if (!arg) throw new Error(t("Usage: /queue <message>", "用法：/queue <消息>")); await client.request("session.followUp", { sessionId, text: arg, attachments: await references(arg) }); notice = t("Message queued", "消息已排队"); render(); return; }
    if (command === "rename") { const title = arg || await ask(t("Session title", "会话名称")); if (title) store.updateSession(await client.request("session.rename", { sessionId, title })); return; }
    if (command === "settings") { showText(t("Configuration", "配置"), `\`\`\`json\n${JSON.stringify(await client.request("config.get", {}), null, 2)}\n\`\`\`\n${t("Change configuration with", "修改配置")}: voidkagami config <key> '<json>'\n/language · ${t("Choose interface language", "切换界面语言")}`); return; }
    if (command === "logout") { if (!arg) throw new Error(t("Usage: /logout <provider>", "用法：/logout <服务商>")); await client.request("auth.logout", { provider: arg }); notice = t(`Signed out of ${arg}`, `已退出 ${arg}`); render(); return; }
    if (command === "login") {
      const provider = arg || await choose(t("Connect provider", "连接服务商"), [{ label: t("ChatGPT subscription", "ChatGPT 订阅"), value: "openai" }, { label: t("DeepSeek API key", "DeepSeek API 密钥"), value: "deepseek" }, { label: t("Anthropic API key", "Anthropic API 密钥"), value: "anthropic" }]);
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
      else { const apiKey = await ask(`${provider} ${t("API key", "API 密钥")}`, "", true); if (apiKey) { await client.request("auth.key", { provider, apiKey }); notice = t(`Signed in to ${provider}`, `已登录 ${provider}`); render(); } } return;
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
    notice = "";
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
    if (event.type === "complete" || event.type === "error" || event.type === "progress" || event.type === "cancelled") { notice = String(event.message || (event.type === "complete" ? t("Signed in with ChatGPT", "已登录 ChatGPT") : event.type)); render(); }
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
    if (matchesKey(data, "shift+tab")) { const modes: PermissionMode[] = ["ask", "accept_edits", "auto", "plan"]; const current = store.get(sessionId)!.session.permissionMode; execute(async () => store.updateSession(await client.request("session.mode", { sessionId, mode: modes[(modes.indexOf(current) + 1) % modes.length]! }))); return { consume: true }; }
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
    tui.setFocus(editor); tui.start(); await attach(initial);
    if (resume) { try { await slash("/resume"); } finally { pickingInitialSession = false; render(); } }
    if (initialPrompt || initialAttachments.length) { await send(initialPrompt, initialAttachments); pendingAttachments = []; }
    await completed;
  } finally {
    stopped = true; closeDialog(); for (const dialog of dialogs.splice(0)) dialog.cancel();
    try {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
    } finally {
      unsubscribe(); tui.stop();
      client.off("event", onEvent); client.off("live", onLive); client.off("replay", onReplay); client.off("auth", onAuth); client.off("state", render); client.off("connectionError", report);
    }
  }
}
