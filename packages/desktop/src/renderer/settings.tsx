import React, { useEffect, useRef, useState } from "react";
import type { Config, Language, ModelInfo, PermissionMode, Session } from "@voidkagami/protocol";
import { AppearanceSettings } from "./appearance.tsx";
import { applyLanguage, useI18n } from "./i18n.ts";
import "./settings.css";

type Section = "general" | "appearance" | "accounts" | "archived" | "advanced";
interface SettingsProps {
  close: () => void;
  onRestored: (session: Session) => void;
  onConfigChanged: () => Promise<void> | void;
  auth: Record<string, unknown> | null;
  initialSection?: Section;
}
const api = window.voidkagami;
const modelValue = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const parseModel = (value: string) => ({ provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) });

export function SettingsPage({ close, onRestored, onConfigChanged, auth, initialSection = "general" }: SettingsProps) {
  const { t, language, setLanguage } = useI18n();
  const [section, setSection] = useState<Section>(initialSection);
  const [config, setConfig] = useState<Config>();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [raw, setRaw] = useState("");
  const [accounts, setAccounts] = useState<{ provider: string; type: string }[]>([]);
  const [archived, setArchived] = useState<Session[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("deepseek");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginId, setLoginId] = useState<string>();
  const [restoring, setRestoring] = useState<string>();
  const activeLogin = useRef<string | undefined>(undefined);
  const loginGeneration = useRef(0);
  const act = (action: () => Promise<unknown>) => { setError(""); setSaved(false); void action().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))); };
  const load = async () => {
    const [next, nextAccounts, sessions] = await Promise.all([
      api.request("config.get", {}), api.request("auth.status", {}), api.request("session.list", { archived: true }),
    ]);
    setConfig(next); setRaw(JSON.stringify(next, null, 2)); setAccounts(nextAccounts); setArchived(sessions);
    const nextModels = await api.request("model.list", {});
    setModels(nextModels.filter((model) => model.authenticated));
  };
  useEffect(() => { act(load); }, []);
  useEffect(() => {
    if (auth?.type === "complete") act(async () => { await load(); await onConfigChanged(); });
    if (auth?.loginId === activeLogin.current && ["complete", "error", "cancelled"].includes(String(auth?.type))) { activeLogin.current = undefined; setLoggingIn(false); }
  }, [auth]);
  useEffect(() => () => {
    loginGeneration.current++;
    if (activeLogin.current) void api.request("auth.cancel", { loginId: activeLogin.current }).catch(() => {});
  }, []);
  const save = async (patch: Partial<Config>) => {
    const next = await api.request("config.set", patch);
    setConfig(next); setRaw(JSON.stringify(next, null, 2)); applyLanguage(next.language); setSaved(true);
    await Promise.all([onConfigChanged(), api.request("model.list", {}).then((items) => setModels(items.filter((model) => model.authenticated)))]);
  };
  const startLogin = async () => {
    const generation = ++loginGeneration.current;
    setLoggingIn(true);
    try {
      const result = await api.request("auth.login", { provider: "openai" });
      if (generation !== loginGeneration.current) { await api.request("auth.cancel", { loginId: result.loginId }); return; }
      activeLogin.current = result.loginId;
      setLoginId(result.loginId);
    } catch (failure) { if (generation === loginGeneration.current) setLoggingIn(false); throw failure; }
  };
  const cancelLogin = async () => {
    loginGeneration.current++;
    const loginId = activeLogin.current;
    activeLogin.current = undefined; setLoginId(undefined); setLoggingIn(false);
    if (loginId) await api.request("auth.cancel", { loginId });
  };
  const sections: { id: Section; label: string }[] = [
    { id: "general", label: t("General", "通用") }, { id: "appearance", label: t("Appearance", "外观") },
    { id: "accounts", label: t("Accounts", "账户") }, { id: "archived", label: t("Archived chats", "已归档的会话") },
    { id: "advanced", label: t("Advanced", "高级") },
  ];
  const permissions: [PermissionMode, string][] = [["ask", t("Ask before changes", "更改前询问")], ["accept_edits", t("Accept file edits", "允许文件编辑")], ["auto", t("Fully automatic", "完全自动")], ["plan", t("Plan · read only", "计划 · 只读")]];
  const activeAuth = auth?.loginId === loginId ? auth : null;
  return <section className="settings-page" aria-label={t("Settings", "设置")}>
    <header className="settings-page-header"><h2>{t("Settings", "设置")}</h2><button onClick={close}>{t("Back to chat", "返回聊天")}</button></header>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label={t("Settings categories", "设置分类")}>{sections.map((item) => <button key={item.id} className={section === item.id ? "selected" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => { setSection(item.id); setError(""); setSaved(false); }}>{item.label}</button>)}</nav>
      <div className="settings-content" key={section}>
        <h2>{sections.find((item) => item.id === section)!.label}</h2>
        {error && <div className="settings-error" role="alert">{error}</div>}
        {section === "general" && config && <>
          <label>{t("Language", "语言")}<select value={language} onChange={(event) => act(async () => { await setLanguage(event.target.value as Language); await load(); })}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>
          <label>{t("Default model", "默认模型")}<select value={modelValue(config.defaultModel)} onChange={(event) => act(() => save({ defaultModel: parseModel(event.target.value) }))}>{!models.some((model) => modelValue(model) === modelValue(config.defaultModel)) && <option value={modelValue(config.defaultModel)} disabled>{`${config.defaultModel.id} · ${t("Current default", "当前默认")}`}</option>}{models.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{model.name}</option>)}</select></label>
          <label>{t("Default permissions", "默认权限")}<select value={config.permissionMode} onChange={(event) => act(() => save({ permissionMode: event.target.value as PermissionMode }))}>{permissions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>{t("Workspace for chats without a project", "无项目聊天的默认工作目录")}<button className="folder-choice" onClick={() => act(async () => { const path = await api.chooseFolder(); if (path) await save({ defaultWorkspace: path }); })}><span>{config.defaultWorkspace}</span><span>…</span></button><small>{t("Each new chat gets its own folder here. Existing chats keep their current folders.", "每个新聊天会在这里创建独立目录，已有聊天的目录保持不变。")}</small></label>
          <label className="checkbox-label"><input type="checkbox" checked={config.sandbox} onChange={(event) => act(() => save({ sandbox: event.target.checked }))} />{t("Sandbox shell commands", "在沙箱中运行 Shell 命令")}</label>
        </>}
        {section === "appearance" && <AppearanceSettings />}
        {section === "accounts" && <>
          {accounts.length === 0 && <p className="muted">{t("Connect an account to start using models.", "连接账户以使用模型。")}</p>}
          {accounts.map((account) => <div className="account-row" key={account.provider}><span><strong>{account.provider}</strong><small>{account.type === "oauth" ? t("Signed in", "已登录") : t("API key", "API 密钥")}</small></span><button onClick={() => act(async () => { await api.request("auth.logout", { provider: account.provider }); await load(); await onConfigChanged(); })}>{t("Sign out", "退出登录")}</button></div>)}
          <button className="primary" disabled={loggingIn} onClick={() => act(startLogin)}>{t("Sign in with ChatGPT", "使用 ChatGPT 登录")}</button>{loggingIn && <button onClick={() => act(cancelLogin)}>{t("Cancel sign-in", "取消登录")}</button>}
          {activeAuth && <div className={`auth-progress ${activeAuth.type === "error" ? "error-text" : ""}`}>
            {activeAuth.type === "url" && <><button onClick={() => void api.openExternal(String(activeAuth.url))}>{t("Open sign-in page", "打开登录页面")} ↗</button><p>{t("Complete sign-in in your browser.", "请在浏览器中完成登录。")}</p></>}
            {activeAuth.message ? <p>{String(activeAuth.message)}</p> : null}
            {activeAuth.type === "prompt" && <form onSubmit={(event) => { event.preventDefault(); act(() => api.request("auth.respond", { loginId: String(activeAuth.loginId), value: code })); }}><input value={code} onChange={(event) => setCode(event.target.value)} placeholder={t("Authorization code or redirect URL", "授权码或回调地址")} /><button>{t("Continue", "继续")}</button></form>}
            {activeAuth.type === "complete" && <p>{t("Signed in successfully.", "登录成功。")}</p>}
          </div>}
          <form className="api-key-form" onSubmit={(event) => { event.preventDefault(); act(async () => { await api.request("auth.key", { provider, apiKey: key }); setKey(""); await load(); await onConfigChanged(); }); }}>
            <label>{t("Provider", "服务商")}<input list="provider-options" value={provider} onChange={(event) => setProvider(event.target.value)} /><datalist id="provider-options"><option value="deepseek" /><option value="anthropic" /><option value="openai" />{config && Object.keys(config.providers).map((name) => <option key={name} value={name} />)}</datalist></label>
            <label>{t("API key", "API 密钥")}<input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label><button disabled={!provider || !key}>{t("Save API key", "保存密钥")}</button>
          </form>
        </>}
        {section === "archived" && <>
          <p className="muted">{t("Restore a chat to view or continue it.", "恢复会话后即可查看或继续。")}</p>
          <input className="archived-search" aria-label={t("Search archived chats", "搜索已归档会话")} placeholder={t("Search archived chats", "搜索已归档会话")} value={query} onChange={(event) => setQuery(event.target.value)} />
          {!archived.length && <p className="muted">{t("No archived chats.", "暂无已归档会话。")}</p>}
          {archived.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())).map((session) => <div className="archived-row" key={session.id}><div><strong>{session.title === "New session" ? t("New chat", "新聊天") : session.title}</strong><small>{session.projectPath === null ? t("No project", "无项目") : (session.projectPath || session.cwd).split(/[\\/]/).at(-1)} · {new Date(session.updatedAt).toLocaleDateString(language)}</small></div><button disabled={Boolean(restoring)} onClick={() => act(async () => { setRestoring(session.id); try { const restored = await api.request("session.archive", { sessionId: session.id, archived: false }); setArchived((items) => items.filter((item) => item.id !== session.id)); onRestored(restored); } finally { setRestoring(undefined); } })}>{restoring === session.id ? t("Restoring…", "恢复中…") : t("Restore", "恢复")}</button></div>)}
        </>}
        {section === "advanced" && <>
          <p className="muted">{t("Configure providers, MCP servers, hooks and permission rules. Manage API keys on the Accounts page.", "配置服务商、MCP 服务、钩子与权限规则。API 密钥请在账户页管理。")}</p>
          <textarea className="configuration-json" aria-label={t("Configuration JSON", "配置 JSON")} spellCheck={false} rows={22} value={raw} onChange={(event) => setRaw(event.target.value)} />
          <button className="primary" onClick={() => act(async () => { await save(JSON.parse(raw) as Config); })}>{t("Save configuration", "保存配置")}</button>
        </>}
        {saved && <p className="muted settings-saved" role="status">{t("Saved", "已保存")}</p>}
      </div>
    </div>
  </section>;
}
