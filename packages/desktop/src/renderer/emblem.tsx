import React from "react";

export function Emblem({ className = "" }: { className?: string }) {
  return <svg className={`emblem ${className}`} viewBox="0 0 48 48" fill="none" role="img" aria-label="VoidKagami">
    <path d="M17 3h14l14 14v14L31 45H17L3 31V17L17 3Z" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" />
    <circle cx="24" cy="24" r="9" stroke="var(--text-secondary)" strokeWidth="1.75" />
  </svg>;
}
