import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
await exec(process.execPath, ["packages/tui/native/build.ts"], { maxBuffer: 4 * 1024 * 1024 });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { cli: "packages/cli/src/index.ts", daemon: "packages/daemon/src/index.ts" },
  outdir: "dist", bundle: true, platform: "node", target: "node24", format: "esm",
  sourcemap: true, logLevel: "info", banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
await cp(`packages/tui/native/${platform}/prebuilds`, `dist/native/${platform}/prebuilds`, { recursive: true });
