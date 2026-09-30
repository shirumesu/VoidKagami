import { Container, Input, SelectList, Text, matchesKey } from "@voidkagami/tui";
import type { SelectItem, SelectListTheme } from "@voidkagami/tui";
import { t } from "./i18n.ts";

export interface SearchPickerOptions {
  searchable?: boolean;
  quickPickCount?: number;
  hint?: string;
}

export class SearchPicker extends Container {
  private input?: Input;
  private list!: SelectList;
  private items: SelectItem[];
  private filteredItems: SelectItem[] = [];
  private theme: SelectListTheme;
  private searchable: boolean;
  private quickPickCount: number;
  private hint: string;
  private maxVisible = 10;
  onSelect?: (value: string) => void;
  onCancel?: () => void;

  constructor(items: SelectItem[], theme: SelectListTheme, options: SearchPickerOptions = {}) {
    super();
    this.items = items;
    this.theme = { ...theme, noMatch: () => theme.noMatch(t("  No matches", "  没有匹配项")) };
    this.searchable = options.searchable ?? true;
    this.quickPickCount = options.quickPickCount ?? 9;
    this.hint = options.hint || t(`↑↓ select · enter confirm · 1-${this.quickPickCount} quick pick · esc cancel`, `↑↓ 选择 · enter 确认 · 1-${this.quickPickCount} 快速选择 · esc 取消`);
    if (this.searchable) { this.input = new Input({ prompt: "/ ", placeholder: t("Type to search", "输入以搜索") }); this.input.focused = true; }
    this.filter();
  }

  setMaxVisible(rows: number) {
    const count = Math.max(1, rows);
    if (count !== this.maxVisible) { this.maxVisible = count; this.filter(true); }
  }
  selectIndex(index: number) {
    if (index < 0 || index >= this.filteredItems.length) return;
    this.list.setSelectedIndex(index);
    const item = this.list.getSelectedItem();
    if (item) this.onSelect?.(item.value);
  }

  private filter(preserveSelection = false) {
    const selected = preserveSelection ? this.list?.getSelectedItem()?.value : undefined;
    const query = this.input?.getValue().toLowerCase() || "";
    const matches = this.items.filter((item) => `${item.label} ${item.description || ""} ${item.value}`.toLowerCase().includes(query));
    this.filteredItems = matches.map((item, index) => ({ ...item, label: `${index + 1}. ${item.label}` }));
    this.list = new SelectList(this.filteredItems, this.maxVisible, this.theme);
    if (selected !== undefined) this.list.setSelectedIndex(this.filteredItems.findIndex((item) => item.value === selected));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
    this.clear();
    if (this.input) this.addChild(this.input);
    this.addChild(this.list);
    this.addChild(new Text(this.theme.description(this.hint), 0, 0));
  }

  handleInput(data: string) {
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      for (let row = 0; row < this.maxVisible; row++) this.list.handleInput(matchesKey(data, "pageUp") ? "\x1b[A" : "\x1b[B");
      return;
    }
    const query = this.input?.getValue().trim() || "";
    if (/^[1-9]$/.test(data) && Number(data) <= this.quickPickCount && (!this.searchable || !query)) { this.selectIndex(Number(data) - 1); return; }
    if ((["up", "down", "enter", "escape", "ctrl+c"] as const).some((key) => matchesKey(data, key))) { this.list.handleInput(data); return; }
    if (this.input) {
      const before = this.input.getValue(); this.input.handleInput(data);
      if (before !== this.input.getValue()) this.filter(true);
    }
  }
}
