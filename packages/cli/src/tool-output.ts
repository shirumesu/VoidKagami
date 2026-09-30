import { Text, truncateToWidth, visibleWidth } from "@voidkagami/tui";
import type { Component } from "@voidkagami/tui";
import { t } from "./i18n.ts";

export class ToolOutput implements Component {
  private tool: string;
  private args: Record<string, unknown>;
  private output: string;
  private expanded: boolean;
  private color: (value: string) => string;
  constructor(tool: string, args: Record<string, unknown>, output: string, expanded: boolean, color: (value: string) => string) {
    this.tool = tool; this.args = args; this.output = output; this.expanded = expanded; this.color = color;
  }
  invalidate() {}
  render(width: number) {
    const label = String(this.args.command || this.args.path || this.args.query || "");
    const summary = `${this.tool} ${label.replace(/\s+/g, " ").trim()}`.trim();
    if (this.expanded) return new Text(this.color(`${summary}\n${JSON.stringify(this.args, null, 2)}\n${this.output}`), 1, 0).render(width);
    const columns = Math.max(1, width - 2);
    const output = this.output ? this.output.split("\n") : [];
    const rows = [summary, ...output.slice(0, 3)];
    const clipped = /[\r\n]/.test(label) || output.length > 3 || rows.some((line) => visibleWidth(line) > columns);
    if (clipped) rows.push(t("… Ctrl+O for full input and output", "… Ctrl+O 查看完整输入与输出"));
    return rows.map((line) => ` ${this.color(truncateToWidth(line, columns, "…"))}`);
  }
}
