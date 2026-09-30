import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getSupportedThinkingLevels, type Api, type Model } from "@voidkagami/ai";
import { openaiChatGPTOAuth, type OAuthCredential } from "@voidkagami/ai/oauth";
import type { ModelInfo, ModelSelection, ThinkingLevel } from "@voidkagami/protocol";
import { ConfigStore, CredentialStore } from "./config.ts";

interface ChatGPTModel {
  slug: string;
  display_name: string;
  visibility: string;
  supported_reasoning_levels?: { effort: string }[];
  default_reasoning_level?: string;
  context_window?: number;
  input_modalities?: string[];
}
const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const openAIBaseUrl = "https://api.openai.com/v1";

export class ModelRegistry {
  readonly config: ConfigStore;
  readonly credentials: CredentialStore;
  private refreshes = new Map<string, Promise<string>>();
  private logins = new Map<string, { controller: AbortController; respond?: (value: string) => void }>();
  private chatGPTCatalog?: { access: string; expires: number; models: ChatGPTModel[] };
  private catalogRequest?: { access: string; promise: Promise<ChatGPTModel[]> };
  readonly notify: (data: Record<string, unknown>) => void;
  constructor(config: ConfigStore, notify: (data: Record<string, unknown>) => void) {
    this.config = config;
    this.credentials = new CredentialStore(config.home);
    this.notify = notify;
  }
  private envKey(provider: string): string | undefined {
    return process.env[`${provider.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`]?.trim() || undefined;
  }
  models(): Model<Api>[] {
    const models = getModels();
    if (this.credentials.get("openai")?.type === "oauth") for (const entry of this.chatGPTCatalog?.models ?? []) {
      const index = models.findIndex((model) => model.provider === "openai" && model.id === entry.slug);
      const existing = index === -1 ? undefined : models.splice(index, 1)[0];
      const levels = entry.supported_reasoning_levels?.map((item) => item.effort) ?? [];
      models.push({ ...existing, provider: "openai", id: entry.slug, name: entry.display_name,
        api: "openai-responses", baseUrl: openAIBaseUrl, reasoning: levels.length > 0,
        thinkingLevelMap: Object.fromEntries(thinkingLevels.map((level) => [level, levels.includes(level) ? level : null])),
        input: entry.input_modalities?.filter((value): value is "text" | "image" => value === "text" || value === "image") ?? existing?.input ?? ["text"],
        contextWindow: entry.context_window ?? existing?.contextWindow ?? 128000, maxTokens: existing?.maxTokens ?? 16384,
        cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    }
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
    if (!model) throw new Error(this.config.text(`Unknown model ${selection.provider}/${selection.id}. Add it to config.providers or choose from model.list.`, `未知模型 ${selection.provider}/${selection.id}。请在供应商配置中添加，或从模型列表选择。`));
    if (selection.thinkingLevel && !getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) throw new Error(this.config.text(`Unsupported thinking level for ${model.id}: ${selection.thinkingLevel}`, `${model.id} 不支持思考强度 ${selection.thinkingLevel}`));
    return model;
  }
  async prepare(selection: ModelSelection): Promise<Model<Api>> {
    if (selection.provider === "openai" && this.credentials.get("openai")?.type === "oauth") await this.accountModels();
    const model = this.resolve(selection);
    if (model.provider === "openai" && model.baseUrl !== openAIBaseUrl && this.credentials.get("openai")?.type === "oauth") {
      throw new Error(this.config.text("ChatGPT sign-in only supports the official OpenAI endpoint. Configure an API key for a custom endpoint.", "ChatGPT 登录仅支持 OpenAI 官方接口。自定义接口请配置 API 密钥。"));
    }
    return model;
  }
  private async accountModels(): Promise<ChatGPTModel[]> {
    const access = await this.apiKey("openai");
    if (!access) throw new Error(this.config.text("Sign in to ChatGPT to load available models", "请登录 ChatGPT 以获取可用模型"));
    if (this.chatGPTCatalog?.access === access && this.chatGPTCatalog.expires > Date.now()) return this.chatGPTCatalog.models;
    if (this.catalogRequest?.access === access) return this.catalogRequest.promise;
    const promise = (async () => {
      // ChatGPT plan discovery returns account-specific models, not the API-key catalog.
      const response = await fetch(`${openAIBaseUrl}/models`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(this.config.text(`Could not load ChatGPT models (HTTP ${response.status}). Try again or sign in again.`, `无法获取 ChatGPT 模型（HTTP ${response.status}），请重试或重新登录。`));
      const body = await response.json() as { models?: ChatGPTModel[] };
      if (!Array.isArray(body.models)) throw new Error(this.config.text("ChatGPT returned an invalid model catalog", "ChatGPT 返回了无效的模型目录"));
      this.chatGPTCatalog = { access, expires: Date.now() + 60_000, models: body.models };
      return body.models;
    })().catch((error: unknown) => {
      if (error instanceof TypeError || error instanceof DOMException) throw new Error(this.config.text("Could not connect to ChatGPT to load available models. Check your connection and try again.", "无法连接 ChatGPT 获取可用模型，请检查网络后重试。"));
      throw error;
    });
    this.catalogRequest = { access, promise };
    try { return await promise; } finally { if (this.catalogRequest?.promise === promise) this.catalogRequest = undefined; }
  }
  async list(): Promise<ModelInfo[]> {
    const credentials = this.credentials.all();
    const accountModels = credentials.openai?.type === "oauth" ? (await this.accountModels()).filter((model) => model.visibility === "list") : undefined;
    const models = this.models();
    const listed = accountModels ? [...accountModels.map((entry) => models.find((model) => model.provider === "openai" && model.id === entry.slug)!), ...models.filter((model) => model.provider !== "openai")] : models;
    return listed.map((model) => {
      const levels = getSupportedThinkingLevels(model);
      const recommended = accountModels?.find((entry) => entry.slug === model.id)?.default_reasoning_level as ThinkingLevel | undefined;
      const credential = credentials[model.provider];
      const authenticated = this.isLocal(model) || Boolean(this.envKey(model.provider))
        || (credential?.type === "api_key" ? Boolean(credential.apiKey?.trim())
          : credential?.type === "oauth" && model.provider === "openai" && Boolean((credential.access && (credential.expires || 0) > Date.now()) || credential.refresh));
      return { provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow,
        thinkingLevels: levels, thinkingLevel: recommended && levels.includes(recommended) ? recommended : undefined, authenticated };
    });
  }
  private isLocal(model: Model<Api>): boolean {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(model.baseUrl).hostname);
  }
  async apiKey(provider: string): Promise<string | undefined> {
    const credential = this.credentials.get(provider);
    if (credential?.type === "api_key") return credential.apiKey?.trim() || this.envKey(provider);
    if (credential?.type === "oauth") {
      if (provider !== "openai") throw new Error(this.config.text("Only OpenAI supports subscription login", "只有 OpenAI 支持订阅账户登录"));
      if (credential.access && (credential.expires || 0) > Date.now()) return credential.access;
      if (!credential.refresh) return this.envKey(provider);
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
    const model = await this.prepare(selection);
    if (this.isLocal(model)) return;
    if (await this.apiKey(selection.provider)) return;
    throw new Error(this.config.text(`Sign in or configure an API key for ${selection.provider} before sending a message.`, `发送消息前，请先登录或配置 ${selection.provider} 的 API 密钥。`));
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
    if (provider !== "openai") throw new Error(this.config.text("Use auth.key for API providers. Subscription login is available for OpenAI only.", "API 供应商请使用 auth.key 配置密钥，订阅账户登录仅支持 OpenAI。"));
    if (this.logins.size) throw new Error(this.config.text("A login is already in progress", "已有登录正在进行"));
    const loginId = randomUUID();
    const controller = new AbortController();
    const login: { controller: AbortController; respond?: (value: string) => void } = { controller };
    this.logins.set(loginId, login);
    setImmediate(() => {
      if (controller.signal.aborted) return;
      void openaiChatGPTOAuth.login({
        signal: controller.signal,
        notify: (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "auth_url") this.notify({ loginId, type: "url", url: event.url, instructions: this.config.text(event.instructions || "Complete sign-in in your browser.", "请在浏览器中完成登录。若没有自动完成，请粘贴最终跳转网址。") });
          else {
            const message = "message" in event ? event.message : undefined;
            this.notify({ loginId, ...event, type: "progress", message: message === "Exchanging authorization code for tokens..." ? this.config.text(message, "正在完成授权…") : message });
          }
        },
        prompt: (prompt) => new Promise<string>((resolve, reject) => {
          const signal = prompt.signal || controller.signal;
          const cancel = () => { login.respond = undefined; reject(new Error(this.config.text("Login cancelled", "登录已取消"))); };
          if (signal.aborted) return cancel();
          signal.addEventListener("abort", cancel, { once: true });
          login.respond = (value) => { signal.removeEventListener("abort", cancel); login.respond = undefined; resolve(value); };
          this.notify({ loginId, type: "prompt", message: this.config.text(prompt.message, "请在浏览器中完成登录，或在此粘贴最终跳转网址：") });
        }),
      }, { getDeviceId: () => this.deviceId() }).then((credential) => {
        if (controller.signal.aborted) return;
        this.credentials.set(provider, credential);
        this.notify({ loginId, type: "complete", provider });
      }).catch((error: Error) => { if (!controller.signal.aborted) this.notify({ loginId, type: "error", message: error.message }); })
        .finally(() => this.logins.delete(loginId));
    });
    return loginId;
  }
  respond(loginId: string, value: string): void {
    const login = this.logins.get(loginId);
    if (!login?.respond) throw new Error(this.config.text("No login prompt is waiting", "当前没有等待输入的登录提示"));
    login.respond(value);
  }
  cancel(loginId: string): void {
    const login = this.logins.get(loginId);
    if (!login) return;
    this.logins.delete(loginId);
    login.controller.abort();
    this.notify({ loginId, type: "cancelled", message: this.config.text("Sign-in cancelled", "登录已取消") });
  }
  get activeLogins(): number { return this.logins.size; }
  status(): { provider: string; type: string }[] {
    const records = Object.entries(this.credentials.all()).map(([provider, credential]) => ({ provider, type: credential.type }));
    for (const provider of new Set(this.models().map((model) => model.provider))) {
      if (this.envKey(provider) && !records.some((record) => record.provider === provider)) records.push({ provider, type: "api_key" });
    }
    return records;
  }
  close(): void { for (const loginId of this.logins.keys()) this.cancel(loginId); }
}
