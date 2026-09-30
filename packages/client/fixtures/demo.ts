import type { Approval, Config, ContextInfo, LiveEvent, ModelInfo, Session, SessionEvent, SessionView, TaskInfo } from "@voidkagami/protocol";

const now = Date.now();
const stamp = (offset: number) => new Date(now + offset).toISOString();
const model = (provider: string, id: string, thinkingLevel = "high") => ({ provider, id, thinkingLevel: thinkingLevel as "high" | "medium" });

export interface DemoProject { id: string; name: string; path: string; branches: string[]; files: string[]; }
export interface DemoCommand { name: string; description: string; }

export const demoProjects: DemoProject[] = [
  { id: "voidkagami", name: "VoidKagami", path: "/work/VoidKagami", branches: ["main", "design/cli-refresh", "fix/session-store"], files: ["README.md", "packages/cli/src/tui.ts", "packages/client/src/store.ts", "packages/protocol/src/index.ts"] },
  { id: "lumen", name: "Lumen Notes", path: "/work/lumen-notes", branches: ["main", "feature/sync"], files: ["README.md", "src/app.ts", "src/sync.ts", "tests/sync.test.ts"] },
  { id: "agent-recipes", name: "Agent Recipes", path: "/work/agent-recipes", branches: ["main"], files: ["README.md", "recipes/release.md", "recipes/review.md"] },
];

export const demoModels: ModelInfo[] = [
  { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", contextWindow: 256000, authenticated: true, thinkingLevels: ["off", "low", "medium", "high", "xhigh"] },
  { provider: "deepseek", id: "deepseek-v3.2", name: "DeepSeek V3.2", contextWindow: 128000, authenticated: true, thinkingLevels: ["off", "low", "medium", "high"] },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, authenticated: false, thinkingLevels: ["off", "low", "medium", "high"] },
];

export const demoConfig: Config = {
  language: "en", defaultWorkspace: demoProjects[0]!.path, defaultModel: model("openai", "gpt-5.5"), permissionMode: "ask",
  rules: [],
  providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", models: [{ id: "deepseek-v3.2", name: "DeepSeek V3.2", contextWindow: 128000, reasoning: true }] } },
  mcpServers: {}, hooks: [], sandbox: false, compactThreshold: 0.8, idleTimeoutMs: 300000,
};

export const demoContext: ContextInfo = {
  components: [{ name: "System prompt", tokens: 4280 }, { name: "Tools", tokens: 6200 }, { name: "Conversation", tokens: 18460 }, { name: "Project instructions", tokens: 950 }],
  estimated: true, tokens: 29890, limit: 256000, systemPrompt: "You are a careful software engineering assistant.", messageCount: 12,
  skills: [{ name: "typescript", description: "TypeScript project conventions", path: ".agents/skills/typescript/SKILL.md" }], cost: 0.0123,
};

export const demoDiff = `diff --git a/packages/cli/src/theme.ts b/packages/cli/src/theme.ts
index 0f3412a..7bb6ac1 100644
--- a/packages/cli/src/theme.ts
+++ b/packages/cli/src/theme.ts
@@ -1 +1,4 @@
-export const accent = "magenta";
+export const accent = "#A594FF";
+export const accentLight = "#6B4EF5";
+export const accent256 = 141;
+export const accent16 = "magenta";

diff --git a/packages/client/src/presentation.ts b/packages/client/src/presentation.ts
index 624522e..f71be12 100644
--- a/packages/client/src/presentation.ts
+++ b/packages/client/src/presentation.ts
@@ -18 +18,4 @@ export function describeTool(item: TranscriptItem, t: Translate, cwd?: string) {
+  if (item.tool === "bash") return describeCommand(item, t);
+  if (item.tool === "read") return describeRead(item, t, cwd);
+  if (item.tool === "edit") return describeEdit(item, t, cwd);
 }
`;

export const demoTasks: TaskInfo[] = [
  { id: "task-4f91", sessionId: "s-running", command: "pnpm test --filter client", status: "running", pid: 4182, output: "PASS src/store.test.ts\nRunning presentation.test.ts" },
  { id: "task-8c20", sessionId: "s-rich", command: "pnpm check", status: "completed", pid: 3921, exitCode: 0, output: "TypeScript check passed" },
];
export const demoCommands: DemoCommand[] = [
  { name: "review", description: "Review the current changes" },
  { name: "release", description: "Prepare a release checklist" },
];

const richId = "s-rich";
const runningId = "s-running";
const approvalId = "s-approval";
const questionId = "s-question";
const failedId = "s-failed";
const emptyId = "s-empty";
const archivedId = "s-archived";
const worktreeId = "s-worktree";

function makeSession(id: string, title: string, project: DemoProject, status: Session["status"], updatedAt: string, extra: Partial<Session> = {}): Session {
  return { id, title, cwd: project.path, projectPath: project.path, createdAt: stamp(-86400000), updatedAt, status, model: model("openai", "gpt-5.5"), permissionMode: "ask", headId: null, ...extra };
}

export const demoSessions: Session[] = [
  makeSession(richId, "Refresh the CLI presentation layer", demoProjects[0]!, "completed", stamp(-90000)),
  makeSession(runningId, "Add client presentation helpers", demoProjects[0]!, "running", stamp(-12000), { model: model("deepseek", "deepseek-v3.2", "medium"), permissionMode: "accept_edits" }),
  makeSession(approvalId, "Check the release output", demoProjects[0]!, "waiting_approval", stamp(-5000), { permissionMode: "ask" }),
  makeSession(questionId, "Choose a changelog format", demoProjects[2]!, "waiting_approval", stamp(-3500), { model: model("anthropic", "claude-sonnet-4-5", "medium"), permissionMode: "ask" }),
  makeSession(failedId, "Investigate the failing integration test", demoProjects[1]!, "failed", stamp(-540000)),
  makeSession(emptyId, "New session", demoProjects[0]!, "idle", stamp(-2000)),
  makeSession(archivedId, "Prototype the old sync worker", demoProjects[1]!, "completed", stamp(-86400000 * 4), { archived: true }),
  makeSession(worktreeId, "Isolated parser experiment", demoProjects[2]!, "completed", stamp(-7200000), { cwd: "/work/agent-recipes/.worktrees/parser-experiment", worktree: "/work/agent-recipes/.worktrees/parser-experiment" }),
];

export const demoApprovals: Approval[] = [
  { id: "approval-bash", sessionId: approvalId, tool: "bash", args: { command: "pnpm release:publish --dry-run=false", cwd: "/work/VoidKagami" } },
  { id: "approval-question", sessionId: questionId, tool: "ask_user", args: {}, question: "Which changelog style should I use?", options: ["Keep a Changelog format", "Use short release notes", "Follow the existing README style"] },
];

interface Spec { type: string; data: Record<string, unknown>; offset: number; }
function event(id: string, seq: number, parentId: string | null, type: string, data: Record<string, unknown>, offset: number): SessionEvent {
  return { id: `${id}-e${String(seq).padStart(2, "0")}`, sessionId: id, parentId, seq, timestamp: stamp(offset), type, data };
}
function view(sessionId: string, events: SessionEvent[], approvals: Approval[] = [], live: Partial<Pick<SessionView, "streaming" | "thinking" | "progress">> = {}): SessionView {
  const session = demoSessions.find((item) => item.id === sessionId)!;
  const last = events.at(-1);
  session.headId = last?.id || null;
  if (last) session.updatedAt = last.timestamp;
  return { session: { ...session }, events, eventSeq: last?.seq || 0, approvals, context: demoContext, liveEpoch: "demo-epoch", liveRevision: sessionId === runningId ? 2 : 0, ...live };
}
function buildView(sessionId: string, specs: Spec[], approvals: Approval[] = [], live: Partial<Pick<SessionView, "streaming" | "thinking" | "progress">> = {}): SessionView {
  let parent: string | null = null;
  const events = specs.map((spec, index) => {
    const next = event(sessionId, index + 1, parent, spec.type, spec.data, spec.offset);
    parent = next.id;
    return next;
  });
  return view(sessionId, events, approvals, live);
}

const initial = (session: Session): Spec => ({ type: "session.created", offset: -600000, data: { session: { ...session, createdAt: stamp(-86400000), updatedAt: stamp(-600000), headId: null, status: "idle" } } });
const userMessage = (text: string, offset: number, attachments?: { type: "image" | "file"; path: string }): Spec => ({ type: "user.message", offset, data: { text, message: { role: "user", content: [{ type: "text", text }] }, ...(attachments ? { attachments: [attachments] } : {}) } });
const persisted = (eventIndex: number, role: "user" | "assistant", offset: number): Spec => ({ type: "message.persisted", offset, data: { message: { role, content: [] }, ...(role === "user" ? { sourceEventId: `${richId}-e${String(eventIndex).padStart(2, "0")}` } : {}) } });
const assistant = (text: string, thinking: string, offset: number, cost = 0.00615): Spec => ({ type: "assistant.message", offset, data: { message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text }], usage: { cost: { total: cost } } }, text } });
const call = (toolCallId: string, tool: string, args: Record<string, unknown>, offset: number): Spec => ({ type: "tool.call", offset, data: { toolCallId, tool, args } });
const result = (toolCallId: string, tool: string, text: string, offset: number, isError = false): Spec => ({ type: "tool.result", offset, data: { toolCallId, tool, result: { content: [{ type: "text", text }], details: {} }, isError } });
const plan = (items: { content: string; status: "pending" | "in_progress" | "completed" }[], offset: number): Spec => ({ type: "todo.updated", offset, data: { items } });

const rich = demoSessions.find((item) => item.id === richId)!;
const richSpecs: Spec[] = [
  initial(rich), userMessage("Please update the onboarding flow and check the command docs. 请保留原有兼容性。", -540000), persisted(2, "user", -539000),
  { type: "turn.started", offset: -535000, data: {} },
  { type: "assistant.message", offset: -530000, data: { message: { role: "assistant", content: [{ type: "thinking", thinking: "I will inspect the CLI and its command documentation first." }, { type: "text", text: "I’ll inspect the current flow, then make a focused update." }], usage: { cost: { total: 0.002 } } }, text: "I’ll inspect the current flow, then make a focused update." } },
  call("call-bash-1", "bash", { command: "pnpm check\nprintf 'ready\\n'" }, -520000), result("call-bash-1", "bash", "TypeScript check passed\nready", -515000),
  call("call-read-1", "read", { path: "packages/cli/src/commands.ts", offset: 1, limit: 80 }, -510000), result("call-read-1", "read", "1\tconst commandList = [...];", -506000),
  call("call-grep-1", "grep", { pattern: "onboarding", path: "packages", glob: "**/*.ts" }, -500000), result("call-grep-1", "grep", "packages/cli/src/commands.ts:42:onboarding", -496000),
  call("call-edit-1", "edit", { path: "packages/cli/src/commands.ts", old_text: "description: \"Start a new session\"", new_text: "description: \"Start a fresh session\"" }, -490000), result("call-edit-1", "edit", "Updated packages/cli/src/commands.ts (1 replacement)", -486000),
  call("call-patch-1", "apply_patch", { patch: "*** Begin Patch\n*** Update File: packages/cli/src/i18n.ts\n@@\n-  ready: \"Ready\",\n+  ready: \"Ready\",\n+  onboarding: \"Getting started\",\n*** Update File: packages/cli/src/commands.ts\n@@\n-  description: \"Start a new session\",\n+  description: \"Start a fresh session\",\n*** End Patch" }, -480000), result("call-patch-1", "apply_patch", "Updated packages/cli/src/i18n.ts\nUpdated packages/cli/src/commands.ts", -476000),
  call("call-write-1", "write", { path: "docs/onboarding.md", content: "# Getting started\n\nRun `voidkagami` to begin.\n" }, -470000), result("call-write-1", "write", "Wrote 48 bytes to docs/onboarding.md", -466000),
  call("call-bash-fail", "bash", { command: "pnpm test --filter missing-suite" }, -460000), result("call-bash-fail", "bash", "No projects matched the filters in \"/work/VoidKagami\"\n[exit 1; task task-2b41]", -455000, true),
  plan([{ content: "Inspect the CLI and documentation", status: "completed" }, { content: "Update onboarding copy", status: "completed" }, { content: "Run focused checks", status: "in_progress" }], -450000),
  assistant("The onboarding copy is updated. The first test command selected no project, so I’m using the client package directly.\n\n```sh\npnpm --filter @voidkagami/client test\n```\n\n- Updated onboarding copy\n- Kept shortcut guidance\n\n| Check | Result |\n| --- | --- |\n| TypeScript | Passed |\n| Client tests | Running |", "The docs use a small command catalog; I should keep the wording concise.", -445000, 0.004),
  { type: "turn.ended", offset: -440000, data: { status: "completed", cost: 0.006 } },
  userMessage("Could you add the English and Chinese command descriptions too?", -430000), persisted(23, "user", -429000),
  { type: "turn.started", offset: -425000, data: {} },
  call("call-edit-2", "edit", { path: "packages/cli/src/commands.ts", old_text: "Start a fresh session", new_text: "Start a fresh session / 新建会话" }, -420000), result("call-edit-2", "edit", "Updated packages/cli/src/commands.ts (1 replacement)", -415000),
  plan([{ content: "Inspect the CLI and documentation", status: "completed" }, { content: "Update onboarding copy", status: "completed" }, { content: "Add bilingual command descriptions", status: "completed" }, { content: "Run focused checks", status: "completed" }], -410000),
  assistant("Done. The command description now includes both languages, and the onboarding page keeps the original shortcut guidance.", "The follow-up is narrow and does not change command behavior.", -405000, 0.0063),
  { type: "turn.ended", offset: -400000, data: { status: "completed", cost: 0.0123 } },
];

const running = demoSessions.find((item) => item.id === runningId)!;
const runningSpecs: Spec[] = [initial(running), userMessage("Implement a shared summary helper for tool activity.", -30000), { type: "turn.started", offset: -12000, data: {} }, call("call-running-read", "read", { path: "packages/client/src/store.ts", offset: 1, limit: 120 }, -11000), result("call-running-read", "read", "export interface SessionState { ... }", -10500), call("call-running-grep", "grep", { pattern: "transcriptRevision", path: "packages/client/src" }, -9500), result("call-running-grep", "grep", "packages/client/src/store.ts:29", -9000), call("call-running-bash", "bash", { command: "pnpm test --filter @voidkagami/client" }, -8000)];
const approval = demoSessions.find((item) => item.id === approvalId)!;
const approvalSpecs: Spec[] = [initial(approval), userMessage("Publish the release after checking the dry run.", -18000), { type: "turn.started", offset: -14000, data: {} }, call("call-approval", "bash", { command: "pnpm release:publish --dry-run=false", cwd: "/work/VoidKagami" }, -9000), { type: "approval.requested", offset: -8000, data: { approval: demoApprovals[0] } }];
const question = demoSessions.find((item) => item.id === questionId)!;
const questionSpecs: Spec[] = [initial(question), userMessage("Prepare a concise changelog for this release.", -10000), { type: "turn.started", offset: -7000, data: {} }, call("call-question", "ask_user", { questions: [{ question: demoApprovals[1]!.question, options: demoApprovals[1]!.options }] }, -5000), { type: "approval.requested", offset: -4000, data: { approval: demoApprovals[1] } }];
const failed = demoSessions.find((item) => item.id === failedId)!;
const failedSpecs: Spec[] = [initial(failed), userMessage("Run the integration suite and report the failure.", -580000), { type: "turn.started", offset: -575000, data: {} }, call("call-failed-test", "bash", { command: "pnpm test -- --runInBand" }, -560000), result("call-failed-test", "bash", "Error: unknown option '--runInBand'", -555000, true), { type: "run.error", offset: -550000, data: { message: "The test runner does not support --runInBand." } }, { type: "turn.ended", offset: -549000, data: { status: "failed", cost: 0.0012 } }];
const empty = demoSessions.find((item) => item.id === emptyId)!;
const archived = demoSessions.find((item) => item.id === archivedId)!;
const worktree = demoSessions.find((item) => item.id === worktreeId)!;
const worktreeSpecs: Spec[] = [initial(worktree), userMessage("Try a lightweight parser in an isolated worktree.", -80000), { type: "turn.started", offset: -74000, data: {} }, call("call-wt-read", "read", { path: "README.md" }, -71000), result("call-wt-read", "read", "Parser experiment notes", -70000), assistant("The isolated workspace is ready for the parser experiment.", "I can compare the existing parser before editing.", -65000), { type: "turn.ended", offset: -62000, data: { status: "completed", cost: 0.003 } }];

export const demoViews: SessionView[] = [
  buildView(richId, richSpecs),
  buildView(runningId, runningSpecs, [], { thinking: "I’ll inspect the existing client contracts before adding the helpers.", streaming: "The existing tests are passing; I’m checking the new formatter.", progress: "PASS packages/client/src/store.test.ts\nRunning presentation tests…" }),
  buildView(approvalId, approvalSpecs, [demoApprovals[0]!]),
  buildView(questionId, questionSpecs, [demoApprovals[1]!]),
  buildView(failedId, failedSpecs),
  buildView(emptyId, [initial(empty)]),
  buildView(archivedId, [initial(archived), { type: "session.archived", offset: -500000, data: { archived: true } }]),
  buildView(worktreeId, worktreeSpecs),
];

export const demoLiveEvents: LiveEvent[] = [
  { sessionId: runningId, type: "assistant.delta", liveRevision: 1, liveEpoch: "demo-epoch", data: { delta: "I’ll inspect the existing client contracts", thinking: true } },
  { sessionId: runningId, type: "tool.progress", liveRevision: 2, liveEpoch: "demo-epoch", data: { toolCallId: "call-running-bash", tool: "bash", text: "PASS packages/client/src/store.test.ts\nRunning presentation tests…" } },
];

export const demoSessionIds = { rich: richId, running: runningId, approval: approvalId, question: questionId, failed: failedId, empty: emptyId, archived: archivedId, worktree: worktreeId } as const;
