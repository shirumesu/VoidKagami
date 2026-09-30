import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions } from "./types.ts";
import { lazyStream } from "./api/lazy.ts";
import { normalizeContext } from "./utils/transcript.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

async function implementation(api: Api) {
  switch (api) {
    case "openai-responses": return import("./api/openai-responses.ts");
    case "openai-completions": return import("./api/openai-completions.ts");
    case "anthropic-messages": return import("./api/anthropic-messages.ts");
    default: throw new Error(`Unsupported model API: ${api}`);
  }
}

export function getEnvApiKey(provider: string): string | undefined {
  const names: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const name = names[provider];
  return name ? process.env[name] : undefined;
}

function requestApiKey(model: Model<Api>, explicit?: string): string | undefined {
  const key = explicit ?? getEnvApiKey(model.provider);
  if (key) return key;
  const host = new URL(model.baseUrl).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(host) ? "local" : undefined;
}

export function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const api = await implementation(model.api);
    return api.streamSimple(model as never, normalizeContext(context), {
      ...options,
      apiKey: requestApiKey(model, options?.apiKey),
    });
  });
}

export function stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const api = await implementation(model.api);
    return api.stream(model as never, normalizeContext(context), {
      ...options,
      apiKey: requestApiKey(model, options?.apiKey),
    });
  });
}

export function completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
  return streamSimple(model, context, options).result();
}

export function complete(model: Model<Api>, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}
