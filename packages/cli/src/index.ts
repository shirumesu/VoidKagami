#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { SocketClient, SessionStore, eventText } from "@voidkagami/client";
import { VERSION } from "@voidkagami/protocol";
import type { Attachment, Config, ModelSelection, PermissionMode, Session, SessionEvent, LiveEvent } from "@voidkagami/protocol";
import { login } from "./login.ts";
import { t, loadLanguage, statusLabel } from "./i18n.ts";

const help = () => t(`VoidKagami ${VERSION}

Usage: voidkagami [chat] [prompt] [options]
       voidkagami run <prompt> [--json] [--mode auto]
       voidkagami attach <session-id>
       voidkagami abort <session-id>
       voidkagami sessions [search] [--json]
       voidkagami models [--json]
       voidkagami login [openai|provider] [--key-stdin]
       voidkagami logout <provider>
       voidkagami config [key [json-value]]
       voidkagami status | stop

Options:
  --cwd <path>          Project directory (default: current directory)
  --session <id>        Continue an existing session
  -c, --continue        Continue the latest session in this directory
  -r, --resume          Pick a saved session (or use --session <id>)
  -p, --print           Run a prompt without the interactive interface
  --model <provider/id> Model for a new session
  --mode <mode>         ask, accept_edits, auto, plan
  --worktree            Create an isolated Git worktree
  --branch <branch>     Git branch for the new worktree
  --image <path>        Attach an image (repeatable)
  --file <path>         Attach a file (repeatable)
  --json                Emit JSON; run streams JSONL events
  --help | --version

Interactive: /help for commands, Esc to stop, Shift+Enter for a new line.
/language switches English/Simplified Chinese; /clear is an alias for /new.
abort stops one session; stop shuts down the entire shared daemon.
Closing a client leaves running tasks in the shared daemon.`, `VoidKagami ${VERSION}

用法：voidkagami [chat] [提示词] [选项]
      voidkagami run <提示词> [--json] [--mode auto]
      voidkagami attach <会话 ID>
      voidkagami abort <会话 ID>
      voidkagami sessions [搜索词] [--json]
      voidkagami models [--json]
      voidkagami login [openai|服务商] [--key-stdin]
      voidkagami logout <服务商>
      voidkagami config [配置项 [JSON 值]]
      voidkagami status | stop

选项：
  --cwd <路径>         项目目录（默认当前目录）
  --session <id>       继续现有会话
  -c, --continue       继续此目录的最近会话
  -r, --resume         选择已保存的会话
  -p, --print          以非交互模式执行提示词
  --model <服务商/id>  新会话使用的模型
  --mode <模式>        ask、accept_edits、auto、plan
  --worktree           创建隔离的 Git 工作树
  --branch <分支>      新工作树的分支
  --image <路径>       添加图片（可重复）
  --file <路径>        添加文件（可重复）
  --json               输出 JSON；执行过程输出 JSONL 事件
  --help | --version

交互模式：/help 查看命令，Esc 停止，Shift+Enter 换行。
/language 切换简体中文或英文；/clear 是 /new 的别名。
abort 停止一个会话；stop 关闭共享 daemon。
关闭客户端后，后台任务继续执行。`);

export function parseModel(value: string): ModelSelection {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(t("Model must use provider/model-id format", "模型必须使用 provider/model-id 格式"));
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  loadLanguage();
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, json: { type: "boolean" }, cwd: { type: "string" }, session: { type: "string" }, continue: { type: "boolean", short: "c" }, resume: { type: "boolean", short: "r" }, print: { type: "boolean", short: "p" }, model: { type: "string" }, mode: { type: "string" }, worktree: { type: "boolean" }, branch: { type: "string" }, image: { type: "string", multiple: true }, file: { type: "string", multiple: true }, "key-stdin": { type: "boolean" },
  } });
  if (values.help || positionals[0] === "help") { console.log(help()); return; }
  if (values.version) { console.log(VERSION); return; }
  const known = ["chat", "run", "attach", "abort", "sessions", "models", "login", "logout", "config", "status", "stop"];
  const command = known.includes(positionals[0] || "") ? positionals.shift()! : values.print ? "run" : "chat";
  const client = new SocketClient({ autoStart: command !== "stop" && command !== "abort", reconnect: command === "chat" || command === "attach" });
  const output = (value: unknown) => console.log(typeof value === "string" && !values.json ? value : JSON.stringify(value, null, values.json ? undefined : 2));
  try {
    if (command === "status") { output(await client.request("daemon.status", {})); return; }
    if (command === "stop") { output(await client.request("daemon.stop", {})); return; }
    if (command === "abort") {
      const sessionId = positionals[0] || values.session;
      if (!sessionId) throw new Error(t("Specify a session id: voidkagami abort <session-id>", "请提供会话 ID：voidkagami abort <会话 ID>"));
      await client.request("session.abort", { sessionId });
      output(values.json ? { sessionId, abortRequested: true } : t(`Abort requested for session ${sessionId}`, `已请求停止会话 ${sessionId}`)); return;
    }
    if (command === "sessions") {
      const sessions = await client.request("session.list", { query: positionals.join(" ") || undefined });
      output(values.json ? sessions : sessions.map((s) => `${s.id}  ${statusLabel(s.status)} ${s.title}\n  ${s.cwd}`).join("\n")); return;
    }
    if (command === "models") {
      const models = (await client.request("model.list", {})).filter((model) => model.authenticated);
      output(values.json ? models : models.map((m) => `${m.authenticated ? "●" : "○"} ${m.provider}/${m.id}  ${m.name}  ${Math.round(m.contextWindow / 1000)}k`).join("\n")); return;
    }
    if (command === "login") {
      const provider = positionals[0] || "openai";
      if (values["key-stdin"]) { await client.request("auth.key", { provider, apiKey: (await readStdin()).trim() }); output({ authenticated: provider }); }
      else await login(client, provider);
      return;
    }
    if (command === "logout") { if (!positionals[0]) throw new Error(t("Specify the provider to log out", "请指定要退出的服务商")); await client.request("auth.logout", { provider: positionals[0] }); return; }
    if (command === "config") {
      const [key, ...value] = positionals;
      if (value.length) { output(await client.request("config.set", { [key!]: JSON.parse(value.join(" ")) } as Partial<Config>)); }
      else { const config = await client.request("config.get", {}); output(key ? config[key as keyof Config] : config); }
      return;
    }
    const cwd = resolve(values.cwd || process.cwd());
    const mode = values.mode as PermissionMode | undefined;
    if (mode && !["ask", "accept_edits", "auto", "plan"].includes(mode)) throw new Error(t("Unknown permission mode", "未知权限模式"));
    const recent = values.continue || values.resume ? (await client.request("session.list", {})).filter((item) => item.cwd === cwd) : [];
    const sessionId = values.session || (command === "attach" ? positionals.shift() : undefined) || recent[0]?.id;
    if (command === "attach" && !sessionId) throw new Error(t("Specify a session id", "请指定会话 ID"));
    if (values.continue && !sessionId) throw new Error(t("No saved session in this directory", "此目录暂无已保存的会话"));
    let session: Session = sessionId ? (await client.request("session.attach", { sessionId })).session : await client.request("session.create", { cwd, model: values.model ? parseModel(values.model) : undefined, permissionMode: mode, worktree: values.worktree, branch: values.branch });
    if (sessionId && values.model) session = await client.request("model.select", { sessionId, model: parseModel(values.model) });
    if (sessionId && mode) session = await client.request("session.mode", { sessionId, mode });
    const attachments: Attachment[] = [...(values.image || []).map((path): Attachment => ({ type: "image", path: resolve(cwd, path) })), ...(values.file || []).map((path): Attachment => ({ type: "file", path: resolve(cwd, path) }))];
    let prompt = positionals.join(" ");
    if (!process.stdin.isTTY && command !== "attach") { const input = await readStdin(); prompt = [prompt, input.trim()].filter(Boolean).join("\n\n"); }
    if (command === "run" || !process.stdout.isTTY || !process.stdin.isTTY) {
      if (!prompt && !attachments.length) throw new Error(t("Provide a prompt, attachment, or pipe input to voidkagami run", "请为 voidkagami run 提供提示词、附件或管道输入"));
      await run(client, session, prompt, attachments, Boolean(values.json));
    } else {
      const { startTui } = await import("./tui.ts");
      await startTui(client, session, prompt, attachments, Boolean(values.resume));
    }
  } finally { client.close(); }
}

async function run(client: SocketClient, session: Session, prompt: string, attachments: Attachment[], json: boolean) {
  const store = new SessionStore();
  store.attach(await client.request("session.attach", { sessionId: session.id }));
  if (json) console.log(JSON.stringify({ type: "session", session }));
  else process.stderr.write(`${t("Session", "会话")} ${session.id}\n`);
  let streamed = "";
  let input: ReturnType<typeof createInterface> | undefined;
  let approvalInput: { id: string; controller: AbortController } | undefined;
  let finished = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  function promptNextApproval() {
    if (finished || json || !process.stdin.isTTY || approvalInput) return;
    const approval = store.get(session.id)?.approvals[0];
    if (!approval) return;
    if (!input) {
      input = createInterface({ input: process.stdin, output: process.stderr });
      input.on("SIGINT", abort);
      input.on("close", () => { if (!finished) rejectDone(new Error(t(`Input closed. Resume session ${session.id} to respond to its approval.`, `输入已关闭，请恢复会话 ${session.id} 处理审批。`))); });
    }
    const controller = new AbortController();
    approvalInput = { id: approval.id, controller };
    const question = approval.question ? `${approval.question}${approval.options?.length ? `\n${approval.options.join(" / ")}` : ""}\n${t("Answer", "回答")}: ` : `${approval.tool}: ${JSON.stringify(approval.args)}\n${t("Allow? [y/N]", "允许？[y/N]")} `;
    void input.question(question, { signal: controller.signal }).then(async (answer) => {
      if (!finished && store.get(session.id)?.approvals.some((item) => item.id === approval.id)) await client.request("approval.respond", { approvalId: approval.id, allow: approval.question ? true : answer.toLowerCase() === "y", answer: approval.question ? answer : undefined });
    }).catch((error) => { if (!controller.signal.aborted) { finished = true; rejectDone(error); } }).finally(() => {
      approvalInput = undefined;
      promptNextApproval();
    });
  }
  const onLive = (event: LiveEvent) => {
    if (event.sessionId !== session.id) return;
    if (json) console.log(JSON.stringify(event));
    else if (event.type === "assistant.delta" && !event.data.thinking) {
      const delta = String(event.data.delta || ""); streamed += delta; process.stdout.write(delta);
    }
  };
  const onEvent = (event: SessionEvent) => {
    if (event.sessionId !== session.id) return;
    store.event(event);
    if (approvalInput && !store.get(session.id)?.approvals.some((approval) => approval.id === approvalInput!.id)) approvalInput.controller.abort();
    if (json) console.log(JSON.stringify(event));
    else if (event.type === "assistant.message") {
      const text = eventText(event.data);
      if (text.trim()) process.stdout.write(`${text.startsWith(streamed) ? text.slice(streamed.length) : text}\n`);
      streamed = "";
    } else if (event.type === "tool.call") process.stderr.write(`→ ${event.data.tool}\n`);
    if (event.type === "approval.requested" && !json) {
      if (process.stdin.isTTY) promptNextApproval();
      else process.stderr.write(t(`Approval required. Open voidkagami attach ${session.id} to respond.\n`, `需要审批，请打开 voidkagami attach ${session.id} 处理。\n`));
    }
    if (["turn.ended", "run.error", "run.interrupted"].includes(event.type)) {
      finished = true;
      if (streamed && !json) process.stdout.write("\n");
      if (event.type === "run.error" || event.data.status === "failed") rejectDone(new Error(eventText(event.data) || t("Run failed", "执行失败")));
      else resolveDone();
    }
  };
  const disconnected = () => rejectDone(new Error(t(`Daemon disconnected. Resume session ${session.id} to see its outcome.`, `daemon 已断开，请恢复会话 ${session.id} 查看结果。`)));
  const abort = () => { void client.request("session.abort", { sessionId: session.id }).catch(rejectDone); };
  client.on("event", onEvent); client.on("live", onLive); client.on("connectionError", rejectDone); client.on("disconnect", disconnected);
  process.once("SIGINT", abort);
  try { promptNextApproval(); await Promise.all([client.request("session.send", { sessionId: session.id, text: prompt, attachments }), done]); }
  finally { finished = true; approvalInput?.controller.abort(); process.removeListener("SIGINT", abort); input?.close(); client.off("event", onEvent); client.off("live", onLive); client.off("connectionError", rejectDone); client.off("disconnect", disconnected); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
