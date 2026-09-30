import { stripTerminalSequences, visibleWidth } from "@voidkagami/tui";

export const snapshotNames = ["empty-welcome", "rich-collapsed", "rich-details", "running-progress", "bash-approval", "ask-user", "model-picker", "help", "help-banner"] as const;
export type SnapshotName = typeof snapshotNames[number];

export function stripSnapshot(lines: string[]) { return lines.map((line) => stripTerminalSequences(line)); }
export function snapshotWidth(lines: string[]) { return Math.max(0, ...lines.map((line) => visibleWidth(line))); }
