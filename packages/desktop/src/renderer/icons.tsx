import React from "react";

type IconName = "folder" | "folder-open" | "archive" | "pin" | "compose" | "settings" | "panel" | "review" | "plus" | "chevron" | "close" | "more";
const paths: Record<IconName, React.ReactNode> = {
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 2h18" />,
  "folder-open": <><path d="M3 11V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2" /><path d="M3 10h18a1 1 0 0 1 1 1.4l-3 8a2 2 0 0 1-1.9 1.3H4.9A2 2 0 0 1 3 19.3L1.9 12A1.7 1.7 0 0 1 3 10Z" /></>,
  archive: <><rect x="3" y="3" width="18" height="5" rx="1.5" /><path d="M5 8v12h14V8M9 12h6" /></>,
  pin: <><path d="m15 3 6 6-4 1-4 5v4l-3-3-6 6m5-8-4-4h4l5-4 1-3Z" /></>,
  compose: <><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /><path d="m16 3 5 5-10 10-6 1 1-6L16 3Z" /></>,
  settings: <><path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 3 3 3 3-2h3l2 3 4-1-1-3 1-3 3-1-1-4-3 1-2-2-1-3Z" /><circle cx="11" cy="12" r="3" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M15 3v18" /></>,
  review: <><path d="M7 3H4v18h3M17 3h3v18h-3M9 8h6M12 5v6M9 16h6" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
