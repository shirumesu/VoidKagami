import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 5174, strictPort: true, open: false } });
await server.listen();
console.log("http://127.0.0.1:5174/preview.html");
await new Promise<void>((resolveStop) => {
  const stop = () => { void server.close().then(resolveStop); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
