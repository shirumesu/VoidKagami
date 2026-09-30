import React, { useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "./i18n.ts";
import { Select } from "./select.tsx";
import { Icon } from "./icons.tsx";

type ThemePreference = "system" | "light" | "dark";
interface Appearance {
  theme: ThemePreference;
  fontFamily: string;
  codeFontFamily: string;
  fontSize: number;
  codeFontSize: number;
  customColors: boolean;
  background: string;
  foreground: string;
  contrast: number;
}

const storageKey = "appearance";
const systemFont = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", sans-serif';
const systemCodeFont = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const palettes = {
  light: { background: "#FFFFFF", foreground: "#0D0D0D" },
  dark: { background: "#1A1A1B", foreground: "#ECECEC" },
};
const defaults: Appearance = { theme: "system", fontFamily: "system", codeFontFamily: "system", fontSize: 14, codeFontSize: 12.5, customColors: false, background: palettes.light.background, foreground: palettes.light.foreground, contrast: 45 };
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const hexColor = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
let currentAppearance: Appearance = { ...defaults };
let systemTheme: MediaQueryList | undefined;

function normalize(value: Partial<Appearance>, fallback: Appearance): Appearance {
  const palette = value.theme === "dark" ? palettes.dark : palettes.light;
  const background = hexColor(value.background, palette.background);
  const foreground = hexColor(value.foreground, palette.foreground);
  return {
    theme: value.theme === "light" || value.theme === "dark" || value.theme === "system" ? value.theme : fallback.theme,
    fontFamily: typeof value.fontFamily === "string" && value.fontFamily.trim() ? value.fontFamily.trim() : fallback.fontFamily,
    codeFontFamily: typeof value.codeFontFamily === "string" && value.codeFontFamily.trim() ? value.codeFontFamily.trim() : fallback.codeFontFamily,
    fontSize: bounded(value.fontSize, fallback.fontSize, 10, 24),
    codeFontSize: bounded(value.codeFontSize, fallback.codeFontSize, 9, 24),
    customColors: typeof value.customColors === "boolean" ? value.customColors : background !== palette.background || foreground !== palette.foreground || (value.contrast !== undefined && value.contrast !== fallback.contrast),
    background,
    foreground,
    contrast: bounded(value.contrast, fallback.contrast, 0, 100),
  };
}

function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as { presetId?: string; values?: Partial<Appearance> } | Partial<Appearance> | null;
    if (!saved) return { ...defaults };
    const legacy = "values" in saved && saved.values ? saved.values : saved as Partial<Appearance>;
    const legacyTheme = legacy.theme === "dark" ? "dark" : legacy.theme === "light" && !("presetId" in saved && saved.presetId === "normal") ? "light" : "system";
    return normalize({ ...legacy, theme: legacyTheme }, defaults);
  } catch { return { ...defaults }; }
}

function mix(background: string, foreground: string, amount: number): string {
  return "#" + [1, 3, 5].map((offset) => Math.round(parseInt(background.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(foreground.slice(offset, offset + 2), 16) * amount).toString(16).padStart(2, "0")).join("");
}

function applyAppearance(value: Appearance) {
  currentAppearance = value;
  const resolved = value.theme === "system" ? systemTheme?.matches ? "dark" : "light" : value.theme;
  const root = document.documentElement;
  const palette = palettes[resolved];
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  root.style.setProperty("--font-ui", value.fontFamily === "system" ? systemFont : value.fontFamily);
  root.style.setProperty("--font-code", value.codeFontFamily === "system" ? systemCodeFont : value.codeFontFamily);
  root.style.setProperty("--ui-font-size", `${value.fontSize}px`);
  root.style.setProperty("--code-font-size", `${value.codeFontSize}px`);
  const overrides = ["--bg", "--bg-sidebar", "--bg-elevated", "--bg-subtle", "--bg-hover", "--bg-active", "--text", "--text-secondary", "--text-tertiary", "--border", "--border-strong", "--primary", "--primary-text"];
  if (value.customColors) {
    const { background, foreground } = value;
    const contrast = value.contrast / 100;
    const surface = (amount: number) => mix(background, foreground, amount);
    root.style.setProperty("--bg", background);
    root.style.setProperty("--bg-sidebar", surface(0.02 + contrast * 0.04));
    root.style.setProperty("--bg-elevated", surface(0.035 + contrast * 0.065));
    root.style.setProperty("--bg-subtle", surface(0.055 + contrast * 0.10));
    root.style.setProperty("--bg-hover", surface(0.055 + contrast * 0.10));
    root.style.setProperty("--bg-active", surface(0.075 + contrast * 0.15));
    root.style.setProperty("--text", foreground);
    root.style.setProperty("--text-secondary", surface(0.65 + contrast * 0.22));
    root.style.setProperty("--text-tertiary", surface(0.48 + contrast * 0.25));
    root.style.setProperty("--border", surface(0.10 + contrast * 0.20));
    root.style.setProperty("--border-strong", surface(0.22 + contrast * 0.25));
    root.style.setProperty("--primary", foreground);
    root.style.setProperty("--primary-text", background);
  } else {
    for (const name of overrides) root.style.removeProperty(name);
    root.style.setProperty("--bg", palette.background);
    root.style.setProperty("--text", palette.foreground);
  }
  void window.voidkagami.setAppearance({ theme: value.theme, background: value.customColors ? value.background : palette.background });
}

export function initializeAppearance() {
  systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  systemTheme.addEventListener("change", () => { if (currentAppearance.theme === "system") applyAppearance(currentAppearance); });
  applyAppearance(loadAppearance());
}

function NumberControl({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <div className="number-control"><input aria-label={label} type="number" step="0.5" min={min} max={max} value={text} onChange={(event) => { setText(event.target.value); const next = event.target.valueAsNumber; if (Number.isFinite(next) && next >= min && next <= max) onChange(next); }} onBlur={() => { const next = text.trim() ? bounded(Number(text), value, min, max) : value; setText(String(next)); onChange(next); }} /><span>px</span></div>;
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <label>{label}<span className="appearance-color"><input type="color" aria-label={`${label} ${t("color", "颜色")}`} value={value} onChange={(event) => onChange(event.target.value)} /><input aria-label={`${label} ${t("hex", "色值")}`} value={text} maxLength={7} spellCheck={false} onChange={(event) => { setText(event.target.value); if (/^#[\da-f]{6}$/i.test(event.target.value)) onChange(event.target.value); }} onBlur={() => setText(value)} /></span></label>;
}

function FontControl({ label, value, code = false, onChange }: { label: string; value: string; code?: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const [customText, setCustomText] = useState(value);
  useEffect(() => setCustomText(value), [value]);
  const choices = [{ value: "system", label: code ? t("System monospace", "系统等宽字体") : t("System font", "系统字体") }, { value: "sans-serif", label: t("Sans serif", "无衬线字体") }, { value: "serif", label: t("Serif", "衬线字体") }, { value: "monospace", label: t("Monospace", "等宽字体") }];
  const custom = !choices.some((choice) => choice.value === value);
  return <div className="font-control"><Select aria-label={label} value={custom ? "custom" : value} onChange={(event) => onChange(event.target.value === "custom" ? code ? '"Courier New", monospace' : "Arial, sans-serif" : event.target.value)}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}<option value="custom">{t("Custom font family", "自定义字体")}</option></Select>{custom && <input aria-label={`${t("Custom", "自定义")} ${label}`} value={customText} spellCheck={false} onChange={(event) => setCustomText(event.target.value)} onBlur={() => { if (customText.trim()) onChange(customText.trim()); else setCustomText(value); }} placeholder={code ? "Menlo, Consolas, monospace" : "Segoe UI, sans-serif"} />}</div>;
}

export function AppearanceSettings() {
  const { t } = useI18n();
  const [value, setValue] = useState(loadAppearance);
  const [saveError, setSaveError] = useState("");
  useLayoutEffect(() => {
    applyAppearance(value);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); setSaveError(""); }
    catch { setSaveError(t("Appearance could not be saved on this device.", "无法在当前设备保存外观设置。")); }
  }, [value]);
  const update = (patch: Partial<Appearance>) => setValue((current) => ({ ...current, ...patch }));
  return <section className="appearance-settings">
    <div className="settings-card appearance-card">
      <div className="setting-row"><div><strong>{t("Theme", "主题")}</strong><small>{t("Follow the system or choose a fixed appearance.", "跟随系统或固定外观。")}</small></div><div className="segmented" role="group" aria-label={t("Theme", "主题")}>{(["system", "light", "dark"] as const).map((theme) => <button type="button" className={value.theme === theme ? "selected" : ""} key={theme} onClick={() => update({ theme })}>{theme === "system" ? t("System", "跟随系统") : theme === "light" ? t("Light", "浅色") : t("Dark", "深色")}</button>)}</div></div>
      <div className="setting-row"><div><strong>{t("Interface font", "界面字体")}</strong><small>{t("Font used for the application interface.", "应用界面使用的字体。")}</small></div><FontControl label={t("Font family", "字体系列")} value={value.fontFamily} onChange={(fontFamily) => update({ fontFamily })} /></div>
      <div className="setting-row"><div><strong>{t("Code font", "代码字体")}</strong><small>{t("Font used for code and tool output.", "代码和工具输出使用的字体。")}</small></div><FontControl label={t("Code font family", "代码字体系列")} value={value.codeFontFamily} code onChange={(codeFontFamily) => update({ codeFontFamily })} /></div>
      <div className="setting-row"><div><strong>{t("Interface size", "界面字号")}</strong></div><NumberControl label={t("UI size (px)", "界面字号（px）")} value={value.fontSize} min={10} max={24} onChange={(fontSize) => update({ fontSize })} /></div>
      <div className="setting-row"><div><strong>{t("Code size", "代码字号")}</strong></div><NumberControl label={t("Code size (px)", "代码字号（px）")} value={value.codeFontSize} min={9} max={24} onChange={(codeFontSize) => update({ codeFontSize })} /></div>
    </div>
    <details className="settings-card custom-colors"><summary><Icon name="chevron" className="disclosure-chevron" />{t("Custom colors", "自定义颜色")}</summary><div className="custom-colors-content"><label className="checkbox-label"><input type="checkbox" checked={value.customColors} onChange={(event) => { const resolved = value.theme === "system" ? systemTheme?.matches ? "dark" : "light" : value.theme; update({ customColors: event.target.checked, ...(event.target.checked ? palettes[resolved] : {}) }); }} />{t("Override theme colors", "覆盖主题颜色")}</label>{value.customColors && <><ColorControl label={t("Background", "背景")} value={value.background} onChange={(background) => update({ background })} /><ColorControl label={t("Foreground", "前景")} value={value.foreground} onChange={(foreground) => update({ foreground })} /><label>{t("Contrast", "对比度")}<span className="appearance-contrast"><input aria-label={t("Appearance contrast", "外观对比度")} type="range" min={0} max={100} value={value.contrast} onChange={(event) => update({ contrast: Number(event.target.value) })} /><output>{value.contrast}</output></span></label></>}</div></details>
    <p className="muted appearance-note">{t("Changes are saved automatically. Reduced motion is respected.", "更改会自动保存，并遵循减少动态效果设置。")}</p>
    {saveError && <p className="error-text" role="alert">{saveError}</p>}
  </section>;
}
