import { build as bundle } from "esbuild";
import { build as buildRenderer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
await bundle({ entryPoints: [resolve(root, "src/main.ts")], outfile: resolve(root, "dist/main.js"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24", sourcemap: true });
await bundle({ entryPoints: [resolve(root, "src/preload.ts")], outfile: resolve(root, "dist/preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node24", sourcemap: true });
await buildRenderer({ root, base: "./", build: { outDir: "dist/renderer", emptyOutDir: true, rollupOptions: { input: resolve(root, "index.html") } }, esbuild: { jsx: "automatic" } });
