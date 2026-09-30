import { Container, Input, SelectList, Text, matchesKey } from "@voidkagami/tui";
import { t } from "./i18n.ts";
import type { SelectItem, SelectListTheme } from "@voidkagami/tui";

export class SearchPicker extends Container {
  private input = new Input({ prompt: "/ ", placeholder: t("Type to search", "输入以搜索") });
  private list!: SelectList;
  private items: SelectItem[];
  private theme: SelectListTheme;
  private maxVisible = 10;
  onSelect?: (value: string) => void;
  onCancel?: () => void;

  constructor(items: SelectItem[], theme: SelectListTheme) {
    super();
    this.items = items; this.theme = { ...theme, noMatch: () => theme.noMatch(t("  No matches", "  没有匹配项")) };
    this.input.focused = true;
    this.filter();
  }

  setMaxVisible(rows: number) {
    const count = Math.max(1, rows);
    if (count !== this.maxVisible) { this.maxVisible = count; this.filter(true); }
  }

  private filter(preserveSelection = false) {
    const selected = preserveSelection ? this.list?.getSelectedItem()?.value : undefined;
    const query = this.input.getValue().toLowerCase();
    const items = this.items.filter((item) => `${item.label} ${item.description || ""} ${item.value}`.toLowerCase().includes(query));
    this.list = new SelectList(items, this.maxVisible, this.theme);
    if (selected !== undefined) this.list.setSelectedIndex(items.findIndex((item) => item.value === selected));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
    this.clear();
    this.addChild(this.input);
    this.addChild(this.list);
    this.addChild(new Text(this.theme.description(t("↑↓ select · Enter confirm · Esc cancel", "↑↓ 选择 · Enter 确认 · Esc 取消")), 1, 0));
  }

  handleInput(data: string) {
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      for (let row = 0; row < this.maxVisible; row++) this.list.handleInput(matchesKey(data, "pageUp") ? "\x1b[A" : "\x1b[B");
    }
    else if ((["up", "down", "enter", "escape", "ctrl+c"] as const).some((key) => matchesKey(data, key))) this.list.handleInput(data);
    else { const before = this.input.getValue(); this.input.handleInput(data); if (before !== this.input.getValue()) this.filter(); }
  }
}
