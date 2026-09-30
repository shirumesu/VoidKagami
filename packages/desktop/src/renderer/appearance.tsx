import React, { useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "./i18n.ts";

type Theme = "light" | "dark";
interface Appearance {
  theme: Theme;
  background: string;
  foreground: string;
  fontFamily: string;
  codeFontFamily: string;
  fontSize: number;
  codeFontSize: number;
  contrast: number;
}
interface AppearancePreference { presetId: string; values: Appearance; }

const themeColors = {
  light: { background: "#FFFFFF", foreground: "#0D0D0D" },
  dark: { background: "#171717", foreground: "#E7E7E7" },
};
const presets: { id: string; name: string; values: Appearance }[] = [{
  id: "normal", name: "常规", values: {
    theme: "light", ...themeColors.light, fontFamily: "system", codeFontFamily: "system", fontSize: 14, codeFontSize: 12, contrast: 45,
  },
}];
const systemFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const systemCodeFont = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
const storageKey = "appearance";
const bounded = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
const hexColor = (value: unknown, fallback: string) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;

function normalize(values: Partial<Appearance>, defaults: Appearance): Appearance {
  return {
    theme: values.theme === "dark" ? "dark" : "light",
    background: hexColor(values.background, defaults.background),
    foreground: hexColor(values.foreground, defaults.foreground),
    fontFamily: typeof values.fontFamily === "string" && values.fontFamily.trim() ? values.fontFamily.trim() : defaults.fontFamily,
    codeFontFamily: typeof values.codeFontFamily === "string" && values.codeFontFamily.trim() ? values.codeFontFamily.trim() : defaults.codeFontFamily,
    fontSize: bounded(values.fontSize, defaults.fontSize, 10, 24),
    codeFontSize: bounded(values.codeFontSize, defaults.codeFontSize, 9, 24),
    contrast: bounded(values.contrast, defaults.contrast, 0, 100),
  };
}

function loadAppearance(): AppearancePreference {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as Partial<AppearancePreference> | null;
    const preset = presets.find((item) => item.id === saved?.presetId) || presets[0]!;
    return { presetId: preset.id, values: normalize(saved?.values || {}, preset.values) };
  } catch { return { presetId: presets[0]!.id, values: { ...presets[0]!.values } }; }
}

function mix(background: string, foreground: string, amount: number): string {
  return "#" + [1, 3, 5].map((offset) => Math.round(parseInt(background.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(foreground.slice(offset, offset + 2), 16) * amount).toString(16).padStart(2, "0")).join("");
}

function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  const { background, foreground } = value;
  const contrast = value.contrast / 100;
  const surface = (amount: number) => mix(background, foreground, amount);
  const dark = [1, 3, 5].reduce((total, offset, index) => total + parseInt(background.slice(offset, offset + 2), 16) * [0.2126, 0.7152, 0.0722][index]!, 0) < 128;
  const success = dark ? "#A6C9AE" : "#246B37";
  const danger = dark ? "#F0ADAD" : "#A32323";
  const warning = dark ? "#D6BB8B" : "#80520A";
  const variables: Record<string, string> = {
    "background": background, "foreground": foreground,
    "font-family": value.fontFamily === "system" ? systemFont : value.fontFamily,
    "code-font-family": value.codeFontFamily === "system" ? systemCodeFont : value.codeFontFamily,
    "ui-font-size": `${value.fontSize}px`, "code-font-size": `${value.codeFontSize}px`,
    "surface": surface(0.02 + contrast * 0.04), "surface-raised": surface(0.035 + contrast * 0.065),
    "surface-hover": surface(0.055 + contrast * 0.10), "surface-selected": surface(0.075 + contrast * 0.15),
    "border": surface(0.10 + contrast * 0.20), "border-strong": surface(0.22 + contrast * 0.25),
    "text-secondary": surface(0.65 + contrast * 0.22), "text-muted": surface(0.58 + contrast * 0.25),
    "text-faint": surface(0.48 + contrast * 0.25), "focus": surface(0.60 + contrast * 0.20),
    "primary": foreground, "primary-text": background, "primary-hover": mix(foreground, background, 0.10),
    "success": success, "danger": danger, "warning": warning,
    "success-surface": mix(background, success, 0.08 + contrast * 0.08),
    "danger-surface": mix(background, danger, 0.08 + contrast * 0.08),
    "warning-surface": mix(background, warning, 0.08 + contrast * 0.08),
    "danger-border": mix(background, danger, 0.35 + contrast * 0.15),
    "warning-border": mix(background, warning, 0.35 + contrast * 0.15),
    "shadow": dark ? "#00000066" : "#0000001F", "backdrop": dark ? "#00000088" : "#00000040",
  };
  for (const [name, color] of Object.entries(variables)) root.style.setProperty(`--${name}`, color);
  root.style.colorScheme = value.theme;
  root.dataset.theme = value.theme;
  void window.voidkagami.setAppearance({ theme: value.theme, background });
}

export function initializeAppearance() { applyAppearance(loadAppearance().values); }

function NumberControl({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label>{label}<input type="number" min={min} max={max} value={text} onChange={(event) => { setText(event.target.value); const next = event.target.valueAsNumber; if (Number.isFinite(next) && next >= min && next <= max) onChange(next); }} onBlur={() => { const next = text.trim() ? bounded(Number(text), value, min, max) : value; setText(String(next)); onChange(next); }} /></label>;
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
  return <label>{label}<select value={custom ? "custom" : value} onChange={(event) => onChange(event.target.value === "custom" ? code ? '"Courier New", monospace' : 'Arial, sans-serif' : event.target.value)}>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}<option value="custom">{t("Custom font family", "自定义字体")}</option></select>{custom && <input aria-label={`${t("Custom", "自定义")} ${label}`} value={customText} spellCheck={false} onChange={(event) => setCustomText(event.target.value)} onBlur={() => { if (customText.trim()) onChange(customText.trim()); else setCustomText(value); }} placeholder={code ? "Menlo, monospace" : "Arial, sans-serif"} />}</label>;
}

export function AppearanceSettings() {
  const { t } = useI18n();
  const [preference, setPreference] = useState(loadAppearance);
  const [saveError, setSaveError] = useState("");
  const preset = presets.find((item) => item.id === preference.presetId) || presets[0]!;
  const value = preference.values;
  useLayoutEffect(() => {
    applyAppearance(value);
    try { localStorage.setItem(storageKey, JSON.stringify(preference)); setSaveError(""); }
    catch { setSaveError(t("Appearance could not be saved on this device.", "无法在当前设备保存外观设置。")); }
  }, [preference]);
  const update = (patch: Partial<Appearance>) => setPreference((current) => ({ ...current, values: normalize({ ...current.values, ...patch }, preset.values) }));
  return <section className="appearance-settings">
    <h3>{t("Appearance", "外观")}</h3>
    <div className="appearance-preset"><label>{t("Preset", "预设")}<select value={preset.id} onChange={(event) => { const selected = presets.find((item) => item.id === event.target.value)!; setPreference({ presetId: selected.id, values: { ...selected.values } }); }}>{presets.map((item) => <option key={item.id} value={item.id}>{t("Regular", item.name)}</option>)}</select></label><button type="button" onClick={() => setPreference({ presetId: preset.id, values: { ...preset.values } })}>{t("Reset to preset defaults", "重置为预设默认值")}</button></div>
    <div className="appearance-grid">
      <label>{t("Theme", "主题")}<select value={value.theme} onChange={(event) => { const theme = event.target.value as Theme; update({ theme, ...themeColors[theme] }); }}><option value="light">{t("Light", "浅色")}</option><option value="dark">{t("Dark", "深色")}</option></select></label>
      <div />
      <FontControl label={t("Interface font", "界面字体")} value={value.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
      <FontControl label={t("Code font", "代码字体")} value={value.codeFontFamily} code onChange={(codeFontFamily) => update({ codeFontFamily })} />
      <NumberControl label={t("Interface size (px)", "界面字号（px）")} value={value.fontSize} min={10} max={24} onChange={(fontSize) => update({ fontSize })} />
      <NumberControl label={t("Code size (px)", "代码字号（px）")} value={value.codeFontSize} min={9} max={24} onChange={(codeFontSize) => update({ codeFontSize })} />
      <ColorControl label={t("Background", "背景")} value={value.background} onChange={(background) => update({ background })} />
      <ColorControl label={t("Foreground", "前景")} value={value.foreground} onChange={(foreground) => update({ foreground })} />
    </div>
    <label>{t("Contrast", "对比度")} <span className="appearance-contrast"><input aria-label={t("Appearance contrast", "外观对比度")} type="range" min={0} max={100} value={value.contrast} onChange={(event) => update({ contrast: Number(event.target.value) })} /><output>{value.contrast}</output></span></label>
    <p className="muted appearance-note">{t("Changes are saved automatically. Contrast adjusts surfaces, borders, and secondary text.", "调整会自动保留。对比度用于调整背景层次、边框和次要文字。")}</p>
    {saveError && <p className="error-text" role="alert">{saveError}</p>}
  </section>;
}
