import React, { useEffect, useRef, useState } from "react";
import "./menu.css";

export function Menu({ trigger, children, ariaLabel, className = "", align = "start", placement = "bottom", open, onOpenChange, disabled = false }: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  ariaLabel: string;
  className?: string;
  align?: "start" | "end";
  placement?: "top" | "bottom";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const controlled = open !== undefined;
  const visible = open ?? internalOpen;
  const setVisible = (next: boolean) => { if (!controlled) setInternalOpen(next); onOpenChange?.(next); };
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.parentElement?.contains(event.target as Node)) setVisible(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setVisible(false); triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus());
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [visible]);
  function navigate(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") || [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return <div className={`menu-popover ${className}`}>
    <button ref={triggerRef} type="button" className="menu-trigger" aria-haspopup="menu" aria-expanded={visible} aria-label={ariaLabel} disabled={disabled} onClick={() => setVisible(!visible)}>{trigger}</button>
    {visible && <div ref={menuRef} className={`menu-surface align-${align} placement-${placement}`} role="menu" aria-label={ariaLabel} onKeyDown={navigate} onClickCapture={(event) => {
      const target = event.target as HTMLElement;
      const item = target.closest<HTMLElement>("[role='menuitem']");
      if (item) { event.preventDefault(); if (!item.hasAttribute("data-menu-keep-open") && !target.closest("[data-menu-keep-open]")) setVisible(false); }
    }}>{children}</div>}
  </div>;
}
