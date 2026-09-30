import { Input, matchesKey, truncateToWidth, visibleWidth } from "@voidkagami/tui";
import type { Component, SelectListTheme } from "@voidkagami/tui";
import type { ModelInfo, ModelSelection, ThinkingLevel } from "@voidkagami/protocol";
import { t, statusLabel } from "./i18n.ts";

export class ModelPicker implements Component {
  private input = new Input({ prompt: "/ ", placeholder: t("Type to search", "输入以搜索") });
  private models: ModelInfo[];
  private theme: SelectListTheme;
  private levels = new Map<ModelInfo, ThinkingLevel>();
  private selected = 0;
  private maxVisible = 8;
  onSelect?: (model: ModelSelection) => void;
  onCancel?: () => void;

  constructor(models: ModelInfo[], current: ModelSelection, theme: SelectListTheme) {
    this.models = models; this.theme = theme;
    this.selected = Math.max(0, models.findIndex((model) => model.provider === current.provider && model.id === current.id));
    for (const model of models) {
      const preferred = model.provider === current.provider && model.id === current.id ? current.thinkingLevel || model.thinkingLevel : model.thinkingLevel || "medium";
      this.levels.set(model, model.thinkingLevels.find((level) => level === preferred) || model.thinkingLevels[0] || "off");
    }
    this.input.focused = true;
  }
  invalidate() {}
  setMaxVisible(rows: number) { this.maxVisible = Math.max(1, rows - 6); }
  private filtered() {
    const query = this.input.getValue().trim().toLowerCase();
    return this.models.filter((model) => `${model.name} ${model.provider}/${model.id}`.toLowerCase().includes(query));
  }
  render(width: number) {
    const models = this.filtered();
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.maxVisible / 2), models.length - this.maxVisible));
    const border = this.theme.description("─".repeat(width));
    const lines = [border, ...this.input.render(width), border];
    const nameWidth = Math.min(36, Math.max(12, width - 30));
    for (let index = start; index < Math.min(models.length, start + this.maxVisible); index++) {
      const model = models[index]!;
      const active = index === this.selected;
      const name = truncateToWidth(model.name, nameWidth, "…");
      const level = this.levels.get(model)!;
      const effortIndex = model.thinkingLevels.indexOf(level);
      const effort = model.thinkingLevels.length > 1 ? `${active ? "← " : "  "}${"▪".repeat(effortIndex + 1)}${"·".repeat(model.thinkingLevels.length - effortIndex - 1)}${active ? " →" : "  "} ${statusLabel(level)}` : statusLabel(level);
      const row = `${active ? "❯ " : "  "}${name}${" ".repeat(Math.max(1, nameWidth - visibleWidth(name) + 2))}${effort}`;
      lines.push(truncateToWidth(active ? this.theme.selectedText(row) : row, width));
    }
    if (!models.length) lines.push(this.theme.noMatch(t("  No matching models", "  没有匹配的模型")));
    if (models.length > this.maxVisible) lines.push(this.theme.scrollInfo(`  ${this.selected + 1}/${models.length}`));
    const model = models[this.selected];
    lines.push("", this.theme.description(truncateToWidth(model ? `  ${model.provider}/${model.id} · ${Math.round(model.contextWindow / 1000)}k ${t("context", "上下文")}` : "", width)), "", this.theme.description(truncateToWidth(t("↑↓ select · ←→ thinking effort · Enter confirm · Esc cancel", "↑↓ 选择模型 · ←→ 思考能力 · Enter 确认 · Esc 取消"), width)));
    return lines;
  }
  handleInput(data: string) {
    const models = this.filtered();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.onCancel?.(); return; }
    if (matchesKey(data, "enter")) {
      const model = models[this.selected];
      if (model) this.onSelect?.({ provider: model.provider, id: model.id, thinkingLevel: this.levels.get(model) });
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const amount = matchesKey(data, "pageUp") || matchesKey(data, "pageDown") ? this.maxVisible : 1;
      const direction = matchesKey(data, "up") || matchesKey(data, "pageUp") ? -1 : 1;
      this.selected = models.length ? (this.selected + direction * amount + models.length) % models.length : 0;
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const model = models[this.selected];
      if (model?.thinkingLevels.length) {
        const index = model.thinkingLevels.indexOf(this.levels.get(model)!);
        this.levels.set(model, model.thinkingLevels[Math.max(0, Math.min(model.thinkingLevels.length - 1, index + (matchesKey(data, "left") ? -1 : 1)))]!);
      }
      return;
    }
    const before = this.input.getValue(); this.input.handleInput(data);
    if (before !== this.input.getValue()) this.selected = 0;
  }
}
