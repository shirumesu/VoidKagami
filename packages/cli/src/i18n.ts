import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLanguage, translate } from "@voidkagami/protocol";
import type { Language } from "@voidkagami/protocol";

let language: Language = normalizeLanguage(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG);

export function setLanguage(value?: string) { language = normalizeLanguage(value); }
export function getLanguage() { return language; }
export function t(en: string, zh: string) { return translate(language, en, zh); }
export function loadLanguage() {
  try {
    const config = JSON.parse(readFileSync(join(process.env.VOIDKAGAMI_HOME || join(homedir(), ".voidkagami"), "config.json"), "utf8"));
    if (config.language) setLanguage(config.language);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function statusLabel(status: string): string {
  const labels: Record<string, [string, string]> = {
    idle: ["Ready", "就绪"], running: ["Working", "执行中"], waiting_approval: ["Waiting for approval", "等待审批"], completed: ["Completed", "已完成"], failed: ["Failed", "失败"], interrupted: ["Stopped", "已停止"],
    connected: ["Connected", "已连接"], connecting: ["Connecting", "连接中"], disconnected: ["Disconnected", "已断开"], reconnecting: ["Reconnecting", "重新连接中"],
    ask: ["Ask before changes", "修改前询问"], accept_edits: ["Accept file edits", "允许文件编辑"], auto: ["Fully automatic", "完全自动"], plan: ["Plan (read only)", "规划（只读）"],
    off: ["Off", "关闭"], minimal: ["Minimal", "最少"], low: ["Low", "低"], medium: ["Medium", "中"], high: ["High", "高"], xhigh: ["Extra high", "更高"], max: ["Maximum", "最大"], ultra: ["Ultra", "极高"],
    steer: ["Steering", "引导"], followUp: ["Follow-up", "后续消息"], queued: ["Queued", "已排队"], delivered: ["Delivered", "已发送"], user: ["You", "你"], assistant: ["Assistant", "助手"],
  };
  return labels[status] ? t(...labels[status]) : status;
}
