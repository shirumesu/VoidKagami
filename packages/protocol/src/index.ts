import type { Language } from "./i18n.ts";
export { normalizeLanguage, translate } from "./i18n.ts";
export type { Language } from "./i18n.ts";

export const PROTOCOL_VERSION = 1;
export const VERSION = "0.1.2";

export type PermissionMode = "ask" | "accept_edits" | "auto" | "plan";
export type SessionStatus = "idle" | "running" | "waiting_approval" | "interrupted" | "completed" | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelSelection { provider: string; id: string; thinkingLevel?: ThinkingLevel; }
export interface Attachment { type: "image" | "file"; path: string; }
export interface Session {
  id: string;
  title: string;
  cwd: string;
  projectPath?: string | null;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  model: ModelSelection;
  permissionMode: PermissionMode;
  headId: string | null;
  parentSessionId?: string;
  worktree?: string;
  archived?: boolean;
}
export interface SessionEvent {
  id: string;
  sessionId: string;
  parentId: string | null;
  seq: number;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}
export interface LiveEvent {
  sessionId: string;
  liveRevision?: number;
  liveEpoch?: string;
  type: "assistant.delta" | "tool.progress" | "status.changed" | "auth.progress";
  data: Record<string, unknown>;
}
export interface Approval {
  id: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  question?: string;
  options?: string[];
}
export interface ContextInfo {
  components: { name: string; tokens: number }[];
  estimated: true;
  tokens: number;
  limit: number;
  systemPrompt: string;
  messageCount: number;
  skills: { name: string; description: string; path: string }[];
  cost: number;
}
export interface SessionView {
  session: Session;
  events: SessionEvent[];
  eventSeq?: number;
  approvals: Approval[];
  context?: ContextInfo;
  streaming?: string;
  thinking?: string;
  progress?: string;
  liveRevision?: number;
  liveEpoch?: string;
}
export interface ModelInfo extends ModelSelection {
  name: string;
  contextWindow: number;
  authenticated: boolean;
  thinkingLevels: ThinkingLevel[];
}
export interface PermissionRule { tool: string; pattern?: string; arguments?: Record<string, string>; action: "allow" | "deny"; }
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export interface HookConfig { event: string; command: string; }
export interface ProviderConfig {
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  models: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }[];
}
export interface Config {
  language: Language;
  defaultWorkspace: string;
  defaultModel: ModelSelection;
  permissionMode: PermissionMode;
  rules: PermissionRule[];
  providers: Record<string, ProviderConfig>;
  mcpServers: Record<string, McpServerConfig>;
  hooks: HookConfig[];
  sandbox: boolean;
  compactThreshold: number;
  idleTimeoutMs: number;
}
export interface TaskInfo {
  id: string;
  sessionId: string;
  command: string;
  status: "running" | "completed" | "failed";
  pid?: number;
  exitCode?: number | null;
  output: string;
}
export interface RpcMethods {
  "hello": { params: { token: string; protocolVersion: number; clientVersion: string }; result: { protocolVersion: number; serverVersion: string; pid: number } };
  "daemon.status": { params: Record<string, never>; result: { pid: number; running: number; sessions: number; uptime: number } };
  "daemon.stop": { params: Record<string, never>; result: { stopped: boolean } };
  "session.create": { params: { cwd?: string; title?: string; model?: ModelSelection; permissionMode?: PermissionMode; worktree?: boolean; branch?: string; parentSessionId?: string }; result: Session };
  "session.list": { params: { query?: string; archived?: boolean }; result: Session[] };
  "session.attach": { params: { sessionId: string; afterSeq?: number }; result: SessionView };
  "session.detach": { params: { sessionId: string }; result: null };
  "session.send": { params: { sessionId: string; text: string; attachments?: Attachment[] }; result: { accepted: boolean } };
  "session.steer": { params: { sessionId: string; text: string; attachments?: Attachment[] }; result: { accepted: boolean } };
  "session.followUp": { params: { sessionId: string; text: string; attachments?: Attachment[] }; result: { accepted: boolean } };
  "session.abort": { params: { sessionId: string }; result: null };
  "session.rename": { params: { sessionId: string; title: string }; result: Session };
  "session.archive": { params: { sessionId: string; archived: boolean }; result: Session };
  "session.workspace": { params: { sessionId: string; cwd?: string | null; worktree?: boolean; branch?: string }; result: Session };
  "session.fork": { params: { sessionId: string; eventId?: string; worktree?: boolean }; result: Session };
  "session.rewind": { params: { sessionId: string; eventId: string; restoreFiles?: boolean }; result: Session };
  "session.context": { params: { sessionId: string }; result: ContextInfo };
  "session.compact": { params: { sessionId: string }; result: null };
  "session.diff": { params: { sessionId: string; eventId?: string; view?: "last-turn" | "branch"; baseBranch?: string }; result: { diff: string; currentBranch?: string; baseBranch?: string } };
  "session.mode": { params: { sessionId: string; mode: PermissionMode }; result: Session };
  "session.tasks": { params: { sessionId: string }; result: TaskInfo[] };
  "task.stop": { params: { sessionId: string; taskId: string }; result: null };
  "approval.respond": { params: { approvalId: string; allow: boolean; answer?: string; remember?: "project" | "global" }; result: null };
  "model.list": { params: Record<string, never>; result: ModelInfo[] };
  "model.select": { params: { sessionId: string; model: ModelSelection }; result: Session };
  "auth.login": { params: { provider: string }; result: { loginId: string } };
  "auth.respond": { params: { loginId: string; value: string }; result: null };
  "auth.cancel": { params: { loginId: string }; result: null };
  "auth.key": { params: { provider: string; apiKey: string }; result: null };
  "auth.logout": { params: { provider: string }; result: null };
  "auth.status": { params: Record<string, never>; result: { provider: string; type: string }[] };
  "config.get": { params: Record<string, never>; result: Config };
  "config.set": { params: Partial<Config>; result: Config };
  "project.branches": { params: { cwd: string }; result: string[] };
  "project.files": { params: { cwd: string; query?: string }; result: string[] };
  "commands.list": { params: { cwd: string }; result: { name: string; description: string }[] };
}
export type Method = keyof RpcMethods;
export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown; }
export interface RpcResponse { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string }; }
export interface RpcNotification { jsonrpc: "2.0"; method: "event" | "live" | "auth"; params: SessionEvent | LiveEvent | Record<string, unknown>; }

export function isBusy(status: SessionStatus): boolean {
  return status === "running" || status === "waiting_approval";
}
