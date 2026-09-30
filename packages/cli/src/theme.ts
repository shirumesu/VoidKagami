import { getCapabilities } from "@voidkagami/tui";
import type { TUI } from "@voidkagami/tui";

export type Tone = "muted" | "accent" | "warning" | "accent2" | "success" | "danger";
export type AccentMode = "truecolor" | "256" | "16";

const deepAccent: [number, number, number] = [165, 148, 255];
const lightAccent: [number, number, number] = [107, 78, 245];
const deepAccent2: [number, number, number] = [94, 200, 229];
const lightAccent2: [number, number, number] = [14, 116, 144];
let lightBackground = false;
let cachedAccentMode: AccentMode | undefined;

export function accentMode(): AccentMode {
  if (cachedAccentMode) return cachedAccentMode;
  const colorTerm = process.env.COLORTERM?.toLowerCase();
  cachedAccentMode = colorTerm === "truecolor" || colorTerm === "24bit" || getCapabilities().trueColor ? "truecolor" : /256color/i.test(process.env.TERM || "") ? "256" : "16";
  return cachedAccentMode;
}
export function isTrueColor() { return accentMode() === "truecolor"; }
export function accentRgb(): [number, number, number] { return lightBackground ? lightAccent : deepAccent; }
export function accent2Rgb(): [number, number, number] { return lightBackground ? lightAccent2 : deepAccent2; }
function style(code: string, text: string, reset: string) { return `\x1b[${code}m${text}\x1b[${reset}m`; }
export function rgb(text: string, color: [number, number, number]) { return style(`38;2;${color[0]};${color[1]};${color[2]}`, text, "39"); }
export function foreground(text: string, index: number) { return style(`38;5;${index}`, text, "39"); }
export function accent(text: string) {
  const mode = accentMode();
  return mode === "truecolor" ? rgb(text, accentRgb()) : mode === "256" ? foreground(text, 141) : style("35", text, "39");
}
export function accent2(text: string) {
  if (accentMode() === "truecolor") return rgb(text, accent2Rgb());
  return style("36", text, "39");
}
export const dim = (text: string) => style("2", text, "22");
export const bold = (text: string) => style("1", text, "22");
export const italic = (text: string) => style("3", text, "23");
export const strikethrough = (text: string) => style("9", text, "29");
export const underline = (text: string) => style("4", text, "24");
export const red = (text: string) => style("31", text, "39");
export const green = (text: string) => style("32", text, "39");
export const yellow = (text: string) => style("33", text, "39");
export const cyan = (text: string) => style("36", text, "39");
export const warning = yellow;
export const danger = red;
export const success = green;
export function tone(text: string, value: Tone) {
  return value === "accent" ? accent(text) : value === "accent2" ? accent2(text) : value === "warning" ? warning(text) : value === "success" ? success(text) : value === "danger" ? danger(text) : dim(text);
}
export function setLightBackground(value: boolean) { lightBackground = value; }
export function applyTerminalColors(tui: TUI, render: () => void) {
  void tui.queryTerminalColors({ timeoutMs: 150 }).then(({ background }) => {
    if (!background) return;
    const light = (background.r * 299 + background.g * 587 + background.b * 114) / 1000 > 150;
    if (light !== lightBackground) { lightBackground = light; render(); }
  }).catch(() => {});
}
export function gradientColor(position: number, from = accentRgb(), to = accent2Rgb()): [number, number, number] {
  const amount = Math.max(0, Math.min(1, position));
  return from.map((channel, index) => Math.round(channel + (to[index]! - channel) * amount)) as [number, number, number];
}
export function gradient(text: string, position: number) {
  if (!isTrueColor()) return accent(text);
  return rgb(text, gradientColor(position));
}
export function shimmer(text: string, phase = 0) {
  if (!isTrueColor()) return accent(text);
  const chars = Array.from(text);
  return chars.map((char, index) => {
    const distance = Math.abs(((index / Math.max(1, chars.length - 1) + phase) % 1) - 0.5);
    const mix = Math.max(0, 1 - distance * 5);
    const from = accentRgb();
    const to = lightBackground ? accent2Rgb() : [255, 255, 255];
    const color = from.map((channel, slot) => Math.round(channel + (to[slot]! - channel) * mix)) as [number, number, number];
    return rgb(char, color);
  }).join("");
}
