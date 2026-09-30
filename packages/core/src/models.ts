import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, type Api, type Model } from "@voidkagami/ai";
import { openaiChatGPTOAuth, type OAuthCredential } from "@voidkagami/ai/oauth";
import type { ModelInfo, ModelSelection } from "@voidkagami/protocol";
import { ConfigStore, CredentialStore } from "./config.ts";

export class ModelRegistry {
  readonly config: ConfigStore;
  readonly credentials: CredentialStore;
  private refreshes = new Map<string, Promise<string>>();
  private logins = new Map<string, { controller: AbortController; respond?: (value: string) => void }>();
  readonly notify: (data: Record<string, unknown>) => void;
  constructor(config: ConfigStore, notify: (data: Record<string, unknown>) => void) {
    this.config = config;
    this.credentials = new CredentialStore(config.home);
    this.notify = notify;
  }
  private envKey(provider: string): string | undefined {
    return process.env[`${provider.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`];
  }
  models(): Model<Api>[] {
    const models = getModels();
    for (const [provider, config] of Object.entries(this.config.get().providers)) {
      for (const entry of config.models) {
        const index = models.findIndex((model) => model.provider === provider && model.id === entry.id);
        const existing = index === -1 ? undefined : models.splice(index, 1)[0];
        models.push({ ...existing, provider, id: entry.id, name: entry.name ?? existing?.name ?? entry.id,
          api: config.api, baseUrl: config.baseUrl, reasoning: entry.reasoning ?? existing?.reasoning ?? false,
          input: existing?.input ?? ["text", "image"], contextWindow: entry.contextWindow ?? existing?.contextWindow ?? 128000,
          maxTokens: entry.maxTokens ?? existing?.maxTokens ?? 16384,
          cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      }
    }
    return models;
  }
  resolve(selection: ModelSelection): Model<Api> {
    const model = this.models().find((item) => item.provider === selection.provider && item.id === selection.id);
    if (!model) throw new Error(`Unknown model ${selection.provider}/${selection.id}. Add it to config.providers or choose from model.list.`);
    return model;
  }
  list(): ModelInfo[] {
    return this.models().map((model) => ({ provider: model.provider, id: model.id, name: model.name,
      contextWindow: model.contextWindow, authenticated: Boolean(this.credentials.get(model.provider) || this.envKey(model.provider)) }));
  }
  async apiKey(provider: string): Promise<string | undefined> {
    const credential = this.credentials.get(provider);
    if (credential?.type === "api_key") return credential.apiKey;
    if (credential?.type === "oauth") {
      if (provider !== "openai") throw new Error("Only OpenAI supports subscription login");
      if ((credential.expires || 0) > Date.now()) return credential.access;
      let refresh = this.refreshes.get(provider);
      if (!refresh) {
        refresh = openaiChatGPTOAuth.refresh(credential as OAuthCredential, new AbortController().signal).then((next) => {
          const current = this.credentials.get(provider);
          if (current?.type === "oauth" && current.refresh === credential.refresh) this.credentials.set(provider, next);
          return next.access;
        }).finally(() => this.refreshes.delete(provider));
        this.refreshes.set(provider, refresh);
      }
      return refresh;
    }
    return this.envKey(provider);
  }
  async requireAuth(selection: ModelSelection): Promise<void> {
    const model = this.resolve(selection);
    if (await this.apiKey(selection.provider)) return;
    const host = new URL(model.baseUrl).hostname;
    if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return;
    throw new Error(`Sign in or configure an API key for ${selection.provider} before sending a message.`);
  }
  private deviceId(): string {
    const path = join(this.config.home, "device-id");
    try { return readFileSync(path, "utf8").trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const id = randomUUID();
      writeFileSync(path, id, { mode: 0o600 });
      return id;
    }
  }
  login(provider: string): string {
    if (provider !== "openai") throw new Error("Use auth.key for API providers. Subscription login is available for OpenAI only.");
    if (this.logins.size) throw new Error("A login is already in progress");
    const loginId = randomUUID();
    const controller = new AbortController();
    const login: { controller: AbortController; respond?: (value: string) => void } = { controller };
    this.logins.set(loginId, login);
    setImmediate(() => {
      void openaiChatGPTOAuth.login({
        signal: controller.signal,
        notify: (event) => {
          if (event.type === "auth_url") this.notify({ loginId, type: "url", url: event.url, instructions: event.instructions });
          else this.notify({ loginId, ...event, type: "progress" });
        },
        prompt: (prompt) => new Promise<string>((resolve, reject) => {
          const signal = prompt.signal || controller.signal;
          const cancel = () => { login.respond = undefined; reject(new Error("Login cancelled")); };
          if (signal.aborted) return cancel();
          signal.addEventListener("abort", cancel, { once: true });
          login.respond = (value) => { signal.removeEventListener("abort", cancel); login.respond = undefined; resolve(value); };
          this.notify({ loginId, type: "prompt", message: prompt.message });
        }),
      }, { getDeviceId: () => this.deviceId() }).then((credential) => {
        this.credentials.set(provider, credential);
        this.notify({ loginId, type: "complete", provider });
      }).catch((error: Error) => this.notify({ loginId, type: "error", message: error.message }))
        .finally(() => this.logins.delete(loginId));
    });
    return loginId;
  }
  respond(loginId: string, value: string): void {
    const login = this.logins.get(loginId);
    if (!login?.respond) throw new Error("No login prompt is waiting");
    login.respond(value);
  }
  get activeLogins(): number { return this.logins.size; }
  status(): { provider: string; type: string }[] {
    const records = Object.entries(this.credentials.all()).map(([provider, credential]) => ({ provider, type: credential.type }));
    for (const provider of new Set(this.models().map((model) => model.provider))) {
      if (this.envKey(provider) && !records.some((record) => record.provider === provider)) records.push({ provider, type: "api_key" });
    }
    return records;
  }
  close(): void { for (const login of this.logins.values()) login.controller.abort(); }
}
