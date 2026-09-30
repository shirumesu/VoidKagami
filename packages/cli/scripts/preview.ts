import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, visibleWidth } from "@voidkagami/tui";
import type { Session, SessionEvent } from "@voidkagami/protocol";
import { MockClient } from "@voidkagami/client/fixtures/mock-client";
import { demoConfig, demoSessionIds, demoSessions } from "@voidkagami/client/fixtures/demo";
import { FakeTerminal } from "./fake-terminal.ts";
import { EMBLEM, WORDMARK } from "../src/brand.ts";
import { helpText } from "../src/help.ts";
import { setLanguage, t } from "../src/i18n.ts";
import { startTui } from "../src/tui.ts";
import type { TuiHandle } from "../src/tui.ts";
import { snapshotNames, stripSnapshot } from "../src/snapshot.ts";

const args = process.argv.slice(2);
const snapshot = args.includes("--snapshot");
const widthIndex = args.indexOf("--width");
const width = widthIndex >= 0 ? Number(args[widthIndex + 1]) : undefined;
const sessionIndex = args.indexOf("--session");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const pause = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
setLanguage(demoConfig.language);

async function realTui(session: Session, width: number, client = new MockClient(), action?: (handle: TuiHandle) => Promise<void>) {
  const terminal = new FakeTerminal(width, 45);
  let resolveReady!: (handle: TuiHandle) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<TuiHandle>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const running = startTui(client, session, "", [], false, { terminal, onReady: resolveReady });
  void running.catch(rejectReady);
  const handle = await ready;
  try {
    await action?.(handle);
    await pause();
    return handle.render(width);
  } finally {
    handle.exit();
    await running;
  }
}

function checkLines(name: string, width: number, lines: string[]) {
  const text = stripSnapshot(lines);
  const max = Math.max(0, ...text.map((line) => visibleWidth(line)));
  if (max > width) throw new Error(`${name} renders at ${max} columns for width ${width}`);
  for (let index = 1; index < text.length; index++) {
    if (!text[index]!.trim() && !text[index - 1]!.trim()) throw new Error(`${name} has multiple blank lines at ${index + 1}`);
  }
  return text;
}

async function screen(name: string, width: number) {
  const sessions: Record<string, string> = {
    "empty-welcome": demoSessionIds.empty,
    "rich-collapsed": demoSessionIds.rich,
    "rich-details": demoSessionIds.rich,
    "running-progress": demoSessionIds.running,
    "bash-approval": demoSessionIds.approval,
    "ask-user": demoSessionIds.question,
    "model-picker": demoSessionIds.rich,
    help: demoSessionIds.rich,
  };
  if (name === "help-banner") return new Text(helpText(width >= 72, width), 0, 0).render(width);
  const session = demoSessions.find((item) => item.id === sessions[name])!;
  const client = new MockClient();
  return realTui(session, width, client, async (handle) => {
    if (name === "rich-details") handle.input("\x0f");
    if (name === "help") handle.input("/help\r");
    if (name === "model-picker") handle.input("/model\r");
    if (["rich-details", "help", "model-picker"].includes(name)) await pause(80);
  });
}

async function scriptedRun() {
  const client = new MockClient();
  const sessionId = demoSessionIds.empty;
  let resolveApproval!: () => void;
  let resolveTurn!: () => void;
  const approval = new Promise<void>((resolve) => { resolveApproval = resolve; });
  const turn = new Promise<void>((resolve) => { resolveTurn = resolve; });
  client.on("event", (event: SessionEvent) => {
    if (event.sessionId !== sessionId) return;
    if (event.type === "approval.requested") resolveApproval();
    if (event.type === "turn.ended") resolveTurn();
  });
  return realTui(demoSessions.find((item) => item.id === sessionId)!, 100, client, async (handle) => {
    handle.input("Show the completed demo run.\r");
    await withTimeout(approval, 10000, t("Mock run did not request approval", "模拟运行未请求审批"));
    await pause(30);
    handle.input("1");
    await withTimeout(turn, 10000, t("Mock run did not finish", "模拟运行未完成"));
    await pause(40);
  });
}

if (snapshot) {
  if (width !== undefined && (!Number.isInteger(width) || width < 1)) throw new Error(t("Width must be a positive integer", "宽度必须为正整数"));
  if (EMBLEM.some((row) => visibleWidth(row) > 12) || WORDMARK.some((row) => visibleWidth(row) !== 70)) throw new Error("Brand rows do not match the design dimensions");
  const widths = width === undefined ? [100, 58] : [width];
  const directory = "/tmp/vk-cli-snapshots";
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  process.env.VOIDKAGAMI_HOME = await mkdtemp(join(tmpdir(), "vk-cli-preview-"));
  let emptyWelcome: string[] | undefined;
  let helpBanner: string[] | undefined;
  for (const currentWidth of widths) {
    for (const name of snapshotNames) {
      const lines = await screen(name, currentWidth);
      const text = checkLines(name, currentWidth, lines);
      if (name === "empty-welcome" && currentWidth === 100) emptyWelcome = text;
      if (name === "help-banner" && currentWidth === 100) helpBanner = text;
      const base = `${name}-${currentWidth}`;
      await writeFile(`${directory}/${base}.ansi`, `${lines.join("\n")}\n`, "utf8");
      await writeFile(`${directory}/${base}.txt`, `${text.join("\n")}\n`, "utf8");
      process.stdout.write(`--- ${base} ---\n${lines.join("\n")}\n`);
    }
  }
  if (emptyWelcome && helpBanner) {
    const wordmark = helpBanner.slice(0, WORDMARK.length);
    const emblem = emptyWelcome.slice(1, 1 + EMBLEM.length).map((line, index) => line.slice(1, 1 + EMBLEM[index]!.length));
    if (wordmark.some((line, index) => line.slice(0, WORDMARK[index]!.length) !== WORDMARK[index]) || emblem.some((line, index) => line !== EMBLEM[index])) throw new Error("Brand rendering does not match DESIGN.md");
  }
  if (width === undefined || width === 100) {
    const lines = await scriptedRun();
    const text = checkLines("scripted-run", 100, lines);
    await writeFile(`${directory}/scripted-run-100.ansi`, `${lines.join("\n")}\n`, "utf8");
    await writeFile(`${directory}/scripted-run-100.txt`, `${text.join("\n")}\n`, "utf8");
    process.stdout.write(`--- scripted-run-100 ---\n${lines.join("\n")}\n`);
  }
} else {
  const session = demoSessions.find((item) => item.id === sessionId) || (sessionId ? undefined : demoSessions[0]);
  if (!session) throw new Error(t(`Unknown demo session: ${sessionId}`, `未知演示会话：${sessionId}`));
  process.env.VOIDKAGAMI_HOME = await mkdtemp(join(tmpdir(), "vk-cli-preview-"));
  await startTui(new MockClient(), session);
}
