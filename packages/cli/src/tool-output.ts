import { truncateToWidth, visibleWidth } from "@voidkagami/tui";
import type { Component } from "@voidkagami/tui";
import type { TranscriptItem } from "@voidkagami/client";
import { describeTool, truncateEnd, truncateMiddle } from "@voidkagami/client";
import { t } from "./i18n.ts";
import { accent, dim, green, red, yellow } from "./theme.ts";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ToolOutput implements Component {
  private item: TranscriptItem;
  private cwd: string;
  private expanded: boolean;
  private frame: () => number;
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(item: TranscriptItem, cwd: string, expanded: boolean, frame: () => number = () => 0) { this.item = item; this.cwd = cwd; this.expanded = expanded; this.frame = frame; }
  invalidate() { this.cachedWidth = undefined; this.cachedLines = undefined; }
  render(width: number) {
    if (this.item.toolStatus !== "running" && this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const description = describeTool(this.item, t, this.cwd);
    const status = this.item.toolStatus;
    const symbol = status === "running" ? accent(spinnerFrames[this.frame() % spinnerFrames.length]!) : status === "error" || this.item.error ? red("✗") : status === "interrupted" ? yellow("✗") : green("✓");
    const verb = status === "running" ? description.activeVerb : description.verb;
    const stats = `${description.added ? ` ${green(`+${description.added}`)}` : ""}${description.removed ? ` ${red(`−${description.removed}`)}` : ""}`;
    const prefix = `  ${symbol} ${verb}${description.target ? " " : ""}`;
    const targetWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(stats));
    const target = this.item.tool === "bash" ? truncateEnd(description.target, targetWidth) : truncateMiddle(description.target, targetWidth);
    const title = `${prefix}${dim(target)}${stats}`;
    const args = this.item.toolArgs || {};
    const command = String(args.command || "");
    const input = this.item.tool === "bash" ? `$ ${command}` : JSON.stringify(args, null, 2);
    const output = this.item.text && status !== "running" ? this.item.text.split(/\r?\n/) : [];
    if (this.expanded) {
      const rows = [title, ...input.split("\n").map((line) => `    ${line}`), ...output.map((line) => `    ${line}`)].map((line) => truncateToWidth(this.item.error ? red(line) : line, width));
      return this.cache(rows, width);
    }
    const editSucceeded = ["write", "edit", "apply_patch"].includes(this.item.tool || "") && status === "completed" && !this.item.error;
    const showOutput = Boolean(output.length) && (Boolean(this.item.error) || (!description.readOnly && !editSucceeded));
    const preview = showOutput ? output.slice(0, 3) : [];
    const rows = [title, ...preview.map((line, index) => {
      const prefix = index === 0 ? `    ${dim("└")} ` : "      ";
      const content = truncateToWidth(line, Math.max(1, width - visibleWidth(prefix)));
      return `${prefix}${this.item.error ? red(content) : dim(content)}`;
    })];
    if (showOutput && output.length > preview.length) rows.push(dim(`      ${t(`… +${output.length - preview.length} lines · ctrl+o to expand`, `… +${output.length - preview.length} 行 · ctrl+o 展开`)}`));
    return this.cache(rows, width);
  }
  private cache(lines: string[], width: number) {
    if (this.item.toolStatus !== "running") { this.cachedWidth = width; this.cachedLines = lines; }
    return lines;
  }
}
