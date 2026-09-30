import React, { useEffect, useRef } from "react";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";
import "./find-bar.css";

export function FindBar({ query, matches, index, onChange, onPrevious, onNext, onClose }: {
  query: string;
  matches: number;
  index: number;
  onChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <div className="find-bar" role="search" aria-label={t("Find in conversation", "在聊天中查找")}>
    <Icon name="search" />
    <input ref={input} aria-label={t("Find in conversation", "在聊天中查找")} value={query} placeholder={t("Find in conversation", "在聊天中查找")} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Enter") { event.preventDefault(); event.shiftKey ? onPrevious() : onNext(); }
    }} />
    <span className="find-count">{index} / {matches}</span>
    <button type="button" title={t("Previous match", "上一个匹配项")} aria-label={t("Previous match", "上一个匹配项")} onClick={onPrevious}><Icon name="arrow-up" /></button>
    <button type="button" title={t("Next match", "下一个匹配项")} aria-label={t("Next match", "下一个匹配项")} onClick={onNext}><Icon name="arrow-down" /></button>
    <button type="button" title={t("Close · esc", "关闭 · esc")} aria-label={t("Close find", "关闭查找")} onClick={onClose}><Icon name="close" /></button>
  </div>;
}
