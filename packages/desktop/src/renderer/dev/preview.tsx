import { MockClient } from "@voidkagami/client/fixtures/mock-client";
import { demoConfig, demoProjects, demoSessions } from "@voidkagami/client/fixtures/demo";
import type { DesktopBridge } from "../../bridge.ts";
import type { Language, RpcNotification } from "@voidkagami/protocol";

const params = new URLSearchParams(window.location.search);
const client = new MockClient();
const requestedLanguage = params.get("lang");
const language: Language = requestedLanguage === "zh-CN" || requestedLanguage === "en" ? requestedLanguage : demoConfig.language;
const theme = params.get("theme");
const selectedSession = params.get("session");
const fixtureSession = demoSessions.find((session) => session.id === selectedSession);
const project = demoProjects.find((item) => item.path === fixtureSession?.projectPath) || demoProjects[0]!;
await client.request("config.set", { language });
localStorage.setItem("language", language);
localStorage.setItem("sidebarWidth", "260");
localStorage.setItem("panelWidth", "410");
localStorage.setItem("sidebarCollapsed", "false");
localStorage.setItem("projects", JSON.stringify(demoProjects.map((item) => item.path)));
localStorage.setItem("collapsedProjects", "[]");
localStorage.setItem("pinnedProjects", "[]");
localStorage.setItem("pinnedSessions", "[]");
localStorage.setItem("drafts", "{}");
if (selectedSession === "none") localStorage.removeItem("selectedSession");
else if (fixtureSession) localStorage.setItem("selectedSession", fixtureSession.id);
if (theme === "light" || theme === "dark" || theme === "system") {
  let appearance: Record<string, unknown> = {};
  try { appearance = JSON.parse(localStorage.getItem("appearance") || "{}"); } catch {}
  const values = appearance.values && typeof appearance.values === "object" ? appearance.values as Record<string, unknown> : appearance;
  localStorage.setItem("appearance", JSON.stringify({ ...appearance, presetId: "preview", theme, values: { ...values, theme, customColors: false } }));
}

const bridge: DesktopBridge = {
  request: (method, request) => client.request(method, request),
  onNotification: (listener) => client.subscribe((message) => listener({ jsonrpc: "2.0", ...message } as RpcNotification)),
  onReplay: (listener) => {
    if (fixtureSession) void client.request("session.attach", { sessionId: fixtureSession.id }).then(listener);
    return () => {};
  },
  onConnection: (listener) => { listener("connected"); return () => {}; },
  chooseFolder: async () => project.path,
  chooseAttachments: async () => [`${project.path}/README.md`, `${project.path}/assets/example.png`],
  importAttachments: async (files) => files.map((file) => `${project.path}/.preview/${file.name}`),
  setAppearance: async () => {},
  openExternal: async (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
};
window.voidkagami = bridge;
await import("../main.tsx");
