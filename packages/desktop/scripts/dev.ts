import { build } from "esbuild";
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import electron from "electron";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({ entryPoints: [resolve(root, "src/main.ts")], outfile: resolve(root, "dist/main.js"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24", sourcemap: true });
await build({ entryPoints: [resolve(root, "src/preload.ts")], outfile: resolve(root, "dist/preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24", sourcemap: true });
const server = await createServer({ root, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 5173 } });
await server.listen();
const child = spawn(electron as unknown as string, [root], { stdio: "inherit", env: { ...process.env, VOIDKAGAMI_RENDERER_URL: server.resolvedUrls!.local[0], VOIDKAGAMI_DAEMON: resolve(root, "../daemon/src/index.ts") } });
const stop = () => child.kill();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
child.once("exit", (code) => { void server.close().then(() => { process.exitCode = code || 0; }); });
