import { resolve, extname } from "node:path";
import { stat } from "node:fs/promises";
import { TuiMainScreen, ProcessTerminal, Container, Text, Markdown, Editor, SelectList, Input, CombinedAutocompleteProvider, matchesKey, CURSOR_MARKER, visibleWidth } from "@voidkagami/tui";
import type { Component, MarkdownTheme, SelectItem, SelectListTheme, OverlayHandle } from "@voidkagami/tui";
import { SessionStore, eventText } from "@voidkagami/client";
import type { SocketClient } from "@voidkagami/client";
import { isBusy } from "@voidkagami/protocol";
import type { Attachment, Session, SessionEvent, LiveEvent, PermissionMode, ModelSelection, Approval } from "@voidkagami/protocol";

const dim = (text: string) => `\x1b[90m${text}\x1b[39m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const identity = (text: string) => text;
const selectTheme: SelectListTheme = { selectedPrefix: bold, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim };
const markdownTheme: MarkdownTheme = { heading: bold, link: identity, linkUrl: dim, code: identity, codeBlock: identity, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: identity, bold, italic: (text) => `\x1b[3m${text}\x1b[23m`, strikethrough: (text) => `\x1b[9m${text}\x1b[29m`, underline: (text) => `\x1b[4m${text}\x1b[24m` };
const commands = [
  ["help", "Show commands and shortcuts"], ["new", "Start a new session in this project"], ["resume", "Choose a saved session"], ["model", "Choose a model"], ["mode", "Change permission mode"], ["context", "Inspect context and usage"], ["compact", "Summarize the conversation"], ["fork", "Branch from a conversation turn"], ["rewind", "Rewind conversation and restore files"], ["diff", "Show file changes"], ["tasks", "Show background tasks"], ["stop", "Stop a background task"], ["queue", "Queue input after the current run"], ["rename", "Rename this session"], ["login", "Sign in with ChatGPT or add an API key"], ["logout", "Remove a provider credential"], ["settings", "Show daemon configuration"], ["exit", "Close the client; keep tasks running"],
].map(([name, description]) => ({ name: name!, description: description! }));

class Dialog extends Container {
  target: Component;
  constructor(title: string, body: string, target: Component) { super(); this.target = target; this.addChild(new Text(bold(title), 1, 1)); if (body) this.addChild(new Text(body, 1, 0)); this.addChild(target); }
  handleInput(data: string) { this.target.handleInput?.(data); }
}

class SecretInput extends Input {
  render(width: number) { return super.render(width).map((line) => line.split(CURSOR_MARKER).map((part) => "•".repeat(visibleWidth(part))).join(CURSOR_MARKER)); }
}

function modelSelection(value: string): ModelSelection {
  const at = value.indexOf("/");
  if (at <= 0) throw new Error("Use provider/model-id");
  return { provider: value.slice(0, at), id: value.slice(at + 1) };
}

export async function startTui(client: SocketClient, initial: Session, initialPrompt = "", initialAttachments: Attachment[] = []) {
  const store = new SessionStore();
  let sessionId = initial.id;
  let overlay: OverlayHandle | undefined;
  let approvalId: string | undefined;
  let stopped = false;
  let notice = "";
  const tui = new TuiMainScreen(new ProcessTerminal(), true);
  const header = new Text("", 1, 1);
  const transcript = new Container();
  const streaming = new Markdown("", 1, 0, markdownTheme);
  const feedback = new Text("", 1, 0);
  const editor = new Editor(tui, { borderColor: dim, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8 });
  const footer = new Text("", 1, 0);
  tui.addChild(header); tui.addChild(transcript); tui.addChild(streaming); tui.addChild(feedback); tui.addChild(editor); tui.addChild(footer);
  const rendered = new Map<string, Component>();
  let transcriptKey = "";
  let finish: () => void = () => {};
  const completed = new Promise<void>((resolveDone) => { finish = resolveDone; });

  function closeOverlay() { overlay?.hide(); overlay = undefined; tui.setFocus(editor); }
  function report(error: unknown) { notice = error instanceof Error ? error.message : String(error); render(); }
  function execute(action: () => Promise<unknown>) { void action().catch(report); }
  function choose(title: string, items: SelectItem[], body = ""): Promise<string | undefined> {
    closeOverlay();
    return new Promise((resolveChoice) => {
      const choices = new SelectList(items, Math.min(items.length, 12), selectTheme);
      choices.onSelect = (item) => { closeOverlay(); resolveChoice(item.value); };
      choices.onCancel = () => { closeOverlay(); resolveChoice(undefined); };
      overlay = tui.showOverlay(new Dialog(title, body, choices), { width: "85%", maxHeight: "85%", margin: 1 });
    });
  }
  function ask(title: string, body = "", secret = false): Promise<string | undefined> {
    closeOverlay();
    return new Promise((resolveAnswer) => {
      const input = secret ? new SecretInput({ prompt: "" }) : new Input();
      input.focused = true;
      input.onSubmit = (value) => { closeOverlay(); resolveAnswer(value); };
      input.onEscape = () => { closeOverlay(); resolveAnswer(undefined); };
      overlay = tui.showOverlay(new Dialog(title, body, input), { width: "85%", margin: 1 });
    });
  }
  function showText(title: string, body: string) {
    transcript.addChild(new Text(bold(title), 1, 1)); transcript.addChild(new Markdown(body, 1, 0, markdownTheme)); tui.requestRender();
  }

  async function attach(session: Session) {
    if (sessionId !== session.id) await client.request("session.detach", { sessionId });
    sessionId = session.id;
    store.attach(await client.request("session.attach", { sessionId }));
    rendered.clear(); transcriptKey = ""; notice = "";
    const customCommands = await client.request("commands.list", { cwd: session.cwd });
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands, ...customCommands], session.cwd));
    render();
  }

  async function approve(approval: Approval) {
    approvalId = approval.id;
    const option = approval.question
      ? await choose("Question", [...(approval.options || []).map((value) => ({ label: value, value })), { label: "Write an answer…", value: "__answer" }], approval.question)
      : await choose(`Allow ${approval.tool}?`, [ { label: "Allow once", value: "allow" }, { label: "Allow for this project", value: "project" }, { label: "Allow globally", value: "global" }, { label: "Deny", value: "deny" } ], JSON.stringify(approval.args, null, 2));
    let answer = option;
    if (option === "__answer") answer = await ask("Your answer", approval.question);
    if (answer !== undefined) await client.request("approval.respond", { approvalId: approval.id, allow: approval.question ? true : option !== "deny", answer: approval.question ? answer : undefined, remember: option === "project" || option === "global" ? option : undefined });
    approvalId = undefined;
    render();
  }

  function render() {
    const state = store.get(sessionId);
    if (!state || stopped) return;
    header.setText(`${bold("VoidKagami")}  ${state.session.title}\n${dim(state.session.cwd)}  ${dim(sessionId.slice(0, 8))}`);
    const key = state.transcript.map((item) => item.id).join(":");
    if (key !== transcriptKey) {
      transcript.clear();
      for (const item of state.transcript) {
        let component = rendered.get(item.id);
        if (!component) {
          if (item.role === "assistant") component = new Markdown(item.text, 1, 1, markdownTheme);
          else if (item.role === "user") component = new Text(`${bold("›")} ${item.text}`, 1, 1);
          else if (item.role === "tool") component = new Text(dim(`${item.tool}\n${item.text.slice(0, 1600)}${item.text.length > 1600 ? "\n…" : ""}`), 1, 0);
          else component = new Text(dim(item.text), 1, 1);
          rendered.set(item.id, component);
        }
        transcript.addChild(component);
      }
      transcriptKey = key;
    }
    streaming.setText(state.streaming);
    feedback.setText(dim(notice || state.progress || (isBusy(state.session.status) ? `${state.session.status === "waiting_approval" ? "Waiting for approval" : "Working…"}  Esc to stop · input to steer · /queue to follow up` : "")));
    const context = state.context ? ` · ${Math.round(100 * state.context.tokens / state.context.limit)}% context` : "";
    footer.setText(dim(`${state.session.model.provider}/${state.session.model.id} · ${state.session.permissionMode}${context} · $${state.cost.toFixed(4)} · ${client.state}\n/help · @file · Shift+Enter newline · Ctrl+D exit`));
    tui.requestRender();
    if (approvalId && !state.approvals.some((approval) => approval.id === approvalId)) { closeOverlay(); approvalId = undefined; }
    if (state.approvals.length && !overlay && !approvalId) execute(() => approve(state.approvals[0]!));
  }

  async function slash(text: string) {
    const [command, ...parts] = text.slice(1).split(/\s+/);
    const arg = parts.join(" ");
    const state = store.get(sessionId)!;
    const session = state.session;
    if (command === "exit" || command === "quit") { finish(); return; }
    if (command === "help") { showText("Commands", commands.map((item) => `- /${item.name} — ${item.description}`).join("\n")); return; }
    if (command === "new") { await attach(await client.request("session.create", { cwd: arg ? resolve(session.cwd, arg) : session.cwd, model: session.model, permissionMode: session.permissionMode })); return; }
    if (command === "resume") {
      const sessions = await client.request("session.list", { query: arg || undefined });
      const selected = await choose("Resume session", sessions.map((item) => ({ value: item.id, label: item.title, description: `${item.status} · ${item.cwd}` })));
      const next = sessions.find((item) => item.id === selected); if (next) await attach(next); return;
    }
    if (command === "model") {
      let selected = arg;
      if (!selected) { const models = await client.request("model.list", {}); selected = await choose("Choose model", models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, description: `${model.provider}/${model.id}${model.authenticated ? "" : " · sign in required"}` }))) || ""; }
      if (selected) store.updateSession(await client.request("model.select", { sessionId, model: modelSelection(selected) })); return;
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
      if (eventId) { const next = command === "fork" ? await client.request("session.fork", { sessionId, eventId }) : await client.request("session.rewind", { sessionId, eventId, restoreFiles: true }); await attach(next); } return;
    }
    if (command === "diff") { const { diff } = await client.request("session.diff", { sessionId, eventId: arg || undefined }); showText("Changes", diff ? `\`\`\`diff\n${diff}\n\`\`\`` : "No changes."); return; }
    if (command === "tasks" || command === "stop") {
      const tasks = await client.request("session.tasks", { sessionId });
      if (command === "tasks") showText("Background tasks", tasks.length ? tasks.map((task) => `**${task.id}** ${task.status}\n\`\`\`\n${task.command}\n${task.output}\n\`\`\``).join("\n\n") : "No background tasks.");
      else { const taskId = arg || await choose("Stop background task", tasks.filter((task) => task.status === "running").map((task) => ({ label: task.command, value: task.id }))); if (taskId) await client.request("task.stop", { sessionId, taskId }); } return;
    }
    if (command === "queue") { if (!arg) throw new Error("Usage: /queue <message>"); await client.request("session.followUp", { sessionId, text: arg, attachments: await references(arg) }); notice = "Message queued"; render(); return; }
    if (command === "rename") { const title = arg || await ask("Session title"); if (title) store.updateSession(await client.request("session.rename", { sessionId, title })); return; }
    if (command === "settings") { showText("Configuration", `\`\`\`json\n${JSON.stringify(await client.request("config.get", {}), null, 2)}\n\`\`\`\nChange configuration with: voidkagami config <key> '<json>'`); return; }
    if (command === "logout") { if (!arg) throw new Error("Usage: /logout <provider>"); await client.request("auth.logout", { provider: arg }); notice = `Signed out of ${arg}`; render(); return; }
    if (command === "login") {
      const provider = arg || "openai";
      if (provider === "openai") await client.request("auth.login", { provider });
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
    if (event.type === "url") { showText("Sign in with ChatGPT", `${event.url}\n\n${event.instructions || "Open this URL in your browser."}`); }
    if (event.type === "prompt") execute(async () => { const value = await ask(String(event.message || "Authorization code")); if (value) await client.request("auth.respond", { loginId: String(event.loginId), value }); });
    if (event.type === "complete" || event.type === "error" || event.type === "progress") { notice = String(event.message || (event.type === "complete" ? "Signed in with ChatGPT" : event.type)); render(); }
  };
  client.on("event", onEvent); client.on("live", onLive); client.on("replay", onReplay); client.on("auth", onAuth); client.on("state", render); client.on("connectionError", report);
  const unsubscribe = store.subscribe(render);
  editor.onSubmit = (text) => { if (text.trim()) { editor.addToHistory(text); execute(() => text.startsWith("/") ? slash(text) : send(text)); } };
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+d") && !editor.getText()) { finish(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) { if (editor.getText()) { editor.setText(""); tui.requestRender(); } else if (isBusy(store.get(sessionId)!.session.status)) execute(() => client.request("session.abort", { sessionId })); else finish(); return { consume: true }; }
    if (matchesKey(data, "escape") && !overlay && isBusy(store.get(sessionId)!.session.status)) { execute(() => client.request("session.abort", { sessionId })); return { consume: true }; }
    return undefined;
  });
  try {
    await attach(initial); tui.setFocus(editor); tui.start();
    if (initialPrompt) await send(initialPrompt, initialAttachments);
    await completed;
  } finally {
    stopped = true; unsubscribe(); closeOverlay(); tui.stop();
    client.off("event", onEvent); client.off("live", onLive); client.off("replay", onReplay); client.off("auth", onAuth); client.off("state", render); client.off("connectionError", report);
  }
}
