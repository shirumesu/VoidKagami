import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { SocketClient } from "@voidkagami/client";

export async function login(client: SocketClient, provider: string) {
  if (provider !== "openai") {
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const input = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    input.on("SIGINT", cancel); input.on("close", cancel);
    process.stderr.write(`${provider} API key (hidden): `);
    try { const apiKey = await input.question("", { signal: controller.signal }); process.stderr.write("\n"); await client.request("auth.key", { provider, apiKey: apiKey.trim() }); console.log(`Signed in to ${provider}`); }
    finally { input.close(); silent.end(); }
    return;
  }
  let loginId: string | undefined;
  const backlog: Record<string, unknown>[] = [];
  let input: ReturnType<typeof createInterface> | undefined;
  const inputController = new AbortController();
  let cancelled = false;
  let rejectLogin: ((error: Error) => void) | undefined;
  let handler: (event: Record<string, unknown>) => void = (event) => backlog.push(event);
  const listener = (event: Record<string, unknown>) => handler(event);
  client.on("auth", listener);
  const cancel = () => { cancelled = true; rejectLogin?.(new Error("Sign-in cancelled")); };
  const disconnected = () => rejectLogin?.(new Error("Daemon disconnected during sign-in"));
  process.once("SIGINT", cancel);
  client.on("disconnect", disconnected);
  try {
    ({ loginId } = await client.request("auth.login", { provider }));
    if (cancelled) throw new Error("Sign-in cancelled");
    await new Promise<void>((resolveLogin, reject) => {
      rejectLogin = reject;
      handler = (event) => {
        if (event.loginId !== loginId) return;
        if (event.type === "url") console.log(`${event.url}\n${event.instructions || "Open this URL to sign in with ChatGPT."}`);
        if (event.type === "progress") console.log(String(event.message || ""));
        if (event.type === "prompt") {
          if (!input) { input = createInterface({ input: process.stdin, output: process.stderr }); input.on("SIGINT", cancel); input.on("close", cancel); }
          void input.question(`${event.message || "Paste the authorization code or redirect URL"}: `, { signal: inputController.signal }).then((value) => client.request("auth.respond", { loginId: loginId!, value })).catch(reject);
        }
        if (event.type === "complete") { console.log("Signed in with ChatGPT"); resolveLogin(); }
        if (event.type === "error") reject(new Error(String(event.message || "Login failed")));
        if (event.type === "cancelled") reject(new Error("Sign-in cancelled"));
      };
      for (const event of backlog) handler(event);
    });
  } finally {
    process.removeListener("SIGINT", cancel); client.off("auth", listener); client.off("disconnect", disconnected);
    inputController.abort(); input?.removeListener("close", cancel); input?.close();
    if (loginId && client.state === "connected") await client.request("auth.cancel", { loginId });
  }
}
