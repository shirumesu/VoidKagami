import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "@voidkagami/protocol";

export const dataHome = process.env.VOIDKAGAMI_HOME || join(homedir(), ".voidkagami");
export const defaults: Config = {
  defaultModel: { provider: "openai", id: "gpt-6.1-sol" },
  permissionMode: "ask",
  rules: [], providers: {}, mcpServers: {}, hooks: [],
  sandbox: false,
  compactThreshold: 0.8,
  idleTimeoutMs: 300_000,
};

export class ConfigStore {
  readonly home: string;
  constructor(home = dataHome) {
    this.home = home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  get(): Config {
    try {
      return { ...defaults, ...JSON.parse(readFileSync(join(this.home, "config.json"), "utf8")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
      throw error;
    }
  }
  set(patch: Partial<Config>): Config {
    const config = { ...this.get(), ...patch };
    if (!(config.compactThreshold > 0 && config.compactThreshold < 1)) throw new Error("compactThreshold must be between 0 and 1");
    if (!(config.idleTimeoutMs >= 0)) throw new Error("idleTimeoutMs must be nonnegative");
    if (!["ask", "accept_edits", "auto", "plan"].includes(config.permissionMode)) throw new Error("Unknown permission mode");
    writeFileSync(join(this.home, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    return config;
  }
}

export interface Credential {
  type: "api_key" | "oauth";
  apiKey?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  [key: string]: unknown;
}
export class CredentialStore {
  readonly path: string;
  constructor(home: string) { this.path = join(home, "credentials.json"); }
  all(): Record<string, Credential> {
    try { return JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  get(provider: string): Credential | undefined { return this.all()[provider]; }
  set(provider: string, credential?: Credential): void {
    const credentials = this.all();
    if (credential) credentials[provider] = credential;
    else delete credentials[provider];
    writeFileSync(this.path, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
