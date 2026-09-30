import type { SlashCommand } from "@voidkagami/tui";
import { t } from "./i18n.ts";

const definitions: [string, string, string, string[]?][] = [
  ["help", "Show commands and shortcuts", "查看命令与快捷键"],
  ["new", "Start a new session (/clear)", "新建会话（别名 /clear）", ["clear"]],
  ["resume", "Choose a saved session", "恢复已保存的会话"],
  ["model", "Choose model and thinking effort", "选择模型与思考能力"],
  ["mode", "Change permission mode", "切换权限模式"],
  ["context", "Inspect context and usage", "查看上下文和用量"],
  ["compact", "Summarize the conversation", "压缩会话上下文"],
  ["fork", "Branch from a conversation turn", "从某条消息分叉"],
  ["rewind", "Rewind conversation and restore files", "回退会话与文件"],
  ["diff", "Show file changes", "查看文件差异"],
  ["tasks", "Show background tasks", "查看后台任务"],
  ["stop", "Stop a background task", "停止后台任务"],
  ["queue", "Queue input after the current run", "在本轮结束后发送消息"],
  ["rename", "Rename this session", "重命名会话"],
  ["login", "Sign in with ChatGPT or add an API key", "登录 ChatGPT 或配置 API 密钥"],
  ["logout", "Remove a provider credential", "移除服务商凭据"],
  ["settings", "Show daemon configuration", "查看配置"],
  ["language", "Choose English or Simplified Chinese", "选择简体中文或英文"],
  ["archive", "Archive the current session", "归档当前会话"],
  ["archived", "Restore an archived session", "恢复已归档的会话"],
  ["details", "Toggle full tool output and thinking (Ctrl+O)", "展开或收起完整工具输出与思考（Ctrl+O）"],
  ["effort", "Choose the model's thinking effort", "选择模型的思考能力"],
  ["attach", "Attach a file or image", "添加文件或图片"],
  ["attachments", "Remove a pending attachment", "移除待发送附件"],
  ["cancel-login", "Cancel a pending sign-in", "取消正在进行的登录"],
  ["exit", "Close the client; keep tasks running", "退出客户端，任务继续运行", ["quit"]],
];
export function commands(): SlashCommand[] { return definitions.map(([name, en, zh, aliases]) => ({ name, description: t(en, zh), aliases })); }
export function commandName(value: string) { return definitions.find(([name, , , aliases]) => name === value || aliases?.includes(value))?.[0] || value; }
