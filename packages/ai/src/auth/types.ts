import type { ProviderHeaders } from "../types.ts";

export interface ModelAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
}

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
  url: string;
  label?: string;
}

export type AuthEvent =
  | { type: "info"; message: string; links?: readonly AuthInfoLink[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

export interface LoginOptions {
  /** Stable UUID for this installation, reused across login attempts. */
  getDeviceId?: () => string;
}

export interface OAuthAuth {
  name: string;
  isSubscription?: boolean;
  loginLabel?: string;
  login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}
