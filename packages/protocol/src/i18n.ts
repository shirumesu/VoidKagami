export type Language = "zh-CN" | "en";

export function normalizeLanguage(value?: string): Language {
  return value?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translate(language: Language, english: string, chinese: string): string {
  return language === "zh-CN" ? chinese : english;
}
