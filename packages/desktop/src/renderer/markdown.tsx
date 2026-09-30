import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n.ts";
import { Icon } from "./icons.tsx";

function CodeBlock({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const code = React.Children.toArray(children).find(React.isValidElement);
  const props = code && React.isValidElement(code) ? code.props as { className?: string; children?: React.ReactNode } : {};
  const language = /language-([\w+-]+)/.exec(props.className || "")?.[1] || t("Code", "代码");
  const source = String(props.children ?? "");
  return <div className="markdown-code"><header><span>{language}</span><button type="button" className="code-copy" title={t("Copy code", "复制代码")} onClick={() => void navigator.clipboard.writeText(source)}><Icon name="copy" />{t("Copy", "复制")}</button></header><pre><code className={props.className}>{props.children}</code></pre></div>;
}

export function Markdown({ text, onExternal }: { text: string; onExternal?: (url: string) => void }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void (onExternal || window.voidkagami.openExternal)(href); }}>{children}</a>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
}
