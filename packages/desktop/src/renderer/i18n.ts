import { useEffect, useSyncExternalStore } from "react";
import { normalizeLanguage, translate, type Language } from "@voidkagami/protocol";

let language = normalizeLanguage(localStorage.getItem("language") || navigator.language);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function applyLanguage(next: Language) {
  language = next;
  document.documentElement.lang = next;
  localStorage.setItem("language", next);
  for (const listener of listeners) listener();
}

export async function initializeLanguage() {
  const config = await window.voidkagami.request("config.get", {});
  applyLanguage(config.language);
}

export function useI18n() {
  const current = useSyncExternalStore(subscribe, () => language);
  useEffect(() => { document.documentElement.lang = current; }, [current]);
  return {
    language: current,
    t: (english: string, chinese: string) => translate(current, english, chinese),
    setLanguage: async (next: Language) => {
      await window.voidkagami.request("config.set", { language: next });
      applyLanguage(next);
    },
  };
}
