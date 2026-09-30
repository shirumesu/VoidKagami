import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { SocketClient } from "@voidkagami/client";

export async function login(client: SocketClient, provider: string) {
  if (provider !== "openai") {
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const input = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) });
    process.stderr.write(`${provider} API key (hidden): `);
    try { const apiKey = await input.question(""); process.stderr.write("\n"); await client.request("auth.key", { provider, apiKey: apiKey.trim() }); console.log(`Signed in to ${provider}`); }
    finally { input.close(); silent.end(); }
    return;
  }
  let loginId: string | undefined;
  const backlog: Record<string, unknown>[] = [];
  let input: ReturnType<typeof createInterface> | undefined;
  let handler: (event: Record<string, unknown>) => void = (event) => backlog.push(event);
  const listener = (event: Record<string, unknown>) => handler(event);
  client.on("auth", listener);
  try {
    ({ loginId } = await client.request("auth.login", { provider }));
    await new Promise<void>((resolveLogin, reject) => {
      handler = (event) => {
        if (event.loginId !== loginId) return;
        if (event.type === "url") console.log(`${event.url}\n${event.instructions || "Open this URL to sign in with ChatGPT."}`);
        if (event.type === "progress") console.log(String(event.message || ""));
        if (event.type === "prompt") {
          input ||= createInterface({ input: process.stdin, output: process.stderr });
          void input.question(`${event.message || "Paste the authorization code or redirect URL"}: `).then((value) => client.request("auth.respond", { loginId: loginId!, value })).catch(reject);
        }
        if (event.type === "complete") { console.log("Signed in with ChatGPT"); resolveLogin(); }
        if (event.type === "error") reject(new Error(String(event.message || "Login failed")));
      };
      for (const event of backlog) handler(event);
    });
  } finally { client.off("auth", listener); input?.close(); }
}
