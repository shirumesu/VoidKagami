import { resolve, extname, join, basename } from "node:path";
import { stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { TuiMainScreen, ProcessTerminal, Container, Text, Markdown, Editor, Input, CombinedAutocompleteProvider, matchesKey, CURSOR_MARKER, visibleWidth, getNativeClipboard } from "@voidkagami/tui";
import type { Component, MarkdownTheme, SelectItem, SelectListTheme, OverlayHandle } from "@voidkagami/tui";
import { SessionStore, eventText } from "@voidkagami/client";
import type { SocketClient } from "@voidkagami/client";
import { isBusy } from "@voidkagami/protocol";
import type { Attachment, Session, SessionEvent, LiveEvent, PermissionMode, ModelSelection, Approval } from "@voidkagami/protocol";
import { SearchPicker } from "./picker.ts";

const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
const identity = (text: string) => text;
const selectTheme: SelectListTheme = { selectedPrefix: bold, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme: MarkdownTheme = { heading: bold, link: identity, linkUrl: dim, code: identity, codeBlock: identity, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: identity, bold, italic: (text) => `\x1b[3m${text}\x1b[23m`, strikethrough: (text) => `\x1b[9m${text}\x1b[29m`, underline: (text) => `\x1b[4m${text}\x1b[24m` };
const commands = [
  ["help", "Show commands and shortcuts"], ["new", "Start a new session in this project"], ["resume", "Choose a saved session"], ["model", "Choose a model"], ["mode", "Change permission mode"], ["context", "Inspect context and usage"], ["compact", "Summarize the conversation"], ["fork", "Branch from a conversation turn"], ["rewind", "Rewind conversation and restore files"], ["diff", "Show file changes"], ["tasks", "Show background tasks"], ["stop", "Stop a background task"], ["queue", "Queue input after the current run"], ["rename", "Rename this session"], ["login", "Sign in with ChatGPT or add an API key"], ["logout", "Remove a provider credential"], ["settings", "Show daemon configuration"], ["exit", "Close the client; keep tasks running"],
].map(([name, description]) => ({ name: name!, description: description! }));
commands.push(...[
  { name: "archive", description: "Archive the current session" },
  { name: "archived", description: "Restore an archived session" },
  { name: "details", description: "Toggle full tool output and thinking (Ctrl+O)" },
  { name: "effort", description: "Choose the model's thinking effort" },
  { name: "attach", description: "Attach a file or image" },
  { name: "attachments", description: "Remove a pending attachment" },
  { name: "cancel-login", description: "Cancel a pending sign-in" },
]);

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
    if (this.target instanceof SearchPicker) this.target.setMaxVisible(available - title.length - previewRows - (body.length > previewRows ? 1 : 0) - 3);
    const controls = this.target.render(width);
    const bodySpace = Math.max(0, available - title.length - controls.length);
    this.bodyRows = body.length > bodySpace ? Math.max(0, bodySpace - 1) : bodySpace;
    this.bodyOffset = Math.max(0, Math.min(this.bodyOffset, body.length - this.bodyRows));
    const hint = body.length > this.bodyRows ? new Text(dim(`Input ${this.bodyOffset + 1}–${Math.min(body.length, this.bodyOffset + this.bodyRows)}/${body.length} · PgUp/PgDn scroll`), 1, 0).render(width) : [];
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
  if (at <= 0) throw new Error("Use provider/model-id");
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

export async function startTui(client: SocketClient, initial: Session, initialPrompt = "", initialAttachments: Attachment[] = [], resume = false) {
  const store = new SessionStore();
  let sessionId = initial.id;
  let overlay: OverlayHandle | undefined;
  let dismissOverlay: (() => void) | undefined;
  let overlayApprovalId: string | undefined;
  let overlayLoginId: string | undefined;
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
  tui.addChild(header); tui.addChild(transcript); tui.addChild(streaming); tui.addChild(feedback); tui.addChild(editor); tui.addChild(footer);
  let transcriptKey = "";
  let finish: () => void = () => {};
  const completed = new Promise<void>((resolveDone) => { finish = resolveDone; });

  function closeOverlay() { dismissOverlay?.(); }
  function report(error: unknown) { notice = error instanceof Error ? error.message : String(error); render(); }
  function execute(action: () => Promise<unknown>) { void action().catch(report); }
  function nextDialog() {
    if (overlay || stopped) return;
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
            overlay?.hide(); overlay = undefined; dismissOverlay = undefined; overlayApprovalId = undefined; overlayLoginId = undefined;
            tui.setFocus(editor); resolveDialog(value);
            queueMicrotask(() => { nextDialog(); render(); });
          };
          dismissOverlay = () => finishDialog(); overlayApprovalId = approval?.id; overlayLoginId = authId;
          const height = () => Math.max(3, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.85)));
          overlay = tui.showOverlay(new Dialog(title, body, create(finishDialog), height), { width: "85%", maxHeight: "85%", margin: 1 });
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
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands, ...customCommands], session.cwd));
    } finally { changingSession = false; render(); }
  }

  async function approve(approval: Approval) {
    approvalId = approval.id;
    try {
      const option = approval.question
        ? await choose("Question", [...(approval.options || []).map((value) => ({ label: value, value })), { label: "Write an answer…", value: "__answer" }], approval.question, approval)
        : await choose(`Allow ${approval.tool}?`, [ { label: "Allow once", value: "allow" }, { label: "Allow for this project", value: "project" }, { label: "Allow globally", value: "global" }, { label: "Deny", value: "deny" } ], JSON.stringify(approval.args, null, 2), approval);
      let answer = option;
      if (option === "__answer") answer = await ask("Your answer", approval.question, false, approval);
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
          if (item.thinking && details) transcript.addChild(new Text(dim(`Thinking\n${item.thinking}`), 1, 1));
          if (item.text) transcript.addChild(new Markdown(item.text, 1, 1, markdownTheme));
        } else if (item.role === "user") transcript.addChild(new Text(`${bold("›")} ${item.text}${item.inputKind ? dim(` [${item.inputKind === "steer" ? "Steering" : "Follow-up"} · ${item.delivery}]`) : ""}${item.attachments?.length ? `\n${dim(item.attachments.map((file) => `[${file.type}: ${basename(file.path)}]`).join(" "))}` : ""}`, 1, 1));
        else if (item.role === "tool") {
          const args = item.toolArgs || {};
          const fullLabel = String(args.command || args.path || args.query || "");
          const singleLine = fullLabel.replace(/\s+/g, " ").trim();
          const label = singleLine.length > 100 ? `${singleLine.slice(0, 100)}…` : singleLine;
          const inputHint = !details && (singleLine.length > 100 || /[\r\n]/.test(fullLabel)) ? " · Ctrl+O for full input" : "";
          const symbol = item.toolStatus === "running" ? "◌" : item.error ? "×" : item.toolStatus === "interrupted" ? "■" : "✓";
          const output = details ? `\n${JSON.stringify(args, null, 2)}\n${item.text}` : item.text ? `\n${item.text.split("\n").slice(0, 3).join("\n").slice(0, 300)}${item.text.length > 300 || item.text.split("\n").length > 3 ? "\n… Ctrl+O for full output" : ""}` : "";
          transcript.addChild(new Text((item.error ? red : dim)(`${symbol} ${item.tool} ${label}${inputHint}${output}`), 1, 0));
        } else transcript.addChild(new Text((item.error ? red : dim)(item.text), 1, 1));
      }
      transcriptKey = key;
    }
    streaming.setText(`${details && state.thinking ? `*Thinking*\n\n${state.thinking}\n\n` : ""}${state.streaming}`);
    const progress = details ? state.progress : `${state.progress.split("\n").slice(0, 3).join("\n").slice(0, 300)}${state.progress.length > 300 || state.progress.split("\n").length > 3 ? "\n… Ctrl+O for full output" : ""}`;
    feedback.setText(dim(notice || progress || (isBusy(state.session.status) ? `${state.session.status === "waiting_approval" ? "Waiting for approval" : "Working…"}  Esc to stop · input to steer · /queue to follow up` : "")));
    const context = state.context ? ` · ${Math.round(100 * state.context.tokens / state.context.limit)}% context` : "";
    footer.setText(dim(`${pendingAttachments.length ? `${pendingAttachments.map((file) => `[${basename(file.path)}]`).join(" ")} · /attachments to remove\n` : ""}${state.session.model.provider}/${state.session.model.id}${state.session.model.thinkingLevel ? ` (${state.session.model.thinkingLevel})` : ""} · ${state.session.permissionMode}${context} · $${state.cost.toFixed(4)} · ${client.state}\n/help · @file · Shift+Enter newline · Ctrl+O details · Ctrl+D exit`));
    tui.requestRender();
    if (approvalId && !state.approvals.some((approval) => approval.id === approvalId)) { if (overlayApprovalId === approvalId) closeOverlay(); approvalId = undefined; }
    if (state.approvals.length && !overlay && !dialogs.length && !approvalId && !changingSession && !pickingInitialSession) execute(() => approve(state.approvals[0]!));
  }

  async function slash(text: string) {
    const [command, ...parts] = text.slice(1).split(/\s+/);
    const arg = parts.join(" ");
    const state = store.get(sessionId)!;
    const session = state.session;
    if (command === "exit" || command === "quit") { finish(); return; }
    if (command === "help") { showText("Commands", commands.map((item) => `- /${item.name} — ${item.description}`).join("\n") + "\n\n**Keyboard**\n- Enter: send (steer while busy)\n- Shift+Enter or Alt+Enter: newline\n- Esc: stop the run, decline an approval, or close a menu\n- Ctrl+C: clear input, stop, or exit\n- Ctrl+D: exit with empty input\n- Ctrl+O: toggle full tools and thinking\n- Ctrl+V: paste clipboard image or text\n- Shift+Tab: cycle permission mode\n- Up/Down: input history · Tab: complete a command or @file\n- Type in a picker to search · ↑↓ select · Enter confirm"); return; }
    if (command === "details") { details = !details; render(); return; }
    if (command === "attach") { if (!arg) throw new Error("Usage: /attach <path>"); const path = resolve(session.cwd, arg); if (!(await stat(path)).isFile()) throw new Error("Choose a file"); pendingAttachments.push({ type: /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "file", path }); render(); return; }
    if (command === "attachments") { const selected = await choose("Remove attachment", pendingAttachments.map((file, index) => ({ value: String(index), label: basename(file.path), description: file.path }))); if (selected !== undefined) pendingAttachments.splice(Number(selected), 1); render(); return; }
    if (command === "cancel-login") {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
      loginId = undefined; notice = "Sign-in cancelled"; render(); return;
    }
    if (command === "new") { await attach(await client.request("session.create", { cwd: arg ? resolve(session.cwd, arg) : session.projectPath || session.cwd, model: session.model, permissionMode: session.permissionMode })); return; }
    if (command === "resume") {
      const sessions = await client.request("session.list", { query: arg || undefined });
      const selected = await choose("Resume session", sessions.map((item) => ({ value: item.id, label: item.title, description: `${item.status} · ${item.cwd}` })));
      const next = sessions.find((item) => item.id === selected); if (next) await attach(next); return;
    }
    if (command === "archive") {
      await client.request("session.archive", { sessionId, archived: true });
      const sessions = await client.request("session.list", {});
      await attach(sessions.find((item) => item.cwd === session.cwd) || await client.request("session.create", { cwd: session.cwd, model: session.model, permissionMode: session.permissionMode })); return;
    }
    if (command === "archived") {
      const sessions = await client.request("session.list", { archived: true, query: arg || undefined });
      const selected = await choose("Restore session", sessions.map((item) => ({ value: item.id, label: item.title, description: item.cwd })));
      if (selected) await attach(await client.request("session.archive", { sessionId: selected, archived: false })); return;
    }
    if (command === "model") {
      let selected = arg;
      if (!selected) { const models = await client.request("model.list", {}); models.sort((a, b) => Number(b.provider === session.model.provider && b.id === session.model.id) - Number(a.provider === session.model.provider && a.id === session.model.id)); selected = await choose("Choose model", models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider === session.model.provider && model.id === session.model.id ? "✓ " : ""}${model.name}`, description: `${model.provider}/${model.id}${model.authenticated ? "" : " · sign in required"}` }))) || ""; }
      if (selected) store.updateSession(await client.request("model.select", { sessionId, model: modelSelection(selected) })); return;
    }
    if (command === "effort") {
      const model = (await client.request("model.list", {})).find((item) => item.provider === session.model.provider && item.id === session.model.id)!;
      const level = arg || await choose("Thinking effort", model.thinkingLevels.map((value) => ({ value, label: `${value === (session.model.thinkingLevel || "off") ? "✓ " : ""}${value}` })));
      if (level) store.updateSession(await client.request("model.select", { sessionId, model: { ...session.model, thinkingLevel: level as ModelSelection["thinkingLevel"] } })); return;
    }
    if (command === "mode") {
      const mode = arg || await choose("Permission mode", [{ label: "Ask before changes", value: "ask" }, { label: "Accept file edits", value: "accept_edits" }, { label: "Fully automatic", value: "auto" }, { label: "Plan (read only)", value: "plan" }]);
      if (mode) store.updateSession(await client.request("session.mode", { sessionId, mode: mode as PermissionMode })); return;
    }
    if (command === "context") { const context = await client.request("session.context", { sessionId }); store.setContext(sessionId, context); showText("Context", `Approximately ${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens · ${context.messageCount} messages\n\n${context.components.map((part) => `- ${part.name}: ~${part.tokens.toLocaleString()} tokens`).join("\n")}\n\n${context.systemPrompt}`); return; }
    if (command === "compact") { await client.request("session.compact", { sessionId }); notice = "Context compacted"; render(); return; }
    if (command === "fork" || command === "rewind") {
      const turns = state.transcript.filter((item) => item.event.type === "user.message" || item.event.type === "assistant.message");
      const eventId = arg || await choose(command === "fork" ? "Fork from message" : "Rewind to message and restore files", turns.map((item) => ({ value: item.id, label: item.text.slice(0, 70), description: `${item.role} · ${item.seq}` })).reverse());
      if (eventId) {
        const choice = await choose(command === "fork" ? "Fork workspace" : "Restore to selected message", command === "fork" ? [{ label: "Same workspace", value: "conversation" }, { label: "Isolated Git worktree", value: "files" }] : [{ label: "Conversation only", value: "conversation" }, { label: "Conversation and files", value: "files" }]);
        if (choice) { const next = command === "fork" ? await client.request("session.fork", { sessionId, eventId, worktree: choice === "files" }) : await client.request("session.rewind", { sessionId, eventId, restoreFiles: choice === "files" }); await attach(next); }
      } return;
    }
    if (command === "diff") { const { diff } = await client.request("session.diff", { sessionId, eventId: arg || undefined }); showText("Changes", diff ? `\`\`\`diff\n${diff}\n\`\`\`` : "No changes."); return; }
    if (command === "tasks" || command === "stop") {
      const tasks = await client.request("session.tasks", { sessionId });
      if (command === "tasks") {
        const children = (await client.request("session.list", {})).filter((item) => item.parentSessionId === sessionId);
        showText("Background tasks", tasks.length ? tasks.map((task) => `**${task.id}** ${task.status}\n\`\`\`\n${task.command}\n${task.output}\n\`\`\``).join("\n\n") : "No background tasks.");
        if (children.length) { const selected = await choose("Agent sessions", children.map((child) => ({ value: child.id, label: child.title, description: `${child.status}${child.status === "waiting_approval" ? " · needs your input" : ""}` }))); const child = children.find((item) => item.id === selected); if (child) await attach(child); }
      }
      else { const taskId = arg || await choose("Stop background task", tasks.filter((task) => task.status === "running").map((task) => ({ label: task.command, value: task.id }))); if (taskId) await client.request("task.stop", { sessionId, taskId }); } return;
    }
    if (command === "queue") { if (!arg) throw new Error("Usage: /queue <message>"); await client.request("session.followUp", { sessionId, text: arg, attachments: await references(arg) }); notice = "Message queued"; render(); return; }
    if (command === "rename") { const title = arg || await ask("Session title"); if (title) store.updateSession(await client.request("session.rename", { sessionId, title })); return; }
    if (command === "settings") { showText("Configuration", `\`\`\`json\n${JSON.stringify(await client.request("config.get", {}), null, 2)}\n\`\`\`\nChange configuration with: voidkagami config <key> '<json>'`); return; }
    if (command === "logout") { if (!arg) throw new Error("Usage: /logout <provider>"); await client.request("auth.logout", { provider: arg }); notice = `Signed out of ${arg}`; render(); return; }
    if (command === "login") {
      const provider = arg || await choose("Connect provider", [{ label: "ChatGPT subscription", value: "openai" }, { label: "DeepSeek API key", value: "deepseek" }, { label: "Anthropic API key", value: "anthropic" }]);
      if (!provider) return;
      if (provider === "openai") {
        if (pendingLogin || loginId) throw new Error("A login is already in progress");
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
      else { const apiKey = await ask(`${provider} API key`, "", true); if (apiKey) { await client.request("auth.key", { provider, apiKey }); notice = `Signed in to ${provider}`; render(); } } return;
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
    if (event.type === "url") { showText("Sign in with ChatGPT", `${event.url}\n\n${event.instructions || "Open this URL in your browser."}`); }
    if (event.type === "prompt") execute(async () => { const value = await ask(String(event.message || "Authorization code"), "", false, undefined, authId); if (stopped || authId !== loginId) return; if (value) await client.request("auth.respond", { loginId: authId, value }); else await client.request("auth.cancel", { loginId: authId }); });
    if (event.type === "complete" || event.type === "error" || event.type === "cancelled") {
      loginId = undefined;
      for (let index = dialogs.length - 1; index >= 0; index--) if (dialogs[index]!.loginId === authId) dialogs.splice(index, 1)[0]!.cancel();
      if (overlayLoginId === authId) closeOverlay();
    }
    if (event.type === "complete" || event.type === "error" || event.type === "progress" || event.type === "cancelled") { notice = String(event.message || (event.type === "complete" ? "Signed in with ChatGPT" : event.type)); render(); }
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
    if (overlay) return undefined;
    if (matchesKey(data, "ctrl+o")) { details = !details; render(); return { consume: true }; }
    if (matchesKey(data, "shift+tab")) { const modes: PermissionMode[] = ["ask", "accept_edits", "auto", "plan"]; const current = store.get(sessionId)!.session.permissionMode; execute(async () => store.updateSession(await client.request("session.mode", { sessionId, mode: modes[(modes.indexOf(current) + 1) % modes.length]! }))); return { consume: true }; }
    if (matchesKey(data, "ctrl+v")) {
      execute(async () => {
        const clipboard = getNativeClipboard();
        if (!clipboard) throw new Error("Clipboard is unavailable in this terminal. Use /attach <path>.");
        const image = await clipboard.getImage();
        if (image) { const directory = join(process.env.VOIDKAGAMI_HOME || join(homedir(), ".voidkagami"), "attachments"); await mkdir(directory, { recursive: true }); const path = join(directory, `${randomUUID()}.png`); await writeFile(path, image, { mode: 0o600 }); pendingAttachments.push({ type: "image", path }); }
        else { const text = await clipboard.getText(); if (text) editor.insertTextAtCursor(text); }
        render();
      }); return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && !editor.getText()) { finish(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) { if (editor.getText()) { editor.setText(""); tui.requestRender(); } else if (isBusy(store.get(sessionId)!.session.status)) execute(() => client.request("session.abort", { sessionId })); else finish(); return { consume: true }; }
    if (matchesKey(data, "escape") && !overlay && isBusy(store.get(sessionId)!.session.status)) { execute(() => client.request("session.abort", { sessionId })); return { consume: true }; }
    return undefined;
  });
  try {
    tui.setFocus(editor); tui.start(); await attach(initial);
    if (resume) { try { await slash("/resume"); } finally { pickingInitialSession = false; render(); } }
    if (initialPrompt || initialAttachments.length) { await send(initialPrompt, initialAttachments); pendingAttachments = []; }
    await completed;
  } finally {
    stopped = true; closeOverlay(); for (const dialog of dialogs.splice(0)) dialog.cancel();
    try {
      if (pendingLogin) { pendingLogin.cancelled = true; await pendingLogin.promise; }
      if (loginId) await client.request("auth.cancel", { loginId });
    } finally {
      unsubscribe(); tui.stop();
      client.off("event", onEvent); client.off("live", onLive); client.off("replay", onReplay); client.off("auth", onAuth); client.off("state", render); client.off("connectionError", report);
    }
  }
}
